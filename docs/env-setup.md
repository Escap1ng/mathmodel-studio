# 环境准备手册

这份文档只做一件事：把**需要联网的动作**写清楚，让它在你的机器上可重复。
本项目不会自动替你下载或安装任何东西——缺件时程序只报出该装什么、怎么装。

实测数据来自 2026-10-16 一台 Windows 10 (26100) / x64 机器，命令与返回一并写出来，方便你判断是不是同一个症状。

## 1 先看通道，再看版本

网络通道会翻转，**任何一条失败先换通道重试再下结论**：

| 目标 | 命令 | 实测结果 | 结论 |
| --- | --- | --- | --- |
| npm 官方源 | `npm view electron version` | 25 s 超时无输出 | 大陆直连不可用，走镜像 |
| npmmirror | `curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://registry.npmmirror.com/electron` | `200 1.37s` | 可用，作为默认 |
| Electron 二进制镜像 | `curl -sI https://npmmirror.com/mirrors/electron/v33.2.0/electron-v33.2.0-win32-x64.zip` | `HTTP/1.1 302` | 可用 |
| github.com | `curl -s -o /dev/null -w "%{http_code}" https://github.com/...` | 超时 | git clone / release 下载不稳 |
| api.github.com | `gh api repos/Escap1ng/mathmodel-kit --jq .full_name` | 正常返回 | **api 通道 ≠ git 通道**，能 `gh api` 不代表能 `git push` |
| TUNA pypi | `curl -s -o /dev/null -w "%{http_code}" https://pypi.tuna.tsinghua.edu.cn/simple/` | 20 s 超时（本轮） | 镜像本身也会挂，别当成配置错了 |

两个判读陷阱，都是踩过才知道的：

- **别把慢当死锁**。`npm install` / `uv sync` 卡住时，如果你加了 `| tail`、`| grep` 之类的管道，输出被全缓冲，看起来像挂了，其实是 KB/s 级慢。先摘掉管道再看。
- **管道之后的 `$?` 是管道的退出码**，不是被测命令的。要判死活就 `cmd; echo "exit=$?"` 或者 `set -o pipefail`。

## 2 镜像配置

仓库里的 [`.npmrc`](../.npmrc) 已经钉了 Electron 与 electron-builder 的二进制镜像，`npm install` 会直接生效：

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

**信任边界说明**：这两行把下载通道从官方 CDN 换成了第三方镜像。包内容与校验值一致，但通道不同——不在大陆的开发者请删掉这两行。

如果你的 `npm` 源本身也慢，再加一行 registry（这一行没进仓库，因为它会改变所有依赖的解析来源，CI 用官方源更合适）：

```ini
registry=https://registry.npmmirror.com/
```

临时用一次，不想改文件：

```bash
npm install --registry=https://registry.npmmirror.com/
```

## 3 版本怎么来的（别照抄数字）

`package.json` 里每个 JS 依赖的版本都是这么查出来的，不是猜的，也不是从旧文档抄的：

```bash
curl -s https://registry.npmmirror.com/electron | python -c "import sys,json;print(json.load(sys.stdin)['dist-tags'])"
```

`dist-tags.latest` 的实测值（2026-10-16）：`electron 44.8.0`、`vite 8.3.4`、`electron-vite 6.0.0`、
`react 19.3.1`、`typescript 7.0.2`、`@vitejs/plugin-react 6.1.2`。

兼容性由 peer 依赖核对，不靠印象：`electron-vite` 6.0.0 对 `vite` 的要求是 `^6 || ^7 || ^8`，
所以配 Vite 8 是上游支持组合，不是我们运气好。

## 4 Python

G1 与 CLI 的注册表部分**只用标准库**；M1 起 `runtime/selfcheck.py` 会真渲染一张图，需要科学计算依赖。
版本下限统一写在仓库根的 `requirements.txt`（与上游技能 v2.0.1 一致），安装走镜像：

```bash
python -m pip install -r requirements.txt -i https://registry.npmmirror.com/pypi/simple/
```

M2 起桌面端会自己拉起 `python runtime/cli.py serve`（Linux/macOS 用 `python3`），所以起窗口要求 Python 在 `PATH` 上；
不在就用 `MMS_PYTHON` 指向解释器。通道服务器、SSE 与 provider 客户端只用标准库，不需要额外的 pip 包。
没有 API Key 时用 `MMS_FAKE_PROVIDER=1` 走离线演示，细节见 [providers.md](providers.md)。

`jsonschema` 也在其中；缺它时契约校验仍会降级并在输出里说明，但 CI 必须装齐。TUNA 镜像在本机实测会超时，
npmmirror 可用——镜像本身也会挂，超时不等于配置错了。

**为什么运行时钉 3.12 而不是本机已有的 3.14**：M5 要随包分发一个可安装 matplotlib / seaborn / PyMuPDF 的解释器，
科学计算 wheel 在 3.12 这一档覆盖面最全。参考实现是 Cherry Studio 的
`src/main/services/binaryManager/pythonRuntime.ts`——它钉 `3.12.13`，
便携解释器走 `https://registry.npmmirror.com/-/binary/python-build-standalone`，
并在注释里明确「绝不收养系统解释器，只认自己的安装目录」。我们照这套做法，理由相同：可复现优先于少下载。

## 5 系统级依赖（程序不会替你装）

| 依赖 | 用途 | 检测命令 | 本机实测 | 缺件时 |
| --- | --- | --- | --- | --- |
| Node.js | 桌面壳 | `node -v` | v24.18.1 | 装 LTS |
| xelatex | 论文排版（M5） | `xelatex --version` | MiKTeX-XeTeX 4.16（MiKTeX 25.12） | 装 TeX Live 或 MiKTeX，系统级安装，pip 装不上；可用 `MMS_XELATEX` 指定路径 |
| pandoc | LaTeX→Word，公式转 OMML | `pandoc --version` | pandoc 3.13，`%LOCALAPPDATA%\mms-tools\pandoc.exe`（2026-10-30） | Windows：官方 zip 解出 `pandoc.exe`（`winget install --id JohnMacFarlane.Pandoc` 也可） |
| 中文字体 | CJK 排版与出图 | 见下 | 未单独核对 | `xeCJK` 需要 SimHei/SimSun 在场；matplotlib 缺字体会画成方框，上游 `plot_style.pick_cjk_font` 有回退 |
| Electron 链接器 | 若改用 Tauri 才需要 | `where link.exe` + `link --version` | 命中的是 GNU coreutils 8.32，**不是 MSVC 链接器**；无 Visual Studio、无 `Windows Kits\10\Lib` | 本仓库选 Electron 正是因为这里没有可用链接器 |

最后一条值得记住：`where link.exe` 有结果**不代表有链接器**。用它找工具链组件时，一律再跑一次 `--version` 认身份。

**pandoc 的查找顺序**：`PATH` → `MMS_PANDOC` → `%LOCALAPPDATA%\mms-tools\pandoc.exe`。三处都没有时论文页列出缺件并禁用构建按钮，G10 退出 1；只有显式 `MMS_PAPER_SKIP=1` 才跳过，且会打印「未验证 G10」。

本机 2026-10-30 的装法（github.com:443 被挡、api 通道可用）：

```bash
gh release download 3.13 --repo jgm/pandoc --pattern "pandoc-3.13-windows-x86_64.zip" --dir /tmp/pandoc
unzip /tmp/pandoc/pandoc-3.13-windows-x86_64.zip
mkdir -p "$LOCALAPPDATA/mms-tools"
cp /tmp/pandoc/pandoc-3.13/pandoc.exe "$LOCALAPPDATA/mms-tools/pandoc.exe"
"$LOCALAPPDATA/mms-tools/pandoc.exe" --version
```

单文件 exe 约 239 MB，是静态链接的完整包；仓库不收录它，也不在运行时自动下载。

TeX 侧需要的是 xelatex 与中文支持（ctex/xeCJK）。Linux CI 用 apt：

```bash
sudo apt-get install -y pandoc texlive-xetex texlive-lang-chinese texlive-latex-extra
```

Windows 上装 MiKTeX 后 `xelatex` 进入 PATH 即可，本机没有再设置 `MMS_XELATEX`。

## 6 写脚本时的 Windows 坑

- **PowerShell 5.1 按 GBK 解 `.ps1`**：含中文的安装/启动脚本会报语法错或静默吞语句。要么脚本全 ASCII，要么带 UTF-8 BOM。上游 metamath-harness 就因为漏了 BOM 导致旧终端下装机必炸。
- **Python 在 GBK 控制台 print 中文会抛 `UnicodeEncodeError`**：本机是 GBK，Windows CI 的 stdout 更窄（cp1252）。`mms` CLI 与两个自检脚本都在入口把 stdout/stderr 重配成 UTF-8；你自己的脚本也要照做，否则本机乱码、CI 直接崩。
- **别按进程名杀进程**（`taskkill /IM`），按 PID 杀；Git Bash 会把 `/PID` 当路径吃掉，需要 `MSYS_NO_PATHCONV=1`。

## 7 装完之后

```bash
npm run gate
```

全绿即脚手架自洽。其中只有 `typecheck`、`build`、`smoke:dist` 需要 `npm install` 成功；
`check:registry`、`check:registry:negative`、`check:contracts`、`check:channel` 只吃标准库（契约校验缺 `jsonschema` 时降级）；
`check:cli` 与 `check:workbench` 需要 `requirements.txt` 里的科学计算包；`check:paper` 还需要 xelatex 与 pandoc。这是刻意设计，方便你在任何机器上验证注册表与通道没漂。

想看界面就两条路：`npm run dev` 起开发窗口；或先 `npm run build` 再 `npm run smoke:window`，
它会 `require` 生产入口真起一次窗口、拉起 Python 通道、用离线 provider 走完 K2→K3→解释→换一批→选择，再重启 runtime 确认待选卡还在；接着真渲一张图、换主题重渲、并排 diff、回滚，再看评分五维/扣分定位/熔断与一票否决（53 条），
截图写到 `screenshots/`（`decision.png`、`drawer.png` 是 M3 新增，`figure.png`、`score.png` 是 M4）。本机有显示器，不需要 xvfb；CI 那条 job 才需要，并且要先修好 Electron 的 SUID 沙箱助手（见 `ci.yml` 的注释）。
会话状态默认写在 Electron `userData/sessions.db`，图表版本在 `userData/workbench/figure/`（开发期可用 `MMS_DATA_DIR` 指到别处），都不存 Key。
