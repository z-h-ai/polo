# POL-44 Implement Report

## 变更摘要

- 在 admin connection sync 的 upsert 逻辑中解构并移除 `endpoint`，避免该字段残留到 Electron `LlmConnection` 配置对象。
- 将 admin 返回的 `endpoint` 映射为 Electron 侧 `LlmConnection.baseUrl`，并保留无 `endpoint` 时使用原有 `baseUrl` 的兼容逻辑。
- 补充 Electron 侧 admin response 类型 `AdminLlmConnection.endpoint?: string`，准确表达 admin API 返回字段。
- 新增 admin sync 测试，覆盖 `api_key_with_endpoint` 连接的 `endpoint -> baseUrl` 映射，以及无 `endpoint` 连接不受影响。

## 关键文件列表

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.test.ts`
- `packages/shared/src/admin/types.ts`

## 自测结果

- `bun test packages/server-core/src/handlers/rpc/admin.test.ts`
  - 结果：通过，9 pass / 0 fail
- `bun run --cwd packages/server-core typecheck`
  - 结果：通过
- `bun run typecheck:shared`
  - 结果：通过

说明：当前 worktree 初始没有安装完整 `node_modules`，首次包级 typecheck 因找不到 `tsc` 失败；随后执行 `bun install --frozen-lockfile` 安装依赖后，上述 typecheck 均通过。

## 遗留问题

- 未发现遗留问题。
