# POL-43 Implement Report

## 变更摘要

- 新增 Electron server-core 侧 transit apiKey 解密能力，HKDF/AES-GCM 参数与 Admin 后端保持一致。
- Admin 连接同步时将 accessToken 传入 upsert/read apiKey 流程，用 accessToken 派生 transit key 后解密 `alg: "A256GCM"` 的 apiKey 对象。
- 保留原有 string apiKey 读取逻辑，兼容旧 Admin 响应。
- 扩展 shared Admin 类型，允许 `apiKey` / `credentials.apiKey` 为 transit-encrypted 对象。
- 增加 handler 测试覆盖直接解密和登录同步后写入明文 credential manager 的路径。

## 关键文件列表

- `packages/server-core/src/lib/admin-transit-decrypt.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.test.ts`
- `packages/shared/src/admin/types.ts`

## 自测结果

- `bun test packages/server-core/src/handlers/rpc/admin.test.ts`
  - 结果：通过，8 pass / 0 fail。
- `cd packages/server-core && bun run typecheck`
  - 结果：通过。
- `cd packages/shared && bun run tsc --noEmit`
  - 结果：通过。

备注：初次运行 typecheck 前本地没有 `node_modules/.bin/tsc`，已执行 `bun install --frozen-lockfile` 安装锁文件依赖后完成上述验证。

## 遗留问题

- 未启动真实 Admin + Electron 做端到端手工集成验证；当前用 handler 级集成测试验证了 `getLlmConnections` 返回加密 apiKey 后 `manager.setLlmApiKey` 收到明文 key。
