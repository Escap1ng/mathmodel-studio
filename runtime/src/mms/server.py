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
from urllib.parse import parse_qs, urlparse

from . import __version__
from .invoke import list_templates
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

MAX_BODY = 1 << 20
MAX_MESSAGES = 64
MAX_TOTAL_CHARS = 200_000
TOOL_ROUNDS = 4
PING_SECONDS = 15

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
        raise ValueError("messages 必须是非空数组")
    if len(raw) > MAX_MESSAGES:
        raise ValueError(f"messages 超过 {MAX_MESSAGES} 条")
    out: list[dict] = []
    total = 0
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("messages 每一项必须是对象")
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


class ChatSession:
    """一次对话：后台线程写事件，SSE 订阅者按 id 续读。"""

    def __init__(self, chat_id: str, provider: dict, api_key: str, model: str, messages: list[dict]):
        self.id = chat_id
        self.provider = provider
        self.api_key = api_key
        self.model = model
        self.messages = messages
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

    def _run(self) -> None:
        tools = TOOLS if self.provider.get("tool_calling") else None
        try:
            for _round in range(TOOL_ROUNDS):
                if self.cancelled:
                    raise CancelledError()
                deltas = lambda kind, text: self.append(kind, {"text": text})
                if self.provider.get("id") == "fake":
                    try:
                        delay = max(0.0, float(os.environ.get("MMS_FAKE_DELAY_MS") or "20") / 1000)
                    except ValueError:
                        delay = 0.02
                    completion = fake_completion(self.messages, deltas, self.should_stop, delay)
                else:
                    completion = stream_completion(
                        self.provider,
                        self.api_key,
                        self.model,
                        self.messages,
                        tools,
                        deltas,
                        self.should_stop,
                    )
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
                        result, ok = run_tool(name, args)
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
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": name,
                            "content": json.dumps(result, ensure_ascii=False),
                        }
                    )
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


class ChannelServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, token: str, fake: bool):
        super().__init__(address, handler)
        self.token = token
        self.fake = fake
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
            self._json(
                200,
                {
                    "ok": True,
                    "version": __version__,
                    "fake": self.server.fake,
                    "pid": os.getpid(),
                },
            )
            return
        if parsed.path == "/providers":
            self._json(200, {"ok": True, "fake": self.server.fake, "providers": provider_rows(self.server.fake)})
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
                self._error(400, "provider", f"未知 provider: {provider_id}")
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
        session = ChatSession(chat_id, provider, api_key, model, messages)
        with self.server.sessions_lock:
            self.server.sessions[chat_id] = session
        session.start()
        self._json(200, {"ok": True, "chatId": chat_id})

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
    server = ChannelServer(("127.0.0.1", port), Handler, token, fake)
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
    stop.wait()
    server.shutdown()
    server.server_close()
    return 0
