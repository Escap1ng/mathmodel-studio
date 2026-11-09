"""G12 · 长会话 harness 自检：预算、压缩、摘要、锚点、溢出识别。

纯逻辑，不联网、不启动窗口；50 轮会话用滚动调用 prepare 模拟。
`--selftest` 把压缩拆掉，确认这些断言真的会红。
"""

from __future__ import annotations

import sys
from pathlib import Path

from checklib import ROOT, check, report

from mms import harness  # noqa: E402


def session_messages(turns: int, size: int = 400) -> list[dict]:
    rows = [{"role": "system", "content": "你是 mathmodel-studio 的建模助手。"}]
    for index in range(turns):
        rows.append({"role": "user", "content": f"第 {index + 1} 问：" + "数" * size})
        rows.append({"role": "assistant", "content": f"第 {index + 1} 答：" + "据" * size})
    return rows


def tool_messages(count: int, size: int = 5000) -> list[dict]:
    rows = [{"role": "system", "content": "系统提示"}]
    rows.append({"role": "user", "content": "跑一遍模板清单"})
    rows.append(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "list_templates", "arguments": "{}"}}],
        }
    )
    for index in range(count):
        rows.append(
            {
                "role": "tool",
                "tool_call_id": f"c{index}",
                "name": f"tool_{index}",
                "content": "结果" + "x" * size,
            }
        )
    return rows


def run_checks() -> None:
    base = session_messages(3, size=20)
    plan = harness.prepare(base, None)
    check(
        "H1 没有预算时不动历史，只按需插锚点",
        [m["content"] for m in plan.messages] == [m["content"] for m in base] and plan.reason == "",
        f"messages={len(plan.messages)} reason={plan.reason}",
    )

    rows = tool_messages(6)
    plan = harness.prepare(rows, 12_000)
    tool_lens = [len(str(m.get("content") or "")) for m in plan.messages if m.get("role") == "tool"]
    check(
        "H2 超预算时先裁剪旧工具结果（保留头尾，最近两条不动）",
        plan.pruned >= 1 and any(harness.PRUNE_MARK.strip() in str(m.get("content")) for m in plan.messages),
        f"pruned={plan.pruned} tool_lens={tool_lens} after={plan.after}",
    )
    check(
        "H2 裁剪后仍然不超过预算比例",
        plan.after <= 12_000 * harness.COMPACT_RATIO,
        f"after={plan.after} limit={int(12_000 * harness.COMPACT_RATIO)}",
    )

    rows = session_messages(6, size=600)
    plan = harness.prepare(rows, 8_000)
    summary = plan.summary
    check(
        "H3 仍然超预算时把较早轮次压成结构化摘要",
        plan.summarized > 0 and summary.startswith(harness.SUMMARY_MARK),
        f"summarized={plan.summarized} summary={summary[:80]!r}",
    )
    check(
        "H3 摘要里保留用户与助手要点",
        "用户：" in summary and "助手：" in summary,
        summary[:160],
    )

    older = harness.prepare(session_messages(6, size=600), 8_000).messages
    again = harness.prepare(older, 4_000)
    check(
        "H3 二次压缩把旧摘要整段并入，不层层变薄",
        again.summary.count(harness.SUMMARY_MARK) == 1 and "第 1 问" in again.summary,
        f"summary={again.summary[:120]!r}",
    )

    anchored = harness.prepare(base, None, anchor=harness.anchor_text("预测销量", 2, ["工作区：D:/题"]))
    anchors = [m for m in anchored.messages if harness.is_anchor(m)]
    check(
        "H4 锚点插在系统提示之后，且只有一条",
        len(anchors) == 1 and harness.is_anchor(anchored.messages[1]) and "预测销量" in anchors[0]["content"],
        f"at={0 if harness.is_anchor(anchored.messages[0]) else 1} count={len(anchors)}",
    )
    replaced = harness.prepare(anchored.messages, None, anchor=harness.anchor_text("识别故障", 9))
    anchors = [m for m in replaced.messages if harness.is_anchor(m)]
    check(
        "H4 下一轮锚点被替换而不是累加",
        len(anchors) == 1 and "识别故障" in anchors[0]["content"] and "预测销量" not in anchors[0]["content"],
        f"count={len(anchors)} text={anchors[0]['content'][:60]!r}",
    )

    check(
        "H5 能认出常见的上下文溢出报错",
        harness.looks_like_overflow("Error code: 400 - context_length_exceeded")
        and harness.looks_like_overflow("This model's maximum context length is 65536 tokens")
        and not harness.looks_like_overflow("429 rate limit"),
        "markers",
    )

    huge = [
        {"role": "system", "content": "你是 mathmodel-studio 的建模助手。"},
        {"role": "user", "content": "数" * 8000 + "甲"},
        {"role": "assistant", "content": "数" * 8000 + "乙"},
        {"role": "user", "content": "最新问题"},
    ]
    plan = harness.prepare(huge, 5_000, anchor=harness.anchor_text("大消息", 3))
    check(
        "H8 单条就超预算时从最早处丢，锚点与最新一问保留",
        plan.dropped >= 1
        and plan.messages[-1]["content"] == "最新问题"
        and harness.is_anchor(plan.messages[1])
        and all(len(str(m.get("content") or "")) < 8_000 for m in plan.messages),
        f"dropped={plan.dropped} after={plan.after} roles={[m['role'] for m in plan.messages]}",
    )

    rows = session_messages(50, size=400)
    plan = harness.prepare(rows, 20_000)
    tail = [str(m.get("content") or "") for m in plan.messages[-6:]]
    expected_tail = [str(m.get("content") or "") for m in rows[-6:]]
    check(
        "H6 50 轮压到预算内，最近 6 条原文保留",
        plan.after <= 20_000 * harness.COMPACT_RATIO and tail == expected_tail,
        f"after={plan.after} kept={len(plan.messages)}",
    )
    check(
        "H6 压缩后第一条仍是系统提示",
        plan.messages[0].get("role") == "system" and plan.messages[0]["content"].startswith("你是"),
        plan.messages[0].get("content", "")[:40],
    )

    rolling = [{"role": "system", "content": "你是 mathmodel-studio 的建模助手。"}]
    peak = 0
    for index in range(50):
        rolling.append({"role": "user", "content": f"第 {index + 1} 问：" + "数" * 400})
        rolling = harness.prepare(
            rolling, 30_000, anchor=harness.anchor_text("一道 50 轮的题", index + 1)
        ).messages
        rolling.append({"role": "assistant", "content": f"第 {index + 1} 答：" + "据" * 400})
        peak = max(peak, harness.usage(rolling))
    anchors = [m for m in rolling if harness.is_anchor(m)]
    check(
        "H7 滚动 50 轮始终不超预算，消息数有界",
        peak <= 30_000 and len(rolling) <= 30,
        f"peak={peak} messages={len(rolling)}",
    )
    check(
        "H7 长会话里锚点仍只有一条且指向当前轮",
        len(anchors) == 1 and "已进行 50 轮" in anchors[0]["content"],
        anchors[0]["content"][:60] if anchors else "（没有锚点）",
    )


def run_self_test() -> int:
    negative: list[tuple[str, bool, str]] = []

    original_prepare = harness.prepare
    harness.prepare = lambda messages, budget=None, **kwargs: harness.Plan(
        messages=list(messages),
        before=harness.usage(messages),
        after=harness.usage(messages),
    )
    try:
        rows = session_messages(50, size=400)
        plan = harness.prepare(rows, 20_000)
        caught = plan.after > 20_000 * harness.COMPACT_RATIO
        detail = f"after={plan.after} limit={int(20_000 * harness.COMPACT_RATIO)}"
    finally:
        harness.prepare = original_prepare
    negative.append(("N1 压缩被拆掉时，H6 的预算断言真的会红", caught, detail))

    original_prune = harness._prune_tool_results
    harness._prune_tool_results = lambda messages, protect_tail=2: (list(messages), 0)
    try:
        rows = tool_messages(6)
        plan = harness.prepare(rows, 12_000)
        caught = plan.pruned == 0 or not any(
            harness.PRUNE_MARK.strip() in str(m.get("content")) for m in plan.messages
        )
        detail = f"pruned={plan.pruned}"
    finally:
        harness._prune_tool_results = original_prune
    negative.append(("N2 工具结果裁剪被关掉时，H2 真的会红", caught, detail))

    failed = [row for row in negative if not row[1]]
    for name, ok, detail in negative:
        print(f"{'PASS' if ok else 'FAIL'} {name}\n       {detail}")
    print(f"\n{len(negative) - len(failed)}/{len(negative)} 条反向覆盖通过")
    return 0 if not failed else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return run_self_test()
    run_checks()
    return report("harness 断言通过")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
