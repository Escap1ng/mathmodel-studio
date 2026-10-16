# 目录占位

本技能目录已由 [`skills/manifest.json`](../manifest.json) 登记，状态为 `planned`：清单、类型、职责、UI 契约都已进注册表并由 CI 把守，但技能内容（`SKILL.md`、`docs/`、`code/`、`templates/`、`themes/`）要到 **M1** 才从上游 vendor 进本仓库。

`check-registry.mjs` 对本目录有两条真实断言，都会让 CI 变红：

- `status: planned` 期间**不得**出现 `SKILL.md`——防止半 vendor 状态被当成已交付
- `status` 一旦改成 `vendored`，`entry` 指向的文件必须存在

M1 交付时本文件由 `VENDOR.md` 与真实 `SKILL.md` 取代。
