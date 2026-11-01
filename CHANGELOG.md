# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
从 `0.1.0` 起，CLI 参数与退出码、注册表字段、产物路径为 Stable；`--json` 字段顺序与错误措辞仍为 Experimental。

## 0.6.1 - 2026-11-01

表格读取、长会话压缩与阶段四真跑。

### 新增

- **xlsx 工作表读取**：解压工作簿读出全部工作表并转成文本表格交给模型；识别共享字符串与富文本、稀疏列、布尔/错误值和公式缓存值，日期与时间按单元格格式渲染（含 1904 日期系统）。单表最多 300 行 × 60 列，截断时在说明里注明；旧版 `.xls` 仍提示另存为 `.xlsx` 或 CSV。新增 G13 自检并接入 gate 与 CI。
- **阶段四真跑**：选模确认后不再只写说明，而是定位工作区里的 CSV、生成并执行基线脚本，把 PNG/PDF/SVG 登记成图表版本；工作区没有数据时回落到内置示例，并在对话里说明用了示例。右侧工作台收到新产物后自动回拉状态。
- **长会话压缩（G12）**：harness 先裁剪旧的工具结果，再把较早轮次压成结构化摘要，每轮只保留一条状态锚点；上下文溢出时压缩后重试。50 轮长会话可压到预算内，最近 6 条消息保留原文。对话流里插入压缩分隔线，显示压缩前后的估算 token；失败消息可点「重试」。
- **文件页拖动与右键**：工作区文件可以拖进中栏直接作为附件，右键提供「添加到对话 / 打开 / 在文件夹中显示 / 复制路径 / 移到回收站（二次确认）」。直接放进工作区根目录的文件也能发给模型；从待发列表移除工作区原件时只拿走附件，不删文件。

### 变更

- 问答会话的本地存储上限从 30 个会话 / 80 条消息提到 60 / 300；只有最近 8 条保留附件全文与思维过程，更早的只留界面文本，避免 `localStorage` 撑爆。
- G7 断言 97 → 100：新增工作区文件拖入、右键菜单、移除不删原件三条；阶段四开始真跑并自动登记图表后，同步了工具卡定位、阶段四流式状态与图表版本计数的三条断言。G6b 下限与点名同步 100 条。

### 修复

- 默认方法族被写成单元素元组时，K2 确认后会抛 `ValueError`；改为按列表处理（G11 反向覆盖 N1）。
- 安装器默认目录改到桌面的 `MathModel Studio`：electron 默认的 per-user 目录落在 `%LOCALAPPDATA%\Programs`，与赛题工作区分不开；`preInit` 写入 HKCU 的 `InstallLocation`，旧记录指向的程序目录不存在时回到桌面默认。

### 打包与仓库

- 本机构建 `mathmodel-studio-0.6.1-setup.exe`（264,667,760 字节，约 264.7 MB），用本机 `CN=Escap1ng Self-Signed Code Signing` 自签名证书签署（证书根不受信任，SmartScreen 仍会提示未知发布者）；未在干净机器上安装验证。

### 验证（本机 Windows，2026-11-01）

- `npm run typecheck`、`npm run build`、`npm run gate` 全部通过：注册表 8/8 与 9/9 破坏被拒、技能 6/6 与 7/7、构建产物 14/14、契约 9/9、G3 13/13、G4 52/52 与 10/10 坏事件被拒、G11 13/13 与 2/2 反向、G12 14/14 与 2/2 反向、G13 10/10、G9 13/13、G10 10/10。
- G7 真启动 100/100，内容尺寸 1440×900，非白像素 3.83%；G6b 独立核验一致。
- CI run [`41289813731`](https://github.com/Escap1ng/mathmodel-studio/actions/runs/41289813731) 三个任务全绿：ubuntu 真启动 100/100、内容尺寸 1440×900、非白像素 4.43%，G6b 复算一致；ubuntu 与 windows 门禁均通过，Windows 的 G10 显式跳过并标注未验证。
- 未用真实 DeepSeek / 通义千问 / Kimi / 智谱 GLM Key 联网；Windows CI 真起窗与干净机安装仍是未证项。

## 0.6.0 - 2026-10-31

多对话、五家模型预设与可收起的右栏。

### 新增

- **多对话与历史**：左栏上半变成会话列表。建模会话从 SQLite 的 `/sessions` 读取，问答会话写入 `mms.chatConversations.v1`；支持新建、切换、单条删除（二次确认）与清空全部。切换问答会话会恢复消息、附件胶囊与上下文全文；切换建模会话会恢复阶段、待决卡与历史消息。中栏顶部显示当前会话标题、估算上下文用量与「清空当前」。
- **AI 设置页重做**：左侧服务商列表、右侧表单；预设 DeepSeek（`deepseek-flash`、`deepseek-v4-pro`）、通义千问（`qwen3.8-max`、`qwen3.7-plus`、`qwen3.8-flash`）、Kimi（`kimi-k3.1-pro`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`）、智谱 GLM（`glm-5.3`、`glm-5.3-flash`、`glm-4.7`）与 OpenAI 格式端点。模型名按各家官网 2026-10 核对，仍可手填。
- **上下文预算 200k / 400k / 1m**：按粗估 token 从最新消息往回装，装不下的旧历史不回放；runtime 按同一预算再截一次。输入条显示「预算 · 深度」，中栏顶部显示已用估算。
- **思维深度 中 / 高 / 最大**：DeepSeek、Kimi K3、GLM-5.3 映射为 `low / high / max`，Qwen 映射为 `medium / high / max`；Kimi K2.x 与 GLM-4.x 改用 `thinking.type`。OpenAI 格式端点默认不发思考参数，需显式勾选「发送思考深度」。
- **右栏收起与分组**：工作台可收成 56px 图标条（保留 7 个页签与 4 个门禁点），点图标展开并切到对应页；展开时标签按「产出 / 评审 / 资料」分组，门禁摘要并入栏头，面板重复标题与独立门禁条移除。状态记在 `mms.workspaceCollapsed`。

### 备份 / 迁移

- `settings.json` 每个服务商新增可选 `context`（200000/400000/1000000）与 `depth`（medium/high/max），自定义端点另有 `sendThinking`。旧文件不含这些键时按 200k / 高 / 预设默认处理，不需要迁移。
- 会话表结构未变；只新增 `GET /sessions`、`DELETE /sessions/{id}` 与 `DELETE /sessions`。

### 门禁

- G7 新增 15 条：五家预设与官方模型名、OpenAI 格式端点与开关、上下文/深度可切换并落盘、问答会话进入列表、新建清空、切换恢复、单条删除、清空历史、门禁摘要并入栏头、右栏收起与图标展开；总数 82 → 97，G6b 下限与点名同步 97 / 59 条。
- G4 新增 4 条（C14）：思维深度写入 `reasoning_effort`、关闭开关时不带字段、上下文预算截断最早历史、截断后仍能跑完；总数 47 → 52。
- G7 的截图统一走重试封装，避免 Windows 遮挡时 `capturePage()` 的 `UnknownVizError` 把整轮判成脚本异常。

### 打包与仓库

- **NSIS 安装包**：electron-builder 配置与随包工具链（便携 Python、pandoc）接线完成；本机构建 `mathmodel-studio-0.6.0-setup.exe`（约 264 MB，自签名证书，证书根不受信任），尚未在干净机器上安装验证。
- **图标**：应用、安装器与向导页头/侧栏图统一由 `build/icon.svg` 一处源生成，`scripts/make-icon.mjs` 同时产出 `icon.ico` 与两张 24 位 BMP。
- **仓库收尾**：studio 历史并入原技能库并改名为 `Escap1ng/mathmodel-studio`，原私有仓改名为 `mathmodel-studio-archive`；旧 Release 与 tag 已清理，`skills/VENDOR.md` 记录同步。
- **许可**：仓库与安装包整体改为 AGPL-3.0-only；`skills/` 中原 Apache-2.0 文件保留原许可与署名。

### 验证（本机 Windows 与 CI，2026-10-31）

- `npm run typecheck`、`npm run build` 通过；`python runtime/selfcheck_channel.py` 52/52；G7 真启动 97/97，G6b 独立核验一致（内容尺寸 1440x900，非白像素 4.09%）。
- CI run `41172805948` 三 job 全绿：ubuntu 真启动 97/97、内容尺寸 1440x900、非白像素 4.16%，G6b 核验一致；ubuntu 与 windows 门禁 job 均通过，Windows 的 G10 显式跳过并标注未验证。
- 未用真实 DeepSeek / 通义千问 / Kimi / 智谱 GLM Key 联网；模型名来自官网 2026-10，参数效果不在证据里。

## 0.5.3 - 2026-10-30

输入区的操作行从卡片里拿出来，固定在窗口底部。

### 变更

- **按钮行独立固定**：模式切换、模型、阶段、发送这一排从输入框卡片内部移到卡片下方，作为独立一行贴在窗口底部；拖输入框上沿只改变卡片的拉伸高度，按钮行位置不动（实测 top 1122 → 1122）。按钮行与卡片同宽、同左边界，宽屏下都按 760px 居中。
- **卡片内边距恢复对称**：卡片上下各 12px，不再为按钮行留白；按钮行距窗口底 18px，与卡片间隔 8px。
- **不再常驻附件按钮**：输入卡片里去掉「＋ 附件」；粘贴截图或剪贴板文件直接进队列——没有本地路径的字节由主进程写进 `<工作区>/附件/日期/`，图片命名「截图-年月日-时分秒.png」，带路径的文件仍走原有暂存；拖入文件、空态点击选择照旧。占位文案改为提示可粘贴截图。

### 门禁

- G7 新增 4 条：按钮行在卡片外且与卡片同宽同左、拉伸输入框后按钮行不移动、粘贴截图进队列并在工作区落盘、输入区不常驻附件按钮；总数 78 → 82，G6b 下限与点名同步 82 / 45 条。

### 验证（本机 Windows，2026-10-30）

- G7 82 条全过（本次新增 4 条），G6b 独立核验一致，内容尺寸 1440x900，非白像素 3.50%。按钮行实读 gap 8px、`inCard=false`、left/width 与卡片一致；拖动输入框上沿 182 → 272 时按钮行 top 1122 → 1122。
- 粘贴 1×1 PNG：队列出现「截图-20261030-233153.png」，工作区同日目录里同名为 `image` 类文件；点 × 后队列清空、暂存副本删除。

## 0.5.2 - 2026-10-30

附件真正进入模型上下文。

### 新增

- **附件正文随消息送入**：发送前由主进程抽取暂存附件的正文——PDF 走 pdfjs（最多 30 页）、文本/CSV/JSON 直接读（UTF-8，坏码率过高时按 GBK 再解一次），CSV 顺带报出「N 行 × M 列」。单文件 2 万字符、单条消息 6 万字符封顶，超限截断并在附件标题里注明；Word/Excel/图片只登记文件名并说明未解析。
- **输入区挂附件**：中栏任意位置都能拖入；已有对话时整列铺一层虚线遮罩，输入框上方出现附件胶囊与「＋ 附件」。可以不写文字只发附件。
- **气泡与恢复**：附件随消息显示为用户气泡下的胶囊，正文只进模型、不铺在界面里。会话里存的是「手打文字 + 附件正文」，重开时按固定标记剥掉正文、还原胶囊；历史重放仍带正文，模型不会在第二轮忘掉文件内容。
- **K2 卡登记附件**：`problem-confirm` 卡的附件清单来自题面里的附件块；子问题只按手打题面切分，只拖文件不写字时改用附件正文。警告改为「附件正文已随题面送入；数据角色核对尚未接入」。
- **只读暂存区**：`files:context` 校验路径必须落在 `<工作区>/附件` 下；读不到的文件返回原因而不是整体抛错。

### 门禁

- G7 新增 4 条：PDF/CSV 正文抽取（含行列数）、只读取工作区附件、附件随消息送进模型（K2 卡计数 + 会话题面含标记 + 气泡不铺正文）、重开后附件胶囊还原；总数 74 → 78，G6b 下限与点名同步 78 / 41 条。
- C12 用例的题面带上附件块：断言 K2 登记 1 个附件、附件正文不参与子问题切分；通道断言 46 → 47。

### 验证（本机 Windows，2026-10-30）

- G7 78/78，G6b 独立核验一致，内容尺寸 1440x900，非白像素 3.47%。PDF 夹具 `ATTACH-MARKER-2026` 抽到正文且记为「1 页」，CSV 记为「2 行 × 2 列」；K2 会话题面含 `K2-PDF-MARKER-88`，气泡只显示手打文字与一个附件胶囊；刷新页面后胶囊还原、正文不铺开。
- 工作区归属校验：工作区外的文件调用 `files:context` 被拒，提示「只能读取工作区里暂存的附件」。

### 验证（CI，run 41065088121）

- 三 job 全绿：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
- ubuntu 真启动 78/78，内容尺寸 1440x900，非白像素 3.81%；G6b 独立复算一致。附件四段在 CI 上同样成立：PDF 抽到 `ATTACH-MARKER-2026` 并记「1 页」、CSV 记「2 行 × 2 列」，工作区外路径被拒，K2 卡登记 1 个附件且题面含正文，气泡只有胶囊、重开后胶囊还原。
- ubuntu 与 Windows 的 G4 都是 47/47（含 C12 的两条附件断言）；G9 13/13、G3 13/13；ubuntu 的 G10 10/10。
- Windows 的 G10 仍显式跳过：`SKIP 缺少排版工具：['xelatex', 'pandoc']（MMS_PAPER_SKIP=1，未验证 G10）`，没有当成通过。

## 0.5.1 - 2026-10-30

可拖拽工作台与输入框；中栏附件拖放区与工作区文件页。

### 新增

- **工作台分隔条**：右侧工作台（380–1100px）可拖拽，双击复位，方向键微调，宽度写入 `localStorage`；拖拽时保证中栏至少 480px。左栏固定 240px，不提供推拉。
- **宽屏按比例**：右栏默认宽度从固定 `440px` 改为 `clamp(460px, 38vw, 1100px)`；2400 宽窗口实测 912px，2560 宽约 973px，不再像固定宽度那样只占一小条。
- **输入框上沿拖拽**：上沿留 8px 拖拽区，并常显一条 84×8 的空心描边长条，骑在输入框顶边框线上；长条固定居中、不跟随鼠标，悬停/拖拽时描边变成强调色。拖拽改输入区高度（最小 132px，最多聊天区 72%），双击复位，方向键微调，高度写入 `localStorage`。
- **光带跟随指针**：工作台分隔条的高亮不是固定短条，而是一道贯穿分隔线、以指针为中心向两端渐隐的光带（横向也羽化）；悬停、聚焦、拖拽时显现，离开时原地淡出。
- 窗口大小变化时，保存的宽度/高度做 180ms 防抖后再夹取，避免从 1440 拉到 2400 的中间尺寸把宽度永久压到最小值。
- **右栏版式随宽度切换**：用容器查询按工作台自身宽度（不是视口）切换，拖宽或拖窄都成立。窄栏保持单列；宽栏下论文页拆成「PDF 预览 + 步骤/门禁/产物」两栏并把预览限宽 620px，评分页拆成「总分与五维 + 扣分明细」两栏，门禁 2×2，代码页命令与产物路径左右分栏。论文页头部补 `页数 · 体积` 摘要，产物行只显示文件名与体积（完整路径在悬停提示里）。不按阶段自动切页。
- **空态补下一步**：图表、代码、日志、论文的空态改为「说明 + 步骤 + 入口按钮」；代码与日志的空态可直接跳回图表页，论文空态写明三道门禁，缺排版工具时沿用上方安装提示。
- **赛题拖放区**：中栏空态换成 605×460 的大框，中央一个加号。整列任意位置可拖入文件，也可以点击选择；拖拽时框变实线、底色转强调色、加号反白，标题变「松手即添加」。文件以胶囊列出类型、体积与移除按钮；坏路径、文件夹、超过 100 MB、一次超过 20 个都当场给原因。文件只做暂存，暂不参与对话。
- **工作区与文件页**：右栏新增第 7 个标签「文件」，列出工作区里的文件（类型、体积、修改时间、所在子目录），点行用系统程序打开；可刷新、更改工作区、恢复默认、打开文件夹。默认工作区为桌面「赛题」，首启自动创建；拖入的副本落在 `<工作区>/附件/日期/`，拖入或移除时文件页自动刷新。工作区选择写入 `settings.json`。

### 修复

- **握把淡出时闪回中间**：指针离开分隔条不再清空 `--grip-y`，只让透明度淡出。拖拽常在分隔条外松手，旧逻辑会在淡出过程中把高亮瞬间挪回中点，看起来像「跳一下」；现在进入时先按指针落位，离开时原地淡出。

### 门禁

- G7 新增 9 条：宽屏右栏比例、宽屏论文页两栏且预览限宽、宽屏评分页两栏、光带跟随指针、离开分隔条后光带保持在指针处、左栏固定不可拖拽、中/右拖拽、输入框上沿拖拽、输入框上沿空心长条居中骑在框线；总数 57 → 66。
- 追加 8 条：拖放框与加号居中、拖拽高亮与复位、CDP 真拖放（落盘→清单→移除）、坏文件给出原因、移除只删副本、文件页列出工作区文件、默认工作区路径、暂存落在工作区；总数 66 → 74。G6b 下限与点名同步 74 / 37 条，其中「真拖放」用 CDP 注入带真实路径的拖放，合成 `File` 没有本地路径、验不到这一段。

### 验证（本机 Windows，2026-10-30）

- G7 74/74，G6b 独立核验一致，内容尺寸 1440x900，非白像素 3.44%。拖放框实读 605×460，加号水平偏移 0px；CDP 拖入 `drag-problem.csv` 后清单与文件页都出现该文件，点 × 移除并刷新后条目消失、原文件仍在。冒烟用 `MMS_WORKSPACE` 指向临时目录，核对默认路径仍是「桌面/赛题」。
- 离开分隔条后 `--grip-y` 仍为 120px，遮罩中心也留在 120px；输入框上沿长条实读 84px、1px 描边、底色与页面一致（盖住框线）、水平居中，中心与输入框顶框线相差 0px。
- 2400×1200 实测：右栏默认 912px，左拖 140px 后 1052px；左栏固定 240px；输入框 145 → 235px；双击均能复位；光带位置读到 300px。论文页两栏实读 459 + 376px（预览限宽 620），评分页 376 + 459px。

## 0.5.0 - 2026-10-30

M5 排版全链路：一题进，`paper.pdf` 与 `paper.docx` 出，去 AI 与章节门禁全绿。目标是「论文页能真编译、真给产物、真跑门禁」，不是自动写正文。

### 新增

- **论文流水线** `runtime/src/mms/paper_build.py`：工作区在 `userData/workbench/paper`；xelatex 两遍 → 产物核验（`%PDF` 文件头与体积）→ pandoc 转 DOCX → `word_postprocess.py` 版式微调；每步记耗时与输出尾部，失败保留错误位置。
- **演示稿** `runtime/src/mms/paper_sample/paper.tex`：摘要、问题重述、问题分析、模型假设、符号说明、模型建立与求解、模型检验、模型评价与改进、AI 使用声明、参考文献与带代码的附录；配图从 vendored `mathmodel-figure` 的预览复制进 `figures/final`。真编 7 页。
- **三道门禁**：`check_phrasing.py`（词表级 AI 痕迹）、`check_style.py`（长被动句、句式重复、过渡词密度、长短句与段落节奏、小数位）、`check_chapters.py`（国赛章节结构，hard/soft/manual）。结果按 JSON 解析成门禁条，不只看退出码。
- **工具探测**：`MMS_XELATEX` / `MMS_PANDOC` 可覆盖；pandoc 回落到 `%LOCALAPPDATA%\mms-tools\pandoc.exe`。缺件时明确列出缺什么并以退出码 2 拒绝，不自动安装。
- **通道与 IPC**：`POST /workbench/paper/build`；`GET /workbench/state` 增加 `paper` 字段与门禁条第四项「论文排版」；主进程把 PDF 读成 data URL 下发，渲染层拿不到文件路径。
- **论文页**：构建/重新构建按钮、工具版本、六步进度、三道门禁 chips、编译日志尾部、pdf.js 页级预览（上一页/下一页）。
- **依赖 `pdfjs-dist`**：worker 由 Vite 打包进 `out/renderer/assets`；CSP 增加 `worker-src 'self' blob:`，PDF 以二进制交给 pdf.js，不走网络。
- **G10 论文自检** `runtime/selfcheck_paper.py`：10 条，真编 PDF/DOCX、文件头、六步、三道门禁、状态落盘，外加缺 pandoc、坏稿、坏 TeX、缺稿件四条反向。
- **G7 扩展**：论文页构建、PDF/DOCX、三道门禁与预览渲染，共 57 条；G6b 下限同步 57、点名 21 条。
- **CI**：gates job 在 ubuntu 安装 pandoc 与 texlive-xetex/中文支持并跑 G10（Windows 显式跳过并标注未证）；window-smoke job 安装同套依赖，G7-9 真编一篇。

### 变更

- 门禁条由三项变四项：图表 / 评分 / 章节 / 论文排版。
- 版本 `0.4.0 → 0.5.0`。

### 验证（本机 Windows，2026-10-30）

- `npm run gate` 全绿：G9 13/13、G4 46/46、事件自测 10/10、G10 10/10、G6b 自测 12/12、G7 57/57（内容尺寸 1440x900）。
- 论文构建 5.4 秒：PDF 284 KB（7 页）、DOCX 151 KB；phrasing 0、style 0、chapters hard 0 / soft 0。
- 论文页真起窗：构建 → 三道门禁 → pdf.js 预览出第 1 页，截图 `screenshots/paper.png`。
- 工具版本：MiKTeX-XeTeX 4.16（MiKTeX 25.12）、pandoc 3.13（装在仓库外的 `%LOCALAPPDATA%\mms-tools`）。

### 验证（CI，run 41017241564）

- 三 job 全绿：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
- ubuntu 上 G10 10/10（真编 PDF/DOCX 与四条反向）、G9 13/13、G6 14/14。
- ubuntu 真启动 57/57，内容尺寸 1440x900，非白像素 2.96%；论文页构建与 pdf.js 预览通过（预览截图非白 7.86%）。G6b 独立复算一致。
- Windows 的 G10 显式跳过：`SKIP 缺少排版工具：['xelatex', 'pandoc']（MMS_PAPER_SKIP=1，未验证 G10）`，没有当成通过。

### 尚未做

- **阶段机没有接论文**：论文构建是工作台动作，阶段五不会因构建成功自动标为已过；K1 环境预检卡也未接。
- **演示稿不是真实赛题**：不读用户上传的题目，不自动生成正文；评分卡仍是演示数据。
- PDF 与 Word 的一致性核对未自动化，只做了 docx 生成与版式微调。
- 排版工具打包未定：要求本机安装还是内置，留给 M6。
- Linux 桌面 `safeStorage` 可用分支、Windows CI 真起窗仍未证。
- 便携 Python 与 `docs/env-setup.md` 英文版仍未做。

## 0.4.0 - 2026-10-30

M4 工作台：图表返工、评分卡与门禁条。目标是「一张图能换主题重渲并回滚；一份稿子能出五维评分与扣分定位」。

### 新增

- **图表工作台** `runtime/src/mms/workbench_figure.py`：复用 `mathmodel-figure` 的渲染器与注册表，渲染结果落到 `userData/workbench/figure/versions/<v>`；记录当前版/上一版、命令、stdout/stderr，支持回滚。未知模板/主题/版本不落版本。
- **两套自定义主题** `runtime/src/mms/themes/`：`studio-ink` 与 `studio-amber`，与内置 `nature` 并列；主题文件通过 vendored `validate_theme.py` 校验。
- **评分卡** `runtime/src/mms/workbench_score.py` + `demo_scores.json`：三轮示例评分（78 / 86 / 84），每轮五维、扣分明细带正文定位与改法；第 3 轮低于 85 显示熔断提示；另带一票否决示例；章节结构跑 `chapter-sample.tex` 的 `check_chapters.py`。
- **工作台界面**：右栏图表页（模板/主题选择、重渲、并排 diff、版本条、回滚）、评分页（五维条、总分、轮次、扣分定位、熔断/否决）、门禁页、代码页（实际渲染命令与产物路径）、日志页（最近一次渲染输出）；顶部三项门禁条。
- **IPC/通道**：`GET /workbench/state`、`POST /workbench/render`、`POST /workbench/rollback`；主进程把 PNG 读成 data URL 下发，渲染层拿不到本地路径权限。
- **G9 工作台自检**：13 条，真渲两版、回滚、未知输入不落版本、三轮评分、扣分定位、一票否决与章节样例。
- **G7 扩展**：首版渲染、换主题 diff、回滚、评分五维/86、扣分定位、熔断、否决、门禁条，共 53 条；G6b 下限同步 53、点名 17 条。
- CI 的 window-smoke job 增加图表依赖安装。

### 变更

- 版本 `0.3.1 → 0.4.0`。
- 工作台不再只是占位卡片；论文页明确标注 PDF 预览待到 M5。

### 验证（本机 Windows，2026-10-30）

- `npm run gate` 全绿：G9 13/13、G4 46/46、事件自测 10/10、G6b 自测 12/12、G7 53/53（内容尺寸 1440x900）。
- 真启动：工作台首版 → 换 `studio-ink` 出 v2 与并排 diff → 回滚 v1；评分五维 86、扣分定位、第三轮熔断、一票否决与门禁条均通过。

### 验证（CI，run 41008695577）

- 三 job 全绿：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
- ubuntu 真启动 53/53，内容尺寸 1440x900，非白像素 3.98%；G6b 独立复算读数一致。G9 在 ubuntu 13/13，G6 产物冒烟 14/14。
- Linux runner 无 Secret Service：`safeStorage 可用=false`、文件不存在、保存被明确拒绝；应用菜单为 null，状态栏为「运行时已连接 · 离线演示」。
- 工作台段在该 run 内实走：首版 v1 → 换主题出 v2 并并排 diff → 回滚 v1；评分五维 86、扣分定位、第三轮熔断、一票否决、门禁条三项全过。

### 尚未做

- **论文 PDF/Word 预览**要等 M5；现在论文页只给边界说明，没有假预览。
- K5 的换数据列、改字号密度与容量超框检查还没接；本版只做模板/主题/版本/回滚。
- 评分卡是演示数据，不是对真实论文的自动评判；真实评分与扣分定位要等用户稿子接入。
- 真实 DeepSeek/Kimi 联网、Linux 桌面 Secret Service 可用分支仍未证。

## 0.3.1 - 2026-10-30

界面留白、对齐与中文文案修订。

### 变更

- 左栏阶段行收紧横向占位、略增纵向间距，「赛题分析与背景调研」不再折成孤字。
- K3 候选卡：元数据改成两列短字段，只给推荐项保留一句理由，卡内留白与按钮基线统一。
- K4 抽屉关闭按钮移到右上角与标题对齐；输入条与状态栏的间距统一。
- 状态栏、运行时提示、工作台空态说明改为中文；`API Key`、`Base URL`、模型 ID 与品牌名保留。
- Windows/Linux 移除 Electron 默认的英文 `File / Edit / View` 菜单。

### 门禁

- G7 新增「Windows/Linux 不挂英文系统菜单」断言，总数 42 → 43；G6b 下限同步到 43，自测仍 12 条。

### 验证（CI，run 41000678500）

- 三 job 全绿；ubuntu 真启动 43/43，内容尺寸 1440x900，非白像素 3.12%；解释抽屉截图 10.87%。
- Linux 上 `Menu.getApplicationMenu()` 为 null，状态栏为「运行时已连接 · 离线演示」。

## 0.3.0 - 2026-10-30

M3 编排闭环。目标是「提交一道题 → 停在选模卡 → 关窗重开仍停在原处 → 点选后继续；解释打开抽屉且不清除待选」。不接真实 Key 也能用离线演示走完。

### 新增

- **会话存储** `runtime/src/mms/store.py`：标准库 `sqlite3` 一张表保存阶段状态、待决卡、消息与轮次；库文件默认在 Electron `userData/sessions.db`（`MMS_DATA_DIR` 可覆盖），**不存 Key**。没有引入 LangGraph/langchain-core——这里只需要「暂停 + 跨进程恢复」，PLAN §8 已把自研状态机列为可退让项。
- **编排状态机** `runtime/src/mms/orchestrator.py`：起题后停在 K2（按题面切子问题、列出附件缺口）；确认后阶段 2 过、阶段 3 停；K3 给 3 条候选（核心思路 / 创新度 / 可解释性 / 难度 / 预计耗时 / 精度与鲁棒性），至少一项创新性高；支持换一批与选择；选择后阶段 3 过、阶段 4 进入。内容由内置方法族模板与关键词选出，**不冒充模型判断**。
- **事件契约**：新增 `phase` 事件（0–6 阶段、五态）与 `done.reason=waiting`；`interrupt` 复用既有 `{card,payload}` 形状，K2/K3 各一种卡。
- **通道端点**：`GET /sessions/latest`、`GET /sessions/{id}`、`POST /sessions/{id}/resume`（confirm / reroll / choose）；`POST /chats` 增加 `mode=workflow`，不传仍是 M2 的自由对话。
- **界面**：输入区加「建模 / 问答」切换；阶段轨道接真实状态；K2 确认卡、K3 三张并排候选（选它 / 解释 / 换一批）、K4 右栏解释抽屉；启动或 runtime 重启后从快照恢复最近会话；待决时建模发送禁用。
- **窗口尺寸**：分数缩放下 `useContentSize` 会抖动 1–2 DIP，`ready-to-show` 时再钉一次内容区 1440×900。
- **门禁**：G4 扩到 46 条（含跨进程恢复），事件判据自测 10 条；G7 扩到 42 条（K2→K3→解释→换一批→选择→阶段四，runtime 重启后 K3 仍在，M2 自由问答与工具卡保留）；G6b 下限 42、点名 10 条关键断言、自测 12 条。

### 变更

- 版本 `0.2.0 → 0.3.0`。
- 阶段轨道与输入区的阶段胶囊由 runtime 事件驱动，不再写死「阶段零」。
- 已选/已确认的决策卡保留在对话流里，但动作按钮禁用；「解释」仍可打开。

### 验证（本机 Windows，2026-10-30）

- `npm run gate` 全绿：G4 46/46、事件自测 10/10、G6b 自测 12/12、G7 42/42（内容尺寸 1440x900，非白像素 2.37%）。
- 真启动走通：K2 两问 → 确认 → K3 三候选 → 打开解释（待选仍在）→ runtime 重启后 K3 仍在 → 换一批（第 2 组）→ 选它 → 阶段 4 运行中；随后切到问答模式，`list_templates` 工具卡仍能完成。
- 跨进程持久化另由 G4 的 C13 用第二个服务器进程验证：换进程后 `/sessions/latest` 仍返回 K2 待决卡，并能继续确认。

### 验证（CI，run 40982728779）

- 三 job 全绿：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
- ubuntu 真启动 42/42，内容尺寸 1440x900，非白像素 3.15%；K2→K3→解释抽屉→runtime 重启后 K3 仍在→换一批→选择全部通过。
- Linux runner 无 Secret Service：`safeStorage 可用=false`、文件不存在、保存被明确拒绝；拒绝分支继续由 CI 覆盖。

### 尚未做

- **选模候选还不是模型生成的**：M3 只把状态机与决策界面做对；接真实模型、方法库检索与选型理由在 M4。
- K1 环境预检、K5 图表返工、K6 评分轮次还没有对应界面；`artifact` / `gate` 事件仍只有契约与转发。
- 真实 DeepSeek/Kimi 联网对话仍未跑（需要用户 Key）；Linux 桌面 Secret Service 可用分支仍未证。
- 便携 Python 与 `docs/env-setup.md` 英文版仍未做。

## 0.2.0 - 2026-10-20

M2 通道与壳。目标是「选一家 provider，在界面里流式对话并看到工具卡」——不接真实 Key 也能用离线演示跑通同一条链路。

### 新增

- **本机通道服务器** `runtime/cli.py serve --port 0`：stdout 只打印一行握手 JSON（`port` / `token` / 子进程 `pid` / `fake` / `version`），之后监听 `127.0.0.1`。Bearer 校验用 `hmac.compare_digest`，Host 与可选 Origin 只接受回环；请求体、消息条数与总长度都有上限。
- **SSE 事件契约** `schemas/chat-events.schema.json`：`token` / `reasoning` / `tool_call` / `artifact` / `interrupt` / `gate` / `error` / `done` 八类，事件 id 单调递增；支持 `Last-Event-ID` 续传；取消后必须收到 `done.reason=cancelled`。流结束时显式 `Connection: close`——上一版不关连接，客户端的读循环会永远等下一块数据。
- **provider 层** `runtime/src/mms/provider.py` + `providers.json`：DeepSeek、Kimi、自定义 OpenAI 兼容端点三个预设；流式解析 `content` 与 `reasoning_content`；分片 `tool_calls` 拼装；429/5xx 按 `Retry-After` 有界重试；回放历史时剥离 reasoning。自定义端点公网必须 https，http 只接受回环。
- **工具调用**：M2 只有只读的 `list_templates`。工具卡依次收到 running 与 ok/error，带上参数、结果与耗时；做完后把 assistant `tool_calls` 与 tool 消息写回历史。
- **G4/G5 自检** `runtime/selfcheck_channel.py`：32 条断言覆盖握手、鉴权、Host 白名单、事件 schema、id 单调、工具卡两态、续传、取消、未知 provider、缺 Key、公网 http、stdout 只有握手、stderr 无 Key、假 provider 开关、429 重试、reasoning 分离、分片工具拼装、历史剥离，以及 Key 只出现在 Authorization。`--selftest` 用 7 种坏事件证明判据本身会拒绝。
- **Electron 主进程**：拉起 Python 子进程并校验握手；15 秒超时、退出上报、重启；`safeStorage` 加密保存 Key（不可用时拒绝保存，不退回明文）；IPC 只暴露窄接口，runtime 端口与 token 不下发渲染层；把 SSE 帧转成 `chat:event`。
- **渲染层**：文字按 token 落进气泡；reasoning 收进默认折叠的「思考过程」；文字与工具卡按发生顺序排列；生成中显示静态光标与「停止」，结束后回到「发送」；设置页可选服务商/模型/自定义端点、保存或清除 Key，已保存的 Key 不回显。
- **G7 M2 端到端**：真启动生产入口，等 runtime 握手，打开设置页验证 Key 不回显，再写入一个哨兵 Key 并核对磁盘上只有 `safeStorage` 密文、没有明文（安全存储不可用的平台则必须明确拒绝且不落盘），最后发一句话，断言文字含模板总数、工具卡状态走到 ok、流结束后按钮复位；对话截图单独落盘 `screenshots/conversation.png`。G7 的 27 条断言在本机 Windows 上全过。
- **G6b 收紧**：断言下限抬到 27，并点名六条关键断言（runtime 就绪、中文真字形、工具卡完成、回复含模板总数、设置页打开、Key 落盘策略）；重复断言名也判失败。自测从 9 条扩到 11 条，新增「删掉关键断言再补满条数」与「detail 不再证明离线演示」两种坏结果。
- **CI**：gates job 增加 G4 正反两条；window-smoke job 增加 `setup-python`（通道只用标准库，不装 matplotlib）。
- **文档** `docs/providers.md`：预设与模型名、Key 的落盘位置与边界、自定义端点规则、离线演示开关、已验证/未验证清单、故障排查。

### 变更

- 发送按钮的 G7 判据从「按事实禁用」改为「runtime 就绪后可用」——M0/M1 没有子进程，禁用是对的；M2 起必须证明它真的能用。
- G7 在测试进程里设置 `MMS_FAKE_PROVIDER=1`，并把 Electron `userData` 指到临时目录：否则开发机上已保存的 provider 会改变默认选中项，测试结果不稳定。
- 版本 `0.1.0 → 0.2.0`。

### 修复

- **Windows CI 的 cp1252 崩溃**：`selfcheck_channel.py` 打印中文前没有重配 stdout，windows-latest 直接 `UnicodeEncodeError` 退出 1。入口现在与 `selfcheck.py` 一样把 stdout/stderr 重配成 UTF-8（`e9f0be1`）。

### 验证（本机 Windows，2026-10-20）

- `npm run gate` 全绿：G4 32/32、G5 反向 7/7、G6b 自测 11/11、G7 27/27（内容尺寸 1440x900，非白像素 2.90%，对话截图 4.49%）。
- 对话链路真跑过：用户消息 → reasoning → `list_templates` running/ok → 「共 25 个模板」正文 → done；按钮从「停止」回到「发送」。
- 设置页在离线演示下列出四个条目（含 DeepSeek/Kimi/自定义），切到 DeepSeek 时 Key 输入框为空且 placeholder 不含密钥样式字符串。
- 哨兵 Key 经 UI 保存后：`settings.json` 存在、含 `key` 密文字段、不含哨兵明文；随后切回离线演示，没有带着这个假 Key 发请求。安全存储不可用的分支写成了「明确拒绝且不落盘」，本机 Windows 只跑到可用分支；拒绝分支由 CI 的 Linux runner 覆盖（见下）。

### 验证（CI，run 40658227855）

- 三 job 全绿：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
- ubuntu 真启动冒烟 27/27，内容尺寸 1440x900，非白像素 3.02%；G7-5 中文墨量比 2.75，截图里中文是真字形。
- Linux runner 没有 Secret Service：`safeStorage 可用=false`、文件不存在、保存被明确拒绝——拒绝分支第一次由 CI 证据覆盖。
- 首轮 run `40657478165` 的 G4 在 Windows 上因 cp1252 崩溃；修复后本 run 才全绿。

### 尚未做

- **没有用真实 DeepSeek/Kimi Key 跑过联网对话**。本仓库不含 Key，CI 也不调真实服务；已验证的是 OpenAI 兼容协议与整条本机链路，不是两家服务的当下行为。
- `interrupt` / `gate` / `artifact` 事件已有契约与转发，但还没有对应的界面卡片；选模卡在 M3。
- 工具只有 `list_templates`；出图、论文等工具要到后续里程碑按需接。
- Windows CI 仍不真起窗；M2 的 Windows 证据来自本机。
- 便携 Python 与 `docs/env-setup.md` 英文版仍未做。

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

### 验证（CI 首轮，run 39398588127）

- ubuntu 与 windows 两个门禁 job 全绿：G1 8/8、G8 6/6 与反向 7/7、G2 9/9、G3 13/13（S10 在两个平台都真渲出 PNG/PDF/SVG）、G6 14/14。
- `真启动冒烟 · ubuntu` 15/15；G6b 独立核验通过，内容尺寸 1440x900，非白像素 2.79%。取回的截图与 M0 一致（M1 未改界面）。
- Windows job 仍只跑门禁，不起窗口；「Windows 上真起窗」依旧是未证项。

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
