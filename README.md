# MathModel Studio

桌面端数学建模工作台：输入赛题与数据，自动完成题面拆解、方法选择、求解代码生成与运行、论文排版。界面是一页三栏——赛题、进度、结果，没有多级工作台与人工确认卡。

## 工作流

1. **题面拆解**：模型把赛题拆成子问题；模型不可用时按小节切分。
2. **方法选择**：模型给出三条候选并标出推荐，直接采用推荐；失败时用内置方法族。
3. **生成代码**：按题面、所选方法与数据画像生成 `solution.py`，契约固定为 `--data` / `--out`，须写出 `result.json` 与 `figure.png/pdf/svg`。
4. **运行求解**：执行脚本；失败把 stderr 与上一版代码回喂模型，最多 3 轮。
5. **论文排版**：按真实 `result.json` 与求解图写 `paper.tex`，xelatex 编译 PDF、pandoc 转 Word；编译失败回喂修复，最多 3 轮。

所有论文数值只来自本次运行的 `result.json`。没有可用模型时进入离线模式：内置基线脚本 + 样例稿，事件与界面会标明兜底，不冒充按本题生成。

## 运行方式

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 桌面开发 | `npm install` → `npm run dev` | 启动 Electron 与本地 Python 运行时 |
| 无界面跑一遍 | `python core/cli.py run --problem-file 题面.txt [--data 数据.csv] [--out 目录]` | 事件按 JSON Lines 输出；默认离线模式 |
| 类型检查 | `npm run typecheck` | 主进程、preload、渲染层全覆盖 |
| 构建 | `npm run build` | 产物在 `desktop/out/` |
| 真启动冒烟 | `npm run smoke:window` | 起生产入口，断言窗口、运行时与界面文本 |
| 打包 | `npm run vendor:python`、`npm run vendor:pandoc` → `npm run dist:win` | 随包 Python 与 pandoc，输出 NSIS 安装包 |

## 环境要求

- Node.js 22 及以上。
- Python 3.12 及以上，并安装 `core/requirements.txt`（`numpy`、`matplotlib`）。
- 生成 PDF 需要本机 `xelatex`；转 Word 需要 `pandoc`。缺失时求解结果仍保留，论文步骤会明确报缺。
- 主平台为 Windows；macOS / Linux 可开发运行，未做安装包验证。

## 数据与隐私

- API Key 用系统安全存储（Electron `safeStorage`）加密保存，运行时按次传给本机进程；不落日志、不进事件、不写入运行目录。
- 每次运行的代码、结果、论文都在用户数据目录的 `runs/<时间戳>/` 下，界面提供「打开 PDF」「打开 Word」「结果文件夹」。
- 本地通道只绑定 `127.0.0.1`，每个请求校验随机 token 与 Host/Origin；主进程不把端口和 token 交给渲染层。
- 服务商地址默认 https；自定义端点若用 http，只接受回环地址。

## 配置服务商

设置弹窗内置 DeepSeek、通义千问、Kimi、智谱 GLM、OpenAI 格式端点与离线模式。预设模型与地址在 `core/src/mms/providers.json`，可自行增改。

- 真实服务商需要填写模型名与 API Key。
- 自定义端点填到 `/v1` 为止，公网必须 https。
- 离线模式不需要 Key，用于先跑通整条链路。

## 目录

根目录是 npm workspace，只做脚本转发；内核与桌面端各自独立。

```
.
├─ core/                       Python 内核（不依赖 GUI）
│  ├─ cli.py                   serve / run 入口
│  ├─ pyproject.toml
│  ├─ requirements.txt
│  └─ src/mms/
│     ├─ pipeline.py           一键流水线
│     ├─ provider.py           OpenAI 兼容流式客户端
│     ├─ llm.py                JSON / 文本调用与重试
│     ├─ baseline.py           数据画像、基线脚本、执行与产物收集
│     ├─ paper_gen.py / paper_build.py   论文生成与排版
│     ├─ server.py             本机 HTTP + SSE 通道
│     └─ templates/            论文骨架与写作规范
├─ desktop/                    Electron 桌面端
│  ├─ src/
│  │  ├─ main/                 通道、设置、文件选择、产物打开
│  │  ├─ preload/              窄 IPC 接口
│  │  ├─ renderer/             单页 React 界面（赛题 / 进度 / 结果）
│  │  └─ shared/               共享类型
│  ├─ tests/window-smoke.cjs   真启动冒烟
│  ├─ scripts/prepare-vendor.mjs   随包 Python / pandoc 准备
│  ├─ build/                   图标与安装向导图
│  ├─ electron.vite.config.ts
│  ├─ electron-builder.yml
│  ├─ package.json             桌面端依赖与脚本
│  └─ tsconfig*.json
├─ package.json                npm workspace 入口
├─ VERSION / LICENSE / THIRD_PARTY_NOTICES.md
└─ vendor/                     随包 Python / pandoc（本机生成，不入库）
```

## 许可

AGPL-3.0-only。第三方组件与分发说明见 `THIRD_PARTY_NOTICES.md`。
