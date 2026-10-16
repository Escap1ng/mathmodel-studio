"""技能注册表与仓库根定位。

单一事实源是 skills/manifest.json。运行时的安装形态（pip install -e、便携包、
打包后的只读资源目录）会让「向上找 VERSION」不可靠，所以显式支持 MMS_HOME 覆盖。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

MANIFEST_RELPATH = Path("skills") / "manifest.json"

EXIT_OK = 0
EXIT_VALIDATION_FAILED = 1
EXIT_USAGE_OR_ENV = 2


def repo_root() -> Path:
    override = os.environ.get("MMS_HOME")
    if override:
        root = Path(override).expanduser()
        if not (root / MANIFEST_RELPATH).is_file():
            raise EnvError(f"MMS_HOME 指向的目录下没有 {MANIFEST_RELPATH.as_posix()}: {root}")
        return root
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if (candidate / MANIFEST_RELPATH).is_file():
            return candidate
    raise EnvError(f"从 {here} 向上没找到含 {MANIFEST_RELPATH.as_posix()} 的仓库根")


class EnvError(RuntimeError):
    """环境或用法错误：对应退出码 2，与校验失败（1）严格区分。"""


def load_manifest(root: Path | None = None) -> dict:
    path = (root or repo_root()) / MANIFEST_RELPATH
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def repo_version(root: Path | None = None) -> str:
    path = (root or repo_root()) / "VERSION"
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise EnvError(f"VERSION 文件不存在: {path}") from exc


def skills(manifest: dict) -> list[dict]:
    return list(manifest.get("skills") or [])


def for_phase(manifest: dict, phase: int) -> list[dict]:
    return [s for s in skills(manifest) if phase in (s.get("ui") or {}).get("phases", [])]


def for_hitl(manifest: dict, card: str) -> list[dict]:
    return [s for s in skills(manifest) if card in (s.get("ui") or {}).get("hitl", [])]


def minimal_validate(manifest: dict) -> list[str]:
    """无 jsonschema 时的最小结构校验；返回问题列表，空列表即通过。

    与 kit 的降级口径一致：缺库不装死，但会说明只跑了最小校验。
    """
    problems: list[str] = []
    required_top = (
        "manifest_version",
        "schema_version",
        "title",
        "description",
        "kinds",
        "status",
        "contribution",
        "cli_contract",
        "phases",
        "skills",
    )
    for key in required_top:
        if key not in manifest:
            problems.append(f"缺顶层字段: {key}")
    entries = manifest.get("skills")
    if not isinstance(entries, list) or not entries:
        problems.append("skills 必须是非空数组")
        return problems
    allowed_phases = set(manifest.get("phases") or [])
    allowed_artifacts = set((manifest.get("artifact_kinds") or {}).keys())
    allowed_hitl = set((manifest.get("hitl_card_kinds") or {}).keys())
    seen: set[str] = set()
    for s in entries:
        name = s.get("name", "")
        if not name:
            problems.append("有技能缺 name")
            continue
        if name in seen:
            problems.append(f"技能名重复: {name}")
        seen.add(name)
        for key in ("kind", "role", "entry", "contribution", "status", "ui"):
            if key not in s:
                problems.append(f"{name}: 缺 {key}")
        # 枚举必须在降级路径上同样把住：C3 反向覆盖实测出这里曾经放过非法 kind
        if s.get("kind") not in ("core", "knowledge", "tool"):
            problems.append(f"{name}: kind 非法 {s.get('kind')!r}")
        if s.get("contribution") not in ("open", "maintainer"):
            problems.append(f"{name}: contribution 非法 {s.get('contribution')!r}")
        if s.get("status") not in ("planned", "vendored"):
            problems.append(f"{name}: status 非法 {s.get('status')!r}")
        if not s.get("entry"):
            problems.append(f"{name}: 缺 entry")
        ui = s.get("ui") or {}
        phases = ui.get("phases") or []
        if not phases:
            problems.append(f"{name}: ui.phases 为空")
        bad = [p for p in phases if p not in allowed_phases]
        if bad:
            problems.append(f"{name}: 阶段越界 {bad}")
        bad_art = [a for a in (ui.get("artifacts") or []) if a not in allowed_artifacts]
        if bad_art:
            problems.append(f"{name}: 产物类型不在词表 {bad_art}")
        bad_hitl = [h for h in (ui.get("hitl") or []) if h not in allowed_hitl]
        if bad_hitl:
            problems.append(f"{name}: 卡点不在词表 {bad_hitl}")
    return problems
