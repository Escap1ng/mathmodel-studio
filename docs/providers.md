# 模型接入与 Key 存储

M2 起，桌面端可以把对话交给一个 OpenAI 兼容的流式端点。本文写清三件事：怎么配、Key 存在哪、哪些结论还没有被验证。

## 1 内置的三个预设

单一事实源是 [`runtime/src/mms/providers.json`](../runtime/src/mms/providers.json)；界面只是把这份清单渲染成设置页。

| id | 显示名 | Base URL | 预设模型 | 工具调用 |
| --- | --- | --- | --- | --- |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`、`deepseek-reasoner` | 支持；默认用 `deepseek-chat` |
| `kimi` | Kimi | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview`、`moonshot-v1-8k` | 支持 |
| `custom` | 自定义 OpenAI 兼容端点 | 空，需自己填 | 空，需自己填 | 取决于端点 |

模型名是**预设**，不是白名单：设置页的模型输入框允许手填。开放平台改名后不必等本仓库发版。

## 2 在界面里配置

1. 起窗口（`npm run dev`），点输入框左下角的模型条，打开「模型与服务商」。
2. 选服务商，确认模型名；自定义端点还要填 Base URL。
3. 粘贴 API Key，保存。已保存的 Key 不会再显示，输入框留空表示「不修改」，只能覆盖或清除。
4. 保存后模型条立即变成「服务商 · 模型名」，发送按钮随即可用。

Key 不会经渲染层回读。设置页只能看到「已保存」标记，拿不到明文，也没有「显示 Key」按钮。

## 3 Key 存在哪、边界在哪

- 磁盘位置：Electron 的 `userData/settings.json`（Windows 通常是 `%APPDATA%\mathmodel-studio\settings.json`，macOS 与 Linux 按 Electron 的默认规则）。
- 文件里只有 `safeStorage.encryptString(key)` 的 base64 密文；渲染层拿到的是 `configured: true/false`，不是 Key。
- **系统安全存储不可用时拒绝保存**，不会退回明文。Linux 上这通常意味着没有可用的 Secret Service（gnome-keyring / KWallet 等）；无头环境与部分 CI 容器属于这一类。
- 文件以 `0600` 写入。它保护的是「同机其他用户」，不是「拿到你账户的人」——这与所有桌面端 BYOK 的边界相同。
- 运行时只在下一次 `chat:start` 时由主进程解密并放进 HTTP `Authorization: Bearer` 头。Key 不进渲染层、不进事件流、不进 stderr；G4/G5 自检用一个 Key 哨兵扫描了这三处。

## 4 自定义端点的规则

- 公网地址必须是 `https`；`http` 只接受 `127.0.0.1`、`localhost`、`::1`。这条在运行时校验，不只在界面提示。
- Base URL 填到 `/v1` 为止，运行时自己拼 `/chat/completions`。
- 端点需要兼容 OpenAI 的 **流式 chat completions**：`data:` 帧、增量 `content`、可选 `reasoning_content`、可选分片 `tool_calls`。不支持流式工具调用也能聊天，只是不会出现工具卡。
- 429 与 5xx 会按 `Retry-After` 做有界重试（最多 3 次）；401/403 直接把错误文本交给对话流，不重试。

## 5 离线演示（不需要 Key）

设置 `MMS_FAKE_PROVIDER=1` 后，runtime 会在服务商列表最前面插入一个「离线演示（不联网）」条目，不读 Key、不发任何网络请求。它的内容是写死的：先给一段 reasoning，发一个 `list_templates` 工具调用，再根据 25 个模板总结一句。用于验证通道、流式渲染与工具卡。

```bash
# Git Bash / macOS / Linux
MMS_FAKE_PROVIDER=1 npm run dev
```

```powershell
# PowerShell
$env:MMS_FAKE_PROVIDER='1'; npm run dev
```

可选 `MMS_FAKE_DELAY_MS`（默认 20）控制每块文本之间的间隔，用来观察流式效果；它只影响假 provider。

G7 真启动冒烟会在自己的进程里打开这个开关，并把 `userData` 指到临时目录，避免你本机已保存的 provider 改变默认选中项。因此 **G7 跑的是离线演示，不是真实模型**。

## 6 已验证与未验证

已验证（本机 + 自检脚本）：

- 握手、Bearer 鉴权、回环 Host/Origin 白名单、SSE 续传与取消（G4，32 条）。
- OpenAI 兼容协议本身：429 退避、`reasoning_content` 与正文分离、分片 `tool_calls` 拼装、历史剥离 reasoning、Key 只出现在 Authorization（G5，用本地假端点，不联网）。
- 界面端到端：设置页打开/关闭、不回显 Key、哨兵 Key 经 UI 保存后磁盘上只有密文（G7 共 42 条，本机 Windows 真启动；M2 的 27 条同组已由 CI 的 ubuntu 跑过）。
- 离线 provider 的文字真的流进气泡，`list_templates` 工具卡从 running 走到 ok，结束后按钮回到「发送」（G7 同一轮）。
- 安全存储不可用时明确拒绝且不落盘：CI run `40982728779`（M3）的 Linux runner 没有 Secret Service，G7 实得 `可用=false、文件存在=false、明确拒绝=true`。

**未验证**：

- 真实 DeepSeek / Kimi 的联网对话。本仓库不内置任何 Key，CI 也不调用真实服务；这条只能由你填自己的 Key 验证。
- 自定义端点的兼容性差异（有的实现不发 `reasoning_content`，有的分片 `tool_calls` 字段不全）。这些情况会以错误文本呈现，但尚未逐个建 fixture。
- Linux 桌面上 Secret Service 可用时的加密保存；CI 只跑到不可用分支，桌面分支没有环境可验。

## 7 故障排查

| 现象 | 先查什么 |
| --- | --- |
| 状态栏「runtime 未连接」 | 终端里能否 `python --version`（Linux/macOS 为 `python3`）；不能就用 `MMS_PYTHON` 指向解释器。点状态栏「重试」会重启子进程。 |
| 发送按钮一直灰 | 该服务商未配置 Key，或自定义端点没填 Base URL；设置页有「已保存」标记才表示 Key 在。 |
| 保存 Key 报「系统安全存储不可用」 | 当前系统没有可用的加密后端；本仓库不会以明文降级保存。 |
| 429 / 5xx | 运行时已自动重试 3 次；仍失败时错误会出现在对话里。 |
| 工具卡不出现 | 端点没有返回 `tool_calls`，或该端点不支持工具调用。M2 只有一个只读工具 `list_templates`。 |
