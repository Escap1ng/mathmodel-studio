# 交接 · M0 完成时的状态

给接手的人（或下一轮会话的我）。日期 2026-10-16，本文件写作时 HEAD 是 `cd78cc4`，本地与远端一致、工作树干净。
提交数与文件数不要信我抄在这里的数字，跑 `git rev-list --count HEAD` 和 `git ls-files | wc -l` 自己取。

## 0 一句话现状

M0 脚手架交付完：白底三栏骨架能真起窗，技能注册表与契约就位，每条门禁**都被证明会失败**。
**还不能建模**——没有 LLM 接入、没有 runtime、技能内容是占位。里程碑见 [../PLAN.md](../PLAN.md) §7。

仓库当前是 **private**。转公开需要维护者点头（`gh repo edit --visibility public`）。

## 1 怎么验（命令 → 期望）

不需要网络、不需要显示器的部分：

```bash
node scripts/check-registry.mjs              # 8/8 项通过，技能 7 个        → exit 0
node scripts/check-registry.negative.mjs     # 9/9 条破坏被门禁抓到          → exit 0
node scripts/check-window-smoke.mjs --selftest  # 9/9 条核验自测            → exit 0
python scripts/validate_contracts.py         # 9/9 项通过（判据来源 jsonschema）→ exit 0
python runtime/selfcheck.py                  # 8/8 条 CLI 契约断言通过       → exit 0
```

需要 `npm install` 的部分（本机没跑过，见 §2）：

```bash
npm install && npm run typecheck && npm run build && node scripts/smoke-dist.mjs
npm run smoke:window   # 真起窗口，写 screenshots/window-smoke.{png,json}
npm run verify:window  # 独立读 JSON 并复算读数
```

一把梭：`npm run gate`（顺序见 `package.json` 的 scripts）。

CI：<https://github.com/Escap1ng/mathmodel-studio/actions> —— 三 job：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、
`真启动冒烟 · ubuntu`。取回截图看：

```bash
gh run download <run-id> -n window-smoke --dir screenshots
```

## 2 已证 / 未证（别混）

| 结论 | 证据来源 | 强度 |
| --- | --- | --- |
| 注册表契约跨平台自洽 | 本机 + CI ubuntu + CI windows | 强 |
| 七道门禁都会失败 | 每道都跑过负向用例，输出在 CI 日志里 | 强 |
| Electron 44.8.0 + electron-vite 6 + Vite 8 + TS 7 能装能编 | CI 双平台真构建 | 强 |
| 生产入口能起窗并画出中文界面 | CI ubuntu 真启动，15/15 断言 + 人看图 | 中——**只有 Linux** |
| Windows 上真起窗 | 无 | **未证**：Windows job 不下载 Electron 二进制、不起窗 |
| 照手册 `npm i` 起空窗（本机路径） | 无 | **未证**：本机没跑过 `npm install`，联网动作归维护者 |
| 沙箱与 CSP 在生产配置下有效 | G7 在 `sandbox: true` 下跑通 IPC | 中：CSP 违规场景没主动探 |

## 3 待维护者定的三项

1. **仓库名**：现在是暂定名 `mathmodel-studio`，撞了 `yan315598-design/mathmodel-studio`（★47），但带命名空间仍唯一。改名成本随提交数上升，越早越好。
2. **UI 取向**：我按「手写 CSS 令牌 + 不引 Tailwind」先落地了（`src/renderer/src/styles/tokens.css`）。要换 Tailwind 就趁 M2 之前，越晚越贵。
3. **排版引擎优先级**：xelatex（接上游现状）/ Typst（MathModelAgent 靠 17 套 Typst 模板赢在观感）/ 双支持。影响 M5 与 skills 层是否扩。

另外**已替你做过、可以推翻**的假设：技能内容 vendor 进本仓库并保留出处（`skills/VENDOR.md`）；桌面壳放 `src/` 而非 `desktop/`（electron-vite 默认约定）；强调色默认 A 墨青（状态栏可切三案）。

## 4 界面待判的观感问题（我只报，没改）

截图在 `screenshots/window-smoke.png`（1440×900，Linux + Noto CJK 下渲染）：

- 左栏 240px 装不下「赛题分析与背景调研」，折行后第二行只挂一个「研」字，且圆点与第二行基线错位。三条路：缩短阶段名 / 左栏加宽到 260 / 状态列改成只有点。
- 阶段圆点是 `1.5px` 描边 `#DCE0E6`，在白底上很淡。
- 中栏空态文字贴顶，下方到输入框之间是 500px 量级的空区，上下不均衡。
- 发送按钮禁用态是灰底灰字，对比度目测不达 WCAG AA。
- 状态栏右侧三枚色块与「墨青」挤在一起，间距 5px 偏小。

## 5 M1 要做的具体动作

1. 从 `Escap1ng/mathmodel-kit` v2.0.1 把 7 个技能目录的内容复制进 `skills/<name>/`（`SKILL.md`、`docs/`、`code/`、`templates/`、`themes/`），层级最深 2 层。
2. 每个技能在 `skills/manifest.json` 里把 `status` 从 `planned` 改成 `vendored`。
   **注意 G1 的 R4 会立刻开始要求 `entry` 文件真实存在**，且 `planned` 目录里不许有 `SKILL.md`——半 vendor 会被拦。
3. 删掉各目录的 `PLACEHOLDER.md`，在 `skills/VENDOR.md` 的 re-sync 表填上游版本号与 commit。
4. 补 `requirements.txt`（上游是 matplotlib/numpy/seaborn/python-docx/PyMuPDF/jsonschema 六项）+ 装依赖的镜像说明。
5. 让 runtime 真 subprocess 调技能脚本：`mms invoke figure <id>` 出 PNG/PDF/SVG 并按 `0/1/2` 退出；把这三码的可达性加进 `runtime/selfcheck.py`。
6. 上游 `SKILL.md` 的 frontmatter 要继续保持 Agent Skills 规范合法，**本仓库的 UI 字段只写在 manifest.json 里，不要塞进 SKILL.md**（见 `skills/VENDOR.md` 第 5 条）。
7. 欠的文档债：`docs/env-setup.md` 英文版。

## 6 这一轮踩过的坑（别再踩）

**网络**：`registry.npmjs.org` 直连超时，`registry.npmmirror.com` 可用；`github.com:443` 会随机拒绝连接而 `api.github.com` 照常工作——`git push` 失败先有界重试再换手段，别立刻报做不到。`.npmrc` 里钉了 Electron 二进制镜像，信任边界写在 `docs/env-setup.md`。

**Electron 在 CI（Linux）**：
- `chrome-sandbox` 必须 root:4755，否则 `FATAL:setuid_sandbox_host` 在任何断言前就退出。**修权限，不要用 `--no-sandbox` 绕**——绕了就没在验生产的 `sandbox: true`。
- 二进制在 `npm install` 后可能还没落地，要显式 `node node_modules/electron/install.js`；而且**任何 `npx electron` 的调用都得排在 chmod 之后**。
- xvfb 屏幕要大于窗口含边框的尺寸；正好 1440×900 会把内容区钳成 1439x899。
- runner 默认没有中文字体，界面会整片豆腐。装 `fonts-noto-cjk`。

**量具自己会造假**（四种，全部实际发生并已被堵）：
1. `app.exit(1)` 被生产入口的 `window-all-closed → app.quit()` 顶掉 → 日志写着 10/12 通过、job 却是绿的。收法：结论落盘 JSON，由另一个进程核验（`scripts/check-window-smoke.mjs`）。
2. 冒烟自建 `BrowserWindow` → `ipcMain.handle` 从没注册过，`app:meta` 报 No handler。收法：`require` 生产入口。
3. `document.fonts.check('13.5px "Microsoft YaHei"', '国赛')` 对没装的字体也返回 true。收法：比「国」与「□」的 canvas 墨量（实测 2.75 vs 阈值 1.5）。
4. 「非白像素 ≥1%」分不清字与空心方框。收法：**把 CI 产物取回来看一眼**，这一步发现了上面第 3、4 两件事。

**Windows 本机**：控制台默认 GBK，Python 脚本 print 中文会崩——`mms` CLI 与两个门禁脚本都已显式 `reconfigure(encoding='utf-8')`；`pandoc` 本机没装；PowerShell 5.1 读含中文的 `.ps1` 要 UTF-8 BOM（见 `docs/env-setup.md` §6）。

**TypeScript 7**：CSS 副作用导入报 `TS2882`，需要 `/// <reference types="vite/client" />`（`src/renderer/src/env.d.ts`）。

## 7 结构速查

```
skills/manifest.json      单一事实源：7 个技能 + UI 契约（phases/artifacts/hitl）
schemas/                  Draft 2020-12 契约；枚举与 manifest 词表由 G1 交叉校验
runtime/src/mms/          registry.py（定位仓库根、降级校验）+ cli.py（0/1/2 三码）
src/main/                 窗口与 IPC：useContentSize、sandbox、CSP、导航守卫
src/renderer/src/         App + PhaseRail + ChatPane + WorkspacePane + lib/phases.ts + styles/
scripts/                  四个门禁 + 反向覆盖 + 结果核验
tests/window-smoke.cjs    真启动断言（15 条），结论写 screenshots/window-smoke.json
.github/workflows/ci.yml  gates（ubuntu+windows）与 window-smoke（ubuntu）
```

一处刻意的设计：`runtime` 只用 subprocess 调技能脚本、按退出码判定，不 import 技能内部函数——这样 `skills/` 仍可被 Claude Code 等宿主单独装载。改这条要先想清楚代价。
