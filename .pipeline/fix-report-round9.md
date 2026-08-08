# POO-29 第 9 轮修复报告

## 已处理

1. Admin publication 路径改为 `/api/organizations/:organizationId/admin/apps`；remote URL 使用 `active`，local bundle 使用 `draft`。complete/publish 发送 JSON 空对象，signed upload 附带 ZIP content type。
2. upload 在创建 Release 前先生成 canonical Bundle，确保后续 metadata/upload 使用最终产物。

## 测试

- `bun run typecheck:all`：通过。
- `bun test packages/shared/src/admin/__tests__/creator-app-publishing.test.ts packages/server-core/src/handlers/rpc/admin.test.ts`：38 pass。

## 剩余风险

- Release create metadata、409 有限重试、shared installer validator 抽取和三种 runtime 的真实 install 证明尚未完成；不能视为最终闭环。
- 本轮未修改外部 polo-admin worktree，尚需与真实服务的 HTTP 契约集成测试确认。
