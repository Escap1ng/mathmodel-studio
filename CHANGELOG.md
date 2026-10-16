# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
`0.0.x` 阶段一切皆可能变动；`0.1.0` 起把 CLI 参数、退出码、注册表字段与产物路径锁为 Stable。

## 0.0.1 - 2026-10-16

M0 脚手架。目标是「新人照手册能起一个空窗口，并且本地门禁全部可跑」。

### 新增

- **技能注册表** `skills/manifest.json`：登记上游 7 个技能，并新增 UI 契约字段（`phases` / `artifacts` / `hitl`），界面据此渲染而不硬编码技能清单。配套契约 `schemas/skill-manifest.schema.json`（Draft 2020-12）。
- **G1 注册表一致性门禁** `scripts/check-registry.mjs`：注册表 ↔ `skills/` 目录 ↔ 契约词表 ↔ 两份 README 的技能表与徽章计数，任一处漂移即非零。
- **G1 反向覆盖** `scripts/check-registry.negative.mjs`：先证明未改动的夹具退出 0，再逐个植入 8 种破坏（删技能、假 vendor、词表外取值、只改契约、删 README 行、改徽章、非法 JSON、路径缺失），每种都必须变红。
- **G2 契约校验与版本同源** `scripts/validate_contracts.py`：jsonschema 在场走完整校验、缺席降级并说明；内建两份必错注册表验证校验器真会拒；`VERSION` / `package.json` / `pyproject.toml` / `mms/__init__.py` 四处版本必须一致。
- **G3 CLI 契约自检** `runtime/selfcheck.py`：`mms` 的退出码 `0/1/2` 三码各自跑到可达，并断言列举数量与注册表实数一致。
- **G6 产物冒烟** `scripts/smoke-dist.mjs`：除入口存在与资源可解析外，断言 bundle 里确实含有本项目的中文文案与三套强调色令牌——「构建成功」不等于「打进去了我们的代码」。
- **Electron 三栏骨架**：240px 阶段轨道 / 760px 正文列 / 440px 工作台（图表·论文·代码·评分·门禁·日志）+ 状态栏；白底、发丝分隔线、两级阴影，`sandbox: true` + `contextIsolation: true` + CSP，外部链接只走 https 且交给系统浏览器。
- **强调色三案可在界面切换**（状态栏色块，或 `?accent=a|b|c`）：A 墨青 `#17494D`、B 靛蓝 `#2B4C7E`、C 朱砂 `#B03A2E`。取值理由见 PLAN.md §4.4。
- **环境手册** `docs/env-setup.md`：把联网动作写成文档而不是替你执行，含通道实测表、镜像配置与信任边界、版本查法、Windows PowerShell/GBK 坑。
- **双语 README** `README.md` / `README_EN.md`，Apache-2.0 许可（取自上游原文）。
- CI `ci.yml`：ubuntu + windows 双矩阵，跳过 Electron 二进制下载，跑四道无需网络的门禁再加类型检查、构建与产物冒烟。

### 尚未做（避免被当成已完成）

- 技能内容**没有 vendor 进仓库**，7 个目录是 `planned` 占位；出图、示意图、降 AI、评分的脚本要到 M1 才在运行时就绪。`skills/VENDOR.md` 的 re-sync 表还是空的。
- 没有 LLM 接入、没有 SSE 通道、没有可持久化的暂停/恢复；输入区按事实禁用。
- 没有打包、没有签名、没有便携 Python 的下载实现（M5/M6）。
- `docs/env-setup.md` 暂无英文版；M1 与其余文档一起补，避免中英两份漂开。
- 没有截图与示例赛题（等界面真的有内容可看）。

### 变更（相对既有方案）

- 桌面壳目录从 PLAN.md §6.1 初稿写的 `desktop/` 改为仓库根 `src/{main,preload,renderer}`，采用 electron-vite 的默认目录约定，去掉一批自定义路径配置以提高 Windows 首次运行的一次通过率。PLAN.md 已同步。

### 已知风险

- `npm install` 未在本机执行过（属联网动作），因此 Electron 44.8.0 / electron-vite 6.0.0 / Vite 8.3.4 / TypeScript 7.0.2 的组合尚未经过一次真构建验证；版本号本身取自镜像 `dist-tags.latest` 并核对了 `electron-vite` 的 peer 范围。
