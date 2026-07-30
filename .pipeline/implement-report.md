# POL-51 实现报告

## 变更摘要

- Admin session coordinator 将账号清理 Promise 与会话 generation 绑定并按账号去重。账号 A 的退出清理挂起时，账号 B 登录只在锁内关闭 A 的 Catalog 授权并完成会话 CAS，不再等待同一个慢 `stopAccount(A)`；A 的迟到清理仍由旧 ending snapshot CAS 隔离，不能删除 B 的凭据或恢复 A 的授权。
- Scoped Local App Registry 新增账号生命周期 generation。安装、启动、重启等已进入操作在 manager 返回后再次校验；若期间开始 logout／明确失权，公开调用统一返回 `NOT_AUTHORIZED`，迟到启动产生的进程继续由同一账号清理链路停止。重复 `stopAccount` 复用同一清理任务。
- Shared Catalog SemVer 解析不再调用 `trim()`。仅保留单个前导 `v` 兼容，首尾空白在 cache、主进程、renderer 和 Catalog runtime 各层一致判为 `invalid_semver`／`INVALID_REQUEST`。
- 为 renderer 的 context/sync 双 generation、分批状态失败合并和 500ms busy 轮询上限补充并发不变量注释。
- 补充慢账号清理与新账号登录、deferred start 遇到 logout、清理去重、首尾空白 SemVer 跨层一致性回归测试。

## 关键文件列表

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `packages/shared/src/admin/semver.ts`
- `packages/shared/src/admin/__tests__/semver.test.ts`
- `packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts`

## 自测结果

- `bun run test`：通过。默认测试 `4791 pass, 19 skip, 0 fail`，共 364 个测试文件；随后仓库脚本串行执行全部 `*.isolated.ts`，全部通过。
- POL-51 定向测试：shared SemVer/cache `15 pass`；Scoped Registry `13 pass`；主进程 Local App isolated `16 pass`；Admin session/Catalog isolated `50 pass`；renderer 版本测试 `7 pass`；renderer Catalog 交互 isolated `15 pass`，均为 `0 fail`。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`：通过，`0 error`；报告 128 个既有 warning。
- `bun run lint:i18n:parity`：通过，6 个 locale 各 1707 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:renderer`：通过；仅有既有 Vite chunk size warning。
- `git diff --check`：通过。

## 遗留问题

- 未连接真实 POL-52 服务、生产对象存储和签名 Bundle 做端到端联调；本轮以确定性 RPC／生命周期时序测试、全仓测试、类型检查和 Electron 生产构建验证。
- 本轮不涉及 UI 结构或新增用户文案，未执行视觉验收。
- 未发现本轮 Reviewer 生产接线补充裁决范围内的已知代码遗留问题。
