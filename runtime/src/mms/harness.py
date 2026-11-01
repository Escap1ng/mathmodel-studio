"""会话上下文策略：预算核算、工具结果裁剪、结构化摘要、目标锚点。

参照 DeepSeek Harness 的分层：这些能力挂在 Agent Loop 之外，按需调用。
压缩顺序是「先无模型裁剪工具结果 → 再把较早的轮次压成结构化摘要 → 最近几轮保留原文」，
每次压缩都由 server 记成 compaction 事件交给界面显示，可回看。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

COMPACT_RATIO = 0.70  # 到预算的这个比例开始压缩
OVERFLOW_RATIO = 0.45  # provider 报上下文溢出后，用更狠的预算重试一次
KEEP_RECENT = 6  # 最近几条消息保留原文
PRUNE_HEAD = 400
PRUNE_TAIL = 200
PRUNE_MARK = "\n…[工具结果已裁剪]…\n"
SUMMARY_MARK = "【较早对话摘要】"
ANCHOR_MARK = "【会话状态】"
SUMMARY_ITEM = 120
MAX_SUMMARY_ITEMS = 12
MAX_SUMMARY_CHARS = 1600
OVERFLOW_MARKERS = (
    "context length",
    "context_length",
    "maximum context",
    "too many tokens",
    "reduce the length",
    "context window",
    "input is too long",
    "prompt is too long",
)


def estimate_tokens(text: str) -> int:
    """粗估 token：CJK 按 1 字 1 token，其余按 3.5 字符 1 token。

    只用于上下文预算与「已用」显示，不追求与任何分词器逐 token 对齐；
    宁可高估，避免把超出窗口的历史送出去。
    """
    cjk = 0
    for ch in text:
        code = ord(ch)
        if 0x2E80 <= code <= 0x9FFF or 0x3000 <= code <= 0x303F or 0xFF00 <= code <= 0xFFEF:
            cjk += 1
    other = max(0, len(text) - cjk)
    return int(cjk + other / 3.5 + 0.999)


def message_tokens(message: dict) -> int:
    cost = estimate_tokens(str(message.get("content") or ""))
    calls = message.get("tool_calls")
    if calls:
        cost += estimate_tokens(json.dumps(calls, ensure_ascii=False))
    return cost


def usage(messages: list[dict]) -> int:
    return sum(message_tokens(message) for message in messages)


def is_anchor(message: dict) -> bool:
    return message.get("role") == "system" and str(message.get("content") or "").startswith(ANCHOR_MARK)


def anchor_text(goal: str, turn: int, extra: list[str] | None = None) -> str:
    """每轮重写的一行状态头：会话目标、轮次、工作区等，防止长会话跑偏。"""
    lines = [f"{ANCHOR_MARK}目标：{goal or '未命名'}；已进行 {turn} 轮。"]
    for item in extra or []:
        text = str(item or "").strip()
        if text:
            lines.append(f"- {text}")
    return "\n".join(lines)


def looks_like_overflow(text: str) -> bool:
    lowered = (text or "").lower()
    return any(marker in lowered for marker in OVERFLOW_MARKERS)


@dataclass
class Plan:
    messages: list[dict]
    before: int
    after: int
    pruned: int = 0
    summarized: int = 0
    dropped: int = 0
    reason: str = ""
    summary: str = ""

    def event(self) -> dict:
        return {
            "reason": self.reason,
            "before": self.before,
            "after": self.after,
            "pruned": self.pruned,
            "summarized": self.summarized,
            "dropped": self.dropped,
            "summary": self.summary,
        }


def _prune_tool_results(messages: list[dict], protect_tail: int = 2) -> tuple[list[dict], int]:
    positions = [index for index, message in enumerate(messages) if message.get("role") == "tool"]
    protected = set(positions[-protect_tail:]) if protect_tail else set()
    out: list[dict] = []
    pruned = 0
    for index, message in enumerate(messages):
        if message.get("role") == "tool" and index not in protected:
            text = str(message.get("content") or "")
            if len(text) > PRUNE_HEAD + PRUNE_TAIL + len(PRUNE_MARK):
                message = {**message, "content": text[:PRUNE_HEAD] + PRUNE_MARK + text[-PRUNE_TAIL:]}
                pruned += 1
        out.append(message)
    return out, pruned


def _summarize(items: list[dict]) -> str:
    """规则摘要：只留开头与最近的少数几条，总长度有上限。

    摘要本身必须比原文小一个量级，否则「压完还超预算」会无限逼近窗口。
    多轮压缩时旧摘要的条目会被并入，但同样受条数与字数限制。
    """
    header = f"{SUMMARY_MARK}（{len(items)} 条较早消息已压缩）"
    chosen = items if len(items) <= MAX_SUMMARY_ITEMS else items[:2] + items[-8:]
    skipped = len(items) - len(chosen)
    lines: list[str] = []
    if skipped > 0:
        lines.append(f"- …中间 {skipped} 条已省略")
    for message in chosen:
        role = message.get("role")
        raw = str(message.get("content") or "")
        if raw.lstrip().startswith(SUMMARY_MARK):
            body = raw[raw.index(SUMMARY_MARK) + len(SUMMARY_MARK) :]
            merged = [line.strip() for line in body.splitlines() if line.strip().startswith("-")]
            lines.extend(merged[:6])
            continue
        content = " ".join(raw.split())
        if role == "tool":
            name = message.get("name") or "工具"
            lines.append(f"- {name}：{content[:SUMMARY_ITEM]}")
            continue
        if role in ("user", "assistant"):
            label = "用户" if role == "user" else "助手"
            if not content:
                calls = message.get("tool_calls") or []
                names = [str((call.get("function") or {}).get("name") or "") for call in calls]
                content = "调用工具：" + "、".join(name for name in names if name)
            lines.append(f"- {label}：{content[:SUMMARY_ITEM]}")
    text = header + "\n" + "\n".join(lines)
    if len(text) > MAX_SUMMARY_CHARS:
        text = text[: MAX_SUMMARY_CHARS - 20] + "\n…[摘要已截断]"
    return text


def prepare(
    messages: list[dict],
    budget: int | None = None,
    *,
    anchor: str = "",
    ratio: float = COMPACT_RATIO,
    keep_recent: int = KEEP_RECENT,
    reason: str = "auto",
) -> Plan:
    """按预算整理一次上下文；没到阈值时只替换锚点，不动历史。"""
    base = [message for message in messages if not is_anchor(message)]
    head = [base[0]] if base and base[0].get("role") == "system" else []
    body = base[len(head) :]
    before = usage(messages)

    def assemble(rows: list[dict]) -> list[dict]:
        anchor_rows = [{"role": "system", "content": anchor}] if anchor else []
        return head + anchor_rows + rows

    current = body
    pruned = summarized = dropped = 0
    summary_text = ""
    changed = ""
    if budget and budget > 0:
        limit = budget * ratio
        if usage(assemble(current)) > limit:
            current, pruned = _prune_tool_results(current)
            if pruned:
                changed = "tools"
        while usage(assemble(current)) > limit and len(current) > max(2, keep_recent):
            cut = max(1, len(current) - keep_recent)
            older, recent = current[:cut], current[cut:]
            summary_text = _summarize(older)
            merged = [{"role": "system", "content": summary_text}] + recent
            # 只剩摘要本身可压时长度不再变化，再循环也不会更短，直接收手。
            if len(merged) >= len(current):
                break
            current = merged
            summarized += cut
            changed = "summary"
        # 最后手段：摘要后仍超预算（历史很短但单条很大）就从最早处丢；
        # 开头不能是 assistant / tool，最后一条用户消息永远保留。
        while usage(assemble(current)) > limit and len(current) > 1:
            first = current.pop(0)
            dropped += 1
            if first.get("tool_calls"):
                while current and current[0].get("role") == "tool":
                    current.pop(0)
                    dropped += 1
        while len(current) > 1 and current[0].get("role") not in ("user", "system"):
            current.pop(0)
            dropped += 1
        if dropped:
            changed = "trim"

    result = assemble(current)
    return Plan(
        messages=result,
        before=before,
        after=usage(result),
        pruned=pruned,
        summarized=summarized,
        dropped=dropped,
        reason=changed if reason else changed,
        summary=summary_text,
    )
