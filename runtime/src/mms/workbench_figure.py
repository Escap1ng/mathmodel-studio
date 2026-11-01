"""M4 图表工作台：渲染、主题切换与版本回滚。

渲染仍然走 mathmodel-figure 的 render_template.py（subprocess），
这里只负责把产物放进版本目录、记录当前版与上一版。
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path

from .invoke import invoke, list_templates
from .registry import repo_root

LOCK = threading.Lock()
MAX_VERSIONS = 8
CUSTOM_THEMES = Path(__file__).resolve().parent / "themes"


def _read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def themes(root: Path | None = None) -> list[dict]:
    root = root or repo_root()
    rows = []
    bundled = root / "skills" / "mathmodel-figure" / "themes" / "nature.theme.json"
    for path, builtin in [(bundled, True)] + [
        (p, False) for p in sorted(CUSTOM_THEMES.glob("*.theme.json"))
    ]:
        data = _read_json(path, {})
        name = data.get("name") or path.name.removesuffix(".theme.json")
        rows.append(
            {
                "id": name,
                "title": data.get("title") or name,
                "path": str(path),
                "builtin": builtin,
            }
        )
    return rows


def templates(root: Path | None = None) -> list[dict]:
    return [row for row in list_templates(root) if row.get("skill") == "mathmodel-figure"]


def _state_path(data_dir: Path) -> Path:
    return data_dir / "workbench" / "figure" / "state.json"


def _load_state(data_dir: Path) -> dict:
    state = _read_json(_state_path(data_dir), {})
    if not isinstance(state, dict):
        state = {}
    state.setdefault("counter", 0)
    state.setdefault("active", None)
    state.setdefault("versions", [])
    return state


def _save_state(data_dir: Path, state: dict) -> None:
    path = _state_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _find(state: dict, version_id: str | None) -> dict | None:
    if not version_id:
        return None
    return next((v for v in state["versions"] if v.get("id") == version_id), None)


def state_payload(root: Path | None = None, data_dir: Path | None = None) -> dict:
    root = root or repo_root()
    data_dir = data_dir or Path(".")
    state = _load_state(data_dir)
    versions = state["versions"]
    active = _find(state, state.get("active")) or (versions[-1] if versions else None)
    if active and active.get("id") != state.get("active"):
        state["active"] = active["id"]
        _save_state(data_dir, state)
    previous = None
    if active:
        index = versions.index(active)
        if index > 0:
            previous = versions[index - 1]
    return {
        "ok": True,
        "templates": templates(root),
        "themes": [{k: v for k, v in row.items() if k != "path"} for row in themes(root)],
        "versions": versions,
        "active": active["id"] if active else None,
        "active_png": (active or {}).get("outputs", {}).get("png"),
        "previous": previous["id"] if previous else None,
        "previous_png": (previous or {}).get("outputs", {}).get("png"),
    }


def _prune(data_dir: Path, state: dict) -> None:
    versions = state["versions"]
    if len(versions) <= MAX_VERSIONS:
        return
    drop = versions[:-MAX_VERSIONS]
    for version in drop:
        if version.get("id") == state.get("active"):
            continue
        path = data_dir / "workbench" / "figure" / "versions" / str(version.get("id"))
        shutil.rmtree(path, ignore_errors=True)
    state["versions"] = [v for v in versions if v not in drop]


def render(
    template: str, theme: str, root: Path | None = None, data_dir: Path | None = None
) -> tuple[int, dict]:
    root = root or repo_root()
    data_dir = data_dir or Path(".")
    template_row = next((row for row in templates(root) if row.get("id") == template), None)
    theme_row = next((row for row in themes(root) if row.get("id") == theme), None)
    if template_row is None:
        return 2, {"ok": False, "error": f"未知模板: {template}"}
    if theme_row is None:
        return 2, {"ok": False, "error": f"未知主题: {theme}"}

    with LOCK:
        state = _load_state(data_dir)
        state["counter"] += 1
        version_id = f"v{state['counter']}"
        out_dir = data_dir / "workbench" / "figure" / "versions" / version_id
        out_dir.mkdir(parents=True, exist_ok=True)
        code, result = invoke(
            "figure", template, out_dir=out_dir, theme=theme_row["path"], root=root
        )
        if code != 0:
            shutil.rmtree(out_dir, ignore_errors=True)
            return code, {"ok": False, "error": result.get("error", "渲染失败"), "result": result}

        version = {
            "id": version_id,
            "label": version_id,
            "template": template,
            "template_title": template_row.get("title", template),
            "theme": theme,
            "theme_title": theme_row.get("title", theme),
            "created": time.time(),
            "outputs": result["outputs"],
            "command": (
                f"python skills/mathmodel-figure/code/tools/render_template.py {template} "
                f"--project {out_dir} --theme {theme_row['path']} --overwrite --lang en"
            ),
            "stdout": (result.get("stdout") or "")[-4000:],
            "stderr": (result.get("stderr") or "")[-4000:],
        }
        state["versions"].append(version)
        state["active"] = version_id
        _prune(data_dir, state)
        _save_state(data_dir, state)
        return 0, {"ok": True, "version": version}


def rollback(version_id: str, root: Path | None = None, data_dir: Path | None = None) -> tuple[int, dict]:
    data_dir = data_dir or Path(".")
    with LOCK:
        state = _load_state(data_dir)
        version = _find(state, version_id)
        if version is None:
            return 2, {"ok": False, "error": f"没有这个版本: {version_id}"}
        state["active"] = version_id
        _save_state(data_dir, state)
        return 0, {"ok": True, "version": version}


def register(
    *,
    data_dir: Path,
    sources: dict[str, str],
    template: str,
    template_title: str,
    theme: str,
    theme_title: str,
    command: str,
    stdout: str = "",
    stderr: str = "",
    label: str | None = None,
) -> dict:
    """把外部渲染的产物登记成一个版本（阶段四的基线图走这条路）。

    和 render() 共用同一份版本状态：登记后图表页、代码页与日志页都只看这一处，
    回滚、上限裁剪也沿用原有规则。
    """
    with LOCK:
        state = _load_state(data_dir)
        state["counter"] += 1
        version_id = f"v{state['counter']}"
        out_dir = data_dir / "workbench" / "figure" / "versions" / version_id
        out_dir.mkdir(parents=True, exist_ok=True)
        outputs: dict[str, str] = {}
        for kind, source in sources.items():
            src = Path(source)
            if not src.is_file():
                continue
            dest = out_dir / f"figure.{kind}"
            shutil.copyfile(src, dest)
            outputs[kind] = str(dest)
        version = {
            "id": version_id,
            "label": label or version_id,
            "template": template,
            "template_title": template_title,
            "theme": theme,
            "theme_title": theme_title,
            "created": time.time(),
            "outputs": outputs,
            "command": command,
            "stdout": (stdout or "")[-4000:],
            "stderr": (stderr or "")[-4000:],
        }
        state["versions"].append(version)
        state["active"] = version_id
        _prune(data_dir, state)
        _save_state(data_dir, state)
        return version
