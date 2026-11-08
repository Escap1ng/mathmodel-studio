"""G10 · 论文排版自检：真跑 xelatex、pandoc 与三道门禁。

需要 xelatex、pandoc 与 python-docx。CI 的 ubuntu gates job 负责装齐；
没有 TeX 的环境显式跳过（MMS_PAPER_SKIP=1），跳过不会被当成通过。
"""

from __future__ import annotations

import os
import shutil
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

from mms import paper_build  # noqa: E402
from mms.store import session_scope  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


def artifact(data: Path, name: str) -> Path:
    return paper_build.workspace(data) / name


def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="mms-paper-check-"))
    data = workdir / "data"
    data_bad = workdir / "data-bad"
    try:
        env = paper_build.env_status()
        check(
            "P1 排版工具齐全",
            env["ok"],
            f"missing={env['missing']} xelatex={env['xelatex']['version']} pandoc={env['pandoc']['version']}",
        )
        if not env["ok"]:
            if os.environ.get("MMS_PAPER_SKIP") == "1":
                print(f"SKIP 缺少排版工具：{env['missing']}（MMS_PAPER_SKIP=1，未验证 G10）")
                return 0
            print(f"FAIL 缺少排版工具：{env['missing']}；装齐后再跑，或显式设 MMS_PAPER_SKIP=1 跳过")
            return 1

        code, first = paper_build.build(data, ROOT)
        pdf = artifact(data, "paper.pdf")
        docx = artifact(data, "paper.docx")
        steps = {row["id"]: row for row in first["steps"]}
        gates = {row["id"]: row for row in first["gates"]}
        check(
            "P2 首次构建通过",
            code == 0 and first["ok"] and pdf.is_file() and docx.is_file(),
            f"exit={code} steps={len(steps)} pdf={pdf.exists()} docx={docx.exists()}",
        )
        check(
            "P2 PDF 与 DOCX 文件头正确",
            pdf.open("rb").read(4) == b"%PDF" and docx.open("rb").read(2) == b"PK",
            f"pdf={pdf.stat().st_size if pdf.exists() else 0}B docx={docx.stat().st_size if docx.exists() else 0}B",
        )
        check(
            "P3 六个构建步骤全部完成",
            set(steps) == {"stage", "xelatex-1", "xelatex-2", "pdf", "pandoc", "docx"}
            and all(row["ok"] for row in steps.values()),
            ",".join(f"{k}={v['ok']}" for k, v in steps.items()),
        )
        check(
            "P4 三道门禁全绿",
            set(gates) == {"phrasing", "style", "chapters"} and all(row["ok"] for row in gates.values()),
            "；".join(f"{k}: {v['detail']}" for k, v in gates.items()),
        )

        saved = paper_build.state(data, ROOT)
        check(
            "P5 构建状态落盘并可复读",
            saved["ok"] and saved["builtAt"] and Path(saved["artifacts"]["pdf"]["path"]).is_file(),
            f"builtAt={saved['builtAt']} artifacts={sorted(saved['artifacts'])}",
        )

        old = os.environ.get("MMS_PANDOC")
        os.environ["MMS_PANDOC"] = str(workdir / "no-such-pandoc.exe")
        try:
            missing_code, missing = paper_build.build(data_bad, ROOT)
        finally:
            if old is None:
                os.environ.pop("MMS_PANDOC", None)
            else:
                os.environ["MMS_PANDOC"] = old
        check(
            "P6 缺 pandoc 时明确拒绝且不产出",
            missing_code == 2
            and "pandoc" in (missing.get("error") or "")
            and not artifact(data_bad, "paper.pdf").exists(),
            f"exit={missing_code} error={missing.get('error')}",
        )

        bad_source = workdir / "banned.tex"
        sample = (paper_build.SAMPLE_TEX).read_text(encoding="utf-8")
        # transition-abuse 的 max_per_document 是 1，注入两次才会超限。
        bad_source.write_text(
            sample.replace(
                "共享单车系统在早高峰呈现单向潮汐。",
                "综上所述，共享单车系统在早高峰呈现单向潮汐。",
            ).replace(
                "模型规模可控，贪心算法在普通笔记本上 3 分钟内收敛。",
                "综上所述，模型规模可控，贪心算法在普通笔记本上 3 分钟内收敛。",
            ),
            encoding="utf-8",
        )
        gate_code, gate_state = paper_build.build(workdir / "data-gate", ROOT, source=bad_source)
        gate_rows = {row["id"]: row for row in gate_state["gates"]}
        check(
            "P7 门禁能抓住坏稿（排版仍出产物，但整体判失败）",
            gate_code == 1
            and not gate_state["ok"]
            and gate_rows.get("phrasing", {}).get("ok") is False
            and artifact(workdir / "data-gate", "paper.pdf").is_file(),
            f"exit={gate_code} phrasing={gate_rows.get('phrasing')}",
        )

        broken = workdir / "broken.tex"
        broken.write_text(
            "\\documentclass{article}\\begin{document}\\nosuchcommand\\end{document}\n",
            encoding="utf-8",
        )
        broken_code, broken_state = paper_build.build(workdir / "data-broken", ROOT, source=broken)
        check(
            "P8 编译失败给出错误位置与退出码 1",
            broken_code == 1
            and not broken_state["ok"]
            and not artifact(workdir / "data-broken", "paper.pdf").exists(),
            f"exit={broken_code} error={broken_state.get('error')}",
        )

        missing_code, missing_state = paper_build.build(
            workdir / "data-missing", ROOT, source=workdir / "no-such.tex"
        )
        check(
            "P9 稿件不存在按用法错误退出 2",
            missing_code == 2 and not missing_state["ok"],
            f"exit={missing_code} error={missing_state.get('error')}",
        )

        sid_dir = session_scope(data, "a1b2c3d4e5f60718")
        check(
            "P10 论文目录按会话隔离，非法 sid 回落全局",
            paper_build.workspace(sid_dir)
            == data / "sessions" / "a1b2c3d4e5f60718" / "workbench" / "paper"
            and paper_build.workspace(session_scope(data, "../x")) == paper_build.workspace(data),
            str(paper_build.workspace(sid_dir)),
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    failed = [row for row in results if not row[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name}\n       {detail}")
    print(f"\n{len(results) - len(failed)}/{len(results)} 条论文断言通过")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
