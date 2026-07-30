# POL-51 实现报告

## 变更摘要

- 会话结束改为在 Admin session coordinator 的同一互斥区内先推进不可复用 generation，并立即关闭当前账号全部 Catalog access/cache、推进授权 epoch；远程登出和本地进程清理等慢操作移到锁外，最终凭据删除继续使用 ending snapshot CAS。退出清理挂起期间，公开 Catalog／本地 App 操作立即 fail closed；账号 A 的迟到清理不会影响后来登录的账号 B。
- 显式 401/403 等失权结果开始清理后，并发中的旧 Catalog 成功响应会因 session generation 或授权 epoch 失效而返回 `SESSION_CHANGED`，不能提交缓存或把 access mode 恢复为 online。
- renderer 将账号／组织／授权上下文的 `contextGeneration` 与 Catalog 请求乱序控制的 `syncGeneration` 分离。本组织普通刷新只淘汰旧同步响应，不再淘汰已通过上下文校验的安装、启动、停止、卸载和日志操作；跨账号、跨组织的迟到结果仍被丢弃。
- shared 层新增唯一严格 SemVer 2.0 规范化与比较实现，Catalog cache、Electron 主进程和 renderer 共同复用。兼容前导 `v`，正确处理 prerelease/build，拒绝第四段和非法输入，并以字符串长度和字典序比较超出 JavaScript 安全整数范围的数字标识符。
- 新增会话结束时序、同组织刷新期间 deferred start，以及大数字 SemVer 跨层一致性回归测试。

## 关键文件列表

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `packages/shared/src/admin/semver.ts`
- `packages/shared/src/admin/__tests__/semver.test.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`
- `packages/shared/src/admin/index.ts`
- `packages/shared/package.json`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`

## 自测结果

- 最新完整默认测试 `bun test`：`4789 pass, 19 skip, 0 fail`，共 364 个测试文件。
- POL-51 定向测试：`101 pass, 0 fail`。其中 shared SemVer/cache 与 renderer 版本测试 `21 pass`，Admin 会话/Catalog isolated `50 pass`，renderer Catalog 交互 isolated `15 pass`，主进程 Local App 授权 isolated `15 pass`。
- 完整测试首次运行时，POO-12 既有进程树清理时序用例出现一次瞬时失败；该文件单独重跑 `29 pass, 0 fail`，随后完整测试重跑为上述 `4789 pass, 0 fail`。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`：通过，`0 error`；报告 128 个既有 warning。
- `bun run lint:i18n:parity`：通过，6 个 locale 各 1707 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:renderer`：通过；仅有既有 Vite chunk size warning。
- `git diff --check`：通过。

## 遗留问题

- 未连接真实 POL-52 服务、生产对象存储和签名 Bundle 做端到端联调；当前以确定性 RPC mock、缓存／运行状态测试、全仓测试、类型检查和 Electron 生产构建验证。
- 本轮不涉及 UI 结构或新增文案；需求快照未启用 `ui_fidelity=true` 或 `visual_acceptance_required=true`，未新增选择器或执行视觉验收。
- 未发现 Reviewer 最新三项裁决范围内的已知代码遗留问题。
