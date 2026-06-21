# POL-29 实现报告

## 变更摘要

- 扩展 `LlmConnection`，新增 `managedBy?: 'admin'`，并同步收紧配置校验 schema。
- 为 Admin LLM 连接响应补充专用类型，允许 Admin API 返回明文 `apiKey`，同步时写入 `CredentialManager.setLlmApiKey`，不把明文 key 保存在本地 config。
- 完善 `syncConnections`：拉取 Admin 连接、映射为本地 `LlmConnection`、设置 `managedBy: 'admin'` 和 `adminConfigVersion`、清理 Admin 已删除连接及其凭据、设置默认连接、更新全局 `adminConfigVersion`。
- 修复已有 admin-managed 连接更新时历史残留 `apiKey`/`key`/`credentials` 字段不会被合并保留的问题。
- 禁止普通 LLM 连接 RPC 修改或删除 admin-managed 连接；设置页在 Admin 模式下禁用添加、重命名、重新认证、编辑、mid-stream 行为修改和删除入口。
- 补充 Admin 同步单测，覆盖映射、API Key 凭据存储、明文不落 config、Admin 删除后的本地清理。

## 关键文件列表

- `packages/shared/src/config/llm-connections.ts`
- `packages/shared/src/config/validators.ts`
- `packages/shared/src/admin/types.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/llm-connections.ts`
- `packages/server-core/src/handlers/rpc/admin.test.ts`
- `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`

## 自测结果

- `bun install`：通过。用于补齐当前 worktree 缺失的 `node_modules`/`typescript`，否则 `bun run typecheck:all` 找不到 `tsc`。
- `bun test packages/server-core/src/handlers/rpc/admin.test.ts`：通过，5 个测试全部通过。
- `bun run typecheck:all`：通过。

## 遗留问题

- 无已知遗留问题。
