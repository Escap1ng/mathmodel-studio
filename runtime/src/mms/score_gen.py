"""阶段六 · 真实评分：LLM 按 rubric 评审论文 → score_card.py 校验渲染。

评分卡是数据：维度固定五项（摘要 30 / 模型 20 / 创新 20 / 写作 15 / 排版 15），
扣分必须带正文定位与改法。总分 ≥85 且无一票否决才算达标；
一票否决（身份信息/页眉等红线）直接淘汰、不进优化循环。

离线兜底：没有可用模型时用演示评分卡，调用方必须标明是兜底。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from . import llm
from .registry import repo_root

P6_INSTRUCTION = (
    "你是数学建模竞赛的论文评审专家。按评分口径对给定论文逐项评分，"
    "只输出一个 JSON 对象，不要围栏、不要解释，形状："
    '{"paper":"论文题目","round":1,"veto":false,"dimensions":['
    '{"id":"abstract","score":24,"deductions":[{"item":"扣分项","penalty":4,"note":"依据",'
    '"target":"正文位置（如 摘要第2段 / 4.2 参数设置）","suggestion":"具体改法"}]},'
    '{"id":"model","score":16,"deductions":[]},{"id":"innovation","score":13,"deductions":[]},'
    '{"id":"writing","score":12,"deductions":[]},{"id":"layout","score":13,"deductions":[]}]}。'
    "五个维度缺一不可：abstract 满分 30、model 满分 20、innovation 满分 20、writing 满分 15、layout 满分 15；"
    "score 为 0 到满分之间的数值，各维度扣分合计应等于满分减得分；"
    "每条扣分必须给 target（论文中的具体位置）与 suggestion（可执行的改法），禁止空泛评语。"
    "发现身份信息、页眉违规等红线时 veto 置 true。"
    "评分必须基于论文实际内容，禁止编造论文里没有的问题；修复轮会附上上一轮扣分与修改后的论文，请重新评审。"
)

DIMENSIONS = {
    "abstract": 30,
    "model": 20,
    "innovation": 20,
    "writing": 15,
    "layout": 15,
}
MAX_TEX_CHARS = 24000


def _rubric(root: Path) -> str:
    path = root / "skills" / "mathmodel-score" / "docs" / "rubric.md"
    try:
        return path.read_text(encoding="utf-8")[:4000]
    except OSError:
        return ""


def build_context(tex: str, round_no: int, root: Path | None = None, prev_card: dict | None = None) -> str:
    root = root or repo_root()
    parts = [
        f"评分口径（rubric 节选）：\n{_rubric(root)}",
        f"待评审论文（第 {round_no} 轮）：\n{tex[:MAX_TEX_CHARS]}",
    ]
    if prev_card:
        parts.append(
            "上一轮评分卡（论文已按扣分修改，请重新评审并给出本轮分数）：\n"
            + json.dumps(prev_card, ensure_ascii=False)[:4000]
        )
    return "\n\n".join(parts)


def _validate_card(data: dict) -> dict:
    dims = data.get("dimensions")
    if not isinstance(dims, list):
        raise ValueError("dimensions 必须是数组")
    seen: dict[str, dict] = {}
    for entry in dims:
        if not isinstance(entry, dict):
            raise ValueError("维度必须是对象")
        did = entry.get("id")
        if did not in DIMENSIONS:
            raise ValueError(f"未知维度: {did}")
        if did in seen:
            raise ValueError(f"维度重复: {did}")
        score = entry.get("score")
        if not isinstance(score, (int, float)) or isinstance(score, bool):
            raise ValueError(f"维度 {did} 的 score 必须是数值")
        if not 0 <= score <= DIMENSIONS[did]:
            raise ValueError(f"维度 {did} 的 score 超出 0–{DIMENSIONS[did]}")
        deductions = entry.get("deductions") or []
        if not isinstance(deductions, list):
            raise ValueError(f"维度 {did} 的 deductions 必须是数组")
        clean = []
        for item in deductions:
            if not isinstance(item, dict) or not str(item.get("item") or "").strip():
                raise ValueError(f"维度 {did} 的扣分项缺少 item")
            penalty = item.get("penalty")
            if not isinstance(penalty, (int, float)) or isinstance(penalty, bool) or penalty < 0:
                raise ValueError(f"维度 {did} 的扣分 penalty 必须是非负数值")
            clean.append(
                {
                    "item": str(item["item"]).strip()[:200],
                    "penalty": float(penalty),
                    "note": str(item.get("note") or "").strip()[:300],
                    "target": str(item.get("target") or "").strip()[:120],
                    "suggestion": str(item.get("suggestion") or "").strip()[:300],
                }
            )
        seen[did] = {"id": did, "score": float(score), "deductions": clean}
    missing = set(DIMENSIONS) - set(seen)
    if missing:
        raise ValueError(f"缺少维度: {sorted(missing)}")
    return {
        "paper": str(data.get("paper") or "赛题论文").strip()[:120],
        "round": int(data.get("round") or 1),
        "veto": data.get("veto") is True,
        "dimensions": [seen[did] for did in DIMENSIONS],
    }


def generate(
    provider: dict | None,
    api_key: str,
    model: str,
    tex: str,
    round_no: int,
    root: Path | None = None,
    prev_card: dict | None = None,
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> tuple[dict, str]:
    """调模型评审，返回 (评分卡, 来源)。失败抛 LlmError。"""
    context = build_context(tex, round_no, root, prev_card)
    card = llm.complete_json(
        provider, api_key, model, "p6-score", P6_INSTRUCTION, context, _validate_card,
        should_stop=should_stop, on_delta=on_delta,
    )
    card["round"] = round_no
    source = "fallback" if (provider or {}).get("id") == "fake" else "llm"
    return card, source


def demo_card(round_no: int = 1) -> dict:
    """离线兜底：演示评分卡（标注兜底，不冒充真实评审）。

    优先取演示里的达标轮，让离线链路能走完；真实评审才产生逐轮分数。
    """
    from .workbench_score import DEMO_SCORES

    demo = json.loads(DEMO_SCORES.read_text(encoding="utf-8"))
    rounds = demo.get("rounds") or []
    passing = [c for c in rounds if sum(d.get("score", 0) for d in c.get("dimensions", [])) >= 85]
    pool = passing or rounds
    card = next((c for c in pool if c.get("round") == round_no), pool[0] if pool else {})
    card = json.loads(json.dumps(card))
    card["round"] = round_no
    return card