## 变更摘要

- 新增 Admin RPC Handler，支持 `admin:login`、`admin:validate`、`admin:logout`、`admin:getStatus`、`admin:syncConnections`。
- 注册 Admin RPC Handler 到 server-core RPC 入口。
- AdminClient 支持 401 后通过 refresh token 自动刷新并重试一次。
- 扩展 LLM connection/admin token 存储字段，支持 admin 管理标记、admin config version 和 displayName。
- 新增 Admin handler 单元测试，并补充 AdminClient 自动刷新测试。

## 关键文件列表

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.test.ts`
- `packages/server-core/src/handlers/rpc/index.ts`
- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/__tests__/client.test.ts`
- `packages/shared/src/config/llm-connections.ts`
- `packages/shared/src/config/storage.ts`
- `packages/shared/src/config/validators.ts`
- `packages/shared/src/credentials/manager.ts`
- `packages/shared/src/credentials/types.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/routing.ts`

## 自测结果

- `bun test packages/server-core/src/handlers/rpc/admin.test.ts`：通过，4 个测试。
- `bun test packages/shared/src/admin/__tests__/client.test.ts`：通过，5 个测试。
- `bun run typecheck:all`：通过。

## 遗留问题

- 无。
