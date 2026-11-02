# DSH P0 探针结果

日期：2026-11-02
范围：只回答 P0 的 8 个生死门问题；探针全部在 `%TEMP%\mms-dsh-probe` 完成，不改仓库运行时。
结论：**P0 通过**。DSH 能作为唯一内核，走 Web API + WebSocket 适配层；Python SDK 与 headless 不能提供实时增量，不作为适配路径。

## 1. 版本与产物体积

| 项 | 值 |
|---|---|
| `dsh --version` | `0.2.1-rc.2` |
| `deepseek-harness-sdk` | `0.2.1rc2` |
| `deepseek-harness-runtime-bin` | `0.2.1rc2` |
| 探针 Python | `3.12.16 (MSC v.1944 64 bit)` |
| 运行时 wheel | `deepseek_harness_runtime_bin-0.2.1rc2-py3-none-win_amd64.whl` |
| 运行时 wheel 大小 | `83,860,784` 字节（79.98 MiB） |
| 运行时 wheel sha256 | `d38c18f5117859feedaaa791a0eea37b8644bc187118e7e6f3afa231a5381cb7` |
| SDK wheel | `deepseek_harness_sdk-0.2.1rc2-py3-none-any.whl` |
| SDK wheel 大小 | `18,112` 字节 |
| SDK wheel sha256 | `30fc72c67f20ff4b46c6952087ea596fc70c2692001aa372185a24f9866bdc46` |
| 解包安装后目录 | `266 MiB`（`deepseek_harness_runtime/runtime`，含 273,157,120 字节的 `dsh` 运行时 exe） |
| 7z `-mx=9` 压缩后 | `52,556,971` 字节（50.12 MiB） |
| 0.6.1 安装包既有读数 | `264.7 MB` |
| 预计 0.6.1 + DSH 安装包 | `约 315–350 MB`，增量低于 150 MB 红线 |

安装包增量按 7z 最高压缩估算；NSIS 的 LZMA solid 与 7z 接近，实际值在 P5 打包时复核。运行时 wheel 下载走清华镜像，直连 PyPI 约 KB/s。

## 2. 关键结论（8 问）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 能否实时拿到增量 | **能，但只在 Web API**。`session/follow` + `assistantStream: true` 按模型 SSE 节奏推送 `reasoning-delta` / `text-delta` / `tool-call-delta`。Python SDK 的 `on_notification` 与 `headless --json` 只给 turn 结束后的持久事件。 | 假模型每 0.7s 一段，follow 在 1.844 / 2.547 / 3.250 / 3.953s 收到四段；SDK 探针在 t=3.015 才一次给出全文 |
| 2 | 取消路径 | **有**。HTTP `POST /api/session/cancel`，`sessionId` 即会话；返回 `accepted: true`，同一 follow 流立即收到 `turn/end {kind:"aborted", reason:{kind:"user"}}`。实测 15ms。 | 见第 4 节 |
| 3 | 能否不挂 shell / 编辑器 | **能**。自定义 preset 只挂 `tool-fs(read/readImage)`、`tool-fs-search`、`tool-skill`、`compaction-basic`；首轮 `request/header.tools` 只有 `glob/grep/read/read_image/skill/working_directory`，外加 MCP 工具。`sandbox-policy.mode=read-only`。 | 见第 5 节 |
| 4 | 自定义工具怎么挂最稳 | **stdio MCP 最稳**。preset 直接加 `@deepseek-ai/dsh-mcp-client`，`transport: stdio`，无需 Node/pnpm 构建。工具以 `mcp__<serverName>__<tool>` 暴露。自定义 JS 插件仍可作为备选，但要多维护一份构建产物。 | `mcp__mms__list_templates` 调用成功，`total == 25` |
| 5 | 能否发现现有技能 | **能，原样复用**。`skill-filesystem.customSkillDirs` 指向仓库 `skills/` 根目录；目录式技能（`<name>/SKILL.md`）被识别，目录注入 `<available_skills>` 作为 user 消息，`skill` 工具返回 `<skill_content>`。现有 `SKILL.md` 的 `allowed-tools` 不报错。 | 7 个 mathmodel 技能全部出现在目录；`mathmodel-core` 加载成功，正文完整返回 |
| 6 | 子代理事件会不会破坏根会话 | **不会**。根 follow 流出现 `subagent/catalog` 与 `tool/call`/`tool/result`；子代理的 durable `assistant/message` 也会出现在流里，但子代理的 token 增量**不**混入根 `assistant-stream`。适配层忽略 `subagent/*` 与非根 `assistant/message` 即可。 | 根 turn 正常 `completed`；子代理输出只在 durable 消息里 |
| 7 | 体积 | 见第 1 节。压缩后约 52.6 MB，低于 150 MB 红线。 |  |
| 8 | `DSH_HOME` 隔离 | **完全隔离**。运行前后 `~/.dsh` 的 mtime 不变；隔离 home 内生成 `.anonymous-user-id`、`.credentials.yaml`、`sessions/`、`storages/`、`profiles/`。`sk-test-SENTINEL-DO-NOT-LEAK` 未写入任何探针 home。 | `~/.dsh` mtime `1793592773624681400` 前后相同；`grep -rl` 哨兵为空 |

## 3. 适配层协议（已实测）

启动：

```bash
dsh --profile web --patch <patch.yml> --no-open --port 0
```

- `--patch` 是 launcher 参数，必须放在 `web` 之前。
- stdout 打印 `http://127.0.0.1:<port>/?token=<token>`。
- 用该 URL 建 cookie，后续 REST 与 WebSocket 都带 `Cookie` 与 `Origin`。

REST（POST `/api/<endpoint>`）：

```json
{"type":"client-request","rpcId":"<uuid>","method":"session/create","payload":{"args":{"request":{"cwd":"...","sessionId":"...","agentPreset":"mms"}}}}
{"type":"client-request","rpcId":"<uuid>","method":"session/prompt","payload":{"args":{"request":{"requestId":"<uuid>","sessionId":"...","mode":"queue","content":[{"type":"text","text":"..."}],"clientTimeZone":"Asia/Shanghai"}}}}
{"type":"client-request","rpcId":"<uuid>","method":"session/cancel","payload":{"args":{"request":{"sessionId":"..."}}}}
```

WebSocket：`ws://127.0.0.1:<port>/api/remote.mux`，先发 open：

```json
{"type":"open","streamId":"<uuid>","endpoint":"session/follow","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"..."},"assistantStream":true}}}}
```

服务端帧：

```json
{"type":"item","streamId":"...","value":{"type":"assistant-stream","frame":{"type":"chunk","attemptId":"<sid>:1","revision":5,"index":3,"chunk":{"type":"text-delta","index":1,"text":"第一段"}}}}
{"type":"item","streamId":"...","value":{"type":"assistant-stream","frame":{"type":"chunk","chunk":{"type":"reasoning-delta","index":0,"text":"先想一下。"}}}}
{"type":"item","streamId":"...","value":{"type":"assistant-stream","frame":{"type":"chunk","chunk":{"type":"tool-call-delta",...}}}}
{"type":"item","streamId":"...","value":{"type":"assistant-stream","frame":{"type":"end","outcome":{"kind":"committed","eventType":"assistant/message","seq":16}}}}
```

持久事件通过同一条 follow 流以 `value.event` 到达：`turn/start|end`、`step/start|end`、`tool/call`、`tool/result`、`assistant/message`、`subagent/catalog`、`session/title` 等。

## 4. 取消原始输出

```text
3.375 text-delta 慢速片段0
cancel_rpc_at 3.39 result {"type":"server-response","result":{"ok":true,"value":{"accepted":true}}}
3.39 cancel turn/end {"turn":1,"reason":{"kind":"aborted","reason":{"kind":"user"}}}
cancel_latency_s 0.015
```

取消前同一会话正常完成过一轮工具调用；取消后 15ms 内 `turn/end aborted`，follow 流随后 `end`。不需要关闭 harness。

## 5. 工具与技能原始输出

首轮工具表：

```text
['glob','grep','read','read_image','skill','working_directory']
```

加 MCP 后：

```text
['glob','grep','list_mcp_resource_templates','list_mcp_resources','mcp__mms__list_templates','read','read_image','read_mcp_resource','skill','working_directory']
```

MCP 调用：

```text
tool/call {"name":"mcp__mms__list_templates","arguments":"{}"}
tool/result {"content":[{"type":"text","text":"{\"ok\": true, \"total\": 25, ...}"}]}
```

技能目录（摘要）：

```text
<available_skills>
- `mathmodel-core`: 数学建模竞赛全流程主技能：...
- `mathmodel-deai`: 降 AI 模块：...
...
</available_skills>
```

技能加载：

```text
tool/call {"name":"skill","arguments":"{\"name\":\"mathmodel-core\"}"}
tool/result <skill_content name="mathmodel-core"> ... Base directory ... D:\000GH more\math-help\skills\mathmodel-core ...
```

## 6. 实时流原始时间线

假模型每 0.7s 发一段，DSH follow 流：

```text
1.844 reasoning-delta 先想一下。
2.547 text-delta 第一段
3.250 text-delta 第二段
3.953 text-delta 第三段
5.344 block-end reasoning 先想一下。
5.359 block-end text 第一段第二段第三段
5.359 usage / finish / end
```

`block-end` 在流结束后才到，`text-delta` 是实时的；适配层只消费 delta，不用等 block-end。

## 7. 子代理事件面

```text
event_types {'snapshot':1,'agent/inbox/spliced':2,'turn/start':1,'step/start':2,'system/message':1,'user/message':2,'request/header':1,'request/context':1,'assistant-stream':14,'session/title':1,'assistant/message':2,'tool/call':1,'subagent/catalog':1,'tool/result':1,'step/end':2,'turn/end':1}
```

根 `assistant-stream` 只包含根会话的两个 attempt（`:1` 工具调用、`:2` 最终文本）；子代理内容以 durable `assistant/message` 出现。

## 8. 安全与隔离

- 自定义 preset 无 shell、无 `str_replace_editor`；`sandbox-policy.mode=read-only`。
- `DSH_HOME` 指向探针目录；`~/.dsh` mtime 运行前后一致。
- 假模型密钥 `sk-test-SENTINEL-DO-NOT-LEAK` 只从环境变量 `MMS_PROBE_KEY` 注入；所有探针 home 中 `grep -rl` 无命中。
- 隔离 home 会写 `.credentials.yaml`（会话/客户端凭据），因此产品必须把 `MMS_DSH_HOME` 放在应用 dataDir，不要写用户全局 `~/.dsh`。

## 9. 已知非致命噪音

`dsh web` 启动时 stderr 有两条可选包缺失：

```text
workspace-controller (@deepseek-ai/dsh-api-workspace-controller): failed to import: Cannot find package '@deepseek-ai/dsh-host-directory-picker'
office-to-pdf (@deepseek-ai/dsh-office-to-pdf): failed to import: Cannot find package '@deepseek-ai/libreoffice-kit'
```

不影响 `session/create` / `prompt` / `follow` / `cancel`。产品侧应捕获 stderr，不要把这两条当启动失败。

## 10. 复现

全部脚本在 `%TEMP%\mms-dsh-probe\`：

| 脚本 | 用途 |
|---|---|
| `probe_web_follow.py` | Web API 实时流 |
| `probe_cancel_skill.py` | 技能发现/加载 + 取消 |
| `probe_mcp_tool.py` + `mcp_mms.py` | stdio MCP 工具 |
| `probe_subagent.py` | 子代理事件面 |
| `probe_stream.py` / `probe_headless.py` | SDK / headless 无实时增量的对照 |

运行环境：`venv312`（Python 3.12.16），`pip install deepseek-harness-sdk==0.2.1rc2`。

## 11. 对计划的影响

1. **适配层改用 Web API + WebSocket**，不依赖 Python SDK 的 `on_notification`。SDK 仍可用于版本/环境检查，但不承担流式。
2. 事件映射从 `assistant/message.stream[]` 改为 `assistant-stream` 的 `reasoning-delta` / `text-delta` / `tool-call-delta`；`tool/call`、`tool/result` 继续用持久事件。
3. 取消直接调 `session/cancel`，不需要“关闭 harness 后重建”。
4. P2 工具走 stdio MCP，不提交 JS 插件构建产物；profile 只增加一个 `mcp-client` 实例。
5. 产品 profile 要设 `includeDefaultRoots: false`，避免把 DSH 自带的 `diagnose-windows-sandbox-acl` 等开发技能和 `~/.agents/skills` 注入数学建模会话；只保留 `customSkillDirs`（仓库 `skills/`）。若确实需要 DSH 自带技能，再显式设 `bundledSkillDir`。
