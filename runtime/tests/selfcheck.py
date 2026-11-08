#!/usr/bin/env python3
"""G3 · CLI 契约自检：把 mms 的 0/1/2 三个退出码各自跑到可达。

除注册表命令外，也真调一次上游图表模板（subprocess）并核验三件产物；
S13 是反向覆盖——渲染器假成功时必须判 1，而不是相信退出码。

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

ROOT = Path(__file__).resolve().parents[2]
PKG_SRC = ROOT / "runtime" / "src"
MANIFEST_PATH = ROOT / "skills" / "manifest.json"
SCHEMA_PATH = ROOT / "schemas" / "skill-manifest.schema.json"

# 同 validate-contracts.py：不假设调用方给了 UTF-8 控制台
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

rows: list[tuple[str, bool, str]] = []


def run(
    args: list[str], env_extra: dict[str, str] | None = None, timeout: float | None = None
) -> subprocess.CompletedProcess:
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
            timeout=timeout,
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

# S9 模板清单：20 张图 + 5 张示意图。上游增删模板时这条要跟着改（re-sync 记录里留痕）。
r = run(["templates", "--json"])
try:
    listing = json.loads(r.stdout)
    counts: dict[str, int] = {}
    for item in listing["templates"]:
        counts[item["skill"]] = counts.get(item["skill"], 0) + 1
    ok9 = (
        r.returncode == 0
        and listing["total"] == 25
        and counts.get("mathmodel-figure") == 20
        and counts.get("mathmodel-diagram") == 5
    )
    detail9 = (
        f"exit {r.returncode} · {listing['total']} 个"
        f"（figure {counts.get('mathmodel-figure')} / diagram {counts.get('mathmodel-diagram')}）"
    )
except (json.JSONDecodeError, KeyError) as exc:
    ok9, detail9 = False, f"exit {r.returncode} · JSON 解析失败 {exc}"
record("S9 templates --json 列出 20 图 + 5 示意图", ok9, detail9)

# S10 真渲染一张：退出 0 且 PNG/PDF/SVG 三件产物都非空
render_out = tempfile.mkdtemp(prefix="mms-render-")
try:
    r = run(
        ["invoke", "figure", "paired-raincloud", "--out", render_out, "--json"],
        timeout=300,
    )
    try:
        rendered = json.loads(r.stdout)
        outs = rendered.get("outputs") or {}
        sizes = {k: Path(v).stat().st_size for k, v in outs.items() if Path(v).is_file()}
        ok10 = (
            r.returncode == 0
            and rendered.get("ok") is True
            and set(sizes) == {"png", "pdf", "svg"}
            and all(s > 0 for s in sizes.values())
        )
        detail10 = f"exit {r.returncode} · 产物 {sizes}"
    except (json.JSONDecodeError, OSError) as exc:
        ok10, detail10 = False, f"exit {r.returncode} · 结果解析失败 {exc} · {r.stderr.strip()[:200]}"
finally:
    shutil.rmtree(render_out, ignore_errors=True)
record("S10 invoke figure 真出 PNG/PDF/SVG", ok10, detail10)

# S11 未接通的技能必须 2（用法错误，不是渲染失败）
r = run(["invoke", "paper", "x"])
record("S11 invoke 未接通技能退出 2", r.returncode == 2, f"exit {r.returncode} · {r.stderr.strip()[:120]}")

# S12 不存在的模板由上游渲染器报用法错误 2，我们原样透传
bad_out = tempfile.mkdtemp(prefix="mms-render-bad-")
try:
    r = run(["invoke", "figure", "no-such-template", "--out", bad_out], timeout=120)
finally:
    shutil.rmtree(bad_out, ignore_errors=True)
record("S12 未知模板退出 2", r.returncode == 2, f"exit {r.returncode}")

# S13 反向覆盖：渲染器退出 0 但没写产物，必须判 1（不信退出码）
def fake_renderer(home: Path) -> None:
    tool = home / "skills" / "mathmodel-figure" / "code" / "tools"
    tool.mkdir(parents=True, exist_ok=True)
    (tool / "render_template.py").write_text("import sys\nsys.exit(0)\n", encoding="utf-8")


home13 = fixture_home(fake_renderer)
empty_out = tempfile.mkdtemp(prefix="mms-render-empty-")
try:
    r = run(
        ["invoke", "figure", "paired-raincloud", "--out", empty_out],
        {"MMS_HOME": home13},
    )
    ok13 = r.returncode == 1 and "缺少产物" in r.stderr
    detail13 = f"exit {r.returncode} · {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else ''}"
finally:
    shutil.rmtree(home13, ignore_errors=True)
    shutil.rmtree(empty_out, ignore_errors=True)
record("S13 渲染器假成功（退出 0 无产物）被判 1", ok13, detail13)

for name, ok, detail in rows:
    print(f"{'PASS' if ok else 'FAIL'} {name}")
    print(f"       {detail}")

failed = [n for n, ok, _ in rows if not ok]
print(f"\n{len(rows) - len(failed)}/{len(rows)} 条 CLI 契约断言通过（0/1/2 三码各自可达）")
sys.exit(1 if failed else 0)
