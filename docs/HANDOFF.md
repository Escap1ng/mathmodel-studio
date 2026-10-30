# 交接 · M4 完成时的状态

给接手的人（或下一轮会话的我）。日期 2026-10-30。
提交数与文件数不要信我抄在这里的数字，跑 `git rev-list --count HEAD` 和 `git ls-files | wc -l` 自己取；HEAD 以 `git log -1` 为准。

## 0 一句话现状

M4 工作台：M3 的 K2/K3/K4 编排闭环保留；右栏现在能真渲一张图、换主题重渲、并排看新旧版并回滚；评分页给五维分、总分 86 达标、扣分正文定位、第三轮熔断与一票否决示例；顶部门禁条汇总图表/评分/章节。
工作台样例来自 vendored 技能与演示评分卡，**不是对真实论文的自动评判**；论文 PDF 预览与自动代码/排版在 M5。
**还不能自动写代码或生成论文**。里程碑见 [../PLAN.md](../PLAN.md) §7。

两句必须保留的限制：

- **没有用真实 DeepSeek/Kimi Key 跑过联网对话。** 已验证的是 OpenAI 兼容协议（本地假端点）与整条本机链路；两家服务的当下行为不在证据里。
- 仓库仍是 **private**。转公开需要维护者点头；转公开之前先读 §3 的拓扑计划。

## 1 怎么验（命令 → 期望）

需要先装两侧依赖：`npm install`（可加 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，CI 不启动窗口时用）与
`python -m pip install -r requirements.txt -i https://registry.npmmirror.com/pypi/simple/`。
窗口冒烟还需要 Python 在 `PATH` 上（Windows 的 `python`，Linux/macOS 的 `python3`；不在就用 `MMS_PYTHON` 指）。

不需要网络、不需要显示器的部分：

```bash
node scripts/check-registry.mjs                 # 8/8 项通过，技能 7 个            → exit 0
node scripts/check-registry.negative.mjs        # 9/9 条破坏被门禁抓到（含基线自证）→ exit 0
node scripts/check-skills.mjs                   # 6/6 项通过，技能 7 个            → exit 0
node scripts/check-skills.mjs --self            # 7/7 条自检通过（含基线自证）     → exit 0
node scripts/check-window-smoke.mjs --selftest  # 12/12 条核验自测                  → exit 0
python scripts/validate_contracts.py            # 9/9 项通过（jsonschema）         → exit 0
python runtime/selfcheck.py                     # 13/13 条 CLI 断言，含真渲一张图  → exit 0
python runtime/selfcheck_channel.py             # 46/46 条通道断言（含 M3 恢复）  → exit 0
python runtime/selfcheck_channel.py --selftest  # 10/10 条坏事件被拒                → exit 0
python runtime/selfcheck_workbench.py           # 13/13 条工作台断言（真渲两版）   → exit 0
```

`selfcheck.py` 与 `selfcheck_workbench.py` 会真的调 matplotlib 渲染（各十几秒），需要 `requirements.txt`；
`selfcheck_channel.py` 只起本机 Python 子进程与 127.0.0.1 上的假 OpenAI 端点，不需要 matplotlib、也不联网。

需要显示器的部分：

```bash
npm run smoke:window   # 真起窗口，53/53，写 screenshots/window-smoke.{png,json}、conversation.png、settings.png、decision.png、drawer.png、figure.png、score.png
npm run verify:window  # 独立读 JSON 并复算读数
```

`smoke:window` 自己设置 `MMS_FAKE_PROVIDER=1`，并把 Electron `userData` 指到临时目录，所以它不会用你已保存的真实 provider，也不会带着哨兵 Key 发请求；工作台的图表与版式也写在这个临时目录。
跑完可以直接看 `screenshots/decision.png`、`screenshots/figure.png` 与 `screenshots/score.png`；断言通过不等于观感合格。

一把梭：`npm run gate`（顺序见 `package.json` 的 scripts；G7 不在 gate 里，因为它要显示器和 Electron 二进制）。

**本机跑 G7 前去掉 `ELECTRON_RUN_AS_NODE`**：本会话 shell 里它是 `1`，会让 `electron` 退化成 Node 并报 `app.setPath` 不存在。用 `env -u ELECTRON_RUN_AS_NODE npx electron tests/window-smoke.cjs`。

CI：<https://github.com/Escap1ng/mathmodel-studio/actions> —— 三 job：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
0.3.0 的 run `40982728779` 三 job 全绿；ubuntu 真启动 42/42、非白像素 3.15%（M2 的历史 run `40658227855` 为 27/27）。0.3.1 的 run `41000678500` 三 job 全绿，ubuntu 真启动 43/43、非白像素 3.12%，Linux 应用菜单为空。0.4.0 的 run `41008695577` 三 job 全绿，ubuntu 真启动 53/53、非白像素 3.98%，G9 13/13、G6 14/14。取回截图：

```bash
gh run download <run-id> -n window-smoke --dir screenshots-m3-ci
```

## 2 已证 / 未证（别混）

| 结论 | 证据来源 | 强度 |
| --- | --- | --- |
| 注册表、技能规范、契约与 CLI 仍自洽 | 本机 gate + CI 双平台（M1 起） | 强 |
| 本机通道：握手、Bearer、Host/Origin、SSE 契约、续传、取消 | `selfcheck_channel.py` 46/46（本机 Windows） | 强（本机） |
| 编排闭环：K2→K3→换一批→选择→阶段四 | 同上的 C12，事件与快照双向核对 | 强（本机） |
| 跨进程恢复：换一个服务器进程仍停在 K2 | 同上的 C13，两个 `Channel` 进程共用一个临时数据目录 | 强（本机） |
| 界面端到端：K2/K3 卡、解释抽屉、换一批、选择、runtime 重启后 K3 仍在 | G7 53/53，本机 Windows 真启动 + 人看截图 | 强（本机 Windows） |
| 图表工作台：真渲两版、换主题、并排 diff、回滚 | G9 W2–W4；G7 工作台段；两版 PNG hash 不同 | 强（本机） |
| 评分卡：三轮、五维、扣分定位、第三轮熔断、一票否决 | G9 W6；G7 评分段；评分由 vendored `score_card.py` 计算 | 强（演示数据，非真实论文） |
| 章节样例 hard/soft 为 0 | G9 W7，`check_chapters.py` 跑 `chapter-sample.tex` | 强（样例文件） |
| 论文 PDF/Word 预览 | 未接；论文页只显示边界说明 | **未证**（M5） |
| K5 换数据列/字号密度/容量超框 | 未接；当前只做模板/主题/版本/回滚 | **未证** |
| OpenAI 兼容协议：429 退避、reasoning 分离、分片 tool_calls、历史剥离、Key 不外泄 | 本地假端点，3 次真实 HTTP 请求 | 强（协议层，非真实厂商） |
| Key 落盘：Windows 上只有 `safeStorage` 密文，无明文 | G7 写入哨兵 Key 后读 `settings.json`，只输出布尔值 | 强（Windows 可用分支） |
| 安全存储不可用时拒绝保存且不落盘 | CI run `40982728779` 的 Linux runner 无 Secret Service，G7 实得 `可用=false、文件存在=false、明确拒绝=true` | 强（拒绝分支）；Linux 桌面 Secret Service 可用分支仍未证 |
| 真实 DeepSeek / Kimi 联网对话 | 无 Key，未跑 | **未证** |
| Linux 上真起窗与整条链路 | 0.4.0 CI run `41008695577`，53/53（1440x900，非白像素 3.98%），G6b 独立核验一致 | 强（M4） |
| Windows CI 真起窗 | 无 | **未证**；M2/M3/M4 的 Windows 证据来自本机 |
| K4 数学公式用 KaTeX 渲染 | M3 用等宽文本展示公式，没有引入 KaTeX | **未证**（排版增强留待 M5） |
| `gate` / `artifact` 事件能渲染成卡片 | 工作台有门禁条；事件本身仍只有契约与转发 | **未证**（M5） |
| 工具不只 `list_templates` | 无 | **未证**；M4 仍未扩工具面 |

## 3 待维护者定的项

1. **收尾时的仓库拓扑**（方向已定，待择时）：两仓独立 → kit 冻结 → studio 完工后把 studio 历史合并进 kit（`--allow-unrelated-histories`，保留两个来源的提交与 `VENDOR.md` 里的出处哈希）→ 先把现有私有 studio 仓改名腾位、再把 kit 改名为 `mathmodel-studio`。star 跟随被改名的 kit；`mathmodel-kit` 这个名字此后不要复用。**不要 force-push 覆盖**，否则技能出处哈希变成孤悬对象。
2. **排版引擎优先级**（M5）：xelatex（接上游现状）/ Typst / 双支持。
3. **provider 列表的维护方式**：现在三家写死在 `runtime/src/mms/providers.json`，界面允许手填模型名与自定义端点。是否要在 M4 前改成用户可增删的服务商列表，取决于你想把「选模型」做成多重的决策点。
4. **Key 的 Linux 兜底**：当前规则是安全存储不可用就拒绝保存，不退回明文。如果目标用户里有 Linux 桌面且没有 Secret Service，是保持拒绝、还是明确提示后允许「本次会话内存保存」，需要你拍板。
5. **图标系统（M4 前）**：当前阶段状态只用色点与文字。若要加图标，建议自绘 16/20px 线性 SVG（阶段、工具、决策各一套），不用图标字体，颜色跟 `currentColor` 走；需要你定风格与覆盖范围。应用图标也还没有。

## 4 界面待判的观感问题（我只报，没改）

`screenshots/window-smoke.png`、`conversation.png`、`settings.png`、`decision.png`、`drawer.png`、`figure.png`、`score.png` 都是 1440×900、本机 Windows 下渲染。

0.3.1 已处理：左栏阶段名折行、候选卡密度与元数据排布、抽屉关闭按钮对齐、输入条与状态栏间距；0.4.0 新增工作台。下面保留仍需你判断的观感项。

M1 已报、仍未改：

- 左栏 240px 装不下「赛题分析与背景调研」，折行后第二行只挂一个「研」字，圆点与第二行基线错位。
- 阶段圆点是 `1.5px` 描边 `#DCE0E6`，在白底上很淡。
- 中栏空态文字贴顶，下方到输入框之间是 500px 量级的空区。
- 状态栏右侧三枚色块与「墨青」间距 5px 偏小。

M3 新增：

- 决策卡放在助手消息内部，宽度跟随对话列；三张候选在 1440 宽下并排可读，更窄时 `auto-fit` 会折成两行。
- 已确认/已选的卡保留在对话流里，动作按钮变灰；这是为了可追溯，但长会话会越来越长。要不要折叠旧卡，你定。
- K4 抽屉覆盖右栏，标题区会压住工作台标签的一部分；现在是覆盖而非推移。是否加遮罩或改成推挤式，属于视觉选择。
- K4 的公式目前是等宽文本，不是 KaTeX；M3 没有引入前端公式渲染依赖。
- 阶段 0 的说明是「runtime 环境就绪」，不代表 xelatex/pandoc 预检已做；K1 完整预检等到 M5 前。

M2 已报、仍适用：

- 工具卡用的是 `--surface` 灰底（`#FAFAFA`），与白底只差一点；是否足够“像一张卡”需要你看截图定。
- 模型条最长 300px，`自定义 OpenAI 兼容端点` 这类长名字会被省略号截断。
- 设置页四个服务商是等宽胶囊，没有分组；离线演示排在第一位。
- 对话截图是在测试点了 B 案靛蓝之后拍的，默认仍是 A 墨青。

M4 新增：

- 图表页在 440px 右栏里做两图并排 diff，单张会缩到约 180px 宽；看得清趋势，看不清细节。是否改成上下堆叠或加“放大查看”，需要你定。
- 评分页信息密度较高：五维条、轮次、较上一轮变化、扣分明细、定位卡都在一屏内滚动；是否把“较上一轮”折起来，属于视觉选择。
- 论文页明确写了 PDF/Word 预览等到 M5，没有放假预览。
- 门禁条三项（图表/评分/章节）目前都能从工作台状态复算，但章节检查跑的是样例 `chapter-sample.tex`。

## 5 M4 做完的与仍欠的

已完成：

1. `workbench_figure.py`：真渲两版、主题切换、版目录、当前/上一版、回滚；未知模板/主题/版本不落版本。
2. `workbench_score.py` + `demo_scores.json`：三轮评分（78/86/84）、五维、扣分定位、熔断、一票否决；章节样例。
3. 通道与 IPC：`/workbench/state|render|rollback`；主进程读 PNG 成 data URL，渲染层不碰文件路径。
4. 右栏：图表页、评分页、门禁页、代码页、日志页；顶部门禁条；论文页明确留待 M5。
5. G9 13 条、G7 53 条、G6b 下限 53；CI window-smoke 增加 matplotlib 依赖。
6. 文档：README/README_EN、CHANGELOG 0.4.0、HANDOFF。

仍欠：

- **论文 PDF/Word 预览**（M5）。
- K5 的换数据列、字号密度与容量超框检查；当前只有模板/主题/版本/回滚。
- 评分是演示数据，不是对用户真实论文的自动评分。
- 选模候选仍由内置模板生成；真实模型选型与工具面扩展未做。
- 真实厂商连通性、Linux 桌面 safeStorage 可用分支、Windows CI 起窗。
- 便携 Python 与 `docs/env-setup.md` 英文版。

## 6 这一轮踩过的坑（别再踩）

**SSE 流不会自己结束**：最开始 `done` 之后 HTTP/1.1 连接仍然保持，客户端的 `reader.read()` 永远等下一块，冒烟挂死。修法是响应头 `Connection: close` 且服务端 `self.close_connection = True`。**任何“事件流”都要定义终止条件，不能只发 done 事件。**

**事件比 `chat.start` 的返回值先到**：主进程收到第一块 SSE 时，渲染层可能还没拿到 `chatId`。现在按 `chatId` 先暂存、拿到 id 后按序补放；上限 500 条，避免旧流污染无限增长。改这段时先想清楚“没有 activeChat 时事件归谁”。

**G7 的假 provider 必须在 require 生产入口之前设环境变量**，否则主进程在 `whenReady` 拉起 Python 时继承不到。`userData` 也要在 ready 之前 `app.setPath` 到临时目录，否则你机器上已保存的 DeepSeek 会改变默认选中项，测试会莫名其妙地发向真实网络。G7 还显式把 provider 切回离线演示，切不回去就中止，绝不带着哨兵 Key 发请求。

**G6b 只数条数不够**：删掉一条关键断言、拿凑数的 `A` 行补齐，条数照样够。现在下限 53，点名 17 条关键断言（M2/M3/M4），并拒绝重复断言名；自测 12 条。

**不要在 runtime 里自动起图**：最初工作台在首次载入时自动 `render`，但 G7 会在 K3 阶段重启 runtime，渲染 POST 与重启撞上，留下 `ECONNRESET` 且版本没写成，之后界面永远没有图表。现在改成空态里的「渲染样例图」显式按钮；重启后工作台重新读状态，用户再点一次。

**评分轮次的字段要防缺**：一票否决示例没有“较上一轮”的变化，`round.changes.length` 直接读会崩掉整个评分页。后端给每张卡补 `changes: []`，前端也用 `round.changes ?? []`。

**data URL 有体积上限**：主进程把 PNG 读成 base64 后通过 IPC 下发，超过 12 MB 直接返回 null，避免一次渲染把 IPC 撑爆；渲染层只拿到 data URL，不拿本地路径。

**工作台也是 CI 依赖**：window-smoke job 现在要真渲图，必须装 `requirements.txt`（matplotlib/numpy/seaborn）；gates job 的 G9 也需要。别把它们当成“只跑标准库”的 job。

**快照必须先落盘再发 `done`**：界面在收到 `done` 后就会允许下一步操作，若此时 SQLite 还没写完，用户点“重开仍在”就会读到旧状态。orchestrator 先 `store.put`，再返回事件；WorkflowSession 只是把事件顺序发出。

**恢复快照不能无条件覆盖当前对话**：启动/runtime 重启时只在「有 pending」或「当前对话为空」时套用快照；否则用户刚开的新会话会被上一次的旧卡顶掉。

**界面取数字字段要转字符串**：`text()` 只接受 string，导致 `batch: 2` 在卡脚显示成「第 1 组」；G7 用「第 2 组」文本断言抓到了。payload 里的数字要么 `String()`，要么 helper 支持 number。

**分数缩放下 `useContentSize` 会抖 1–2 DIP**：本机 150% 缩放时内容区读到 1440×902。`ready-to-show` 里再 `setContentSize(1440, 900)` 钉一次；G6b 仍按精确值判，不放宽阈值。

**解释按钮在已选卡上仍有意义**：已选/已确认卡只禁用「选它 / 换一批」，不禁止打开解释；G7 因此只断言这两类按钮禁用，不要写成“卡内所有按钮都禁用”。

**阶段状态文案不能借门禁**：M3 没有跑任何门禁，`passed` 的文案从「已过门禁」改成「已完成」；阶段 0 只声明 runtime 环境就绪，外部排版依赖未检。

**本机 shell 可能带 `ELECTRON_RUN_AS_NODE=1`**：这会让 `electron` 退化成 Node，报 `app.setPath` 不存在。跑 G7 用 `env -u ELECTRON_RUN_AS_NODE`。

**safeStorage 的“不可用”是正常分支**：代码里拒绝保存、不退回明文；G7 写成双分支断言。本机 Windows 跑到“可用”支，CI 的 Linux runner 跑到“拒绝”支（不建文件、无明文），只剩 Linux 桌面的可用支未证。

**本机控制台是 GBK，Windows CI 的 stdout 是 cp1252**：本机 `selfcheck_channel.py` 的中文显示成乱码但退出码正常；到了 windows-latest，控制台编码更窄，第一条中文断言打印就 `UnicodeEncodeError` 退出 1（run `40657478165`）。所有新加的 Python 入口都要像 `selfcheck.py` 那样把 stdout/stderr reconfigure 成 UTF-8。**乱码不等于失败，崩溃才是。**

**git 通道会瞬时断**：本轮推送时 `github.com:443` 连续 4 次 reset/超时，而 `api.github.com` 全程正常；几分钟后同一条命令成功。先重试并探本机代理端口，不要改 remote，也不要怀疑权限。

**`app.exit(1)` 仍会被生产入口的 `app.quit()` 顶掉**：结论继续落 JSON、由 G6b 独立判，别改回退出码管道。

**上一轮的坑仍然有效**：`chrome-sandbox` 要 root:4755（别用 `--no-sandbox` 绕）；Electron 二进制懒下载；xvfb 屏幕要大于窗口含边框尺寸；runner 缺中文字体会整片豆腐；`document.fonts.check` 对没装的字体也返回 true；`mms templates | head` 在 Windows 上会假失败。

## 7 结构速查

```
skills/                     7 个 vendor 进来的技能（原样）+ manifest.json + VENDOR.md
schemas/                    skill-manifest.schema.json、chat-events.schema.json
runtime/src/mms/
  server.py                 本机通道：握手、鉴权、SSE、会话、workflow 与工作台端点
  store.py                  SQLite：阶段、待决卡、消息、轮次
  orchestrator.py           K2/K3/K4 的确定性状态机
  workbench_figure.py       图表渲染、主题、版本与回滚
  workbench_score.py        评分卡、扣分定位、章节样例与一票否决
  demo_scores.json          三轮演示评分卡
  themes/                   studio-ink / studio-amber 主题
  provider.py               OpenAI 兼容流式客户端 + 离线假 provider
  providers.json            DeepSeek / Kimi / 自定义端点预设
  registry.py / invoke.py   技能注册表与 subprocess 调用
  cli.py                    serve / templates / invoke
runtime/cli.py              开发期入口（npm run mms）
runtime/selfcheck_channel.py G4/G5 自检与 10 条反向覆盖（含跨进程恢复）
runtime/selfcheck_workbench.py G9 工作台自检（真渲两版）
src/main/
  index.ts                  窗口、IPC、provider 合并视图、SSE 转发、resume
  channel.ts                Python 子进程生命周期、HTTP/SSE 客户端
  settings.ts               safeStorage 密文读写
src/preload/index.ts        window.studio 窄接口
src/shared/api.ts           主进程与渲染层共享的纯类型
src/renderer/src/
  App.tsx                   运行时状态、provider、对话事件归并、快照恢复
  components/ChatPane.tsx   流式消息、工具卡、输入区、阶段胶囊
  components/DecisionCard.tsx  K2 确认卡与 K3 选模卡
  components/ExplainDrawer.tsx K4 右栏抽屉
  components/WorkspacePane.tsx 图表/评分/门禁/代码/日志工作台
  components/SettingsDialog.tsx  服务商/模型/Key 设置
  lib/chat.ts               事件折叠的纯函数
  lib/phases.ts             阶段名与状态文案
  styles/workbench.css      M4 工作台样式
scripts/                    G1/G1 反向/G8/G8 反向/G6/G6b 与契约校验
tests/window-smoke.cjs      真启动断言（53 条）+ 截图与 JSON 结论
.github/workflows/ci.yml    gates（ubuntu+windows，含 G9）与 window-smoke（ubuntu，装图表依赖）
```

会话库位置：Electron `userData/sessions.db`；命令行直接起 runtime 时是 `<MMS_HOME>/.mms/sessions.db`，可用 `MMS_DATA_DIR` 覆盖。库内只有阶段、待决卡与消息，没有 Key。
图表版本位置：`userData/workbench/figure/versions/<v>`，`state.json` 记当前版与上一版；同样随 `MMS_DATA_DIR` 走。

一处刻意的设计：`runtime` 只用 subprocess 调技能脚本、按退出码判定，不 import 技能内部函数——这样 `skills/` 仍可被 Claude Code 等宿主单独装载。改这条要先想清楚代价。
