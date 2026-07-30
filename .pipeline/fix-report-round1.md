# POL-51 第 1 轮 Review 修复报告

## 每条 issue 的处理结果

### 1. Logout 慢远端请求窗口内未建立本地生命周期 fence

已修复。

- `AdminSessionCoordinator.beginEnding()` 现在会在同一会话转换锁内依次推进 ending generation、关闭 Catalog 授权，并立即调用 `onAdminSessionEnding` 建立本地 App 生命周期 fence。
- `stopAccount(accountId)` 返回的慢停止／取消 Promise 仍在锁外等待，不阻塞新账号登录；远端 logout 与本地清理并行进行，最终凭据删除继续受 ending snapshot CAS 保护。
- Electron 生产接线直接返回 `ScopedLocalAppRuntimeRegistry.stopAccount()` Promise，确保调用 hook 时同步执行 registry 的账号 gate 与 lifecycle generation 推进。
- 新增真实 `registerAdminHandlers + registerLocalAppHandlers + ScopedLocalAppRuntimeRegistry` 确定性回归测试：公开 START RPC 已进入且远端 logout 挂起时，迟到的 localhost 启动结果返回 `NOT_AUTHORIZED`，并由同一账号清理链调用 `stop` 回收产生的进程。

### 2. AdminSessionCoordinator 缺少并发不变量 why 注释

已修复。

- 增加类级注释，说明 session generation、login attempt、ending snapshot 只在 `runExclusive` 转换中推进。
- 说明 ending generation 如何在释放锁前淘汰旧提交、慢 cleanup 为什么必须留在锁外，以及账号 cleanup Promise 的 single-flight／generation 去重边界。
- 同步加强 `HandlerDeps.onAdminSessionEnding` 契约注释，明确 hook 必须先同步建立 fence，再返回慢清理 Promise。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/handler-deps.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `.pipeline/fix-report-round1.md`

## 自测命令与结果

- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 结果：1 pass，0 fail。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 结果：50 pass，0 fail。
- `bun test apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
  - 结果：13 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 结果：17 pass，0 fail。
- `bun run typecheck:all`
  - 结果：通过。
- `cd apps/electron && bunx eslint src/main/index.ts src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 结果：通过，0 error。
- `bun run electron:build:main`
  - 结果：主进程构建并校验通过。
- `bun run test`
  - 最终结果：全量非 isolated 测试 4792 pass、19 skip、0 fail；随后全部 isolated 测试通过，包含本轮新增生产接线竞态测试。
  - 说明：首次全量运行出现两个与本次改动无关的时序型失败（依赖准备进程树 PID 探测、session watcher 通知）；两项定向重跑均通过，第二次完整全量运行无失败。
- `git diff --check`
  - 结果：通过。

## 遗留问题

无本轮遗留问题。
