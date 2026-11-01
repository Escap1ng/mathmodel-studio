"""G4/G5 · 本机通道与 provider 流式契约自检。

不需要真实 API Key、不访问公网：通道用 MMS_FAKE_PROVIDER=1 的本地假 provider，
provider 路径用 127.0.0.1 上的假 OpenAI 端点（含 429 重试、reasoning_content 剥离、
tool_calls 增量拼装）。

每条断言都能失败；--selftest 用 7 份坏事件证明事件判据本身会拒绝它们。
退出码：0 全部通过 / 1 有断言失败 / 2 用法错误
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 同 selfcheck.py：CI 的 Windows 控制台是 cp1252，不重配会在打印中文时崩
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schemas" / "chat-events.schema.json"
SENTINEL = "sk-test-SENTINEL-DO-NOT-LEAK"
EVENT_TYPES = {"token", "reasoning", "tool_call", "artifact", "interrupt", "gate", "phase", "error", "done"}
sys.path.insert(0, str(ROOT / "runtime" / "src"))
from mms.provider import apply_reasoning, find_provider  # noqa: E402

results: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append({"name": name, "ok": bool(ok), "detail": detail})


def lint_event(ev) -> list[str]:
    """不依赖 jsonschema 的形状判据；--selftest 证明它会拒绝坏事件。"""
    problems: list[str] = []
    if not isinstance(ev, dict):
        return ["事件不是对象"]
    eid = ev.get("id")
    if not isinstance(eid, str) or not eid.isdigit() or int(eid) < 1:
        problems.append("id 必须是正整数形式的字符串")
    event = ev.get("event")
    if event not in EVENT_TYPES:
        problems.append(f"未知事件类型: {event!r}")
    data = ev.get("data")
    if not isinstance(data, dict):
        problems.append("data 必须是对象")
        return problems
    if event in ("token", "reasoning"):
        if not isinstance(data.get("text"), str) or not data.get("text"):
            problems.append(f"{event} 缺非空 text")
    elif event == "tool_call":
        if not isinstance(data.get("id"), str) or not data.get("id"):
            problems.append("tool_call 缺 id")
        if not isinstance(data.get("name"), str) or not data.get("name"):
            problems.append("tool_call 缺 name")
        if data.get("status") not in ("running", "ok", "error"):
            problems.append("tool_call.status 非法")
        if "duration_ms" in data and not isinstance(data["duration_ms"], int):
            problems.append("tool_call.duration_ms 必须是整数")
    elif event == "phase":
        if not isinstance(data.get("phase"), int) or not 0 <= data["phase"] <= 6:
            problems.append("phase 必须是 0..6 的整数")
        if data.get("status") not in ("idle", "running", "waiting", "passed", "failed"):
            problems.append("phase.status 非法")
    elif event == "error":
        if not isinstance(data.get("message"), str) or not data.get("message"):
            problems.append("error 缺 message")
    elif event == "done":
        if data.get("reason") not in ("stop", "error", "cancelled", "max_tool_rounds", "waiting"):
            problems.append("done.reason 非法")
    return problems


def schema_validate(events: list[dict]) -> tuple[list[str], str]:
    """优先按 Draft 2020-12 契约校验；缺 jsonschema 时退回 lint_event。"""
    try:
        import jsonschema  # type: ignore
    except ImportError:
        problems: list[str] = []
        for ev in events:
            problems.extend(lint_event(ev))
        return problems, "minimal"
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    problems = []
    for ev in events:
        for err in validator.iter_errors(ev):
            problems.append(f"事件 {ev.get('id')}: {err.message}")
    for ev in events:
        problems.extend(lint_event(ev))
    return problems, "jsonschema+shape"


def parse_sse(raw: str) -> list[dict]:
    frames: list[dict] = []
    cur: dict = {}
    for line in raw.splitlines():
        if not line.strip() or line.startswith(":"):
            if cur.get("event") and cur.get("data") is not None:
                frames.append({"id": cur.get("id", ""), "event": cur["event"], "data": cur["data"]})
            cur = {}
            continue
        if line.startswith("retry:"):
            continue
        key, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if key == "id":
            cur["id"] = value
        elif key == "event":
            cur["event"] = value
        elif key == "data":
            try:
                cur["data"] = json.loads(value)
            except json.JSONDecodeError:
                cur["data"] = {"__raw__": value}
    if cur.get("event") and cur.get("data") is not None:
        frames.append({"id": cur.get("id", ""), "event": cur["event"], "data": cur["data"]})
    return frames


def read_frame(resp) -> dict | None:
    cur: dict = {}
    while True:
        line = resp.readline()
        if not line:
            if cur.get("event") and cur.get("data") is not None:
                return {"id": cur.get("id", ""), "event": cur["event"], "data": cur["data"]}
            return None
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        if not text:
            if cur.get("event") and cur.get("data") is not None:
                return {"id": cur.get("id", ""), "event": cur["event"], "data": cur["data"]}
            continue
        if text.startswith(":"):
            continue
        key, _, value = text.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if key == "id":
            cur["id"] = value
        elif key == "event":
            cur["event"] = value
        elif key == "data":
            cur["data"] = json.loads(value)


class Channel:
    def __init__(self, fake: bool = True, env_extra: dict | None = None):
        env = {**os.environ}
        env.pop("MMS_FAKE_PROVIDER", None)
        env.pop("MMS_FAKE_DELAY_MS", None)
        if fake:
            env["MMS_FAKE_PROVIDER"] = "1"
        env.update(env_extra or {})
        self.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "runtime" / "cli.py"), "serve", "--port", "0"],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
        timer = threading.Timer(20, self.proc.kill)
        timer.start()
        try:
            line = self.proc.stdout.readline() if self.proc.stdout else ""
        finally:
            timer.cancel()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"服务器没有打印握手行；stderr: {err[-800:]}")
        self.handshake = json.loads(line)
        self.port = int(self.handshake["port"])
        self.token = str(self.handshake["token"])
        self.extra_stdout = ""
        self.stderr = ""

    def header(self, extra: dict | None = None) -> dict:
        head = {"Authorization": f"Bearer {self.token}"}
        head.update(extra or {})
        return head

    def request(self, method: str, path: str, body=None, headers=None) -> tuple[int, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        data = None
        head = self.header(headers)
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            head["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=head)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, raw

    def json(self, method: str, path: str, body=None, headers=None) -> tuple[int, dict]:
        status, raw = self.request(method, path, body, headers)
        try:
            return status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return status, {"__raw__": raw.decode("utf-8", "replace")}

    def start_chat(self, body: dict) -> tuple[int, dict]:
        return self.json("POST", "/chats", body)

    def events(self, chat_id: str, last_id: str | None = None) -> tuple[list[dict], str]:
        headers = self.header({"Last-Event-ID": last_id} if last_id else None)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request("GET", f"/chats/{chat_id}/events", headers=headers)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", "replace")
        conn.close()
        return parse_sse(raw), raw

    def open_events(self, chat_id: str, last_id: str | None = None):
        headers = self.header({"Last-Event-ID": last_id} if last_id else None)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request("GET", f"/chats/{chat_id}/events", headers=headers)
        return conn, conn.getresponse()

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        self.extra_stdout = self.proc.stdout.read() if self.proc.stdout else ""
        self.stderr = self.proc.stderr.read() if self.proc.stderr else ""


class FakeOpenAI(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or "0")
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        self.server.records.append(
            {"auth": self.headers.get("Authorization"), "body": body}
        )
        if len(self.server.records) == 1:
            self.send_response(429)
            self.send_header("Retry-After", "0")
            self.end_headers()
            self.wfile.write(b'{"error":"rate limited"}')
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        messages = body.get("messages") or []
        if any(m.get("role") == "tool" for m in messages):
            chunks = [
                {"choices": [{"delta": {"content": "共 25 个模板。"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        else:
            chunks = [
                {"choices": [{"delta": {"reasoning_content": "想一想。"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "查模板。"}, "finish_reason": None}]},
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_live_1",
                                        "type": "function",
                                        "function": {"name": "list_templates", "arguments": ""},
                                    }
                                ]
                            },
                            "finish_reason": None,
                        }
                    ]
                },
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {"index": 0, "function": {"arguments": '{"unused": true}'}}
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                },
            ]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def fake_openai() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOpenAI)
    server.daemon_threads = True
    server.records = []  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_fake_chat(channel: Channel, api_key: str = "") -> tuple[list[dict], str, dict]:
    status, started = channel.start_chat(
        {
            "providerId": "fake",
            "model": "fake-stream",
            "apiKey": api_key,
            "messages": [{"role": "user", "content": "列一下模板"}],
        }
    )
    check("C5 假 provider 能开一次对话", status == 200 and started.get("ok") is True, f"HTTP {status} {started}")
    chat_id = started.get("chatId", "")
    events, raw = channel.events(chat_id)
    return events, raw, started


def tests() -> None:
    channel = Channel(fake=True)
    try:
        hs = channel.handshake
        check(
            "C1 握手行含 port/token/pid",
            isinstance(hs.get("port"), int)
            and hs["port"] > 0
            and isinstance(hs.get("token"), str)
            and len(hs["token"]) >= 32
            and isinstance(hs.get("pid"), int),
            f"port={hs.get('port')} token_len={len(str(hs.get('token','')))} pid={hs.get('pid')}",
        )
        status, health = channel.json("GET", "/health")
        check("C1 /health 可用且报告 fake", status == 200 and health.get("ok") is True and health.get("fake") is True, f"HTTP {status} {health}")

        status, _ = channel.request("GET", "/health", headers={"Authorization": "Bearer wrong"})
        check("C2 错误 token 被拒", status == 401, f"HTTP {status}")
        conn = http.client.HTTPConnection("127.0.0.1", channel.port, timeout=10)
        conn.request("GET", "/health", headers={"Host": "evil.example"})
        resp = conn.getresponse()
        resp.read()
        conn.close()
        check("C2 非回环 Host 被拒（防 DNS rebinding）", resp.status == 403, f"HTTP {resp.status}")

        status, providers = channel.json("GET", "/providers")
        ids = [p.get("id") for p in providers.get("providers", [])]
        check("C3 provider 清单含 fake/deepseek/kimi/custom", status == 200 and {"fake", "deepseek", "kimi", "custom"} <= set(ids), f"HTTP {status} ids={ids}")
        blob = json.dumps(providers, ensure_ascii=False)
        check("C3 provider 清单不含密钥字段", "apiKey" not in blob and "api_key" not in blob and "key" not in providers.get("providers", [{}])[0], "只返回展示信息")

        events, raw, started = run_fake_chat(channel, api_key=SENTINEL)
        problems, how = schema_validate(events)
        check("C4 事件全部符合契约", not problems, f"判据 {how}；{problems[:3]}")
        ids_seq = [int(e["id"]) for e in events]
        check("C4 事件 id 从 1 连续递增", ids_seq == list(range(1, len(events) + 1)), f"{ids_seq[:5]}…{ids_seq[-2:]}")
        kinds = [e["event"] for e in events]
        check("C4 同时出现 reasoning/token/tool_call/done", {"reasoning", "token", "tool_call", "done"} <= set(kinds), f"{kinds[:8]}…")
        running = [e for e in events if e["event"] == "tool_call" and e["data"].get("status") == "running"]
        finished = [e for e in events if e["event"] == "tool_call" and e["data"].get("status") == "ok"]
        check(
            "C4 工具卡先 running 后 ok，结果含 25 个模板",
            bool(running)
            and bool(finished)
            and finished[0]["data"].get("result", {}).get("total") == 25,
            f"running={len(running)} ok={len(finished)} total={finished[0]['data'].get('result', {}).get('total') if finished else None}",
        )
        check("C4 done 原因 = stop", events and events[-1]["event"] == "done" and events[-1]["data"].get("reason") == "stop", str(events[-1] if events else None))
        check("C4 密钥不出现在事件流", SENTINEL not in raw, "已扫描整条 SSE")

        # 续传：先读 3 条就断开，再用 Last-Event-ID 接上
        status, started2 = channel.start_chat(
            {
                "providerId": "fake",
                "model": "fake-stream",
                "messages": [{"role": "user", "content": "再列一次"}],
            }
        )
        chat2 = started2.get("chatId", "")
        conn, resp = channel.open_events(chat2)
        first = [read_frame(resp) for _ in range(3)]
        conn.close()
        last_id = first[-1]["id"] if all(first) else "0"
        rest, _ = channel.events(chat2, last_id=last_id)
        resumed = rest[0]["event"] if rest else None
        check(
            "C6 Last-Event-ID 续传不重不漏",
            bool(rest) and int(rest[0]["id"]) == int(last_id) + 1 and rest[-1]["event"] == "done",
            f"断在 {last_id}，续得首条 id={rest[0]['id'] if rest else None} event={resumed}",
        )

        # 取消：慢一点的假 provider，确保取消发生在流中途
        slow = Channel(fake=True, env_extra={"MMS_FAKE_DELAY_MS": "120"})
        try:
            status, started3 = slow.start_chat(
                {
                    "providerId": "fake",
                    "model": "fake-stream",
                    "messages": [{"role": "user", "content": "慢速演示"}],
                }
            )
            chat3 = started3.get("chatId", "")
            time.sleep(0.2)
            status_cancel, _ = slow.json("POST", f"/chats/{chat3}/cancel")
            events3, _ = slow.events(chat3)
            check("C7 取消请求被接受", status_cancel == 200, f"HTTP {status_cancel}")
            check(
                "C7 取消后 done.reason=cancelled 且 done 在最后",
                bool(events3)
                and events3[-1]["event"] == "done"
                and events3[-1]["data"].get("reason") == "cancelled",
                f"最后事件 {events3[-1] if events3 else None}",
            )
        finally:
            slow.stop()

        status, bad = channel.json("POST", "/chats", {"providerId": "nope", "messages": [{"role": "user", "content": "x"}]})
        check("C8 未知 provider 返回 400", status == 400, f"HTTP {status} {bad}")
        status, bad = channel.json(
            "POST",
            "/chats",
            {"providerId": "deepseek", "model": "deepseek-chat", "messages": [{"role": "user", "content": "x"}]},
        )
        check("C8 缺 API Key 返回 400", status == 400, f"HTTP {status} {bad}")
        status, bad = channel.json(
            "POST",
            "/chats",
            {
                "providerId": "custom",
                "model": "x",
                "apiKey": SENTINEL,
                "baseUrl": "http://example.com/v1",
                "messages": [{"role": "user", "content": "x"}],
            },
        )
        check("C8 公网 http 端点被拒", status == 400, f"HTTP {status} {bad}")

        channel.stop()
        check("C9 stdout 只有握手一行", channel.extra_stdout.strip() == "", f"多余输出: {channel.extra_stdout[-120:]!r}")
        check("C9 stderr 不出现密钥", SENTINEL not in channel.stderr, "已扫描服务器 stderr")
    finally:
        channel.stop()

    bare = Channel(fake=False)
    try:
        status, providers = bare.json("GET", "/providers")
        ids = [p.get("id") for p in providers.get("providers", [])]
        check("C10 未显式启用时不出现 fake", status == 200 and "fake" not in ids, f"ids={ids}")
        status, out = bare.json(
            "POST",
            "/chats",
            {"providerId": "fake", "model": "fake-stream", "messages": [{"role": "user", "content": "x"}]},
        )
        check("C10 未启用时 fake 对话被拒", status == 400, f"HTTP {status} {out}")
    finally:
        bare.stop()

    # 真实 provider 路径：本地假 OpenAI 端点，先 429 再流式
    upstream = fake_openai()
    try:
        base = f"http://127.0.0.1:{upstream.server_address[1]}/v1"
        channel2 = Channel(fake=False)
        try:
            status, started = channel2.start_chat(
                {
                    "providerId": "custom",
                    "model": "test-model",
                    "apiKey": SENTINEL,
                    "baseUrl": base,
                    "messages": [{"role": "user", "content": "列模板"}],
                }
            )
            check("C11 自定义端点能开对话", status == 200 and started.get("ok") is True, f"HTTP {status} {started}")
            events, raw = channel2.events(started.get("chatId", ""))
            kinds = [e["event"] for e in events]
            check(
                "C11 429 后重试成功，聊天跑完",
                bool(events) and events[-1]["event"] == "done" and events[-1]["data"].get("reason") == "stop",
                f"最后事件 {events[-1] if events else None}",
            )
            check(
                "C11 reasoning 与 content 分开归一",
                any(e["event"] == "reasoning" and "想一想" in e["data"].get("text", "") for e in events)
                and any(e["event"] == "token" and "查模板" in e["data"].get("text", "") for e in events),
                f"事件 {kinds[:6]}",
            )
            tools_ok = [e for e in events if e["event"] == "tool_call" and e["data"].get("status") == "ok"]
            check("C11 分片 tool_call 被拼装并执行", bool(tools_ok) and tools_ok[0]["data"].get("result", {}).get("total") == 25, str(tools_ok[:1])[:200])
            check("C11 密钥不出现在事件流", SENTINEL not in raw, "已扫描整条 SSE")
            records = upstream.records  # type: ignore[attr-defined]
            check("C11 provider 收到 3 次请求（1 次 429 + 两轮对话）", len(records) == 3, f"实得 {len(records)} 次")
            if len(records) >= 3:
                replay = records[2]["body"].get("messages") or []
                replayed = json.dumps(replay, ensure_ascii=False)
                check(
                    "C11 回放历史已剥离 reasoning，且带 tool 结果",
                    "reasoning_content" not in replayed
                    and "reasoning" not in replayed
                    and any(m.get("role") == "tool" for m in replay)
                    and any(m.get("role") == "assistant" and m.get("tool_calls") for m in replay),
                    f"第 3 次请求角色 {[m.get('role') for m in replay]}",
                )
                check("C11 密钥只出现在 Authorization 头", records[2].get("auth") == f"Bearer {SENTINEL}", "头部存在，正文不含")

            # C14 思考深度与上下文预算真的进入请求体
            before = len(records)
            status, started = channel2.start_chat(
                {
                    "providerId": "custom",
                    "model": "test-model",
                    "apiKey": SENTINEL,
                    "baseUrl": base,
                    "thinking": "max",
                    "contextTokens": 50000,
                    "messages": [
                        {"role": "user", "content": "数" * 30000 + "甲"},
                        {"role": "assistant", "content": "数" * 30000 + "乙"},
                        {"role": "user", "content": "最新问题"},
                    ],
                }
            )
            events14, _ = channel2.events(started.get("chatId", ""))
            first_body = records[before]["body"] if len(records) > before else {}
            sent = first_body.get("messages") or []
            check(
                "C14 思维深度映射为 reasoning_effort",
                status == 200 and first_body.get("reasoning_effort") == "max",
                f"HTTP {status} effort={first_body.get('reasoning_effort')!r}",
            )
            check(
                "C14 上下文预算裁剪最早历史，保留锚点与最新一问",
                len(sent) == 3
                and sent[0].get("role") == "system"
                and str(sent[1].get("content") or "").startswith("【会话状态】")
                and sent[-1].get("content") == "最新问题"
                and all("数" * 100 not in str(m.get("content") or "") for m in sent),
                f"请求消息 {[(m.get('role'), str(m.get('content'))[:12]) for m in sent]}",
            )
            check(
                "C14 截断后对话仍能跑完",
                bool(events14) and events14[-1]["event"] == "done",
                f"最后事件 {events14[-1] if events14 else None}",
            )

            before = len(records)
            status, started = channel2.start_chat(
                {
                    "providerId": "custom",
                    "model": "test-model",
                    "apiKey": SENTINEL,
                    "baseUrl": base,
                    "thinking": "max",
                    "sendThinking": False,
                    "messages": [{"role": "user", "content": "不发送深度"}],
                }
            )
            events15, _ = channel2.events(started.get("chatId", ""))
            off_body = records[before]["body"] if len(records) > before else {}
            check(
                "C14 关闭开关时不带 reasoning_effort",
                status == 200 and "reasoning_effort" not in off_body,
                f"字段={sorted(off_body.keys())[:8]}",
            )

            def mapped(provider_id: str, model_name: str, depth: str) -> dict:
                payload: dict = {}
                apply_reasoning(payload, find_provider(provider_id) or {}, model_name, depth)
                return payload

            deep = mapped("deepseek", "deepseek-flash", "medium")
            kimi = mapped("kimi", "kimi-k2.6", "max")
            qwen = mapped("qwen", "qwen3.8-max", "medium")
            check(
                "C14 预设深度的参数映射",
                deep.get("reasoning_effort") == "low"
                and kimi.get("thinking", {}).get("type") == "enabled"
                and qwen.get("reasoning_effort") == "medium",
                f"deepseek={deep} kimi-k2.6={kimi} qwen={qwen}",
            )
            channel2.stop()
            check("C11 密钥不出现在服务器 stderr", SENTINEL not in channel2.stderr, "已扫描 stderr")
        finally:
            channel2.stop()
    finally:
        upstream.shutdown()
        upstream.server_close()

    # M3 编排闭环：暂停、恢复、换一批、选择，以及跨进程恢复
    workdir = tempfile.mkdtemp(prefix="mms-workflow-")
    try:
        wf = Channel(fake=True, env_extra={"MMS_DATA_DIR": workdir})
        try:
            problem = (
                "问题1 预测未来三个月的销量。\n问题2 给出补货建议。\n\n"
                "--- 附件（本机文件）---\n\n"
                "### sales.csv · 12 KB（120 行 × 3 列）\n"
                "month,region,sales\n2026-01,华东,120\n2026-02,华南,138\n\n"
                "--- 附件结束 ---"
            )
            status, started = wf.start_chat(
                {
                    "providerId": "fake",
                    "model": "fake-stream",
                    "mode": "workflow",
                    "messages": [{"role": "user", "content": problem}],
                }
            )
            sid = started.get("chatId", "")
            events, raw = wf.events(sid)
            problems, how = schema_validate(events)
            statuses = {e["data"]["phase"]: e["data"]["status"] for e in events if e["event"] == "phase"}
            card = next((e["data"] for e in events if e["event"] == "interrupt"), {})
            questions = card.get("payload", {}).get("questions", [])
            check(
                "C12 新赛题停在 K2，事件符合契约",
                status == 200 and not problems and events[-1]["data"].get("reason") == "waiting",
                f"HTTP {status}；{problems[:2]}；最后事件 {events[-1]['event'] if events else None}",
            )
            check(
                "C12 阶段 0 已过、阶段 1 等你确认",
                statuses.get(0) == "passed" and statuses.get(1) == "waiting",
                f"阶段状态 {statuses}",
            )
            attachments = card.get("payload", {}).get("attachments", [])
            check(
                "C12 K2 卡带子问题与附件清单",
                card.get("card") == "problem-confirm"
                and len(questions) >= 2
                and len(attachments) == 1
                and attachments[0].get("name") == "sales.csv"
                and "附件" in card.get("payload", {}).get("warning", ""),
                f"card={card.get('card')} questions={len(questions)} attachments={attachments}",
            )
            check(
                "C12 附件正文不参与子问题切分",
                all("month,region" not in str(q.get("text", "")) for q in questions),
                f"子问题 {[q.get('text', '')[:24] for q in questions]}",
            )
            check("C12 K2 的 SSE 不含密钥", SENTINEL not in raw, "已扫描整条 SSE")

            status, latest = wf.json("GET", "/sessions/latest")
            check(
                "C12 /sessions/latest 能读出待决卡",
                status == 200 and latest.get("session", {}).get("pending", {}).get("card") == "problem-confirm",
                f"HTTP {status} pending={(latest.get('session') or {}).get('pending', {}).get('card')}",
            )

            status, _ = wf.json("POST", f"/sessions/{sid}/resume", {"action": "confirm"})
            k3, _ = wf.events(sid)
            k3_card = next((e["data"] for e in k3 if e["event"] == "interrupt"), {})
            candidates = k3_card.get("payload", {}).get("candidates", [])
            k3_statuses = {e["data"]["phase"]: e["data"]["status"] for e in k3 if e["event"] == "phase"}
            check(
                "C12 确认后到 K3，三张候选且至少一项创新性高",
                status == 200
                and k3[-1]["data"].get("reason") == "waiting"
                and k3_card.get("card") == "model-choice"
                and len(candidates) == 3
                and any(c.get("innovation") == "高" for c in candidates),
                f"HTTP {status} candidates={len(candidates)} innovations={[c.get('innovation') for c in candidates]}",
            )
            check("C12 阶段 3 停在等你选", k3_statuses.get(3) == "waiting", f"阶段状态 {k3_statuses}")

            status, _ = wf.json("POST", f"/sessions/{sid}/resume", {"action": "reroll"})
            k3b, _ = wf.events(sid)
            card_b = next((e["data"] for e in k3b if e["event"] == "interrupt"), {})
            candidates_b = card_b.get("payload", {}).get("candidates", [])
            check(
                "C12 换一批返回新候选，待选不消失",
                status == 200
                and card_b.get("payload", {}).get("batch") == 2
                and candidates_b
                and candidates_b[0].get("name") != candidates[0].get("name")
                and k3b[-1]["data"].get("reason") == "waiting",
                f"batch={card_b.get('payload', {}).get('batch')} 首项 {candidates_b[0].get('name') if candidates_b else None}",
            )

            pick = candidates_b[0]["id"]
            status, _ = wf.json("POST", f"/sessions/{sid}/resume", {"action": "choose", "choice": pick})
            chosen, _ = wf.events(sid)
            chosen_statuses = {e["data"]["phase"]: e["data"]["status"] for e in chosen if e["event"] == "phase"}
            status, latest = wf.json("GET", "/sessions/latest")
            session = latest.get("session") or {}
            last_text = session.get("messages", [{}])[-1].get("content", "") if session.get("messages") else ""
            check(
                "C12 选择后阶段 3 过、阶段 4 真跑完，待决清空",
                status == 200
                and chosen_statuses.get(3) == "passed"
                and chosen_statuses.get(4) == "passed"
                and session.get("pending") is None
                and chosen[-1]["data"].get("reason") == "stop"
                and "阶段四完成" in last_text,
                f"状态 {chosen_statuses} pending={session.get('pending')} 文本={last_text[:60]}",
            )
            check(
                "C12 K3 的历史消息标了已选，K2 标了已确认",
                [m for m in session.get("messages", []) if m.get("interrupt") and m["interrupt"].get("resolved")]
                and all(
                    m["interrupt"].get("resolved")
                    for m in session.get("messages", [])
                    if m.get("interrupt")
                ),
                f"resolved={[m.get('interrupt', {}).get('resolved') for m in session.get('messages', []) if m.get('interrupt')]}",
            )
            status, out = wf.json("POST", f"/sessions/{sid}/resume", {"action": "confirm"})
            check("C12 没有待决时恢复被拒", status == 409, f"HTTP {status} {out}")
        finally:
            wf.stop()

        # 跨进程：换一个服务器进程，仍然读得到上一次的待选
        wf2 = Channel(fake=True, env_extra={"MMS_DATA_DIR": workdir})
        try:
            status, started = wf2.start_chat(
                {
                    "providerId": "fake",
                    "model": "fake-stream",
                    "mode": "workflow",
                    "messages": [{"role": "user", "content": "问题1 给某城市做公交调度优化。"}],
                }
            )
            sid2 = started.get("chatId", "")
            wf2.events(sid2)
        finally:
            wf2.stop()

        wf3 = Channel(fake=True, env_extra={"MMS_DATA_DIR": workdir})
        try:
            status, latest = wf3.json("GET", "/sessions/latest")
            session = latest.get("session") or {}
            check(
                "C13 服务器重启后仍停在原来的 K2",
                status == 200
                and session.get("id") == sid2
                and session.get("pending", {}).get("card") == "problem-confirm",
                f"id={session.get('id')} pending={(session.get('pending') or {}).get('card')}",
            )
            check(
                "C13 会话表里没有哨兵密钥",
                SENTINEL not in json.dumps(session, ensure_ascii=False),
                "已扫描快照",
            )
            status, _ = wf3.json("POST", f"/sessions/{sid2}/resume", {"action": "confirm"})
            after, _ = wf3.events(sid2)
            check(
                "C13 重启后仍能确认并进入 K3",
                status == 200
                and any(e["event"] == "interrupt" and e["data"].get("card") == "model-choice" for e in after),
                f"HTTP {status} 事件 {[e['event'] for e in after][:6]}",
            )
        finally:
            wf3.stop()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    failed = [r for r in results if not r["ok"]]
    for row in results:
        print(f"{'PASS' if row['ok'] else 'FAIL'} {row['name']}\n       {row['detail']}")
    print(f"\n{len(results) - len(failed)}/{len(results)} 条通道契约断言通过")
    raise SystemExit(0 if not failed else 1)


def selftest() -> None:
    good = {"id": "1", "event": "token", "data": {"text": "好"}}
    cases = [
        ("合法事件应通过", good, True),
        ("缺 id", {"event": "token", "data": {"text": "x"}}, False),
        ("id 为 0", {"id": "0", "event": "token", "data": {"text": "x"}}, False),
        ("未知事件类型", {"id": "1", "event": "chunk", "data": {"text": "x"}}, False),
        ("token 缺 text", {"id": "1", "event": "token", "data": {}}, False),
        ("tool_call 状态非法", {"id": "1", "event": "tool_call", "data": {"id": "c", "name": "n", "status": "done"}}, False),
        ("done 原因非法", {"id": "1", "event": "done", "data": {"reason": "ok"}}, False),
        ("phase 状态非法", {"id": "1", "event": "phase", "data": {"phase": 3, "status": "done"}}, False),
        ("phase 越界", {"id": "1", "event": "phase", "data": {"phase": 7, "status": "running"}}, False),
        ("done.waiting 合法", {"id": "1", "event": "done", "data": {"reason": "waiting"}}, True),
    ]
    rows = []
    for label, ev, want_pass in cases:
        problems = lint_event(ev)
        rows.append({"label": label, "pass": (not problems) if want_pass else bool(problems), "detail": problems or "通过"})
    bad = [r for r in rows if not r["pass"]]
    for row in rows:
        print(f"{'PASS' if row['pass'] else 'FAIL'} {row['label']}\n       {row['detail']}")
    print(f"\n{len(rows) - len(bad)}/{len(rows)} 条事件判据自测通过")
    raise SystemExit(0 if not bad else 1)


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        selftest()
    unknown = [a for a in sys.argv[1:] if a != "--selftest"]
    if unknown:
        print(f"用法错误: 未知参数 {unknown}", file=sys.stderr)
        raise SystemExit(2)
    tests()
