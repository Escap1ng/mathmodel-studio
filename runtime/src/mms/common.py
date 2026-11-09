"""运行时公共小工具：UTF-8 控制台兜底与 JSON 读写。

只放与业务无关的东西，避免各模块各写一份同名 helper。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def utf8_console() -> None:
    """Windows 控制台默认 GBK，打印中文会抛 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def dump_json(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback
