"""一键流水线：题面 → 选模 → 生成代码 → 运行修复 → 写论文排版。

没有人工确认卡：模型给出的推荐候选直接采用，失败自动回退确定性路径。
每个阶段的进度通过 emit(event, data) 报给通道层，事件形状见 server.py。
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from pathlib import Path

from mms_gateway import llm
from mms_gateway.provider import CancelledError

from . import baseline, ingest, paper_build, paper_gen

PHASES = [
    {"id": 1, "label": "题面拆解"},
    {"id": 2, "label": "方法选择"},
    {"id": 3, "label": "生成代码"},
    {"id": 4, "label": "运行求解"},
    {"id": 5, "label": "论文排版"},
]

K2_INSTRUCTION = (
    "你是数学建模竞赛的题面分析助手。把用户给出的赛题拆成子问题，并核对附件的数据角色。"
    "只输出一个 JSON 对象，不要围栏、不要解释，形状："
    '{"questions":[{"id":"q1","text":"子问题描述","data":"所需数据说明"}],'
    '"dataRoles":[{"file":"文件名","role":"训练集/预测集/共用","note":"判断依据"}],'
    '"warning":"数据缺口或风险提醒"}。'
    "questions 最多 6 条，text 忠实于题面、不改写原意；数据没给就写「未附数据文件」。"
)

K3_INSTRUCTION = (
    "你是数学建模竞赛的方法选型助手。针对题面给出恰好 3 条候选路线，"
    "其中至少 1 条具备明显创新性，并标出恰好一条 recommended。"
    "只输出一个 JSON 对象，不要围栏、不要解释，形状："
    '{"candidates":[{"name":"方法名","idea":"核心思路","innovation":"高/中/低",'
    '"interpretability":"高/中/低","difficulty":"高/中/低","eta":"预计耗时",'
    '"accuracy":"精度与鲁棒性预期","math":"数学形式","fit":"为何适配本题",'
    '"diff":"与未选方案的差异","verify":"验证方式","recommended":true,"reason":"一句推荐理由"}]}。'
)

SELECTION_GUIDE = (
    "选型原则：拟合性优先于高级性；能用初等方法解决的不用高等方法；"
    "创新落点明确（建模/求解/结果/推广其一）。"
    "问题特征参考：时序预测→ARIMA/Prophet/LSTM，小样本 GM(1,1)；评价排序→熵权-TOPSIS/AHP；"
    "0-1 变量→整数规划+遗传算法；机理演化→微分方程组+RK4+敏感性分析；"
    "路径配送→TSP/VRP+GA/蚁群；插值补全→三次样条。"
)

P4_INSTRUCTION = (
    "你是数学建模竞赛的求解代码生成助手。按题面、所选方法与数据画像，写一个完整可运行的 Python 脚本 solution.py。"
    "只输出一个 JSON 对象，不要围栏、不要解释，形状："
    '{"rationale":"两三句实现思路","code":"完整 Python 源码"}。'
    "脚本硬性契约：用 argparse 接受 --data（一个或多个 CSV/TSV 路径，nargs='+'，按附件顺序传入）与 --out（输出目录）；"
    "在 --out 写出 result.json（含 ok、rows、cols、target、datasets 与本题关键数值结果）"
    "和 figure.png / figure.pdf / figure.svg 三件图（matplotlib 用 Agg 后端，dpi≥150）；"
    "只用标准库 + numpy + matplotlib，不依赖 pandas / scikit-learn；"
    "数据编码按 utf-8-sig / gbk / utf-8 依次尝试；固定随机种子保证可复现；"
    "不得联网、不得读写 --data/--out 之外的路径、不得执行系统命令。"
    "只有一份数据时 --data 只有一个路径；多份数据按顺序给出，脚本按题面分别读取，不要假设它们同构。"
    "修复轮次会附上上一版代码与失败输出，请针对性修改后重新输出完整脚本。"
)

P4_MAX_ROUNDS = 3
P5_MAX_ROUNDS = 3

DEFAULT_CANDIDATES = [
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
        "diff": "比时间序列模型更不依赖平稳性假设，但外推能力弱于机制模型。",
        "verify": "按时间切分训练/验证，报告 RMSE 与残差自相关。",
        "recommended": True,
        "reason": "先跑通这条基线的代价最低，结果可直接对照后续模型。",
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
        "recommended": False,
        "reason": "作为透明的对照基线。",
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
        "recommended": False,
        "reason": "作为机制路线的创新对照。",
    },
]


def split_questions(problem: str) -> list[str]:
    text = problem.strip()
    if not text:
        return []
    pattern = r"(?=(?:问题\s*[一二三四五六七八九十0-9]+|（\s*[0-9]+\s*）|\(\s*[0-9]+\s*\)))"
    parts = [p.strip() for p in re.split(pattern, text) if p.strip()]
    if len(parts) < 2:
        parts = [line.strip() for line in text.splitlines() if line.strip()][:3] or [text]
    return [p[:180] for p in parts[:6]]


def _validate_problem(data: dict) -> dict:
    raw = data.get("questions")
    if not isinstance(raw, list) or not raw:
        raise ValueError("questions 必须是非空数组")
    rows: list[dict] = []
    for index, item in enumerate(raw[:6]):
        text = item.get("text") if isinstance(item, dict) else item
        if not str(text or "").strip():
            continue
        rows.append({"id": f"q{index + 1}", "text": str(text).strip()[:300]})
    if not rows:
        raise ValueError("没有可用的子问题")
    return {"questions": rows}


def _normalize_candidate(item: dict, index: int) -> dict:
    explain = item.get("explain") if isinstance(item.get("explain"), dict) else {}
    row = {
        "id": f"c{index + 1}",
        "name": str(item.get("name") or "").strip()[:120],
        "idea": str(item.get("idea") or "").strip()[:300],
        "innovation": str(item.get("innovation") or "中").strip()[:20],
        "interpretability": str(item.get("interpretability") or "中").strip()[:20],
        "difficulty": str(item.get("difficulty") or "中").strip()[:20],
        "eta": str(item.get("eta") or "未估").strip()[:60],
        "accuracy": str(item.get("accuracy") or "").strip()[:120],
        "recommended": item.get("recommended") is True,
        "reason": str(item.get("reason") or "").strip()[:200],
        "explain": {
            "math": str(item.get("math") or explain.get("math") or "").strip()[:500],
            "fit": str(item.get("fit") or explain.get("fit") or "").strip()[:500],
            "diff": str(item.get("diff") or explain.get("diff") or "").strip()[:500],
            "verify": str(item.get("verify") or explain.get("verify") or "").strip()[:500],
        },
    }
    if not row["name"]:
        raise ValueError("候选缺少 name")
    return row


def _validate_candidates(data: dict) -> dict:
    raw = data.get("candidates")
    if not isinstance(raw, list) or not raw or len(raw) > 5:
        raise ValueError("candidates 必须是非空数组（最多 5 条）")
    rows = [_normalize_candidate(item, index) for index, item in enumerate(raw) if isinstance(item, dict)]
    if not rows:
        raise ValueError("没有可用的候选")
    if not any(row["recommended"] for row in rows):
        rows[0]["recommended"] = True
    return {"candidates": rows}


def _validate_code(data: dict) -> dict:
    code = data.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code 必须是非空字符串")
    problems = baseline.validate_script(code)
    if problems:
        raise ValueError("脚本不满足契约：" + "；".join(problems))
    return {"rationale": str(data.get("rationale") or "").strip()[:500], "code": code}


class Pipeline:
    def __init__(
        self,
        job_dir: Path,
        problem: str,
        data_paths: list[Path] | None,
        provider: dict | None,
        api_key: str,
        model: str,
        emit: Callable[[str, dict], None],
        should_stop: Callable[[], bool],
    ) -> None:
        self.job_dir = job_dir
        self.problem = problem.strip()
        self.data_paths = [Path(item) for item in (data_paths or [])]
        self.provider = provider
        self.api_key = api_key
        self.model = model
        self.emit = emit
        self.should_stop = should_stop
        self.questions: list[dict] = []
        self.picked: dict = {}
        self.profile: dict = {}
        self.attachments: dict = {"tables": [], "docs": [], "errors": []}
        self.tables: list[dict] = []
        self.table_paths: list[Path] = []
        self.data_path: Path | None = None
        self.doc_text = ""
        self.sources: dict[str, str] = {}
        self.outputs: dict[str, str] = {}
        self.error = ""
        self.started = time.time()

    # ---------- 事件 ----------

    def _log(self, text: str, level: str = "info") -> None:
        self.emit("log", {"level": level, "text": text})

    def _phase(self, phase_id: int, status: str, detail: str = "") -> None:
        label = next((p["label"] for p in PHASES if p["id"] == phase_id), "")
        data = {"id": phase_id, "label": label, "status": status}
        if detail:
            data["detail"] = detail
        self.emit("phase", data)

    def _progress_delta(self, stage: str) -> Callable[[str, str], None]:
        counter = {"chars": 0, "sent": 0}

        def on_delta(kind: str, text: str) -> None:
            if kind != "token":
                return
            counter["chars"] += len(text)
            if counter["chars"] - counter["sent"] >= 2000:
                counter["sent"] = counter["chars"]
                self.emit("progress", {"stage": stage, "chars": counter["chars"]})

        return on_delta

    # ---------- 主流程 ----------

    def run(self) -> dict:
        try:
            self._prepare_data()
            self._step_problem()
            self._step_method()
            self._step_solve()
            self._step_paper()
        except CancelledError:
            self.error = "已取消"
            self._finish(False, cancelled=True)
            return self.summary()
        except Exception as exc:  # noqa: BLE001  顶层兜底，错误要进事件
            self.error = str(exc) or exc.__class__.__name__
            self._log(self.error, "error")
            self._finish(False)
            return self.summary()
        self._finish(True)
        return self.summary()

    def _prepare_data(self) -> None:
        """把附件统一成 CSV 与文字：主表喂求解脚本，docx 文字并入上下文。"""
        if not self.data_paths:
            return
        try:
            info = ingest.prepare(self.data_paths, self.job_dir / "attachments")
        except Exception as exc:  # noqa: BLE001  附件是外部输入，失败原因必须报给用户
            raise RuntimeError(f"附件解析失败：{exc}") from exc
        self.attachments = info
        for message in info["errors"]:
            self._log(message, "warn")
        tables: list[dict] = info["tables"]
        docs: list[dict] = info["docs"]
        usable = [item for item in tables if item.get("rows", 0) >= 1]
        if usable:
            primary = usable[0]
            self.tables = usable
            self.table_paths = [Path(item["path"]) for item in usable]
            self.data_path = self.table_paths[0]
            where = f"{primary['name']} / {primary['sheet']}" if primary.get("sheet") else primary["name"]
            extra = f"；连同其余 {len(usable) - 1} 张表按序传入脚本" if len(usable) > 1 else ""
            self._log(
                f"附件：{len(tables)} 张表、{len(docs)} 份文字；主表 {where}"
                f"（{primary['rows']} 行 × {primary['cols']} 列{extra}）。"
            )
        elif docs or tables:
            self._log("附件里没有可用的表格数据，求解用内置示例数据，附件文字并入题面上下文。", "warn")
        elif not info["errors"]:
            raise RuntimeError("附件里没有可用的表格或文字：" + "、".join(p.name for p in self.data_paths))
        else:
            raise RuntimeError("附件无法解析：" + "；".join(info["errors"]))
        if docs:
            self.doc_text = "\n\n".join(item["text"] for item in docs)[:8000]
            self._log("附件文字：" + "；".join(f"{item['name']}（{item['chars']} 字）" for item in docs))

    def _step_problem(self) -> None:
        self._phase(1, "running")
        if len(self.problem) < 10:
            raise RuntimeError("题面太短：至少写一句完整的题目描述")
        questions = [
            {"id": f"q{index + 1}", "text": text}
            for index, text in enumerate(split_questions(self.problem))
        ]
        source = "按小节切分"
        if self.provider:
            user = f"题面：\n{self.problem}\n\n{self._doc_block()}数据画像：\n{self._profile_json()}"
            try:
                parsed = llm.complete_json(
                    self.provider, self.api_key, self.model, "k2-problem",
                    K2_INSTRUCTION, user, _validate_problem,
                    should_stop=self.should_stop, on_delta=self._progress_delta("题面拆解"),
                )
                questions = parsed["questions"]
                source = "模型拆解"
            except llm.LlmError as exc:
                self._log(f"模型拆题不可用（{exc}），按小节切分。", "warn")
        self.questions = questions
        self.sources["questions"] = source
        names = "；".join(q["text"][:40] for q in questions[:3])
        self._log(f"{source}：{len(questions)} 个子问题。{names}")
        self._phase(1, "ok", f"{len(questions)} 个子问题")

    def _step_method(self) -> None:
        self._phase(2, "running")
        candidates: list[dict] = []
        source = "内置方法族"
        if self.provider:
            user = (
                f"题面：\n{self._problem_with_questions()}\n\n数据画像：\n{self._profile_json()}\n\n"
                f"{SELECTION_GUIDE}"
            )
            try:
                parsed = llm.complete_json(
                    self.provider, self.api_key, self.model, "k3-models",
                    K3_INSTRUCTION, user, _validate_candidates,
                    should_stop=self.should_stop, on_delta=self._progress_delta("方法选择"),
                )
                candidates = parsed["candidates"]
                source = "模型推荐"
            except llm.LlmError as exc:
                self._log(f"模型选模不可用（{exc}），使用内置方法族。", "warn")
        if not candidates:
            candidates = [_normalize_candidate(item, index) for index, item in enumerate(DEFAULT_CANDIDATES)]
        picked = next((c for c in candidates if c.get("recommended")), candidates[0])
        self.picked = picked
        self.sources["method"] = source
        self._log(f"{source}：采用「{picked['name']}」——{picked.get('reason') or picked.get('idea') or ''}")
        self._phase(2, "ok", picked["name"])

    def _step_solve(self) -> None:
        code_dir = self.job_dir / "code"
        out_dir = code_dir / "outputs"
        code_dir.mkdir(parents=True, exist_ok=True)
        sample = not self.table_paths
        data_paths = list(self.table_paths)
        if not data_paths:
            data_paths = [baseline.ensure_sample(code_dir)]
            self._log("没有可用的表格数据，使用内置示例数据 sample.csv 跑通链路。", "warn")
        self.data_path = data_paths[0]
        self.profile = baseline.profile_data(self.data_path)
        self._log(
            f"数据：{len(data_paths)} 个文件，主表 {self.data_path.name}（{self.profile.get('rows', '?')} 行 × "
            f"{self.profile.get('cols', '?')} 列{'，示例数据' if sample else ''}）"
        )

        self._phase(3, "running")
        feedback = ""
        code = ""
        for round_no in range(1, P4_MAX_ROUNDS + 1):
            if self.provider:
                user = self._p4_user(feedback)
                try:
                    parsed = llm.complete_json(
                        self.provider, self.api_key, self.model, "p4-code",
                        P4_INSTRUCTION, user, _validate_code,
                        should_stop=self.should_stop, on_delta=self._progress_delta("生成代码"),
                    )
                    code = parsed["code"]
                    self.sources["code"] = "模型生成"
                except llm.LlmError as exc:
                    self._log(f"第 {round_no} 轮代码生成失败（{exc}）。", "warn")
                    code = ""
            if not code:
                code = baseline.SCRIPT
                self.sources["code"] = "内置基线"
            script = code_dir / baseline.SCRIPT_NAME
            script.write_text(code, encoding="utf-8")
            self._log(f"第 {round_no} 轮：solution.py 已写入（{len(code.splitlines())} 行，{self.sources['code']}）。")
            self._phase(3, "ok", f"solution.py · {len(code.splitlines())} 行")

            self._phase(4, "running")
            run = baseline.run_baseline(code_dir, data_paths, out_dir)
            if run.get("ok"):
                stats = run.get("result") or {}
                self.outputs = {
                    "dir": str(self.job_dir),
                    "code": str(script),
                    "resultJson": str(out_dir / "result.json"),
                    **{kind: path for kind, path in (run.get("outputs") or {}).items()},
                }
                fit = ""
                if isinstance(stats.get("r2"), (int, float)):
                    fit = f"R²={stats['r2']:.3f}，RMSE={stats['rmse']:.3f}"
                self._log(f"运行通过：{fit or '关键数值见 result.json'}")
                self._phase(4, "ok", fit or "脚本运行通过")
                return

            error_text = (run.get("stderr") or run.get("stdout") or "").strip()
            tail = " ".join(error_text.split())[-300:]
            self._log(f"第 {round_no} 轮运行失败（退出 {run.get('exit')}）：{tail}", "error")
            if not self.provider or round_no >= P4_MAX_ROUNDS:
                self._phase(4, "error", f"脚本失败（退出 {run.get('exit')}）")
                raise RuntimeError(
                    f"求解脚本运行失败（退出 {run.get('exit')}）"
                    + ("，已用尽修复轮次" if round_no >= P4_MAX_ROUNDS else "")
                    + (f"：{tail}" if tail else "")
                )
            feedback = (
                f"这是第 {round_no + 1} 轮修复。上一版代码运行失败，失败输出（尾部）：\n{error_text[-1500:]}\n\n"
                f"上一版代码：\n{code[:8000]}"
            )

    def _step_paper(self) -> None:
        self._phase(5, "running")
        env = paper_build.env_status()
        if not env["ok"]:
            self._phase(5, "error", "缺排版工具")
            self._log("缺少排版工具（" + "、".join(env["missing"]) + "），求解结果已保留，论文未生成。", "error")
            self.outputs["paperError"] = "缺少排版工具：" + "、".join(env["missing"])
            raise RuntimeError("缺少排版工具：" + "、".join(env["missing"]))

        workdir = self.job_dir / "paper"
        source_tex = workdir / "draft.tex"
        workdir.mkdir(parents=True, exist_ok=True)
        figure = Path(self.outputs.get("png") or "") if self.outputs.get("png") else None
        feedback = ""
        prev_tex = ""
        last_error = ""
        for round_no in range(1, P5_MAX_ROUNDS + 1):
            tex = ""
            source = "模型撰写"
            if self.provider:
                try:
                    tex = paper_gen.generate(
                        self.provider, self.api_key, self.model,
                        self._problem_with_questions(), self.picked, self.profile,
                        self._result_json(), feedback=feedback, prev_tex=prev_tex,
                        should_stop=self.should_stop,
                        on_delta=self._progress_delta("论文排版"),
                    )
                except llm.LlmError as exc:
                    self._log(f"第 {round_no} 轮论文生成失败（{exc}），改用演示样例稿。", "warn")
            if not tex:
                tex = paper_gen.sample_tex()
                source = "样例稿（兜底）"
            self.sources["paper"] = source
            source_tex.write_text(tex, encoding="utf-8")
            self._log(f"第 {round_no} 轮：论文稿 {len(tex.splitlines())} 行（{source}），开始排版。")

            ok, payload = paper_build.build(workdir, source_tex, figure)
            if ok:
                artifacts = payload.get("artifacts") or {}
                self.outputs.update(
                    {
                        "paperPdf": artifacts.get("pdf", ""),
                        "paperDocx": artifacts.get("docx", ""),
                        "paperTex": artifacts.get("tex", ""),
                    }
                )
                self._log("排版通过：paper.pdf / paper.docx 已生成。")
                self._phase(5, "ok", "paper.pdf / paper.docx")
                return

            last_error = str(payload.get("error") or "排版未通过")
            self._log(f"第 {round_no} 轮排版失败：{last_error}", "error")
            if not self.provider or round_no >= P5_MAX_ROUNDS:
                break
            feedback = last_error + "\n" + str(payload.get("logTail") or "")
            prev_tex = tex

        self._phase(5, "error", last_error[:120])
        raise RuntimeError(f"论文排版失败（已用尽 {P5_MAX_ROUNDS} 轮）：{last_error}")

    # ---------- 上下文 ----------

    def _problem_with_questions(self) -> str:
        if not self.questions:
            return self.problem
        lines = "\n".join(f"- {q['text']}" for q in self.questions)
        return f"{self.problem}\n\n拆出的子问题：\n{lines}\n\n{self._doc_block()}"

    def _doc_block(self) -> str:
        if not self.doc_text:
            return ""
        return f"附件文字（节选）：\n{self.doc_text}\n\n"

    def _profile_json(self) -> str:
        if not self.profile and self.data_path is not None:
            self.profile = baseline.profile_data(self.data_path)
        if not self.profile:
            return "无（未选择数据文件）"
        payload = dict(self.profile)
        others = [item for item in self.attachments.get("tables") or [] if item["path"] != str(self.data_path)]
        if others:
            payload["otherTables"] = [
                {"name": item["name"], "sheet": item.get("sheet", ""), "rows": item["rows"], "cols": item["cols"]}
                for item in others[:10]
            ]
        return json.dumps(payload, ensure_ascii=False)[:4000]

    def _result_json(self) -> dict:
        path = Path(self.outputs.get("resultJson") or "")
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _p4_user(self, feedback: str) -> str:
        explain = self.picked.get("explain") or {}
        parts = [
            f"题面：\n{self._problem_with_questions()}",
            (
                f"所选方法：{self.picked.get('name')}\n核心思路：{self.picked.get('idea')}\n"
                f"数学形式：{explain.get('math') or '无'}\n验证方式：{explain.get('verify') or '无'}"
            ),
            "数据画像：\n" + self._profile_json(),
        ]
        if self.tables:
            lines = []
            for index, item in enumerate(self.tables, 1):
                name = item["name"] + (f" / {item['sheet']}" if item.get("sheet") else "")
                lines.append(
                    f"{index}. {name}（{item['rows']} 行 × {item['cols']} 列，文件 {Path(item['path']).name}）"
                )
            parts.append(
                "求解脚本运行时 --data 会按下列顺序给出这些 CSV；不同表的列结构可能不同，按题面分别读取：\n"
                + "\n".join(lines)
            )
        if feedback:
            parts.append(feedback)
        return "\n\n".join(parts)

    # ---------- 收尾 ----------

    def summary(self) -> dict:
        attachments = {
            "tables": [
                {"name": item["name"], "sheet": item.get("sheet", ""), "rows": item["rows"], "cols": item["cols"]}
                for item in self.attachments.get("tables") or []
            ],
            "docs": [{"name": item["name"], "chars": item["chars"]} for item in self.attachments.get("docs") or []],
            "errors": self.attachments.get("errors") or [],
        }
        return {
            "ok": not self.error,
            "error": self.error,
            "problem": self.problem,
            "questions": self.questions,
            "picked": self.picked,
            "data": str(self.data_path or ""),
            "attachments": attachments if self.data_paths else {},
            "sources": self.sources,
            "outputs": {key: value for key, value in self.outputs.items() if value},
            "seconds": round(time.time() - self.started, 1),
        }

    def _finish(self, ok: bool, cancelled: bool = False) -> None:
        summary = self.summary()
        try:
            (self.job_dir / "summary.json").write_text(
                json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass
        data = {
            "ok": ok,
            "outputs": summary["outputs"],
            "error": self.error,
            "picked": self.picked.get("name", ""),
            "sources": self.sources,
            "seconds": summary["seconds"],
        }
        if cancelled:
            data["cancelled"] = True
        self.emit("done", data)
