"""`mms templates` 与 `mms invoke` 的实现。

契约边界：本模块**不 import 任何技能内部函数**，只把技能脚本当外部程序调用，
按退出码判定，并在成功退出后独立核验产物是否真的落盘。这样上游升级不会
把桌面端代码和技能实现绑死（见 skills/VENDOR.md 第 4 条）。
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .registry import (
    EXIT_OK,
    EXIT_USAGE_OR_ENV,
    EXIT_VALIDATION_FAILED,
    EnvError,
    repo_root,
)

FIGURE_SKILL = "mathmodel-figure"
FIGURE_DIR = Path("skills") / FIGURE_SKILL
FIGURE_RENDERER = FIGURE_DIR / "code" / "tools" / "render_template.py"
FIGURE_MANIFEST = FIGURE_DIR / "code" / "tools" / "manifest.json"
DIAGRAM_MANIFEST = Path("skills") / "mathmodel-diagram" / "code" / "templates" / "manifest.json"

FIGURE_DEPS = ("matplotlib", "numpy", "seaborn")

# 命令行用短名（文档与验收口径写的是 `mms invoke figure ...`），注册表里是全名。
SKILL_ALIASES = {"figure": FIGURE_SKILL, FIGURE_SKILL: FIGURE_SKILL}


def _load_json(path: Path, label: str) -> dict:
    if not path.is_file():
        raise EnvError(f"{label}不存在: {path}（技能是否已 vendor？）")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise EnvError(f"{label}不是合法 JSON: {path} — {exc}") from exc


def list_templates(root: Path | None = None) -> list[dict]:
    """返回两个技能注册表里登记的全部模板（M1 时是 20 + 5）。"""
    root = root or repo_root()
    rows: list[dict] = []
    figure = _load_json(root / FIGURE_MANIFEST, "图表模板注册表")
    for entry in figure.get("templates", []):
        rows.append(
            {
                "skill": FIGURE_SKILL,
                "id": entry.get("id"),
                "title": entry.get("title"),
                "group": entry.get("group", "figure"),
            }
        )
    diagram = _load_json(root / DIAGRAM_MANIFEST, "示意图模板注册表")
    for entry in diagram.get("templates", []):
        rows.append(
            {
                "skill": "mathmodel-diagram",
                "id": entry.get("id"),
                "title": entry.get("title"),
                "group": "diagram",
            }
        )
    return rows


def _missing_deps() -> list[str]:
    return [name for name in FIGURE_DEPS if importlib.util.find_spec(name) is None]


def _default_out(skill: str, template: str) -> Path:
    return Path(tempfile.gettempdir()) / "mms-invoke" / f"{skill}-{template}"


def _collect_artifacts(out_dir: Path) -> dict[str, str]:
    outputs = out_dir / "outputs"
    found: dict[str, str] = {}
    for suffix in (".png", ".pdf", ".svg"):
        candidates = sorted(p for p in outputs.glob(f"*{suffix}") if p.is_file() and p.stat().st_size > 0)
        if candidates:
            found[suffix.lstrip(".")] = str(candidates[0])
    return found


def invoke(
    skill: str,
    template: str,
    out_dir: Path | None = None,
    theme: str | None = None,
    root: Path | None = None,
) -> tuple[int, dict]:
    """调用一个技能模板。返回 (退出码, 机器可读结果)。"""
    root = root or repo_root()
    raw_skill = skill
    skill = SKILL_ALIASES.get(skill.strip().lower())
    if not skill:
        raise EnvError(f"M1 只接通了 figure（{FIGURE_SKILL}），暂不支持: {raw_skill}")

    renderer = root / FIGURE_RENDERER
    if not renderer.is_file():
        raise EnvError(f"找不到上游渲染器: {renderer}（技能是否已 vendor？）")

    missing = _missing_deps()
    if missing:
        raise EnvError(
            "缺少 Python 依赖: "
            + ", ".join(missing)
            + "；先执行 python -m pip install -r requirements.txt（国内镜像见 docs/env-setup.md）"
        )

    out_dir = (out_dir or _default_out(skill, template)).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        str(renderer),
        template,
        "--project",
        str(out_dir),
        "--overwrite",
        "--lang",
        "en",
    ]
    if theme:
        cmd += ["--theme", theme]

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.setdefault("MPLCONFIGDIR", str(out_dir / ".mplconfig"))

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise EnvError(f"渲染超时（300s）: {template}") from exc

    result: dict = {
        "ok": False,
        "skill": skill,
        "template": template,
        "out": str(out_dir),
        "exit": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "outputs": {},
    }

    if proc.returncode != 0:
        # 上游契约：1 = 校验或渲染失败，2 = 用法或环境错误，原样透传。
        result["error"] = proc.stderr.strip() or proc.stdout.strip() or f"渲染器退出 {proc.returncode}"
        return (EXIT_USAGE_OR_ENV if proc.returncode == 2 else EXIT_VALIDATION_FAILED), result

    artifacts = _collect_artifacts(out_dir)
    missing_kinds = [k for k in ("png", "pdf", "svg") if k not in artifacts]
    if missing_kinds:
        # 渲染器说成功但产物没落盘：按校验失败处理，而不是相信退出码。
        result["error"] = f"渲染器退出 0，但缺少产物: {', '.join(missing_kinds)}（目录 {out_dir / 'outputs'}）"
        return EXIT_VALIDATION_FAILED, result

    result["ok"] = True
    result["outputs"] = artifacts
    return EXIT_OK, result
