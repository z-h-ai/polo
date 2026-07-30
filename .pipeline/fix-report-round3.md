# POL-51 Reviewer 第 3 轮修复报告

## 逐条问题处理结果

### 1. 受保护请求 401 不得被 refresh 临时错误覆盖

- 已修复。`AdminClient.request()` 在受保护接口明确返回 HTTP 401 后，先保存原始认证错误；自动 refresh 只有完整成功并持久化新 token 后才重试原请求。
- refresh 网络失败、HTTP 5xx、响应校验失败或 token 持久化失败均重新抛出原始 401，不再把明确失权降级成 `NETWORK_ERROR` / `SERVER_ERROR`。
- 增加真实 `AdminClient` 回归：本地 token 仍视为未过期时，VALIDATE 返回 401 且 refresh 网络失败，以及 Catalog 返回 401 且 refresh 返回 503，最终都保持 `TOKEN_REVOKED` / HTTP 401。
- server-core 的 VALIDATE 与 Catalog 链路分别覆盖该保留结果，验证凭据删除、账号进程清理回调执行、Catalog authorization 与 access mode 均变为 denied。

### 2. Catalog 与组织列表共用授权 epoch

- 已修复。主进程为 `accountId + organizationId` 维护独立授权 epoch；每次 Catalog 同步注册时在会话锁内捕获当前 epoch。
- Catalog 的离线快路径、网络提交、授权失败、临时错误缓存回退和普通错误提交都同时校验 session generation、Catalog 请求代次与授权 epoch。
- LIST_ORGANIZATIONS 成功确认组织移除、暂停或成员非 active 时，在同一可信会话提交锁内推进对应 scope epoch，再 deny Catalog 缓存和 access mode。
- epoch 同时覆盖已有缓存和正在请求但尚无缓存的 scope，避免无缓存的挂起请求绕过失权结果。
- 增加确定性竞态测试：Catalog v1 挂起，组织列表先确认移除并提交 denied，v1 随后返回；最终请求为 `REQUEST_SUPERSEDED`，缓存保持旧版本 denied，不能重新写回 authorized/online。

### 3. 安装确认 Release 的 TOCTOU 绑定

- 已修复。Catalog 安装协议新增用户确认的 Release 指纹：`version`、`checksum`、`sizeBytes`、`platform`、`arch`；platform/arch 缺失也以显式 `null` 参与比较。
- renderer 从确认框所持有的 Release A 构造指纹；主进程仍只使用当前授权缓存构造实际下载参数，但下载前逐项严格比较用户确认指纹。
- 任一字段不一致或缺少指纹时，主进程返回 `RELEASE_CHANGED`，不会创建安装任务或下载新 Release。
- renderer 收到 `RELEASE_CHANGED` 后强制刷新 Catalog，并显示国际化提示，用户必须基于 Release B 重新打开确认流程。
- 覆盖五个指纹字段逐项变化的主进程测试，以及“确认 A → 主进程缓存变为 B → 确认提交”的 renderer 跨层回归；验证首次请求只携带 A、未静默安装 B、最终页面刷新为 B。
- 新文案已补齐全部 locale，并通过 parity、sorted 和 coverage 检查。

## 关键文件

- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/__tests__/client.test.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/lib/home-app-errors.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
- `packages/shared/src/i18n/locales/*.json`

## 自测结果

- `bun run test`
  - 完整通过，退出码 0。
  - 常规阶段：4783 pass、19 skip、0 fail，4802 tests / 363 files。
  - 脚本后半段发现并逐文件执行的全部 `*.isolated.ts` 测试通过。
- `bun test ./packages/shared/src/admin/__tests__/client.test.ts`
  - 31 pass，0 fail。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 47 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 10 pass，0 fail。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
  - 14 pass，0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 6 pass，0 fail。
- `bun run typecheck:all`
  - 通过。
- `bun run lint:i18n:parity`
  - 通过，6 个非英文 locale 与英文各 1707 keys。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:coverage`
  - 通过。
- 变更文件定向 ESLint
  - 0 error；3 个测试环境既有 `localStorage` 规则 warning。
- `git diff --check`
  - 通过。

## 遗留问题

- SemVer 三份实现仍按 Reviewer 第 1 轮报告中的风险判断保留，未在本轮安全与 TOCTOU 修复中扩大重构范围。
- 无其他已知阻断问题。
