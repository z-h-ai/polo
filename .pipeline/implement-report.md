# POL-51 实现报告

## 变更摘要

- 收紧 Catalog denied 网络回退：进程内 deny gate 现在优先于可能仍为 authorized 的旧持久缓存。明确失权后的 denied 快照即使写盘失败，后续 `NETWORK_ERROR`、`TIMEOUT` 和异常缓存回退也只返回去能力化 Catalog，不会恢复 offline/online 授权或泄露远程 URL、Release 下载地址及 checksum。
- 统一 Catalog Local App scope 的业务实体 ID 校验：账号、组织和 Catalog App ID 全部复用 shared `AdminEntityIdSchema`，接受 NUL、冒号、Unicode 和最长 512 字符；文件目录、manager key 和 runtime App ID 继续使用 scope 元组的安全哈希，不把业务 ID 直接用作路径。
- 将首页最近使用记录从 `localStorage` 迁移到现有 Electron `preferences.json`：新增强类型读取／写入 RPC，使用版本化且无碰撞的账号／组织上下文 key 隔离记录；首次读取兼容旧 `craft-home-recent-apps`，只有持久化成功后才清理旧值。
- 补充确定性回归：覆盖 deny 缓存写失败后的网络错误／超时、NUL／Unicode／长实体 ID 的跨层与 production wiring、最近使用跨账号／组织持久化和旧数据一次性迁移，以及 HomePage 回访时内置 App 可发现性。

## 关键文件列表

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `packages/shared/src/config/preferences.ts`
- `packages/shared/src/config/validators.ts`
- `packages/shared/src/config/__tests__/home-recent-apps.test.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/routing.ts`
- `packages/server-core/src/handlers/rpc/settings.ts`
- `apps/electron/src/transport/channel-map.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/renderer/lib/home-recent-apps.ts`
- `apps/electron/src/renderer/lib/__tests__/home-recent-apps.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`

## 自测结果

- `bun run test`：通过；全仓标准测试及全部 `*.isolated.ts` 测试均通过。
- `bun run validate:ci`：通过；全仓 TypeScript、shared/doc-tools 测试，以及 6 个 locale、每个 1,706 keys 的 parity、sorted 和 coverage 检查均通过。
- `cd apps/electron && bun run lint`：通过；0 errors，保留仓库既有 warnings。
- `bun run electron:build:main`：通过。
- `bun run electron:build:renderer`：通过；仅输出既有 chunk size 提示。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`：59 passed、337 assertions。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`：21 passed、167 assertions。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`：12 passed、69 assertions。
- 最近使用持久化、实体 ID schema 与 scoped registry 定向测试：30 passed。
- `git diff --check`：通过。

## 遗留问题

- 本任务范围内无已知功能遗留。
- HomePage 测试仍输出既有 React/Radix `act` 与 ref 警告；renderer 构建仍输出既有大 chunk 提示，均不影响测试或构建结果。
