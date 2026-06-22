# POL-32 Review Round 1 修复报告

## Issue 1 [major/bug] — 假用量数据误导用户
- 处理结果：已修复。
- 说明：删除 `getFallbackQuota()`，`config.quota` 为空时不渲染用量区域，避免展示硬编码 520K/1M 假数据。

## Issue 2 [major/bug] — 模型选择乐观更新无回滚
- 处理结果：已修复。
- 说明：模型选择先执行默认 connection/model 持久化，成功后才调用 `onConnectionChange()` / `onModelChange()` 更新 UI；失败时保持当前选择并展示 toast。

## Issue 3 [minor/bug] — What's New 小圆点始终可见
- 处理结果：已修复。
- 说明：小圆点仅在 `hasUnseenWhatsNew` 为 true 时渲染。

## Issue 4 [minor/architecture] — 硬编码字符串未使用 i18n
- 处理结果：已修复。
- 说明：用户菜单、quota 文案、管理员模型锁定 footer、默认模型更新失败 toast 均改为 i18n key；同步补齐所有 locale 文件。

## Issue 5 [suggestion/style] — 模型持久化逻辑重复
- 处理结果：已修复。
- 说明：新增 `persist-model-selection.ts`，集中处理 `setDefaultLlmConnection`、`saveLlmConnection` 和 `refreshLlmConnections`。

## 自测结果
- `git diff --check`：通过。
- `bun run typecheck:all`：通过。
