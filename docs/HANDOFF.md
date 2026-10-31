# 交接 · M5 完成时的状态

给接手的人（或下一轮会话的我）。日期 2026-10-30。
提交数与文件数不要信我抄在这里的数字，跑 `git rev-list --count HEAD` 和 `git ls-files | wc -l` 自己取；HEAD 以 `git log -1` 为准。

## 0 一句话现状

M5 论文页：右栏「论文」能真跑 **xelatex 两遍 → pandoc 转 DOCX → Word 版式微调 → 去 AI 措辞 / 结构指标 / 章节结构三道门禁**，并用 pdf.js 做页级预览。本机演示稿真编 7 页（PDF 284 KB、DOCX 151 KB），三道门禁全绿；门禁条变成图表 / 评分 / 章节 / 论文排版四项。
**论文构建是工作台动作，不是阶段机的第五阶段**：阶段五不会因构建成功自动标为已过，K1 环境预检卡也没接；编译的是仓库里的演示稿，不会替你写正文。里程碑见 [../PLAN.md](../PLAN.md) §7。
**附件随消息送入模型**：文件复制到工作区（默认桌面「赛题」），发送前主进程抽正文（PDF 走 pdfjs、文本/CSV 直读并报行列），界面只显示胶囊；数据角色核对（目标列是否为空、行数、时间范围）仍未接入。

三句必须保留的限制：

- **没有用真实 DeepSeek/Kimi Key 跑过联网对话。** 已验证的是 OpenAI 兼容协议（本地假端点）与整条本机链路；两家服务的当下行为不在证据里。
- **论文样例不是对真实赛题的解答。** 内容是演示稿，评分卡也是演示数据；PDF/Word 一致性核对没有自动化。
- 仓库仍是 **private**。转公开需要维护者点头；转公开之前先读 §3 的拓扑计划。

**0.6.0 界面批次（2026-10-31，未跑 CI）**：左栏变成会话列表（建模会话从 SQLite 读，问答会话进 `localStorage`），支持新建、切换、单条删除与清空；中栏顶部显示会话标题与上下文用量，发送前按 200k/400k/1m 预算截断回放历史。设置页改为左侧服务商列表，预设 DeepSeek / 通义千问 / Kimi / 智谱 GLM / OpenAI 格式（模型名按官网 2026-10 核对），并提供上下文与思维深度选择器；深度按各家映射到 `reasoning_effort` 或 `thinking.type`。右栏可收成 56px 图标条，标签按产出/评审/资料分组，门禁摘要并入栏头。本机 G7 97/97、G6b 核验一致；CI 尚未跑这一批。

## 1 怎么验（命令 → 期望）

需要先装两侧依赖：`npm install`（可加 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，CI 不启动窗口时用）与
`python -m pip install -r requirements.txt -i https://registry.npmmirror.com/pypi/simple/`。

论文自检还需要 **xelatex 与 pandoc**（见 `docs/env-setup.md`）：xelatex 走 PATH 或 `MMS_XELATEX`；pandoc 走 PATH、`MMS_PANDOC`，最后回落到 `%LOCALAPPDATA%\mms-tools\pandoc.exe`。缺件时 G10 退出 1 并打印缺什么；只有显式 `MMS_PAPER_SKIP=1` 才跳过，且会打印「未验证 G10」。

不需要网络、不需要显示器的部分：

```bash
node scripts/check-registry.mjs                 # 8/8 项通过，技能 7 个            → exit 0
node scripts/check-registry.negative.mjs        # 9/9 条破坏被门禁抓到（含基线自证）→ exit 0
node scripts/check-skills.mjs                   # 6/6 项通过，技能 7 个            → exit 0
node scripts/check-skills.mjs --self            # 7/7 条自检通过（含基线自证）     → exit 0
node scripts/check-window-smoke.mjs --selftest  # 12/12 条核验自测                  → exit 0
python scripts/validate_contracts.py            # 9/9 项通过（jsonschema）         → exit 0
python runtime/selfcheck.py                     # 13/13 条 CLI 断言，含真渲一张图  → exit 0
python runtime/selfcheck_channel.py             # 52/52 条通道断言（含 M3 恢复与 0.6.0 思考深度/上下文截断）  → exit 0
python runtime/selfcheck_channel.py --selftest  # 10/10 条坏事件被拒                → exit 0
python runtime/selfcheck_workbench.py           # 13/13 条工作台断言（真渲两版）  → exit 0
python runtime/selfcheck_paper.py               # 10/10 条论文断言（真编 PDF/DOCX）→ exit 0
```

`selfcheck.py`、`selfcheck_workbench.py` 与 `selfcheck_paper.py` 会真调 matplotlib / xelatex / pandoc（各十几秒），需要 `requirements.txt` 与本机排版工具；`selfcheck_channel.py` 只起本机 Python 子进程与 127.0.0.1 上的假 OpenAI 端点，不需要排版工具、也不联网。

需要显示器的部分：

```bash
npm run smoke:window   # 真起窗口，97/97，写 screenshots/window-smoke.{png,json}、conversation.png、settings.png、decision.png、drawer.png、figure.png、score.png、paper.png、dropzone.png、files.png、attachments.png
npm run verify:window  # 独立读 JSON 并复算读数
```

`smoke:window` 自己设置 `MMS_FAKE_PROVIDER=1`，并把 Electron `userData` 指到临时目录，所以它不会用你已保存的真实 provider，也不会带着哨兵 Key 发请求；图表版本、论文工作区与日志也都写在这个临时目录。它还设 `MMS_WORKSPACE` 指向临时目录，避免在真实桌面建「赛题」；正常启动时默认工作区是桌面「赛题」，附件落在 `<工作区>/附件/日期/`。G7-9 会真编一遍演示稿，因此跑 G7 的机器必须有 xelatex 与 pandoc。
跑完可以直接看 `screenshots/paper.png`；断言通过不等于观感合格。

一把梭：`npm run gate`（顺序见 `package.json` 的 scripts；G7 不在 gate 里，因为它要显示器和 Electron 二进制）。

**本机跑 G7 前去掉 `ELECTRON_RUN_AS_NODE`**：本会话 shell 里它是 `1`，会让 `electron` 退化成 Node 并报 `app.setPath` 不存在。用 `env -u ELECTRON_RUN_AS_NODE npx electron tests/window-smoke.cjs`。

CI：<https://github.com/Escap1ng/mathmodel-studio/actions> —— 三 job：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
0.3.0 的 run `40982728779` 三 job 全绿；ubuntu 真启动 42/42、非白像素 3.15%（M2 的历史 run `40658227855` 为 27/27）。0.3.1 的 run `41000678500` 三 job 全绿，ubuntu 真启动 43/43、非白像素 3.12%。0.4.0 的 run `41008695577` 三 job 全绿，ubuntu 真启动 53/53、非白像素 3.98%。**0.5.0 的 run `41017241564` 三 job 全绿**：ubuntu 真启动 57/57、1440x900、非白像素 2.96%，G10 10/10、G9 13/13、G6 14/14；Windows 的 G10 显式跳过。取回截图：

```bash
gh run download <run-id> -n window-smoke --dir screenshots-m5-ci
```

## 2 已证 / 未证（别混）

| 结论 | 证据来源 | 强度 |
| --- | --- | --- |
| 注册表、技能规范、契约与 CLI 仍自洽 | 本机 gate + CI 双平台（M1 起） | 强 |
| 本机通道：握手、Bearer、Host/Origin、SSE 契约、续传、取消；0.6.0 思考深度与上下文截断 | `selfcheck_channel.py` 52/52（本机 Windows） | 强（本机） |
| 编排闭环：K2→K3→换一批→选择→阶段四 | 同上的 C12，事件与快照双向核对 | 强（本机） |
| 跨进程恢复：换一个服务器进程仍停在 K2 | 同上的 C13 | 强（本机） |
| 界面端到端：97 条，含论文构建、预览、可拖拽布局、附件拖放与正文送入、工作区文件页、按钮行固定、粘贴截图；0.6.0 追加多对话历史/切换/删除/清空、五家预设与上下文/深度选择器、右栏收起与分组 | G7 97/97，本机 Windows 真启动 + 人看截图 | 强（本机 Windows） |
| 图表工作台：真渲两版、换主题、并排 diff、回滚 | G9 W2–W4；G7 工作台段 | 强（本机） |
| 评分卡：三轮、五维、扣分定位、熔断、一票否决 | G9 W6；G7 评分段；演示数据 | 强（演示数据，非真实论文） |
| 论文排版：xelatex 两遍、pandoc DOCX、Word 后处理 | G10 P2/P3/P5；G7-9；本机真编 7 页 | 强（演示稿） |
| 论文门禁：去 AI 措辞、结构指标、章节结构 | G10 P4；G7-9 三门禁 chips | 强（演示稿） |
| 门禁能抓住坏稿 | G10 P7：注入两处过渡词后 phrasing 判红，PDF 仍生成 | 强（反向） |
| 缺工具 / 坏 TeX / 缺稿件 | G10 P6/P8/P9：分别退出 2 / 1 / 2，不产出假 PDF | 强（反向） |
| pdf.js 页级预览 | G7-9：画布尺寸与截图墨迹；`screenshots/paper.png` | 强（本机） |
| M5 在 CI 上真编 | run `41017241564`：ubuntu G10 10/10、G7 57/57、G6b 核验一致 | 强（ubuntu） |
| 0.5.2 在 CI 上真起窗 | run `41065088121`：ubuntu G7 78/78、非白像素 3.81%、G6b 核验一致；双平台 G4 47/47、G9 13/13、G3 13/13，ubuntu G10 10/10 | 强（ubuntu） |
| Windows CI 跑 G10 | 未装 MiKTeX，gates job 显式跳过并打印「未验证 G10」 | **未证**（执行层跳过，不是通过） |
| PDF 与 Word 版式一致性 | 未自动化；只做 docx 生成与后处理 | **未证** |
| 阶段五由构建驱动 / K1 环境预检 | 未接；论文页构建不推进阶段机 | **未证** |
| 论文 PDF/Word 之外的正文自动生成 | 未做；只编演示稿 | **未证** |
| 真实 DeepSeek / 通义千问 / Kimi / GLM 联网对话 | 无 Key，未跑 | **未证** |
| Linux 桌面 `safeStorage` 可用分支 | 只证了「不可用就拒绝保存」 | **未证** |
| Windows CI 真起窗 | 无 | **未证**；Windows 证据来自本机 |
| 便携 Python / TeX / pandoc 打包 | 未做；M6 | **未证** |

## 3 待维护者定的项

1. **收尾时的仓库拓扑**（方向已定，待择时）：两仓独立 → kit 冻结 → studio 完工后把 studio 历史合并进 kit（`--allow-unrelated-histories`，保留两个来源的提交与 `VENDOR.md` 里的出处哈希）→ 先把现有私有 studio 仓改名腾位、再把 kit 改名为 `mathmodel-studio`。star 跟随被改名的 kit；`mathmodel-kit` 这个名字此后不要复用。**不要 force-push 覆盖**，否则技能出处哈希变成孤悬对象。
2. **TeX 与 pandoc 在安装包里怎么存在**（M6）：要求用户本机装 / 内置 Tectonic / 两者都支持并让环境检测决定。M5 只做了检测与明确拒绝；便携 Python 的 300–400 MB 预估也要在打包时回填真实数字。
3. **provider 列表的维护方式**：现在三家写死在 `runtime/src/mms/providers.json`，界面允许手填模型名与自定义端点。是否改成用户可增删的服务商列表，取决于你想把「选模型」做成多重的决策点。
4. **Key 的 Linux 兜底**：当前规则是安全存储不可用就拒绝保存，不退回明文。如果目标用户里有 Linux 桌面且没有 Secret Service，是保持拒绝、还是明确提示后允许「本次会话内存保存」，需要你拍板。
5. **阶段机怎么接论文**：现在「构建论文」是工作台按钮，左侧阶段五仍显示「未开始」。是构建成功后把阶段五标为已过，还是把阶段五留给真正的「正文生成 + 交付打包」，二者语义不同，界面也应该不同。

## 4 界面待判的观感问题（我只报，没改）

`screenshots/window-smoke.png`、`conversation.png`、`settings.png`、`decision.png`、`drawer.png`、`figure.png`、`score.png`、`paper.png` 都是 1440×900、本机 Windows 下渲染。

M1/M2/M3 已报、仍未改：

- 左栏 240px 装不下最长的阶段名时靠收紧占位解决；阶段圆点仍是 `1.5px` 描边，在白底上很淡。
- 中栏空态文字偏上，下方到输入框之间空隙大。
- 状态栏右侧三枚色块与「墨青」间距 5px 偏小。
- 工具卡灰底与白底只差一点；模型条最长 300px，长名字会被截断。
- 设置页四个服务商是等宽胶囊，没有分组。

M4 已报、仍适用：

- 图表页在 440px 右栏里做两图并排 diff，单张约 180px 宽；看得清趋势，看不清细节。
- 评分页信息密度较高；「较上一轮」是否折起来属于视觉选择。

M5 新增：

- 论文页把 A4 页缩到约 370px 宽，正文可辨但字号很小；要不要加缩放或全屏预览，你定。
- 构建后右栏同时有步骤、门禁 chips 与折叠日志，面板偏长；日志默认折叠。
- 只预览 PDF，没有 DOCX 预览；Word 产物只显示体积。
- 左侧阶段五显示「未开始」而右侧论文已经编好，这个矛盾是否需要现在处理，见 §3 第 5 条。

## 5 M5 做完的与仍欠的

已完成：

1. `paper_build.py`：工作区、xelatex 两遍、PDF/DOCX 核验、pandoc、`word_postprocess.py`，每步耗时与日志尾部。
2. 演示稿 `paper_sample/paper.tex`：完整章节、三线表、公式、配图、参考文献、带代码附录；真编 7 页。
3. 三道门禁按 JSON 解析成门禁条；缺件、坏稿、坏 TeX、缺稿件都有反向覆盖。
4. 通道 `/workbench/paper/build`、`paper` 状态、门禁条第四项；主进程下发 PDF data URL，渲染层不碰路径。
5. 论文页：构建按钮、步骤、门禁、日志、pdf.js 预览。
6. G10 10 条、G7 97 条、G6b 下限 97 与 59 条关键断言；CI 装 TeX/pandoc。
7. 文档：README/README_EN、CHANGELOG 0.5.0、HANDOFF、env-setup。

仍欠：

- **阶段机接论文与 K1 环境预检**（§3 第 5 条）。
- **正文生成**：现在是固定演示稿，不读用户赛题。
- **PDF/Word 一致性核对**与 Word 预览。
- **TeX/pandoc 打包**与便携 Python。
- 真实厂商连通性、Linux 桌面 safeStorage 可用分支、Windows CI 起窗、Windows 上的 G10。
- `docs/env-setup.md` 英文版。

## 6 这一轮踩过的坑（别再踩）

**POST 处理器必须读请求体，否则 keep-alive 会中毒**：`/workbench/paper/build` 第一版没调 `self._body()`，客户端发来的 `{}` 留在连接里，下一条 `GET /workbench/state` 被解析成 `{}GET ...`，服务端回 501，界面报「运行时 HTTP 501」。凡是 `do_POST` 分支，先读体再处理。

**pdf.js 不要传 `data:` URL**：`getDocument({url: dataUrl})` 会去 fetch，CSP 的 `connect-src` 不放行 `data:`，报 `Unexpected server response (0)`。改成把 base64 解成 `Uint8Array` 传给 `getDocument({data})`；worker 由 Vite 打包，CSP 需要 `worker-src 'self' blob:`。

**pandoc 不在 PATH 时要有回落，但覆盖变量指向不存在的路径必须判缺**：本机装在 `%LOCALAPPDATA%\mms-tools\pandoc.exe`。`MMS_PANDOC` 设了但文件不存在时直接判缺（不回落到 PATH），否则「缺件反例」会被 PATH 里的 pandoc 悄悄救活。

**xelatex 能编模板不等于模板能过门禁**：vendored `paper.tex` 是骨架，章节门禁 hard 失败 8 项是预期。要让门禁真绿，需要一份完整样例，并按 `check_style.py` 的段落节奏调长度（相邻合格段落字数差需 ≥20%；LaTeX 表格行也会被当成段落统计）。

**`check_phrasing.py` 会扫注释**：模板里的写作提示（「随着…的发展」）会被当成命中。样例稿的注释也要避开词表。`transition-abuse` 的 `max_per_document` 是 1，全文用一次「综上所述」算合规，反例要注入两次。

**G7 新增断言要同步三处**：`tests/window-smoke.cjs` 的断言、`scripts/check-window-smoke.mjs` 的 `MIN_ASSERTIONS` 与 `REQUIRED_ASSERTIONS`、以及文档里的条数。门禁条从三项变四项时，G7 的 gate 断言也要改。

**窗口 resize 时的夹取要防抖**：从 1440 拉到 2400 的过程中会触发多次中间尺寸的 resize，立刻按当前 innerWidth 夹取会把用户保存的宽度永久压到最小值（G7 曾读到右栏 380px）。现在等 180ms 尺寸稳定后再夹，测试也在断言前等右栏 >800px。

**分隔条高亮用 CSS 变量定位**：`--grip-y` 由 pointermove/pointerenter 写在工作台栏边界上，`::after` 用 `radial-gradient(... at 50% var(--grip-y))` 当遮罩，光带以指针为中心向两端渐隐；不要固定 50%，也不要在 pointerleave 清空它（淡出时会闪回中点）。拖拽时窗口级 pointermove 也要继续更新它。输入框上沿的空心描边长条固定居中、不跟随鼠标，只随 hover/拖拽变色；左栏固定 240px，没有分隔条。

**CI 的排版依赖是硬依赖**：gates 的 ubuntu job 装 `pandoc` 与 `texlive-xetex/texlive-lang-chinese/texlive-latex-extra`；window-smoke job 同样要装，否则 G7-9 会红。Windows gates 没有 TeX，G10 用 `MMS_PAPER_SKIP=1` 显式跳过，跳过必须打印「未验证」，不能算通过。

**上一轮的坑仍然有效**：SSE 流要显式 `Connection: close`；事件可能比 `chat.start` 返回值先到；G7 的假 provider 必须在 `require` 生产入口之前设；`app.exit(1)` 会被 `window-all-closed` 顶掉，结论必须落 JSON 由 G6b 独立判；Windows 控制台 cp1252 会因中文崩溃，入口要 reconfigure UTF-8；本机 shell 可能带 `ELECTRON_RUN_AS_NODE=1`；safeStorage 的「不可用」是正常分支；`git` 通道会瞬时断，先探本机代理端口并重试，不要改 remote。

**0.6.0 新增的坑**：

- `capturePage()` 在窗口被遮挡时会抛 `UnknownVizError`，G7 的截图全部走 `capture(win)` 重试封装；不要退回裸调用。
- 会话列表有两套来源：`GET /sessions` 只返回建模会话的摘要，问答会话在渲染层 `localStorage`（`mms.chatConversations.v1`）。清空历史必须两边一起删，否则列表会「复活」。
- 上下文估算在 TS（`lib/context.ts`）与 Python（`server.py` 的 `estimate_tokens`）各有一份；改公式必须两边同步，G4 的 C14 用 200k 预算下的截断验证 Python 侧。
- 左栏宽度仍是 240px，`.tab` 仍是 7 个；右栏分组只加 `.tabs__group`/`.tabs__label`，不要把标签并成 6 个，G6b 点名了标签数量与左栏固定。
- 面板标题与门禁条已并入栏头/面板内 `.panel__bar`；G7 不再有 `.gatebar` 断言，但门禁页的 `[data-gate-row]` 仍必须 4 条。

## 7 结构速查

```
skills/                     7 个 vendor 进来的技能（原样）+ manifest.json + VENDOR.md
schemas/                    skill-manifest.schema.json、chat-events.schema.json
runtime/src/mms/
  server.py                 本机通道：握手、鉴权、SSE、会话、workflow、工作台与论文端点
  store.py                  SQLite：阶段、待决卡、消息、轮次
  orchestrator.py           K2/K3/K4 的确定性状态机
  workbench_figure.py       图表渲染、主题、版本与回滚
  workbench_score.py        评分卡、扣分定位、章节样例与一票否决
  paper_build.py            论文流水线：xelatex、pandoc、Word 后处理、三道门禁
  paper_sample/paper.tex    M5 演示稿（真编 7 页）
  demo_scores.json          三轮演示评分卡
  themes/                   studio-ink / studio-amber 主题
  provider.py               OpenAI 兼容流式客户端 + 离线假 provider
  providers.json            DeepSeek / 通义千问 / Kimi / 智谱 GLM / OpenAI 格式预设与思考参数映射
  registry.py / invoke.py   技能注册表与 subprocess 调用
  cli.py                    serve / templates / invoke
runtime/cli.py              开发期入口（npm run mms）
runtime/selfcheck_channel.py G4/G5 自检与 10 条反向覆盖（含跨进程恢复）
runtime/selfcheck_workbench.py G9 工作台自检（真渲两版）
runtime/selfcheck_paper.py  G10 论文自检（真编 PDF/DOCX + 四条反向）
src/main/
  index.ts                  窗口、IPC、provider 合并视图、SSE 转发、resume、PDF data URL
  channel.ts                Python 子进程生命周期、HTTP/SSE 客户端
  settings.ts               safeStorage 密文读写
src/preload/index.ts        window.studio 窄接口
src/shared/api.ts           主进程与渲染层共享的纯类型
src/renderer/src/
  App.tsx                   运行时状态、provider、对话事件归并、快照恢复
  components/ChatPane.tsx   流式消息、工具卡、输入区、阶段胶囊
  components/DecisionCard.tsx  K2 确认卡与 K3 选模卡
  components/ExplainDrawer.tsx K4 右栏抽屉
  components/WorkspacePane.tsx 图表/论文/门禁/代码/评分/日志工作台 + pdf.js 预览
  components/SettingsDialog.tsx  服务商/模型/Key 设置
  lib/chat.ts               事件折叠的纯函数
  lib/phases.ts             阶段名与状态文案
  styles/workbench.css      M4 工作台与 M5 论文页样式
scripts/                    G1/G1 反向/G8/G8 反向/G6/G6b 与契约校验
tests/window-smoke.cjs      真启动断言（97 条）+ 截图与 JSON 结论
.github/workflows/ci.yml    gates（ubuntu+windows，含 G9/G10）与 window-smoke（ubuntu，装图表与排版依赖）
```

会话库位置：Electron `userData/sessions.db`；命令行直接起 runtime 时是 `<MMS_HOME>/.mms/sessions.db`，可用 `MMS_DATA_DIR` 覆盖。库内只有阶段、待决卡与消息，没有 Key。
图表版本位置：`userData/workbench/figure/versions/<v>`，`state.json` 记当前版与上一版。
论文工作区：`userData/workbench/paper/`，含 `paper.tex`、`paper.pdf`、`paper.docx`、`figures/final/`、`logs/` 与 `build.json`；同样随 `MMS_DATA_DIR` 走。

一处刻意的设计：`runtime` 只用 subprocess 调技能脚本、按退出码与产物双重判定，不 import 技能内部函数——这样 `skills/` 仍可被 Claude Code 等宿主单独装载。改这条要先想清楚代价。
