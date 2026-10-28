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
import subprocess
import sys
import threading
import time
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schemas" / "chat-events.schema.json"
SENTINEL = "sk-test-SENTINEL-DO-NOT-LEAK"
EVENT_TYPES = {"token", "reasoning", "tool_call", "artifact", "interrupt", "gate", "error", "done"}
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
    elif event == "error":
        if not isinstance(data.get("message"), str) or not data.get("message"):
            problems.append("error 缺 message")
    elif event == "done":
        if data.get("reason") not in ("stop", "error", "cancelled", "max_tool_rounds"):
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
            channel2.stop()
            check("C11 密钥不出现在服务器 stderr", SENTINEL not in channel2.stderr, "已扫描 stderr")
        finally:
            channel2.stop()
    finally:
        upstream.shutdown()
        upstream.server_close()

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
