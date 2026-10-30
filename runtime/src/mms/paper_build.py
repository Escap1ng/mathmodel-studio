"""M5 论文排版：xelatex 编译、pandoc 转 Word、去 AI 与章节门禁。

排版工具不在仓库里：xelatex 走系统 PATH（或 MMS_XELATEX），pandoc 走 PATH、
MMS_PANDOC，最后回落到 %LOCALAPPDATA%/mms-tools/pandoc.exe。缺件时明确报缺，
不尝试自动安装。
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .registry import EXIT_OK, EXIT_USAGE_OR_ENV, EXIT_VALIDATION_FAILED, EnvError, repo_root

SAMPLE_DIR = Path(__file__).resolve().parent / "paper_sample"
SAMPLE_TEX = SAMPLE_DIR / "paper.tex"
SAMPLE_FIGURE = Path("skills") / "mathmodel-figure" / "examples" / "previews" / "fit_confidence_residual_replica.png"
FIGURE_TARGET = Path("figures") / "final" / "fig1_residual.png"
XELATEX_TIMEOUT = 300
PANDOC_TIMEOUT = 180
MAX_TAIL = 4000


def _tail(text: str, limit: int = MAX_TAIL) -> str:
    text = (text or "").strip()
    return text[-limit:]


def _which_pandoc() -> str | None:
    override = os.environ.get("MMS_PANDOC")
    if override:
        return override if Path(override).is_file() else None
    found = shutil.which("pandoc")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidate = Path(local) / "mms-tools" / "pandoc.exe"
        if candidate.is_file():
            return str(candidate)
    return None


def _version(exe: str | None) -> str:
    if not exe:
        return ""
    try:
        proc = subprocess.run(
            [exe, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    line = (proc.stdout or "").strip().splitlines()
    return line[0].strip() if line else ""


def env_status() -> dict:
    override = os.environ.get("MMS_XELATEX")
    xelatex = (override if Path(override).is_file() else None) if override else shutil.which("xelatex")
    pandoc = _which_pandoc()
    python_docx = importlib.util.find_spec("docx") is not None
    missing = []
    if not xelatex:
        missing.append("xelatex")
    if not pandoc:
        missing.append("pandoc")
    if not python_docx:
        missing.append("python-docx")
    return {
        "ok": not missing,
        "missing": missing,
        "xelatex": {"found": bool(xelatex), "path": xelatex or "", "version": _version(xelatex)},
        "pandoc": {"found": bool(pandoc), "path": pandoc or "", "version": _version(pandoc)},
        "python_docx": python_docx,
    }


def _state_path(data_dir: Path) -> Path:
    return data_dir / "workbench" / "paper" / "build.json"


def workspace(data_dir: Path) -> Path:
    return data_dir / "workbench" / "paper"


def _read_state(data_dir: Path) -> dict:
    try:
        data = json.loads(_state_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_state(data_dir: Path, state: dict) -> None:
    path = _state_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _run(cmd: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    try:
        return subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise EnvError(f"命令超时（{timeout}s）：{' '.join(cmd[:2])}") from exc
    except OSError as exc:
        raise EnvError(f"无法执行 {cmd[0]}：{exc}") from exc


def _run_json(script: Path, args: list[str], cwd: Path, timeout: int = 120) -> tuple[int, dict | None]:
    proc = _run([sys.executable, str(script), *args], cwd, timeout)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc.returncode, None
    return proc.returncode, data


def _stage(workspace_dir: Path, root: Path, source: Path | None) -> list[str]:
    """把稿件与配图放进工作区，返回做了什么。"""
    notes = []
    workspace_dir.mkdir(parents=True, exist_ok=True)
    tex = workspace_dir / "paper.tex"
    if source is not None:
        if not source.is_file():
            raise EnvError(f"找不到稿件：{source}")
        shutil.copyfile(source, tex)
        notes.append(f"稿件来自 {source}")
    elif not tex.is_file():
        shutil.copyfile(SAMPLE_TEX, tex)
        notes.append("稿件来自演示样例")

    figure_src = root / SAMPLE_FIGURE
    figure_dst = workspace_dir / FIGURE_TARGET
    if not figure_dst.is_file():
        if not figure_src.is_file():
            raise EnvError(f"找不到演示配图：{figure_src}（技能是否已 vendor？）")
        figure_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(figure_src, figure_dst)
        notes.append("配图来自 mathmodel-figure 的预览")
    return notes


def _check_artifact(path: Path, kind: str) -> tuple[bool, str]:
    if not path.is_file():
        return False, f"{kind} 未生成"
    size = path.stat().st_size
    if size <= 1000:
        return False, f"{kind} 只有 {size} B"
    head = path.open("rb").read(8)
    if kind == "PDF" and not head.startswith(b"%PDF"):
        return False, "PDF 文件头不对"
    if kind == "DOCX" and not head.startswith(b"PK"):
        return False, "DOCX 不是 zip 容器"
    return True, f"{kind} {size // 1024} KB"


def _gate_phrasing(root: Path, cwd: Path, tex: str) -> dict:
    script = root / "skills" / "mathmodel-deai" / "code" / "check_phrasing.py"
    code, data = _run_json(script, ["--json", tex], cwd)
    hits = len((data or {}).get("hits") or [])
    ok = code == 0
    return {
        "id": "phrasing",
        "label": "去 AI 措辞",
        "ok": ok,
        "detail": "0 处命中" if ok else f"命中 {hits} 处" if data else f"检查器退出 {code}",
    }


def _gate_style(root: Path, cwd: Path, tex: str) -> dict:
    script = root / "skills" / "mathmodel-deai" / "code" / "check_style.py"
    code, data = _run_json(script, ["--json", tex], cwd)
    hits = (data or {}).get("hits") or []
    ok = code == 0
    detail = "0 处命中" if ok else f"命中 {len(hits)} 处" if data else f"检查器退出 {code}"
    return {"id": "style", "label": "结构指标", "ok": ok, "detail": detail}


def _gate_chapters(root: Path, cwd: Path, tex: str) -> dict:
    script = root / "skills" / "mathmodel-score" / "code" / "check_chapters.py"
    code, data = _run_json(script, ["--json", "--rules", "cumcm", tex], cwd)
    if data is None:
        return {"id": "chapters", "label": "章节结构", "ok": False, "detail": f"检查器退出 {code}"}
    counts = ((data.get("files") or [{}])[0]).get("counts", {})
    hard = int(data.get("hard_failed", counts.get("hard", 0)))
    soft = int(data.get("soft_failed", counts.get("soft", 0)))
    manual = int(counts.get("manual", 0))
    return {
        "id": "chapters",
        "label": "章节结构",
        "ok": hard == 0,
        "detail": f"hard {hard} · soft {soft} · 人工 {manual}",
    }


def state(data_dir: Path, root: Path | None = None) -> dict:
    root = root or repo_root()
    state = _read_state(data_dir)
    workdir = workspace(data_dir)
    artifacts = {}
    for kind, name in (("pdf", "paper.pdf"), ("docx", "paper.docx"), ("tex", "paper.tex")):
        path = workdir / name
        if path.is_file():
            artifacts[kind] = {"path": str(path), "size": path.stat().st_size}
    return {
        "ok": bool(state.get("ok")),
        "env": env_status(),
        "artifacts": artifacts,
        "builtAt": state.get("builtAt"),
        "steps": state.get("steps", []),
        "gates": state.get("gates", []),
        "error": state.get("error"),
        "logTail": state.get("logTail", ""),
        "workspace": str(workdir),
    }


def build(data_dir: Path, root: Path | None = None, source: Path | None = None) -> tuple[int, dict]:
    root = root or repo_root()
    env = env_status()
    if not env["ok"]:
        return EXIT_USAGE_OR_ENV, {
            "ok": False,
            "error": "缺少排版工具：" + "、".join(env["missing"]),
            "env": env,
            "steps": [],
            "gates": [],
        }

    workdir = workspace(data_dir)
    steps: list[dict] = []
    log_tail = ""

    def step(row_id: str, label: str, ok: bool, detail: str, started: float) -> None:
        steps.append(
            {
                "id": row_id,
                "label": label,
                "ok": ok,
                "detail": detail,
                "ms": int((time.time() - started) * 1000),
            }
        )

    started = time.time()
    try:
        notes = _stage(workdir, root, source)
        step("stage", "准备稿件", True, "；".join(notes) or "沿用现有稿件", started)
    except EnvError as exc:
        step("stage", "准备稿件", False, str(exc), started)
        code, payload = _finish(data_dir, env, steps, [], str(exc), "")
        return EXIT_USAGE_OR_ENV, payload

    xelatex = env["xelatex"]["path"]
    pandoc = env["pandoc"]["path"]
    tex = "paper.tex"

    for index in (1, 2):
        started = time.time()
        proc = _run(
            [xelatex, "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", tex],
            workdir,
            XELATEX_TIMEOUT,
        )
        log_tail = _tail(proc.stdout + "\n" + proc.stderr)
        ok = proc.returncode == 0
        detail = "编译通过" if ok else _first_error(proc.stdout) or f"xelatex 退出 {proc.returncode}"
        step(f"xelatex-{index}", f"xelatex 第 {index} 遍", ok, detail, started)
        if not ok:
            return _finish(data_dir, env, steps, [], f"xelatex 第 {index} 遍失败：{detail}", log_tail)

    (workdir / "logs").mkdir(exist_ok=True)
    if (workdir / "paper.log").is_file():
        shutil.copyfile(workdir / "paper.log", workdir / "logs" / "paper.log")
    pdf = workdir / "paper.pdf"
    pdf_ok, pdf_detail = _check_artifact(pdf, "PDF")
    started = time.time()
    step("pdf", "PDF 产物", pdf_ok, pdf_detail, started)
    if not pdf_ok:
        return _finish(data_dir, env, steps, [], pdf_detail, log_tail)

    started = time.time()
    proc = _run([pandoc, tex, "-o", "paper.docx", "--resource-path=."], workdir, PANDOC_TIMEOUT)
    docx = workdir / "paper.docx"
    docx_ok, docx_detail = _check_artifact(docx, "DOCX")
    step("pandoc", "pandoc 转 Word", docx_ok, docx_detail if docx_ok else _tail(proc.stderr, 400) or docx_detail, started)
    if not docx_ok:
        return _finish(data_dir, env, steps, [], docx_detail, log_tail)

    started = time.time()
    post = root / "skills" / "mathmodel-paper" / "code" / "word_postprocess.py"
    proc = _run([sys.executable, str(post), "paper.docx"], workdir, PANDOC_TIMEOUT)
    ok = proc.returncode == 0 and _check_artifact(docx, "DOCX")[0]
    step("docx", "Word 版式微调", ok, "版式微调完成" if ok else _tail(proc.stderr, 400) or f"后处理退出 {proc.returncode}", started)

    gates = [
        _gate_phrasing(root, workdir, tex),
        _gate_style(root, workdir, tex),
        _gate_chapters(root, workdir, tex),
    ]
    all_ok = ok and all(g["ok"] for g in gates)
    error = "" if all_ok else "；".join(g["label"] + "：" + g["detail"] for g in gates if not g["ok"])
    return _finish(data_dir, env, steps, gates, error, log_tail)


def _first_error(log: str) -> str:
    for line in (log or "").splitlines():
        if line.startswith("!") or "error:" in line.lower():
            return line.strip()[:200]
    return ""


def _finish(
    data_dir: Path, env: dict, steps: list[dict], gates: list[dict], error: str, log_tail: str
) -> tuple[int, dict]:
    ok = not error and bool(steps) and all(s["ok"] for s in steps) and all(g["ok"] for g in gates)
    state = {
        "ok": ok,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "steps": steps,
        "gates": gates,
        "error": error or None,
        "logTail": log_tail,
    }
    _save_state(data_dir, state)
    payload = state | {"env": env, "workspace": str(workspace(data_dir))}
    return (EXIT_OK if ok else EXIT_VALIDATION_FAILED), payload
