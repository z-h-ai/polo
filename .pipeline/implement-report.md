# POL-51 实现报告

## 变更摘要

- 完成 Reviewer 第五轮会话竞态收口。通用 `auth.LOGOUT` 与 Admin 登录、校验、刷新、登出共用同一个 session coordinator；退出先捕获不可复用的 generation，账号级进程清理在锁外完成，最终凭据、Catalog 和配置清理由同一 CAS 提交。账号 A 清理迟到时返回 `SESSION_CHANGED`，不会枚举或删除账号 B 的凭据。
- 为 `VALIDATE` 和 `SYNC_APP_CATALOG` 的受限离线路径增加最终会话 CAS。离线身份、access mode 和缓存响应均在确认 generation 未变化后才构造；旧账号 continuation 迟到时只返回 `SESSION_CHANGED`。renderer 遇到该结果会重新读取当前可信会话，不会把旧请求当作真实登出。
- 为每个 `accountId + organizationId` 的 Catalog 同步增加按调用顺序递增的请求代次。成功、授权失败、离线降级和普通失败均在会话锁内检查最新代次；较旧响应只能读取已提交的新缓存，不能覆盖新版本、恢复已撤下 App 或改变最新 access mode。
- 初次运行状态读取不再把完整 Catalog 截断到 10,000 项，而是按主进程 RPC 的 10,000 项上限分批、顺序读取并合并。`10,000 visible + 1 installed withdrawn` 和 `10,000 visible + 10,000 withdrawn` 均能保留真实状态、日志/停止/卸载入口；500ms busy 轮询仍保持 32 项上限。
- 保持前四轮已完成的主进程授权 Release 绑定、三元 scope 隔离、受限离线启动、SemVer 可见错误、国际化和 POO-12 生命周期兼容实现不变。

## 关键文件列表

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/auth.ts`
- `packages/server-core/src/handlers/rpc/index.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`

## 自测结果

- POL-51/POO-12 相关普通测试：`108 pass, 0 fail`。覆盖 Catalog cache/client/schema、Local App manager/scoped registry、版本与卡片状态。
- 相关 isolated 测试：`63 pass, 0 fail`。其中 Admin 会话与 Catalog 为 `43 pass`，主进程批量状态为 `8 pass`，renderer scope/批量状态为 `9 pass`，HomePage 交互为 `3 pass`。
- 新增确定性回归覆盖：
  - 账号 A 通用退出清理挂起、账号 B 登录成功、A 清理迟到。
  - A 的在线校验、过期 token 离线刷新和离线 Catalog continuation 在 B 登录后返回 `SESSION_CHANGED`。
  - 同一账号/组织的 Catalog v1 挂起、v2 先提交、v1 后返回，最终缓存和授权保持 v2。
  - `10,000 visible + 1 installed withdrawn` 分为 `10,000 + 1` 两批并保留 withdrawn 真实运行状态。
  - 最大 `10,000 visible + 10,000 withdrawn` 边界分为两个 10,000 项批次并完整合并。
- `bun run typecheck:all`：通过。
- `bun run lint:i18n:parity`：通过，6 个 locale 各 1703 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- 修改过的 Electron 文件执行 ESLint：通过，0 error；仅报告 `App.tsx` 中 8 个既有 hooks warning。
- `bun run electron:build:main`：通过。
- `bun run electron:build:renderer`：通过；仅有既有 Vite chunk size warning。
- `git diff --check`：通过。

## 遗留问题

- 未连接真实 POL-52 服务、生产对象存储和签名 Bundle 做端到端联调；当前以 AdminClient/RPC mock、临时本地运行目录、renderer 交互测试、全仓类型检查及 Electron 生产构建验证。
- 本次未做视觉验收；需求快照未启用 `ui_fidelity=true` 或 `visual_acceptance_required=true`，且第五轮改动不改变首页视觉结构。
- 未发现第五轮裁决范围内的已知代码遗留问题。
