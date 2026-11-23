"""论文排版：xelatex 编译 PDF，pandoc 转 Word。

排版工具不在仓库里：xelatex 走系统 PATH（或 MMS_XELATEX），pandoc 依次看
MMS_PANDOC、随包的 <MMS_HOME>/pandoc、PATH，最后回落到
%LOCALAPPDATA%/mms-tools/pandoc.exe。缺件时明确报缺，不尝试自动安装。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

FIGURE_TARGET = Path("figures") / "final" / "fig1_residual.png"
XELATEX_TIMEOUT = 300
PANDOC_TIMEOUT = 180
MAX_TAIL = 4000


def _tail(text: str, limit: int = MAX_TAIL) -> str:
    return (text or "").strip()[-limit:]


def _which_pandoc() -> str | None:
    override = os.environ.get("MMS_PANDOC")
    if override:
        return override if Path(override).is_file() else None
    home = os.environ.get("MMS_HOME")
    if home:
        bundled = Path(home) / "pandoc" / ("pandoc.exe" if os.name == "nt" else "pandoc")
        if bundled.is_file():
            return str(bundled)
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
    lines = (proc.stdout or "").strip().splitlines()
    return lines[0].strip() if lines else ""


def env_status() -> dict:
    override = os.environ.get("MMS_XELATEX")
    xelatex = (override if Path(override).is_file() else None) if override else shutil.which("xelatex")
    pandoc = _which_pandoc()
    missing = []
    if not xelatex:
        missing.append("xelatex")
    if not pandoc:
        missing.append("pandoc")
    return {
        "ok": not missing,
        "missing": missing,
        "xelatex": {"found": bool(xelatex), "path": xelatex or "", "version": _version(xelatex)},
        "pandoc": {"found": bool(pandoc), "path": pandoc or "", "version": _version(pandoc)},
    }


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
        raise RuntimeError(f"命令超时（{timeout}s）：{cmd[0]}") from exc
    except OSError as exc:
        raise RuntimeError(f"无法执行 {cmd[0]}：{exc}") from exc


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


def _first_error(log: str) -> str:
    for line in (log or "").splitlines():
        if line.startswith("!") or "error:" in line.lower():
            return line.strip()[:200]
    return ""


def build(workdir: Path, source_tex: Path, figure_png: Path | None) -> tuple[bool, dict]:
    """把稿件与配图放进 workdir，编译 PDF/DOCX。返回 (ok, payload)。"""
    env = env_status()
    if not env["ok"]:
        return False, {
            "ok": False,
            "error": "缺少排版工具：" + "、".join(env["missing"]),
            "env": env,
            "steps": [],
            "artifacts": {},
            "logTail": "",
        }

    steps: list[dict] = []
    log_tail = ""

    def step(row_id: str, label: str, ok: bool, detail: str, started: float) -> None:
        steps.append(
            {"id": row_id, "label": label, "ok": ok, "detail": detail,
             "ms": int((time.time() - started) * 1000)}
        )

    started = time.time()
    try:
        workdir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_tex, workdir / "paper.tex")
        if figure_png is not None and figure_png.is_file():
            target = workdir / FIGURE_TARGET
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(figure_png, target)
            note = "稿件与求解配图已就位"
        else:
            note = "稿件已就位（缺配图）"
        step("stage", "准备稿件", True, note, started)
    except OSError as exc:
        step("stage", "准备稿件", False, str(exc), started)
        return False, _payload(env, steps, {}, str(exc), log_tail, workdir)

    xelatex = env["xelatex"]["path"]
    pandoc = env["pandoc"]["path"]

    for index in (1, 2):
        started = time.time()
        try:
            proc = _run(
                [xelatex, "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "paper.tex"],
                workdir,
                XELATEX_TIMEOUT,
            )
        except RuntimeError as exc:
            step(f"xelatex-{index}", f"xelatex 第 {index} 遍", False, str(exc), started)
            return False, _payload(env, steps, {}, str(exc), log_tail, workdir)
        log_tail = _tail(proc.stdout + "\n" + proc.stderr)
        ok = proc.returncode == 0
        detail = "编译通过" if ok else _first_error(proc.stdout) or f"xelatex 退出 {proc.returncode}"
        step(f"xelatex-{index}", f"xelatex 第 {index} 遍", ok, detail, started)
        if not ok:
            return False, _payload(env, steps, {}, f"xelatex 第 {index} 遍失败：{detail}", log_tail, workdir)

    pdf = workdir / "paper.pdf"
    pdf_ok, pdf_detail = _check_artifact(pdf, "PDF")
    step("pdf", "PDF 产物", pdf_ok, pdf_detail, time.time())
    if not pdf_ok:
        return False, _payload(env, steps, {}, pdf_detail, log_tail, workdir)

    started = time.time()
    try:
        proc = _run([pandoc, "paper.tex", "-o", "paper.docx", "--resource-path=."], workdir, PANDOC_TIMEOUT)
    except RuntimeError as exc:
        step("pandoc", "pandoc 转 Word", False, str(exc), started)
        return False, _payload(env, steps, {}, str(exc), log_tail, workdir)
    docx = workdir / "paper.docx"
    docx_ok, docx_detail = _check_artifact(docx, "DOCX")
    step("pandoc", "pandoc 转 Word", docx_ok,
         docx_detail if docx_ok else _tail(proc.stderr, 400) or docx_detail, started)
    if not docx_ok:
        return False, _payload(env, steps, {}, docx_detail, log_tail, workdir)

    artifacts = {"pdf": str(pdf), "docx": str(docx), "tex": str(workdir / "paper.tex")}
    return True, _payload(env, steps, artifacts, "", log_tail, workdir)


def _payload(env: dict, steps: list[dict], artifacts: dict, error: str, log_tail: str, workdir: Path) -> dict:
    return {
        "ok": not error,
        "error": error or None,
        "env": env,
        "steps": steps,
        "artifacts": artifacts,
        "logTail": log_tail,
        "workdir": str(workdir),
    }
