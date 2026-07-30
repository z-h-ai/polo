# POL-51 实现报告

## 变更摘要

- 在 shared 层新增统一的账号／组织上下文 key：使用可逆 JSON tuple 编码，renderer、Catalog access mode 与 server-core 共用同一实现；server-core 同时保留结构化 scope 元组，账号级授权关闭与离线切换不再解析字符串前缀，避免 NUL、冒号、Unicode 和长 ID 造成碰撞或串号。
- 新增共享的 Local App 状态去能力化投影，并统一应用于 `GET_INSTALLED_APPS`、`GET_RUNTIME_STATUS`、`GET_RUNTIME_STATUSES` 和 `STOP`。denied 或 withdrawn App 仍保留真实本地状态及 STOP、UNINSTALL 管理闭环，但 IPC 不再返回 `availableRelease` 中的下载地址、checksum、包大小、平台或架构；App 撤下的内存 lifecycle fence 在新 Catalog 落盘前也会立即关闭状态元数据。
- 收紧 Catalog 304 契约：仅“authorized 缓存 + 非 force + 实际携带 appConfigVersion”的请求可以接受 `notModified`。denied、无缓存或 force full-fetch 收到异常 304 时立即 fail closed，保持 denied access mode，并只向 renderer 返回清洗后的 denied Catalog。
- 补充共享层、server-core 与 Electron production-wiring 回归测试，覆盖碰撞型实体 ID、三类状态 RPC 的交付元数据清洗、denied cache 异常 304、force refresh 异常 304，以及 full-fetch 测试桩的真实协议行为。

## 关键文件列表

- `packages/shared/src/admin/context-key.ts`
- `packages/shared/src/admin/__tests__/context-key.test.ts`
- `packages/shared/src/admin/app-catalog-access.ts`
- `packages/shared/src/admin/__tests__/app-catalog-access.test.ts`
- `packages/shared/src/admin/index.ts`
- `packages/shared/package.json`
- `packages/shared/src/protocol/local-apps.ts`
- `packages/shared/src/protocol/__tests__/local-apps.test.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/lib/organization-storage.ts`

## 自测结果

- `bun run test`：通过；标准测试 4,824 passed、19 skipped、0 failed，随后全仓全部 `*.isolated.ts` 测试通过。
- `bun run validate:ci`：通过；包含全仓 TypeScript、shared/doc-tools 测试，以及 6 个 locale、每个 1,706 keys 的 parity、sorted 和 coverage 检查。
- `cd apps/electron && bun run lint`：通过；0 errors，保留仓库既有 131 warnings。
- `bun run electron:build:main`：通过。
- `bun run electron:build:renderer`：通过；仅输出既有 chunk size 提示。
- 定向回归：
  - shared context key、Catalog access mode 与 Local App 状态投影：6 passed。
  - server-core Admin handler：57 passed、317 assertions。
  - Electron Admin session/local-app production wiring：20 passed、150 assertions。
  - Electron Local Apps IPC 授权边界：20 passed、129 assertions。
- `git diff --check`：通过。

## 遗留问题

- 本任务范围内无已知功能遗留。
- HomePage 测试仍输出既有 Radix `DialogOverlay` ref 警告；不影响测试结果，且本次未修改对应通用 UI 组件。
