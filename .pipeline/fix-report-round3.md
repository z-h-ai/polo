# POL-51 第 3 轮 Review 修复报告

## 每条 issue 的处理结果

### 1. 冷启动缓存 scope 未登记时，账号 ending 门禁可能失效

已修复。

- 在 shared Catalog access 状态中增加独立的账号级进程内 denied gate。`denyAppCatalogAccessForAccount()` 会先关闭账号下所有已登记和未登记 scope；后续单 scope 的 `online` 写入也不能覆盖该账号门禁。
- 只有完成可信登录并成功持久化新会话后，主进程才调用 `resumeAppCatalogAccessForAccount()` 重新开放账号；各组织仍保持默认 `offline`，直到各自 Catalog 同步成功。
- denied gate 不依赖 Catalog 缓存写入、scope 枚举或 runtime cleanup 完成，因此磁盘 authorized cache、无内存 access mode、denied-cache 写失败和慢 cleanup 同时出现时仍 fail closed。
- 新增 shared gate 单测和真实 Admin/Local Apps/scoped registry 接线测试。测试覆盖 cleanup 挂起窗口内 `RESOLVE_REMOTE_URL` 与离线 `START` 均返回 `NOT_AUTHORIZED`，且 runtime manager 未创建。

### 2. STOP 后迟到 START 仍可能返回 localhost URL

已修复。

- renderer 为每个完整 scope 增加 lifecycle action generation。
- START 进入时捕获当前代次，主进程返回后、结果对外提交前再次校验。
- STOP 与卸载在发送 RPC 前推进该 scope 代次，因此更早进入的 START 即使迟到成功，也只能转为 stale-context 失败，不能把 URL 交给 HomePage 打开。
- 更新 deferred START/STOP 确定性测试：STOP RPC 真实发送并完成后，迟到 START 的公开 Promise 必须 rejected。

### 3. 首次 runtime status 未返回时短暂暴露“安装”

已修复。

- `useAppCatalog` 新增按完整 scope 隔离的 `statusLoadingScopeKeys`。
- Catalog 元数据提交后，本地 Bundle App 在首次批量状态读取完成前保持 unknown/loading；成功或明确失败都会清除对应 loading 标记。
- `HomePage` 将该状态传给 `OrganizationAppCard`，卡片显示国际化“正在读取状态”并禁用主操作，不再把缺失状态折叠成 `not_installed`。
- 新增 hook deferred 批量状态测试、主操作决策测试和实际 HomePage 禁用按钮交互测试。
- `homeApps.status.loading` 已补齐全部 locale，并通过 parity、sorted、coverage 检查。

### 4. 无效 SemVer 的可信 Release 保留不变量缺少说明

已处理。

- 在主进程 `deriveCatalogReleaseStatus()` 无效版本分支补充 why 注释：无效服务端元数据必须保持可见且不能清除上一可信更新；仅 installed/stopped/update_available 状态可把可信更新提升为主状态，running/busy/broken 保留当前生命周期状态。

## 关键文件

- `packages/shared/src/admin/app-catalog-access.ts`
- `packages/shared/src/admin/index.ts`
- `packages/shared/src/admin/__tests__/app-catalog-access.test.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/OrganizationAppCard.test.ts`
- `packages/shared/src/i18n/locales/*.json`
- `.pipeline/fix-report-round3.md`

## 自测命令与结果

- `bun test`
  - 结果：4794 pass，19 skip，0 fail，共 4813 tests / 365 files。
- `for f in $(find . -name '*.isolated.ts' -not -path './node_modules/*'); do bun test "./${f#./}" || exit 1; done`
  - 结果：仓库全部 isolated 测试逐文件通过。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 结果：6 pass，0 fail。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
  - 结果：17 pass，0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 结果：7 pass，0 fail。
- `bun test packages/shared/src/admin/__tests__/app-catalog-access.test.ts apps/electron/src/renderer/components/tab-browser/__tests__/OrganizationAppCard.test.ts`
  - 结果：8 pass，0 fail。
- `bun run typecheck:all`
  - 结果：通过。
- `bun run lint:i18n:parity && bun run lint:i18n:sorted && bun run lint:i18n:coverage`
  - 结果：通过；全部 locale 为 1708 keys，排序与覆盖检查通过。
- Electron 本轮变更文件定向 ESLint
  - 结果：0 error；仅测试文件 3 个既有 `localStorage` warning。
- shared 本轮变更文件定向 ESLint
  - 结果：0 error，0 warning。
- `bun run electron:build:main && bun run electron:build:renderer`
  - 结果：主进程与 renderer 生产构建通过；renderer 仅有既有 chunk size warning。
- `git diff --check`
  - 结果：通过。

## 遗留问题

- `bun run lint:shared` 仍被 5 个与 POL-51 无关的仓库既有规则错误阻断，位于 resource bundle / token refresh 文件；本轮未修改这些文件。本轮涉及的 shared 文件定向 ESLint、全量类型检查和全量测试均通过。
- 未发现本轮 4 条 review issue 的已知代码遗留。
