"""DSH Web 适配层：本机子进程 + HTTP REST + WebSocket follow。

P0 结论：只有 Web API 的 `session/follow` 能实时推送增量；Python SDK 与
headless 都只在 turn 结束后给持久事件。因此这里直接管理 `dsh web` 子进程，
不依赖 SDK。

安全边界：
- 只连 127.0.0.1；token 与 cookie 只存在内存。
- 子进程环境里带 API Key，但不写日志、不进事件、不写 profile 文件。
- Windows 上用 Job Object 让子进程随本进程退出，避免 Electron 强杀后残留。
"""

from __future__ import annotations

import atexit
import base64
import hashlib
import http.client
import json
import os
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

from .server import ChatSession
from .store import data_dir
from . import dsh_provider

READY_TIMEOUT = 40.0
STDERR_LINES = 200
MAX_FRAME_BYTES = 32 * 1024 * 1024
WS_RECV_TIMEOUT = 1.0
TURN_TIMEOUT = 900.0
TURN_GRACE = 0.5
MAX_TOOL_RESULT_CHARS = 8_000
URL_RE = re.compile(r"(http://127\.0\.0\.1:(\d+)/\?token=([\w\-]+))")


class DshError(RuntimeError):
    """DSH 子进程、认证或 RPC 失败。错误文本不包含 API Key。"""


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def find_dsh(explicit: str = "") -> Path:
    """按显式路径、环境变量、当前解释器、PATH 的顺序找 dsh。"""
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    env_bin = os.environ.get("MMS_DSH_BIN")
    if env_bin:
        candidates.append(Path(env_bin))
    exe_dir = Path(sys.executable).resolve().parent
    candidates.extend(
        [
            exe_dir / "dsh.exe",
            exe_dir / "Scripts" / "dsh.exe",
            repo_root() / "vendor" / "python" / "Scripts" / "dsh.exe",
        ]
    )
    found = shutil.which("dsh")
    if found:
        candidates.append(Path(found))
    for path in candidates:
        if path.is_file():
            return path
    raise DshError(
        "找不到 dsh 可执行文件；请把 MMS_DSH_BIN 指向 dsh.exe，"
        "或把 deepseek-harness-sdk 安装到随包 Python"
    )


def _origin(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def _auth_cookie(port: int, token: str) -> str:
    """访问带 token 的入口，拿 Set-Cookie；后续 REST 与 WS 都靠它。"""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        conn.request("GET", f"/?token={token}", headers={"Origin": _origin(port)})
        resp = conn.getresponse()
        raw_cookies = resp.headers.get_all("Set-Cookie") or []
        resp.read()
        pairs = []
        for raw in raw_cookies:
            pair = raw.split(";", 1)[0].strip()
            if pair:
                pairs.append(pair)
        if not pairs:
            raise DshError(f"DSH 入口没有返回认证 cookie（HTTP {resp.status}）")
        cookie = "; ".join(pairs)
        conn.request("GET", "/", headers={"Origin": _origin(port), "Cookie": cookie})
        resp = conn.getresponse()
        resp.read()
        return cookie
    finally:
        conn.close()


class WsClient:
    """够用的 RFC6455 客户端：文本帧、分片、ping/pong、close。"""

    def __init__(self, sock: socket.socket, buf: bytes = b""):
        self.sock = sock
        self.buf = buf
        self.closed = False
        self._send_lock = threading.Lock()

    @classmethod
    def connect(cls, port: int, path: str, cookie: str, origin: str) -> "WsClient":
        sock = socket.create_connection(("127.0.0.1", port), timeout=15)
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Origin: {origin}\r\n"
            f"Cookie: {cookie}\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = sock.recv(4096)
            if not chunk:
                raise DshError("WebSocket 握手时连接被关闭")
            raw += chunk
            if len(raw) > 64 * 1024:
                raise DshError("WebSocket 握手响应过大")
        head, rest = raw.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        if " 101 " not in f" {status} ":
            raise DshError(f"WebSocket 升级失败：{status}")
        return cls(sock, rest)

    def _read_exact(self, size: int) -> bytes:
        while len(self.buf) < size:
            chunk = self.sock.recv(65536)
            if not chunk:
                self.closed = True
                raise DshError("WebSocket 连接已关闭")
            self.buf += chunk
        out, self.buf = self.buf[:size], self.buf[size:]
        return out

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        size = len(payload)
        if size < 126:
            header.append(0x80 | size)
        elif size < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", size)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", size)
        mask = secrets.token_bytes(4)
        header += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        with self._send_lock:
            self.sock.sendall(bytes(header) + masked)

    def recv(self, timeout: float = WS_RECV_TIMEOUT) -> str | None:
        """返回一条文本消息；超时返回 None；对端 close 返回 None。"""
        if self.closed:
            return None
        self.sock.settimeout(max(0.05, timeout))
        fragments = b""
        while True:
            try:
                first = self._read_exact(2)
            except socket.timeout:
                return None
            except DshError:
                return None
            opcode = first[0] & 0x0F
            fin = bool(first[0] & 0x80)
            length = first[1] & 0x7F
            masked = bool(first[1] & 0x80)
            try:
                if length == 126:
                    length = struct.unpack(">H", self._read_exact(2))[0]
                elif length == 127:
                    length = struct.unpack(">Q", self._read_exact(8))[0]
                if length > MAX_FRAME_BYTES:
                    self.close()
                    raise DshError("WebSocket 帧超过 32MB")
                mask = self._read_exact(4) if masked else b""
                payload = self._read_exact(length)
            except socket.timeout:
                return None
            except DshError:
                return None
            if masked and mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 0x8:
                self.closed = True
                return None
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                fragments = payload
            elif opcode == 0x0:
                fragments += payload
            else:
                continue
            if not fin:
                continue
            try:
                return fragments.decode("utf-8")
            except UnicodeDecodeError:
                return fragments.decode("utf-8", "replace")

    def close(self) -> None:
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass


class DshRuntime:
    """一个 `dsh web` 子进程，多个会话共享。"""

    def __init__(self, patch_text: str, home: Path, workspace: Path, api_key: str):
        self.patch_text = patch_text
        self.home = Path(home)
        self.workspace = Path(workspace)
        self.api_key = api_key
        self.proc: subprocess.Popen | None = None
        self.port = 0
        self.cookie = ""
        self._job = None
        self._stdout: list[str] = []
        self._stderr: list[str] = []
        self._lock = threading.Lock()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _reader(self, stream, sink: list[str]) -> None:
        for line in stream:
            with self._lock:
                sink.append(line.rstrip())
                if len(sink) > STDERR_LINES:
                    del sink[: len(sink) - STDERR_LINES]

    def _tail(self) -> str:
        with self._lock:
            return "\n".join(self._stderr[-20:])

    def start(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        self.workspace.mkdir(parents=True, exist_ok=True)
        patch_path = self.home / "mms.patch.yml"
        patch_path.write_text(self.patch_text, encoding="utf-8")
        env = os.environ.copy()
        env["DSH_HOME"] = str(self.home)
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        if self.api_key:
            env["MMS_PROVIDER_KEY"] = self.api_key
        dsh = find_dsh()
        cmd = [
            str(dsh),
            "--profile",
            "web",
            "--patch",
            str(patch_path),
            "--no-open",
            "--port",
            "0",
        ]
        creationflags = 0
        if os.name == "nt":
            creationflags = 0x08000000  # CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            cmd,
            cwd=str(self.workspace),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        self._job = _assign_kill_on_close(self.proc)
        threading.Thread(target=self._reader, args=(self.proc.stdout, self._stdout), daemon=True).start()
        threading.Thread(target=self._reader, args=(self.proc.stderr, self._stderr), daemon=True).start()
        deadline = time.monotonic() + READY_TIMEOUT
        url = ""
        while time.monotonic() < deadline:
            with self._lock:
                for line in self._stdout:
                    match = URL_RE.search(line)
                    if match:
                        url = match.group(1)
                        self.port = int(match.group(2))
                        token = match.group(3)
                        break
            if url:
                break
            if not self.alive():
                raise DshError(f"dsh 启动失败：{self._tail()}")
            time.sleep(0.1)
        if not url:
            self.stop()
            raise DshError(f"dsh 在 {READY_TIMEOUT:.0f}s 内没有打印 Web 地址：{self._tail()}")
        try:
            self.cookie = _auth_cookie(self.port, token)
        except Exception:
            self.stop()
            raise

    def rpc(self, endpoint: str, args: dict) -> dict:
        body = {
            "type": "client-request",
            "rpcId": uuid.uuid4().hex,
            "method": endpoint,
            "payload": {"args": args},
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            conn.request(
                "POST",
                f"/api/{endpoint}",
                body=data,
                headers={
                    "Content-Type": "application/json",
                    "Origin": _origin(self.port),
                    "Cookie": self.cookie,
                },
            )
            resp = conn.getresponse()
            raw = resp.read()
        finally:
            conn.close()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DshError(f"{endpoint} 返回不是 JSON（HTTP {resp.status}）") from exc
        result = payload.get("result") or {}
        if result.get("ok") is not True:
            error = result.get("error") or {}
            message = str(error.get("message") or error) if isinstance(error, dict) else str(error)
            raise DshError(f"{endpoint} 失败：{message}")
        value = result.get("value")
        return value if isinstance(value, dict) else {"value": value}

    def create_session(self, session_id: str, cwd: str, preset: str = "mms") -> None:
        self.rpc(
            "session/create",
            {"request": {"cwd": cwd, "sessionId": session_id, "agentPreset": preset}},
        )

    def prompt(self, session_id: str, text: str) -> None:
        self.rpc(
            "session/prompt",
            {
                "request": {
                    "requestId": uuid.uuid4().hex,
                    "sessionId": session_id,
                    "mode": "queue",
                    "content": [{"type": "text", "text": text}],
                    "clientTimeZone": "Asia/Shanghai",
                }
            },
        )

    def cancel(self, session_id: str) -> None:
        self.rpc("session/cancel", {"request": {"sessionId": session_id}})

    def follow(self, session_id: str) -> WsClient:
        ws = WsClient.connect(self.port, "/api/remote.mux", self.cookie, _origin(self.port))
        ws.send_text(
            json.dumps(
                {
                    "type": "open",
                    "streamId": uuid.uuid4().hex,
                    "endpoint": "session/follow",
                    "payload": {
                        "args": {
                            "request": {
                                "address": {"kind": "session", "sessionId": session_id},
                                "assistantStream": True,
                            }
                        }
                    },
                },
                ensure_ascii=False,
            )
        )
        return ws

    def stop(self) -> None:
        proc = self.proc
        self.proc = None
        if proc is not None and proc.poll() is None:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    creationflags=0x08000000,
                )
            else:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if self._job is not None:
            try:
                import ctypes

                ctypes.windll.kernel32.CloseHandle(self._job)
            except Exception:
                pass
            self._job = None


def _assign_kill_on_close(proc: subprocess.Popen):
    """Windows Job Object：本进程退出时一并杀掉 dsh，避免强杀后残留。"""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_uint64)
                for name in (
                    "ReadOperationCount",
                    "WriteOperationCount",
                    "OtherOperationCount",
                    "ReadTransferCount",
                    "WriteTransferCount",
                    "OtherTransferCount",
                )
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimits),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = ExtendedLimits()
        info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        kernel32.SetInformationJobObject(
            job, 9, ctypes.byref(info), ctypes.sizeof(info)
        )
        kernel32.AssignProcessToJobObject(job, wintypes.HANDLE(int(proc._handle)))
        return job
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return None


_LOCK = threading.Lock()
_RUNTIME: DshRuntime | None = None
_RUNTIME_KEY = ""


def get_runtime(patch_text: str, home: Path, workspace: Path, api_key: str) -> DshRuntime:
    global _RUNTIME, _RUNTIME_KEY
    key = "\0".join(
        [
            hashlib.sha256(patch_text.encode("utf-8")).hexdigest(),
            str(Path(home).resolve()),
            str(Path(workspace).resolve()),
            hashlib.sha256((api_key or "").encode("utf-8")).hexdigest(),
        ]
    )
    with _LOCK:
        if _RUNTIME is not None and _RUNTIME_KEY == key and _RUNTIME.alive():
            return _RUNTIME
        if _RUNTIME is not None:
            _RUNTIME.stop()
            _RUNTIME = None
            _RUNTIME_KEY = ""
        runtime = DshRuntime(patch_text, home, workspace, api_key)
        runtime.start()
        _RUNTIME = runtime
        _RUNTIME_KEY = key
        return runtime


def shutdown_dsh_runtime() -> None:
    global _RUNTIME, _RUNTIME_KEY
    with _LOCK:
        if _RUNTIME is not None:
            _RUNTIME.stop()
            _RUNTIME = None
            _RUNTIME_KEY = ""


atexit.register(shutdown_dsh_runtime)


def _session_id(chat_id: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_-]", "-", chat_id or "")
    return value[:64] or f"chat-{secrets.token_hex(4)}"


def _prompt_text(messages: list[dict]) -> str:
    convo = [m for m in messages if m.get("role") != "system"]
    if not convo:
        return ""
    if len(convo) == 1 and convo[0].get("role") == "user":
        return str(convo[0].get("content") or "")
    lines = ["以下是本会话已经发生的内容，按时间顺序。", ""]
    for message in convo:
        label = "用户" if message.get("role") == "user" else "助手"
        lines.append(f"{label}：{message.get('content') or ''}")
        lines.append("")
    lines.append("请只回答最后一条用户消息，不要复述历史。")
    return "\n".join(lines)


def build_patch(
    provider: dict,
    model: str,
    workspace: Path,
    context_tokens: int | None = None,
    depth: str = "",
    send_thinking: bool = True,
) -> str:
    base_url = dsh_provider.base_url(provider)
    context_window = dsh_provider.context_window(provider, context_tokens)
    max_tokens = dsh_provider.max_tokens(provider, context_window)
    thinking = ""
    thinking_format = dsh_provider.thinking_format(provider)
    if thinking_format:
        thinking = f"        compat:\n          thinkingFormat: {thinking_format}\n"
    efforts = dsh_provider.effort_table(provider, model)
    if efforts:
        effort_block = "            reasoningEfforts:\n              off:\n"
        for level, wire in efforts.items():
            effort_block += f"              {level}: {json.dumps(wire)}\n"
    else:
        effort_block = "            reasoningEfforts: false\n"
    effort = dsh_provider.default_effort(provider, model, depth, send_thinking)
    effort_line = f"    reasoningEffort: {json.dumps(effort)}\n" if effort else ""
    skills = repo_root() / "skills"
    persona = "你是 MathModel Studio 的数学建模助手。工具返回的数据以工具结果为准，不要编造没有运行过的结果；回答简洁，关键判断留给使用者确认。"
    skill_block = ""
    if skills.is_dir():
        skill_block = (
            "          - id: skill-filesystem\n"
            "            name: '@deepseek-ai/dsh-skill-filesystem'\n"
            "            config:\n"
            "              includeDefaultRoots: false\n"
            "              customSkillDirs:\n"
            f"                - {json.dumps(str(skills), ensure_ascii=False)}\n"
            "          - id: tool-skill\n"
            "            name: '@deepseek-ai/dsh-tool-skill'\n"
        )
    python_bin = os.environ.get("MMS_PYTHON") or sys.executable
    mcp_script = repo_root() / "runtime" / "mcp" / "mms_server.py"
    mcp_block = ""
    if mcp_script.is_file():
        mcp_block = (
            "          - id: mcp-mms\n"
            "            name: '@deepseek-ai/dsh-mcp-client'\n"
            "            config:\n"
            "              transport: stdio\n"
            "              serverName: mms\n"
            f"              command: {json.dumps(str(python_bin), ensure_ascii=False)}\n"
            "              args:\n"
            f"                - {json.dumps(str(mcp_script), ensure_ascii=False)}\n"
            f"              cwd: {json.dumps(str(repo_root()), ensure_ascii=False)}\n"
            "              failOnStartupError: true\n"
        )
    return (
        "- insert:\n"
        "    - id: preset-mms\n"
        "      name: '@deepseek-ai/dsh-agent-preset'\n"
        "      config:\n"
        "        id: mms\n"
        "        order: 0\n"
        "        plugins:\n"
        "          - id: persona\n"
        "            name: '@deepseek-ai/dsh-persona'\n"
        "            config:\n"
        f"              prefix: {json.dumps(persona, ensure_ascii=False)}\n"
        "          - id: tool-fs\n"
        "            name: '@deepseek-ai/dsh-tool-fs'\n"
        "            config:\n"
        "              read: true\n"
        "              readImage: true\n"
        "              write: false\n"
        "              edit: false\n"
        "          - id: tool-fs-search\n"
        "            name: '@deepseek-ai/dsh-tool-fs-search'\n"
        "            config:\n"
        "              sampleOverCapGlobResults: false\n"
        f"{skill_block}"
        f"{mcp_block}"
        "          - id: compaction\n"
        "            name: cordis:group\n"
        "            group: true\n"
        "            isolate:\n"
        "              compaction: true\n"
        "            config:\n"
        "              - id: compaction-basic\n"
        "                name: '@deepseek-ai/dsh-compaction-basic'\n"
        "- id: agent-preset-registry\n"
        "  config:\n"
        "    default: mms\n"
        "- id: session-title-llm\n"
        "  disabled: true\n"
        "- id: llm-pi-ai\n"
        "  config:\n"
        "    providers:\n"
        "      mms:\n"
        "        apiKeyEnv: MMS_PROVIDER_KEY\n"
        "        api: openai-completions\n"
        f"        baseURL: {json.dumps(base_url, ensure_ascii=False)}\n"
        f"{thinking}"
        "        models:\n"
        f"          - id: {json.dumps(model, ensure_ascii=False)}\n"
        f"            contextWindow: {context_window}\n"
        f"            maxTokens: {max_tokens}\n"
        f"{effort_block}"
        "- id: agent-default-model\n"
        "  config:\n"
        "    provider: mms\n"
        f"    model: {json.dumps(model, ensure_ascii=False)}\n"
        f"{effort_line}"
        "- id: sandbox-policy\n"
        "  config:\n"
        "    mode: read-only\n"
        f"    workspaceRoot: {json.dumps(str(workspace), ensure_ascii=False)}\n"
    )


class DshChatSession(ChatSession):
    """把 DSH 的 follow 流映射成现有 9 类聊天事件。"""

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
        super().__init__(
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
        self.session_id = _session_id(chat_id)
        self.send_thinking = send_thinking
        self.raw_depth = depth
        self._runtime: DshRuntime | None = None
        self._follow: WsClient | None = None
        self._cancel_sent = False
        self._turn_end: dict | None = None
        self._usage: dict | None = None
        self._tool_started: dict[str, float] = {}
        self._tool_names: dict[str, str] = {}

    def cancel(self) -> None:
        with self.cond:
            if self.done:
                return
            self.cancelled = True
            self.cond.notify_all()
        self._send_cancel()

    def _send_cancel(self) -> None:
        if self._cancel_sent or self._runtime is None:
            return
        self._cancel_sent = True
        try:
            self._runtime.cancel(self.session_id)
        except Exception as exc:  # 允许下一次重试，别卡在一次性标志位。# noqa: BLE001
            self._cancel_sent = False
            print(f"[mms] dsh cancel failed: {exc}", file=sys.stderr)

    def _run(self) -> None:
        try:
            if self.cancelled:
                self.finish("cancelled")
                return
            home = Path(
                os.environ.get("MMS_DSH_HOME")
                or (data_dir(Path(os.environ.get("MMS_HOME") or ".")) / "dsh")
            )
            workspace = (
                Path(self.workspace).expanduser().resolve()
                if self.workspace.strip()
                else home
            )
            patch = build_patch(
                self.provider,
                self.model,
                workspace,
                self.context_tokens,
                depth=self.raw_depth,
                send_thinking=self.send_thinking,
            )
            self._runtime = get_runtime(patch, home, workspace, self.api_key)
            if self.cancelled:
                self.finish("cancelled")
                return
            self._runtime.create_session(self.session_id, str(workspace))
            self._follow = self._runtime.follow(self.session_id)
            if self.cancelled:
                self._send_cancel()
                self.finish("cancelled")
                return
            self._runtime.prompt(self.session_id, _prompt_text(self.messages))
            turn = self._consume()
            self._finish_from_turn(turn)
        except DshError as exc:
            self.append("error", {"message": str(exc)})
            self.finish("error")
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self.append("error", {"message": "DSH 适配层内部错误，详情见 stderr"})
            self.finish("error")
        finally:
            if self._follow is not None:
                self._follow.close()
                self._follow = None

    def _consume(self) -> dict:
        assert self._follow is not None
        deadline = time.monotonic() + TURN_TIMEOUT
        grace_deadline = 0.0
        while True:
            now = time.monotonic()
            if self.cancelled:
                self._send_cancel()
            if self._turn_end is not None and now >= grace_deadline:
                return self._turn_end
            if now >= deadline:
                raise DshError("等待 DSH 回合结束超时")
            text = self._follow.recv(0.2 if self._turn_end is not None else 1.0)
            if text is None:
                if self._follow.closed:
                    raise DshError("DSH 事件流提前关闭")
                continue
            try:
                frame = json.loads(text)
            except json.JSONDecodeError:
                continue
            if self._handle_frame(frame):
                grace_deadline = time.monotonic() + TURN_GRACE

    def _finish_from_turn(self, turn: dict | None) -> None:
        reason = turn.get("reason") if isinstance(turn, dict) else None
        kind = reason.get("kind") if isinstance(reason, dict) else ""
        if self.cancelled or kind == "aborted":
            self.finish("cancelled")
            return
        if kind in ("error", "blocked"):
            error = reason.get("error") if isinstance(reason, dict) else None
            message = error.get("message") if isinstance(error, dict) else str(error or "")
            self.append("error", {"message": message or "DSH 回合失败"})
            self.finish("error")
            return
        if not kind:
            raise DshError("DSH 没有给出 turn/end")
        self.finish("stop", self._usage)

    def _handle_frame(self, frame: dict) -> bool:
        value = frame.get("value")
        if not isinstance(value, dict):
            return False
        if value.get("type") == "assistant-stream":
            self._handle_stream(value.get("frame"))
            return False
        event = value.get("event")
        if not isinstance(event, dict):
            return False
        etype = event.get("type")
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        if etype == "tool/call":
            self._handle_tool_call(data)
        elif etype == "tool/result":
            self._handle_tool_result(data)
        elif etype == "turn/end":
            self._turn_end = data
            return True
        elif etype == "compaction/end":
            self._handle_compaction(data)
        return False

    def _handle_stream(self, frame) -> None:
        if not isinstance(frame, dict) or frame.get("type") != "chunk":
            return
        chunk = frame.get("chunk")
        if not isinstance(chunk, dict):
            return
        kind = chunk.get("type")
        if kind == "reasoning-delta":
            text = chunk.get("text")
            if isinstance(text, str) and text:
                self.append("reasoning", {"text": text})
        elif kind == "text-delta":
            text = chunk.get("text")
            if isinstance(text, str) and text:
                self.append("token", {"text": text})
        elif kind == "usage":
            usage = chunk.get("usage")
            if isinstance(usage, dict):
                self._usage = {
                    "prompt_tokens": int(usage.get("inputTokens") or 0),
                    "completion_tokens": int(usage.get("outputTokens") or 0),
                    "total_tokens": int(usage.get("totalTokens") or 0),
                }

    def _handle_tool_call(self, data: dict) -> None:
        call_id = str(data.get("callId") or f"call_{secrets.token_hex(4)}")
        name = str(data.get("name") or "tool")
        raw_args = data.get("arguments")
        args = raw_args
        if isinstance(raw_args, str) and raw_args.strip():
            try:
                args = json.loads(raw_args)
            except json.JSONDecodeError:
                args = raw_args
        elif raw_args in (None, ""):
            args = {}
        self._tool_started[call_id] = time.monotonic()
        self._tool_names[call_id] = name
        self.append(
            "tool_call",
            {"id": call_id, "name": name, "status": "running", "args": args},
        )

    def _handle_tool_result(self, data: dict) -> None:
        message = data.get("message") if isinstance(data.get("message"), dict) else {}
        call_id = str(
            message.get("toolCallId")
            or message.get("tool_call_id")
            or data.get("callId")
            or f"call_{secrets.token_hex(4)}"
        )
        name = str(message.get("name") or self._tool_names.get(call_id) or "tool")
        is_error = bool(message.get("isError"))
        content = message.get("content")
        text = ""
        if isinstance(content, list):
            parts = [
                str(item.get("text") or "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            ]
            text = "\n".join(parts)
        elif content is not None:
            text = str(content)
        try:
            parsed = json.loads(text) if text.strip().startswith(("{", "[")) else None
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            result = parsed
            blob = json.dumps(result, ensure_ascii=False)
            if len(blob) > MAX_TOOL_RESULT_CHARS:
                result = {"ok": bool(result.get("ok", not is_error)), "truncated": True, "text": blob[:MAX_TOOL_RESULT_CHARS]}
        else:
            result = {"ok": not is_error, "text": text[:MAX_TOOL_RESULT_CHARS]}
        started = self._tool_started.pop(call_id, None)
        duration = int((time.monotonic() - started) * 1000) if started else 0
        payload = {
            "id": call_id,
            "name": name,
            "status": "error" if is_error else "ok",
            "result": result,
            "duration_ms": max(0, duration),
        }
        if is_error:
            payload["error"] = text[:800] or "工具执行失败"
        self.append("tool_call", payload)
        self._tool_names.pop(call_id, None)

    def _handle_compaction(self, data: dict) -> None:
        try:
            before = int(data.get("before") or 0)
            after = int(data.get("after") or 0)
        except (TypeError, ValueError):
            before = after = 0
        self.append(
            "compaction",
            {
                "reason": str(data.get("reason") or "auto"),
                "before": before,
                "after": after,
                "pruned": int(data.get("pruned") or 0),
                "summarized": int(data.get("summarized") or 0),
                "dropped": int(data.get("dropped") or 0),
            },
        )
