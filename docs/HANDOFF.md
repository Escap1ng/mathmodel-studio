# 交接 · M1 完成时的状态

给接手的人（或下一轮会话的我）。日期 2026-10-20。
提交数与文件数不要信我抄在这里的数字，跑 `git rev-list --count HEAD` 和 `git ls-files | wc -l` 自己取；HEAD 以 `git log -1` 为准。

## 0 一句话现状

M1 技能落地：七个技能从上游 v2.0.1 原样 vendor 进仓库，注册表全部翻为 `vendored`；不接模型也能 `mms templates` 列 25 个模板、`mms invoke figure <id>` 真出 PNG/PDF/SVG。
**还不能建模**——没有 LLM 接入、没有编排、没有通道。里程碑见 [../PLAN.md](../PLAN.md) §7。

仓库当前是 **private**。转公开需要维护者点头（`gh repo edit --visibility public`）；转公开之前先读 §3 的拓扑计划。

## 1 怎么验（命令 → 期望）

需要先装两侧依赖：`npm install`（可加 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，CI 不启动窗口时用）与
`python -m pip install -r requirements.txt -i https://registry.npmmirror.com/pypi/simple/`。

不需要网络、不需要显示器的部分：

```bash
node scripts/check-registry.mjs                 # 8/8 项通过，技能 7 个            → exit 0
node scripts/check-registry.negative.mjs        # 9/9 条破坏被门禁抓到（含基线自证）→ exit 0
node scripts/check-skills.mjs                   # 6/6 项通过，技能 7 个            → exit 0
node scripts/check-skills.mjs --self            # 7/7 条自检通过（含基线自证）     → exit 0
node scripts/check-window-smoke.mjs --selftest  # 9/9 条核验自测                   → exit 0
python scripts/validate_contracts.py            # 9/9 项通过（jsonschema）         → exit 0
python runtime/selfcheck.py                     # 13/13 条 CLI 断言，含真渲一张图  → exit 0
```

`check-cli` 会真的调 matplotlib 渲染 `paired-raincloud`（约十几秒），所以它需要 `requirements.txt` 里的包；
只跑注册表部分时不需要。

需要显示器的部分：

```bash
npm run smoke:window   # 真起窗口，写 screenshots/window-smoke.{png,json}
npm run verify:window  # 独立读 JSON 并复算读数
```

一把梭：`npm run gate`（顺序见 `package.json` 的 scripts）。

CI：<https://github.com/Escap1ng/mathmodel-studio/actions> —— 三 job：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、
`真启动冒烟 · ubuntu`。M1 首轮 run `39398588127` 三 job 全绿。取回截图看：

```bash
gh run download <run-id> -n window-smoke --dir screenshots
```

## 2 已证 / 未证（别混）

| 结论 | 证据来源 | 强度 |
| --- | --- | --- |
| 注册表契约跨平台自洽 | 本机 + CI ubuntu + CI windows | 强 |
| M1 全门禁与真启动在 CI 通过 | run `39398588127` 三 job 全绿；G3 真渲在 ubuntu/windows 各跑一次 | 强 |
| 七个技能与上游 v2.0.1 逐字节一致 | 复制后逐文件 sha256 与上游 tarball 比对 | 强（本机） |
| `SKILL.md` 仍是合法 Agent Skills 入口 | G8 6 项检查 + 6 种破坏全部被拒；CI 双平台同跑 | 强（本机 + CI） |
| `mms invoke figure` 真出三件产物 | 本机 Windows 真渲 + CI ubuntu/windows 的 S10 真渲，均核验文件非空 | 强（仅 figure） |
| 渲染器「退出 0 但没写产物」会被判 1 | selfcheck S13 用假渲染器反向覆盖 | 强（本机） |
| Electron 44.8.0 + electron-vite 6 + Vite 8 + TS 7 能装能编 | 本机 `npm install` + CI 双平台构建 | 强 |
| 照手册 `npm i` 起空窗（本机路径） | 本机已跑通 `npm install`（81 包，走 npmmirror） | 强（安装本身） |
| 生产入口能起窗并画出中文界面 | CI ubuntu 真启动，15/15 断言 + 人看图 | 中——**只有 Linux** |
| Windows 上真起窗 | 无 | **未证**：Windows job 不下载 Electron 二进制、不起窗 |
| 沙箱与 CSP 在生产配置下有效 | G7 在 `sandbox: true` 下跑通 IPC | 中：CSP 违规场景没主动探 |
| `diagram` / `deai` / `score` / `paper` 能从 runtime 调起 | 无 | **未证**：M1 只接通了 figure |

## 3 待维护者定的项

1. **收尾时的仓库拓扑**（已定方向，待择时）：两仓独立 → kit 冻结 → studio 完工后把 studio 历史合并进 kit（`--allow-unrelated-histories`，保留两个来源的提交与 `VENDOR.md` 里的出处哈希）→ 先把现有私有 studio 仓改名腾位、再把 kit 改名为 `mathmodel-studio`。star 跟随被改名的 kit；`mathmodel-kit` 这个名字此后不要复用。**不要 force-push 覆盖**，否则技能出处哈希变成孤悬对象。合并必须在 M1 vendor 之后进行。
2. **UI 取向**：现在「手写 CSS 令牌 + 不引 Tailwind」。要换就趁 M2 之前。
3. **排版引擎优先级**：xelatex（接上游现状）/ Typst（MathModelAgent 靠 17 套模板赢在观感）/ 双支持。影响 M5 与 skills 层是否扩。

另外**已替你做过、可以推翻**的假设：技能内容 vendor 进本仓库并保留出处；桌面壳放 `src/` 而非 `desktop/`；强调色默认 A 墨青（状态栏可切三案）。

## 4 界面待判的观感问题（我只报，没改）

截图在 `screenshots/window-smoke.png`（1440×900，Linux + Noto CJK 下渲染）：

- 左栏 240px 装不下「赛题分析与背景调研」，折行后第二行只挂一个「研」字，且圆点与第二行基线错位。三条路：缩短阶段名 / 左栏加宽到 260 / 状态列改成只有点。
- 阶段圆点是 `1.5px` 描边 `#DCE0E6`，在白底上很淡。
- 中栏空态文字贴顶，下方到输入框之间是 500px 量级的空区，上下不均衡。
- 发送按钮禁用态是灰底灰字，对比度目测不达 WCAG AA。
- 状态栏右侧三枚色块与「墨青」挤在一起，间距 5px 偏小。

M1 没有改这些，留到界面真正开始有内容的 M2/M3。

## 5 M1 做完的与仍欠的

已完成：

1. 七个技能目录整目录原样复制（含 `README.md` 与 `examples/`），逐文件 sha256 与上游一致。
2. 注册表 7 个 `status` 翻为 `vendored`；G1 的 R4 开始要求入口真实存在。
3. 占位文件删除；`VENDOR.md` 填上 v2.0.1 与 commit `5ec0e464da0ae415d3db87cf53fb66eb6e2dff24`。
4. 根 `requirements.txt` 六项 + 镜像说明。
5. `mms templates` / `mms invoke figure <id>`；`selfcheck.py` 13 条，含真渲染与「假成功」反向覆盖。
6. G8 技能规范门禁 + 6 条负向对照，接入 `npm run gate` 与 CI。

仍欠：

- `docs/env-setup.md` 英文版（M0 就欠着，M1 仍未补）。
- `diagram` 的 runtime 入口；其余技能的命令行入口（M2/M4 按需接）。
- 便携 Python 运行时的下载与内置（M5/M6）。

## 6 这一轮踩过的坑（别再踩）

**上游源码怎么取**：本机没有 kit 检出；`github.com:443` 仍然连不上（`git ls-remote` 21 秒后失败），但 `api.github.com` 正常。
`gh api repos/Escap1ng/mathmodel-kit/tarball/v2.0.1` 一次成功（14.5 MB），tarball 顶层目录名带短 SHA `5ec0e46`，与 tag 指向的完整提交一致。
**取上游别死磕 git 通道。**

**VENDOR.md 的旧规则是错的**：M0 写的「层级最深 2 层（与上游一致）」与上游不符——`mathmodel-figure/code/style/`、
`mathmodel-diagram/code/templates/schema/` 都在第 3 层。照旧规则 vendor 会漏掉样式模块与 schema，模板直接跑不起来。
已改成「最深 3 层」。**写「与上游一致」之前先去上游数一遍。**

**全部翻成 vendored 之后，G1 的两条测试同时失效**：
- 反向用例 M2 原本是「把 planned 改成 vendored 但不放入口」，基线全 vendored 后它变成空操作；
- 夹具还在拷贝已删除的 `PLACEHOLDER.md`，直接 `ENOENT`。
收法：M2 改为「把 entry 指向不存在的文件」，夹具复制真实 `SKILL.md`。**改状态位这类全局变更，先看哪些测试靠旧状态成立。**

**Windows 上把带中文输出的命令接 `| head` 会假失败**：`npm run mms -- templates | head -3` 报
`Exception ignored while flushing sys.stdout: OSError: [Errno 22] Invalid argument` 且没有输出——`head` 提前关管道，
Python 退出时 flush 失败。命令本身是好的，重定向到文件再读即可。**别把它当成 CLI 坏了。**

**依赖版本**：本机 Python 3.14.5 + matplotlib 3.10.9 + numpy 2.4.4 + seaborn 0.13.2 能原样跑上游 v2.0.1 模板，
渲出的 `paired-raincloud` 与上游 `examples/previews/` 里的同名图一致。`requirements.txt` 仍按上游下限声明，不锁版本。
CI 的 gates job 已改为安装整份 `requirements.txt`，因为 G3 现在真的要 matplotlib。

**npm 依赖**：本机此前没装过（M0 只在 CI 装）。这轮用 `--registry=https://registry.npmmirror.com` +
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 装了 81 个包（54 s）。`.npmrc` 里的 `electron_mirror` 会让 npm 打 Unknown config 警告，不影响安装。

**上一轮的坑仍然有效**：`chrome-sandbox` 要 root:4755（别用 `--no-sandbox` 绕）；Electron 二进制懒下载；
xvfb 屏幕要大于窗口含边框尺寸；runner 缺中文字体会整片豆腐；`app.exit(1)` 会被生产入口的 `app.quit()` 顶掉（所以结论落盘、独立核验）；
`document.fonts.check` 对没装的字体也返回 true；非白像素比分不清字形与方框。
**Windows 本机**：控制台 GBK；`pandoc` 没装；PS 5.1 读含中文的 `.ps1` 要 BOM。**TypeScript 7**：CSS 副作用导入需要 `vite/client` 引用。

## 7 结构速查

```
skills/                  7 个 vendor 进来的技能（原样）+ manifest.json（本仓库唯一事实源）+ VENDOR.md
schemas/                 Draft 2020-12 契约；枚举与 manifest 词表由 G1 交叉校验
runtime/src/mms/         registry.py（仓库根定位、降级校验）+ invoke.py（subprocess 调模板、核验产物）+ cli.py
runtime/cli.py           开发期入口：python runtime/cli.py（npm run mms）
src/main/                窗口与 IPC：useContentSize、sandbox、CSP、导航守卫
src/renderer/src/        App + PhaseRail + ChatPane + WorkspacePane + lib/phases.ts + styles/
scripts/                 G1/G1 反向/G8/G8 反向/G6/G6b 与契约校验
tests/window-smoke.cjs   真启动断言（15 条），结论写 screenshots/window-smoke.json
.github/workflows/ci.yml gates（ubuntu+windows，含 Python 依赖）与 window-smoke（ubuntu）
```

一处刻意的设计：`runtime` 只用 subprocess 调技能脚本、按退出码判定，不 import 技能内部函数——这样 `skills/` 仍可被 Claude Code 等宿主单独装载。改这条要先想清楚代价。
