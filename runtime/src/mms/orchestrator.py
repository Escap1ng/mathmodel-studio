"""M3 编排状态机：起题 → K2 确认 → K3 选模 → 选择后进入阶段四。

M3 的内容生成是确定性的：题面按小节切分，候选来自内置方法族模板，
不冒充模型判断。真实模型参与选模放在 M4；这里先把「暂停/恢复/换一批/
解释不清待选」的语义与落盘做对。
"""

from __future__ import annotations

import re

from .store import SessionStore

PHASE_INTRO = "已收到题目。先按小节把题面拆开；确认题面后再进入算法选择。"

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

DEFAULT_FAMILY = (
    [
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
    ],
)


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
    questions = split_questions(problem)
    return {
        "title": "赛题与附件确认",
        "intro": f"按题面切出 {len(questions)} 个子问题。附件核对需要真实文件，这一步先标出缺口。",
        "questions": [
            {"id": f"q{i + 1}", "text": text, "data": "未附数据文件"}
            for i, text in enumerate(questions)
        ],
        "attachments": [],
        "dataRoles": [],
        "warning": "尚未接入文件上传：没有附件可核对目标列是否为空。确认后按文字题面继续。",
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


def start(store: SessionStore, record: dict) -> list[dict]:
    payload = _problem_payload(record["problem"])
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


def resume(store: SessionStore, record: dict, action: str, choice: str) -> list[dict]:
    pending = record["pending"]
    if not pending:
        raise ValueError("这个会话没有等待中的决策")
    card = pending.get("card")

    if action == "confirm":
        if card != "problem-confirm":
            raise ValueError("当前不是在确认赛题")
        _resolve_interrupt(record, "已确认")
        set_phase(record, 1, "passed")
        set_phase(record, 2, "passed")
        set_phase(record, 3, "waiting")
        payload = _model_payload(record["problem"], record["batch"])
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
        return [
            phase_event(1, "passed"),
            phase_event(2, "passed", "会话数据目录已创建"),
            phase_event(3, "running"),
            {"event": "token", "data": {"text": text}},
            phase_event(3, "waiting"),
            {"event": "interrupt", "data": record["pending"]},
        ]

    if action == "reroll":
        if card != "model-choice":
            raise ValueError("当前不是在选模")
        _resolve_interrupt(record, "已换一批")
        record["batch"] += 1
        payload = _model_payload(record["problem"], record["batch"])
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
        return [
            {"event": "token", "data": {"text": text}},
            {"event": "interrupt", "data": record["pending"]},
        ]

    if action == "choose":
        if card != "model-choice":
            raise ValueError("当前不是在选模")
        candidates = pending.get("payload", {}).get("candidates", [])
        picked = next((c for c in candidates if c.get("id") == choice), None)
        if picked is None:
            raise ValueError("选择的候选不存在")
        _resolve_interrupt(record, f"已选：{picked['name']}")
        set_phase(record, 3, "passed")
        set_phase(record, 4, "running")
        text = f"已选择「{picked['name']}」。阶段三已过，接下来进入代码实现。"
        record["messages"].append({"role": "assistant", "content": text})
        record["pending"] = None
        store.put(record)
        return [
            phase_event(3, "passed"),
            phase_event(4, "running"),
            {"event": "token", "data": {"text": text}},
        ]

    raise ValueError(f"未知动作: {action}")
