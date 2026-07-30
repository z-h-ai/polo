# POL-51 实现报告

## 变更摘要

- 拆分 Catalog 组织上下文 RPC 与组织管理 RPC 的 ID 校验：Catalog 接受非空、最长 512 字符且可包含冒号和 Unicode 的 Admin 实体 ID；既有组织管理写接口继续保持 UUID 约束。
- 新增共享的 denied Catalog 投影类型与严格 schema。明确失权及 `denied + NETWORK_ERROR` 返回只保留卡片、完整 scope 和本地数据管理所需字段，不再暴露 `remoteUrl`、Release 下载地址、checksum、权限或 trusted releases。
- 分离持久化可信 Catalog 与 renderer denied 投影：内部缓存仍保留后续授权恢复所需的可信元数据，所有 IPC 返回在边界统一去能力化。
- 补充 production wiring、主进程、renderer hook 与 HomePage 回归测试，覆盖复杂组织 ID、冷启动 denied hydration，以及日志、STOP、UNINSTALL 可达但 INSTALL、UPDATE、START、RESTART 不可构造的闭环。

## 关键文件列表

- `packages/shared/src/admin/schemas.ts`
- `packages/shared/src/admin/types.ts`
- `packages/shared/src/admin/authorization-failure.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `packages/shared/src/admin/__tests__/schemas.test.ts`
- `packages/shared/src/admin/__tests__/authorization-failure.test.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`

## 自测结果

- `bun run test`：通过；标准测试 4,819 passed、19 skipped、0 failed，随后全部 `*.isolated.ts` 测试通过。
- `bun run validate:ci`：通过；包含全仓 TypeScript、shared/doc-tools 测试、6 个 locale 的 1,706 keys parity、排序与 coverage 检查。
- `bun run lint:electron`：通过；0 errors，保留仓库既有 131 warnings。
- `bun run electron:build:main`：通过。
- `bun run electron:build:renderer`：通过；仅有既有 chunk size 提示。
- 定向回归：
  - shared Catalog schema / denied projection / cache：21 passed。
  - server-core Admin production handler：55 passed。
  - Electron Admin session/local-app production wiring：20 passed。
  - renderer `useAppCatalog`：28 passed。
  - renderer `HomePage`：12 passed。
- `git diff --check`：通过。

## 遗留问题

- 本任务范围内无已知功能遗留。
- HomePage 测试仍输出既有 Radix `DialogOverlay` ref 警告；不影响测试结果，且本次未修改对应通用 UI 组件。
