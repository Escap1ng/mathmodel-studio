# Vendor 记录

本目录的技能内容来自 [`Escap1ng/mathmodel-kit`](https://github.com/Escap1ng/mathmodel-kit) **v2.0.1**（Apache-2.0），在 **M1** 阶段 vendor 进来。M0 时这里只有占位目录与注册表。

## 为什么要 vendor 而不是引用

桌面端要在本机双击即用，不能假设用户先装了另一个仓库。同时 `skills/` 必须保持**可被 Claude Code 等宿主直接使用**——复制哪一个技能，哪一个就能单独用——这是上游的承诺，不能被本仓库的 UI 元数据污染。

## 引入规则

1. **内容原样复制**，不改写条文；上游改动走显式的 re-sync 提交，每次在下面的表格加一行。
2. 每个技能目录保留上游的 `SKILL.md` / `docs/` / `code/` / `templates/` / `themes/` 结构，**层级最深 2 层**（与上游一致）。
3. `SKILL.md` 的 YAML frontmatter 保持 [Agent Skills 规范](https://agentskills.io/specification)合法（`name` 与目录同名、`description` 为触发语），由 CI 的 `skills-ref validate` 或等价最小校验将 `status` 从 `planned` 改 `vendored` 时把关。
4. **runtime 只用 subprocess 调用技能脚本并按退出码判定**（`0 成功 / 1 校验或渲染失败 / 2 用法或环境错误`），不 `import` 技能内部函数。这样上游升级不会改动本仓库代码，技能也不因为被桌面端使用就必须服从桌面端的接口。
5. 本仓库新增的 UI 契约（`phases` / `artifacts` / `hitl`）只写在 `manifest.json` 里，**不写进 `SKILL.md`**，避免上游规范与宿主私有字段混在一处。

## re-sync 记录

| 本仓库版本 | 上游版本 | 上游 commit | 差异 |
|---|---|---|---|
| _待 M1_ | 2.0.1 | _待填_ | 首次 vendor，无改动 |
