"""G11 · 编排状态机自检：起题 → K2 确认 → K3 选模 → 进入阶段四。

不依赖窗口、不联网、不读真实 Key；只用临时目录里的 SQLite。
回归点：英文题面不含中文关键词时走默认方法族，`DEFAULT_FAMILY` 曾写成单元素元组，
`_candidates` 拿到的是一串候选 dict，`dict()` 抛 ValueError 被界面原样显示。
`--selftest` 把同样的坏形状塞回去，确认这些断言真的会红。
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

from mms import orchestrator, workbench_figure  # noqa: E402
from mms.store import SessionStore  # noqa: E402

# 阶段四的节奏停顿只影响观感，自检里关掉。
os.environ.setdefault("MMS_WORKFLOW_DELAY_MS", "0")

# 不匹配任何关键词族：APMCM 那道英文机器人题面的形态。
ENGLISH_PROBLEM = (
    "Optimization of Robot's Performance. The safety of the robot motor is the core of "
    "operation, and the stability of its power output directly affects the safety."
)
KEYWORD_PROBLEM = "预测某城市未来五年的用电需求，并给出区间估计。"
PLAIN_PROBLEM = "一道没有任何关键词的题，只有场景描述。"
PREDICTION_FAMILY = {"梯度提升回归", "SARIMAX 时间序列", "高斯过程回归"}

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


def interrupt_card(events: list[dict]) -> dict:
    for event in events:
        if event["event"] == "interrupt":
            return event["data"] or {}
    return {}


def candidate_names(events: list[dict]) -> list[str]:
    payload = interrupt_card(events).get("payload") or {}
    return [str(item.get("name")) for item in payload.get("candidates") or []]


def phase_status(record: dict) -> dict[int, str]:
    return {int(row["phase"]): str(row["status"]) for row in record["phases"]}


def confirm_flow(store: SessionStore, problem: str) -> tuple[dict, list[dict]]:
    record = store.create("chat-1", "deepseek", "deepseek-flash", problem)
    orchestrator.start(store, record)
    return record, orchestrator.resume(store, record, "confirm", "")


def run_checks(workdir: Path) -> None:
    store = SessionStore(workdir / "en.db")
    record = store.create("chat-1", "deepseek", "deepseek-flash", ENGLISH_PROBLEM)
    started = orchestrator.start(store, record)
    status = phase_status(record)
    card = interrupt_card(started)
    check(
        "K1 起题：阶段一等你确认，挂出赛题确认卡，消息落盘两条",
        status.get(0) == "passed"
        and status.get(1) == "waiting"
        and card.get("card") == "problem-confirm"
        and len(record["messages"]) == 2,
        f"phases={status} card={card.get('card')} messages={len(record['messages'])}",
    )

    confirmed = orchestrator.resume(store, record, "confirm", "")
    names = candidate_names(confirmed)
    check(
        "K2 英文题面（无中文关键词）确认后给出 3 条不同候选（回归）",
        len(names) == 3 and len(set(names)) == 3,
        f"names={names}",
    )

    status = phase_status(record)
    check(
        "K2 阶段二三通过、阶段四等你确认，待决卡换成选模",
        status.get(2) == "passed"
        and status.get(3) == "waiting"
        and (record["pending"] or {}).get("card") == "model-choice",
        f"phases={status} pending={(record['pending'] or {}).get('card')}",
    )

    rerolled = orchestrator.resume(store, record, "reroll", "")
    reroll_names = candidate_names(rerolled)
    check(
        "K3 换一批：batch 递增，仍给 3 条不同候选",
        record["batch"] == 2 and len(reroll_names) == 3 and len(set(reroll_names)) == 3,
        f"batch={record['batch']} names={reroll_names}",
    )

    chosen = orchestrator.resume(store, record, "choose", "c1")
    status = phase_status(record)
    check(
        "K3 选模后阶段四跑完、待决清空",
        status.get(3) == "passed" and status.get(4) == "passed" and record["pending"] is None,
        f"phases={status} pending={record['pending']} events={[e['event'] for e in chosen]}",
    )

    reloaded = SessionStore(workdir / "en.db").get("chat-1")
    check(
        "K3 选择结果已落盘，换个连接读回一致",
        reloaded is not None
        and len(reloaded["messages"]) == len(record["messages"])
        and reloaded["batch"] == 2,
        f"messages={len(reloaded['messages']) if reloaded else None}",
    )

    keyword_store = SessionStore(workdir / "keyword.db")
    _, keyword_events = confirm_flow(keyword_store, KEYWORD_PROBLEM)
    keyword_names = candidate_names(keyword_events)
    check(
        "K4 含关键词的题面走预测方法族",
        set(keyword_names) == PREDICTION_FAMILY,
        f"names={keyword_names}",
    )

    plain_store = SessionStore(workdir / "plain.db")
    _, plain_events = confirm_flow(plain_store, PLAIN_PROBLEM)
    plain_names = candidate_names(plain_events)
    check(
        "K5 无关键词题面回落到默认族，3 条互不相同",
        len(plain_names) == 3 and len(set(plain_names)) == 3,
        f"names={plain_names}",
    )

    pending = plain_store.get("chat-1")
    try:
        orchestrator.resume(plain_store, pending, "confirm", "")
    except ValueError as exc:
        rejected, detail = "当前不是在确认赛题" in str(exc), str(exc)
    else:
        rejected, detail = False, "没有抛错"
    check("K6 卡类型不对的动作被拒绝，不静默通过", rejected, detail)

    workspace = workdir / "workspace"
    attach = workspace / "附件" / "2026-11-01"
    attach.mkdir(parents=True)
    rows = ["x1,x2,y"] + [
        f"{index},{round(index * 0.5, 2)},{round(2.4 * index + 1.2 * index * 0.5 + (index % 3) * 0.1, 3)}"
        for index in range(1, 41)
    ]
    (attach / "sales.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")

    phase_store = SessionStore(workdir / "phase.db")
    phase_record = phase_store.create("chat-phase", "deepseek", "deepseek-flash", ENGLISH_PROBLEM)
    orchestrator.start(phase_store, phase_record)
    orchestrator.resume(phase_store, phase_record, "confirm", "")
    phase_events = orchestrator.resume(phase_store, phase_record, "choose", "c1", str(workspace))
    finished = [
        event
        for event in phase_events
        if event["event"] == "tool_call" and event["data"].get("status") != "running"
    ]
    artifact = [event for event in phase_events if event["event"] == "artifact"]
    figure = workbench_figure.state_payload(data_dir=phase_store.path.parent)
    outputs = (figure.get("versions") or [{}])[-1].get("outputs") or {}
    code_dir = phase_store.path.parent / "workbench" / "code"
    status = phase_status(phase_record)
    summary = str(phase_record["messages"][-1].get("content") or "")
    check(
        "K7 阶段四：五个工具步骤全部落地，工作区的 CSV 被真读进去",
        len(finished) == 5
        and all(event["data"].get("status") == "ok" for event in finished)
        and "sales.csv" in summary
        and "40 行" in summary,
        f"steps={[(e['data']['name'], e['data'].get('status')) for e in finished]} summary={summary[:80]!r}",
    )
    check(
        "K7 阶段四：PNG/PDF/SVG 三件产物登记成图表版本",
        len(artifact) == 1
        and {"png", "pdf", "svg"} <= set(outputs)
        and all(Path(outputs[kind]).is_file() and Path(outputs[kind]).stat().st_size > 0 for kind in outputs),
        f"artifact={bool(artifact)} outputs={sorted(outputs)}",
    )
    check(
        "K7 阶段四：代码与结果落盘，阶段四通过并停在阶段五",
        (code_dir / "solution.py").is_file()
        and (code_dir / "outputs" / "result.json").is_file()
        and status.get(4) == "passed"
        and status.get(5) == "idle"
        and phase_record["pending"] is None,
        f"phases={status} pending={phase_record['pending']}",
    )

    empty = workdir / "empty-workspace"
    empty.mkdir()
    sample_store = SessionStore(workdir / "sample.db")
    sample_record = sample_store.create("chat-sample", "deepseek", "deepseek-flash", PLAIN_PROBLEM)
    orchestrator.start(sample_store, sample_record)
    orchestrator.resume(sample_store, sample_record, "confirm", "")
    sample_events = orchestrator.resume(sample_store, sample_record, "choose", "c1", str(empty))
    sample_figure = workbench_figure.state_payload(data_dir=sample_store.path.parent)
    sample_tools = {
        event["data"]["name"]: event["data"].get("result")
        for event in sample_events
        if event["event"] == "tool_call" and event["data"].get("status") == "ok"
    }
    check(
        "K8 工作区没有数据时用内置示例把链路跑通，并在对话里说明",
        bool((sample_tools.get("定位数据") or {}).get("sample"))
        and bool(sample_figure.get("versions"))
        and "示例数据" in str(sample_record["messages"][-1].get("content") or ""),
        f"locate={sample_tools.get('定位数据')} versions={len(sample_figure.get('versions') or [])}",
    )


def run_self_test() -> int:
    negative: list[tuple[str, bool, str]] = []

    original_family = orchestrator.DEFAULT_FAMILY
    orchestrator.DEFAULT_FAMILY = (original_family,)  # 复现旧 bug：单元素元组
    caught = False
    detail = ""
    workdir = Path(tempfile.mkdtemp(prefix="mms-orchestrator-neg-"))
    try:
        store = SessionStore(workdir / "neg.db")
        record = store.create("chat-neg", "deepseek", "deepseek-flash", ENGLISH_PROBLEM)
        orchestrator.start(store, record)
        orchestrator.resume(store, record, "confirm", "")
    except ValueError as exc:
        caught = "dictionary update sequence element" in str(exc)
        detail = str(exc)
    else:
        detail = "没有抛错"
    finally:
        orchestrator.DEFAULT_FAMILY = original_family
        shutil.rmtree(workdir, ignore_errors=True)
    negative.append(("N1 默认族写成单元素元组时，K2 真的会红", caught, detail))

    original_families = list(orchestrator.FAMILIES)
    orchestrator.FAMILIES[:] = []  # 关键词族被清空后，关键词题面会落到默认族
    caught = False
    detail = ""
    workdir = Path(tempfile.mkdtemp(prefix="mms-orchestrator-neg2-"))
    try:
        store = SessionStore(workdir / "neg.db")
        _, events = confirm_flow(store, KEYWORD_PROBLEM)
        names = candidate_names(events)
        caught = set(names) != PREDICTION_FAMILY
        detail = f"names={names}"
    finally:
        orchestrator.FAMILIES[:] = original_families
        shutil.rmtree(workdir, ignore_errors=True)
    negative.append(("N2 关键词族被清空时，K4 真的会红", caught, detail))

    failed = [row for row in negative if not row[1]]
    for name, ok, detail in negative:
        print(f"{'PASS' if ok else 'FAIL'} {name}\n       {detail}")
    print(f"\n{len(negative) - len(failed)}/{len(negative)} 条反向覆盖通过")
    return 0 if not failed else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return run_self_test()

    workdir = Path(tempfile.mkdtemp(prefix="mms-orchestrator-"))
    try:
        run_checks(workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    failed = [row for row in results if not row[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name}\n       {detail}")
    print(f"\n{len(results) - len(failed)}/{len(results)} 条编排断言通过")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
