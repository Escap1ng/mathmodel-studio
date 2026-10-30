<h1 align="center">mathmodel-studio</h1>

---

<p align="center"><b>数学建模竞赛桌面 Agent · 人在环的建模工作台</b></p>

<p align="center">
  赛题进、论文出——但每一步的关键判断都留给你点一下：<br>
  <b>选哪个模型、为什么选它、这一步过没过门禁、扣的分扣在哪一句</b>，全部可见、可问、可回滚。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/%E6%8A%80%E8%83%BD-7-7B5FD6?style=flat" alt="技能">
  <img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-Apache--2.0-1A6FC4?style=flat" alt="许可证">
  <img src="https://img.shields.io/badge/Python-3.12+-2E9E44?style=flat" alt="Python">
  <img src="https://img.shields.io/badge/%E6%A1%8C%E9%9D%A2%E7%AB%AF-Electron-2B4C7E?style=flat" alt="桌面端">
</p>

<p align="center">
  <b>简体中文</b> &nbsp;·&nbsp; <a href="README_EN.md">English</a>
</p>

---

> **能交给机器校验的，交给门禁；该由人判断的，留给人，并且把判断点做成界面。**
> 本项目把 [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) 的契约化技能集（出版级图表、排版规范、降 AI 检查、结构自检与评分）落到一个本地桌面程序里：模型自带、数据不外传、过程可审计。

**当前状态：M3 编排闭环**。把赛题正文发进来，状态机会先停在 **K2 赛题与附件确认**；确认后给出 3 张 **K3 选模卡**，可 **换一批**、可打开 **K4 就地解释** 抽屉（打开不清除待选），点「选它」后进入阶段四。阶段状态、待决卡与对话消息落在本机 SQLite 里，**runtime 重启后仍停在原处**。
M3 的候选来自内置方法族模板并由题面关键词选取，**不是模型判断**；真实模型参与选模在 M4。模型接入、流式对话、工具卡与 Key 的 `safeStorage` 边界沿用 M2；没有 Key 也能开 `MMS_FAKE_PROVIDER=1` 的离线演示，见 [docs/providers.md](docs/providers.md)。
**还不能真正做题**——代码实现、图表返工、论文编译与评分分别在 M4/M5。里程碑见 [PLAN.md](PLAN.md) §7。
要接手或复核，先读 [docs/HANDOFF.md](docs/HANDOFF.md)：哪些结论已被证明、哪些还没有、以及这一轮踩过的坑。

## 快速开始

```bash
# 装依赖（大陆网络请先看 docs/env-setup.md：npm 直连与 github.com 都不稳）
npm install
python -m pip install -r requirements.txt -i https://registry.npmmirror.com/pypi/simple/

# 起窗口。没有 Key 时加一行环境变量走离线演示：MMS_FAKE_PROVIDER=1 npm run dev
npm run dev

# 不接模型也能验运行时：列 25 个模板，真渲一张图（PNG/PDF/SVG）
npm run mms -- templates
npm run mms -- invoke figure paired-raincloud

# 跑全部本地门禁：注册表 + 技能规范 + 反向覆盖 + 类型检查 + 构建 + 产物冒烟 + 契约 + CLI + 通道 + 离线 provider
npm run gate
```

`npm run gate` 全绿即说明脚手架自洽；它不依赖网络，也不依赖显示器。
界面分「建模」与「问答」两种输入：建模会把赛题送进状态机并停在决策卡，问答保持 M2 的自由流式对话与工具卡。离线演示下走一遍：粘贴含两个子问题的题面 → 确认 K2 → 看 K3 三张候选 → 打开解释 → 换一批 → 选它；截图见 `screenshots/decision.png`、`screenshots/drawer.png`（本地生成，不入库）。

## 这是什么

一个跑在本机的数学建模竞赛辅助程序，而不是一句话生成论文的按钮。

```
┌──────────┬───────────────────────────────┬──────────────────┐
│ 左栏 240 │  中栏 · 对话流（正文列宽 760）  │ 右栏 440         │
│ 赛题会话  │  Agent 回复 · 工具卡 · 选模卡  │  图表 论文 代码   │
│ 阶段零…六 │  门禁失败条（可点定位）        │  评分 门禁 日志   │
│ 状态 + 产物│  ┌─────────────────────────┐ │  pdf.js 页级预览  │
└──────────┴───────────────────────────────┴──────────────────┘
```

- **阶段轨道**：上游 `mathmodel-core` 的阶段零～六（环境预检 → 赛题分析 → 工作目录 → 算法选择 → 代码实现 → 论文输出 → 评分优化）变成一条能看到"卡在哪一步"的轨道。
- **六个卡点**：环境缺件确认、赛题与附件确认、**选模卡**、**就地解释**、图表返工、评分轮次放行。暂停是可持久化的——关窗再开仍停在原处。
- **追溯链**：论文里的每个数字都能点回产出它的脚本和那次运行的输出。
- **门禁把守**：图表容量、章节结构、词表级与结构级 AI 痕迹、零宽字符、五维评分（≥85 达标，3 轮熔断），全部由脚本判定，不靠肉眼。

## 技能

单一事实源是 [`skills/manifest.json`](skills/manifest.json)；下表的行数与上面的徽章计数由 CI 强校验一致。
状态 `vendored` 表示技能内容已原样引入本仓库，来源版本与 commit 记在 [`skills/VENDOR.md`](skills/VENDOR.md)。

| 技能 | 职责 | 状态 |
| --- | --- | --- |
| [`mathmodel-core`](skills/mathmodel-core/) | 主技能：阶段零至阶段六编排与路由 | vendored |
| [`mathmodel-methods`](skills/mathmodel-methods/) | 建模方法库与选型：问题族索引、选型依据、验证方式 | vendored |
| [`mathmodel-paper`](skills/mathmodel-paper/) | 论文写作与排版：写作规范、LaTeX 骨架、Word 输出、参考文献 | vendored |
| [`mathmodel-figure`](skills/mathmodel-figure/) | 数据图表：matplotlib 模板库 + Nature 出图标准 | vendored |
| [`mathmodel-diagram`](skills/mathmodel-diagram/) | 学术示意图：JSON 驱动版式模板 + 高保真复刻 | vendored |
| [`mathmodel-deai`](skills/mathmodel-deai/) | 降 AI 与交付核查：词表级、结构级、字符级三道门禁 | vendored |
| [`mathmodel-score`](skills/mathmodel-score/) | 结构自检与评分：章节门槛 + 百分制五维评分卡 | vendored |

技能内容来自 [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) v2.0.1（Apache-2.0），引入规则与 re-sync 记录见 [`skills/VENDOR.md`](skills/VENDOR.md)。运行时**只用 subprocess 调用技能脚本并按退出码判定**，所以每个技能仍能被 Claude Code 等宿主单独装载、单独使用。

## 已实现的质量门禁

每条都配了反向覆盖——只跑「绿的」的检查器不构成证据。

| 门禁 | 判据 | 反向覆盖 |
| --- | --- | --- |
| G1 注册表一致 | `skills/manifest.json` ↔ `skills/` 目录 ↔ 契约词表 ↔ 两份 README 技能表与徽章计数 | 8 种破坏逐个植入，每种必须变红（`npm run check:registry:negative`） |
| G8 技能规范 | 每个 vendored 技能的 `SKILL.md` 仍是合法 Agent Skills 入口：frontmatter 可解析、`name` 与目录同名、`description` 非空且在 1024 字内、无本仓库私有字段；目录无占位文件、层级不超过上游的 3 层 | 用真实 `SKILL.md` 造 6 种破坏（删入口、改名、空描述、塞 `ui` 字段、残留占位、超深目录），每种必须变红（`npm run check:skills:negative`） |
| G2 契约校验 | 注册表按 JSON Schema Draft 2020-12 校验；`jsonschema` 缺席时降级并说明 | 构造两份非法注册表，必须被拒（`scripts/validate_contracts.py` C3） |
| G2b 版本同源 | `VERSION` / `package.json` / `pyproject.toml` / `mms/__init__.py` 四处一致 | 任一缺项即失败 |
| G3 CLI 契约 | 退出码 `0 成功 / 1 校验失败 / 2 用法或环境错误` 三码各自可达；M1 起真调上游渲染器出一张图，并独立核验 PNG/PDF/SVG 三件产物非空 | 词表外取值→1、非法 JSON→1、空 `MMS_HOME`→2、未知子命令/未知模板→2、渲染器假成功（退出 0 但没写产物）→1（`runtime/selfcheck.py`） |
| G4 事件流 | 握手一行 JSON；Bearer token 与 Host/Origin 回环白名单；SSE 九类事件按契约校验；`Last-Event-ID` 续传；取消后必须收到 `done.reason=cancelled`。M3 追加：新赛题停在 K2、确认进 K3、换一批、选择后进阶段四，以及**换一个服务器进程仍读得到待决卡**（46 条） | 10 种坏事件逐个必须被拒；无 token / 错 Host / 无待决时恢复被拒（`python runtime/selfcheck_channel.py --selftest`） |
| G5 provider 离线契约 | 本地假 OpenAI 端点跑 429 退避、`reasoning_content` 与正文分离、分片 `tool_calls` 拼装、历史剥离 reasoning、Key 只出现在 Authorization | Key 哨兵不得出现在事件流与 stderr；未开 `MMS_FAKE_PROVIDER` 时必须拒绝假 provider（同上） |
| G6 桌面骨架 | 类型检查 + 构建 + 产物里确实含有本项目的中文文案与设计令牌名 | 断言失败即退出 1（`scripts/smoke-dist.mjs`） |
| G7 真启动冒烟 | `require` 生产入口 `out/main/index.js` 起窗，再断言：加载构建产物、内容尺寸 1440×900、非白像素 ≥1%、IPC 端到端、阶段轨道与输入区、中文真字形、设置页不回显 Key 且落盘只有密文/明确拒绝；M3 追加 K2→K3→解释抽屉→换一批→选择→阶段四，以及**杀掉 runtime 再拉起后 K3 仍在**；M2 自由问答与工具卡保留为回归（43 条） | 空白截图过不了像素阈值；自建窗口的假版本、豆腐块截图、删掉关键断言再补满条数，三类都暴露过（`tests/window-smoke.cjs`） |
| G6b 结果核验 | 读 `screenshots/window-smoke.json` 并**复算读数**：内容尺寸、非白像素比、断言条数下限、10 条关键断言是否还在、自述计数与明细一致 | 带 `--selftest`，12 份合成结果证明「ok=true 但读数不对」「删掉 M2 或 M3 的关键断言再补满条数」照样被拒（`scripts/check-window-smoke.mjs`） |

G7 在 CI 里先把 Electron 的 SUID 沙箱助手修好（root:4755）再启动，所以 preload 与 IPC 是在生产那套 `sandbox: true` 下验的，不是靠 `--no-sandbox` 绕过。
为什么要有 G6b 这道独立核验：CI 里曾经出现过冒烟打印「10/12 项通过」但 job 是绿的——`app.exit(1)` 被生产入口的 `window-all-closed → app.quit()` 抢先顶掉了。通过与否从此不吊在 Electron 的退出码管道上。
**仍未覆盖**：真实 DeepSeek/Kimi 的联网对话（本仓库没有 Key，也不该有）、CI 的 Windows 真起窗、CSP 违规场景的主动探测。

退出码约定、注册表字段与产物路径属于 **Stable**；`--json` 字段顺序与错误措辞属于 **Experimental**；脚本内几何常量属于 **Internal**。

**执行状态要说清**：M3 的本机 `npm run gate` 全绿——G1（含 9 条反向覆盖）、G8（含 6 条反向覆盖）、G2（完整与降级两种模式）、G3（13 条断言）、G4（46 条通道断言，含跨进程恢复）、事件判据自测（10/10）、G6b 自测（12/12）、类型检查、构建与 G6 产物冒烟。G7 在本机 Windows 上 43/43，独立核验通过（内容尺寸 1440x900，非白像素 2.37%）；选模卡与解释抽屉截图在 `screenshots/decision.png`、`screenshots/drawer.png`。
0.3.0 的 CI run `40982728779` 三 job 全绿：ubuntu/windows 门禁同跑 G4 46 条；ubuntu 真启动冒烟 42/42（非白像素 3.15%），K2→K3→解释→重启恢复→换一批→选择全过，`safeStorage` 不可用时仍走「明确拒绝且不落盘」。0.3.1 的界面修订以本次推送后的 run 为准。M1/M2 的历史 run 与坑记录保留在 `CHANGELOG.md`，没有删。

## 依赖

| 用途 | 依赖 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron、electron-vite、React、TypeScript | 见 `package.json` |
| 运行时 | Python 3.12+（通道服务器、SSE、provider 客户端只用标准库） | `jsonschema>=4.20` 可选，缺席时契约校验降级 |
| 模型接入 | DeepSeek / Kimi / 任意 OpenAI 兼容端点（BYOK） | 见 [docs/providers.md](docs/providers.md)；Key 只经主进程 `safeStorage` 加密落盘 |
| 排版（M5） | xelatex（TeX Live 或 MiKTeX）、pandoc | 系统级安装，不由 pip 提供，缺件时阶段零只给指引 |
| 出图（M1） | matplotlib、numpy、seaborn | 已随技能 vendor；版本下限写在 `requirements.txt`，安装走镜像 |

打包形态已定：**内置便携 Python 运行时**（bundled `uv` + python-build-standalone），用户不需要装 Python；TeX 与 pandoc 的处理在 M5 决定。

## 定位与合规声明

本项目辅助**已经完成的建模工作**：规范排版、出版级图表、交付前自检、方法选型讨论。它不替你思考，也不保证获奖。
内置的评分与结构自检默认按国赛口径（对齐 2026 格式规范），美赛口径可通过参数切换；降 AI 检查只清理模板腔与不可见字符，
**不会把未做的内容写成做过**——伪造结果、编造文献与数据在技能规范里是硬红线。请遵守你所在赛事对生成式工具的规定。

## 许可

[Apache-2.0](LICENSE)。技能内容的版权与许可随上游 [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) 一并保留。
