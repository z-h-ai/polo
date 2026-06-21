# POL-31 实现报告

## 变更摘要

- 新增 Admin 登录页 `AdminLoginStep`：居中 glass card、Polo AI logo、用户名/密码表单、密码明文切换、loading 状态与错误提示动画。
- 新增 Admin 被踢页 `AdminKickedStep`：多设备登录失效提示与“重新登录”入口。
- 扩展 onboarding 状态机：新增 `admin-login` / `admin-kicked` step；`needsAdminLogin` 时进入登录页；登录成功进入完成步骤；TOKEN_REVOKED/401 校验失败进入被踢页。
- 补齐 renderer/preload admin RPC API：`adminLogin`、`adminValidate`、`adminLogout`、`adminGetStatus`、`adminSyncConnections`。
- 服务端 `admin:validate` 在 refresh token 被撤销或 401 时返回可识别错误码，保留普通无 token 返回登录页的行为。
- 更新 RPC channel inventory/registration 测试期望，并新增 revoked refresh token 的 admin handler 单测。

## 关键文件列表

- `apps/electron/src/renderer/components/onboarding/AdminLoginStep.tsx`
- `apps/electron/src/renderer/components/onboarding/AdminKickedStep.tsx`
- `apps/electron/src/renderer/components/onboarding/OnboardingWizard.tsx`
- `apps/electron/src/renderer/hooks/useOnboarding.ts`
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/preload/bootstrap.ts`
- `apps/electron/src/transport/channel-map.ts`
- `apps/electron/src/shared/types.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/types.ts`

## 自测结果

- `bun install --frozen-lockfile`：通过，用于补齐当前 worktree 缺失的 `node_modules`。
- `bun run typecheck:all`：通过。
- `bun test packages/server-core/src/handlers/rpc/admin.test.ts apps/electron/src/shared/__tests__/ipc-channels.test.ts apps/electron/src/renderer/hooks/__tests__/useOnboarding.test.ts`：通过，27 pass。
- 额外尝试运行 registration 相关测试时失败，失败点为既有运行时导出缺失：`@polo-ai/shared/config` 未导出 `getWorkspaceByNameOrId` / `setSetupDeferred`。完整 typecheck 已覆盖这些测试文件的类型层面。

## 遗留问题

- 未在本环境启动 Electron 做真实 UI 点击验收；本次完成了类型检查与受影响逻辑测试。
- registration 运行时测试存在上述既有模块导出问题，未在本任务中扩大范围修复。
