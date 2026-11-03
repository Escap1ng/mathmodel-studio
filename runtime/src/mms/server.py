"""本机通道服务器：stdout 握手，此后只走 127.0.0.1 HTTP + SSE。

为什么不是 stdio JSON-RPC：SSE 自带事件 id 与断线续传语义，主进程只需转发；
端口与 token 由子进程生成并只交给父进程，渲染层既拿不到端口也拿不到 token。

安全边界：
- 只绑 127.0.0.1，每个请求校验 Host 与 Origin（防 DNS rebinding）。
- 每个请求校验 Bearer token（防同机其他进程顺手调用）。
- API Key 按次传入，不落盘、不写日志、不放进任何事件。
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import signal
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__, harness, orchestrator
from .invoke import list_templates
from .store import SessionStore, data_dir, snapshot
from . import paper_build, workbench_figure, workbench_score
from .provider import (
    CancelledError,
    ProviderError,
    fake_completion,
    find_provider,
    load_providers,
    stream_completion,
    validate_base_url,
)
from .registry import EnvError

MAX_BODY = 16 << 20
MAX_MESSAGES = 200
MAX_TOTAL_CHARS = 1_600_000
MAX_TOOL_RESULT_CHARS = 8_000
TOOL_ROUNDS = 8
PING_SECONDS = 15
DEPTHS = ("medium", "high", "max")

SYSTEM_PROMPT = (
    "你是 mathmodel-studio 的数学建模助手。工具返回的数据以工具结果为准，不要编造没有运行过的结果；"
    "回答简洁，关键判断留给使用者确认。"
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_templates",
            "description": "列出本机技能内置的图表与示意图模板（只读注册表，不渲染）。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    }
]


class FakeProviderDisabled(RuntimeError):
    pass


def fake_enabled() -> bool:
    return os.environ.get("MMS_FAKE_PROVIDER") == "1"


def core_name() -> str:
    return "dsh" if (os.environ.get("MMS_CORE") or "python").strip().lower() == "dsh" else "python"


def provider_rows(fake: bool | None = None) -> list[dict]:
    rows = [dict(p) for p in load_providers()]
    for row in rows:
        row.setdefault("requires_key", True)
    if fake is None:
        fake = fake_enabled()
    if fake:
        rows.insert(
            0,
            {
                "id": "fake",
                "display": "离线演示（不联网）",
                "base_url": "",
                "auth_style": "none",
                "models": ["fake-stream"],
                "tool_calling": True,
                "streaming_tools": True,
                "context_len": 4096,
                "max_out": 1024,
                "requires_key": False,
                "custom": False,
                "note": "只在 MMS_FAKE_PROVIDER=1 时出现，用于验证通道与工具卡。",
            },
        )
    return rows


def run_tool(name: str, args: dict | None) -> tuple[dict, bool]:
    if name == "list_templates":
        try:
            rows = list_templates()
        except (EnvError, OSError, json.JSONDecodeError) as exc:
            return {"ok": False, "error": str(exc)}, False
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["skill"]] = counts.get(row["skill"], 0) + 1
        return {"ok": True, "total": len(rows), "by_skill": counts, "templates": rows}, True
    return {"ok": False, "error": f"未知工具: {name}"}, False


def normalize_messages(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("消息必须是非空数组")
    if len(raw) > MAX_MESSAGES:
        raise ValueError(f"消息超过 {MAX_MESSAGES} 条")
    out: list[dict] = []
    total = 0
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("消息每一项必须是对象")
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant", "system"):
            raise ValueError(f"不支持的消息角色: {role!r}")
        if not isinstance(content, str):
            raise ValueError("消息 content 必须是字符串")
        total += len(content)
        if total > MAX_TOTAL_CHARS:
            raise ValueError("消息总长度超过上限")
        out.append({"role": role, "content": content})
    if not any(m["role"] == "user" for m in out):
        raise ValueError("至少需要一条 user 消息")
    if out[0]["role"] != "system":
        out.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    return out


def estimate_tokens(text: str) -> int:
    """兼容旧调用点；真正的实现在 harness 里。"""
    return harness.estimate_tokens(text)


class ChatSession:
    """一次对话：后台线程写事件，SSE 订阅者按 id 续读。"""

    def __init__(
        self,
        chat_id: str,
        provider: dict,
        api_key: str,
        model: str,
        messages: list[dict],
        depth: str = "",
        context_tokens: int | None = None,
        send_thinking: bool = True,
        goal: str = "",
        workspace: str = "",
    ):
        self.id = chat_id
        self.provider = provider
        self.api_key = api_key
        self.model = model
        self.messages = messages
        self.depth = depth if send_thinking else ""
        self.context_tokens = context_tokens
        self.goal = goal
        self.workspace = workspace
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.done = False
        self.cancelled = False
        self.reason = ""
        self.usage: dict | None = None
        self.thread = threading.Thread(target=self._run, name=f"chat-{chat_id}", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def should_stop(self) -> bool:
        return self.cancelled

    def append(self, event: str, data: dict) -> None:
        with self.cond:
            if self.done:
                return
            eid = len(self.events) + 1
            self.events.append({"id": str(eid), "event": event, "data": data})
            self.cond.notify_all()

    def finish(self, reason: str, usage: dict | None = None) -> None:
        with self.cond:
            if self.done:
                return
            self.done = True
            self.reason = reason
            self.usage = usage
            payload = {"reason": reason}
            if usage:
                payload["usage"] = usage
            eid = len(self.events) + 1
            self.events.append({"id": str(eid), "event": "done", "data": payload})
            self.cond.notify_all()

    def cancel(self) -> None:
        with self.cond:
            if self.done:
                return
            self.cancelled = True
            self.cond.notify_all()
        # 不在这里 finish：worker 可能在一次工具调用中间，由它收尾，
        # 这样 done 一定排在最后一个真实事件之后。

    def _pause(self, seconds: float) -> None:
        end = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < end:
            if self.cancelled:
                raise CancelledError()
            time.sleep(min(0.02, max(0.0, end - time.monotonic())))

    def _context_plan(
        self, ratio: float = harness.COMPACT_RATIO, reason: str = "auto"
    ) -> harness.Plan:
        turn = sum(1 for message in self.messages if message.get("role") == "user")
        extra = [f"工作区：{self.workspace}"] if self.workspace else []
        anchor = harness.anchor_text(self.goal, turn, extra)
        return harness.prepare(
            self.messages, self.context_tokens, anchor=anchor, ratio=ratio, reason=reason
        )

    def _apply_plan(self, plan: harness.Plan) -> None:
        self.messages = plan.messages
        if plan.reason:
            self.append("compaction", plan.event())

    def _complete(self, tools, deltas):
        recovered = False
        while True:
            if self.cancelled:
                raise CancelledError()
            try:
                if self.provider.get("id") == "fake":
                    try:
                        delay = max(0.0, float(os.environ.get("MMS_FAKE_DELAY_MS") or "20") / 1000)
                    except ValueError:
                        delay = 0.02
                    return fake_completion(self.messages, deltas, self.should_stop, delay)
                return stream_completion(
                    self.provider,
                    self.api_key,
                    self.model,
                    self.messages,
                    tools,
                    deltas,
                    self.should_stop,
                    depth=self.depth,
                )
            except ProviderError as exc:
                if recovered or not harness.looks_like_overflow(str(exc)):
                    raise
                # provider 报上下文溢出：压得更狠再试一次，别把错误直接甩给用户。
                recovered = True
                self._apply_plan(
                    self._context_plan(ratio=harness.OVERFLOW_RATIO, reason="overflow")
                )

    def _run(self) -> None:
        tools = TOOLS if self.provider.get("tool_calling") else None
        self._apply_plan(self._context_plan())
        seen: dict[str, dict] = {}
        try:
            for _round in range(TOOL_ROUNDS):
                if self.cancelled:
                    raise CancelledError()
                deltas = lambda kind, text: self.append(kind, {"text": text})
                completion = self._complete(tools, deltas)
                if not completion.tool_calls:
                    self.finish("stop", completion.usage)
                    return
                self.messages.append(
                    {
                        "role": "assistant",
                        "content": completion.content or None,
                        "tool_calls": completion.tool_calls,
                    }
                )
                for call in completion.tool_calls:
                    if self.cancelled:
                        raise CancelledError()
                    call_id = call.get("id") or f"call_{secrets.token_hex(4)}"
                    fn = call.get("function") or {}
                    name = fn.get("name") or ""
                    raw_args = fn.get("arguments") or "{}"
                    try:
                        args = json.loads(raw_args) if raw_args.strip() else {}
                    except json.JSONDecodeError:
                        args = None
                    shown = args if args is not None else raw_args
                    self.append("tool_call", {"id": call_id, "name": name, "status": "running", "args": shown})
                    started = time.monotonic()
                    if args is None:
                        result, ok = {"ok": False, "error": "工具参数不是合法 JSON"}, False
                    else:
                        key = f"{name}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"
                        if key in seen:
                            result = {**seen[key], "note": "重复调用，返回上次结果"}
                            ok = bool(seen[key].get("ok"))
                        else:
                            result, ok = run_tool(name, args)
                            seen[key] = result
                    duration = int((time.monotonic() - started) * 1000)
                    self.append(
                        "tool_call",
                        {
                            "id": call_id,
                            "name": name,
                            "status": "ok" if ok else "error",
                            "args": shown,
                            "result": result,
                            "duration_ms": duration,
                        },
                    )
                    content = json.dumps(result, ensure_ascii=False)
                    if len(content) > MAX_TOOL_RESULT_CHARS:
                        content = content[:MAX_TOOL_RESULT_CHARS] + "…[工具结果已截断]"
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": name,
                            "content": content,
                        }
                    )
                # 工具结果可能把上下文推过阈值：下一轮之前再压一次。
                if self.context_tokens:
                    self._apply_plan(self._context_plan())
            self.finish("max_tool_rounds")
        except CancelledError:
            self.finish("cancelled")
        except ProviderError as exc:
            self.append("error", {"message": str(exc)})
            self.finish("error")
        except Exception:
            # 堆栈只进 stderr；事件里不回显请求体或密钥。
            traceback.print_exc(file=sys.stderr)
            self.append("error", {"message": "运行时内部错误，详情见 stderr"})
            self.finish("error")


class WorkflowSession(ChatSession):
    """M3 编排会话：复用事件缓冲与 SSE 语义，内容由状态机产生。"""

    def __init__(
        self,
        chat_id: str,
        store: SessionStore,
        record: dict,
        action: str,
        choice: str,
        workspace: str = "",
    ):
        super().__init__(chat_id, {}, "", "", [], workspace=workspace)
        self.store = store
        self.record = record
        self.action = action
        self.choice = choice

    def _run(self) -> None:
        try:
            if self.action == "start":
                events = orchestrator.start(self.store, self.record)
            else:
                events = orchestrator.resume_iter(
                    self.store, self.record, self.action, self.choice, self.workspace
                )
            for ev in events:
                if self.cancelled:
                    raise CancelledError()
                delay = ev.get("delay")
                if delay:
                    self._pause(float(delay))
                self.append(ev["event"], ev["data"])
            self.finish("stop" if self.action == "choose" else "waiting")
        except CancelledError:
            self.finish("cancelled")
        except ValueError as exc:
            self.append("error", {"message": str(exc)})
            self.finish("error")
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self.append("error", {"message": "编排状态机内部错误，详情见 stderr"})
            self.finish("error")


class ChannelServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, token: str, fake: bool, store: SessionStore, root: Path):
        super().__init__(address, handler)
        self.token = token
        self.fake = fake
        self.store = store
        self.root = root
        self.sessions: dict[str, ChatSession] = {}
        self.sessions_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: ChannelServer

    def log_message(self, fmt: str, *args) -> None:
        # 只记方法/路径/状态；不记 header 与 body，密钥没有机会进日志。
        sys.stderr.write("[mms] %s\n" % (fmt % args))

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"ok": False, "error": {"code": code, "message": message}})

    def _guard(self) -> bool:
        port = self.server.server_address[1]
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = (self.headers.get("Host") or "").strip()
        if host not in allowed_hosts:
            self._error(403, "host", "Host 不在回环白名单")
            return False
        origin = (self.headers.get("Origin") or "").strip()
        if origin and origin not in {f"http://{h}" for h in allowed_hosts}:
            self._error(403, "origin", "Origin 不在回环白名单")
            return False
        auth = (self.headers.get("Authorization") or "").strip()
        expected = f"Bearer {self.server.token}"
        if not hmac.compare_digest(auth, expected):
            self._error(401, "auth", "缺少或错误的 token")
            return False
        return True

    def _body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._error(400, "body", "Content-Length 非法")
            return None
        if length <= 0 or length > MAX_BODY:
            self._error(400, "body", "请求体为空或过大")
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "body", "请求体不是合法 JSON")
            return None
        if not isinstance(data, dict):
            self._error(400, "body", "请求体必须是对象")
            return None
        return data

    def do_GET(self) -> None:  # noqa: N802
        if not self._guard():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            try:
                from .dsh_adapter import dsh_version
            except Exception:
                dsh_version = None
            self._json(
                200,
                {
                    "ok": True,
                    "version": __version__,
                    "fake": self.server.fake,
                    "core": core_name(),
                    "dshVersion": dsh_version() if dsh_version else None,
                    "pid": os.getpid(),
                },
            )
            return
        if parsed.path == "/providers":
            self._json(200, {"ok": True, "fake": self.server.fake, "providers": provider_rows(self.server.fake)})
            return
        if parsed.path == "/sessions/latest":
            self._json(200, {"ok": True, "session": snapshot(self.server.store.latest())})
            return
        if parsed.path == "/sessions":
            self._json(200, {"ok": True, "sessions": self.server.store.list_summaries()})
            return
        if parsed.path == "/workbench/state":
            self._json(200, self._workbench())
            return
        if parsed.path.startswith("/sessions/") and parsed.path.count("/") == 2:
            session_id = parsed.path[len("/sessions/") :]
            record = self.server.store.get(session_id)
            if not record:
                self._error(404, "session", "没有这个会话")
                return
            self._json(200, {"ok": True, "session": snapshot(record)})
            return
        if parsed.path.startswith("/chats/") and parsed.path.endswith("/events"):
            chat_id = parsed.path[len("/chats/") : -len("/events")].strip("/")
            self._stream(chat_id, parse_qs(parsed.query))
            return
        self._error(404, "not_found", "没有这个端点")

    def do_POST(self) -> None:  # noqa: N802
        if not self._guard():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/chats":
            self._start_chat()
            return
        if parsed.path.startswith("/sessions/") and parsed.path.endswith("/resume"):
            session_id = parsed.path[len("/sessions/") : -len("/resume")].strip("/")
            self._resume_session(session_id)
            return
        if parsed.path == "/workbench/render":
            self._render_figure()
            return
        if parsed.path == "/workbench/rollback":
            self._rollback_figure()
            return
        if parsed.path == "/workbench/paper/build":
            self._build_paper()
            return
        if parsed.path.startswith("/chats/") and parsed.path.endswith("/cancel"):
            chat_id = parsed.path[len("/chats/") : -len("/cancel")].strip("/")
            with self.server.sessions_lock:
                session = self.server.sessions.get(chat_id)
            if not session:
                self._error(404, "chat", "没有这个对话")
                return
            session.cancel()
            self._json(200, {"ok": True, "chatId": chat_id})
            return
        self._error(404, "not_found", "没有这个端点")

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._guard():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/sessions":
            removed = self.server.store.clear()
            self._json(200, {"ok": True, "removed": removed})
            return
        if parsed.path.startswith("/sessions/") and parsed.path.count("/") == 2:
            session_id = parsed.path[len("/sessions/") :]
            if not self.server.store.delete(session_id):
                self._error(404, "session", "没有这个会话")
                return
            self._json(200, {"ok": True, "id": session_id})
            return
        self._error(404, "not_found", "没有这个端点")

    def _workbench(self) -> dict:
        figure = workbench_figure.state_payload(
            self.server.root, self.server.store.path.parent
        )
        try:
            score = workbench_score.state(self.server.root)
            chapter = score.get("chapter", {})
            round_row = next(
                (r for r in score.get("rounds", []) if r.get("round") == score.get("defaultRound")),
                None,
            )
            score_ok = bool(round_row and round_row.get("pass"))
            score_detail = (
                f"第 {round_row['round']} 轮 {round_row['total']} / 100"
                if round_row
                else (score.get("error") or "无法评分")
            )
        except Exception as exc:  # 评分脚本坏掉时工作台仍能打开
            score = {"ok": False, "error": str(exc), "rounds": []}
            chapter = {"ok": False, "error": str(exc)}
            score_ok = False
            score_detail = str(exc)
        active = next(
            (v for v in figure.get("versions", []) if v.get("id") == figure.get("active")),
            None,
        )
        outputs = (active or {}).get("outputs", {})
        figure_ok = bool(active) and all(
            kind in outputs and Path(outputs[kind]).is_file() and Path(outputs[kind]).stat().st_size > 0
            for kind in ("png", "pdf", "svg")
        )
        gate = [
            {
                "id": "figure",
                "label": "图表产物",
                "ok": figure_ok,
                "detail": "PNG / PDF / SVG 齐全" if figure_ok else "尚未渲染出三件产物",
            },
            {"id": "score", "label": "评分", "ok": score_ok, "detail": score_detail},
            {
                "id": "chapter",
                "label": "章节结构",
                "ok": bool(chapter.get("pass")),
                "detail": (
                    f"hard {chapter.get('hard_failed', 0)} · soft {chapter.get('soft_failed', 0)} · 人工 {chapter.get('manual', 0)}"
                    if chapter.get("ok")
                    else chapter.get("error", "章节自检未运行")
                ),
            },
        ]
        paper = paper_build.state(self.server.store.path.parent, self.server.root)
        artifacts = paper.get("artifacts") or {}
        paper_ok = bool(paper.get("ok")) and {"pdf", "docx"} <= set(artifacts)
        if paper_ok:
            paper_detail = f"PDF {artifacts['pdf']['size'] // 1024} KB · DOCX {artifacts['docx']['size'] // 1024} KB"
        elif paper.get("builtAt"):
            paper_detail = paper.get("error") or "上次构建未全绿"
        else:
            paper_detail = "尚未构建论文"
        gate.append({"id": "paper", "label": "论文排版", "ok": paper_ok, "detail": paper_detail})
        return {
            "ok": True,
            "figure": figure,
            "score": score,
            "chapter": chapter,
            "paper": paper,
            "gate": gate,
        }

    def _render_figure(self) -> None:
        body = self._body()
        if body is None:
            return
        template = str(body.get("template") or "")
        theme = str(body.get("theme") or "")
        code, result = workbench_figure.render(
            template, theme, self.server.root, self.server.store.path.parent
        )
        if code != 0:
            self._error(400, "figure", str(result.get("error") or "渲染失败"))
            return
        self._json(200, {"ok": True, "version": result.get("version"), "state": self._workbench()})

    def _rollback_figure(self) -> None:
        body = self._body()
        if body is None:
            return
        version = str(body.get("version") or "")
        code, result = workbench_figure.rollback(
            version, self.server.root, self.server.store.path.parent
        )
        if code != 0:
            self._error(404, "figure", str(result.get("error") or "没有这个版本"))
            return
        self._json(200, {"ok": True, "state": self._workbench()})

    def _build_paper(self) -> None:
        body = self._body()
        if body is None:
            return
        code, result = paper_build.build(
            self.server.store.path.parent, self.server.root
        )
        self._json(
            200,
            {
                "ok": bool(result.get("ok")),
                "code": code,
                "paper": result,
                "state": self._workbench(),
            },
        )

    def _start_chat(self) -> None:
        body = self._body()
        if body is None:
            return
        provider_id = str(body.get("providerId") or "")
        try:
            messages = normalize_messages(body.get("messages"))
        except ValueError as exc:
            self._error(400, "messages", str(exc))
            return
        model = str(body.get("model") or "").strip()
        api_key = str(body.get("apiKey") or "")
        depth = str(body.get("thinking") or "")
        if depth and depth not in DEPTHS:
            self._error(400, "thinking", f"未知思维深度: {depth}")
            return
        context_tokens: int | None = None
        raw_context = body.get("contextTokens")
        if isinstance(raw_context, (int, float)) and not isinstance(raw_context, bool):
            context_tokens = int(raw_context)
            if context_tokens < 50_000 or context_tokens > 2_000_000:
                self._error(400, "context", "上下文预算必须在 50k–2M 之间")
                return
        send_thinking = body.get("sendThinking") is not False

        if provider_id == "fake":
            if not self.server.fake:
                self._error(400, "provider", "离线演示未启用")
                return
            provider = {
                "id": "fake",
                "display": "离线演示",
                "tool_calling": True,
                "base_url": "",
            }
            api_key = ""
            model = model or "fake-stream"
        else:
            provider = find_provider(provider_id)
            if not provider:
                self._error(400, "provider", f"未知服务商: {provider_id}")
                return
            if provider.get("custom"):
                provider["base_url"] = str(body.get("baseUrl") or "")
            try:
                validate_base_url(provider.get("base_url") or "")
            except ProviderError as exc:
                self._error(400, "base_url", str(exc))
                return
            if not api_key:
                self._error(400, "key", "缺少 API Key（在模型设置里填写）")
                return
            if not model:
                self._error(400, "model", "缺少模型名")
                return

        chat_id = secrets.token_hex(8)
        mode = str(body.get("mode") or "chat")
        if mode not in ("chat", "workflow"):
            self._error(400, "mode", f"未知对话模式: {mode}")
            return
        if mode == "chat" and core_name() == "dsh" and provider_id == "fake":
            self._error(
                400,
                "core",
                "MMS_CORE=dsh 不支持离线 fake provider；请切回 python 核心或选择真实服务商",
            )
            return
        workspace = str(body.get("workspace") or "")
        raw_goal = next((m["content"] for m in messages if m["role"] == "user"), "")
        goal = " ".join(str(raw_goal).split())[:80]
        if mode == "workflow":
            problem = next(m["content"] for m in reversed(messages) if m["role"] == "user")
            record = self.server.store.create(chat_id, provider_id, model, problem)
            session: ChatSession = WorkflowSession(
                chat_id, self.server.store, record, "start", "", workspace=workspace
            )
        elif core_name() == "dsh":
            from .dsh_adapter import DshChatSession

            session = DshChatSession(
                chat_id,
                provider,
                api_key,
                model,
                messages,
                depth=depth,
                context_tokens=context_tokens,
                send_thinking=send_thinking,
                goal=goal,
                workspace=workspace,
            )
        else:
            session = ChatSession(
                chat_id,
                provider,
                api_key,
                model,
                messages,
                depth=depth,
                context_tokens=context_tokens,
                send_thinking=send_thinking,
                goal=goal,
                workspace=workspace,
            )
        with self.server.sessions_lock:
            self.server.sessions[chat_id] = session
        session.start()
        self._json(200, {"ok": True, "chatId": chat_id, "mode": mode})

    def _resume_session(self, session_id: str) -> None:
        body = self._body()
        if body is None:
            return
        action = str(body.get("action") or "")
        choice = str(body.get("choice") or "")
        if action not in ("confirm", "reroll", "choose"):
            self._error(400, "action", f"未知动作: {action}")
            return
        if action == "choose" and not choice:
            self._error(400, "choice", "选择候选时必须给出 choice")
            return
        record = self.server.store.get(session_id)
        if not record:
            self._error(404, "session", "没有这个会话")
            return
        if not record.get("pending"):
            self._error(409, "pending", "这个会话没有等待中的决策")
            return
        session = WorkflowSession(
            session_id,
            self.server.store,
            record,
            action,
            choice,
            workspace=str(body.get("workspace") or ""),
        )
        with self.server.sessions_lock:
            self.server.sessions[session_id] = session
        session.start()
        self._json(200, {"ok": True, "chatId": session_id})

    def _stream(self, chat_id: str, query: dict) -> None:
        with self.server.sessions_lock:
            session = self.server.sessions.get(chat_id)
        if not session:
            self._error(404, "chat", "没有这个对话")
            return

        raw_last = (self.headers.get("Last-Event-ID") or (query.get("last_id") or [""])[0] or "0").strip()
        try:
            last_id = max(0, int(raw_last))
        except ValueError:
            last_id = 0

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        # 流结束后必须由服务端关连接：客户端是 urllib/fetch，不是 EventSource，
        # 只认 EOF（或 chunked 结束），keep-alive 会让它一直等下去。
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b"retry: 1500\n\n")
            self.wfile.flush()
            index = min(last_id, len(session.events))
            last_ping = time.monotonic()
            while True:
                with session.cond:
                    while index >= len(session.events) and not session.done:
                        session.cond.wait(timeout=PING_SECONDS)
                        if index >= len(session.events):
                            break
                    pending = session.events[index:]
                    done = session.done
                if pending:
                    for ev in pending:
                        frame = (
                            f"id: {ev['id']}\nevent: {ev['event']}\n"
                            f"data: {json.dumps(ev['data'], ensure_ascii=False)}\n\n"
                        )
                        self.wfile.write(frame.encode("utf-8"))
                    index += len(pending)
                    self.wfile.flush()
                    last_ping = time.monotonic()
                    continue
                if done:
                    return
                if time.monotonic() - last_ping >= PING_SECONDS:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.monotonic()
        except (BrokenPipeError, ConnectionResetError):
            return


def serve(port: int = 0) -> int:
    token = secrets.token_hex(24)
    fake = fake_enabled()
    root = Path(os.environ.get("MMS_HOME") or ".").resolve()
    store = SessionStore(data_dir(root) / "sessions.db")
    server = ChannelServer(("127.0.0.1", port), Handler, token, fake, store, root)
    # 握手行是 stdout 的唯一内容；之后所有诊断都走 stderr。
    print(
        json.dumps(
            {
                "port": server.server_address[1],
                "token": token,
                "pid": os.getpid(),
                "fake": fake,
                "version": __version__,
            }
        ),
        flush=True,
    )
    stop = threading.Event()

    def _request_stop(*_args) -> None:
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _request_stop)
        except (ValueError, OSError):
            pass

    thread = threading.Thread(target=server.serve_forever, name="mms-http", daemon=True)
    thread.start()
    try:
        stop.wait()
        server.shutdown()
        server.server_close()
    finally:
        if core_name() == "dsh":
            try:
                from .dsh_adapter import shutdown_dsh_runtime

                shutdown_dsh_runtime()
            except Exception:
                traceback.print_exc(file=sys.stderr)
    return 0
