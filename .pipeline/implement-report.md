# POL-27 实现报告

## 变更摘要

- 扩展 `getAuthState()`：读取 `getAdminUrl()`，检查 `CredentialManager.getAdminTokens()`，返回 `authState.admin`，包含 Admin URL 配置状态、登录状态和用户名。
- 扩展 `getSetupNeeds()`：Admin 管理模式下新增 `needsAdminLogin`，无 Admin tokens 时要求 Admin 登录；已登录且存在默认 LLM connection 时视为配置完成。
- Admin 管理模式下抑制本地 LLM 配置入口：`needsBillingConfig` 和 `needsCredentials` 固定为 `false`。
- 同步浏览器安全类型定义和 renderer 中手工构造的 `SetupNeeds` 对象。
- 增加 Admin 管理模式 setup needs 单测覆盖。

## 关键文件列表

- `packages/shared/src/auth/state.ts`
- `packages/shared/src/auth/types.ts`
- `packages/shared/src/auth/__tests__/state.test.ts`
- `apps/electron/src/renderer/App.tsx`

## 自测结果

- `cd packages/shared && bun test src/auth/__tests__/state.test.ts`
  - 结果：通过，21 pass / 0 fail。
- `bun run typecheck:all`
  - 结果：通过。

## 遗留问题

- 无。
