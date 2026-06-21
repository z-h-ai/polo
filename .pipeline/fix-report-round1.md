# POL-31 Review Round 1 修复报告

## Issue 1 [major/style] AdminLoginStep.tsx

处理结果：已修复。

- `AdminLoginStep` 已接入 `useTranslation()`。
- 用户可见文本和 aria-label 均替换为 `t()` 调用。
- 已在全部 locale 文件中新增并排序 `onboarding.adminLogin.*` key。

## Issue 2 [major/style] AdminKickedStep.tsx

处理结果：已修复。

- `AdminKickedStep` 已接入 `useTranslation()`。
- 标题、说明、按钮和 aria-label 均替换为 `t()` 调用。
- 已在全部 locale 文件中新增并排序 `onboarding.adminKicked.*` key。

## Issue 3 [major/style] useOnboarding.ts

处理结果：已修复。

- `mapAdminLoginError` 已改为使用共享 i18n 实例。
- `INVALID_CREDENTIALS`、`ACCOUNT_DISABLED`、网络错误和兜底错误均使用 i18n key。

## Issue 4 [minor/style] useOnboarding.test.ts

处理结果：已修复。

- 新增 admin onboarding flow 测试，覆盖：
  - `needsAdminLogin=true` 初始 step 为 `admin-login`
  - admin 登录成功切到 `complete`
  - admin 登录失败映射本地化错误文案
  - `admin-kicked` 重新登录切回 `admin-login`
  - `showAdminKicked` 对应状态转换到 `admin-kicked`
- 当前测试环境没有 DOM hook runner，测试覆盖的是 hook 复用的纯状态转换函数，避免引入额外测试依赖。

## 自测结果

- `bun run typecheck:all`：通过。
- `bun test packages/shared/src/i18n/__tests__/locale-parity.test.ts apps/electron/src/renderer/hooks/__tests__/useOnboarding.test.ts packages/server-core/src/handlers/rpc/admin.test.ts apps/electron/src/shared/__tests__/ipc-channels.test.ts`：通过，64 pass。
