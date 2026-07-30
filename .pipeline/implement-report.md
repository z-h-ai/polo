# POL-51 实现报告

## 变更摘要

- 为 Catalog 单 App 撤下增加完整 `accountId + organizationId + catalogAppId` 级生命周期 fence。成功 Catalog 提交在写入 withdrawn 状态前同步推进不可复用的 App generation，并启动精确 scope 的停止／取消清理。
- 已进入运行时 manager 的 `START`、`RESTART`、`INSTALL` 在对应 App 被撤下后统一以 `NOT_AUTHORIZED` 结束；迟到启动产生的进程会停止，安装任务会取消。
- App 级 fence 只影响被撤下的完整 scope。同账号、同组织仍 available 的 App 不会因普通 Catalog 刷新丢弃已经验证的启动结果。
- HomePage 改为始终展示未进入 recent 的内置 App；recent 中已有内置、组织或外部记录时，Kanban、AirDrop 等其余内置 App 仍可见并可启动。recent 与内置区按内置 App ID 去重。
- 保留既有 Catalog-only renderer IPC、账号／组织 fence、批量状态、single-flight busy polling、严格 SemVer、受限离线和 withdrawn tombstone 行为；未新增用户文案。

## 关键文件列表

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/handler-deps.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`

## 自测结果

- `bun test`：通过，4797 pass、19 skip、0 fail（4816 tests / 365 files）。
- 全部 19 个 `*.isolated.ts` 文件逐一执行：全部通过。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`：11 pass、0 fail。
- `bun test ./apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`：15 pass、0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`：8 pass、0 fail。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`：50 pass、0 fail。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`：通过，0 error；保留仓库既有 warning。
- `bun run lint:i18n:parity`、`bun run lint:i18n:sorted`、`bun run lint:i18n:coverage`：全部通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:renderer`：通过；仅有既有 chunk size warning。
- `git diff --check`：通过。

新增确定性回归覆盖：

- deferred START 与成功 Catalog 单 App 撤下并发：START 不返回 localhost URL，结果为 `NOT_AUTHORIZED`，随后停止进程。
- deferred INSTALL 与成功 Catalog 单 App 撤下并发：INSTALL 不返回成功，结果为 `NOT_AUTHORIZED`，安装被取消并执行停止清理。
- 同组织刷新仍保留目标 App：已进入 START 的成功 localhost URL 正常返回，不触发停止。
- 同组织两个 App 并发 START：只 fence 被撤下的完整 App scope，仍 available App 的结果正常提交。
- signed-out HomePage 已有 builtin/external recent：recent 内置项不在内置区重复，其他内置 App 仍可见并可启动。

## 遗留问题

- 无已知代码阻断。
- 未连接真实 POL-52 服务与生产签名 Bundle 做端到端联调；本轮通过 production wiring mock、真实 scoped registry、全量单测、全部 isolated 测试和 Electron production build 验证。
