# POL-51 Reviewer 第 1 轮修复报告

## 逐条处理结果

### 1. remote_url 撤下后的授权 deny fence

- 已修复。
- Catalog 成功响应在写缓存前会计算全部被撤下 App，不再只筛选
  `local_bundle`，并按完整 `accountId + organizationId + catalogAppId`
  scope 同步建立进程内 deny gate。
- `local-apps:resolveRemoteUrl` 在返回 URL 前校验同一个 App 级 gate。
  即使 `saveAppCatalog` 写入失败、旧缓存仍显示 available，也会返回
  `NOT_AUTHORIZED`。
- 只有后续成功写入且明确重新包含该 App 的 Catalog 才调用授权释放。
- 新增 production wiring 确定性回归测试，覆盖 remote_url 撤下、
  缓存写失败、旧 URL 仍在缓存但无法解析。

### 2. Catalog App 身份唯一性与组织绑定

- 已修复。
- `AppCatalogResponseSchema` 拒绝一次响应内重复的 App ID，并保持
  10,000 项上限。
- `AdminClient.getAppCatalog` 在共享 schema 校验后，结合请求参数校验
  每个 `app.organizationId` 必须与请求的 `organizationId` 完全一致，
  否则 fail closed 为 `SERVER_ERROR`。
- 缓存 schema 改用 `safeExtend`，保留响应 schema 的唯一性 refinement。
- 新增重复 `remote_url`、重复 `local_bundle`、组织 ID 不匹配测试。

### 3. 普通成员日志入口收敛

- 已修复。
- `OrganizationAppCard` 仅在运行状态为 `broken` 时显示“查看日志”；
  healthy installed/running/stopped 状态不再暴露日志入口。
- 该规则不因成员角色变化而放宽，避免健康 App 日志中的路径、配置或
  用户数据被普通成员看到。
- withdrawn/denied App 仍保留 STOP 与 UNINSTALL 本地数据管理入口。
- 更新 HomePage 交互回归，验证 withdrawn 与 denied healthy App
  无日志入口但仍可停止、卸载；补充 broken 与健康状态单元测试。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/handler-deps.ts`
- `packages/shared/src/admin/schemas.ts`
- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `packages/shared/src/admin/__tests__/schemas.test.ts`
- `packages/shared/src/admin/__tests__/client.test.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/OrganizationAppCard.test.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`

## 自测结果

- `bun test packages/shared/src/admin/__tests__/schemas.test.ts packages/shared/src/admin/__tests__/client.test.ts apps/electron/src/renderer/components/tab-browser/__tests__/OrganizationAppCard.test.ts`
  - 51 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 16 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 18 pass，0 fail；包含 remote URL 对 App 级 deny gate 的直接边界测试。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 10 pass，0 fail。
- 全部 `*.isolated.ts` 逐文件执行
  - 全部通过。
- `bun test apps/electron/src/main/handlers/__tests__/registration-profiles.test.ts apps/electron/src/main/handlers/__tests__/registration.test.ts apps/electron/src/main/handlers/__tests__/session-watcher.test.ts packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`
  - 18 pass，0 fail。
- `bun test packages/server/src/__tests__/smoke.test.ts`
  - 4 pass，0 fail。
- `bun run typecheck:electron`、shared `tsc --noEmit`、server-core
  `tsc --noEmit`
  - 全部通过。
- `bun run validate:ci`
  - 通过；包含全仓 typecheck、shared 测试、19 项文档工具测试、
  i18n parity/sorted/coverage。
- Electron 与 shared 本轮改动文件定向 ESLint
  - 0 errors；HomePage 既有 localStorage 测试代码报告 3 warnings。
- `git diff --check`
  - 通过。
- `bun run test`
  - 最新全量尝试为 4,815 pass、19 skip、1 fail；唯一失败是与本轮无关
    的既有墙钟型 `session-watcher.test.ts` watcher 通知竞态。该文件定向
    复跑曾通过 3/3，连续复跑时也复现过 0 通知，确认其本身存在波动。

## 遗留问题

- 全仓 `session-watcher.test.ts` 仍有既有墙钟等待型偶发失败，本轮未改动
  session watcher 生产代码或测试，避免扩大 POL-51 reviewer 修复范围。
- 无本轮 blocking issue 遗留。
