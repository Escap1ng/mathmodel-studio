# 第三方组件与许可

本仓库与安装包包含以下第三方组件。各组件版权归其作者所有，许可条款以随附文本与上游链接为准。

## 本仓库许可

本仓库整体以 AGPL-3.0-only 发布，全文见 `LICENSE`；分发本软件或其修改版时，需按 AGPL-3.0 提供对应源码。`skills/` 下的技能文件原以 Apache-2.0 发布，作为整体分发作品的一部分保留原许可与版权声明，出处见 `skills/VENDOR.md`。

| 组件 | 用途 | 许可 | 来源 |
| --- | --- | --- | --- |
| Electron | 桌面运行时 | MIT | https://github.com/electron/electron |
| Chromium | Electron 渲染引擎 | BSD-3-Clause 等 | https://www.chromium.org |
| Node.js | Electron 内置运行时 | MIT | https://nodejs.org |
| React / ReactDOM | 渲染层 | MIT | https://github.com/facebook/react |
| pdfjs-dist | PDF 预览 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| Python（python-build-standalone） | 内置解释器 | PSF-2.0 | https://github.com/astral-sh/python-build-standalone |
| pandoc | Word 转换 | GPL-2.0-or-later | https://github.com/jgm/pandoc |
| matplotlib | 图表渲染 | Matplotlib License（PSF 派生） | https://github.com/matplotlib/matplotlib |
| numpy | 数值计算 | BSD-3-Clause | https://github.com/numpy/numpy |
| seaborn | 统计图样式 | BSD-3-Clause | https://github.com/mwaskom/seaborn |
| python-docx | DOCX 后处理 | MIT | https://github.com/python-openxml/python-docx |
| jsonschema | 契约校验 | MIT | https://github.com/python-jsonschema/jsonschema |
| PyMuPDF（fitz） | PDF 文本抽取 | AGPL-3.0 或 Artifex 商业许可（双许可） | https://github.com/pymupdf/PyMuPDF |

## 分发说明

- **Electron / Chromium**：完整许可文本随安装包提供，位于安装目录的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。
- **pandoc（GPL-2.0-or-later）**：安装包随附二进制，许可全文见 `licenses/pandoc-COPYING.md`，版权与贡献者信息见 `licenses/pandoc-COPYRIGHT`；对应源码可从上游仓库获取。GPL-2.0-or-later 与 AGPLv3 兼容，随 AGPL-3.0-only 作品分发时保留本许可文本与源码获取方式即可。
- **PyMuPDF（AGPL-3.0 / 商业许可）**：PyMuPDF 以 AGPL-3.0 或 Artifex 商业许可双许可发布。本仓库整体采用 AGPL-3.0-only，分发安装包时按 AGPL-3.0 提供对应源码（公开仓库与构建脚本即满足该义务）；如需在闭源或非 AGPL 条件下分发，应取得 Artifex 商业许可，或改用宽松许可的 PDF 实现。
