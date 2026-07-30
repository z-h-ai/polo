# POL-51 第 3 轮阻塞审查修复报告

## 逐条 Issue 处理结果

### 1. Catalog 撤下与 retained tombstone 提交竞态

已修复。

- Catalog 修改响应先在当前 session/sync generation 的提交锁内计算撤下集合，并为完整 `accountId + organizationId + catalogAppId` scope 同步建立 lifecycle deny fence。
- 慢清理在 session coordinator 锁外执行，避免阻塞账号切换；清理失败时拒绝本次 Catalog 提交并保留 deny gate。
- fence 和清理完成后重新扫描 retained scopes，并将初次扫描与最终扫描合并，确保初次扫描后才完成安装并落盘的 App 不会在 tombstone 容量边界被遗漏。
- 缓存写入前再次执行 session、sync generation、授权状态和撤下集合校验；上下文或 Catalog 基线已变化时不提交旧结果。
- 新增确定性 production-wiring 回归：初次 retained 扫描挂起后完成 INSTALL，在 10,000 tombstone 边界撤下该 App；断言缓存保留真实本地状态，且 STATUS、STOP、UNINSTALL 均可达。

### 2. GET_LOGS 与 RESTART 的 TOCTOU 日志泄露

已修复。

- Runtime manager 新增 failure-recovery 专用原子日志接口，并为每个 runtime App 维护不可复用的 lifecycle generation。
- 读取前拒绝正在排队的生命周期操作或活跃安装，确认可信状态为 `broken`；日志进入主进程内存后再次校验 generation、生命周期空闲和 `broken` 状态，任一条件变化都返回 `NOT_AUTHORIZED`，不提交已读取内容。
- Scoped registry 在账号级管理操作跟踪内完成业务 scope 到内部 runtime ID 的映射；公开 GET_LOGS RPC 只调用该原子接口，不再把独立状态查询与普通日志读取拼接。
- 新增真实 manager 并发回归：GET_LOGS 的底层读取挂起时执行 RESTART，恢复为 running 后迟到日志请求必须返回 `NOT_AUTHORIZED`，且不会返回敏感日志内容。

### 3. HomePage 跨 App 日志请求乱序覆盖

已修复。

- 日志请求使用完整 App scope key，并为每次打开、关闭或切换分配单调 request generation。
- 只有 generation 与当前 `logsTarget` scope 同时匹配时，异步结果才可以提交 logs、error 或 loading 状态。
- 关闭弹窗、切换目标以及账号/组织 context generation 变化都会立即使旧请求失效。
- 新增 A/B deferred 交互回归：A 请求未完成时切换到 B，A 先返回不会覆盖 B 内容或提前清除 B loading，B 返回后仅展示 B 日志。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/main/local-app-runtime/manager.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`

## 自测结果

- `bun run test`
  - 通过（exit 0）；常规测试与仓库全部 `*.isolated.ts` 测试均完成。
- `bun run validate:ci`
  - 通过；包含全部 workspace 类型检查、shared/config/doc-tools 测试，以及 i18n parity、sorted、coverage 检查。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 55 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 19 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 19 pass，0 fail。
- `bun test apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
  - 30 pass，0 fail。
- `bun test apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
  - 20 pass，0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 11 pass，0 fail。
- `bun test packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`
  - 11 pass，0 fail。
- Electron 变更文件定向 ESLint
  - 0 error；HomePage 测试文件有 3 个既有 `localStorage` 规则 warning。
- `git diff --check`
  - 通过。

## 遗留问题

- 未发现本轮三个 blocking issues 的已知代码遗留。
- worktree 中任务开始前已有的 `.pipeline/fix-report-round4.md` 删除和 `design-demos/`、`docs/spec-home-app-admin-config*.md` 未跟踪文件未纳入本轮修改或提交。
