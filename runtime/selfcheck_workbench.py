"""G9 · 工作台自检：真渲两版、换主题、回滚、评分与门禁。

需要 matplotlib/numpy/seaborn（与 G3 相同），运行于 gates job；
不依赖窗口、不联网、不读真实 Key。
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "runtime" / "src"))

from mms import project_export, workbench_figure, workbench_score  # noqa: E402
from mms.store import SessionStore, session_scope  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


def digest(path: str | None) -> str:
    if not path or not Path(path).is_file():
        return ""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="mms-workbench-"))
    data = workdir / "data"
    try:
        initial = workbench_figure.state_payload(ROOT, data)
        check(
            "W1 初始工作台有 20 个图表模板与 3 套主题",
            len(initial["templates"]) == 20
            and {t["id"] for t in initial["themes"]} == {"nature", "studio-ink", "studio-amber"},
            f"templates={len(initial['templates'])} themes={[t['id'] for t in initial['themes']]}",
        )
        check("W1 初始没有版本", initial["versions"] == [] and initial["active"] is None, str(initial["versions"]))

        code, first = workbench_figure.render("line-compare", "nature", ROOT, data)
        outputs = (first.get("version") or {}).get("outputs", {})
        check(
            "W2 第一次渲染产出 PNG/PDF/SVG",
            code == 0 and all(Path(outputs.get(k, "")).is_file() and Path(outputs[k]).stat().st_size > 0 for k in ("png", "pdf", "svg")),
            f"exit={code} outputs={sorted(outputs)}",
        )

        code2, second = workbench_figure.render("line-compare", "studio-ink", ROOT, data)
        after = workbench_figure.state_payload(ROOT, data)
        first_png = (first.get("version") or {}).get("outputs", {}).get("png")
        second_png = (second.get("version") or {}).get("outputs", {}).get("png")
        check(
            "W3 换主题生成第二版，当前与上一版并存",
            code2 == 0
            and len(after["versions"]) == 2
            and after["active"] == second["version"]["id"]
            and after["previous"] == first["version"]["id"]
            and digest(first_png) != digest(second_png),
            f"active={after['active']} previous={after['previous']} hash {digest(first_png)}/{digest(second_png)}",
        )

        code3, _ = workbench_figure.rollback(first["version"]["id"], ROOT, data)
        rolled = workbench_figure.state_payload(ROOT, data)
        check(
            "W4 回滚到第一版",
            code3 == 0 and rolled["active"] == first["version"]["id"] and Path(rolled["active_png"]).is_file(),
            f"exit={code3} active={rolled['active']}",
        )

        before_count = len(rolled["versions"])
        bad_code, bad = workbench_figure.render("not-a-template", "nature", ROOT, data)
        bad_theme_code, bad_theme = workbench_figure.render("line-compare", "not-a-theme", ROOT, data)
        after_bad = workbench_figure.state_payload(ROOT, data)
        check(
            "W5 未知模板/主题被拒且不新增版本",
            bad_code == 2 and bad_theme_code == 2 and len(after_bad["versions"]) == before_count,
            f"template={bad_code} theme={bad_theme_code} versions={len(after_bad['versions'])}",
        )
        check(
            "W5 未知版本回滚被拒",
            workbench_figure.rollback("v999", ROOT, data)[0] == 2,
            "v999",
        )

        # S7b：产物目录按会话隔离；非法 sid 一律回落全局目录。
        scoped = session_scope(data, "a1b2c3d4")
        check(
            "W8 十六进制 sid 映射到 sessions/<sid>",
            scoped == data / "sessions" / "a1b2c3d4",
            str(scoped),
        )
        bad_sids = ("../evil", "a1/b2", "A1B2C3D4", "a1", "", None, "a1b2c3d4/../../x")
        check(
            "W8 非法 sid 回落全局目录（路径穿越被拒）",
            all(session_scope(data, bad) == data for bad in bad_sids),
            "，".join(str(session_scope(data, bad)) for bad in bad_sids),
        )
        scoped_code, _ = workbench_figure.render("line-compare", "nature", ROOT, scoped)
        scoped_state = workbench_figure.state_payload(ROOT, scoped)
        global_state = workbench_figure.state_payload(ROOT, data)
        check(
            "W8 会话产物的版本不混入全局目录",
            scoped_code == 0
            and len(scoped_state["versions"]) == 1
            and len(global_state["versions"]) == before_count
            and Path(scoped_state["active_png"]).is_file()
            and str(scoped) in str(scoped_state["active_png"]),
            f"scoped={len(scoped_state['versions'])} global={len(global_state['versions'])} active={scoped_state['active_png']}",
        )

        old_db = workdir / "old" / "sessions.db"
        old_db.parent.mkdir(parents=True)
        with sqlite3.connect(old_db) as conn:
            conn.executescript(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, created REAL NOT NULL, updated REAL NOT NULL,"
                " provider TEXT NOT NULL, model TEXT NOT NULL, problem TEXT NOT NULL, phases TEXT NOT NULL,"
                " pending TEXT, messages TEXT NOT NULL, batch INTEGER NOT NULL DEFAULT 1);"
            )
            conn.execute(
                "INSERT INTO sessions VALUES"
                " ('a1b2c3d4e5f60718', 0, 0, 'fake', 'm', 'p', '[]', NULL, '[]', 1)"
            )
        migrated = SessionStore(old_db)
        old_row = migrated.get("a1b2c3d4e5f60718")
        migrated.create("0011223344556677", "fake", "m", "p", str(workdir))
        new_row = migrated.get("0011223344556677")
        check(
            "W8 旧库补 workspace 列，新会话可写入归属目录",
            old_row is not None
            and old_row["workspace"] is None
            and new_row is not None
            and new_row["workspace"] == str(workdir),
            f"old={(old_row or {}).get('workspace')} new={(new_row or {}).get('workspace')}",
        )

        # S7c：图表副本落进用户赛题文件夹；目标不可写只记日志、不抛错。
        user_ws = workdir / "user-workspace"
        scoped_outputs = scoped_state["versions"][-1]["outputs"]
        project_export.copy_outputs(str(user_ws), "图表", scoped_outputs)
        copied = sorted(item.name for item in (user_ws / "图表").iterdir())
        check(
            "W9 图表三件套复制到赛题文件夹",
            set(copied) == {Path(path).name for path in scoped_outputs.values()},
            f"copied={copied}",
        )
        blocked = workdir / "blocked-target"
        blocked.write_text("x", encoding="utf-8")
        quiet = io.StringIO()
        with contextlib.redirect_stderr(quiet):
            project_export.copy_outputs(str(blocked), "论文", scoped_outputs)
        check(
            "W9 目标不可写时静默跳过",
            blocked.is_file() and "[export]" in quiet.getvalue(),
            quiet.getvalue().strip()[:80],
        )

        score = workbench_score.state(ROOT)
        rounds = score["rounds"]
        check(
            "W6 三轮评分与默认轮次",
            [r["total"] for r in rounds] == [78, 86, 84]
            and score["defaultRound"] == 2
            and all(len(r["dimensions"]) == 5 for r in rounds),
            f"totals={[r['total'] for r in rounds]} default={score['defaultRound']}",
        )
        check(
            "W6 第 3 轮低于 85 触发熔断",
            rounds[2]["breaker"] is True and rounds[1]["pass"] is True,
            f"round3 breaker={rounds[2]['breaker']} round2 pass={rounds[1]['pass']}",
        )
        targets = [d.get("target") for r in rounds for d in r["deductions"] if d.get("target")]
        check(
            "W6 扣分项带正文定位与改法",
            len(targets) >= 8 and any("摘要" in (t or "") for t in targets),
            f"targets={len(targets)} sample={targets[:2]}",
        )
        check(
            "W6 一票否决示例",
            score["veto"] is not None and score["veto"]["verdict"] == "veto" and not score["veto"]["pass"],
            f"verdict={(score['veto'] or {}).get('verdict')}",
        )
        check(
            "W7 章节样例 hard/soft 均为 0",
            score["chapter"].get("ok") and score["chapter"].get("hard_failed") == 0
            and score["chapter"].get("soft_failed") == 0,
            str(score["chapter"]),
        )
        check(
            "W7 默认轮次总分达标",
            next(r for r in rounds if r["round"] == score["defaultRound"])["pass"] is True,
            f"total={next(r['total'] for r in rounds if r['round'] == score['defaultRound'])}",
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    failed = [row for row in results if not row[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name}\n       {detail}")
    print(f"\n{len(results) - len(failed)}/{len(results)} 条工作台断言通过")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
