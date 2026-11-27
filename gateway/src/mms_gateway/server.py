"""本机通道服务器：stdout 握手，此后只走 127.0.0.1 HTTP + SSE。

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
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__
from .provider import ProviderError, find_provider, load_providers, validate_base_url

MAX_BODY = 1 << 20
MAX_PROBLEM = 200_000
PING_SECONDS = 15
DATA_SUFFIXES = (".csv", ".tsv", ".xlsx", ".docx", ".pdf", ".zip")


def data_root(root: Path) -> Path:
    return Path(os.environ.get("MMS_DATA_DIR") or (root / ".mms")).resolve()


def provider_rows() -> list[dict]:
    rows = [
        {
            "id": "fake",
            "display": "离线模式",
            "models": ["offline"],
            "model": "offline",
            "base_url": "",
            "requires_key": False,
            "custom": False,
            "note": "不联网：用内置基线与样例论文跑通链路。",
        }
    ]
    for item in load_providers():
        models = [str(m) for m in item.get("models") or []]
        rows.append(
            {
                "id": item.get("id"),
                "display": item.get("display"),
                "models": models,
                "model": models[0] if models else "",
                "base_url": item.get("base_url") or "",
                "requires_key": not item.get("custom"),
                "custom": bool(item.get("custom")),
                "note": item.get("note") or "",
            }
        )
    return rows


class RunJob:
    def __init__(self, run_id: str) -> None:
        self.id = run_id
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.done = False
        self.cancelled = False

    def emit(self, event: str, data: dict) -> None:
        with self.cond:
            self.events.append({"id": str(len(self.events) + 1), "event": event, "data": data})
            self.cond.notify_all()

    def finish(self) -> None:
        with self.cond:
            self.done = True
            self.cond.notify_all()

    def cancel(self) -> None:
        self.cancelled = True

    def should_stop(self) -> bool:
        return self.cancelled


class ChannelServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, token: str, root: Path, runner_factory=None):
        super().__init__(address, handler)
        self.token = token
        self.root = root
        self.runner_factory = runner_factory
        self.data_root = data_root(root)
        self.jobs: dict[str, RunJob] = {}
        self.jobs_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: ChannelServer

    def log_message(self, fmt: str, *args) -> None:
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
        if not hmac.compare_digest(auth, f"Bearer {self.server.token}"):
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
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
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
            self._json(200, {"ok": True, "version": __version__, "pid": os.getpid()})
            return
        if parsed.path == "/providers":
            self._json(200, {"ok": True, "providers": provider_rows()})
            return
        if parsed.path.startswith("/runs/") and parsed.path.endswith("/events"):
            run_id = parsed.path[len("/runs/") : -len("/events")].strip("/")
            self._stream(run_id, parse_qs(parsed.query))
            return
        self._error(404, "not_found", "没有这个端点")

    def do_POST(self) -> None:  # noqa: N802
        if not self._guard():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/runs":
            self._start_run()
            return
        if parsed.path.startswith("/runs/") and parsed.path.endswith("/cancel"):
            run_id = parsed.path[len("/runs/") : -len("/cancel")].strip("/")
            with self.server.jobs_lock:
                job = self.server.jobs.get(run_id)
            if not job:
                self._error(404, "run", "没有这个运行")
                return
            job.cancel()
            self._json(200, {"ok": True, "runId": run_id})
            return
        self._error(404, "not_found", "没有这个端点")

    def _start_run(self) -> None:
        body = self._body()
        if body is None:
            return
        problem = str(body.get("problem") or "").strip()
        if len(problem) > MAX_PROBLEM:
            self._error(400, "problem", "题面过长")
            return

        data_paths: list[Path] = []
        raw_paths = body.get("dataPaths")
        if isinstance(raw_paths, list):
            for item in raw_paths[:10]:
                if not isinstance(item, str) or not item:
                    continue
                candidate = Path(item)
                if candidate.is_file() and candidate.suffix.lower() in DATA_SUFFIXES:
                    data_paths.append(candidate.resolve())
        if not data_paths and raw_paths:
            self._error(400, "data", "数据文件需为存在的 CSV/TSV/XLSX/DOCX/PDF/ZIP")
            return
        if len(problem) < 10 and not data_paths:
            self._error(400, "problem", "题面至少写一句完整的题目描述，或附加含题面的 PDF/DOCX")
            return

        ctx = body.get("provider") if isinstance(body.get("provider"), dict) else {}
        provider_id = str(ctx.get("id") or "fake").strip()
        api_key = str(ctx.get("apiKey") or "")
        model = str(ctx.get("model") or "").strip()
        provider: dict | None = None
        if provider_id and provider_id != "fake":
            provider = find_provider(provider_id)
            if not provider:
                self._error(400, "provider", "未知服务商")
                return
            if provider.get("custom"):
                try:
                    provider["base_url"] = validate_base_url(str(ctx.get("baseUrl") or ""))
                except ProviderError as exc:
                    self._error(400, "provider", str(exc))
                    return
            if not api_key and not provider.get("custom"):
                self._error(400, "provider", "还没配置 API Key")
                return
        if not model:
            models = [str(m) for m in (provider or {}).get("models") or []]
            model = models[0] if models else "offline"

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        run_id = f"{stamp}-{secrets.token_hex(3)}"
        job_dir = self.server.data_root / "runs" / run_id
        try:
            job_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self._error(500, "dir", f"运行目录创建失败：{exc}")
            return

        if self.server.runner_factory is None:
            self._error(503, "runner", "服务端没有装配数模流水线")
            return

        job = RunJob(run_id)
        with self.server.jobs_lock:
            while len(self.server.jobs) >= 20:
                oldest = next(iter(self.server.jobs))
                self.server.jobs.pop(oldest, None)
            self.server.jobs[run_id] = job

        runner = self.server.runner_factory(
            job_dir=job_dir,
            problem=problem,
            data_paths=data_paths,
            provider=provider,
            api_key=api_key,
            model=model,
            emit=job.emit,
            should_stop=job.should_stop,
        )

        def _run() -> None:
            try:
                runner.run()
            finally:
                job.finish()

        threading.Thread(target=_run, name=f"mms-run-{run_id}", daemon=True).start()
        self._json(200, {"ok": True, "runId": run_id})

    def _stream(self, run_id: str, query: dict) -> None:
        with self.server.jobs_lock:
            job = self.server.jobs.get(run_id)
        if not job:
            self._error(404, "run", "没有这个运行")
            return

        raw_last = (self.headers.get("Last-Event-ID") or (query.get("last_id") or [""])[0] or "0").strip()
        try:
            last_id = max(0, int(raw_last))
        except ValueError:
            last_id = 0

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b"retry: 1500\n\n")
            self.wfile.flush()
            index = min(last_id, len(job.events))
            last_ping = time.monotonic()
            while True:
                with job.cond:
                    while index >= len(job.events) and not job.done:
                        job.cond.wait(timeout=PING_SECONDS)
                        if index >= len(job.events):
                            break
                    pending = job.events[index:]
                    done = job.done
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


def serve(port: int = 0, runner_factory=None) -> int:
    token = secrets.token_hex(24)
    root = Path(os.environ.get("MMS_HOME") or ".").resolve()
    server = ChannelServer(("127.0.0.1", port), Handler, token, root, runner_factory)
    print(
        json.dumps(
            {
                "port": server.server_address[1],
                "token": token,
                "pid": os.getpid(),
                "fake": True,
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
