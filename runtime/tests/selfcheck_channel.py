"""G4/G5 · 本机通道与 provider 流式契约自检。

不需要真实 API Key、不访问公网：通道用 MMS_FAKE_PROVIDER=1 的本地假 provider，
provider 路径用 127.0.0.1 上的假 OpenAI 端点（含 429 重试、reasoning_content 剥离、
tool_calls 增量拼装）。

每条断言都能失败；--selftest 用多份坏事件证明事件判据本身会拒绝它们。
--core dsh 另起本地假 OpenAI 与 dsh web，验证适配层的流式、工具与取消。
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

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "schemas" / "chat-events.schema.json"
SENTINEL = "sk-test-SENTINEL-DO-NOT-LEAK"
EVENT_TYPES = {"token", "reasoning", "tool_call", "compaction", "artifact", "interrupt", "gate", "phase", "error", "done"}
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
    elif event == "compaction":
        for key in ("before", "after", "pruned", "summarized", "dropped"):
            if not isinstance(data.get(key), int) or data.get(key) < 0:
                problems.append(f"compaction.{key} 必须是非负整数")
        if not isinstance(data.get("reason"), str) or not data.get("reason"):
            problems.append("compaction 缺 reason")
        if "summary" in data and not isinstance(data["summary"], str):
            problems.append("compaction.summary 必须是字符串")
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
        # 外壳环境可能带着 MMS_CORE；测试默认锁定到 python，除非显式覆盖。
        # 传 "" 表示不设置，用来验证自动路由。
        core = (env_extra or {}).get("MMS_CORE")
        env["MMS_CORE"] = "python" if core is None else core
        if not env["MMS_CORE"]:
            del env["MMS_CORE"]
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
        if getattr(self.server, "rate_limit", True) and len(self.server.records) == 1:
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
        tool_name = getattr(self.server, "tool_name", "list_templates")
        tool_args = getattr(self.server, "tool_args", '{"unused": true}')
        has_tool_result = any(m.get("role") == "tool" for m in messages)
        if tool_name and not has_tool_result:
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
                                        "function": {"name": tool_name, "arguments": ""},
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
                                    {"index": 0, "function": {"arguments": tool_args}}
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                },
            ]
        else:
            chunks = [
                {"choices": [{"delta": {"reasoning_content": "想一想。"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "第一段"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "第二段"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        delay = float(getattr(self.server, "delay", 0.0) or 0.0)
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()
            if delay:
                time.sleep(delay)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def fake_openai(tool_name="list_templates", delay: float = 0.0, rate_limit: bool = True) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOpenAI)
    server.daemon_threads = True
    server.records = []  # type: ignore[attr-defined]
    server.tool_name = tool_name  # type: ignore[attr-defined]
    server.tool_args = '{"unused": true}'  # type: ignore[attr-defined]
    server.delay = delay  # type: ignore[attr-defined]
    server.rate_limit = rate_limit  # type: ignore[attr-defined]
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


def finish() -> None:
    failed = [r for r in results if not r["ok"]]
    for row in results:
        print(f"{'PASS' if row['ok'] else 'FAIL'} {row['name']}\n       {row['detail']}")
    print(f"\n{len(results) - len(failed)}/{len(results)} 条通道契约断言通过")
    raise SystemExit(0 if not failed else 1)


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

            # C15 上下文卡片：用户在对话里问该用什么模型，工具推送选模卡
            upstream.tool_name = "suggest_models"
            upstream.tool_args = '{"batch": 1, "question": "预测未来三个月的销量"}'
            status, started_card = channel2.start_chat(
                {
                    "providerId": "custom",
                    "model": "test-model",
                    "apiKey": SENTINEL,
                    "baseUrl": base,
                    "messages": [{"role": "user", "content": "这道销量预测题该用什么模型？"}],
                }
            )
            card_events, card_raw = channel2.events(started_card.get("chatId", ""))
            card_problems, card_how = schema_validate(card_events)
            interrupts = [e for e in card_events if e["event"] == "interrupt"]
            payload = interrupts[0]["data"].get("payload", {}) if interrupts else {}
            cards = payload.get("candidates") or []
            from mms import orchestrator as _orch

            expected = _orch.model_candidates("预测未来三个月的销量", 1)
            check(
                "C15 选模卡通过 interrupt 事件推送",
                status == 200
                and bool(interrupts)
                and interrupts[0]["data"].get("card") == "model-choice"
                and len(cards) == 3
                and not card_problems,
                f"HTTP {status} interrupts={len(interrupts)} cards={len(cards)} 判据={card_how} {card_problems[:2]}",
            )
            check(
                "C15 卡片候选与编排器同源",
                [c.get("name") for c in cards] == [c.get("name") for c in expected],
                f"cards={[c.get('name') for c in cards]} expected={[c.get('name') for c in expected]}",
            )
            check("C15 卡片事件不含密钥", SENTINEL not in card_raw, "已扫描 SSE")
            upstream.tool_name = "list_templates"
            upstream.tool_args = '{"unused": true}'
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

    finish()


def tests_dsh() -> None:
    try:
        from mms.dsh_adapter import find_dsh

        dsh = find_dsh()
    except Exception as exc:  # noqa: BLE001
        check("D0 找到 dsh 可执行文件", False, f"设置 MMS_DSH_BIN 或装到 vendor/python/Scripts：{exc}")
        finish()

    workdir = Path(tempfile.mkdtemp(prefix="mms-dsh-core-"))
    wsdir = workdir / "ws"
    wsdir.mkdir()
    home = workdir / "dsh"
    upstream = fake_openai(tool_name=None, rate_limit=False)
    channel = None
    try:
        try:
            channel = Channel(
                fake=False,
                env_extra={
                    "MMS_CORE": "dsh",
                    "MMS_DSH_BIN": str(dsh),
                    "MMS_DSH_HOME": str(home),
                    "MMS_DATA_DIR": str(workdir),
                },
            )
        except Exception as exc:  # noqa: BLE001
            check("D1 DSH sidecar 能启动", False, repr(exc))
            finish()
        status, health = channel.json("GET", "/health")
        check(
            "D1 /health 报告 core=dsh",
            status == 200 and health.get("core") == "dsh",
            f"HTTP {status} {health}",
        )
        check(
            "D1b /health 报告 dshVersion",
            status == 200 and (health.get("dshVersion") or "").startswith("0.2."),
            f"dshVersion={health.get('dshVersion')}",
        )

        base = f"http://127.0.0.1:{upstream.server_address[1]}/v1"
        body = {
            "providerId": "custom",
            "model": "fake-model",
            "apiKey": SENTINEL,
            "baseUrl": base,
            "workspace": str(wsdir),
            "messages": [{"role": "user", "content": "你好"}],
        }
        status, started = channel.start_chat(body)
        check("D2 DSH 对话能启动", status == 200 and started.get("ok") is True, f"HTTP {status} {started}")
        events, raw = channel.events(started.get("chatId", ""))
        problems, how = schema_validate(events)
        check("D2 事件符合契约", not problems, f"判据 {how}；{problems[:3]}")
        ids = [int(e["id"]) for e in events]
        check("D2 事件 id 从 1 连续递增", ids == list(range(1, len(events) + 1)), f"{ids[:5]}…{ids[-2:]}")
        kinds = [e["event"] for e in events]
        check(
            "D2 同时出现 reasoning/token/done",
            {"reasoning", "token", "done"} <= set(kinds) and kinds.count("token") >= 2,
            f"{kinds}",
        )
        check(
            "D2 done.reason=stop 且 done 在最后",
            bool(events) and events[-1]["event"] == "done" and events[-1]["data"].get("reason") == "stop",
            str(events[-1] if events else None),
        )
        check("D2 密钥不进入 SSE", SENTINEL not in raw, "已扫描整条 SSE")

        upstream.tool_name = "skill"
        upstream.tool_args = '{"name":"mathmodel-core"}'
        upstream.delay = 0.0
        status, started_tool = channel.start_chat(
            {**body, "messages": [{"role": "user", "content": "加载核心技能"}]}
        )
        tool_events, _ = channel.events(started_tool.get("chatId", ""))
        tool_problems, _ = schema_validate(tool_events)
        running = [e for e in tool_events if e["event"] == "tool_call" and e["data"].get("status") == "running"]
        finished_tool = [e for e in tool_events if e["event"] == "tool_call" and e["data"].get("status") in ("ok", "error")]
        check(
            "D2b DSH 工具先 running 后结束",
            status == 200 and bool(running) and bool(finished_tool) and not tool_problems,
            f"HTTP {status} running={len(running)} finished={len(finished_tool)} problems={tool_problems[:2]}",
        )
        check(
            "D2b 技能工具执行成功",
            bool(finished_tool)
            and finished_tool[0]["data"].get("status") == "ok"
            and "mathmodel-core" in json.dumps(finished_tool[0]["data"], ensure_ascii=False),
            str(finished_tool[:1])[:300],
        )
        tool_kinds = [e["event"] for e in tool_events]
        check(
            "D2b 工具回合仍有 token 与 done",
            "token" in tool_kinds and tool_kinds[-1] == "done",
            f"{tool_kinds}",
        )

        upstream.tool_name = "mcp__mms__list_templates"
        upstream.tool_args = "{}"
        upstream.delay = 0.0
        status, started_mcp = channel.start_chat(
            {**body, "messages": [{"role": "user", "content": "列出模板"}]}
        )
        mcp_events, _ = channel.events(started_mcp.get("chatId", ""))
        mcp_problems, _ = schema_validate(mcp_events)
        running_mcp = [e for e in mcp_events if e["event"] == "tool_call" and e["data"].get("status") == "running"]
        finished_mcp = [e for e in mcp_events if e["event"] == "tool_call" and e["data"].get("status") in ("ok", "error")]
        check(
            "D2c MCP 工具可用并跑完",
            status == 200 and bool(running_mcp) and bool(finished_mcp) and not mcp_problems,
            f"HTTP {status} running={len(running_mcp)} finished={len(finished_mcp)} problems={mcp_problems[:2]}",
        )
        result = finished_mcp[0]["data"].get("result") if finished_mcp else {}
        check(
            "D2c MCP 工具 result.total == 25",
            isinstance(result, dict) and result.get("total") == 25,
            f"{json.dumps(result, ensure_ascii=False)[:300]}",
        )
        try:
            from mms.invoke import list_templates

            expected_templates = list_templates()
        except Exception as exc:  # noqa: BLE001
            expected_templates = None
        expected_counts: dict[str, int] = {}
        for row in expected_templates or []:
            skill = str(row.get("skill") or "")
            expected_counts[skill] = expected_counts.get(skill, 0) + 1
        check(
            "D2c MCP 工具结果与 CLI 逐字段一致",
            isinstance(expected_templates, list)
            and isinstance(result, dict)
            and result.get("templates") == expected_templates
            and result.get("by_skill") == expected_counts,
            f"result.templates={len((result or {}).get('templates') or [])} expected={len(expected_templates or [])} by_skill={result.get('by_skill') if isinstance(result, dict) else None}",
        )

        upstream.tool_name = "mcp__mms__suggest_models"
        upstream.tool_args = '{"question": "预测未来三个月的销量", "batch": 1}'
        upstream.delay = 0.0
        status, started_card = channel.start_chat(
            {**body, "messages": [{"role": "user", "content": "该用什么模型？"}]}
        )
        card_events, _ = channel.events(started_card.get("chatId", ""))
        interrupts = [e for e in card_events if e["event"] == "interrupt"]
        payload = interrupts[0]["data"].get("payload", {}) if interrupts else {}
        cards = payload.get("candidates") or []
        from mms import orchestrator as _orch

        expected_cards = _orch.model_candidates("预测未来三个月的销量", 1)
        check(
            "D2d DSH 选模卡通过 interrupt 推送",
            status == 200
            and bool(interrupts)
            and interrupts[0]["data"].get("card") == "model-choice"
            and len(cards) == 3
            and [c.get("name") for c in cards] == [c.get("name") for c in expected_cards],
            f"HTTP {status} interrupts={len(interrupts)} cards={[c.get('name') for c in cards]}",
        )
        upstream.tool_name = None
        upstream.tool_args = '{"unused": true}'

        # 供应商与思考档位映射：代码级断言 base_url/effort。
        from mms import dsh_adapter, dsh_provider
        from mms.provider import find_provider

        deepseek = find_provider("deepseek")
        check(
            "D6a deepseek 思考档位映射",
            dsh_provider.effort_table(deepseek, "deepseek-v4-pro")
            == {"medium": "low", "high": "high", "max": "max"},
            f"efforts={dsh_provider.effort_table(deepseek, 'deepseek-v4-pro')}",
        )
        qwen = find_provider("qwen")
        check(
            "D6b qwen 思考档位映射",
            dsh_provider.effort_table(qwen, "qwen3.8-max")
            == {"medium": "medium", "high": "high", "max": "max"},
            f"efforts={dsh_provider.effort_table(qwen, 'qwen3.8-max')}",
        )
        kimi = find_provider("kimi")
        check(
            "D6c kimi-k2.x 关思考",
            dsh_provider.effort_table(kimi, "kimi-k2.6") == {}
            and dsh_provider.default_effort(kimi, "kimi-k2.6", "max", True) is None,
            f"efforts={dsh_provider.effort_table(kimi, 'kimi-k2.6')}",
        )
        custom = find_provider("custom")
        custom["base_url"] = base
        patch = dsh_adapter.build_patch(custom, "custom-model", wsdir, 50_000, "max", True)
        check(
            "D6d custom 思考档位与 baseURL",
            f'baseURL: {json.dumps(base)}' in patch
            and 'reasoningEffort: "max"' in patch
            and "reasoningEfforts:\n              off:\n" in patch,
            f"baseURL={base in patch} effort={('reasoningEffort: \"max\"' in patch)}",
        )

        # DSH 线上行为： reasoning_effort/max 与 sendThinking=False
        records_before = len(upstream.records)
        status, started_effort = channel.start_chat(
            {**body, "messages": [{"role": "user", "content": "深度演示"}], "thinking": "max"}
        )
        channel.events(started_effort.get("chatId", ""))
        deep_bodies = [r["body"] for r in upstream.records[records_before:] if isinstance(r["body"], dict) and (r["body"].get("messages") or [])]
        check(
            "D6e thinking=max 发送 wire effort",
            bool(deep_bodies) and any(b.get("reasoning_effort") == "max" for b in deep_bodies),
            f"bodies={[b.get('reasoning_effort') for b in deep_bodies]}",
        )
        records_before = len(upstream.records)
        status, started_off = channel.start_chat(
            {
                **body,
                "messages": [{"role": "user", "content": "关闭思考"}],
                "thinking": "max",
                "sendThinking": False,
            }
        )
        channel.events(started_off.get("chatId", ""))
        off_bodies = [r["body"] for r in upstream.records[records_before:] if isinstance(r["body"], dict) and (r["body"].get("messages") or [])]
        check(
            "D6f sendThinking=false 不发送 effort",
            bool(off_bodies) and all("reasoning_effort" not in b for b in off_bodies),
            f"bodies={[b.get('reasoning_effort') for b in off_bodies]}",
        )

        # 同一会话的续聊：第二轮只把新增 user 发给 provider，不重建 session。
        upstream.tool_name = None
        upstream.tool_args = '{"unused": true}'
        upstream.delay = 0.0
        status, started_first = channel.start_chat(
            {**body, "messages": [{"role": "user", "content": "一轮"}]}
        )
        records_before = len(upstream.records)
        first_events, _ = channel.events(started_first.get("chatId", ""))
        first_user = [
            m
            for r in upstream.records[records_before:]
            if isinstance(r["body"], dict)
            for m in (r["body"].get("messages") or [])
            if isinstance(m, dict) and m.get("role") == "user"
        ]
        check(
            "D7a 首轮 prompt 只有第一问",
            bool(first_user)
            and started_first.get("chatId")
            and first_user[0].get("content") == "一轮"
            and len(first_events) > 0
            and first_events[-1]["event"] == "done",
            f"first_user={first_user[:1]} last_events={first_events[-1] if first_events else None}",
        )
        status, started_second = channel.start_chat(
            {
                **body,
                "messages": [
                    {"role": "user", "content": "一轮"},
                    {"role": "assistant", "content": "第一句回复"},
                    {"role": "user", "content": "两轮"},
                ],
            }
        )
        records_before2 = len(upstream.records)
        second_events, _ = channel.events(started_second.get("chatId", ""))
        tail_user = [
            m
            for r in upstream.records[records_before2:]
            if isinstance(r["body"], dict)
            for m in (r["body"].get("messages") or [])
            if isinstance(m, dict) and m.get("role") == "user"
        ]
        check(
            "D7b 续聊只发新增 user，不重发 transcript",
            bool(tail_user) and tail_user[-1].get("content") == "两轮" and not tail_user[-1].get("content").endswith("一轮") and bool(second_events) and second_events[-1]["event"] == "done",
            f"tail_user={tail_user[-1] if tail_user else None} last_events={second_events[-1] if second_events else None}",
        )

        # 取消：慢速假模型，收到第一个 token 后调 /cancel
        upstream.delay = 0.4
        status, started2 = channel.start_chat(
            {
                **body,
                "messages": [{"role": "user", "content": "慢速演示"}],
            }
        )
        chat2 = started2.get("chatId", "")
        conn, resp = channel.open_events(chat2)
        frames = []
        first_token = None
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                frame = read_frame(resp)
                if frame is None:
                    break
                frames.append(frame)
                if frame["event"] == "token":
                    first_token = frame
                    break
            check("D3 取消前收到 token", first_token is not None, f"已读 {len(frames)} 帧")
            cancel_start = time.monotonic()
            status_cancel, _ = channel.json("POST", f"/chats/{chat2}/cancel")
            check("D3 取消请求被接受", status_cancel == 200, f"HTTP {status_cancel}")
            while time.monotonic() - cancel_start < 10:
                frame = read_frame(resp)
                if frame is None:
                    break
                frames.append(frame)
        finally:
            conn.close()
        latency = time.monotonic() - cancel_start if first_token is not None else -1
        check(
            "D3 3 秒内 done=cancelled 且 done 在最后",
            bool(frames)
            and frames[-1]["event"] == "done"
            and frames[-1]["data"].get("reason") == "cancelled"
            and latency <= 3.0,
            f"最后事件 {frames[-1] if frames else None}，延迟 {latency:.2f}s",
        )
        cancel_problems, _ = schema_validate(frames)
        check("D3 取消后的事件仍符合契约", not cancel_problems, f"{cancel_problems[:3]}")
        cancel_ids = [int(e["id"]) for e in frames]
        check(
            "D3 取消后 id 仍连续递增",
            cancel_ids == list(range(1, len(cancel_ids) + 1)),
            f"{cancel_ids[:5]}…{cancel_ids[-2:]}",
        )

        # 负向：DSH 二进制指向不存在路径，启动应明确报错，不能静默回退。
        negative = Channel(
            fake=False,
            env_extra={
                "MMS_CORE": "dsh",
                "MMS_DSH_BIN": str(workdir / "missing" / "dsh.exe"),
                "MMS_DSH_HOME": str(home),
                "MMS_DATA_DIR": str(workdir),
            },
        )
        try:
            status, neg_started = negative.start_chat(
                {
                    **body,
                    "messages": [{"role": "user", "content": "缺 DSH"}],
                }
            )
            neg_events, neg_raw = negative.events(neg_started.get("chatId", ""))
            neg_errors = [e for e in neg_events if e["event"] == "error"]
            neg_tail = neg_events[-1] if neg_events else None
            check(
                "D8 DSH 缺失时明确报错",
                status == 200
                and any(
                    "找不到 dsh" in json.dumps(e["data"], ensure_ascii=False)
                    or "MMS_DSH_BIN" in json.dumps(e["data"], ensure_ascii=False)
                    for e in neg_errors
                )
                and neg_tail is not None
                and neg_tail["event"] == "done"
                and neg_tail["data"].get("reason") == "error",
                f"errors={[e['data'] for e in neg_errors][:1]} tail={neg_tail}",
            )
            check(
                "D8 报错不含密钥",
                SENTINEL not in neg_raw and SENTINEL not in (negative.stderr or ""),
                "已扫描事件与 stderr",
            )
        finally:
            negative.stop()

        # 自动路由：不设 MMS_CORE 时默认 DSH；离线演示固定走 python，不需要 Key 与 dsh 对话。
        auto = Channel(
            fake=True,
            env_extra={"MMS_CORE": "", "MMS_DSH_HOME": str(home), "MMS_DATA_DIR": str(workdir)},
        )
        try:
            status, health_auto = auto.json("GET", "/health")
            check(
                "D9 未指定内核时 /health 报 dsh",
                status == 200 and health_auto.get("core") == "dsh",
                f"HTTP {status} {health_auto}",
            )
            status, started_auto = auto.start_chat(
                {
                    "providerId": "fake",
                    "model": "fake-stream",
                    "messages": [{"role": "user", "content": "离线演示"}],
                }
            )
            auto_events, auto_raw = auto.events(started_auto.get("chatId", ""))
            check(
                "D9 离线演示自动落到 python 并跑完",
                status == 200
                and bool(auto_events)
                and auto_events[-1]["event"] == "done"
                and auto_events[-1]["data"].get("reason") == "stop"
                and SENTINEL not in auto_raw,
                f"HTTP {status} tail={auto_events[-1] if auto_events else None}",
            )
        finally:
            auto.stop()
    finally:
        if channel is not None:
            channel.stop()

    leaks = []
    for path in home.rglob("*"):
        if not path.is_file():
            continue
        try:
            if SENTINEL.encode("utf-8") in path.read_bytes():
                leaks.append(str(path))
        except OSError:
            continue
    check("D4 密钥不落在 DSH_HOME", not leaks, f"命中 {leaks[:3]}")
    check("D5 密钥不进入 DSH stderr", SENTINEL not in (channel.stderr if channel else ""), "已扫描 stderr")
    upstream.shutdown()
    upstream.server_close()
    shutil.rmtree(workdir, ignore_errors=True)
    finish()


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
        (
            "compaction 合法",
            {"id": "1", "event": "compaction", "data": {"reason": "auto", "before": 10, "after": 5, "pruned": 1, "summarized": 0, "dropped": 0}},
            True,
        ),
        (
            "compaction 缺字段",
            {"id": "1", "event": "compaction", "data": {"reason": "auto", "before": 10}},
            False,
        ),
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


def run_with_dsh_python(argv: list[str]) -> int | None:
    """DSH 自检要用随包解释器：SDK 与 dsh.exe 都装在 vendor/python。

    系统 python 未必装过 deepseek-harness-sdk，这时 /health 的 dshVersion 会是 None，
    验的就不是要发布的组合。返回 None 表示已经在目标解释器里，继续跑。
    Windows 上 os.execve 会把含空格的路径拼坏，所以走 subprocess 转发。
    """
    if os.environ.get("MMS_CHECK_REEXEC") == "1":
        return None
    vendor = ROOT / "vendor" / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    if not vendor.is_file() or Path(sys.executable).resolve() == vendor.resolve():
        return None
    env = {**os.environ, "MMS_CHECK_REEXEC": "1"}
    return subprocess.run(
        [str(vendor), str(Path(__file__).resolve()), *argv],
        cwd=str(ROOT),
        env=env,
    ).returncode


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    core = "python"
    rest: list[str] = []
    index = 0
    while index < len(args):
        if args[index] == "--core":
            if index + 1 >= len(args):
                print("用法错误: --core 需要 python 或 dsh", file=sys.stderr)
                return 2
            core = args[index + 1]
            index += 2
            continue
        rest.append(args[index])
        index += 1
    if "--selftest" in rest:
        selftest()
    unknown = [value for value in rest if value != "--selftest"]
    if unknown or core not in ("python", "dsh"):
        print(f"用法错误: 未知参数 {unknown or core}", file=sys.stderr)
        return 2
    if core == "dsh":
        forwarded = run_with_dsh_python([*args])
        if forwarded is not None:
            return forwarded
        tests_dsh()
    else:
        tests()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
