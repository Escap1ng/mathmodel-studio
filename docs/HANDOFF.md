# 交接 · M2 完成时的状态

给接手的人（或下一轮会话的我）。日期 2026-10-20。
提交数与文件数不要信我抄在这里的数字，跑 `git rev-list --count HEAD` 和 `git ls-files | wc -l` 自己取；HEAD 以 `git log -1` 为准。

## 0 一句话现状

M2 通道闭环：主进程拉起本机 Python 子进程，握手后经回环 HTTP + SSE 把 token、reasoning、工具卡事件转给渲染层；界面上选服务商、发一句话，文字逐块出现，`list_templates` 工具卡走到完成；Key 由主进程 `safeStorage` 加密，界面不回显。
**还不能建模**——选模卡、解释抽屉与真正的多步编排在 M3 以后。里程碑见 [../PLAN.md](../PLAN.md) §7。

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
node scripts/check-window-smoke.mjs --selftest  # 11/11 条核验自测                  → exit 0
python scripts/validate_contracts.py            # 9/9 项通过（jsonschema）         → exit 0
python runtime/selfcheck.py                     # 13/13 条 CLI 断言，含真渲一张图  → exit 0
python runtime/selfcheck_channel.py             # 32/32 条通道断言                → exit 0
python runtime/selfcheck_channel.py --selftest  # 7/7 条坏事件被拒                 → exit 0
```

`selfcheck.py` 会真的调 matplotlib 渲染 `paired-raincloud`（约十几秒），需要 `requirements.txt`；
`selfcheck_channel.py` 只起本机 Python 子进程与 127.0.0.1 上的假 OpenAI 端点，不需要 matplotlib、也不联网。

需要显示器的部分：

```bash
npm run smoke:window   # 真起窗口，27/27，写 screenshots/window-smoke.{png,json}、conversation.png、settings.png
npm run verify:window  # 独立读 JSON 并复算读数
```

`smoke:window` 自己设置 `MMS_FAKE_PROVIDER=1`，并把 Electron `userData` 指到临时目录，所以它不会用你已保存的真实 provider，也不会带着哨兵 Key 发请求。
跑完可以直接看 `screenshots/conversation.png` 和 `screenshots/settings.png`；断言通过不等于观感合格。

一把梭：`npm run gate`（顺序见 `package.json` 的 scripts；G7 不在 gate 里，因为它要显示器和 Electron 二进制）。

CI：<https://github.com/Escap1ng/mathmodel-studio/actions> —— 三 job：`门禁 · ubuntu-latest`、`门禁 · windows-latest`、`真启动冒烟 · ubuntu`。
M2 的 run `40658227855` 三 job 全绿；ubuntu 真启动 27/27、非白像素 3.02%。取回截图：

```bash
gh run download <run-id> -n window-smoke --dir screenshots-m2-ci
```

## 2 已证 / 未证（别混）

| 结论 | 证据来源 | 强度 |
| --- | --- | --- |
| 注册表、技能规范、契约与 CLI 仍自洽 | 本机 gate + CI 双平台（M1 起） | 强 |
| 本机通道：握手、Bearer、Host/Origin、SSE 契约、续传、取消 | `selfcheck_channel.py` 32/32（本机 Windows） | 强（本机） |
| OpenAI 兼容协议：429 退避、reasoning 分离、分片 tool_calls、历史剥离、Key 不外泄 | 同上的本地假端点，3 次真实 HTTP 请求 | 强（协议层，非真实厂商） |
| 界面端到端：流式文字、工具卡、设置页、按钮复位 | G7 27/27，本机 Windows 真启动 + 人看截图 | 强（本机 Windows） |
| Key 落盘：Windows 上只有 `safeStorage` 密文，无明文 | G7 写入哨兵 Key 后读 `settings.json`，只输出布尔值 | 强（Windows 可用分支） |
| 安全存储不可用时拒绝保存且不落盘 | CI run `40658227855` 的 Linux runner 无 Secret Service，G7 实得 `可用=false、文件存在=false、明确拒绝=true` | 强（拒绝分支）；Linux 桌面 Secret Service 可用分支仍未证 |
| 真实 DeepSeek / Kimi 联网对话 | 无 Key，未跑 | **未证** |
| Linux 上真起窗与整条 M2 链路 | CI run `40658227855`，27/27 + 独立核验（1440x900，非白像素 3.02%） | 强 |
| Windows CI 真起窗 | 无 | **未证**；M2 的 Windows 证据来自本机 |
| `interrupt` / `gate` / `artifact` 能渲染成卡片 | 只有契约与转发，没有 UI | **未证**（M3） |
| 工具不只 `list_templates` | 无 | **未证**；M2 只接了一个只读工具 |

## 3 待维护者定的项

1. **收尾时的仓库拓扑**（方向已定，待择时）：两仓独立 → kit 冻结 → studio 完工后把 studio 历史合并进 kit（`--allow-unrelated-histories`，保留两个来源的提交与 `VENDOR.md` 里的出处哈希）→ 先把现有私有 studio 仓改名腾位、再把 kit 改名为 `mathmodel-studio`。star 跟随被改名的 kit；`mathmodel-kit` 这个名字此后不要复用。**不要 force-push 覆盖**，否则技能出处哈希变成孤悬对象。
2. **排版引擎优先级**（M5）：xelatex（接上游现状）/ Typst / 双支持。
3. **provider 列表的维护方式**：现在三家写死在 `runtime/src/mms/providers.json`，界面允许手填模型名与自定义端点。是否要在 M3 前改成用户可增删的服务商列表，取决于你想把「选模型」做成多重的决策点。
4. **Key 的 Linux 兜底**：当前规则是安全存储不可用就拒绝保存，不退回明文。如果目标用户里有 Linux 桌面且没有 Secret Service，是保持拒绝、还是明确提示后允许「本次会话内存保存」，需要你拍板。

## 4 界面待判的观感问题（我只报，没改）

`screenshots/window-smoke.png`、`conversation.png`、`settings.png` 都是 1440×900、本机 Windows 下渲染。

M1 已报、仍未改：

- 左栏 240px 装不下「赛题分析与背景调研」，折行后第二行只挂一个「研」字，圆点与第二行基线错位。
- 阶段圆点是 `1.5px` 描边 `#DCE0E6`，在白底上很淡。
- 中栏空态文字贴顶，下方到输入框之间是 500px 量级的空区。
- 状态栏右侧三枚色块与「墨青」间距 5px 偏小。

M2 新增：

- 工具卡用的是 `--surface` 灰底（`#FAFAFA`），与白底只差一点；它在内容流里是否足够“像一张卡”，需要你看截图定。
- 模型条最长 300px，`自定义 OpenAI 兼容端点` 这类长名字会被省略号截断；要不要改成两行或只显示短名，属于视觉选择。
- 设置页的四个服务商是等宽胶囊，没有分组；离线演示排在第一位。是否把「离线演示」弱化成次要入口，避免被误当成正式选项，需要你定。
- 对话截图是在测试点了 B 案靛蓝之后拍的，所以按钮与强调线是靛蓝；默认仍是 A 墨青。

## 5 M2 做完的与仍欠的

已完成：

1. `runtime/cli.py serve` 与本机通道：握手 JSON、回环绑定、Bearer、Host/Origin、SSE 八类事件、`Last-Event-ID`、取消、15 秒心跳、`Connection: close`。
2. provider 层三个预设 + 自定义端点；流式解析、reasoning 分离、工具调用拼装、429/5xx 重试、历史剥离。
3. `list_templates` 工具卡：running / ok，参数、结果摘要、耗时；assistant `tool_calls` 与 tool 消息回写历史。
4. Electron 主进程：子进程生命周期、重启、状态广播、`safeStorage` 设置、IPC 窄接口、SSE 转发、取消兜底。
5. 渲染层：流式消息、思考折叠、工具卡、停止/发送、错误条、模型设置页、runtime 状态与重试。
6. G4 32 条、G5 反向 7 条、G6b 11 条、G7 27 条；CI 接入 G4 与 `setup-python`。
7. 文档：`docs/providers.md`、双语 README、CHANGELOG 0.2.0。

仍欠：

- 真实厂商连通性（需要你的 Key）。
- `interrupt` / `gate` / `artifact` 的界面；选模卡在 M3。
- 设置页的「清除 Key」只有实现，没有自动化覆盖；G7 只测了保存与不回显。
- `docs/env-setup.md` 英文版；便携 Python（M5/M6）。
- Windows CI 起窗；Linux 桌面 safeStorage。

## 6 这一轮踩过的坑（别再踩）

**SSE 流不会自己结束**：最开始 `done` 之后 HTTP/1.1 连接仍然保持，客户端的 `reader.read()` 永远等下一块，冒烟挂死。修法是响应头 `Connection: close` 且服务端 `self.close_connection = True`。**任何“事件流”都要定义终止条件，不能只发 done 事件。**

**事件比 `chat.start` 的返回值先到**：主进程收到第一块 SSE 时，渲染层可能还没拿到 `chatId`。现在按 `chatId` 先暂存、拿到 id 后按序补放；上限 500 条，避免旧流污染无限增长。改这段时先想清楚“没有 activeChat 时事件归谁”。

**G7 的假 provider 必须在 require 生产入口之前设环境变量**，否则主进程在 `whenReady` 拉起 Python 时继承不到。`userData` 也要在 ready 之前 `app.setPath` 到临时目录，否则你机器上已保存的 DeepSeek 会改变默认选中项，测试会莫名其妙地发向真实网络。G7 还显式把 provider 切回离线演示，切不回去就中止，绝不带着哨兵 Key 发请求。

**G6b 只数条数不够**：删掉一条关键断言、拿凑数的 `A` 行补齐，条数照样够。现在点名六条关键断言，并拒绝重复断言名。反向覆盖也补了这两种坏结果。

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
  server.py                 本机通道：握手、鉴权、SSE、会话与工具轮次
  provider.py               OpenAI 兼容流式客户端 + 离线假 provider
  providers.json            DeepSeek / Kimi / 自定义端点预设
  registry.py / invoke.py   技能注册表与 subprocess 调用
  cli.py                    serve / templates / invoke
runtime/cli.py              开发期入口（npm run mms）
runtime/selfcheck_channel.py G4/G5 自检与 7 条反向覆盖
src/main/
  index.ts                  窗口、IPC、provider 合并视图、SSE 转发
  channel.ts                Python 子进程生命周期、HTTP/SSE 客户端
  settings.ts               safeStorage 密文读写
src/preload/index.ts        window.studio 窄接口
src/shared/api.ts           主进程与渲染层共享的纯类型
src/renderer/src/
  App.tsx                   运行时状态、provider、对话事件归并
  components/ChatPane.tsx   流式消息、工具卡、输入区
  components/SettingsDialog.tsx  服务商/模型/Key 设置
  lib/chat.ts               事件折叠的纯函数
scripts/                    G1/G1 反向/G8/G8 反向/G6/G6b 与契约校验
tests/window-smoke.cjs      真启动断言（27 条）+ 截图与 JSON 结论
.github/workflows/ci.yml    gates（ubuntu+windows）与 window-smoke（ubuntu）
```

一处刻意的设计：`runtime` 只用 subprocess 调技能脚本、按退出码判定，不 import 技能内部函数——这样 `skills/` 仍可被 Claude Code 等宿主单独装载。改这条要先想清楚代价。
