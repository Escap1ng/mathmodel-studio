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

**当前状态：M0 脚手架**。三栏界面骨架、技能注册表与契约、四道门禁（G1 注册表一致 · G2 契约与版本同源 · G3 CLI 退出码 · G6 产物冒烟，每道都带反向覆盖）已就位；
**还不能建模**——LLM 接入在 M2，选模卡与解释抽屉在 M3，论文编译链路在 M5。里程碑见 [PLAN.md](PLAN.md) §7。

## 快速开始

```bash
# 装依赖（大陆网络请先看 docs/env-setup.md：npm 直连与 github.com 都不稳）
npm install

# 起空窗口看骨架
npm run dev

# 跑全部本地门禁：注册表一致性 + 反向覆盖 + 类型检查 + 构建 + 产物冒烟 + 契约 + CLI 退出码
npm run gate
```

`npm run gate` 全绿即说明脚手架自洽；它不依赖网络，也不依赖显示器。

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
状态 `planned` 表示已登记并占位、内容尚未在 M1 vendor 进本仓库。

| 技能 | 职责 | 状态 |
| --- | --- | --- |
| [`mathmodel-core`](skills/mathmodel-core/) | 主技能：阶段零至阶段六编排与路由 | planned |
| [`mathmodel-methods`](skills/mathmodel-methods/) | 建模方法库与选型：问题族索引、选型依据、验证方式 | planned |
| [`mathmodel-paper`](skills/mathmodel-paper/) | 论文写作与排版：写作规范、LaTeX 骨架、Word 输出、参考文献 | planned |
| [`mathmodel-figure`](skills/mathmodel-figure/) | 数据图表：matplotlib 模板库 + Nature 出图标准 | planned |
| [`mathmodel-diagram`](skills/mathmodel-diagram/) | 学术示意图：JSON 驱动版式模板 + 高保真复刻 | planned |
| [`mathmodel-deai`](skills/mathmodel-deai/) | 降 AI 与交付核查：词表级、结构级、字符级三道门禁 | planned |
| [`mathmodel-score`](skills/mathmodel-score/) | 结构自检与评分：章节门槛 + 百分制五维评分卡 | planned |

技能内容来自 [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) v2.0.1（Apache-2.0），引入规则与 re-sync 记录见 [`skills/VENDOR.md`](skills/VENDOR.md)。运行时**只用 subprocess 调用技能脚本并按退出码判定**，所以每个技能仍能被 Claude Code 等宿主单独装载、单独使用。

## 已实现的质量门禁

每条都配了反向覆盖——只跑「绿的」的检查器不构成证据。

| 门禁 | 判据 | 反向覆盖 |
| --- | --- | --- |
| G1 注册表一致 | `skills/manifest.json` ↔ `skills/` 目录 ↔ 契约词表 ↔ 两份 README 技能表与徽章计数 | 8 种破坏逐个植入，每种必须变红（`npm run check:registry:negative`） |
| G2 契约校验 | 注册表按 JSON Schema Draft 2020-12 校验；`jsonschema` 缺席时降级并说明 | 构造两份非法注册表，必须被拒（`scripts/validate_contracts.py` C3） |
| G2b 版本同源 | `VERSION` / `package.json` / `pyproject.toml` / `mms/__init__.py` 四处一致 | 任一缺项即失败 |
| G3 CLI 契约 | 退出码 `0 成功 / 1 校验失败 / 2 用法或环境错误` 三码各自可达 | 词表外取值→1、非法 JSON→1、`MMS_HOME` 指向空目录→2、未知子命令→2（`runtime/selfcheck.py`） |
| G6 桌面骨架 | 类型检查 + 构建 + 产物里确实含有本项目的中文文案与设计令牌名 | 断言失败即退出 1（`scripts/smoke-dist.mjs`） |
| G7 真启动冒烟 | xvfb 下真起窗口：标题与 1440×900 内容尺寸、按 BGRA 统计非白像素占比 ≥1%、IPC 往返把主进程版本号写进状态栏、阶段轨道 7 节 / 标签 6 个 / 发送按钮按事实禁用、点色块真的换掉 `--accent` | 空白截图过不了像素阈值这一关；`needs: []` 独立跑（`tests/window-smoke.cjs`） |

G7 先把 Electron 的 SUID 沙箱助手修好，再在 `sandbox: true` 下启动，所以 preload 与 IPC 是在沙箱里被验过的，不是靠 `--no-sandbox` 绕过。
**仍未覆盖**的是 `src/main/index.ts` 自己的窗口配置与导航守卫——冒烟脚本自建窗口、加载构建产物，那条路要等 M2 有 runtime 可握手时补一次真启动测试；CSP 目前也停在静态配置。

退出码约定、注册表字段与产物路径属于 **Stable**；`--json` 字段顺序与错误措辞属于 **Experimental**；脚本内几何常量属于 **Internal**。

**执行状态要说清**：G1（含 9 条反向覆盖）、G2（完整与降级两种模式）、G3 在本机跑绿；G1、G2、G3、G6 已在 CI 的 ubuntu + windows 双矩阵跑绿。
G7 是本轮新写的，还没有执行过一次——它写好了，但尚未被证明跑得过。

## 依赖

| 用途 | 依赖 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron、electron-vite、React、TypeScript | 见 `package.json` |
| 运行时 | Python 3.12+（标准库即可跑 M0 门禁） | `jsonschema>=4.20` 可选，缺席时契约校验降级 |
| 排版（M5） | xelatex（TeX Live 或 MiKTeX）、pandoc | 系统级安装，不由 pip 提供，缺件时阶段零只给指引 |
| 出图（M1） | matplotlib、numpy、seaborn | 随技能 vendor 时补齐 requirements |

打包形态已定：**内置便携 Python 运行时**（bundled `uv` + python-build-standalone），用户不需要装 Python；TeX 与 pandoc 的处理在 M5 决定。

## 定位与合规声明

本项目辅助**已经完成的建模工作**：规范排版、出版级图表、交付前自检、方法选型讨论。它不替你思考，也不保证获奖。
内置的评分与结构自检默认按国赛口径（对齐 2026 格式规范），美赛口径可通过参数切换；降 AI 检查只清理模板腔与不可见字符，
**不会把未做的内容写成做过**——伪造结果、编造文献与数据在技能规范里是硬红线。请遵守你所在赛事对生成式工具的规定。

## 许可

[Apache-2.0](LICENSE)。技能内容的版权与许可随上游 [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) 一并保留。
