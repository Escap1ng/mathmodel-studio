# Vendor 记录

本目录的技能内容来自 [`Escap1ng/mathmodel-kit`](https://github.com/Escap1ng/mathmodel-kit) **v2.0.1**（Apache-2.0），已在 M1 原样引入。

## 来源

| 项 | 值 |
|---|---|
| 上游仓库 | `Escap1ng/mathmodel-kit` |
| 版本 | `2.0.1` |
| tag 指向的 commit | `5ec0e464da0ae415d3db87cf53fb66eb6e2dff24` |
| 取得方式 | `gh api repos/Escap1ng/mathmodel-kit/tarball/v2.0.1` |
| 核对方式 | 逐文件 sha256 与上游 tarball 一致；目录内无本仓库新增文件 |

## 为什么要 vendor 而不是引用

桌面端要在本机双击即用，不能假设用户先装了另一个仓库。同时 `skills/` 必须保持**可被 Claude Code 等宿主直接使用**——复制哪一个技能，哪一个就能单独用——这是上游的承诺，不能被本仓库的 UI 元数据污染。

## 引入规则

1. **整个技能目录原样复制**（`SKILL.md`、`README.md`、`docs/`、`code/`、`themes/`、`examples/`），不改写条文；上游改动走显式的 re-sync 提交，每次在下面的表格加一行。
2. **目录层级与上游一致**，最深 3 层（例如 `code/templates/schema/`、`code/style/`）；不扁平化，也不额外加层。
3. `SKILL.md` 的 YAML frontmatter 保持 [Agent Skills 规范](https://agentskills.io/specification)合法（`name` 与目录同名、`description` 为触发语），由 `scripts/check-skills.mjs` 在 CI 把关，并带负向对照证明它会失败。
4. **runtime 只用 subprocess 调用技能脚本并按退出码判定**（`0 成功 / 1 校验或渲染失败 / 2 用法或环境错误`），不 `import` 技能内部函数。这样上游升级不会改动本仓库代码，技能也不因为被桌面端使用就必须服从桌面端的接口。
5. 本仓库新增的 UI 契约（`phases` / `artifacts` / `hitl`）只写在 `manifest.json` 里，**不写进 `SKILL.md`**，避免上游规范与宿主私有字段混在一处。

## re-sync 记录

| 本仓库版本 | 上游版本 | 上游 commit | 差异 |
|---|---|---|---|
| 0.1.0（M1） | 2.0.1 | `5ec0e464da0ae415d3db87cf53fb66eb6e2dff24` | 首次 vendor，无改动 |
