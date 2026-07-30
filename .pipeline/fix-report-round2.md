# POL-51 第 2 轮阻塞审查修复报告

## 逐条处理

### 1. 区分账号认证失效与 Catalog 组织失权

- 为 Catalog 同步增加独立的认证失败分类：
  - `UNAUTHORIZED`、`INVALID_TOKEN`、`TOKEN_REVOKED`、`TOKEN_EXPIRED`、
    `ACCOUNT_DISABLED` 以及明确 HTTP 401 继续结束可信账号会话。
  - `FORBIDDEN`、`MEMBERSHIP_REMOVED`、`MEMBERSHIP_SUSPENDED`、
    `ORGANIZATION_UNAVAILABLE`、`NOT_FOUND` 以及 Catalog HTTP 403
    只调用 `denyCatalogScope`。
- Catalog 组织失权不再依赖“必须存在缓存”才建立 deny gate；无缓存时同样
  fail closed。
- renderer 的 Catalog 同步使用独立的账号失效事件分类。组织级 403/成员失权
  不再触发 App 全局登出，账号禁用和 token/session 失效仍触发登出。
- 组织失权后保留当前账号凭据和 denied Catalog：
  - `INSTALL`、更新 Release、`START`、`RESTART` 均返回
    `NOT_AUTHORIZED`。
  - 运行状态、日志、`STOP`、`UNINSTALL` 继续可用。
- 增加真实 Admin handler + scoped local runtime production wiring 测试，
  覆盖 Catalog 403 后账号会话保留、生命周期操作 fail closed，以及本地数据
  管理继续可用。
- 增加 App 与 `useAppCatalog` 测试，覆盖组织 403 不清理账号上下文、
  `ACCOUNT_DISABLED` 仍进入账号认证失效链路。

### 2. 401/403 响应体半开时保留已知授权状态

- AdminClient 在 `fetch` 返回响应头时立即记录 `Response`。
- 统一 deadline 仍覆盖 `response.text()`；响应体半开会按期限 abort。
- 若已收到 HTTP 401/403，body 超时或读取失败不再改写为 `TIMEOUT`：
  - 401 保留为 `UNAUTHORIZED`，继续遵循既有 token refresh 规则。
  - 403 保留为 `FORBIDDEN`。
- 其他 fetch/body 半开行为仍稳定映射为 `TIMEOUT`。
- 新增 401、403 body 永不结束的确定性测试，验证 abort 只发生一次且不会
  延迟重复触发。
- server-core 回归测试确认 Catalog 403 进入 denied Catalog，不会进入
  `NETWORK_ERROR`/`TIMEOUT` 的旧授权缓存回退。

## 关键文件

- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/__tests__/client.test.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/lib/admin-auth-failure.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/__tests__/App.organization-deep-link.interaction.isolated.ts`

## 全量自测结果

- 定向回归：
  - AdminClient：34 pass，0 fail。
  - Admin RPC：50 pass，0 fail。
  - production wiring：13 pass，0 fail。
  - `useAppCatalog`：20 pass，0 fail。
  - App：6 pass，0 fail。
- `bun run test`：通过。
  - 常规测试：4,803 pass，19 skip，0 fail（4,822 tests / 365 files）。
  - 19 个 isolated 测试文件：268 pass，0 fail。
  - 合计：5,071 pass，19 skip，0 fail。
- `bun run typecheck:all`：通过。
- 修改文件定向 ESLint：0 error；Electron 仅有既存 warning。
- `git diff --check`：通过。

## 遗留问题

- 功能与阻塞审查项无遗留。
- 根级 `bun run lint` 目前无法完整启动：仓库引用的
  `scripts/check-raw-sends.sh` 与 `scripts/check-task-tool-checks.sh`
  在当前 worktree 不存在；已改为对本轮修改文件执行可用的 package ESLint，
  结果 0 error。
