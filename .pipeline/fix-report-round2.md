# POL-51 第 2 轮 Blocking Issues 修复报告

## 逐条处理结果

### 1. 全量测试中的 transfer TTL 与 session watcher 竞态

- Transfer 收到合法 chunk 后会在文件写入前刷新 TTL，避免旧 deadline 在异步文件 I/O 期间提前清理仍活跃的传输。
- TTL 回归测试改为 fake timer 驱动，不再依赖 25ms 墙钟等待。
- Session 文件监听增加可注入的 watcher factory 测试 seam；两组 watcher 测试使用事件控制器明确触发变更并等待目标 client push，不再依赖真实 `fs.watch` 的调度时机和固定 sleep。
- Transfer + 两组 watcher 回归连续复跑 5 次，均为 10 pass、0 fail。
- 项目标准 `bun run test` 完整执行 3 次，均成功退出。

### 2. GET_LOGS 主进程授权边界

- `local-apps:getLogs` 在主进程先读取 scoped registry 的可信运行状态，仅 `status = broken` 时允许读取日志；`installed`、`running`、`stopped` 等健康状态统一返回 `NOT_AUTHORIZED`。
- denied/withdrawn App 仍可读取状态并执行 STOP、UNINSTALL，但健康状态不能读取日志。
- 新增直接 RPC 回归，覆盖 healthy installed/running/stopped、denied healthy 均拒绝，以及 broken/启动失败状态可读取日志。

### 3. Catalog 同 ID deliveryMode 变更

- 将 `deliveryMode` 纳入 Catalog App 身份契约：同一账号、组织、Catalog App ID 一旦存在于最近可信的 visible 或 withdrawn Catalog 中，后续成功响应不得把 `remote_url` 与 `local_bundle` 相互切换。
- 模式冲突会在建立新 fence 或保存新缓存前以 `SERVER_ERROR` 拒绝，新响应不能提交；同步保留上一可信缓存并进入现有受限离线回退。
- 因旧 local bundle 身份和授权上下文不发生切换，已经进入 manager 的 START/INSTALL 结果仍按旧可信上下文提交，STOP/UNINSTALL 数据管理入口继续可达。
- 新增 shared handler 级 remote-to-local 冲突测试，以及 production wiring 的 deferred START、deferred INSTALL、STOP、UNINSTALL 确定性测试。

## 关键文件

- `packages/server-core/src/handlers/rpc/transfer.ts`
- `packages/server-core/src/handlers/rpc/transfer.test.ts`
- `packages/server-core/src/handlers/handler-deps.ts`
- `packages/server-core/src/handlers/rpc/sessions.ts`
- `apps/electron/src/main/handlers/__tests__/session-watcher.test.ts`
- `apps/electron/src/main/handlers/__tests__/sessions-watchers.test.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`

## 自测结果

- `bun run test`：完整执行 3 次，均通过；最终复跑为 4,816 pass、19 skip、0 fail。
- `bun run validate:ci`：通过；包含 shared 配置测试、资源脚本 smoke tests、i18n parity/sorted/coverage 检查。
- Transfer 与 watcher 三个目标测试文件连续复跑 5 次：每次 10 pass、0 fail。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`：55 pass、0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`：18 pass、0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`：19 pass、0 fail。
- `bun run typecheck:electron`：通过。
- `packages/server-core` 执行 `bun run tsc --noEmit`：通过。
- `packages/shared` 执行 `bun run tsc --noEmit`：通过。
- 变更涉及的 Electron 文件定向 ESLint：通过。
- `git diff --check`：通过。

## 遗留问题

- 本轮 3 项 blocking issue 无遗留。
- worktree 中原有的 `.pipeline/fix-report-round3.md`、`.pipeline/fix-report-round4.md` 删除状态，以及 `design-demos/`、3 个 `docs/spec-home-app-admin-config*.md` 未跟踪内容均未改动，也不会纳入本轮 commit。
