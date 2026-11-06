"""最小 MCP stdio server：给 DSH 暴露一个域工具 `list_templates`。

行为见 docs/spike/dsh-probe.md：DSH 的 mcp-client 会按行发 JSON-RPC，
这里只实现 initialize / ping / tools/list / tools/call 四个方法。
工具执行沿用现有技能 subprocess 契约：
`<MMS_PYTHON> <MMS_ROOT>/runtime/cli.py templates --json`，30 秒超时。

安全边界：MMS_PYTHON 取环境变量（由 channel.ts 注入），否则是当前解释器；
MMS_ROOT 缺省按 `runtime/mcp/mms_server.py` 的位置上溯两层。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PROTOCOL_VERSION = "2024-11-05"
TOOL_TIMEOUT = 30
TOOLS = [
    {
        "name": "list_templates",
        "description": "列出本机技能内置的图表与示意图模板（只读注册表，不渲染）。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "suggest_models",
        "description": (
            "用户讨论该用什么模型/方法时调用：向界面推送三张可选模型卡，由用户自己点选。"
            "用户要求换一批时，把 batch 加 1 再调用；不要替用户做选择，也不要编造用户已选。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "要建模的子问题或用户原话；必填。",
                },
                "batch": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9,
                    "description": "第几批候选，默认 1；换一批时递增。",
                },
            },
            "required": ["question"],
            "additionalProperties": False,
        },
    },
]


def _force_utf8() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def _root() -> Path:
    override = os.environ.get("MMS_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def _python() -> str:
    return os.environ.get("MMS_PYTHON") or sys.executable


def list_templates() -> dict:
    cli = _root() / "runtime" / "cli.py"
    if not cli.is_file():
        return {"ok": False, "error": f"找不到 runtime/cli.py：{cli}"}
    try:
        proc = subprocess.run(
            [_python(), str(cli), "templates", "--json"],
            cwd=str(_root()),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TOOL_TIMEOUT,
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"list_templates 超过 {TOOL_TIMEOUT}s"}
    except OSError as exc:
        return {"ok": False, "error": f"无法启动 cli.py：{exc}"}
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()[-5:]
        return {"ok": False, "error": f"cli.py 退出码 {proc.returncode}：{' | '.join(detail)}"}
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": "cli.py 输出不是 JSON"}
    templates = result.get("templates") if isinstance(result, dict) else None
    if isinstance(templates, list):
        by_skill: dict[str, int] = {}
        for row in templates:
            skill = str((row or {}).get("skill") or "")
            by_skill[skill] = by_skill.get(skill, 0) + 1
        result["by_skill"] = by_skill
    return result


def suggest_models(args: dict) -> dict:
    question = str(args.get("question") or "").strip()
    if not question:
        return {"ok": False, "error": "缺少建模问题文本"}
    try:
        batch = int(args.get("batch") or 1)
    except (TypeError, ValueError):
        batch = 1
    batch = min(max(batch, 1), 9)
    src = _root() / "runtime" / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
    try:
        from mms import orchestrator
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"无法加载方法库：{exc}"}
    candidates = orchestrator.model_candidates(question, batch)
    return {"ok": True, "batch": batch, "candidates": candidates}


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    _force_utf8()
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict):
            continue
        method = message.get("method")
        request_id = message.get("id")
        if request_id is None:
            # notification（例如 initialized），不回包，收到就算了。
            continue
        if method == "initialize":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "mms", "version": "0.2"},
                        "instructions": "MathModel Studio 的域工具；按需调用。",
                    },
                }
            )
            continue
        if method == "ping":
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
            continue
        if method == "tools/list":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
            continue
        if method == "tools/call":
            params = message.get("params") or {}
            name = str(params.get("name") or "")
            args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            if name == "list_templates":
                result = list_templates()
            elif name == "suggest_models":
                result = suggest_models(args)
            else:
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32602, "message": f"未知工具: {name}"},
                    }
                )
                continue
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]
                    },
                }
            )
            continue
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"未知方法: {method}"},
            }
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
