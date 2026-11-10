# 交接 · 当前状态（0.1.0）

给接手的人（或下一轮会话的我）。日期 2026-11-06。
提交数与文件数不要信这里抄的数字，跑 `git rev-list --count HEAD` 和 `git ls-files | wc -l` 自己取；HEAD 以 `git log -1` 为准。

## 0 一句话现状

0.1.0 是对话优先的工作台：默认自由对话，输入区的「全流程建模」按钮才进入题面确认 → 选模 → 基线 → 论文的七阶段引导；对话里问「该用什么模型」会由 `suggest_models` 工具推出三张候选卡，点卡即继续对话。设置页可在 Python 与 DeepSeek Harness 两个内核间切换，DSH 经本机 `dsh web` 的 HTTP + WebSocket 接入，事件仍映射为原有九类。论文页执行 xelatex → pandoc → 三道交付门禁；图表、评分、附件与多会话能力保留。

三句必须保留的限制：

- **没有用真实 DeepSeek / 通义千问 / Kimi / 智谱 GLM Key 跑过联网对话。** 已验证的是 OpenAI 兼容协议（本地假端点）与整条本机链路；各服务的当下行为不在证据里。
- **论文样例不是对真实赛题的解答。** 内容是演示稿，评分卡也是演示数据；PDF/Word 一致性核对没有自动化。
- **0.1.0 的安装包尚未构建，也没有在 CI 上复跑。** 现有安装包读数与 CI 读数均来自版本重置之前，只作参考。

## 1 怎么验（命令 → 期望）

需要先装两侧依赖：`npm install`（可加 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，CI 不启动窗口时用）与
`python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple/`。

论文自检还需要 **xelatex 与 pandoc**（见 `docs/env-setup.md`）：xelatex 走 PATH 或 `MMS_XELATEX`；pandoc 走 PATH、`MMS_PANDOC`，最后回落到 `%LOCALAPPDATA%\mms-tools\pandoc.exe`。缺件时 G10 退出 1 并打印缺什么；只有显式 `MMS_PAPER_SKIP=1` 才跳过，且会打印「未验证 G10」。

不需要网络、不需要显示器的部分：

```bash
node scripts/check-registry.mjs                 # 8/8 项通过，技能 7 个            → exit 0
node scripts/check-registry.negative.mjs        # 9/9 条破坏被门禁抓到（含基线自证）→ exit 0
node scripts/check-skills.mjs                   # 6/6 项通过，技能 7 个            → exit 0
node scripts/check-skills.mjs --self            # 7/7 条自检通过（含基线自证）     → exit 0
node scripts/check-window-smoke.mjs --selftest  # 12/12 条核验自测                  → exit 0
python scripts/validate-contracts.py            # 9/9 项通过（jsonschema）         → exit 0
python runtime/tests/selfcheck.py                     # 13/13 条 CLI 断言，含真渲一张图  → exit 0
python runtime/tests/selfcheck_channel.py             # 55/55 条通道断言（含 C15 选模卡）→ exit 0
python runtime/tests/selfcheck_channel.py --selftest  # 10/10 条坏事件被拒                → exit 0
python runtime/tests/selfcheck_channel.py --core dsh  # 31/31 条 DSH 断言                 → exit 0
python runtime/tests/selfcheck_workbench.py           # 19/19 条工作台断言（真渲两版）  → exit 0
python runtime/tests/selfcheck_paper.py               # 12/12 条论文断言（真编 PDF/DOCX）→ exit 0
```

`--core dsh` 会自动转发到 `vendor/python`（SDK 与 `dsh.exe` 都装在那里）；系统解释器缺 SDK 时不再误报 `dshVersion`。`selfcheck.py`、`selfcheck_workbench.py` 与 `selfcheck_paper.py` 会真调 matplotlib / xelatex / pandoc（各十几秒）。

需要显示器的部分：

```bash
npm run smoke:window   # 真起窗口，114/114，写 screenshots/window-smoke.{png,json} 与各页截图
npm run verify:window  # 独立读 JSON 并复算读数
```

`smoke:window` 自己设置 `MMS_FAKE_PROVIDER=1`，并把 Electron `userData` 与 `MMS_WORKSPACE` 指到临时目录，所以不会用你已保存的真实 provider，也不会在真实桌面建「赛题」。G7-9 会真编一遍演示稿，跑 G7 的机器必须有 xelatex 与 pandoc。G7-11 会切换内核并重启运行时。

一把梭：`npm run gate`（顺序见 `package.json` 的 scripts；G7 不在 gate 里，因为它要显示器和 Electron 二进制）。

**本机跑 G7 前去掉 `ELECTRON_RUN_AS_NODE`**：本会话 shell 里它是 `1`，会让 `electron` 退化成 Node 并报 `app.setPath` 不存在。用 `env -u ELECTRON_RUN_AS_NODE npx electron tests/window-smoke.cjs`。

CI：<https://github.com/Escap1ng/mathmodel-studio/actions>。0.1.0 尚未在 CI 上复跑；此前 run 的读数只作历史参考。

## 2 已证 / 未证（别混）

| 结论 | 证据来源 | 强度 |
| --- | --- | --- |
| 注册表、技能规范、契约与 CLI 自洽 | `npm run gate`（本机 Windows，2026-11-06） | 强（本机） |
| 本机通道：握手、Bearer、Host/Origin、SSE 契约、续传、取消、思考深度与上下文截断 | `selfcheck_channel.py` 55/55 | 强（本机） |
| 上下文选模卡：工具调用后推送 `interrupt`，候选与编排器同源 | 同上 C15 三条 | 强（本机） |
| 编排闭环：K2→K3→换一批→选择→阶段四；跨进程恢复 | 同上 C12/C13 | 强（本机） |
| DSH 内核：流式、工具、取消、续聊复用、缺少 dsh 时明确报错 | `selfcheck_channel.py --core dsh` 31/31 | 强（本机） |
| 打包后 DSH 缺失的报错与密钥边界 | 真实 packaged resources 负向 17/17（2026-11-04，改名后已恢复） | 强（本机） |
| 内核路由：有 DSH 走 DSH、离线演示走 Python，界面不暴露切换 | G7-11 一条 | 强（本机） |
| 界面端到端 114 条：K2→K3→解释→选择（含五维雷达）、阶段四真跑、图表、评分、论文、附件、多会话、通用/数模分段切换与按模式收合偏好、过程总览默认页 | G7 114/114 | 强（本机） |
| 图表工作台、评分卡、论文排版与三道门禁 | G9 19/19、G10 12/12、G7 对应段落 | 强（演示数据/演示稿） |
| 门禁能抓住坏稿；缺工具 / 坏 TeX / 缺稿件 | G10 反向 P6–P9 | 强（反向） |
| 0.1.0 的 NSIS 安装包 | 未构建 | **未证** |
| 0.1.0 在 CI 上的门禁与真启动 | 未复跑 | **未证** |
| DSH 内核下的选模卡 | `suggest_models` 只在 python 内核接；DSH 走 MCP 尚无对应工具 | **未证** |
| DSH 内核下旧 python 内核会话 resume | 未验证 | **未证** |
| 跨 sidecar 重启续聊（DSH 不重载 session） | 未做 | **未证** |
| 真实厂商联网对话 | 无 Key，未跑 | **未证** |
| Windows CI 真起窗、干净机安装 | 无 | **未证** |
| Linux 桌面 `safeStorage` 可用分支 | 只证了「不可用就拒绝保存」 | **未证** |

## 3 待维护者定的项

1. **TeX 与 pandoc 在安装包里怎么存在**：要求用户本机装 / 内置 Tectonic / 两者都支持并让环境检测决定。当前只做了检测与明确拒绝。
2. **provider 列表的维护方式**：三家写死在 `runtime/src/mms/providers.json`，界面允许手填模型名与自定义端点。是否改成用户可增删的服务商列表，取决于「选模型」要多重。
3. **Key 的 Linux 兜底**：当前规则是安全存储不可用就拒绝保存，不退回明文。保持拒绝还是允许「本次会话内存保存」，需要拍板。
4. **阶段机怎么接论文**：现在「构建论文」是工作台按钮，左侧阶段五仍显示「未开始」。构建成功是否推进阶段五，语义不同，界面也应不同。
5. **DSH 内核要不要补齐工具面**：选模卡、技能与工作台端点目前只在 python 内核可用；补齐要扩 `runtime/mcp/mms_server.py` 并在适配层映射卡片事件。

## 4 界面待判的观感问题（我只报，没改）

`screenshots/` 下的截图均为 1440×900、本机 Windows 渲染。

- 左栏 240px 装不下最长的阶段名时靠收紧占位解决；阶段圆点描边较淡。
- 中栏空态文字偏上，下方到输入框之间空隙大。
- 状态栏右侧色块与文字间距偏小。
- 工具卡灰底与白底差别小；模型条最长 300px，长名字会被截断。
- 设置页服务商是等宽胶囊，没有分组；新增的「对话内核」段落与模型字段的视觉层级是否合适，需要看过再定。
- 评分页信息密度较高；论文页 A4 缩到约 370px 宽，正文可辨但字号很小。
- 对话优先后，阶段轨道常驻左侧但默认没有活跃会话，是否要弱化或折叠，属于产品选择。

## 5 已做与仍欠

已做：

1. 对话优先工作台：默认通用模式，「通用 | 数模」分段切换。
2. `suggest_models` 工具与选模卡事件；chat 模式点卡转消息。
3. DSH 适配层：进程管理、WS follow、事件映射、取消、续聊复用、闲置回收。
4. `settings.json` 持久化与 `providerViews` 的 `unavailable` 约束仍在；设置页不提供内核开关（自动路由）。
5. 打包布线：SDK 版本记录、`MMS_DSH_*` 环境、resources 路径探测。
6. 门禁：G4 55、G7 114、DSH 31、G9 19、G10 12、G11 13、G12 14、G13 10。
7. 发布规范 `docs/release.md`；版本重置为 0.1.0，旧 Release/tag 已删。

仍欠：

- 0.1.0 安装包重建与干净机安装验证。
- CI 已于 2026-11-10 在 0.1.0 复跑（ubuntu 真起窗）；Windows 真起窗仍未进 CI。
- DSH 侧选模卡、技能与工作台端点。
- DSH 内核下旧会话 resume 兼容、跨 sidecar 重启续聊。
- 真实厂商连通性、Linux 桌面 safeStorage 可用分支。
- 正文生成：论文页仍是演示稿。

## 6 踩过的坑（别再踩）

**POST 处理器必须读请求体，否则 keep-alive 会中毒**：`/workbench/paper/build` 第一版没调 `self._body()`，客户端发来的 `{}` 留在连接里，下一条 `GET /workbench/state` 被解析成 `{}GET ...`，服务端回 501。凡是 `do_POST` 分支，先读体再处理。

**pdf.js 不要传 `data:` URL**：`getDocument({url: dataUrl})` 会去 fetch，CSP 的 `connect-src` 不放行 `data:`。改成把 base64 解成 `Uint8Array` 传给 `getDocument({data})`；worker 由 Vite 打包，CSP 需要 `worker-src 'self' blob:`。

**pandoc 不在 PATH 时要有回落，但覆盖变量指向不存在的路径必须判缺**：`MMS_PANDOC` 设了但文件不存在时直接判缺（不回落到 PATH），否则「缺件反例」会被 PATH 里的 pandoc 悄悄救活。

**xelatex 能编模板不等于模板能过门禁**：`check_style.py` 的段落节奏要求相邻合格段落字数差 ≥20%；LaTeX 表格行也会被当成段落统计。`check_phrasing.py` 会扫注释，样例稿注释也要避开词表。

**G7 新增断言要同步三处**：`tests/window-smoke.cjs` 的断言、`scripts/check-window-smoke.mjs` 的 `MIN_ASSERTIONS` 与 `REQUIRED_ASSERTIONS`、以及文档里的条数。分组编号先 grep 现有 `G7-*`，G7-9 已被论文页占用。

**默认模式改了要查恢复路径**：默认从 workflow 改成 chat 后，`session.latest()` 恢复待决会话时如果只设 `activeKind` 不设 `mode`，点确认会走成聊天消息（冒烟 8 项红）。恢复时必须 `setMode('workflow')`。

**DSH 路径在 dev 与 packaged 不同**：dev 在 `vendor/python/Scripts/dsh.exe`，packaged 在 `resources/python/Scripts/dsh.exe`。`MMS_DSH_BIN` 设置过但文件不存在时 `find_dsh` 直接报错，所以 Electron 只在探测到文件时才注入。

**DSH 自检要用随包解释器**：系统 python 没装 SDK，`dshVersion` 会是 None。自检在 `--core dsh` 时用 subprocess 转发到 `vendor/python`；Windows 上 `os.execve` 会拼坏含空格路径，不要用。

**工具卡片的通道**：选模卡走 `interrupt` 事件（`card=model-choice`），不是 `gate`；`gate` 是技能门禁的 `{skill, ok, exit}`。chat 模式的点卡由渲染层转成用户消息，不复用 orchestrator 的 resume。

**窗口 resize 时的夹取要防抖**：从 1440 拉到 2400 的过程中会触发多次中间尺寸，立刻夹取会把保存宽度永久压到最小值。现在等 180ms 稳定后再夹。

**分隔条高亮用 CSS 变量定位**：`--grip-y` 由 pointermove 写入，`::after` 用 `radial-gradient(... at 50% var(--grip-y))`；不要固定 50%，也不要在 pointerleave 清空它。

**CI 的排版依赖是硬依赖**：gates 的 ubuntu job 与 window-smoke job 都要装 pandoc 与 TeX；Windows gates 没有 TeX，G10 用 `MMS_PAPER_SKIP=1` 显式跳过，跳过必须打印「未验证」。

**上一轮的坑仍然有效**：SSE 流要显式 `Connection: close`；事件可能比 `chat.start` 返回值先到；G7 的假 provider 必须在 `require` 生产入口之前设；`app.exit(1)` 会被 `window-all-closed` 顶掉，结论必须落 JSON 由 G6b 独立判；Windows 控制台 cp1252 会因中文崩溃，入口要 reconfigure UTF-8；本机 shell 可能带 `ELECTRON_RUN_AS_NODE=1`；safeStorage 的「不可用」是正常分支；`git` 通道会瞬时断，先探本机代理端口并重试，不要改 remote。

**近期新增的坑**：

- `capturePage()` 在窗口被遮挡时会抛 `UnknownVizError`，G7 的截图全部走 `capture(win)` 重试封装。
- 会话列表有两套来源：`GET /sessions` 只返回建模会话摘要，问答会话在渲染层 `localStorage`（索引 `mms.chatConversations.index.v2` + 每篇分片 `mms.chatConv.<id>`；旧单键 `mms.chatConversations.v1` 启动时自动迁移，迁移不完整时旧键保留）。清空历史必须两边一起删。
- 上下文估算在 TS（`lib/context.ts`）与 Python（`server.py` 的 `estimate_tokens`）各有一份；改公式必须两边同步。
- 左栏宽度 240px、`.tab` 7 个是 G6b 点名项；右栏分组用 `.tabs__group`/`.tabs__label`。
- 面板标题与门禁条已并入栏头/`.panel__bar`；门禁页 `[data-gate-row]` 仍必须 4 条。

## 7 结构速查

```
skills/                     7 个 vendor 进来的技能（原样）+ manifest.json + VENDOR.md
schemas/                    skill-manifest.schema.json、chat-events.schema.json
runtime/src/mms/
  server.py                 本机通道：握手、鉴权、SSE、会话、workflow、工具与工作台端点
  dsh_adapter.py             DSH 子进程、HTTP/WS、事件映射、取消与续聊复用
  dsh_provider.py            供应商与思考档位到 DSH patch 的映射
  store.py                  SQLite：阶段、待决卡、消息、轮次
  orchestrator.py           K2/K3 状态机与基线；chat 选模卡共用候选
  workbench_figure.py       图表渲染、主题、版本与回滚
  workbench_score.py        评分卡、扣分定位、章节样例与一票否决
  paper_build.py            论文流水线：xelatex、pandoc、Word 后处理、三道门禁
  provider.py               OpenAI 兼容流式客户端 + 离线假 provider
  providers.json            DeepSeek / 通义千问 / Kimi / 智谱 GLM / OpenAI 格式预设与思考参数映射
  cli.py                    serve / templates / invoke
runtime/mcp/mms_server.py   DSH 侧 stdio MCP（当前只有 list_templates）
runtime/cli.py              开发期入口（npm run mms）
runtime/cli.py              开发期入口（npm run mms）
runtime/tests/              自检：CLI、通道、编排、harness、工作台、论文（G3–G13，含反向覆盖）
src/main/
  index.ts                  窗口、IPC、provider 合并视图、SSE 转发、resume、PDF data URL
  channel.ts                Python 子进程生命周期、HTTP/SSE 客户端、内核选择
  settings.ts               safeStorage 密文、工作区、对话内核与 provider 设置
src/preload/index.ts        window.studio 窄接口
src/shared/api.ts           主进程与渲染层共享的纯类型
src/shared/file-kinds.ts    扩展名 → 文件类别（主进程与渲染层共用）
src/renderer/src/
  App.tsx                   运行时状态、provider、对话事件归并、快照恢复、卡片决策分流
  components/chat/          对话流、欢迎屏、决策卡、解释抽屉、Markdown 与消息操作
  components/rail/          PhaseRail：会话列表与七阶段轨道
  components/workspace/     WorkspacePane 与图表/论文/评分/门禁/代码/日志/文件面板
  components/settings/      SettingsDialog：服务商/模型/Key 与对话内核设置
  components/common/        ContextMenu、SelectMenu、FileChips
  lib/chat.ts               事件折叠的纯函数
scripts/                    G1/G1 反向/G8/G8 反向/G6/G6b 与契约校验
tests/window-smoke.cjs      真启动断言（114 条）+ 截图与 JSON 结论
docs/release.md             发布格式规范
.github/workflows/ci.yml    gates（ubuntu+windows，含 G9/G10）与 window-smoke（ubuntu）
```

会话库位置：Electron `userData/sessions.db`；命令行直接起 runtime 时是 `<MMS_HOME>/.mms/sessions.db`，可用 `MMS_DATA_DIR` 覆盖。库内只有阶段、待决卡与消息，没有 Key。
DSH 状态：`MMS_DSH_HOME`（默认 `userData/dsh`），profile 名 `mms`。
图表版本位置：`userData/sessions/<sid>/workbench/figure/versions/<v>`，`state.json` 记当前版与上一版；无合法 sid 时回落 `userData/workbench/`。
论文工作区：`userData/sessions/<sid>/workbench/paper/`，含 `paper.tex`、`paper.pdf`、`paper.docx`、`figures/final/`、`logs/` 与 `build.json`；受同样回落规则约束。

一处刻意的设计：`runtime` 只用 subprocess 调技能脚本、按退出码与产物双重判定，不 import 技能内部函数——这样 `skills/` 仍可被 Claude Code 等宿主单独装载。改这条要先想清楚代价。
