# POL-51 第 4 轮 Review 修复报告

## 每条 issue 的处理结果

### 1. 组织明确失权未封锁已进入的本地生命周期操作

已修复。

- `ScopedLocalAppRuntimeRegistry` 新增 `accountId + organizationId` 级 lifecycle generation、同步 denied fence、在途操作集合与去重清理 Promise。
- 组织失权时，`denyCatalogScope()` 会先推进 Catalog authorization epoch 并关闭内存 access mode，然后立即调用生产接线的 `stopOrganization()`；该调用在任何 manager、文件系统或操作等待前同步推进组织 lifecycle generation 并建立 fence，慢停止／取消在锁外继续。
- 安装、启动、重启及其他 scoped runtime 操作进入时同时捕获账号与组织 generation，manager 成功或失败返回后都再次校验；撤权后的迟到结果统一转为 `NOT_AUTHORIZED`。
- 组织清理只取消和停止该账号、该组织的安装任务与运行实例，不影响同账号其他组织。
- 新增真实 Admin handler、Local Apps handler 与 `ScopedLocalAppRuntimeRegistry` 接线竞态测试：覆盖 deferred START 遇到 `LIST_ORGANIZATIONS` 成员移除，以及 deferred INSTALL 遇到 Catalog `NOT_FOUND`。两者均不能提交成功，产生的进程被停止、安装任务被取消。

### 2. renderer 多来源状态读取可被旧响应乱序覆盖

已修复。

- `useAppCatalog` 新增按完整 scope 隔离的单调 status-read generation。
- Catalog 全量读取、START/STOP 等生命周期完成刷新和 busy poll 共用同一代次；每轮读取开始即登记 token，提交时只接收仍为该 scope 最新 token 的结果。
- replace 批量中仅失效的 scope 保留当前可信状态，其他仍为最新的 scope 正常合并；旧请求也不能清除新请求维护的 loading/error 状态。
- START 在 finally 刷新后再次校验 lifecycle action generation，STOP 已成为更新意图时，迟到 START 不返回 localhost URL。
- 新增确定性竞态测试：全量状态读取、START-finally 和 STOP-finally 同时挂起，STOP 的 `stopped` 先提交后，两个旧 `running` 响应依次返回仍不能覆盖最终状态。

### 3. 受限离线 broken Bundle 错误显示“重试”

已修复。

- `OrganizationAppCard.primaryActionFor()` 在 `offline + broken` 时返回 `unavailable`，主按钮因此显示不可用并禁用，不再触发主进程必然拒绝的 START。
- 新增组件决策测试，同时验证在线 broken 仍保留“重试”。

### 4. Home App 文案重复 common 翻译键

已修复。

- `AddAppDialog`、`OrganizationAppCard`、安装确认和卸载弹窗改用 `common.cancel/open/retry/unavailable/name/url`。
- 从全部 locale 删除无上下文差异的六组 `homeApps` 重复键。
- locale parity、排序和 literal coverage 检查全部通过。

## 关键文件

- `packages/server-core/src/handlers/handler-deps.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/AddAppDialog.tsx`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/components/tab-browser/__tests__/OrganizationAppCard.test.ts`
- `packages/shared/src/i18n/locales/*.json`
- `.pipeline/fix-report-round4.md`

## 自测命令与结果

- `bun test`
  - 结果：4796 pass、19 skip、0 fail，共 4815 tests / 365 files。
- 逐文件执行仓库全部 `*.isolated.ts`
  - 结果：19 个 isolated 测试文件全部通过。
  - 关键套件：Admin 生产接线 8 pass；Local Apps 授权边界 17 pass；renderer Catalog 交互 18 pass；server-core Admin 50 pass。
- `bun test apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts apps/electron/src/renderer/components/tab-browser/__tests__/OrganizationAppCard.test.ts`
  - 结果：22 pass、0 fail。
- `bun run typecheck:all`
  - 结果：通过。
- `bun run lint:electron`
  - 结果：0 error、128 个仓库既有 warning。
- `bun run lint:i18n:parity && bun run lint:i18n:sorted && bun run lint:i18n:coverage`
  - 结果：通过；6 个附加 locale 与英文基准均为 1702 keys，排序和 literal coverage 正常。
- `bun run electron:build:main && bun run electron:build:renderer`
  - 结果：主进程与 renderer 生产构建通过；仅有既有的大 chunk 非阻断警告。
- `git diff --check`
  - 结果：通过。

## 遗留问题

- 未发现本轮 4 条 review issue 的已知代码遗留。
- 未连接真实 POL-52 与签名 Bundle 做端到端撤权联调；本轮以真实主进程生产接线、scoped runtime registry 和确定性并发测试覆盖。
