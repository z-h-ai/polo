# POL-51 第 2 轮 Review 修复报告

## 每条 issue 的处理结果

### 1. VALIDATE 受限离线返回未关闭既有在线 Catalog 安装权限

已修复。

- 两条受限离线路径（过期 token 刷新网络失败、未过期 token 校验网络失败）都在最终 `mutateIfCurrent` session CAS 内枚举当前账号已缓存或已注册的 Catalog scope。
- 仅将仍为 `online` 的 scope 原子降级为 `offline`，不会把已经 `denied` 的 scope 重新开放。
- 新增真实 Admin handler、Local Apps handler 与 scoped runtime registry 接线测试：先完成 online Catalog sync，再触发两类离线 VALIDATE；紧接着公开 INSTALL 均返回 `NOT_AUTHORIZED`，runtime manager 创建次数为 0。

### 2. renderer 按 scope 复用不同生命周期操作的在途 Promise

已修复。

- `useAppCatalog` 的生命周期 single-flight key 改为完整 scope key 加 operation kind（install/start/stop/uninstall）。
- 相同 scope 的重复同类操作继续去重，但 STOP 不再复用在途 START Promise，可真实发送到主进程并由主进程生命周期队列串行处理。
- 新增 deferred START 确定性测试：START 未完成时调用 STOP，断言 STOP RPC 在 START resolve 前已发送且只发送一次。

### 3. 严格 SemVer 错误接受大写 `V` 前缀

已修复。

- shared 唯一解析实现移除大小写不敏感标志，只兼容精确小写单个前导 `v`。
- shared parser、Catalog cache、主进程、renderer 和 scoped runtime 五层测试都新增大写 `V` 拒绝用例。
- 原有小写 `v`、大数字标识符、prerelease、第四段和首尾空白契约保持不变。

### 4. 明确失权时缓存写失败可能保留内存 online 门禁

已修复。

- 新增统一 fail-closed scope denial：先推进 authorization epoch，再将内存 access mode 设置为 `denied`，最后才尝试持久化 denied cache。
- denied cache 写失败只记录告警，不再中断内存授权关闭，也不会让 RPC 返回路径恢复在线。
- Catalog `NOT_FOUND` 与组织列表确认成员移除均复用该顺序。
- 新增两条缓存写失败生产接线测试：缓存仍显示旧 authorized 元数据时，内存门禁已为 denied，公开 INSTALL 立即返回 `NOT_AUTHORIZED`，runtime manager 创建次数为 0。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `packages/shared/src/admin/semver.ts`
- `packages/shared/src/admin/__tests__/semver.test.ts`
- `packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts`
- `.pipeline/fix-report-round2.md`

## 自测命令与结果

- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 结果：5 pass，0 fail。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
  - 结果：16 pass，0 fail。
- `bun test ./packages/shared/src/admin/__tests__/semver.test.ts ./packages/shared/src/admin/__tests__/app-catalog-cache.test.ts ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts ./apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
  - 结果：36 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 结果：17 pass，0 fail。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 结果：50 pass，0 fail。
- `bun run typecheck:all`
  - 结果：通过。
- `cd apps/electron && bunx eslint src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts src/main/handlers/__tests__/local-apps.isolated.ts src/main/local-app-runtime/__tests__/scoped-registry.test.ts src/renderer/hooks/useAppCatalog.ts src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts src/renderer/hooks/__tests__/useAppCatalog.test.ts`
  - 结果：通过，0 error。
- `bun run electron:build:main`
  - 结果：主进程构建并校验通过。
- `bun run test`
  - 结果：全量非 isolated 测试 4792 pass、19 skip、0 fail；随后全部 isolated 测试通过，包含本轮新增授权和 renderer 竞态回归。
- `git diff --check`
  - 结果：通过。

## 遗留问题

无本轮遗留问题。
