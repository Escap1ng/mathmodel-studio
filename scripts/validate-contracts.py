#!/usr/bin/env python3
"""G2 · 契约校验 + 跨语言版本一致性。

判据分层：jsonschema 在场时按 Draft 2020-12 完整校验；缺席时降级为 registry.minimal_validate，
并在输出里说明降级（与上游技能集同一口径）。

反向覆盖内建：C3 会主动构造两份必错的注册表，确认校验器真的会拒——
只跑「绿的」不构成证据。

退出码：0 通过 / 1 校验失败 / 2 用法或环境错误。
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "runtime" / "src"))

# Windows 控制台默认 GBK，print 中文技能名会抛 UnicodeEncodeError；不靠调用方设环境变量。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

from mms.registry import minimal_validate  # noqa: E402

EXIT_OK, EXIT_FAILED, EXIT_ENV = 0, 1, 2
rows: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str) -> None:
    rows.append((name, ok, detail))


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


manifest_path = ROOT / "skills" / "manifest.json"
schema_path = ROOT / "schemas" / "skill-manifest.schema.json"

if not manifest_path.is_file() or not schema_path.is_file():
    print(f"环境错误: 缺注册表或契约文件（{manifest_path} / {schema_path}）", file=sys.stderr)
    sys.exit(EXIT_ENV)

try:
    manifest = load_json(manifest_path)
    schema = load_json(schema_path)
except json.JSONDecodeError as exc:
    print(f"校验失败: JSON 解析错误 — {exc}", file=sys.stderr)
    sys.exit(EXIT_FAILED)

# C1 契约自身要是合法的 Draft 2020-12 schema
has_jsonschema = True
try:
    import jsonschema  # type: ignore
except ImportError:
    has_jsonschema = False

if has_jsonschema:
    # check_schema 不返回错误列表：合法就静默通过，非法抛 SchemaError
    try:
        jsonschema.Draft202012Validator.check_schema(schema)
        meta_errors: list[str] = []
    except jsonschema.SchemaError as exc:
        meta_errors = [exc.message]
    record("C1 契约文件本身合法", not meta_errors, "通过 Draft 2020-12 元校验" if not meta_errors else "; ".join(meta_errors))
else:
    record("C1 契约文件本身合法", schema.get("$schema", "").endswith("2020-12/schema"), "jsonschema 缺席，仅核对 $schema 声明（降级）")


def full_errors(data: dict) -> list[str]:
    if not has_jsonschema:
        return minimal_validate(data)
    v = jsonschema.Draft202012Validator(schema)
    return [f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}" for e in v.iter_errors(data)]


# C2 注册表对契约
problems = full_errors(manifest)
mode = "jsonschema" if has_jsonschema else "minimal"
record(f"C2 注册表通过契约（{mode}）", not problems, f"{len(problems)} 项问题" + (f": {'; '.join(problems[:4])}" if problems else ""))

# C3 反向覆盖：这两份必须被拒
must_fail = {
    "kind 取非法值": {**manifest, "skills": [{**manifest["skills"][0], "kind": "wizard"}, *manifest["skills"][1:]]},
    "contribution 取非法值": {
        **manifest,
        "skills": [{**manifest["skills"][0], "contribution": "anyone"}, *manifest["skills"][1:]],
    },
    "status 取非法值": {**manifest, "skills": [{**manifest["skills"][0], "status": "done"}, *manifest["skills"][1:]]},
    "ui.phases 为空数组": {
        **manifest,
        "skills": [{**manifest["skills"][0], "ui": {**manifest["skills"][0]["ui"], "phases": []}}, *manifest["skills"][1:]],
    },
    "阶段号越界": {
        **manifest,
        "skills": [{**manifest["skills"][0], "ui": {**manifest["skills"][0]["ui"], "phases": [9]}}, *manifest["skills"][1:]],
    },
}
for label, bad in must_fail.items():
    rejected = bool(full_errors(bad))
    record(f"C3 构造错误被拒（{label}）", rejected, "已拒绝" if rejected else "假绿：校验器放过了非法注册表")

# C4 版本四处同源
versions: dict[str, str | None] = {}
versions["VERSION"] = (ROOT / "VERSION").read_text(encoding="utf-8").strip() if (ROOT / "VERSION").is_file() else None
try:
    versions["package.json"] = load_json(ROOT / "package.json").get("version")
except FileNotFoundError:
    versions["package.json"] = None
try:
    versions["pyproject.toml"] = tomllib.loads((ROOT / "runtime" / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
except (FileNotFoundError, KeyError):
    versions["pyproject.toml"] = None
init_src = (ROOT / "runtime" / "src" / "mms" / "__init__.py").read_text(encoding="utf-8") if (ROOT / "runtime" / "src" / "mms" / "__init__.py").is_file() else ""
m = re.search(r'__version__\s*=\s*"([^"]+)"', init_src)
versions["mms/__init__.py"] = m.group(1) if m else None
distinct = set(filter(None, versions.values()))
record(
    "C4 版本四处同源",
    len(distinct) == 1 and None not in versions.values(),
    f"实得 {versions}" if len(distinct) != 1 else f"全部为 {distinct.pop()}",
)

# C5 schemas/ 下所有 JSON 都能解析
broken = []
for p in sorted((ROOT / "schemas").glob("*.json")):
    try:
        load_json(p)
    except json.JSONDecodeError as exc:
        broken.append(f"{p.name}: {exc}")
record("C5 schemas/ 全部可解析", not broken, "; ".join(broken) if broken else f"{len(list((ROOT / 'schemas').glob('*.json')))} 份契约文件")

for name, ok, detail in rows:
    print(f"{'PASS' if ok else 'FAIL'} {name}")
    print(f"       {detail}")

failed = [n for n, ok, _ in rows if not ok]
print(f"\n{len(rows) - len(failed)}/{len(rows)} 项通过（判据来源 {mode}）")
sys.exit(EXIT_FAILED if failed else EXIT_OK)
