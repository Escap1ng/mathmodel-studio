# 交接 · 当前状态（0.2.0）

给接手的人（或下一轮会话的我）。日期 2026-11-15。
提交数与文件数不要信这里抄的数字，跑 `git rev-list --count HEAD` 和 `git ls-files | wc -l` 自己取；HEAD 以 `git log -1` 为准。

## 0 一句话现状

0.2.0 把数模模块真正跑通：七阶段全链由 LLM 驱动（配 Key 时）——K2 题面拆解、K3 选模、阶段四按题生成求解代码并经「代码确认卡」点运行才执行、阶段五按真实结果写论文并过三道门禁、阶段六按 rubric 真实评分（<85 回喂修复 ≤3 轮熔断）。没有 Key 或模型不可用时回退确定性路径/演示样例，并在对话里明确标注兜底。DSH 双内核已移除，只剩自研 Python 单内核；工作台日志页并入代码页（标签 8→7）。

三句必须保留的限制：

- **没有用真实 DeepSeek / 通义千问 / Kimi / 智谱 GLM Key 跑过联网端到端。** 已验证的是 OpenAI 兼容协议（本地假端点）与整条本机离线链路；各服务的当下行为不在证据里。真实链路需用户在设置页配 Key 后自跑一道真题。
- **离线演示的论文与评分是兜底样例，不是对真实赛题的解答。** 配 Key 后才按本题生成；PDF/Word 一致性核对没有自动化。
- **0.2.0 的安装包尚未构建；G7 真启动本轮被本机环境阻塞**（今晨重启后 Electron 渲染进程挂起，Edge 对照正常，疑似终端安全软件拦截），待环境恢复后复跑。

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
python runtime/tests/selfcheck_channel.py             # 64/64 条通道断言（含 C16–C18 全链）→ exit 0
python runtime/tests/selfcheck_channel.py --selftest  # 12/12 条坏事件被拒                → exit 0
python runtime/tests/selfcheck_orchestrator.py        # 34/34 条编排断言（含 L1–L14 LLM 注入）→ exit 0
python runtime/tests/selfcheck_workbench.py           # 19/19 条工作台断言（真渲两版）  → exit 0
python runtime/tests/selfcheck_paper.py               # 12/12 条论文断言（真编 PDF/DOCX）→ exit 0
```

`selfcheck.py`、`selfcheck_orchestrator.py`、`selfcheck_workbench.py` 与 `selfcheck_paper.py` 会真调 matplotlib / xelatex / pandoc（编排全链含论文编译，约一两分钟）。

需要显示器的部分：

```bash
npm run smoke:window   # 真起窗口，116 条断言，写 screenshots/window-smoke.{png,json} 与各页截图
npm run verify:window  # 独立读 JSON 并复算读数
```

`smoke:window` 自己设置 `MMS_FAKE_PROVIDER=1`，并把 Electron `userData` 与 `MMS_WORKSPACE` 指到临时目录，所以不会用你已保存的真实 provider，也不会在真实桌面建「赛题」。G7-9 会真编一遍论文，跑 G7 的机器必须有 xelatex 与 pandoc。

一把梭：`npm run gate`（顺序见 `package.json` 的 scripts；G7 不在 gate 里，因为它要显示器和 Electron 二进制）。

**本机跑 G7 前去掉 `ELECTRON_RUN_AS_NODE`**：本会话 shell 里它是 `1`，会让 `electron` 退化成 Node 并报 `app.setPath` 不存在。

**G7 环境阻塞（2026-11-15）**：本机今晨重启后 Electron 渲染进程一律挂起（连内联 data URL 都不加载），Edge 无头对照正常；已排除路径空格、沙箱、GPU、用户数据目录、残留进程，沙箱外运行同样复现。疑似终端安全软件（edrservice）拦截，需排查后复跑 G7。

CI：<https://github.com/Escap1ng/mathmodel-studio/actions>。0.2.0 尚未在 CI 上复跑。

## 2 已证 / 未证（别混）

| 结论 | 证据来源 | 强度 |
| --- | --- | --- |
| 注册表、技能规范、契约与 CLI 自洽 | `npm run gate`（本机 Windows，2026-11-15） | 强（本机） |
| 本机通道：握手、Bearer、Host/Origin、SSE 契约、续传、取消、思考深度与上下文截断 | `selfcheck_channel.py` 64/64 | 强（本机） |
| LLM 注入：K2/K3 模型生成、坏 JSON 回喂重试与回退、选模落盘 | `selfcheck_orchestrator.py` L1–L8 | 强（本机，fake） |
| 代码确认卡：未确认不执行、动作守卫、失败回喂 ≤2 轮 | 同上 L9–L10、C17 | 强（本机） |
| 全链离线：题面→选模→代码→运行→论文 PDF/DOCX+三门禁→评分达标 | 同上 K3/L11–L12、C12/C18 | 强（本机，fake 兜底） |
| 真实评分：评分卡校验、按会话落盘、一票否决淘汰 | 同上 L13–L14、C18 | 强（本机） |
| 上下文选模卡：工具调用后推送 `interrupt`，候选与编排器同源 | C15 | 强（本机） |
| 编排闭环跨进程恢复 | C13 | 强（本机） |
| 图表工作台、评分卡、论文排版与三道门禁 | G9 19/19、G10 12/12 | 强（演示数据/演示稿） |
| 门禁能抓住坏稿；缺工具 / 坏 TeX / 缺稿件 | G10 反向 P6–P9 | 强（反向） |
| 真实厂商 Key 联网端到端 | 无 Key，未跑 | **未证** |
| G7 真启动（0.2.0） | 本机环境阻塞，未跑 | **未证** |
| 0.2.0 的 NSIS 安装包 | 未构建 | **未证** |
| 0.2.0 在 CI 上的门禁与真启动 | 未复跑 | **未证** |
| Windows CI 真起窗、干净机安装 | 无 | **未证** |
| Linux 桌面 `safeStorage` 可用分支 | 只证了「不可用就拒绝保存」 | **未证** |

## 3 待维护者定的项

1. **TeX 与 pandoc 在安装包里怎么存在**：要求用户本机装 / 内置 Tectonic / 两者都支持并让环境检测决定。当前只做了检测与明确拒绝。
2. **provider 列表的维护方式**：预设写死在 `runtime/src/mms/providers.json`，界面允许手填模型名与自定义端点。是否改成用户可增删的服务商列表，取决于「选模型」要多重。
3. **Key 的 Linux 兜底**：当前规则是安全存储不可用就拒绝保存，不退回明文。保持拒绝还是允许「本次会话内存保存」，需要拍板。
4. **双模式与双存储合并**：通用/数模双模式、问答会话 localStorage 与建模会话 SQLite 两套存储仍在（本轮稳妥简化未动）。合并为单一对话流 + 统一存储是下一版本的简化方向，需重写 G7 大面积断言。
5. **论文分章生成**：当前一次生成整篇，实测输出被截断时再改分章。

## 4 界面待判的观感问题（我只报，没改）

`screenshots/` 下的截图均为 1440×900、本机 Windows 渲染（0.1.0 旧图，0.2.0 待 G7 恢复后重拍）。

- 左栏 240px 装不下最长的阶段名时靠收紧占位解决；阶段圆点描边较淡。
- 中栏空态文字偏上，下方到输入框之间空隙大。
- 状态栏右侧色块与文字间距偏小。
- 工具卡灰底与白底差别小；模型条最长 300px，长名字会被截断。
- 设置页服务商是等宽胶囊，没有分组。
- 评分页信息密度较高；论文页 A4 缩到约 370px 宽，正文可辨但字号很小。
- 代码确认卡的代码预览块最高 320px 可滚动，长脚本需滚动查看。

## 5 已做与仍欠

已做（0.2.0）：

1. LLM 进编排：K2/K3 模型生成 + 回退；恢复决策带服务商上下文，Key 按次补齐不落盘。
2. 代码确认卡（K4）：模型生成求解代码，点运行才执行，失败回喂 ≤2 轮；所选模型落盘。
3. 真实论文生成：骨架 + 规范 + 真实结果 → tex → 排版 + 三门禁，修复 ≤3 轮；阶段五推进（含手动构建）。
4. 真实评分：rubric 评审 + score_card 校验 + 按会话落盘；<85 回喂修复 ≤3 轮熔断；一票否决淘汰。
5. 移除 DSH 双内核（适配层/MCP/SDK/环境注入/自检全清）；单 Python 内核。
6. 工作台精简：日志并入代码页，标签 8→7。
7. 门禁：G4 64、G11 34、G9 19、G10 12、G12 14、G13 10；版本 0.2.0 四处同源。

仍欠：

- 真实厂商 Key 联网端到端（需用户配 Key 自跑）。
- G7 真启动复跑（本机环境阻塞）与截图重拍。
- 0.2.0 安装包重建与干净机安装验证；CI 复跑。
- 双模式合并、存储统一（下一版本）。
- Linux 桌面 safeStorage 可用分支。

## 6 踩过的坑（别再踩）

**POST 处理器必须读请求体，否则 keep-alive 会中毒**：凡是 `do_POST` 分支，先读体再处理。

**pdf.js 不要传 `data:` URL**：把 base64 解成 `Uint8Array` 传给 `getDocument({data})`；worker 由 Vite 打包，CSP 需要 `worker-src 'self' blob:`。

**pandoc 不在 PATH 时要有回落，但覆盖变量指向不存在的路径必须判缺**：`MMS_PANDOC` 设了但文件不存在时直接判缺。

**xelatex 能编模板不等于模板能过门禁**：`check_style.py` 的段落节奏要求相邻合格段落字数差 ≥20%；LaTeX 表格行也会被当成段落统计。`check_phrasing.py` 会扫注释。

**G7 新增断言要同步三处**：`tests/window-smoke.cjs` 的断言、`scripts/check-window-smoke.mjs` 的 `MIN_ASSERTIONS` 与 `REQUIRED_ASSERTIONS`、以及文档里的条数。

**默认模式改了要查恢复路径**：恢复待决会话时必须 `setMode('workflow')`，否则点确认走成聊天消息。

**interrupt 节点幂等硬约束**：写文件/执行脚本/花 token 一律在 interrupt 之后。代码确认卡先落 pending 再 yield interrupt，`run` 动作才执行；阶段五/六的生成与编译都在 resume 链里，不在挂卡前。

**LLM 输出先校验再改状态**：`llm.complete_json`/`complete_text` 剥围栏、坏输出回喂重试一次，仍坏抛 LlmError 由编排层回退；schema 校验先于状态变更。fake provider 按 system 消息的 `[mms-stage:...]` 标记路由，聊天两段脚本不受影响。

**兜底必须标注**：fake/无模型时论文用样例稿、评分用演示卡，来源标 fallback 并在对话里写明「非按本题生成/评审」，不冒充真实结果。

**工具卡片的通道**：选模卡/代码卡走 `interrupt` 事件，不是 `gate`；`gate` 是技能门禁的 `{skill, ok, exit}`。`artifact` 事件支持 `path`（单文件）与 `outputs`（多产物）两种形状。

**窗口 resize 时的夹取要防抖**：等 180ms 稳定后再夹。

**分隔条高亮用 CSS 变量定位**：`--grip-y` 由 pointermove 写入，不要固定 50%。

**CI 的排版依赖是硬依赖**：gates 的 ubuntu job 与 window-smoke job 都要装 pandoc 与 TeX；Windows gates 没有 TeX，G10 用 `MMS_PAPER_SKIP=1` 显式跳过。

**上一轮的坑仍然有效**：SSE 流要显式 `Connection: close`；事件可能比 `chat.start` 返回值先到；G7 的假 provider 必须在 `require` 生产入口之前设；`app.exit(1)` 会被 `window-all-closed` 顶掉，结论必须落 JSON 由 G6b 独立判；Windows 控制台 cp1252 会因中文崩溃，入口要 reconfigure UTF-8；本机 shell 可能带 `ELECTRON_RUN_AS_NODE=1`；safeStorage 的「不可用」是正常分支。

**近期新增的坑**：

- `capturePage()` 在窗口被遮挡时会抛 `UnknownVizError`，G7 的截图全部走 `capture(win)` 重试封装。
- 会话列表有两套来源：`GET /sessions` 只返回建模会话摘要，问答会话在渲染层 `localStorage`。清空历史必须两边一起删。
- 上下文估算在 TS（`lib/context.ts`）与 Python（`harness.estimate_tokens`）各有一份；改公式必须两边同步。
- 左栏宽度 240px、`.tab` 7 个（0.2.0 日志并入代码后）是 G6b 点名项；右栏分组用 `.tabs__group`/`.tabs__label`。
- 面板标题与门禁条已并入栏头/`.panel__bar`；门禁页 `[data-gate-row]` 仍必须 4 条。
- 评分按会话隔离：`workbench_score.state(root, data_dir)` 优先读 `<会话>/workbench/score/round-N.json`，无则回落演示三轮；章节门禁优先查本会话 `paper.tex`。

## 7 结构速查

```
skills/                     7 个 vendor 进来的技能（原样）+ manifest.json + VENDOR.md
schemas/                    skill-manifest.schema.json、chat-events.schema.json
runtime/src/mms/
  server.py                 本机通道：握手、鉴权、SSE、会话、workflow、工具与工作台端点（单 Python 内核）
  store.py                  SQLite：阶段、待决卡、消息、轮次、picked（所选模型）
  orchestrator.py           K2/K3 状态机 + 代码确认卡 + 阶段四五六全链；chat 选模卡共用候选
  llm.py                    编排器 LLM 注入层：阶段标记、JSON/文本补全、回喂重试
  paper_gen.py              阶段五论文生成：骨架 + 规范 + 真实结果 → tex
  score_gen.py              阶段六评分生成：rubric 评审 → 评分卡
  workbench_figure.py       图表渲染、主题、版本与回滚
  workbench_score.py        评分卡、扣分定位、按会话真实轮次、章节门禁与一票否决
  paper_build.py            论文流水线：xelatex、pandoc、Word 后处理、三道门禁
  baseline.py               数据画像、脚本校验、求解脚本执行框架
  provider.py               OpenAI 兼容流式客户端 + 离线假 provider（按阶段路由）
  providers.json            DeepSeek / 通义千问 / Kimi / 智谱 GLM / OpenAI 格式预设与思考参数映射
  cli.py                    serve / templates / invoke
runtime/cli.py              开发期入口（npm run mms）
runtime/tests/              自检：CLI、通道、编排、harness、工作台、论文（G3–G13，含反向覆盖）
src/main/
  index.ts                  窗口、IPC、provider 合并视图、SSE 转发、resume（带 Key）、PDF data URL
  channel.ts                Python 子进程生命周期、HTTP/SSE 客户端
  settings.ts               safeStorage 密文、工作区与 provider 设置
src/preload/index.ts        window.studio 窄接口
src/shared/api.ts           主进程与渲染层共享的纯类型
src/shared/file-kinds.ts    扩展名 → 文件类别（主进程与渲染层共用）
src/renderer/src/
  App.tsx                   运行时状态、provider、对话事件归并、快照恢复、卡片决策分流
  components/chat/          对话流、欢迎屏、决策卡（含代码确认卡）、解释抽屉、Markdown 与消息操作
  components/rail/          PhaseRail：会话列表与七阶段轨道
  components/workspace/     WorkspacePane 与图表/论文/评分/门禁/代码（含日志）/文件/过程总览面板
  components/settings/      SettingsDialog：服务商/模型/Key 设置
  components/common/        ContextMenu、SelectMenu、FileChips
  lib/chat.ts               事件折叠的纯函数
scripts/                    G1/G1 反向/G8/G8 反向/G6/G6b 与契约校验
tests/window-smoke.cjs      真启动断言（116 条）+ 截图与 JSON 结论
docs/release.md             发布格式规范
.github/workflows/ci.yml    gates（ubuntu+windows，含 G9/G10）与 window-smoke（ubuntu）
```

会话库位置：Electron `userData/sessions.db`；命令行直接起 runtime 时是 `<MMS_HOME>/.mms/sessions.db`，可用 `MMS_DATA_DIR` 覆盖。库内只有阶段、待决卡、消息与所选模型，没有 Key。
图表版本位置：`userData/sessions/<sid>/workbench/figure/versions/<v>`，`state.json` 记当前版与上一版；无合法 sid 时回落 `userData/workbench/`。
论文工作区：`userData/sessions/<sid>/workbench/paper/`，含 `paper.tex`、`paper.pdf`、`paper.docx`、`figures/final/`、`logs/` 与 `build.json`；受同样回落规则约束。
评分轮次：`userData/sessions/<sid>/workbench/score/round-N.json`。

一处刻意的设计：`runtime` 只用 subprocess 调技能脚本、按退出码与产物双重判定，不 import 技能内部函数——这样 `skills/` 仍可被 Claude Code 等宿主单独装载。改这条要先想清楚代价。