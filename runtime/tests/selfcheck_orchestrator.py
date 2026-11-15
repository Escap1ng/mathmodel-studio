"""G11 · 编排状态机自检：起题 → K2 确认 → K3 选模 → 进入阶段四。

不依赖窗口、不联网、不读真实 Key；只用临时目录里的 SQLite。
回归点：英文题面不含中文关键词时走默认方法族，`DEFAULT_FAMILY` 曾写成单元素元组，
`_candidates` 拿到的是一串候选 dict，`dict()` 抛 ValueError 被界面原样显示。
`--selftest` 把同样的坏形状塞回去，确认这些断言真的会红。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from checklib import ROOT, check, report

from mms import llm, orchestrator, paper_build, workbench_figure  # noqa: E402
from mms.store import SessionStore  # noqa: E402

# 阶段四的节奏停顿只影响观感，自检里关掉。
os.environ.setdefault("MMS_WORKFLOW_DELAY_MS", "0")

# 与 G10 同一约定：没有 TeX 的环境显式 MMS_PAPER_SKIP=1 跳过阶段五六断言，
# 跳过打印「未验证」，不当成通过。
PAPER_SKIP = os.environ.get("MMS_PAPER_SKIP") == "1"
FULL_CHAIN = paper_build.env_status()["ok"] and not PAPER_SKIP

# 不匹配任何关键词族：APMCM 那道英文机器人题面的形态。
ENGLISH_PROBLEM = (
    "Optimization of Robot's Performance. The safety of the robot motor is the core of "
    "operation, and the stability of its power output directly affects the safety."
)
KEYWORD_PROBLEM = "预测某城市未来五年的用电需求，并给出区间估计。"
PLAIN_PROBLEM = "一道没有任何关键词的题，只有场景描述。"
PREDICTION_FAMILY = {"梯度提升回归", "SARIMAX 时间序列", "高斯过程回归"}

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
        "K3 选模后挂出代码确认卡，脚本未执行（执行严格在确认之后）",
        status.get(3) == "passed"
        and status.get(4) == "running"
        and (record["pending"] or {}).get("card") == "code-confirm",
        f"phases={status} pending={(record['pending'] or {}).get('card')} events={[e['event'] for e in chosen]}",
    )
    chosen = orchestrator.resume(store, record, "run", "")
    status = phase_status(record)
    if FULL_CHAIN:
        check(
            "K3 点运行后阶段四五六全链跑完（离线兜底）、待决清空",
            status.get(4) == "passed"
            and status.get(5) == "passed"
            and status.get(6) == "passed"
            and record["pending"] is None,
            f"phases={status} pending={record['pending']} events={[e['event'] for e in chosen]}",
        )
    else:
        print("SKIP 缺少排版工具或 MMS_PAPER_SKIP=1：K3/K7/L9–L14 只验到阶段四（未验证阶段五六）")
        check(
            "K3 点运行后阶段四跑完、待决清空（排版跳过，未验证阶段五六）",
            status.get(4) == "passed" and record["pending"] is None,
            f"phases={status} pending={record['pending']}",
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
    choose_events = orchestrator.resume(phase_store, phase_record, "choose", "c1", str(workspace))
    run_events = orchestrator.resume(phase_store, phase_record, "run", "", str(workspace))
    phase_events = choose_events + run_events
    # 阶段五/六的工具卡以 p5-/p6- 开头；这里只统计阶段四的五个步骤。
    finished = [
        event
        for event in phase_events
        if event["event"] == "tool_call"
        and event["data"].get("status") != "running"
        and not str(event["data"].get("id") or "").startswith(("p5-", "p6-"))
    ]
    artifact = [
        event
        for event in phase_events
        if event["event"] == "artifact" and event["data"].get("kind") == "figure"
    ]
    figure = workbench_figure.state_payload(data_dir=phase_store.path.parent)
    outputs = (figure.get("versions") or [{}])[-1].get("outputs") or {}
    code_dir = phase_store.path.parent / "workbench" / "code"
    status = phase_status(phase_record)
    summary = "\n".join(str(m.get("content") or "") for m in phase_record["messages"])
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
        "K7 阶段四：代码与结果落盘，阶段四通过" + ("、五六全链完成" if FULL_CHAIN else "（排版跳过）"),
        (code_dir / "solution.py").is_file()
        and (code_dir / "outputs" / "result.json").is_file()
        and status.get(4) == "passed"
        and (status.get(5) == "passed" and status.get(6) == "passed" if FULL_CHAIN else True)
        and phase_record["pending"] is None,
        f"phases={status} pending={phase_record['pending']}",
    )

    empty = workdir / "empty-workspace"
    empty.mkdir()
    sample_store = SessionStore(workdir / "sample.db")
    sample_record = sample_store.create("chat-sample", "deepseek", "deepseek-flash", PLAIN_PROBLEM)
    orchestrator.start(sample_store, sample_record)
    orchestrator.resume(sample_store, sample_record, "confirm", "")
    sample_choose = orchestrator.resume(sample_store, sample_record, "choose", "c1", str(empty))
    sample_events = sample_choose + orchestrator.resume(sample_store, sample_record, "run", "", str(empty))
    sample_figure = workbench_figure.state_payload(data_dir=sample_store.path.parent)
    sample_tools = {
        event["data"]["name"]: event["data"].get("result")
        for event in sample_events
        if event["event"] == "tool_call" and event["data"].get("status") == "ok"
    }
    sample_text = "\n".join(str(m.get("content") or "") for m in sample_record["messages"])
    check(
        "K8 工作区没有数据时用内置示例把链路跑通，并在对话里说明",
        bool((sample_tools.get("定位数据") or {}).get("sample"))
        and bool(sample_figure.get("versions"))
        and "示例数据" in sample_text,
        f"locate={sample_tools.get('定位数据')} versions={len(sample_figure.get('versions') or [])}",
    )


def run_llm_checks(workdir: Path) -> None:
    """LLM 注入层：fake 按阶段路由、坏输出重试与回退、选模落盘。"""
    fake = {"id": "fake", "base_url": "", "tool_calling": True}

    store = SessionStore(workdir / "llm.db")
    record = store.create("aabbccdd11", "fake", "fake-stream", KEYWORD_PROBLEM)
    orchestrator.start(store, record, provider=fake)
    card = (record["pending"] or {}).get("payload") or {}
    check(
        "L1 fake 起题：K2 卡由阶段脚本生成，子问题非空且标明离线演示",
        bool(card.get("questions")) and "离线演示" in str(card.get("warning") or ""),
        f"questions={len(card.get('questions') or [])} warning={str(card.get('warning'))[:40]!r}",
    )

    events = orchestrator.resume(store, record, "confirm", "", provider=fake)
    names = candidate_names(events)
    check(
        "L2 fake 确认后 K3 候选与确定性方法族同源（离线不冒充模型判断）",
        set(names) == PREDICTION_FAMILY,
        f"names={names}",
    )

    orchestrator.resume(store, record, "choose", "c1", provider=fake)
    orchestrator.resume(store, record, "run", "", provider=fake)
    reloaded = SessionStore(workdir / "llm.db").get("aabbccdd11")
    check(
        "L3 选模结果落盘：picked 列跨连接可读，阶段四按所选继续",
        reloaded is not None
        and (reloaded.get("picked") or {}).get("name") == names[0]
        and phase_status(reloaded).get(4) == "passed",
        f"picked={(reloaded or {}).get('picked')}",
    )

    # 坏 JSON：第一次回喂重试，第二次合法 → 成功
    calls = {"n": 0}

    def flaky_complete(provider, api_key, model, messages, should_stop=None, on_delta=None, depth=""):
        calls["n"] += 1
        if calls["n"] == 1:
            return "这不是 JSON"
        return json.dumps(
            {
                "questions": [{"id": "q1", "text": "子问题一", "data": "未附数据文件"}],
                "dataRoles": [],
                "warning": "测试提醒",
            },
            ensure_ascii=False,
        )

    original_complete = llm.complete
    llm.complete = flaky_complete
    try:
        payload = orchestrator._problem_payload_llm("题面", fake, "", "m")
        check(
            "L4 坏 JSON 回喂重试一次后成功，重试真的发生",
            calls["n"] == 2 and payload["questions"][0]["text"] == "子问题一",
            f"calls={calls['n']} payload={str(payload)[:60]}",
        )

        calls["n"] = 0

        def always_bad(provider, api_key, model, messages, should_stop=None, on_delta=None, depth=""):
            calls["n"] += 1
            return "还是坏输出"

        llm.complete = always_bad
        payload = orchestrator._problem_payload_llm("题面", fake, "", "m")
        check(
            "L5 两次都坏时回退确定性切分，并在警告里标明兜底",
            calls["n"] == 2
            and bool(payload.get("questions"))
            and "回退" in str(payload.get("warning") or ""),
            f"calls={calls['n']} warning={str(payload.get('warning'))[:60]!r}",
        )

        candidates_payload = orchestrator._model_payload_llm("预测销量", 1, fake, "", "m")
        check(
            "L6 K3 模型不可用时回退内置方法族并标明兜底",
            len(candidates_payload.get("candidates") or []) == 3
            and "兜底" in str(candidates_payload.get("intro") or ""),
            f"intro={str(candidates_payload.get('intro'))[:40]!r}",
        )
    finally:
        llm.complete = original_complete

    # 校验器：缺推荐、缺创新高项、数量不对都必须拒绝
    def candidate(**over):
        base = {
            "name": "方法", "idea": "思路", "innovation": "中", "interpretability": "中",
            "difficulty": "中", "eta": "1–2 小时", "accuracy": "中",
            "math": "公式", "fit": "适配", "diff": "差异", "verify": "验证",
            "recommended": False, "reason": "",
        }
        base.update(over)
        return base

    good = [candidate(recommended=True), candidate(), candidate(innovation="高")]
    try:
        orchestrator._validate_candidates({"candidates": good})
        ok_good = True
    except ValueError:
        ok_good = False
    rejected = 0
    for bad in (
        {"candidates": good[:2]},
        {"candidates": [candidate(), candidate(), candidate(innovation="高")]},
        {"candidates": [candidate(recommended=True), candidate(recommended=True), candidate(innovation="高")]},
    ):
        try:
            orchestrator._validate_candidates(bad)
        except ValueError:
            rejected += 1
    check(
        "L7 候选校验：合法形状通过；缺项/无推荐/无高创新都被拒",
        ok_good and rejected == 3,
        f"ok_good={ok_good} rejected={rejected}/3",
    )

    check(
        "L8 阶段标记识别与围栏剥离",
        llm.stage_of([{"role": "system", "content": llm.stage_prompt("k2-problem", "指令")}]) == "k2-problem"
        and llm.stage_of([{"role": "system", "content": "普通聊天"}]) == ""
        and llm.parse_json('```json\n{"a": 1}\n```') == {"a": 1},
        "stage_of / parse_json",
    )

    # L9 代码确认卡：choose 后脚本未执行；run 动作只在 code-confirm 上有效
    cstore = SessionStore(workdir / "code.db")
    crecord = cstore.create("ccddeeff22", "fake", "fake-stream", PLAIN_PROBLEM)
    orchestrator.start(cstore, crecord)
    orchestrator.resume(cstore, crecord, "confirm", "")
    choose_events = orchestrator.resume(cstore, crecord, "choose", "c1")
    cpayload = (crecord["pending"] or {}).get("payload") or {}
    crun_called = {"n": 0}
    original_run = orchestrator.baseline.run_baseline

    def counting_run(*args, **kwargs):
        crun_called["n"] += 1
        return original_run(*args, **kwargs)

    orchestrator.baseline.run_baseline = counting_run
    try:
        check(
            "L9 代码卡带代码与轮次，choose 全程没有执行脚本",
            (crecord["pending"] or {}).get("card") == "code-confirm"
            and bool(cpayload.get("code"))
            and cpayload.get("round") == 1
            and crun_called["n"] == 0
            and any(e["event"] == "interrupt" for e in choose_events),
            f"card={(crecord['pending'] or {}).get('card')} round={cpayload.get('round')} runs={crun_called['n']}",
        )
        try:
            orchestrator.resume(cstore, crecord, "confirm", "")
            guard_ok = False
        except ValueError as exc:
            guard_ok = "确认赛题" in str(exc)
        check("L9 代码卡上点确认被拒绝，不静默通过", guard_ok, "action guard")
        orchestrator.resume(cstore, crecord, "run", "")
        check(
            "L9 点运行才执行，产物登记、阶段四通过" + ("、全链完成" if FULL_CHAIN else "（排版跳过）"),
            crun_called["n"] == 1
            and phase_status(crecord).get(4) == "passed"
            and (phase_status(crecord).get(5) == "passed" and phase_status(crecord).get(6) == "passed" if FULL_CHAIN else True)
            and crecord["pending"] is None,
            f"runs={crun_called['n']} phases={phase_status(crecord)}",
        )
    finally:
        orchestrator.baseline.run_baseline = original_run

    # L10 运行失败 → 回喂修复：第二轮真跑成功；无模型时直接失败
    BAD_CODE = (
        "import argparse\n"
        "parser = argparse.ArgumentParser()\n"
        "parser.add_argument('--data')\n"
        "parser.add_argument('--out')\n"
        "args = parser.parse_args()\n"
        "raise RuntimeError('故意失败：测试修复环')\n"
        "# result.json figure.png\n"
    )
    fstore = SessionStore(workdir / "fix.db")
    frecord = fstore.create("ddeeff3344", "fake", "fake-stream", PLAIN_PROBLEM)
    orchestrator.start(fstore, frecord)
    orchestrator.resume(fstore, frecord, "confirm", "")
    orchestrator.resume(fstore, frecord, "choose", "c1")
    fcard = frecord["pending"]["payload"]
    fcard["code"] = BAD_CODE
    Path(fcard["scriptPath"]).write_text(BAD_CODE, encoding="utf-8")
    fstore.put(frecord)
    fix_events = orchestrator.resume(fstore, frecord, "run", "", provider=fake)
    fix_card = (frecord["pending"] or {}).get("payload") or {}
    check(
        "L10 第一轮失败后回喂模型，第二轮代码卡出现且未自动执行",
        (frecord["pending"] or {}).get("card") == "code-confirm"
        and fix_card.get("round") == 2
        and phase_status(frecord).get(4) == "running",
        f"round={fix_card.get('round')} phases={phase_status(frecord)}",
    )
    orchestrator.resume(fstore, frecord, "run", "", provider=fake)
    check(
        "L10 第二轮（fake 返回基线脚本）运行成功" + ("，全链完成" if FULL_CHAIN else "（排版跳过）"),
        phase_status(frecord).get(4) == "passed"
        and (phase_status(frecord).get(5) == "passed" and phase_status(frecord).get(6) == "passed" if FULL_CHAIN else True)
        and frecord["pending"] is None,
        f"phases={phase_status(frecord)}",
    )

    nstore = SessionStore(workdir / "nofix.db")
    nrecord = nstore.create("eeff445566", "fake", "fake-stream", PLAIN_PROBLEM)
    orchestrator.start(nstore, nrecord)
    orchestrator.resume(nstore, nrecord, "confirm", "")
    orchestrator.resume(nstore, nrecord, "choose", "c1")
    ncard = nrecord["pending"]["payload"]
    ncard["code"] = BAD_CODE
    Path(ncard["scriptPath"]).write_text(BAD_CODE, encoding="utf-8")
    nstore.put(nrecord)
    orchestrator.resume(nstore, nrecord, "run", "")
    ntext = str(nrecord["messages"][-1].get("content") or "")
    check(
        "L10 没有可用模型时运行失败直接终止，不假装修复",
        phase_status(nrecord).get(4) == "failed"
        and nrecord["pending"] is None
        and "没有可用模型" in ntext,
        f"phases={phase_status(nrecord)} text={ntext[:60]!r}",
    )

def run_paper_checks(workdir: Path) -> None:
    """L11–L14：阶段五六全链（论文真排版、真实评分、否决）。需要 TeX，仅在排版可用时跑。"""
    fake = {"id": "fake", "base_url": "", "tool_calling": True}
    # L11 阶段五：fake 兜底样例稿真排版，产物落盘、门禁事件齐全、兜底有标注
    pstore = SessionStore(workdir / "paper.db")
    precord = pstore.create("ff5566778899", "fake", "fake-stream", PLAIN_PROBLEM)
    orchestrator.start(pstore, precord, provider=fake)
    orchestrator.resume(pstore, precord, "confirm", "", provider=fake)
    orchestrator.resume(pstore, precord, "choose", "c1", provider=fake)
    p5_events = orchestrator.resume(pstore, precord, "run", "", provider=fake)
    p5_status = phase_status(precord)
    paper_dir = pstore.path.parent / "sessions" / "ff5566778899" / "workbench" / "paper"
    gate_events = [e for e in p5_events if e["event"] == "gate"]
    paper_artifact = [e for e in p5_events if e["event"] == "artifact" and e["data"].get("kind") == "paper"]
    all_text = "\n".join(str(m.get("content") or "") for m in precord["messages"])
    gate_ids = {e["data"].get("skill") for e in gate_events}
    check(
        "L11 阶段五自动完成：PDF/DOCX 落盘、三类门禁全绿、paper 产物事件",
        p5_status.get(5) == "passed"
        and (paper_dir / "paper.pdf").is_file()
        and (paper_dir / "paper.docx").is_file()
        and gate_ids == {"phrasing", "style", "chapters"}
        and all(e["data"].get("ok") for e in gate_events)
        and len(paper_artifact) == 1,
        f"phases={p5_status} gates={sorted(gate_ids)} artifact={len(paper_artifact)}",
    )
    check(
        "L11 离线兜底论文明确标注，不冒充按本题生成",
        "兜底" in all_text and "样例稿" in all_text,
        f"text={all_text[-120:]!r}",
    )

    # L12 阶段六：评分卡落盘、按会话读真实轮次、达标判定
    from mms import score_gen, workbench_score

    p6_status = phase_status(precord)
    score_file = pstore.path.parent / "sessions" / "ff5566778899" / "workbench" / "score" / "round-1.json"
    real_state = workbench_score.state(data_dir=pstore.path.parent / "sessions" / "ff5566778899")
    real_rounds = real_state.get("rounds") or []
    p6_text = "\n".join(str(m.get("content") or "") for m in precord["messages"])
    last_round = real_rounds[-1] if real_rounds else {}
    check(
        "L12 阶段六完成：评分卡落盘、工作台读到真实轮次、末轮达标",
        p6_status.get(6) == "passed"
        and score_file.is_file()
        and len(real_rounds) >= 1
        and last_round.get("total") == 86
        and bool(last_round.get("pass"))
        and "86" in p6_text,
        f"phases={p6_status} rounds={len(real_rounds)} total={last_round.get('total')}",
    )
    check(
        "L12 离线兜底评分明确标注，不冒充真实评审",
        "评分暂用演示评分卡兜底" in p6_text,
        f"text={p6_text[-100:]!r}",
    )

    # L13 评分校验器：合法卡通过；缺维度/超分/重复都被拒
    good_card = score_gen.demo_card(1)
    try:
        score_gen._validate_card(good_card)
        ok_card = True
    except ValueError:
        ok_card = False
    rejected = 0
    bad_cards = [
        {"dimensions": good_card["dimensions"][:4]},
        {"dimensions": [dict(d, score=999) if d["id"] == "abstract" else d for d in good_card["dimensions"]]},
        {"dimensions": good_card["dimensions"] + [good_card["dimensions"][0]]},
    ]
    for bad in bad_cards:
        try:
            score_gen._validate_card(bad)
        except ValueError:
            rejected += 1
    check(
        "L13 评分卡校验：合法通过；缺维度/超分/重复都拒",
        ok_card and rejected == 3,
        f"ok={ok_card} rejected={rejected}/3",
    )

    # L14 一票否决：veto 卡直接淘汰，阶段六判 failed，不进优化循环
    vstore = SessionStore(workdir / "veto.db")
    vrecord = vstore.create("aa9988776655", "fake", "fake-stream", PLAIN_PROBLEM)
    orchestrator.start(vstore, vrecord, provider=fake)
    orchestrator.resume(vstore, vrecord, "confirm", "", provider=fake)
    orchestrator.resume(vstore, vrecord, "choose", "c1", provider=fake)
    original_demo = score_gen.demo_card

    def veto_card(round_no=1):
        card = original_demo(round_no)
        card["veto"] = True
        return card

    score_gen.demo_card = veto_card
    try:
        orchestrator.resume(vstore, vrecord, "run", "", provider=fake)
    finally:
        score_gen.demo_card = original_demo
    vstatus = phase_status(vrecord)
    vtext = "\n".join(str(m.get("content") or "") for m in vrecord["messages"])
    check(
        "L14 一票否决直接淘汰：阶段六 failed、不进优化循环",
        vstatus.get(6) == "failed"
        and "一票否决" in vtext
        and vstatus.get(5) == "passed",
        f"phases={vstatus} text={vtext[-80:]!r}",
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
        run_llm_checks(workdir)
        if FULL_CHAIN:
            run_paper_checks(workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return report("编排断言通过")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
