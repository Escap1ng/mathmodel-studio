# 第三方组件与许可

本仓库与安装包包含以下第三方组件。各组件版权归其作者所有，许可条款以随附文本与上游链接为准。

## 本仓库许可

本仓库整体以 AGPL-3.0-only 发布，全文见 `LICENSE`；分发本软件或其修改版时，需按 AGPL-3.0 提供对应源码。

| 组件 | 用途 | 许可 | 来源 |
| --- | --- | --- | --- |
| Electron | 桌面运行时 | MIT | https://github.com/electron/electron |
| Chromium | Electron 渲染引擎 | BSD-3-Clause 等 | https://www.chromium.org |
| Node.js | Electron 内置运行时 | MIT | https://nodejs.org |
| React / ReactDOM | 渲染层 | MIT | https://github.com/facebook/react |
| Python（python-build-standalone） | 内置解释器 | PSF-2.0 | https://github.com/astral-sh/python-build-standalone |
| pandoc | Word 转换 | GPL-2.0-or-later | https://github.com/jgm/pandoc |
| matplotlib | 图表渲染 | Matplotlib License（PSF 派生） | https://github.com/matplotlib/matplotlib |
| numpy | 数值计算 | BSD-3-Clause | https://github.com/numpy/numpy |

## 分发说明

- **Electron / Chromium**：完整许可文本随安装包提供，位于安装目录的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。
- **pandoc（GPL-2.0-or-later）**：安装包随附二进制，许可全文见 `licenses/pandoc-COPYING.md`，版权与贡献者信息见 `licenses/pandoc-COPYRIGHT`；对应源码可从上游仓库获取。GPL-2.0-or-later 与 AGPLv3 兼容，随 AGPL-3.0-only 作品分发时保留本许可文本与源码获取方式即可。
- **PDF 排版**：论文 PDF 由系统或随包安装的 xelatex 生成，不随包分发 TeX 发行版；使用环境需自行安装并遵守其许可。
