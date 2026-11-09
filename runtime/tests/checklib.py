"""自检公共脚手架：UTF-8 控制台、仓库根与包路径注入、断言收集与汇总。

六个 selfcheck 都以脚本方式运行（python runtime/tests/selfcheck_*.py），
脚本目录自然在 sys.path[0]，直接 ``from checklib import ...`` 即可。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# CI 的 Windows 控制台是 cp1252，不重配会在打印中文时崩。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

sys.path.insert(0, str(ROOT / "runtime" / "src"))

rows: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    rows.append((name, bool(ok), detail))


def report(title: str) -> int:
    """打印断言与「通过数/总数 条 <title>」，返回退出码（0 全绿 / 1 有失败）。"""
    failed = [row for row in rows if not row[1]]
    for name, ok, detail in rows:
        print(f"{'PASS' if ok else 'FAIL'} {name}\n       {detail}")
    print(f"\n{len(rows) - len(failed)}/{len(rows)} 条 {title}")
    return 1 if failed else 0
