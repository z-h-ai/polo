# POL-51 第 1 轮修复报告

## 阻塞问题处理结果

### 1. denied / withdrawn 本地 App 日志管理闭环

- 已修复。
- `GET_LOGS` 继续先校验可信 Admin 会话、完整 Catalog scope 和本地 Bundle 类型。
- 正常获授权且仍在目录中的 App 继续只在 `broken` 故障恢复状态开放日志，避免把普通运行日志暴露为常规成员功能。
- denied、withdrawn 或已建立 App deny fence 的保留安装现在可在 `installed`、`running`、`stopped`、`broken`、`update_available` 状态读取有界日志尾部。
- 保留安装日志读取使用现有 manager 的 `tail` 上限，并在读取前后复核 runtime generation、安装任务和生命周期队列；并发启动、停止、更新后不会提交旧日志快照。
- scoped registry 只加载已有 `scope.json + metadata.json` 的安装记录。未安装 App 不会创建 manager、目录或持久化记录，并返回 `NOT_AUTHORIZED`。
- renderer 对 denied / withdrawn 的 installed-like 状态展示“查看日志”；正常可用且健康的 App 仍不显示该入口。
- INSTALL、UPDATE、START、RESTART、远程 URL 与 Release 交付元数据的既有 fail-closed 行为保持不变。

## 关键文件

- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/local-app-runtime/manager.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/OrganizationAppCard.test.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`

## 自测结果

- 定向 main / runtime / registry / card 测试：86 passed、0 failed。
- `HomePage.round2.interaction.isolated.ts`：14 passed、0 failed。
- `cd apps/electron && bun run typecheck`：通过。
- 本轮修改文件 ESLint：0 errors；仅 4 个测试迁移代码中的既有 `localStorage` warning。
- `bun run test`：全量测试通过。
- `bun run validate:ci`：通过（全包类型检查、shared/config/doc-tools 测试与 i18n parity/sorted/coverage）。
- `git diff --check`：通过。

## 遗留问题

- 本轮阻塞问题无已知遗留。
- HomePage 测试仍输出仓库既有 React `act(...)` 与 Radix ref warning，不影响断言结果。
