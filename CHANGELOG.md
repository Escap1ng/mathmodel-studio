# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
从 `0.1.0` 起，CLI 参数与退出码、注册表字段、产物路径为 Stable；`--json` 字段顺序与错误措辞仍为 Experimental。

## 0.1.0 - 2026-10-20

M1 技能落地。目标是不接模型也能「列模板、渲一张图、跑一次门禁」。

### 新增

- **七个技能 vendor 进仓库**：从 `mathmodel-kit` v2.0.1（commit `5ec0e464da0ae415d3db87cf53fb66eb6e2dff24`）原样复制 `SKILL.md` / `README.md` / `docs/` / `code/` / `themes/` / `examples/`；逐文件 sha256 与上游 tarball 一致，目录内没有本仓库新增文件。来源与 re-sync 表见 `skills/VENDOR.md`。
- **G8 技能规范门禁** `scripts/check-skills.mjs`：frontmatter 可解析、`name` 与目录同名、`description` 非空且在 1024 字内、不含本仓库私有字段、无占位文件、目录层级不超过上游的 3 层。`--self` 用真实 `SKILL.md` 造 6 种破坏（删入口、改名、空描述、塞 `ui` 字段、残留占位、超深目录），含基线自证共 7/7 通过。
- **runtime 接通技能**：`mms templates` 列出 20 张图 + 5 张示意图；`mms invoke figure <id>` 以 subprocess 调上游 `render_template.py`，按 `0/1/2` 透传退出码，并独立核验 PNG/PDF/SVG 三件产物非空。`runtime/selfcheck.py` 从 8 条扩到 13 条；新增 S13 反向覆盖：渲染器退出 0 却没写产物，必须判 1。
- **开发期入口** `python runtime/cli.py`（或 `npm run mms -- ...`）：不必先 `pip install -e`，也不必在 bash 与 PowerShell 之间换 `PYTHONPATH` 写法。
- **`requirements.txt`** 与 `docs/env-setup.md` 的镜像安装说明（六个包，版本下限与上游一致）。

### 变更

- 注册表 7 个技能 `status: planned → vendored`；两份 README 技能表同步。
- 版本 `0.0.1 → 0.1.0`。
- **修正 `skills/VENDOR.md` 的一条错规则**：M0 写的「层级最深 2 层（与上游一致）」是错的——上游 figure 的 `code/style/`、diagram 的 `code/templates/schema/` 都在第 3 层。按旧规则 vendor 会漏掉样式模块与 schema，现在按实际写成「最深 3 层」。
- G1 反向覆盖的 M2 改为「入口指向不存在的文件」：原先依赖 `planned` 状态，全部翻成 `vendored` 后那条破坏不再成立。夹具改为复制真实 `SKILL.md`，不再依赖已删除的 `PLACEHOLDER.md`。
- CI 的 gates job 改为安装 `requirements.txt`（G3 现在真的要 matplotlib）。

### 验证（本机，2026-10-20）

- `npm run gate` 全绿：G1 8/8、G1 反向 9/9、G8 6/6、G8 反向 7/7、G6b 自测 9/9、G2 9/9、G3 13/13，类型检查、构建、G6 产物冒烟通过。
- 真渲 `paired-raincloud`：PNG 439181 B / PDF 63764 B / SVG 102321 B；产物与上游 `examples/previews/` 里的同名预览目视一致。
- 本机首次跑通 `npm install`（81 个包，54 s，走 npmmirror）；M0 时只在 CI 装过。
- 本机 Python 3.14.5 + matplotlib 3.10.9 能跑上游 v2.0.1 模板；`requirements.txt` 仍按上游下限声明，不锁版本。

### 尚未做

- `invoke` 只接通 figure；diagram 的渲染入口与其余技能的命令行入口留到 M2/M4。
- G8 的 S4 只拦「私有字段/规范外字段」，不做完整 YAML 校验——用不到的 YAML 特性宁可报错，也不静默猜。
- 便携 Python 仍未实现（M5/M6）；`docs/env-setup.md` 仍无英文版。
- 技能内容原样引入，M1 没有改写任何条文；上游模板自身的版式问题（例如 `paired-raincloud` 的图例贴边）不在这轮修。

## 0.0.1 - 2026-10-16

M0 脚手架。目标是「新人照手册能起一个空窗口，并且本地门禁全部可跑」。

### 新增

- **技能注册表** `skills/manifest.json`：登记上游 7 个技能，并新增 UI 契约字段（`phases` / `artifacts` / `hitl`），界面据此渲染而不硬编码技能清单。配套契约 `schemas/skill-manifest.schema.json`（Draft 2020-12）。
- **G1 注册表一致性门禁** `scripts/check-registry.mjs`：注册表 ↔ `skills/` 目录 ↔ 契约词表 ↔ 两份 README 的技能表与徽章计数，任一处漂移即非零。
- **G1 反向覆盖** `scripts/check-registry.negative.mjs`：先证明未改动的夹具退出 0，再逐个植入 8 种破坏（删技能、假 vendor、词表外取值、只改契约、删 README 行、改徽章、非法 JSON、路径缺失），每种都必须变红。
- **G2 契约校验与版本同源** `scripts/validate_contracts.py`：jsonschema 在场走完整校验、缺席降级并说明；内建两份必错注册表验证校验器真会拒；`VERSION` / `package.json` / `pyproject.toml` / `mms/__init__.py` 四处版本必须一致。
- **G3 CLI 契约自检** `runtime/selfcheck.py`：`mms` 的退出码 `0/1/2` 三码各自跑到可达，并断言列举数量与注册表实数一致。
- **G6 产物冒烟** `scripts/smoke-dist.mjs`：除入口存在与资源可解析外，断言 bundle 里确实含有本项目的中文文案与设计令牌名——「构建成功」不等于「打进去了我们的代码」。刻意不断言具体色值：CSS minifier 会缩写或转色空间，那只会造成假红。
- **Electron 三栏骨架**：240px 阶段轨道 / 760px 正文列 / 440px 工作台（图表·论文·代码·评分·门禁·日志）+ 状态栏；白底、发丝分隔线、两级阴影，`sandbox: true` + `contextIsolation: true` + CSP，外部链接只走 https 且交给系统浏览器。
- **强调色三案可在界面切换**（状态栏色块，或 `?accent=a|b|c`）：A 墨青 `#17494D`、B 靛蓝 `#2B4C7E`、C 朱砂 `#B03A2E`。取值理由见 PLAN.md §4.4。
- **环境手册** `docs/env-setup.md`：把联网动作写成文档而不是替你执行，含通道实测表、镜像配置与信任边界、版本查法、Windows PowerShell/GBK 坑。
- **双语 README** `README.md` / `README_EN.md`，Apache-2.0 许可（取自上游原文）。
- **交接文档** `docs/HANDOFF.md`：把「已证 / 未证」分栏写清（尤其 Windows 真启动与本机 `npm install` 都还没验过）、待维护者定的三项、M1 的具体动作清单（含改 `status` 会触发 R4 这条连锁）、以及这一轮踩过的网络 / Electron / 量具坑。两份 README 各加一行指过去。
- CI `ci.yml`：ubuntu + windows 双矩阵，跳过 Electron 二进制下载，跑四道无需网络的门禁再加类型检查、构建与产物冒烟。
- **G6b 结果核验** `scripts/check-window-smoke.mjs`：独立读取真启动的 JSON 结论并复算读数（尺寸、非白像素比、断言条数下限、自述计数与明细是否自洽），带 `--selftest` 用 8 份合成夹具自证会拒绝被污染的结果；已并入 `npm run gate`，不需要 Electron。
- **G7 真启动冒烟** `tests/window-smoke.cjs` + CI `window-smoke` job：`require` 生产入口起窗，断言加载的是构建产物、内容尺寸 1440×900、非白像素占比 ≥1%、状态栏版本号来自主进程 IPC 应答、阶段轨道 7 节、工作台 6 标签、发送按钮按事实禁用、点色块真的把 `--accent` 换成 B 案靛蓝，截图上传为 artifact。
- **窗口内容尺寸基线**：`src/main/index.ts` 加 `useContentSize: true`——默认 `width/height` 含边框，实测内容区只有 1439x872，「以 1440×900 为设计基准」这句话就不可比。
- **跨平台行尾约定** `.gitattributes`：仓库内统一 LF、签出也发 LF（门禁脚本要在 ubuntu 与 windows 上行为一致），`*.cmd/*.bat/*.ps1` 保持 CRLF，二进制不参与 diff。

### 尚未做（避免被当成已完成）

- 技能内容**没有 vendor 进仓库**，7 个目录是 `planned` 占位；出图、示意图、降 AI、评分的脚本要到 M1 才在运行时就绪。`skills/VENDOR.md` 的 re-sync 表还是空的。
- 没有 LLM 接入、没有 SSE 通道、没有可持久化的暂停/恢复；输入区按事实禁用。
- 没有打包、没有签名、没有便携 Python 的下载实现（M5/M6）。
- `docs/env-setup.md` 暂无英文版；M1 与其余文档一起补，避免中英两份漂开。
- 没有截图与示例赛题（等界面真的有内容可看）。

### 变更（相对既有方案）

- 桌面壳目录从 PLAN.md §6.1 初稿写的 `desktop/` 改为仓库根 `src/{main,preload,renderer}`，采用 electron-vite 的默认目录约定，去掉一批自定义路径配置以提高 Windows 首次运行的一次通过率。PLAN.md 已同步。

### CI 首轮实测（2026-10-16，ubuntu + windows 双矩阵）

- `npm install` 在两个平台都成功：Electron 44.8.0 / electron-vite 6.0.0 / Vite 8.3.4 / TypeScript 7.0.2 这组版本能一起装出来。
- G1、G1 反向覆盖、G2、G3、`compileall` 在 **ubuntu 与 windows 上均全绿**——注册表契约与退出码契约是跨平台自洽的。
- 类型检查首轮失败：TypeScript 7 以 `TS2882` 拦下 `import './styles/tokens.css'` 这类副作用导入。补 `src/renderer/src/env.d.ts`（`/// <reference types="vite/client" />`）声明资源模块。
- 顺带把 G6 的色值断言换成设计令牌名断言，避免 minifier 改写颜色造成的假红。
- **第二轮全绿**：类型检查、`electron-vite build` 与 G6 产物冒烟在 ubuntu 和 windows 上都通过，于是 Electron 44.8.0 + electron-vite 6.0.0 + Vite 8.3.4 + TypeScript 7.0.2 这组版本算经过了真构建验证，不再是「装得上但没编过」。
- **G7 首跑失败**：Linux 上 `node_modules/electron/dist/chrome-sandbox` 不是 root:4755，Chromium 在任何断言执行之前就 `FATAL:setuid_sandbox_host` 退出（信号 SIGTRAP）。没有用 `--no-sandbox` 绕过——那样等于把生产窗口的 `sandbox: true` 排除在验证之外；改为在 workflow 里把沙箱助手权限修好，于是 G7-3 的 IPC 断言实际是在沙箱内验 preload。
- **G7 第二、三轮失败都是我自己的脚手架问题**：第二轮 `chmod` 报 no such file，因为二进制要到首次 `npx electron` 才懒下载，改为先显式跑 electron 自己的 `install.js`；第三轮则是我加的诊断命令 `npx electron --version` 排在了 `chmod` 之前，自己踩进同一个 SUID 陷阱。日志里 `chrome-sandbox` 的 `ls -l` 输出把这件事写实了，不再是猜。
- **G7 第四轮跑起来了，但抓出脚手架在造假**：画面 2.11% 非白、轨道与标签数量都对，可 `app:meta` 报 `No handler registered`——那一版冒烟自己 `new BrowserWindow`，从没加载 `src/main/index.ts`，IPC 处理器自然不存在，「窗口起来了」于是变成一句没验证产品的话。改为 `require(out/main/index.js)` 让生产入口起窗。
- **G7 第五轮：绿是假的**。job 显示通过，日志里却写着「10/12 项通过」——`app.exit(1)` 被生产入口的 `window-all-closed → app.quit()` 抢先，退出码被顶成 0。通过与否不能再吊在 Electron 的退出码管道上，于是新增 `scripts/check-window-smoke.mjs`：冒烟把结论落成 `screenshots/window-smoke.json`，核验脚本独立读它并**复算读数**（`ok=true` 但尺寸 1439x899 照样拒），并带 `--selftest` 用 8 份合成结果自证会失败；它被加进 `npm run gate`，本机即可跑。
- **同轮还有两条断言本身写错了**：① `app.getVersion()` 在 `electron <脚本>` 这种启动方式下返回的是 Electron 自带 default_app 的版本（实测 44.8.0），不是我们的 0.0.1，所以状态栏那条改成校验形状，并另加一条「主进程的 runtime 信息原样穿过 preload 回到页面」；② xvfb 虚拟屏正好 1440×900 时装不下带边框的窗口，内容区被钳成 1439x899，改为 1600x1000。
- **看了截图才发现：中文全是豆腐块**。13/13 全绿、非白像素 2.09%，但把 PNG 取回来看，整片中文都是空心方框——runner 上没有中文字体，而像素断言分不清「字」与「方框」。给 CI 装 `fonts-noto-cjk`，并补两条断言（G7-5），断言下限从 13 抬到 15。
- **G7-5 的第一版自己也是假保证**：用 `document.fonts.check('13.5px "Microsoft YaHei"', '国赛')` 问字体在不在，实测五个族名全部返回可用，包括 runner 上根本没装的 YaHei 与 PingFang——Chromium 只要有回退字体就对任何族名返回 true。改成能双向区分的度量：把「国」与空心框「□」画进 canvas 比暗像素，缺字体时两者墨量接近（比值≈1），有字体时「国」明显更密（阈值 1.5）。装字体前后两张截图的对比也印证了这个方向：PNG 从 23.3 KB 变 79.3 KB、非白像素从 2.09% 升到 2.79%。

### 已知风险

- 本机没有执行过 `npm install`（npm 直连在本机不可用），所以本地跑绿的只有四道不吃网络的门禁；构建、G6 与 G7 的证据全部来自 CI。这两套证据不等价，装机路径要到 M6 才算被真实验过。
- 便携 Python、TeX 与 pandoc 的取回策略还没实现；`docs/env-setup.md` 里写的是指引，不是代码。

### 被反向覆盖当场抓出的缺陷（已修）

写门禁时先跑了自己的破坏夹具，三处真问题因此暴露——这正是「检查器必须能失败」的用处：

- `minimal_validate`（jsonschema 缺席时的降级校验）放过了非法 `kind`。补上 `kind` / `contribution` / `status` 三个枚举断言，并把 C3 反向覆盖从 2 例扩到 5 例，两种模式现在都是 9/9。
- `validate_contracts.py` 误把 `jsonschema.Draft202012Validator.check_schema()` 当成返回错误列表的 API 用，`list(None)` 直接 `TypeError` 崩在门禁自己身上。改为按文档语义捕获 `SchemaError`。
- 徽章匹配正则把域名写成 `shields.org`（实为 `shields.io`），导致 G1 的 R9 恒定报「徽章缺失」。修掉后 R9 才第一次真正比对上。
