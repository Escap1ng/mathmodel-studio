"""M4 评分与章节门禁：把 mathmodel-score 的脚本结果整理成界面可渲染的数据。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .registry import repo_root

MAX_ROUNDS = 3
DEMO_SCORES = Path(__file__).resolve().parent / "demo_scores.json"


def _run_script(script: Path, args: list[str], cwd: Path) -> tuple[int, str, str]:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    proc = subprocess.run(
        [sys.executable, str(script), *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=120,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _run_card(root: Path, card: dict, workdir: Path) -> dict:
    script = root / "skills" / "mathmodel-score" / "code" / "score_card.py"
    path = workdir / f"round-{card.get('round', 0)}.json"
    path.write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
    code, stdout, stderr = _run_script(script, [str(path), "--json"], root)
    if code not in (0, 1):
        raise RuntimeError(stderr.strip() or f"评分脚本退出 {code}")
    data = json.loads(stdout)

    by_dim = {d["id"]: d for d in card.get("dimensions", [])}
    for deduction in data.get("deductions", []):
        source = by_dim.get(deduction.get("dim_id"), {})
        match = next(
            (
                item
                for item in source.get("deductions", [])
                if item.get("item") == deduction.get("item")
                and float(item.get("penalty", 0) or 0) == float(deduction.get("penalty", 0) or 0)
            ),
            {},
        )
        deduction["target"] = match.get("target", "尚未标注正文位置")
        deduction["suggestion"] = match.get("suggestion", "按评分项要求补充内容。")
    data["round"] = card.get("round", data.get("round"))
    data["veto"] = bool(card.get("veto"))
    data["changes"] = []
    data["breaker"] = bool(
        isinstance(data["round"], int) and data["round"] >= MAX_ROUNDS and not data.get("pass")
    )
    return data


def _changes(current: dict, previous: dict | None) -> list[dict]:
    if not previous:
        return []
    old = {d["id"]: d["score"] for d in previous.get("dimensions", [])}
    out = []
    for dim in current.get("dimensions", []):
        before = old.get(dim["id"])
        if before is None:
            continue
        delta = dim["score"] - before
        if delta:
            out.append(
                {
                    "dim": dim["label"],
                    "from": before,
                    "to": dim["score"],
                    "delta": delta,
                }
            )
    return out


def state(root: Path | None = None) -> dict:
    root = root or repo_root()
    demo = json.loads(DEMO_SCORES.read_text(encoding="utf-8"))
    rounds = []
    with tempfile.TemporaryDirectory(prefix="mms-score-") as temp:
        workdir = Path(temp)
        previous = None
        for card in demo.get("rounds", []):
            result = _run_card(root, card, workdir)
            result["changes"] = _changes(result, previous)
            rounds.append(result)
            previous = result
        veto = _run_card(root, demo.get("veto", {}), workdir) if demo.get("veto") else None

    chapter_script = root / "skills" / "mathmodel-score" / "code" / "check_chapters.py"
    sample = root / "skills" / "mathmodel-score" / "examples" / "chapter-sample.tex"
    code, stdout, stderr = _run_script(
        chapter_script, [str(sample), "--json"], root
    )
    chapter = {"ok": False, "error": stderr.strip() or f"章节自检退出 {code}"}
    if code in (0, 1):
        report = json.loads(stdout)
        counts = (report.get("files") or [{}])[0].get("counts", {})
        chapter = {
            "ok": True,
            "pass": bool(report.get("pass")),
            "hard_failed": int(report.get("hard_failed", 0)),
            "soft_failed": int(report.get("soft_failed", 0)),
            "manual": int(counts.get("manual", 0)),
            "pass_count": int(counts.get("pass", 0)),
        }

    default_round = next((r["round"] for r in rounds if r.get("pass")), rounds[-1]["round"] if rounds else 0)
    return {"ok": True, "rounds": rounds, "veto": veto, "defaultRound": default_round, "chapter": chapter}
