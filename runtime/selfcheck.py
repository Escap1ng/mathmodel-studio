#!/usr/bin/env python3
"""G3 · CLI 契约自检：把 mms 的 0/1/2 三个退出码各自跑到可达。

一个只会返回 0 的检查器没有价值，所以这里既跑「正常应当 0」，
也跑「坏了必须 1」和「环境缺失必须 2」，并与注册表实数对照。

本脚本只依赖标准库；jsonschema 在场时走完整契约校验，缺席时走降级校验，
两种路径都必须退出 0（真实判据打印在输出里）。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG_SRC = ROOT / "runtime" / "src"
MANIFEST_PATH = ROOT / "skills" / "manifest.json"
SCHEMA_PATH = ROOT / "schemas" / "skill-manifest.schema.json"

# 同 validate_contracts.py：不假设调用方给了 UTF-8 控制台
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

rows: list[tuple[str, bool, str]] = []


def run(args: list[str], env_extra: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(PKG_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    env.pop("MMS_HOME", None)
    if env_extra:
        env.update(env_extra)
    # cwd 故意设成临时目录，验证「从安装位置向上找仓库根」这条路径而不是依赖 cwd
    with tempfile.TemporaryDirectory() as td:
        return subprocess.run(
            [sys.executable, "-m", "mms.cli", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=td,
            env=env,
        )


def record(name: str, ok: bool, detail: str) -> None:
    rows.append((name, ok, detail))


def fixture_home(mutate) -> str:
    """复制一份真实注册表到临时仓库根，按 mutate 改坏，返回该根目录。"""
    home = tempfile.mkdtemp(prefix="mms-selfcheck-")
    (Path(home) / "skills").mkdir(parents=True, exist_ok=True)
    (Path(home) / "schemas").mkdir(parents=True, exist_ok=True)
    shutil.copy(MANIFEST_PATH, Path(home) / "skills" / "manifest.json")
    shutil.copy(SCHEMA_PATH, Path(home) / "schemas" / "skill-manifest.schema.json")
    mutate(Path(home))
    return home


declared = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
skill_count = len(declared["skills"])

# S1 版本
r = run(["--version"])
record("S1 --version 退出 0", r.returncode == 0 and r.stdout.startswith("mms "), f"exit {r.returncode} · {r.stdout.strip()!r}")

# S2 人读列举
r = run(["skills"])
listed = [ln for ln in r.stdout.splitlines() if ln.strip()]
record(
    "S2 skills 列举数与注册表一致",
    r.returncode == 0 and len(listed) - 1 == skill_count,
    f"exit {r.returncode} · 列出 {len(listed) - 1} 行 / 注册表 {skill_count} 个",
)

# S3 机器可读
r = run(["skills", "--json"])
try:
    parsed = json.loads(r.stdout)
    ok3 = r.returncode == 0 and len(parsed["skills"]) == skill_count
    detail3 = f"exit {r.returncode} · JSON skills {len(parsed['skills'])} 个"
except json.JSONDecodeError as exc:
    ok3, detail3 = False, f"exit {r.returncode} · JSON 解析失败 {exc}"
record("S3 skills --json 可被程序读取", ok3, detail3)

# S4 真注册表应当通过
r = run(["skills", "--check"])
how = "jsonschema" if "jsonschema" in r.stdout else ("minimal" if "minimal" in r.stdout else "?")
record("S4 skills --check 对真注册表退出 0", r.returncode == 0, f"exit {r.returncode} · 判据来源 {how} · {r.stdout.strip()}")

# S5 契约外取值必须 1
def break_enum(home: Path) -> None:
    data = json.loads((home / "skills" / "manifest.json").read_text(encoding="utf-8"))
    data["skills"][0]["ui"]["artifacts"] = ["hologram"]
    (home / "skills" / "manifest.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


home5 = fixture_home(break_enum)
try:
    r = run(["skills", "--check"], {"MMS_HOME": home5})
    record("S5 词表外取值退出 1", r.returncode == 1, f"exit {r.returncode} · {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else r.stdout.strip()}")
finally:
    shutil.rmtree(home5, ignore_errors=True)

# S6 非 JSON 必须 1（而不是崩在读取阶段）
def break_json(home: Path) -> None:
    (home / "skills" / "manifest.json").write_text('{"skills": [', encoding="utf-8")


home6 = fixture_home(break_json)
try:
    r = run(["skills", "--check"], {"MMS_HOME": home6})
    record("S6 非法 JSON 退出 1 且不抛栈", r.returncode == 1 and "Traceback" not in r.stderr, f"exit {r.returncode}")
finally:
    shutil.rmtree(home6, ignore_errors=True)

# S7 MMS_HOME 指向空目录必须 2
empty = tempfile.mkdtemp(prefix="mms-selfcheck-empty-")
try:
    r = run(["skills"], {"MMS_HOME": empty})
    record("S7 MMS_HOME 无注册表退出 2", r.returncode == 2, f"exit {r.returncode}")
finally:
    shutil.rmtree(empty, ignore_errors=True)

# S8 未知子命令必须 2
r = run(["nope"])
record("S8 未知子命令退出 2", r.returncode == 2, f"exit {r.returncode}")

for name, ok, detail in rows:
    print(f"{'PASS' if ok else 'FAIL'} {name}")
    print(f"       {detail}")

failed = [n for n, ok, _ in rows if not ok]
print(f"\n{len(rows) - len(failed)}/{len(rows)} 条 CLI 契约断言通过（0/1/2 三码各自可达）")
sys.exit(1 if failed else 0)
