"""论文正文生成：骨架 + 写作规范 + 真实求解结果 → 完整 paper.tex。

一次生成起步：整篇 tex 由模型按骨架写出，编译失败回喂修复。
离线兜底：没有可用模型时返回样例稿，并在事件里标明是兜底。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from mms_gateway import llm

TEMPLATES = Path(__file__).resolve().parent / "templates"

P5_INSTRUCTION = (
    "你是数学建模竞赛的论文写作助手。按题面、所选方法、数据画像与真实求解结果，"
    "写出一篇完整的竞赛论文 LaTeX 正文。直接输出完整的 LaTeX 源码，不要围栏、不要解释。"
    "稿件必须是可直接用 xelatex 编译的完整文档（\\documentclass 到 \\end{document}），"
    "导言区原样沿用给定骨架（ctex 中文、页面与标题格式、无页眉），不得增删宏包；"
    "正文按骨架章节组织：问题背景与重述、问题分析、模型假设、符号说明、模型建立与求解、"
    "模型的评价改进与推广、参考文献、附录。"
    "摘要按五段式：钩子直入、方法链与创新点、逐问结果带关键数值、稳健性一句、现实映射；"
    "禁止模板腔（随着…的发展、本文对…进行了深入研究、得到了较为理想的结果）。"
    "所有数值必须来自给定的 result.json，禁止编造没有运行过的结果；"
    "图用 \\includegraphics[width=0.85\\textwidth]{figures/final/fig1_residual.png} 引用（文件已就位）；"
    "参考文献至少 3 条真实可查的文献；正文不出现作者身份与页眉。"
    "修复轮次会附上编译错误与上一版稿件，请针对性修改后重新输出完整稿件。"
)

MAX_RESULT_CHARS = 6000
MAX_RULES_CHARS = 3000
MAX_FEEDBACK_CHARS = 3000
MAX_PREV_TEX_CHARS = 12000


def _skeleton() -> str:
    try:
        return (TEMPLATES / "paper.tex").read_text(encoding="utf-8")
    except OSError:
        return ""


def _writing_rules() -> str:
    try:
        return (TEMPLATES / "writing-rules.md").read_text(encoding="utf-8")[:MAX_RULES_CHARS]
    except OSError:
        return ""


def build_context(
    problem: str,
    picked: dict,
    profile: dict,
    result: dict,
    feedback: str = "",
    prev_tex: str = "",
) -> str:
    explain = picked.get("explain") or {}
    parts = [
        f"题面：\n{problem}",
        (
            f"所选方法：{picked.get('name')}\n核心思路：{picked.get('idea')}\n"
            f"数学形式：{explain.get('math') or '无'}\n验证方式：{explain.get('verify') or '无'}"
        ),
        "数据画像：\n" + json.dumps(profile, ensure_ascii=False)[:2000],
        "真实求解结果（result.json，论文数值只能来自这里）：\n"
        + json.dumps(result, ensure_ascii=False)[:MAX_RESULT_CHARS],
        "LaTeX 骨架（导言区原样沿用，章节结构照此组织）：\n" + _skeleton(),
        "写作规范节选：\n" + _writing_rules(),
        "配图已就位：figures/final/fig1_residual.png（求解产物图），正文必须引用它。",
    ]
    if feedback:
        parts.append(f"上一轮未通过，问题如下（请针对性修复）：\n{feedback[:MAX_FEEDBACK_CHARS]}")
    if prev_tex:
        parts.append(f"上一版稿件：\n{prev_tex[:MAX_PREV_TEX_CHARS]}")
    return "\n\n".join(parts)


def _validate_tex(tex: str) -> str:
    if not isinstance(tex, str) or len(tex.strip()) < 500:
        raise ValueError("tex 必须是完整的 LaTeX 稿件（过短）")
    if "\\documentclass" not in tex or "\\end{document}" not in tex:
        raise ValueError("tex 缺少 \\documentclass 或 \\end{document}")
    if "\\begin{document}" not in tex:
        raise ValueError("tex 缺少 \\begin{document}")
    if "摘要" not in tex and "\\begin{abstract}" not in tex:
        raise ValueError("tex 缺少摘要")
    if "fig1_residual" not in tex:
        raise ValueError("tex 必须引用求解产物图 fig1_residual.png")
    return tex


def generate(
    provider: dict | None,
    api_key: str,
    model: str,
    problem: str,
    picked: dict,
    profile: dict,
    result: dict,
    feedback: str = "",
    prev_tex: str = "",
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> str:
    context = build_context(problem, picked, profile, result, feedback, prev_tex)
    return llm.complete_text(
        provider, api_key, model, "p5-paper", P5_INSTRUCTION, context, _validate_tex,
        should_stop=should_stop, on_delta=on_delta,
    )


def sample_tex() -> str:
    """离线兜底：样例稿，调用方必须标明是兜底。"""
    path = Path(__file__).resolve().parent / "paper_sample" / "paper.tex"
    return path.read_text(encoding="utf-8")
