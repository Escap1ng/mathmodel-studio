# 发布规范

本文件规定 GitHub Release 的版本号、标题、正文与附件格式。以后每次发布按此执行，不再各自发挥。

## 版本号

- 使用 `X.Y.Z` 语义化版本，Git tag 为 `vX.Y.Z`（带 `v` 前缀）。
- 当前版本为 `0.1.0`。
- 版本号在四处同源，发布前必须一致：`VERSION`、`package.json`、`runtime/pyproject.toml`、`runtime/src/mms/__init__.py`。`npm run check:contracts` 的 C4 断言会拦截不一致。

## 标题

```
vX.Y.Z · 一句话主题
```

示例：`v0.1.0 · DSH 内核与对话优先工作台`。主题只写这一版最主要的变化，不堆功能清单。

## 正文结构

固定五节，按此顺序；某节没有内容就写「无」，不要删节。

```markdown
## 变更
- 面向用户可感知的新能力，一条一句，动词开头。

## 修复
- 修掉的缺陷，写清触发条件与修复后的行为。

## 升级注意
- 需要用户手动处理的事项（安装目录、配置迁移、旧会话兼容、内核切换等）。

## 校验
- 安装包：`mathmodel-studio-X.Y.Z-setup.exe`，<字节数> 字节（约 <MB> MB）
- SHA-256：`<hash>`
- 随包组件：Python <版本>、pandoc <版本>、deepseek-harness-sdk <版本>
- 门禁：`npm run gate` 通过；窗口冒烟 <N>/<N>；DSH 自检 <N>/<N>
- 签名：<有/无自签名证书及信任状态>

## 已知问题
- 未验证或已知缺陷，写清影响面。
```

## 附件

- 只附 `mathmodel-studio-X.Y.Z-setup.exe` 与对应的 `*.blockmap`。
- 不手工上传源码压缩包；GitHub 自动生成的 Source code 条目保持默认。
- 安装包必须从待发布 tag 对应的提交重新构建，不复用旧构建产物。

## 发布前检查清单

1. `VERSION`、`package.json`、`runtime/pyproject.toml`、`runtime/src/mms/__init__.py` 均为同一版本。
2. `CHANGELOG.md` 有无对应版本条目。
3. `npm run gate` 全绿；`npm run smoke:window` 全绿；`npm run check:channel:dsh` 全绿。
4. 工作区干净，tag 指向的提交与构建来源一致；构建后核对安装包内的 `VERSION`。
5. 在 Release 正文「校验」中写入安装包字节数、SHA-256 与构建来源提交。

## 发布操作

```bash
git tag vX.Y.Z <提交>
git push origin vX.Y.Z
gh release create vX.Y.Z \
  "release/mathmodel-studio-X.Y.Z-setup.exe" \
  "release/mathmodel-studio-X.Y.Z-setup.exe.blockmap" \
  --title "vX.Y.Z · 一句话主题" \
  --notes-file <正文文件>
```

移除旧版本时，release 与 tag 一起删：

```bash
gh release delete vX.Y.Z --yes --cleanup-tag
```
