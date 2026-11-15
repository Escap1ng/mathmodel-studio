"""编排状态机：起题 → K2 确认 → K3 选模 → 阶段四真跑一次基线。

K2/K3 的内容生产优先走 LLM（llm.complete_json）：题面拆解与候选路线由模型
按本题给出；没有 Key、模型不可用或输出两次不合法时，回退确定性的正则切分与
内置方法族，并在卡片上标明是离线兜底。阶段四定位工作区数据、生成脚本、
真跑一遍并把图登记成图表版本，进度用工具卡逐条报到界面上。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from collections.abc import Callable, Iterator
from pathlib import Path

from . import (
    baseline,
    llm,
    paper_build,
    paper_gen,
    project_export,
    score_gen,
    workbench_figure,
    workbench_score,
)
from .store import SessionStore, session_scope

PHASE_INTRO = "已收到题目。先按小节把题面拆开；确认题面后再进入算法选择。"

K2_INSTRUCTION = (
    "你是数学建模竞赛的题面分析助手。把用户给出的赛题拆成子问题，并核对附件的数据角色。"
    "只输出一个 JSON 对象，不要围栏、不要解释，形状："
    '{"questions":[{"id":"q1","text":"子问题描述","data":"所需数据说明"}],'
    '"dataRoles":[{"file":"文件名","role":"训练集/预测集/共用","note":"判断依据"}],'
    '"warning":"数据缺口或风险提醒"}。'
    "questions 最多 6 条，text 忠实于题面、不改写原意；data 写明该问需要哪份数据，"
    "题面没给数据就写「未附数据文件」；dataRoles 只在附件正文足够判断时给出，"
    "判断依据看目标列是否为空、行数与时间范围，不靠文件名猜。"
)

K3_INSTRUCTION = (
    "你是数学建模竞赛的方法选型助手。针对题面给出恰好 3 条候选路线，其中至少 1 条具备明显创新性。"
    "只输出一个 JSON 对象，不要围栏、不要解释，形状："
    '{"candidates":[{"name":"方法名","idea":"核心思路","innovation":"高/中/低",'
    '"interpretability":"高/中/低","difficulty":"高/中/低","eta":"预计耗时（按本题数据规模给量级）",'
    '"accuracy":"精度与鲁棒性预期","math":"数学形式","fit":"为何适配本题","diff":"与未选方案的差异",'
    '"verify":"验证方式","recommended":true,"reason":"一句推荐理由"}]}。'
    "恰好一条 recommended 为 true；评估基于本题的数据规模与约束，不夸大创新度、不低估难度；"
    "换一批时给出与上一批不同的路线。"
)

SELECTION_GUIDE_EXCERPT = (
    "选型原则（mathmodel-methods · selection-guide 节选）：拟合性优先于高级性；"
    "能用初等方法解决的不用高等方法；创新落点明确（建模/求解/结果/推广其一），"
    "须回答解决了旧方法解决不了的什么问题；验证手段与问题类型匹配。"
    "问题特征参考：时序预测→ARIMA/Prophet/LSTM，小样本 GM(1,1)；评价排序→熵权-TOPSIS/AHP；"
    "0-1 变量→整数规划+遗传算法；机理演化→微分方程组+RK4+敏感性分析；"
    "路径配送→TSP/VRP+GA/蚁群；插值补全→三次样条。"
)

_CANDIDATE_TEXT_FIELDS = ("name", "idea", "innovation", "interpretability", "difficulty", "eta", "accuracy")
_CANDIDATE_EXPLAIN_FIELDS = ("math", "fit", "diff", "verify")

FAMILIES = [
    (
        ("预测", "回归", "销量", "价格", "需求", "增长", "估计"),
        [
            {
                "name": "梯度提升回归",
                "idea": "用滞后项、窗口统计与外部变量喂给树模型，直接拟合连续目标。",
                "innovation": "中",
                "interpretability": "中",
                "difficulty": "中",
                "eta": "2–4 小时",
                "accuracy": "中高",
                "math": "ŷ = Σ f_k(x)，f_k 为逐步拟合残差的回归树；用早停与交叉验证选轮数。",
                "fit": "样本量中等、特征以结构化数据为主时，先得到一个强基线，再谈复杂机制。",
                "diff": "比 SARIMAX 更不依赖平稳性假设，但外推能力弱于机制模型。",
                "verify": "按时间切分训练/验证，报告 RMSE 与残差自相关。",
            },
            {
                "name": "SARIMAX 时间序列",
                "idea": "把趋势、季节项与外生变量放进同一个线性状态结构。",
                "innovation": "低",
                "interpretability": "高",
                "difficulty": "中",
                "eta": "1–3 小时",
                "accuracy": "中",
                "math": "φ(B)(1−B)^d y_t = θ(B) ε_t + β x_t，B 为滞后算子。",
                "fit": "目标按固定频率采样、样本跨度足够长时，系数可直接解释。",
                "diff": "可解释性高于树模型，但对缺失值与结构突变敏感。",
                "verify": "ADF 检验平稳性，Ljung-Box 检查残差白噪声。",
            },
            {
                "name": "高斯过程回归",
                "idea": "用核函数描述样本间相关性，同时给出预测区间。",
                "innovation": "高",
                "interpretability": "中",
                "difficulty": "高",
                "eta": "3–5 小时",
                "accuracy": "中高",
                "math": "f ~ GP(m(x), k(x,x'))，后验均值与方差由核矩阵闭式给出。",
                "fit": "小样本、需要不确定性区间时最合适；样本上万后核矩阵代价明显。",
                "diff": "比树模型多给方差，但调核与数值稳定性更费时间。",
                "verify": "留出集覆盖率检查预测区间是否兑现。",
            },
        ],
    ),
    (
        ("分类", "识别", "判别", "检测", "标签"),
        [
            {
                "name": "LightGBM 分类",
                "idea": "直方图分裂的梯度提升树，处理混合类型特征与类别不平衡。",
                "innovation": "中",
                "interpretability": "中",
                "difficulty": "中",
                "eta": "1–3 小时",
                "accuracy": "高",
                "math": "在每轮拟合负梯度，按叶节点输出类概率；用 scale_pos_weight 处理不平衡。",
                "fit": "结构化特征、样本量从几千到几十万都稳，先看特征重要度。",
                "diff": "精度通常高于线性基线，代价是系数不可直接解释。",
                "verify": "分层交叉验证，报告 AUC、召回与混淆矩阵。",
            },
            {
                "name": "正则化逻辑回归",
                "idea": "在线性决策边界上加 L1/L2 约束，给出可读的系数方向。",
                "innovation": "低",
                "interpretability": "高",
                "difficulty": "低",
                "eta": "0.5–1.5 小时",
                "accuracy": "中",
                "math": "P(y=1|x)=σ(wᵀx+b)，最小化对数损失 + λ‖w‖。",
                "fit": "特征维度可控、需要解释每个变量方向时优先。",
                "diff": "比树模型透明，但漏掉交互项时精度会明显落后。",
                "verify": "检查 VIF 与系数稳定性，报告校准曲线。",
            },
            {
                "name": "半监督标签传播",
                "idea": "用少量标注样本与大量未标注样本的相似图扩散标签。",
                "innovation": "高",
                "interpretability": "低",
                "difficulty": "高",
                "eta": "3–6 小时",
                "accuracy": "中",
                "math": "在相似度图上最小化 Σ w_ij‖f_i−f_j‖²，固定已标注点求解。",
                "fit": "标注稀缺但未标注样本充足时值得试，否则不如监督模型。",
                "diff": "能利用未标注数据，但图构建与阈值选择会显著影响结果。",
                "verify": "只用标注集做最终评估，另设人工抽查未标注伪标签。",
            },
        ],
    ),
    (
        ("优化", "调度", "分配", "路径", "选址", "排班", "规划"),
        [
            {
                "name": "混合整数线性规划",
                "idea": "把决策写成 0-1 与连续变量，目标与约束全部线性化。",
                "innovation": "中",
                "interpretability": "高",
                "difficulty": "中",
                "eta": "2–5 小时",
                "accuracy": "高",
                "math": "min cᵀx s.t. Ax ≤ b, x_i∈{0,1}（部分分量）。",
                "fit": "约束能写成线性、规模在求解器可承受范围时，给出可证明的最优界。",
                "diff": "比启发式慢，但结果可复核；非线性约束需要先线性化。",
                "verify": "检查求解状态与对偶界，扰动关键参数做敏感性分析。",
            },
            {
                "name": "遗传算法",
                "idea": "用编码、交叉与变异在非凸空间里搜索可行解。",
                "innovation": "中",
                "interpretability": "低",
                "difficulty": "中",
                "eta": "2–4 小时",
                "accuracy": "中",
                "math": "每代保留适应度高的个体，按选择概率重组并变异。",
                "fit": "目标非凸、约束难线性化时可用；需要固定随机种子才能复现。",
                "diff": "比 MILP 灵活，但没有最优性保证，调参成本高。",
                "verify": "多次独立运行看解的方差，并与贪心基线比较。",
            },
            {
                "name": "鲁棒优化",
                "idea": "把参数的不确定集写进约束，求最坏情况下的可行方案。",
                "innovation": "高",
                "interpretability": "中",
                "difficulty": "高",
                "eta": "4–6 小时",
                "accuracy": "中高",
                "math": "min cᵀx s.t. a(ξ)ᵀx ≤ b ∀ξ∈U，U 为盒式或椭球不确定集。",
                "fit": "需求或价格波动明显、方案不能事后补救时最有价值。",
                "diff": "比确定性模型保守，但能回答「参数偏多少会失效」。",
                "verify": "在不确定集边界采样，检查约束违反率与目标退化幅度。",
            },
        ],
    ),
    (
        ("评价", "指标", "权重", "排名", "综合", "评分"),
        [
            {
                "name": "熵权-TOPSIS",
                "idea": "用样本离散度定权，再按与理想解的距离排序。",
                "innovation": "中",
                "interpretability": "高",
                "difficulty": "低",
                "eta": "1–2 小时",
                "accuracy": "中",
                "math": "熵权 w_j ∝ 1−e_j；贴近度 C_i = d_i⁻/(d_i⁺+d_i⁻)。",
                "fit": "指标方向一致、样本量足够形成分布时，权重完全由数据决定。",
                "diff": "比 AHP 少主观性，但样本太少时熵权不稳定。",
                "verify": "对指标做正负向归一化，换权重方案检查排序是否翻转。",
            },
            {
                "name": "AHP-模糊综合评价",
                "idea": "用成对比较矩阵取权重，再用隶属度合成评价等级。",
                "innovation": "低",
                "interpretability": "高",
                "difficulty": "中",
                "eta": "1.5–3 小时",
                "accuracy": "中",
                "math": "判断矩阵最大特征向量作权重；B = W∘R 合成隶属度。",
                "fit": "指标难以量化、需要专家判断时可用，但要报告一致性比率。",
                "diff": "比熵权更能纳入领域知识，主观性也更高。",
                "verify": "CR < 0.1；更换专家矩阵做敏感性分析。",
            },
            {
                "name": "可解释加权评分",
                "idea": "把分项得分与权重写成显式公式，逐项可追溯。",
                "innovation": "高",
                "interpretability": "高",
                "difficulty": "低",
                "eta": "1–2 小时",
                "accuracy": "中",
                "math": "S = Σ w_j · s_j，s_j 为归一化分项，w_j 由约束或专家给定。",
                "fit": "评审需要看懂每一分从哪来时，比黑箱排序更合适。",
                "diff": "透明但依赖权重设定；可与熵权结果交叉验证。",
                "verify": "逐项回算总分，检查权重和为 1 与极端样本。",
            },
        ],
    ),
    (
        ("传播", "扩散", "动力学", "微分", "传染病", "演化"),
        [
            {
                "name": "常微分方程参数反演",
                "idea": "先写机制方程，再用观测数据拟合关键速率参数。",
                "innovation": "中",
                "interpretability": "高",
                "difficulty": "中",
                "eta": "3–5 小时",
                "accuracy": "中高",
                "math": "dx/dt = f(x,θ)，最小化 Σ‖x(t_i;θ)−y_i‖²。",
                "fit": "变量少、机制清楚时最稳；参数不可辨识要先做结构分析。",
                "diff": "比纯数据驱动更能外推，但模型设定错会系统性偏差。",
                "verify": "多初值拟合，检查参数置信区间与残差结构。",
            },
            {
                "name": "元胞自动机",
                "idea": "把空间划成网格，用局部更新规则模拟扩散与聚集。",
                "innovation": "中",
                "interpretability": "中",
                "difficulty": "中",
                "eta": "2–4 小时",
                "accuracy": "中",
                "math": "x_i(t+1)=F(x_i(t), N(i))，N(i) 为邻域状态。",
                "fit": "空间异质性与局部交互明显、连续方程难写时可用。",
                "diff": "比 ODE 灵活，但规则与网格尺度会改变结论，需要做收敛检查。",
                "verify": "缩小网格与时间步，确认宏观指标收敛。",
            },
            {
                "name": "贝叶斯层次模型",
                "idea": "给参数加先验并共享组间信息，输出后验区间。",
                "innovation": "高",
                "interpretability": "中",
                "difficulty": "高",
                "eta": "4–7 小时",
                "accuracy": "中高",
                "math": "θ_g ~ p(θ|φ)，y_g ~ p(y|θ_g)，对 φ 与 θ_g 联合求后验。",
                "fit": "分组样本量不均、需要量化不确定性时最有价值。",
                "diff": "比点估计多给区间，但采样诊断与先验选择成本高。",
                "verify": "检查 R̂ 与有效样本量，做先验敏感性分析。",
            },
        ],
    ),
]

DEFAULT_FAMILY = [
    {
        "name": "梯度提升树",
        "idea": "先用结构化特征建立非线性基线，量化可提升空间。",
        "innovation": "低",
        "interpretability": "中",
        "difficulty": "低",
        "eta": "1–2 小时",
        "accuracy": "中高",
        "math": "ŷ = Σ f_k(x)，逐轮拟合残差。",
        "fit": "题面尚未暴露明确机制时，先拿到可复现的基线。",
        "diff": "比机制模型省时，但外推与解释较弱。",
        "verify": "交叉验证并报告特征重要度。",
    },
    {
        "name": "多元回归 + 正则化",
        "idea": "用显式变量与约束项给出可解释的基线。",
        "innovation": "低",
        "interpretability": "高",
        "difficulty": "低",
        "eta": "1–2 小时",
        "accuracy": "中",
        "math": "min ‖y−Xβ‖² + λ‖β‖。",
        "fit": "变量关系近似线性、需要逐项解释时优先。",
        "diff": "比树模型透明，交互项需要手工构造。",
        "verify": "残差诊断与系数稳定性检查。",
    },
    {
        "name": "机制模型 + 数据校准",
        "idea": "先写守恒或平衡关系，再用数据校准少量参数。",
        "innovation": "高",
        "interpretability": "高",
        "difficulty": "高",
        "eta": "3–6 小时",
        "accuracy": "中高",
        "math": "由守恒关系给出 f(x,θ)=0，再最小化观测残差。",
        "fit": "题面给了明确机制或约束时，比纯拟合更可信。",
        "diff": "可外推、可解释，但建模与校准都更费时间。",
        "verify": "参数敏感性分析与留出年份回测。",
    },
]


def _family_for(problem: str):
    for keywords, pool in FAMILIES:
        if any(k in problem for k in keywords):
            return pool
    return DEFAULT_FAMILY


def split_questions(problem: str) -> list[str]:
    text = problem.strip()
    if not text:
        return []
    pattern = r"(?=(?:问题\s*[一二三四五六七八九十0-9]+|（\s*[0-9]+\s*）|\(\s*[0-9]+\s*\)))"
    parts = [p.strip() for p in re.split(pattern, text) if p.strip()]
    if len(parts) < 2:
        parts = [line.strip() for line in text.splitlines() if line.strip()][:3] or [text]
    return [p[:180] for p in parts[:6]]


# 渲染层把附件正文包在这对标记里送进来；题目切分只用标记外的手打文字。
ATTACH_START = "--- 附件（本机文件）---"
ATTACH_END = "--- 附件结束 ---"


def _attachment_region(problem: str) -> str:
    start = problem.find(ATTACH_START)
    if start < 0:
        return ""
    end = problem.find(ATTACH_END, start + len(ATTACH_START))
    begin = start + len(ATTACH_START)
    return problem[begin:] if end < 0 else problem[begin:end]


def attachment_names(problem: str) -> list[str]:
    names: list[str] = []
    for line in _attachment_region(problem).splitlines():
        line = line.strip()
        if not line.startswith("### "):
            continue
        name = line[4:].split(" · ", 1)[0].strip()
        if name and name not in names:
            names.append(name)
    return names


def strip_attachments(problem: str) -> str:
    start = problem.find(ATTACH_START)
    if start < 0:
        return problem.strip()
    end = problem.find(ATTACH_END, start + len(ATTACH_START))
    head = problem[:start].strip()
    tail = "" if end < 0 else problem[end + len(ATTACH_END):].strip()
    return (head + ("\n" + tail if tail else "")).strip()


def question_source(problem: str) -> str:
    # 只拖了文件、没手打题面时，题面就在附件正文里；此时用正文切子问题。
    typed = strip_attachments(problem)
    if typed:
        return typed
    body = _attachment_region(problem)
    return "\n".join(line for line in body.splitlines() if not line.strip().startswith("### ")).strip()


def phase_event(num: int, status: str, note: str = "") -> dict:
    data = {"phase": num, "status": status}
    if note:
        data["note"] = note
    return {"event": "phase", "data": data}


def set_phase(record: dict, num: int, status: str) -> None:
    for row in record["phases"]:
        if row["phase"] == num:
            row["status"] = status


def _last_assistant(record: dict) -> dict | None:
    for message in reversed(record["messages"]):
        if message.get("role") == "assistant":
            return message
    return None


def _resolve_interrupt(record: dict, label: str) -> None:
    message = _last_assistant(record)
    if message and message.get("interrupt"):
        message["interrupt"]["resolved"] = label


def _problem_payload(problem: str) -> dict:
    names = attachment_names(problem)
    questions = split_questions(question_source(problem))
    intro = (
        f"按题面切出 {len(questions)} 个子问题，收到 {len(names)} 个附件；附件正文已并入题面。"
        if names
        else f"按题面切出 {len(questions)} 个子问题。附件核对需要真实文件，这一步先标出缺口。"
    )
    return {
        "title": "赛题与附件确认",
        "intro": intro,
        "questions": [
            {"id": f"q{i + 1}", "text": text, "data": "未附数据文件"}
            for i, text in enumerate(questions)
        ],
        "attachments": [{"id": f"a{i + 1}", "name": name} for i, name in enumerate(names)],
        "dataRoles": [],
        "warning": (
            "附件正文已随题面送入；数据角色核对（目标列是否为空、行数、时间范围）尚未接入。"
            if names
            else "未附数据文件：数据角色核对需要真实表格。确认后按文字题面继续。"
        ),
    }


def _candidates(problem: str, batch: int) -> list[dict]:
    pool = _family_for(problem)
    start = (batch - 1) % len(pool)
    picked = [pool[(start + i) % len(pool)] for i in range(3)]
    out = []
    for index, base in enumerate(picked):
        item = dict(base)
        item["id"] = f"c{index + 1}"
        item["recommended"] = index == 0
        item["reason"] = (
            "先跑通这条基线的代价最低，结果可直接对照后续模型。"
            if index == 0
            else "作为对照，用来检验推荐方案的优势是否真实存在。"
        )
        item["explain"] = {
            "math": item.pop("math"),
            "fit": item.pop("fit"),
            "diff": item.pop("diff"),
            "verify": item.pop("verify"),
            "eta": item["eta"],
            "source": "mathmodel-methods · selection-guide（M3 内置节选）",
        }
        out.append(item)
    return out


def _model_payload(problem: str, batch: int) -> dict:
    return {
        "title": "算法选择",
        "intro": "以下是同题的三条路线。先看差异，再选一条进入代码实现。",
        "batch": batch,
        "candidates": _candidates(problem, batch),
    }


def model_candidates(problem: str, batch: int = 1) -> list[dict]:
    """对话式选模卡与全流程编排共用同一份候选，避免两套口径。"""
    return _candidates(problem, batch)


def _validate_problem(data: dict) -> dict:
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        raise ValueError("questions 必须是非空数组")
    rows: list[dict] = []
    for index, item in enumerate(questions[:6]):
        if not isinstance(item, dict) or not str(item.get("text") or "").strip():
            raise ValueError("每个子问题必须有 text")
        rows.append(
            {
                "id": str(item.get("id") or f"q{index + 1}"),
                "text": str(item["text"]).strip()[:300],
                "data": str(item.get("data") or "未附数据文件").strip()[:120],
            }
        )
    roles: list[dict] = []
    for item in data.get("dataRoles") or []:
        if isinstance(item, dict) and str(item.get("file") or "").strip():
            roles.append(
                {
                    "file": str(item["file"]).strip()[:120],
                    "role": str(item.get("role") or "").strip()[:40],
                    "note": str(item.get("note") or "").strip()[:200],
                }
            )
    return {
        "questions": rows,
        "dataRoles": roles,
        "warning": str(data.get("warning") or "").strip()[:300],
    }


def _problem_payload_llm(
    problem: str,
    provider: dict | None,
    api_key: str,
    model: str,
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> dict:
    """K2：LLM 拆子问题并核对数据角色；失败回退正则切分并标明兜底。"""
    base = _problem_payload(problem)
    if not provider:
        return base
    user = (
        f"题面：\n{question_source(problem)}\n\n"
        f"附件清单：{'、'.join(attachment_names(problem)) or '无'}\n\n"
        f"附件正文（节选）：\n{_attachment_region(problem)[:6000] or '无'}"
    )
    try:
        parsed = llm.complete_json(
            provider, api_key, model, "k2-problem", K2_INSTRUCTION, user, _validate_problem,
            should_stop=should_stop, on_delta=on_delta,
        )
    except llm.LlmError:
        base["warning"] = (base["warning"] + "（模型不可用，已回退按小节切分）").strip()
        return base
    names = attachment_names(problem)
    count = len(parsed["questions"])
    intro = (
        f"模型拆出 {count} 个子问题，收到 {len(names)} 个附件；请核对数据角色后确认。"
        if names
        else f"模型拆出 {count} 个子问题。未附数据文件，确认后按文字题面继续。"
    )
    return {
        "title": "赛题与附件确认",
        "intro": intro,
        "questions": parsed["questions"],
        "attachments": base["attachments"],
        "dataRoles": parsed["dataRoles"],
        "warning": parsed["warning"] or base["warning"],
    }


def _validate_candidates(data: dict) -> dict:
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or len(candidates) != 3:
        raise ValueError("candidates 必须恰好 3 条")
    rows: list[dict] = []
    recommended_count = 0
    for index, item in enumerate(candidates):
        if not isinstance(item, dict):
            raise ValueError("候选必须是对象")
        row: dict = {"id": f"c{index + 1}"}
        for field in _CANDIDATE_TEXT_FIELDS:
            value = str(item.get(field) or "").strip()
            if not value:
                raise ValueError(f"候选缺少字段 {field}")
            row[field] = value[:300]
        explain: dict = {}
        for field in _CANDIDATE_EXPLAIN_FIELDS:
            value = str(item.get(field) or "").strip()
            if not value:
                raise ValueError(f"候选缺少解释字段 {field}")
            explain[field] = value[:500]
        explain["eta"] = row["eta"]
        explain["source"] = "模型判断（参考 mathmodel-methods · selection-guide）"
        row["explain"] = explain
        row["recommended"] = item.get("recommended") is True
        recommended_count += int(row["recommended"])
        row["reason"] = str(item.get("reason") or "").strip()[:200]
        rows.append(row)
    if recommended_count != 1:
        raise ValueError("必须恰好一条推荐候选")
    if not any(row["innovation"] == "高" for row in rows):
        raise ValueError("至少一条候选的创新度必须为高")
    return {"candidates": rows}


def _model_payload_llm(
    problem: str,
    batch: int,
    provider: dict | None,
    api_key: str,
    model: str,
    previous: list[str] | None = None,
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> dict:
    """K3：LLM 按题出候选；失败回退内置方法族并标明兜底。"""
    if not provider:
        return _model_payload(problem, batch)
    user = (
        f"题面：\n{question_source(problem)}\n\n"
        f"附件清单：{'、'.join(attachment_names(problem)) or '无'}\n\n"
        f"{SELECTION_GUIDE_EXCERPT}"
    )
    if previous:
        user += f"\n\n上一批候选（换一批时不要重复）：{'、'.join(previous)}"
    try:
        parsed = llm.complete_json(
            provider, api_key, model, "k3-models", K3_INSTRUCTION, user, _validate_candidates,
            should_stop=should_stop, on_delta=on_delta,
        )
    except llm.LlmError:
        payload = _model_payload(problem, batch)
        payload["intro"] = "模型不可用，以下候选来自内置方法族（离线兜底）。先看差异，再选一条。"
        return payload
    return {
        "title": "算法选择",
        "intro": "以下是模型按本题给出的三条路线。先看差异，再选一条进入代码实现。",
        "batch": batch,
        "candidates": parsed["candidates"],
    }


def start(
    store: SessionStore,
    record: dict,
    provider: dict | None = None,
    api_key: str = "",
    model: str = "",
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> list[dict]:
    payload = _problem_payload_llm(
        record["problem"], provider, api_key, model or record.get("model") or "",
        should_stop=should_stop, on_delta=on_delta,
    )
    set_phase(record, 0, "passed")
    set_phase(record, 1, "waiting")
    record["messages"].append({"role": "user", "content": record["problem"]})
    record["messages"].append(
        {
            "role": "assistant",
            "content": PHASE_INTRO,
            "interrupt": {"card": "problem-confirm", "payload": payload},
        }
    )
    record["pending"] = {"card": "problem-confirm", "payload": payload}
    store.put(record)
    return [
        phase_event(0, "passed", "runtime 环境就绪（xelatex/pandoc 等外部依赖未检）"),
        phase_event(1, "running"),
        {"event": "token", "data": {"text": PHASE_INTRO}},
        phase_event(1, "waiting"),
        {"event": "interrupt", "data": record["pending"]},
    ]


def resume(
    store: SessionStore,
    record: dict,
    action: str,
    choice: str,
    workspace: str = "",
    provider: dict | None = None,
    api_key: str = "",
    model: str = "",
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> list[dict]:
    return list(
        resume_iter(
            store, record, action, choice, workspace,
            provider=provider, api_key=api_key, model=model,
            should_stop=should_stop, on_delta=on_delta,
        )
    )


def resume_iter(
    store: SessionStore,
    record: dict,
    action: str,
    choice: str,
    workspace: str = "",
    provider: dict | None = None,
    api_key: str = "",
    model: str = "",
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> Iterator[dict]:
    pending = record["pending"]
    if not pending:
        raise ValueError("这个会话没有等待中的决策")
    card = pending.get("card")
    model = model or record.get("model") or ""

    if action == "confirm":
        if card != "problem-confirm":
            raise ValueError("当前不是在确认赛题")
        _resolve_interrupt(record, "已确认")
        set_phase(record, 1, "passed")
        set_phase(record, 2, "passed")
        set_phase(record, 3, "waiting")
        payload = _model_payload_llm(
            record["problem"], record["batch"], provider, api_key, model,
            should_stop=should_stop, on_delta=on_delta,
        )
        text = "题面已确认。会话数据已落盘，下面是三条候选路线。"
        record["messages"].append(
            {
                "role": "assistant",
                "content": text,
                "interrupt": {"card": "model-choice", "payload": payload},
            }
        )
        record["pending"] = {"card": "model-choice", "payload": payload}
        store.put(record)
        yield phase_event(1, "passed")
        yield phase_event(2, "passed", "会话数据目录已创建")
        yield phase_event(3, "running")
        yield {"event": "token", "data": {"text": text}}
        yield phase_event(3, "waiting")
        yield {"event": "interrupt", "data": record["pending"]}
        return

    if action == "reroll":
        if card != "model-choice":
            raise ValueError("当前不是在选模")
        _resolve_interrupt(record, "已换一批")
        previous = [
            str(item.get("name") or "")
            for item in (pending.get("payload") or {}).get("candidates") or []
        ]
        record["batch"] += 1
        payload = _model_payload_llm(
            record["problem"], record["batch"], provider, api_key, model,
            previous=previous, should_stop=should_stop, on_delta=on_delta,
        )
        text = f"换一批（第 {record['batch']} 组）：仍然只看路线差异，不改变待选状态。"
        record["messages"].append(
            {
                "role": "assistant",
                "content": text,
                "interrupt": {"card": "model-choice", "payload": payload},
            }
        )
        record["pending"] = {"card": "model-choice", "payload": payload}
        set_phase(record, 3, "waiting")
        store.put(record)
        yield {"event": "token", "data": {"text": text}}
        yield {"event": "interrupt", "data": record["pending"]}
        return

    if action == "choose":
        if card != "model-choice":
            raise ValueError("当前不是在选模")
        candidates = pending.get("payload", {}).get("candidates", [])
        picked = next((c for c in candidates if c.get("id") == choice), None)
        if picked is None:
            raise ValueError("选择的候选不存在")
        _resolve_interrupt(record, f"已选：{picked['name']}")
        # 所选模型落盘：阶段四按它生成代码，选模不再是装饰。
        record["picked"] = picked
        set_phase(record, 3, "passed")
        set_phase(record, 4, "running")
        text = f"已选择「{picked['name']}」。阶段三已过，开始阶段四：真跑一次基线。"
        record["messages"].append({"role": "assistant", "content": text})
        record["pending"] = None
        store.put(record)
        yield phase_event(3, "passed")
        yield phase_event(4, "running")
        yield {"event": "token", "data": {"text": text}}
        yield from _phase4_prepare(
            store, record, picked, workspace,
            provider=provider, api_key=api_key, model=model,
            should_stop=should_stop, on_delta=on_delta,
        )
        return

    if action == "run":
        if card != "code-confirm":
            raise ValueError("当前不是在确认求解代码")
        yield from _run_code(
            store, record, workspace,
            {
                "provider": provider, "api_key": api_key, "model": model,
                "should_stop": should_stop, "on_delta": on_delta,
            },
        )
        return

    raise ValueError(f"未知动作: {action}")


def _workflow_delay() -> float:
    try:
        return max(0.0, float(os.environ.get("MMS_WORKFLOW_DELAY_MS") or "180") / 1000)
    except ValueError:
        return 0.18


def _tool(
    call_id: str,
    name: str,
    status: str,
    *,
    args=None,
    result=None,
    duration_ms: int | None = None,
    delay: float = 0.0,
) -> dict:
    data: dict = {"id": call_id, "name": name, "status": status}
    if args is not None:
        data["args"] = args
    if result is not None:
        data["result"] = result
    if duration_ms is not None:
        data["duration_ms"] = duration_ms
    row: dict = {"event": "tool_call", "data": data}
    if delay:
        row["delay"] = delay
    return row


def _text_event(text: str, delay: float = 0.0) -> dict:
    row: dict = {"event": "token", "data": {"text": text}}
    if delay:
        row["delay"] = delay
    return row


def _close_phase4(store: SessionStore, record: dict, text: str) -> None:
    record["messages"].append({"role": "assistant", "content": text})
    record["pending"] = None
    store.put(record)


P4_INSTRUCTION = (
    "你是数学建模竞赛的求解代码生成助手。按题面、所选方法与数据画像，写一个完整可运行的 Python 脚本 solution.py。"
    "只输出一个 JSON 对象，不要围栏、不要解释，形状："
    '{"rationale":"两三句实现思路","code":"完整 Python 源码"}。'
    "脚本硬性契约：用 argparse 接受 --data（CSV/TSV 路径）与 --out（输出目录）；"
    "在 --out 写出 result.json（含 ok、rows、cols、target 与本题关键数值结果）"
    "和 figure.png / figure.pdf / figure.svg 三件图（matplotlib 用 Agg 后端，dpi≥150）；"
    "只用标准库 + numpy + matplotlib，不依赖 pandas / scikit-learn；"
    "数据编码按 utf-8-sig / gbk / utf-8 依次尝试；固定随机种子保证可复现；"
    "不得联网、不得读写 --data/--out 之外的路径、不得执行系统命令。"
    "修复轮次会附上上一版代码与失败输出，请针对性修改后重新输出完整脚本。"
)

P4_MAX_ROUNDS = 3


def _validate_code(data: dict) -> dict:
    code = data.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code 必须是非空字符串")
    problems = baseline.validate_script(code)
    if problems:
        raise ValueError("脚本不满足契约：" + "；".join(problems))
    return {"rationale": str(data.get("rationale") or "").strip()[:500], "code": code}


def _p4_user_content(record: dict, picked: dict, profile: dict, feedback: str = "") -> str:
    explain = picked.get("explain") or {}
    parts = [
        f"题面：\n{question_source(record['problem'])}",
        (
            f"所选方法：{picked.get('name')}\n核心思路：{picked.get('idea')}\n"
            f"数学形式：{explain.get('math') or '无'}\n验证方式：{explain.get('verify') or '无'}"
        ),
        "数据画像：\n" + json.dumps(profile, ensure_ascii=False)[:4000],
    ]
    if feedback:
        parts.append(feedback)
    return "\n\n".join(parts)


def _p4_feedback(round_no: int, prev_code: str, error_text: str) -> str:
    return (
        f"这是第 {round_no} 轮修复。上一版代码运行失败，失败输出（尾部）：\n{error_text[-1500:]}\n\n"
        f"上一版代码：\n{prev_code[:8000]}"
    )


def _code_card(
    store: SessionStore,
    record: dict,
    code: str,
    rationale: str,
    script_path: Path,
    data_path: Path,
    round_no: int,
    sample: bool,
    source: str,
) -> Iterator[dict]:
    """先落 pending 再 yield interrupt：执行严格发生在用户点「运行」之后。"""
    text = (
        f"求解脚本已生成（第 {round_no} 轮，{source}）。请检查代码，点「运行」才执行；"
        "脚本只读数据文件、只写输出目录。\n\n"
    )
    payload = {
        "title": "求解代码确认",
        "intro": rationale or "检查代码后运行。",
        "code": code,
        "scriptPath": str(script_path),
        "dataPath": str(data_path),
        "round": round_no,
        "rationale": rationale,
        "sample": sample,
    }
    record["messages"].append(
        {"role": "assistant", "content": text, "interrupt": {"card": "code-confirm", "payload": payload}}
    )
    record["pending"] = {"card": "code-confirm", "payload": payload}
    store.put(record)
    yield _text_event(text, _workflow_delay())
    yield {"event": "interrupt", "data": record["pending"]}


def _phase4_prepare(
    store: SessionStore,
    record: dict,
    picked: dict,
    workspace: str,
    provider: dict | None = None,
    api_key: str = "",
    model: str = "",
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> Iterator[dict]:
    """阶段四前半：目录 → 数据画像 → LLM 生成代码 → 挂确认卡。不执行任何脚本。"""
    delay = _workflow_delay()
    name = str(picked.get("name") or "方案")
    data_root = session_scope(store.path.parent, record.get("id"))
    code_dir = data_root / "workbench" / "code"

    yield _text_event(
        f"按「{name}」进入阶段四：准备目录 → 定位数据 → 生成求解代码，等你确认后运行。\n\n",
        delay,
    )

    yield _tool("p4-prepare", "准备目录", "running", args={"dir": str(code_dir)})
    started = time.monotonic()
    try:
        code_dir.mkdir(parents=True, exist_ok=True)
        prep_error = ""
    except OSError as exc:
        prep_error = str(exc)
    yield _tool(
        "p4-prepare",
        "准备目录",
        "ok" if not prep_error else "error",
        args={"dir": str(code_dir)},
        result={"ok": not prep_error, "dir": str(code_dir), "error": prep_error},
        duration_ms=int((time.monotonic() - started) * 1000),
        delay=delay,
    )
    if prep_error:
        text = f"阶段四没开始：工作目录创建失败（{prep_error}）。"
        set_phase(record, 4, "failed")
        _close_phase4(store, record, text)
        yield phase_event(4, "failed", prep_error)
        yield _text_event(text, delay)
        return

    yield _tool("p4-data", "定位数据", "running", args={"workspace": workspace or "（未设置）"})
    started = time.monotonic()
    data_path = baseline.find_data(Path(workspace)) if workspace else None
    sample = data_path is None
    if sample:
        data_path = baseline.ensure_sample(code_dir)
    try:
        size_kb = round(data_path.stat().st_size / 1024, 1)
    except OSError:
        size_kb = 0.0
    yield _tool(
        "p4-data",
        "定位数据",
        "ok",
        args={"workspace": workspace or "（未设置）"},
        result={
            "file": data_path.name,
            "path": str(data_path),
            "size_kb": size_kb,
            "sample": sample,
        },
        duration_ms=int((time.monotonic() - started) * 1000),
        delay=delay,
    )
    if sample:
        yield _text_event("工作区里没有 CSV/TSV，先用内置示例数据 sample.csv 把链路跑通。\n", delay)

    profile = baseline.profile_data(data_path)
    yield from _p4_generate(
        store, record, picked, code_dir, data_path, profile, sample, round_no=1,
        provider=provider, api_key=api_key, model=model,
        should_stop=should_stop, on_delta=on_delta,
    )


def _p4_generate(
    store: SessionStore,
    record: dict,
    picked: dict,
    code_dir: Path,
    data_path: Path,
    profile: dict,
    sample: bool,
    round_no: int,
    feedback: str = "",
    provider: dict | None = None,
    api_key: str = "",
    model: str = "",
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> Iterator[dict]:
    """生成脚本（LLM 优先，失败回退内置基线），写盘后挂 code-confirm 卡。"""
    delay = _workflow_delay()
    yield _tool("p4-code", "生成脚本", "running", args={"file": baseline.SCRIPT_NAME, "round": round_no})
    started = time.monotonic()
    code, rationale, source = baseline.SCRIPT, "内置基线脚本（离线兜底）", "fallback"
    if provider:
        try:
            parsed = llm.complete_json(
                provider, api_key, model or record.get("model") or "",
                "p4-code", P4_INSTRUCTION,
                _p4_user_content(record, picked, profile, feedback),
                _validate_code,
                should_stop=should_stop, on_delta=on_delta,
            )
            code, rationale, source = parsed["code"], parsed["rationale"], "llm"
        except llm.LlmError as exc:
            rationale = f"模型不可用（{exc}），回退内置基线脚本。"
    script_path = code_dir / baseline.SCRIPT_NAME
    try:
        script_path.write_text(code, encoding="utf-8")
        write_error = ""
    except OSError as exc:
        write_error = str(exc)
    yield _tool(
        "p4-code",
        "生成脚本",
        "ok" if not write_error else "error",
        args={"file": baseline.SCRIPT_NAME, "round": round_no},
        result={
            "ok": not write_error,
            "file": str(script_path),
            "lines": len(code.splitlines()),
            "source": source,
            "error": write_error,
        },
        duration_ms=int((time.monotonic() - started) * 1000),
        delay=delay,
    )
    if write_error:
        text = f"阶段四失败：脚本写入失败（{write_error}）。"
        set_phase(record, 4, "failed")
        _close_phase4(store, record, text)
        yield phase_event(4, "failed", write_error)
        yield _text_event(text, delay)
        return
    yield from _code_card(store, record, code, rationale, script_path, data_path, round_no, sample, source)


def _run_code(store: SessionStore, record: dict, workspace: str, ctx: dict) -> Iterator[dict]:
    """阶段四后半：用户点「运行」后才执行；失败回喂修复 ≤2 轮，成功登记产物。"""
    delay = _workflow_delay()
    pending = record.get("pending") or {}
    payload = pending.get("payload") or {}
    picked = record.get("picked") or {}
    name = str(picked.get("name") or "方案")
    data_root = session_scope(store.path.parent, record.get("id"))
    code_dir = data_root / "workbench" / "code"
    out_dir = code_dir / "outputs"
    data_path = Path(str(payload.get("dataPath") or ""))
    round_no = int(payload.get("round") or 1)
    sample = bool(payload.get("sample"))
    code = str(payload.get("code") or "")

    _resolve_interrupt(record, "已运行")
    record["pending"] = None
    store.put(record)
    yield _text_event(f"开始运行求解脚本（第 {round_no} 轮）。\n", delay)

    if not data_path.is_file():
        text = "阶段四失败：数据文件不存在，请重新选择题面数据。"
        set_phase(record, 4, "failed")
        _close_phase4(store, record, text)
        yield phase_event(4, "failed", "数据文件缺失")
        yield _text_event(text, delay)
        return

    yield _tool("p4-run", "运行脚本", "running", args={"data": str(data_path), "out": str(out_dir)})
    started = time.monotonic()
    run = baseline.run_baseline(code_dir, data_path, out_dir)
    stats = run.get("result") or {}
    seconds = round(time.monotonic() - started, 1)
    yield _tool(
        "p4-run",
        "运行脚本",
        "ok" if run.get("ok") else "error",
        args={"data": str(data_path), "out": str(out_dir)},
        result={
            "ok": run.get("ok"),
            "exit": run.get("exit"),
            "seconds": seconds,
            "rows": stats.get("rows"),
            "cols": stats.get("cols"),
            "target": stats.get("target"),
            "r2": stats.get("r2"),
            "rmse": stats.get("rmse"),
            "stderr": (run.get("stderr") or "")[-400:],
        },
        duration_ms=int(seconds * 1000),
        delay=delay,
    )

    if not run.get("ok"):
        error_text = (run.get("stderr") or run.get("stdout") or "").strip()
        if round_no < P4_MAX_ROUNDS and ctx.get("provider"):
            text = f"第 {round_no} 轮运行失败（退出 {run.get('exit')}），把失败输出回喂模型修复。\n"
            record["messages"].append({"role": "assistant", "content": text})
            store.put(record)
            yield _text_event(text, delay)
            profile = baseline.profile_data(data_path)
            yield from _p4_generate(
                store, record, picked, code_dir, data_path, profile, sample,
                round_no=round_no + 1,
                feedback=_p4_feedback(round_no + 1, code, error_text),
                provider=ctx.get("provider"), api_key=ctx.get("api_key") or "",
                model=ctx.get("model") or "", should_stop=ctx.get("should_stop"),
                on_delta=ctx.get("on_delta"),
            )
            return
        tail = " ".join(error_text.split())[-200:]
        text = (
            f"阶段四失败：脚本退出 {run.get('exit')}"
            f"{'，已用尽修复轮次' if round_no >= P4_MAX_ROUNDS else '，且没有可用模型做修复'}。"
            f"{('输出：' + tail) if tail else ''}"
        )
        set_phase(record, 4, "failed")
        _close_phase4(store, record, text)
        yield phase_event(4, "failed", "求解脚本失败")
        yield _text_event(text, delay)
        return

    yield _tool("p4-collect", "登记产物", "running", args={"outputs": sorted(run["outputs"])})
    started = time.monotonic()
    version = workbench_figure.register(
        data_dir=data_root,
        sources=run["outputs"],
        template="solution",
        template_title=f"阶段四 · 求解（{name}）",
        theme="studio-ink",
        theme_title="Studio Ink",
        command=run.get("command") or "",
        stdout=run.get("stdout") or "",
        stderr=run.get("stderr") or "",
        label="求解",
    )
    # 用户文件夹里的「图表」放最新的可读副本；写不进去只记日志，不影响阶段推进。
    project_export.copy_outputs(workspace, "图表", version["outputs"])
    yield _tool(
        "p4-collect",
        "登记产物",
        "ok",
        args={"outputs": sorted(run["outputs"])},
        result={"version": version["id"], "outputs": version["outputs"]},
        duration_ms=int((time.monotonic() - started) * 1000),
        delay=delay,
    )
    yield {
        "event": "artifact",
        "data": {"kind": "figure", "version": version["id"], "outputs": version["outputs"]},
    }

    r2 = stats.get("r2")
    rmse = stats.get("rmse")
    if isinstance(r2, (int, float)) and isinstance(rmse, (int, float)):
        fit = f"R²={r2:.3f}，RMSE={rmse:.3f}"
    else:
        fit = "关键数值结果见 result.json"
    source = "内置示例数据" if sample else "工作区数据"
    text = (
        f"阶段四完成（{name}）。\n"
        f"- 数据：{data_path.name}（{source}，{stats.get('rows')} 行 × {stats.get('cols')} 列，"
        f"目标列 {stats.get('target')}）\n"
        f"- 结果：{fit}\n"
        f"- 产物：PNG/PDF/SVG 三件，已登记为图表版本 {version['id']}\n"
        "进入阶段五：按真实结果写论文并排版。"
    )
    set_phase(record, 4, "passed")
    record["messages"].append({"role": "assistant", "content": text})
    record["pending"] = None
    store.put(record)
    yield phase_event(4, "passed", "求解脚本已跑通，图表版本已登记")
    yield _text_event(text, delay)
    yield from _phase5_paper(store, record, workspace, ctx, run.get("result") or {}, version)


P5_MAX_ROUNDS = 3


def _p5_feedback(result: dict) -> str:
    parts: list[str] = []
    if result.get("error"):
        parts.append(str(result["error"]))
    for gate in result.get("gates") or []:
        if not gate.get("ok"):
            parts.append(f"{gate.get('label')}：{gate.get('detail')}")
    if result.get("logTail"):
        parts.append("编译日志尾部：\n" + str(result["logTail"])[-1500:])
    return "\n".join(parts) or "构建未通过"


def _build_paper_once(
    store: SessionStore,
    record: dict,
    ctx: dict,
    data_root: Path,
    profile: dict,
    result_json: dict,
    version: dict,
    round_no: int,
    feedback: str,
    prev_tex: str,
    prefix: str,
) -> Iterator[dict]:
    """写一轮论文并排版：yield 工具卡/门禁事件，最后 yield 一个 outcome 事件。

    outcome.data = {ok, tex, source, error}。阶段五首轮与阶段六优化轮共用。
    """
    delay = _workflow_delay()
    paper_dir = paper_build.workspace(data_root)
    picked = record.get("picked") or {}
    provider = ctx.get("provider")
    yield _tool(
        f"{prefix}-write", "撰写论文", "running",
        args={"round": round_no, "source": "llm" if provider else "fallback"},
    )
    started = time.monotonic()
    source = "llm"
    try:
        if provider:
            tex, source = paper_gen.generate(
                provider, ctx.get("api_key") or "", ctx.get("model") or record.get("model") or "",
                question_source(record["problem"]), picked, profile, result_json,
                feedback=feedback, prev_tex=prev_tex,
                should_stop=ctx.get("should_stop"), on_delta=ctx.get("on_delta"),
            )
        else:
            tex = paper_gen.sample_tex()
            source = "fallback"
        write_error = ""
    except llm.LlmError as exc:
        tex, write_error = "", str(exc)
    draft = paper_dir / "draft.tex"
    if not write_error:
        try:
            paper_dir.mkdir(parents=True, exist_ok=True)
            draft.write_text(tex, encoding="utf-8")
            # 真实求解图放进论文工作区；骨架引用 figures/final/fig1_residual.png。
            figure_src = Path((version.get("outputs") or {}).get("png") or "")
            if figure_src.is_file():
                figure_dst = paper_dir / paper_build.FIGURE_TARGET
                figure_dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(figure_src, figure_dst)
        except OSError as exc:
            write_error = str(exc)
    yield _tool(
        f"{prefix}-write", "撰写论文", "ok" if not write_error else "error",
        args={"round": round_no, "source": source},
        result={
            "ok": not write_error,
            "round": round_no,
            "source": source,
            "lines": len(tex.splitlines()),
            "error": write_error,
        },
        duration_ms=int((time.monotonic() - started) * 1000),
        delay=delay,
    )
    if write_error:
        yield {"event": "outcome", "data": {"ok": False, "tex": "", "source": source, "error": write_error}}
        return
    if source == "fallback":
        note = "没有可用模型，论文暂用演示样例稿兜底（非按本题生成）；配置 Key 后可在论文页重新构建。\n"
        record["messages"].append({"role": "assistant", "content": note})
        store.put(record)
        yield _text_event(note, delay)

    yield _tool(f"{prefix}-build", "排版与门禁", "running", args={"round": round_no})
    started = time.monotonic()
    code, result = paper_build.build(data_root, source=draft)
    seconds = round(time.monotonic() - started, 1)
    gates = result.get("gates") or []
    yield _tool(
        f"{prefix}-build", "排版与门禁", "ok" if code == 0 else "error",
        args={"round": round_no},
        result={
            "ok": code == 0,
            "exit": code,
            "seconds": seconds,
            "gates": [{"id": g.get("id"), "ok": g.get("ok"), "detail": g.get("detail")} for g in gates],
            "error": result.get("error"),
        },
        duration_ms=int(seconds * 1000),
        delay=delay,
    )
    for gate in gates:
        yield {
            "event": "gate",
            "data": {
                "skill": str(gate.get("id") or ""),
                "ok": bool(gate.get("ok")),
                "exit": 0 if gate.get("ok") else 1,
                "summary": str(gate.get("detail") or ""),
            },
        }
    yield {
        "event": "outcome",
        "data": {"ok": code == 0, "tex": tex, "source": source, "error": result.get("error") or ""},
    }


def _p5_profile(data_root: Path, workspace: str) -> dict:
    code_dir = data_root / "workbench" / "code"
    located = baseline.find_data(Path(workspace)) if workspace else None
    if located is None and (code_dir / baseline.SAMPLE_NAME).is_file():
        located = code_dir / baseline.SAMPLE_NAME
    return baseline.profile_data(located) if located else {}


def _phase5_paper(
    store: SessionStore,
    record: dict,
    workspace: str,
    ctx: dict,
    result_json: dict,
    version: dict,
) -> Iterator[dict]:
    """阶段五：LLM 按真实结果写论文 → 排版 → 门禁；失败回喂修复 ≤3 轮。

    没有可用模型时回退演示样例稿并标明兜底；缺排版工具时阶段五判 failed。
    成功后链入阶段六真实评分。
    """
    delay = _workflow_delay()
    data_root = session_scope(store.path.parent, record.get("id"))
    paper_dir = paper_build.workspace(data_root)
    provider = ctx.get("provider")
    set_phase(record, 5, "running")
    store.put(record)
    yield phase_event(5, "running")

    env = paper_build.env_status()
    if not env["ok"]:
        text = "阶段五失败：缺少排版工具（" + "、".join(env["missing"]) + "）。装好后在工作台论文页重试构建。"
        set_phase(record, 5, "failed")
        _close_phase4(store, record, text)
        yield phase_event(5, "failed", "缺排版工具")
        yield _text_event(text, delay)
        return

    profile = _p5_profile(data_root, workspace)
    prev_tex = ""
    feedback = ""
    outcome: dict = {}
    for round_no in range(1, P5_MAX_ROUNDS + 1):
        for ev in _build_paper_once(
            store, record, ctx, data_root, profile, result_json, version,
            round_no, feedback, prev_tex, "p5",
        ):
            if ev["event"] == "outcome":
                outcome = ev["data"]
            else:
                yield ev
        if outcome.get("ok"):
            break
        if not outcome.get("tex"):
            text = f"阶段五失败：论文生成不可用（{outcome.get('error')}）。"
            set_phase(record, 5, "failed")
            _close_phase4(store, record, text)
            yield phase_event(5, "failed", "论文生成失败")
            yield _text_event(text, delay)
            return
        prev_tex = outcome["tex"]
        feedback = str(outcome.get("error") or "构建未通过")
        if round_no < P5_MAX_ROUNDS and provider:
            note = f"第 {round_no} 轮未过门禁/编译，把问题回喂模型修复。\n"
            record["messages"].append({"role": "assistant", "content": note})
            store.put(record)
            yield _text_event(note, delay)
            continue
        break

    if outcome.get("ok"):
        artifacts = paper_build.state(data_root).get("artifacts") or {}
        deliverables = {
            kind: str((artifacts.get(kind) or {}).get("path") or "")
            for kind in ("pdf", "docx")
            if artifacts.get(kind)
        }
        project_export.copy_outputs(workspace, "论文", deliverables)
        headline = (
            "阶段五完成：论文已按真实求解结果生成并排版。"
            if outcome.get("source") == "llm"
            else "阶段五完成：论文已排版（离线兜底样例稿，非按本题生成）。"
        )
        text = (
            f"{headline}\n"
            f"- 产物：paper.pdf / paper.docx（{paper_dir}）\n"
            "- 三道交付门禁全绿（去 AI 措辞 / 结构指标 / 章节结构）\n"
            "进入阶段六：按评分口径评审论文。"
        )
        set_phase(record, 5, "passed")
        record["messages"].append({"role": "assistant", "content": text})
        record["pending"] = None
        store.put(record)
        yield phase_event(5, "passed", "论文 PDF/DOCX 已产出，门禁全绿")
        yield {"event": "artifact", "data": {"kind": "paper", "outputs": deliverables}}
        yield _text_event(text, delay)
        yield from _phase6_score(store, record, workspace, ctx, result_json, version, profile)
        return

    error = str(outcome.get("error") or "构建失败")
    text = (
        f"阶段五失败（已用尽 {P5_MAX_ROUNDS} 轮修复）：{error}\n"
        "可在论文页查看日志并手动重试构建。"
    )
    set_phase(record, 5, "failed")
    _close_phase4(store, record, text)
    yield phase_event(5, "failed", error[:120])
    yield _text_event(text, delay)


P6_MAX_ROUNDS = 3


def _score_feedback(card: dict) -> str:
    lines: list[str] = []
    for dim in card.get("dimensions") or []:
        for item in dim.get("deductions") or []:
            lines.append(
                f"[{dim.get('id')}] {item.get('item')}（-{item.get('penalty')}）"
                f"位置：{item.get('target') or '未标注'}；改法：{item.get('suggestion') or '无'}"
            )
    return "\n".join(lines) or "无扣分明细"


def _phase6_score(
    store: SessionStore,
    record: dict,
    workspace: str,
    ctx: dict,
    result_json: dict,
    version: dict,
    profile: dict,
) -> Iterator[dict]:
    """阶段六：LLM 按 rubric 评审真实论文；S<85 回喂扣分修复，≤3 轮熔断。

    一票否决直接淘汰、不进优化循环；没有可用模型时用演示评分卡并标明兜底。
    """
    delay = _workflow_delay()
    data_root = session_scope(store.path.parent, record.get("id"))
    paper_dir = paper_build.workspace(data_root)
    provider = ctx.get("provider")
    set_phase(record, 6, "running")
    store.put(record)
    yield phase_event(6, "running")

    prev_card: dict | None = None
    last_data: dict = {}
    for round_no in range(1, P6_MAX_ROUNDS + 1):
        tex_path = paper_dir / "paper.tex"
        try:
            tex = tex_path.read_text(encoding="utf-8")
        except OSError as exc:
            text = f"阶段六失败：读不到论文稿件（{exc}）。"
            set_phase(record, 6, "failed")
            _close_phase4(store, record, text)
            yield phase_event(6, "failed", "稿件缺失")
            yield _text_event(text, delay)
            return

        yield _tool("p6-score", "评分", "running", args={"round": round_no})
        started = time.monotonic()
        source = "llm"
        try:
            if provider:
                card, source = score_gen.generate(
                    provider, ctx.get("api_key") or "", ctx.get("model") or record.get("model") or "",
                    tex, round_no, prev_card=prev_card,
                    should_stop=ctx.get("should_stop"), on_delta=ctx.get("on_delta"),
                )
            else:
                card = score_gen.demo_card(round_no)
                source = "fallback"
            score_error = ""
        except llm.LlmError as exc:
            card, score_error = {}, str(exc)
        if not score_error:
            try:
                workbench_score.save_card(data_root, card)
                state = workbench_score.state(data_dir=data_root)
                last_data = next(
                    (r for r in state.get("rounds", []) if r.get("round") == round_no), {}
                )
            except (RuntimeError, OSError, ValueError) as exc:
                score_error = str(exc)
        seconds = round(time.monotonic() - started, 1)
        yield _tool(
            "p6-score", "评分", "ok" if not score_error else "error",
            args={"round": round_no},
            result={
                "ok": not score_error,
                "round": round_no,
                "source": source,
                "total": last_data.get("total"),
                "pass": last_data.get("pass"),
                "veto": last_data.get("veto"),
                "error": score_error,
            },
            duration_ms=int(seconds * 1000),
            delay=delay,
        )
        if score_error:
            text = f"阶段六失败：评分不可用（{score_error}）。"
            set_phase(record, 6, "failed")
            _close_phase4(store, record, text)
            yield phase_event(6, "failed", "评分失败")
            yield _text_event(text, delay)
            return
        if source == "fallback":
            note = "没有可用模型，评分暂用演示评分卡兜底（非按本论文评审）；配置 Key 后可重新评分。\n"
            record["messages"].append({"role": "assistant", "content": note})
            store.put(record)
            yield _text_event(note, delay)

        total = last_data.get("total")
        passed = bool(last_data.get("pass"))
        veto = bool(last_data.get("veto"))
        if passed or veto:
            break
        prev_card = card
        if round_no < P6_MAX_ROUNDS and provider:
            note = f"第 {round_no} 轮总分 {total} < 85，把扣分明细回喂模型修改论文。\n"
            record["messages"].append({"role": "assistant", "content": note})
            store.put(record)
            yield _text_event(note, delay)
            feedback = "评分未达标，请按以下扣分明细逐条修改论文：\n" + _score_feedback(card)
            outcome: dict = {}
            for ev in _build_paper_once(
                store, record, ctx, data_root, profile, result_json, version,
                round_no, feedback, tex, "p6-fix",
            ):
                if ev["event"] == "outcome":
                    outcome = ev["data"]
                else:
                    yield ev
            if not outcome.get("ok"):
                text = f"阶段六中断：第 {round_no} 轮修改后排版未通过（{outcome.get('error')}）。"
                set_phase(record, 6, "failed")
                _close_phase4(store, record, text)
                yield phase_event(6, "failed", "优化轮排版失败")
                yield _text_event(text, delay)
                return
            continue
        break

    total = last_data.get("total")
    passed = bool(last_data.get("pass"))
    veto = bool(last_data.get("veto"))
    breaker = bool(last_data.get("breaker"))
    if veto:
        text = (
            "阶段六结束：触发一票否决（身份信息/页眉等红线），直接淘汰、不计分。\n"
            "请删除红线内容后重新构建论文并评分。"
        )
        set_phase(record, 6, "failed")
    elif passed:
        text = f"阶段六完成：总分 {total} ≥ 85，达标。全流程跑通。"
        set_phase(record, 6, "passed")
    elif breaker:
        text = (
            f"阶段六熔断：{P6_MAX_ROUNDS} 轮优化后总分 {total} 仍 < 85，"
            "未达 85 分标准，需人工复核。扣分明细见评分页。"
        )
        set_phase(record, 6, "failed")
    else:
        text = f"阶段六结束：总分 {total} < 85，需针对性优化后重新评分。"
        set_phase(record, 6, "failed")
    _close_phase4(store, record, text)
    yield phase_event(6, "passed" if passed else "failed", f"总分 {total}")
    yield {"event": "artifact", "data": {"kind": "score", "outputs": {"round": str(last_data.get("round") or 1)}}}
    yield _text_event(text, delay)
