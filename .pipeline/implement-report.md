# POL-51 实现报告

## 变更摘要

- 收口 renderer 可调用的 Local Apps IPC/RPC 边界：公开安装、启动、停止、重启、取消、卸载、状态、日志等接口只接受完整 `CatalogLocalAppScope`。`kind = legacy` 在进入凭据、Catalog 缓存或运行管理器前统一返回 `NOT_AUTHORIZED`，因此登录态、受限离线、明确失权和已登出场景都不能借 legacy 身份绕过组织授权。
- 将 Electron renderer API 和公开安装协议同步收窄为 Catalog-only。POO-12 的 `LocalAppRuntimeManager` 及 legacy 请求类型继续保留在主进程内部兼容层，不再由 renderer RPC 分发到达；运行管理器原有非 Catalog 安装、启动、停止、更新与卸载能力保持兼容。
- 将 500ms busy 状态刷新从固定 `setInterval` 改为共享在途槽位的 single-flight `setTimeout` 循环。busy 集合变化会推进 loop generation；每次请求另带 request generation 和提交 guard，上一轮完成前不会发起下一轮，失效响应不能回写状态。
- 补充并发不变量注释与确定性回归测试：覆盖伪造 legacy install/start 在 online、offline、denied、signed-out 四类上下文中的 fail-closed，以及可控延迟下 busy 轮询最大并发为 1、旧响应不提交。

## 关键文件列表

- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/transport/__tests__/channel-map-parity.test.ts`
- `packages/shared/src/protocol/local-apps.ts`

## 自测结果

- `bun run test`：通过。常规测试与仓库脚本逐文件执行的全部 `*.isolated.ts` 均为 0 fail。
- Local Apps 主进程授权边界：`17 pass, 0 fail`。
- renderer Catalog 版本／状态／single-flight 单测：`8 pass, 0 fail`。
- renderer Catalog 交互 isolated：`15 pass, 0 fail`。
- transport channel-map：`5 pass, 0 fail`。
- POO-12 `LocalAppRuntimeManager` 兼容与生命周期测试：`29 pass, 0 fail`。
- Scoped Registry：`13 pass, 0 fail`；Admin session/Catalog isolated：`50 pass, 0 fail`。
- HomePage 离线启动与第二轮交互、OrganizationAppCard、shared SemVer/cache、IPC channel 定向测试均通过。两个 Happy DOM isolated 文件不能在同一 Bun 进程重复注册全局 DOM，已按仓库全量脚本的逐文件方式分别执行并通过。
- `bun run typecheck:all`：通过。
- 变更文件定向 ESLint：通过；`bun run lint:electron` 为 `0 error, 128 warnings`，均为仓库既有 warning。
- `bun run lint:i18n:parity`、`bun run lint:i18n:sorted`、`bun run lint:i18n:coverage`：通过。
- `bun run electron:build:main`、`bun run electron:build:renderer`：通过；renderer 仅有既有 chunk size warning。
- `git diff --check`：通过。

## 遗留问题

- 未连接真实 POL-52、对象存储与签名 Bundle 做端到端安装联调；本轮以主进程 RPC 边界、真实本地运行管理器回归、renderer 确定性并发测试及生产构建覆盖。
- 本轮不修改 UI 结构或用户文案，无新增视觉验收项。
- 未发现 Reviewer IPC 边界补充裁决范围内的已知代码遗留问题。
