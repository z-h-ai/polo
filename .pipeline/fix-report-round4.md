# POL-51 第 4 轮阻塞审查修复报告

## 逐条处理

### 1. token refresh 网络失败不得把 persisted denied Catalog 降级为 offline

已修复。

- `SYNC_APP_CATALOG` 在 token refresh 返回 `NETWORK_ERROR` 的冷启动路径中重新读取当前 Catalog 缓存。
- 最近可信缓存已经是 `authorizationStatus = denied` 时，保持主进程 Catalog access mode 为 `denied`，不再写成 `offline`。
- 返回给冷 renderer 的失败响应包含清洗后的 denied Catalog；所有可见和 retained App 均为 `availability = unavailable`。
- 账号 token 和最近验证身份继续保留，但安装、更新、启动和重启仍由 denied gate 拒绝。
- 新增 server-core handler 与真实 Electron Admin/Local Apps production wiring 回归，覆盖过期 token、refresh 网络失败、persisted denied cache、冷 renderer 响应和生命周期 fail closed。

### 2. 大批量 App 撤下的 fence、扫描和停止并发

已修复。

- `stopApps()` 先验证并去重完整 scopes，再在同一个无 `await` 的同步循环中为全部撤下 App 建立 deny gate 并推进 lifecycle generation；任何目录扫描、manager 查找或慢清理开始前，完整撤下集合已全部 fail closed。
- 同一批次按 `accountId + organizationId` 分组，每个账号/组织只执行一次 persisted scope 扫描；不再为每个 App 重复遍历全部 scope 目录。
- 新增 registry 级全局 stop/cancel slot queue，上限为 `STOP_CLEANUP_CONCURRENCY = 8`。App、组织和账号清理共用同一并发门禁，并发 bulk cleanup 也不能叠加突破上限。
- entered install/start 的取消与迟到提交语义保持不变；清理失败继续聚合为 `STOP_FAILED`，App deny gate 不会因慢清理完成而自动释放。
- 新增 1,000 App 回归，断言全部 fence 同步建立且组织只扫描一次。
- 新增 10,000 App、两个并发组织批次回归，断言每个组织只扫描一次、10,000 个实例全部停止、全局最大同时 stop 数严格为 8。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `.pipeline/fix-report-round4.md`

## 自测结果

- `bun run test`
  - 全量通过。
  - 常规测试：4809 pass，19 skip，0 fail，共 4828 tests / 366 files。
  - 全部 isolated 测试：280 pass，0 fail。
  - 合计：5089 pass，19 skip，0 fail。
- 定向回归：
  - server-core Admin handler：54 pass，0 fail。
  - Electron Admin/Local Apps production wiring：15 pass，0 fail。
  - scoped local app runtime registry：18 pass，0 fail；包含 1,000/10,000 撤下规模测试。
- `bun run typecheck:all`
  - 全部 workspace 类型检查通过。
- 本轮 Electron 变更文件定向 ESLint
  - 0 error，0 warning。
- `bun run lint:i18n:parity && bun run lint:i18n:sorted && bun run lint:i18n:coverage`
  - 通过；6 个 locale 各 1706 keys，排序和覆盖检查通过。
- `bun run electron:build:main`
  - 主进程生产构建和产物校验通过。
- `git diff --check`
  - 通过。

## 遗留问题

- 未发现本轮两个阻塞问题的已知代码遗留。
- 仓库根级 lint 仍依赖当前 checkout 中不存在的 `scripts/check-raw-sends.sh` 与 `scripts/check-task-tool-checks.sh`；本轮相关文件的定向 ESLint、全量类型检查、全量测试和主进程构建均已通过。
