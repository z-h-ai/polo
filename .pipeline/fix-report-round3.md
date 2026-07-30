# POL-51 第 3 轮阻塞审查修复报告

## 逐条处理

### 1. HTTP 401 优先结束账号，并统一主进程与 renderer 分类

已修复。

- 新增 shared 授权失败分类器，主进程与 renderer 共同复用，避免 Catalog 与通用组织 RPC 的判断漂移。
- 分类器首先检查原始 HTTP 401；即使响应 body 为 `FORBIDDEN`、`MEMBERSHIP_REMOVED` 或未知错误码，也统一判定为账号会话失效。
- Catalog 的 HTTP 403、成员移除/暂停、组织不可用等仍只关闭对应 Catalog scope；账号会话保持有效。
- 通用组织 RPC 继续 fail closed：HTTP 401/403 和明确组织授权失败会进入可信账号清理链。
- 新增 shared、renderer 与主进程测试，覆盖 401 与三类冲突 body、Catalog scope denial、组织列表与组织创建 RPC。

### 2. 首次 Catalog 失权时恢复清洗缓存和真实本地状态

已修复。

- Catalog scope denial 现在返回清洗后的最后可信 Catalog：`authorizationStatus = denied`，全部可见与 retained App 标记为 `unavailable`。
- denied-cache 持久化失败时仍返回进程内清洗快照；不会因为磁盘上保留旧 authorized cache 而恢复生命周期授权。
- 已 denied 的 Catalog 后续遇到网络错误时继续返回 denied 快照，不会切换为可启动的离线授权。
- renderer 首次装载失败响应时校验完整账号/组织上下文，接收 denied Catalog，并立即通过批量状态 RPC 读取真实安装/运行状态。
- denied App 的状态、日志、停止、卸载保持可用；安装、更新、启动、重启保持 fail closed。
- 新增首次 `FORBIDDEN`、首次 `MEMBERSHIP_REMOVED`、renderer 重建、真实批量状态与数据管理回归。

### 3. 组织列表失去当前组织时保留只读 tombstone 管理区

已修复。

- 新增与“最近验证授权上下文”分离的账号级 unavailable organization tombstone；不会把失权组织写回可离线授权的 active organization 缓存。
- 组织列表成功返回且当前组织被移除或暂停时，保留同一组织上下文作为只读 tombstone，使 HomePage 能继续装载 denied Catalog 和本地 App 管理入口。
- renderer 重建或后续网络离线时可恢复 tombstone；后续列表重新确认成员有效后才清除 tombstone并恢复正常组织上下文。
- Organization Switcher 与 onboarding 过滤 tombstone：失权组织不可选择，组织管理入口不可打开；HomePage 仍保留状态、日志、停止、卸载入口。
- production wiring 回归验证组织列表移除后账号 token 保留，批量状态/日志/停止/卸载可用，而安装/更新/启动/重启均返回 `NOT_AUTHORIZED`。

## 关键文件

- `packages/shared/src/admin/authorization-failure.ts`
- `packages/shared/src/admin/__tests__/authorization-failure.test.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/admin/types.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/lib/admin-auth-failure.ts`
- `apps/electron/src/renderer/lib/organization-storage.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/useOrganizationContext.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/hooks/__tests__/useOrganizationContext.isolated.ts`
- `apps/electron/src/renderer/components/organization/OrganizationSwitcher.tsx`
- `apps/electron/src/renderer/components/organization/OrganizationOnboarding.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/OrganizationAccess.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
- `apps/electron/src/renderer/App.tsx`

## 自测结果

- `bun run test`
  - 全量通过。
  - 常规测试：4807 pass，19 skip，0 fail，共 4826 tests / 366 files。
  - 全部 isolated 测试：278 pass，0 fail。
  - 合计：5085 pass，19 skip，0 fail。
- `bun run typecheck:all`
  - 全部 workspace 类型检查通过。
- 定向回归：
  - shared authorization + Admin client：38 pass，0 fail。
  - server-core Admin production handler：53 pass，0 fail。
  - Electron Admin/Local Apps production wiring：14 pass，0 fail。
  - `useAppCatalog`：25 pass，0 fail。
  - `useOrganizationContext`：13 pass，0 fail。
  - Organization access interaction：7 pass，0 fail。
  - HomePage round-two interaction：10 pass，0 fail。
- `bun run lint:i18n:parity && bun run lint:i18n:sorted && bun run lint:i18n:coverage`
  - 通过；6 个 locale 各 1706 keys，排序和覆盖检查通过。
- 本轮 Electron 变更文件定向 ESLint
  - 0 error；20 个既有规则 warning（App hooks 与 organization storage/localStorage 规则）。
- 本轮 shared 变更文件定向 ESLint
  - 0 error，0 warning。
- `git diff --check`
  - 通过。

## 遗留问题

- 仓库根级 `bun run lint` 在执行实际 ESLint 前被缺失的既有脚本 `scripts/check-raw-sends.sh` 阻断（exit 127；`scripts/check-task-tool-checks.sh` 同样不存在）。本轮定向 ESLint、全量类型检查和全量测试均已通过。
- 未发现本轮三个 major 问题的已知代码遗留。
