# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
从 `0.1.0` 起，CLI 参数与退出码、注册表字段、产物路径为 Stable；`--json` 字段顺序与错误措辞仍为 Experimental。

## 0.1.0 - 2026-11-06

对话优先的工作台，DSH 作为可选内核。

### 新增

- **对话优先**：默认进入自由对话；输入区提供单个「全流程建模」按钮，按下才进入题面确认 → 选模 → 基线 → 论文的七阶段引导，再按一次退回对话。
- **上下文选模卡**：对话里问「该用什么模型」时，模型可调用 `suggest_models` 推送三张候选卡；点卡即作为一条消息继续对话，「换一批」同理。候选与全流程编排共用同一份方法库。
- **DSH 内核**：设置页新增「对话内核」（Python / DeepSeek Harness），切换后运行时重启并按选择注入 `MMS_CORE`；DSH 经本机 `dsh web` 的 HTTP + WebSocket 接入，事件仍映射为原有九类。
- **内核约束**：DSH 内核下「离线演示」标记为不可用并禁用发送，避免启动聊天后才报错。

### 变更

- 版本重新定为 `0.1.0`；此前的版本记录、Release 与 tag 已清理，后续按 [docs/release.md](docs/release.md) 记录。
- 会话恢复时会切回建模模式，避免待决卡在对话模式下点确认走错分支。
- 随包依赖新增 `deepseek-harness-sdk==0.2.1rc2`；NSIS 安装包体积约 311 MB（较无 DSH 构建净增约 46–59 MB）。

### 修复

- 打包后 `MMS_DSH_BIN` 指向不存在的 `resources/vendor/python/Scripts/dsh.exe`：改为在 vendor 与 resources 两处探测，存在才注入。
- DSH 自检在未安装 SDK 的系统解释器上误报 `dshVersion` 缺失：改为转发到随包 `vendor/python`。

### 验证（本机 Windows，2026-11-06）

- `npm run gate` 全绿：注册表、契约、G3 13/13、G4 55/55（含 C15 选模卡）、G11 13/13、G12 14/14、G13 10/10、G9 13/13、G10 10/10。
- G7 真启动 106/106（含 G7-11 内核切换与离线演示禁用）；内容尺寸 1440×900。
- DSH 内核自检 31/31；真实 packaged resources 负向验证 17/17。
- 未用真实服务商 Key 联网；0.1.0 安装包尚未构建，干净机安装仍是未证项。
