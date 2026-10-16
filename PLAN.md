# mathmodel-studio · 前期调研与实施方案

日期 2026-10-16 ｜ 状态：待你定第 9 节三项，之后从 M0 开工

## 0 已锁定的四个决策

| 项 | 结论 |
|---|---|
| skills 内容来源 | vendor 一份进新仓库，保留出处（`mathmodel-kit` v2.0.1，同作者 Apache-2.0） |
| Agent 运行时 | 自研 Python runtime，BYOK 任意模型（不绑 Claude Code） |
| v1 边界 | 先做桌面 shell + 编排闭环（选模/解释/门禁/评分），完整排版编译放 M5 |
| 打包形态 | 内置便携 Python 运行时（bundled `uv` + python-build-standalone） |

一句话定位：**本地、可审计、人在环的数模工作台**。赛道里"全自动无需人工干预"已经有人占了（见第 2 节），我们反着打：每个关键判断都交给参赛者点一下，并且每个数字都能追到脚本产物。

---

## 1 源项目能继承什么

`Escap1ng/mathmodel-kit`（★6，pushed 2026-09-18，v2.0.1）拆开看是四层资产：

| 层 | 现成资产 | 桌面端要做的事 |
|---|---|---|
| 编排 | `mathmodel-core/SKILL.md` 阶段零～六强制流程：环境预检 → 赛题分析 → 工作目录 → 算法选择 → 代码实现 → 论文输出 → 评分优化（S≥85、熔断 3 轮） | 阶段变成**可视轨道 + 可中断状态机**，不再只是一段提示词 |
| 契约 | `skills/manifest.json` 单一事实源（kind: core/knowledge/tool、contribution: open/maintainer）；CLI 退出码统一 `0 成功 / 1 校验或渲染失败 / 2 用法或环境错误`；接口稳定性分 Stable / Experimental / Internal 三档；JSON Schema Draft 2020-12 内容契约 | 注册表**扩展出 UI 元数据**（见 6.2），让界面从数据渲染而不硬编码 |
| 内容 | 7 个技能、25 个模板（`mathmodel-figure` 20 个 matplotlib + `mathmodel-diagram` 5 个 JSON 驱动版式，按文件树实数）、6 项 Python 依赖、中英双语音料 | 原样 vendor，加 provenance 记录 |
| 门禁 | `deai`：`check_phrasing.py`（词表）/`check_style.py`（结构）/`strip_invisible.py`（字符）；`score`：`check_chapters.py`（章节门槛）/`score_card.py`（五维 30/20/20/15/15）；CI 校验 manifest ↔ 目录 ↔ README 表 ↔ 徽章计数 | 门禁结果**从退出码升格成界面元素**（门禁条 + 可点击定位） |

kit 的三个缺口，正是这个产品的全部工作量：**没有 UI**、**没有 provider 层**（模型由宿主 agent 决定）、**没有持久化状态**（中断即丢，谈不上"人在环"）。

---

## 2 同类项目对照

星数与日期为 2026-10-16 `gh api` 实测。

| 项目 | 规模 | 形态 | 技能机制 | 人在环 | 对我们的意义 |
|---|---|---|---|---|---|
| `jihe520/MathModelAgent` | ★6211，pushed 2026-10-03，主语言报 TeX | FastAPI + Vue3/Vite/reka-ui/marked/katex + Docker + **官方桌面版** | 11 个 skill：`1start`…`6verity` + `mathmodel-to-ei`/`doctor`/`typst-author`/`figure-templates`/`_references`；17 套 Typst 模板；9 步自动验收 | **明确写"无需人工干预"** | 头号对手。它的桌面版做法是**内置 Claude Code + 全套 skill，UI 只做壳**——所以我们自研 runtime 是差异点不是重复；它的 Vue 依赖清单（marked/katex/highlight.js/lucide/motion）是现成的渲染器 checklist |
| `LKQ667/metamath-harness` | ★22，pushed 2026-09-24 | DeepSeek Harness 增强套件 | `.dsh/skills/` 下 `math-paper-cn`/`-en`/`-huashu`，step0–5 硬门禁直通 LaTeX/PDF | 手动 Skill 卡片 | 门禁强度可参照：它按**编译后 PDF 的实际页面坐标**核对"符号说明标题 → 符号表 → 问题一"阅读顺序，并拒绝复用过期编译产物。**教训**：桌宠插件 2026-09-20 下架，官方原因是"常驻动画渲染造成卡顿" |
| `CherryHQ/cherry-studio` | ★52672，pushed 2026-10-16 | Electron 44 + electron-vite + React 19 | `resources/skills/*/` + builtin-agents；agent 模式 spawn Claude Code CLI | 选项卡式提问 | **便携 Python 的生产级实现**：`src/main/services/binaryManager/pythonRuntime.ts`（6047 B）钉 `DEFAULT_VERSION = '3.12.13'`，中国镜像走 `registry.npmmirror.com/-/binary/python-build-standalone`，注释第 77 行写"绝不收养系统解释器，只认自己的安装目录"。三栏 shell + 右栏命名预设 + `@cherrystudio/file-preview`(PDF/DOCX/SVG) + 本机 OpenAI 兼容网关。**避坑**：CVE-2025-61929，`cherrystudio://` 自定义协议一键装 MCP 导致 RCE |
| `lobehub/lobehub`（原 lobe-chat 已改名） | ★83267，pushed 2026-10-16 | Electron 薄壳 over Next.js | `packages/builtin-skills/src/manifests.ts` → `BuiltinSkillManifest[]`，每个技能 `manifest.ts` + `content.ts` | artifact canvas | `native-deps.config.mjs`：为 Vite 自动 externalize `.node`、从 asar 解包、剔除非目标平台 prebuild —— Windows 打包直接抄这段 |
| `Mintplex-Labs/anything-llm` | ★67180 | React+Vite + Node server:3001 + collector | workspace 隔离向量集 | 会话级 | **反面教材**：`CONTRIBUTING.md` 自述桌面壳是把核心代码复制进私有仓库维护 → 单仓不要拆 |
| `janhq/jan` | ★44963，主语言 Rust | Tauri + Next.js | 引擎 Cortex/llama.cpp | — | 本机 `127.0.0.1:1337` OpenAI 兼容服务；`src-tauri/utils/src/http.rs` 白名单只放 loopback/RFC1918/link-local 字面量、拒公网地址（防 DNS rebinding）——我们绑端口时照抄这个校验 |
| `open-webui/open-webui` | ★155958 | Svelte5 由 FastAPI 直供 | — | — | "一个 Python 进程同时供 UI 与 API"跑得动；但桌面故事靠第三方壳 |

三条收敛结论：

1. **栈**：可比项目约 8:2 收敛在 Electron + React + Vite + electron-builder，agent 作为子进程（stdio JSON-RPC 或 localhost HTTP+SSE），不是 Tauri。OpenCode 在 2026-04 从 Tauri 回退 Electron，理由是各平台 WebKit 渲染漂移、内置 CLI 启动延迟、Windows 启动不稳。**本机也验证过 Tauri 走不通**（第 3 节）。
2. **交互词汇**已被验证：三栏布局、流式工具卡、`AskUserQuestion` 式可点选项卡、按 prompt 建 checkpoint 并可回滚（代码/对话/两者）。
3. **空位**：所有开源数模 agent 的界面都停在"能用"，商业桌面版（B 站那几个全自动论文生成器）界面是十年前的 Win32 味。**白底 + 精致 + 人在环**这一格没人占。

---

## 3 本机实测（可行性的钉子）

全部由本轮命令产出，不是推断。

| 检查 | 结果 | 影响 |
|---|---|---|
| `node -v` / `npm -v` | v24.18.1 / 11.16.0 | Electron 可开发 |
| `python -V` | 3.14.5；`numpy 2.4.4` `matplotlib 3.10.9` `seaborn 0.13.2` `pandas 2.3.3` `jsonschema 4.26.0` `PyMuPDF 1.28.0` `python-docx 1.2.0` 均可 import | kit 的 6 项依赖在本机已满足，工具层能立刻跑 |
| `rustc` / `cargo` | 1.98.0 / 1.98.0，host `x86_64-pc-windows-msvc` | 看着能装 Tauri，实则 |
| `where link.exe` | 命中 `D:\git\usr\bin\link.exe` → `link (GNU coreutils) 8.32`，**不是 MSVC 链接器** | 假阳性，必须辨认 |
| VS / Windows SDK | `C:\Program Files\Microsoft Visual Studio` 不存在；`Windows Kits\10\Lib` 不存在；`cl.exe` 找不到 | **Tauri 在本机不可构建**，Electron 是唯一路 |
| `xelatex` | MiKTeX-XeTeX 4.16（MiKTeX 25.12） | M5 排版可本地真跑 |
| `pandoc` | command not found | M5 前需补装，进阶段零预检清单 |
| `registry.npmjs.org` | `npm view electron` 25 s 超时 | 直连不可用 |
| `registry.npmmirror.com` | 200，1.37 s；Electron 二进制镜像 HEAD → 302 | **镜像可用**，装依赖走 npmmirror |
| `github.com:443` | `curl` 超时；同一时刻 `gh api` 全程正常 | api 通道 ≠ git 通道，push/release 需备代理，写进手册不自动执行 |
| `pypi.tuna.tsinghua.edu.cn` | 本轮 20 s 超时 | Python 依赖走 npmmirror 的 python-build-standalone + pip 镜像，且失败要换手段重试 |
| `gh auth status` | 已登录 `Escap1ng`，token 含 `repo` `delete_repo` `workflow` | 建仓与 Actions 可行 |

---

## 4 产品形态与交互设计

### 4.1 窗口（以 1440×900 为基准，最小 1100×700）

```
┌──────────┬───────────────────────────────┬──────────────────┐
│ 左栏 240 │  中栏 · 对话流（正文列宽 760）  │ 右栏 400–480     │
│          │                               │ 可折叠成 48 图标条│
│ 赛题会话  │  用户消息                      │                  │
│ 列表      │  Agent 流式回复                │ 标签页：          │
│          │  ▸ 工具卡（模板 id / 退出码 /  │  图表 · 论文 ·    │
│ ──────── │    耗时，可展开 stderr）        │  代码 · 评分 ·    │
│ 阶段轨道  │  ▸ 选模卡（见 4.3 K3）         │  门禁 · 日志      │
│ 零…六     │  ▸ 门禁失败条（可点定位）      │                  │
│ 每阶段    │                               │ 预览：pdf.js 渲染 │
│ 状态点 +  │  ┌──────────────────────────┐ │ paper.pdf、图片  │
│ 产物计数  │  │ 输入区：模型选择器 · 阶段   │ │ 300DPI 图、      │
│          │  │ 开关 · 附件拖放 · 停止     │ │ content JSON     │
└──────────┴───────────────────────────────┴──────────────────┘
```

### 4.2 七个阶段是一条可视轨道，不是一段提示词

kit 的阶段零～六直接映射为状态机节点，每个节点显示：状态（待办/进行/阻塞等待你/已过/未过）、耗时、产物计数、绑定的门禁。阶段图标上挂"等待你"的呼吸点，让"agent 卡在哪一步"一眼可读——这是全自动产品最缺的透明度。

### 4.3 人在环卡点清单（本产品的核心差别）

每个卡点 = 一次 `interrupt()` + 一个 JSON payload + 一个 UI 组件 + 一条恢复语义。关窗再开仍停在原处（SqliteSaver 持久化）。

| 卡点 | 触发 | 界面 | 契约出处 |
|---|---|---|---|
| **K1 环境预检** | 阶段零检出缺件 | 缺件表：项目 / 检测命令 / 期望 / 建议动作；能自动补的（pip）给"补装"按钮，系统级的（pandoc/MiKTeX）只给指引，不偷装 | core 阶段零 4 条清单 |
| **K2 赛题与附件确认** | 题目解析完 | 子问题卡片 + 附件列表；逐问标注"数据表 X / 共用一套数据"，并把**数据角色判定**摊开显示（训练集目标列非空数、预测集目标列为空、行数、时间范围）——kit 明令"靠文件名猜不算完成" | core 阶段一第 5、6 条；implementation-guide §3.5 |
| **K3 选模卡**（旗舰） | 阶段三 | 2–3 张并排卡，字段照抄 kit 表格列：核心思路 / 创新度 / 可解释性 / 实现难度 / 预计耗时（按本题数据规模给量级）/ 精度与鲁棒性预期；推荐项带徽标 + 一句理由；每卡三钮 **[选它] [解释] [换一批]**；至少 1 项带明显创新性由契约强制 | core 阶段三 |
| **K4 就地解释** | 点方法名 / 公式 / 图 / 扣分项 | 右栏抽屉打开：数学形式（KaTeX）、为何适配本题数据规模与约束、与未选方案的差异、验证方式、预计运行时间、对应规范条文链接。**打开抽屉不清除 K3 的待选状态**；正文里方法名/评分项渲染为细虚线下划线，hover 出摘要、点击进抽屉 | methods `selection-guide`；score `rubric` |
| **K5 图表返工** | 任意图产物 | 换模板（按 20 模板注册表给候选）/ 换主题（`themes/*.theme.json`，改色不改码）/ 换数据列 / 改字号密度；新旧并排 diff，保留旧版可回滚；`--check` 容量超框直接标红而不产出 | figure/diagram CLI；`validate_theme.py` |
| **K6 评分与优化轮次** | 阶段六 | 五维条形 + 总分 S 与 ≥85 判定；扣分明细可点进"改哪一句"；每轮列出上一轮改了什么；轮次到 3 熔断并按 kit 原话标注"未达 85 分标准，需人工复核"；一票否决项（身份信息/页眉）红色横条、不进循环 | score `rubric` / `chapter-checklist` / core 阶段六 |

另外两条贯穿性交互：

- **追溯链**：论文里每个数字都能点 → 产出它的脚本 → 那次运行的事件与 stdout。把 kit"论文数字能追溯到脚本产物"的口号做成一个真实可点的链条。
- **回滚**：按 prompt 建 checkpoint，可只回代码、只回对话、或两者都回（Claude Code 的 rewind 语义）。**注意它不跟踪 Bash 副作用**，我们的产物目录走快照，否则"回滚"是假的。

### 4.4 视觉方向（主色白，三案待选）

| 案 | 强调色 | 语义色 | 性格 |
|---|---|---|---|
| A 墨青 | `#17494D`，hover `#0F3A3E` | 成功 `#2F7A55` 警示 `#A9631C` 失败 `#A63232` | 学术、安静，印刷感 |
| B 靛蓝 | `#2B4C7E`，hover `#1F3A63` | 同上 | 工具感、克制的"高级" |
| C 朱砂 | 主 `#1A1D21` + 点缀 `#B03A2E` | 靠排版分层 | 最不像 AI 生成的，风险也最高 |

统一基底：底色 `#FFFFFF`、面 `#FAFAFA`、发丝线 `#EDEFF2`、主文 `#1A1D21`、次文 `#6B7280`；阴影只用 `0 1px 2px rgba(16,24,40,.06)` 与 `0 8px 24px rgba(16,24,40,.08)` 两级。中文正文 `16px/1.75`，数字一律 tabular-nums，等宽用 Maple Mono NF CN（自托管，不嵌 OS 字体）。**动效预算**：只做状态变化（120–200ms ease-out）与流式光标，**不做常驻动画**——metamath-harness 的桌宠因常驻渲染卡顿被下架，这条是花钱买的结论。

---

## 5 技术架构

### 5.1 三层

```
src/      Electron 壳：窗口、IPC、provider 密钥、更新、打包      ← 不写业务规则
runtime/  Python：阶段状态机、provider 适配、工具调用、产物、事件  ← 唯一编排者
skills/   vendor 自 kit：方法论 + 模板 + 检查器 + Schema         ← 只读契约与脚本
```

runtime **subprocess 调用** skills 里的脚本并按退出码判定，不 import 其私有函数——这样 skills/ 仍可独立被 Claude Code 使用，符合"复制哪一个哪一个就能单独用"的原承诺。

### 5.2 传输：localhost HTTP + SSE，stdio 只管生命周期

主进程 `spawn` Python（`--port 0`），子进程在 stdout 打印一行 `{port, token}` 完成握手；此后全部走 HTTP。只绑 `127.0.0.1`，每个请求校验 `Origin`/`Host` 并按 Jan 的 loopback 白名单拒绝公网地址（防 DNS rebinding）。

- 控制面 REST：`POST /runs`、`POST /runs/{id}/resume`、`POST /runs/{id}/cancel`、`GET /runs/{id}/events`
- 事件面 SSE：`token` / `reasoning` / `tool_call` / `artifact` / `interrupt` / `gate` / `error` / `done`，带 `id:` 与 `Last-Event-ID` 续传，`: ping` 保活
- 产物一律以 `/files/...` URL 传，支持 HTTP Range（pdf.js 需要）；**不用 base64 塞大文件**，仅小图标内联
- 理由：SSE 自带重连语义，省去自研帧协议；浏览器对单 host HTTP/1.1 有约 6 连接上限，所以保持"一条流 + 一条控制面"

### 5.3 编排与持久化

LangGraph `interrupt()` + `SqliteSaver`（`thread_id` = 赛题会话）。选它的唯一理由：它是主流框架里唯一给出**可跨进程重启存活**的暂停语义、且 payload 是 JSON 可直接渲染成选项卡的方案。OpenAI Agents SDK 的 `to_state()` 也能持久化但循环不由我们写；Claude Agent SDK 的 `canUseTool` 是活回调、不耐久且 Anthropic-only，直接排除（它的 AskUserQuestion payload 形状可以抄）。

**硬约束**：`interrupt()` 所在节点会从顶部重新执行，因此任何非幂等副作用（编译、写文件、花 token）必须放在 interrupt 之后。这条会写进 runtime 的 AGENTS 约束并在契约测试里设防。

### 5.4 provider 层（"好用的 AI 接口"的对内一半）

自研矩阵，不用 LiteLLM：官方 `openai` SDK 配 `base_url` + 一层薄 Anthropic 适配器 + **`providers.json` 能力注册表**。字段：`id / display / base_url / auth_style / models[] / tool_calling / streaming_tools / reasoning_field / thinking_extra_body / context_len / max_out`。预设 DeepSeek、Kimi、通义/DashScope、智谱 GLM、火山方舟、OpenRouter、Ollama、OpenAI、Anthropic，外加"自定义 OpenAI 兼容端点"。

已知怪癖按数据登记而非散在代码里：Qwen 的 `enable_thinking` 需走 `extra_body` 且流式字段是 `reasoning_content`（重放历史前必须剥离）；Anthropic 开 `thinking.budget_tokens` 会强制 `temperature=1`；OpenAI o 系列忽略 temperature；Ollama 的 `/v1` 兼容层滞后；vLLM/SGLang 不加 `--enable-auto-tool-choice --tool-call-parser` 会**静默**丢掉工具调用。归一化成 `content` 与 `reasoning` 两类事件。

密钥：只进 Electron `safeStorage`（Windows 侧 DPAPI），**磁盘上任何 JSON 不落明文**；号池轮转 + 429 退避 + 每模型成本与额度计量。可按阶段分配模型（选模与摘要用强模型，批量代码与检查用便宜模型）。

### 5.5 "好用的 AI 接口"的对外一半

延续 kit 的接口开放承诺，三个出口：
1. `mms skills --json` / `mms invoke <skill> --json` —— 能力可列举、可校验、可编排，退出码沿用 `0/1/2`
2. 本机 OpenAI 兼容网关（Cherry 的 apiGateway / Jan 的 :1337 先例）—— 别家客户端能把我们的 agent 当模型用
3. 可选 MCP server —— 让 Claude Code / Cursor 直接调 skills

稳定性同样分档：命令行参数与退出码、注册表字段、产物路径 = **Stable**；`--lang`、事件字段顺序、错误措辞 = **Experimental**；内部几何常量与基元签名 = **Internal**。

### 5.6 工作区目录沿用 kit 阶段二规范

`第X题_赛题简称/answer/{code,figures/final,figures/tmp,paper}`，交付/打包前整体删 `tmp`；`figures/final` 语义命名 `fig{图号}_{题型}_{内容}.png/pdf`，≥300 DPI 且必须被 `paper.tex` 引用（这条做成门禁，不靠自觉）。

### 5.7 便携 Python

照 Cherry 的做法：bundled `uv` + python-build-standalone **3.12.13**（不是本机 3.14——科学计算 wheel 面在 3.12 最厚，且这是上游已验证的钉法），装进应用自有目录，npmmirror 优先再回落官方源，**绝不收养系统解释器**。体积代价预估安装包 300–400 MB（Electron ~100 + Python+whl ~200），需要在 M5 实测后回填真实数字。

LaTeX 不在本轮决定内（v1 边界不含排版），M5 三选一：要求本机 MiKTeX/TeX Live（本机已有）、内置 Tectonic 单文件二进制、或两个都支持并让阶段零检测。中文排版另有一条暗坑：`xeCJK` 依赖本机 SimHei/SimSun 存在，`plot_style.pick_cjk_font` 的字体回退要同样用于预览。

---

## 6 仓库结构与 CI 门禁

### 6.1 结构

```
Escap1ng/<仓库名>/
├── README.md / README_EN.md / CHANGELOG.md / VERSION / LICENSE(Apache-2.0)
├── docs/            架构、交互规格、provider 指南、环境手册、upgrade-plan(+_EN)
├── skills/          vendor 自 kit v2.0.1，含 VENDOR.md 记录来源 commit 与差异
├── runtime/         providers/ orchestrator/ tools/ artifacts/ server/ events/
├── src/             Electron 壳：main/ preload/ renderer/（沿用 electron-vite 默认目录约定，
│                    不另设 desktop/——少一批自定义路径，Windows 首运行更容易一次通过）
├── schemas/         技能注册表、事件流、选模 payload、评分卡、provider 矩阵
├── tests/           契约测试 + 门禁自检 fixture
└── .github/workflows/  ci / gates / desktop-build / release
```

### 6.2 对 kit manifest.json 的唯一结构性增量

给每个 skill 增加 `ui` 与 `hitl` 元数据（入口图标、产物类型、可渲染的 payload schema、是否阻塞等待）。**界面从注册表生成，不硬编码技能清单**——第三方加一个技能，UI 就多一个卡，这正是把 kit 的"契约开放"从命令行推进到图形界面。

### 6.3 六道门禁，且每条都要证明它会失败

| 门禁 | 内容 | 反向验证 |
|---|---|---|
| G1 注册表一致 | `skills/manifest.json` ↔ `skills/` 目录 ↔ README 技能表 ↔ 徽章计数 | 故意删一行注册表，CI 必须红（继承 kit 已验证的做法） |
| G2 Schema 校验 | 所有契约文件按 Draft 2020-12 校验；skills frontmatter 过 `skills-ref validate`，保证仍可被 Claude Code 装载 | 喂一个非法 payload 必须非零退出 |
| G3 工具层契约 | 每个 skill CLI 的 `--list --json` / `--check` / `validate_*` 输出结构与退出码 | 断言 `0/1/2` 三码各自可达 |
| G4 事件流契约 | SSE 事件类型与字段顺序快照；`interrupt` payload 必须能渲染成选模卡 | 缺字段 → 渲染层抛错而不是白屏 |
| G5 provider 离线 contract | 用本地假端点跑流式/工具调用/`reasoning_content` 剥离/429 退避 | 每个怪癖一条 fixture；**fixture 必须真跑过被测代码** |
| G6 桌面构建 | TS 类型检查 + 打包 + 无窗口 smoke（起进程、握手、拿注册表、渲染 25 模板清单） | 已知风险：CI 里 Electron 需 xvfb；且**检查器要能失败**——把 smoke 的断言反过来跑一次确认非零 |

---

## 7 里程碑

| 阶段 | 交付 | 可运行判据 |
|---|---|---|
| **M0** 脚手架 | 仓库、双语 README 骨架、CI 空跑、**环境手册**（npmmirror/镜像钉法、pandoc/MiKTeX 只写指引不代跑） | 新人照手册能 `npm i` 起一个空窗 |
| **M1** skills 落地 | vendor + VENDOR.md + G1/G2/G3；runtime 无 LLM 也能"列举 25 模板、渲染一张、跑一次门禁" | `mms invoke figure paired-raincloud` 出 PNG/PDF/SVG 且退出码正确 |
| **M2** 通道与壳 | Python 子进程握手、SSE 事件、Electron 三栏空壳、流式渲染、provider 设置页 + safeStorage | 选 DeepSeek/Kimi 任一家，能在 UI 里流式对话并显示工具卡 |
| **M3** 编排闭环 | 阶段状态机 + SqliteSaver + **K2/K3/K4** | 提交一道题 → 停在选模卡 → 关窗重开仍停在原处 → 点选后继续；"解释"打开抽屉且不清除待选 |
| **M4** 工作台 | 右栏 pdf.js/图预览 + **K5** + 门禁条 + 评分卡 **K6** | 一张图能换主题重渲并回滚；一份稿子能出五维评分与扣分定位 |
| **M5** 排版全链路 | xelatex/pandoc 接入、交付门禁、`tmp` 清理、一票否决红线 | 一题进、`paper.pdf`+`paper.docx` 出，deai/score 全绿 |
| **M6** 发布 | 便携打包（NSIS + 可选全内置大包）、截图、示例赛题、Release | Windows 干净机装完填 key 即可跑通一道真题 |

签名与公证不在 M6 默认项里：MathModelAgent 的 Windows 包至今未签名、README 里专门写了如何绕过 SmartScreen。是否花钱买代码签名证书留给你决定（macOS 侧它是 Developer ID 签名 + 公证都做齐了）。

---

## 8 风险登记

| 风险 | 概率 | 处置 |
|---|---|---|
| `github.com:443` 与 pip 直连随时翻转（本轮已实测 npm/github 超时、`gh api` 正常） | 高 | 全部联网动作写成手册；镜像失败换手段（换端口/换协议/换通道）后再报失败 |
| Electron 在 CI 无显示器 | 中 | headless + xvfb，或主进程逻辑抽到可单测的纯函数 |
| LangGraph 拖入 langchain-core 语义 | 中 | 只用 `interrupt`/`SqliteSaver` 两点，把依赖面写死在 G6；不可控则自研 200 行状态机（已识别为可退让项） |
| provider 工具调用漂移（尤其国产 + Ollama） | 高 | 能力矩阵按数据登记，UI 在缺 `tool_calling` 时降级为"建议式工具调用"，不谎报 |
| 中文 LaTeX 缺字体 / matplotlib 方框 | 中 | 阶段零把字体也当依赖检测；复用 `pick_cjk_font` |
| 安装包体积与未签名告警 | 中 | 先出"依赖系统 TeX、内置 Python"的折中包；体积数字 M5 实测后回填 |
| 单人维护、面铺太宽 | 高 | v1 边界已收窄到 M3/M4；排版与 EI 改稿后置；每步有可运行判据 |

---

## 9 需要你定的三件事

1. **仓库名**。候选：`mathmodel-studio`（撞名 `yan315598-design/mathmodel-studio` ★47，但全名带你的命名空间仍唯一）／`mathmodel-desk`／`mathmodework`（都不撞）。
2. **UI 依赖取向**：手写 CSS 令牌 + 只引 Radix 原语（无 Tailwind，视觉可控、少一层"AI 味"）／Tailwind v4（快，但默认观感要额外压）。kit 和 VisualLaTeX 都是零依赖取向，我倾向前者，但它会让每个视觉细节都变成真代码。
3. **排版引擎优先级**（可以现在不定，但影响 M5 与 skills 层要不要扩）：xelatex 优先（接 kit 现状）／Typst 优先（MathModelAgent 靠 17 套 Typst 模板赢在观感）／双支持。

定完我从 M0 开工：先建仓、出双语 README 骨架和环境手册，再动代码。
