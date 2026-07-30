# POL-51 实现报告

## 变更摘要

- 修复 denied Catalog 冷启动恢复：当主进程返回 `NETWORK_ERROR`、`accessMode = denied` 且携带与当前账号和组织匹配的清洗 Catalog 时，renderer 进入 denied hydration，恢复不可用卡片并批量读取真实本地状态；安装、更新和启动继续 fail closed，日志、停止和卸载保持可达。
- 将持久化 `scope.json` 读取接入 registry 级共享 I/O 信号量。并发的 `stopApps`、`stopOrganization`、`stopAccount` 扫描共同受 `PERSISTED_SCOPE_READ_CONCURRENCY = 8` 上限约束，不再只有单次扫描内部限流。
- 将批量撤下清理从整批共享一个结果改为完整 App scope 独立结果。健康 App 清理成功后可独立恢复授权；同批其他 App 清理失败时只保留失败 App 的 deny gate。
- 增加 denied `NETWORK_ERROR` hook/HomePage、1,000 个并发组织扫描聚合 I/O 上限、同批 App 一成一败并发重新授权的确定性回归测试。

## 关键文件列表

- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`

## 自测结果

- `bun run test`：通过；项目标准测试与全部 `*.isolated.ts` 测试均通过。
- `bun run validate:ci`：通过；全包 TypeScript、shared 配置测试、文档工具测试、i18n parity/sorted/coverage 全部通过。
- `bun test apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`：20/20 通过。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`：26/26 通过。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`：10/10 通过。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`：15/15 通过。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`：18/18 通过。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`：54/54 通过。
- `apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts` 连续复跑 3 次：每次 29/29 通过。
- `bun run lint:electron`：通过，0 error；输出仓库既有 131 个 warning。
- `git diff --check`：通过。

## 遗留问题

- 根级 `bun run lint` 仍被仓库当前缺失的 `scripts/check-raw-sends.sh` 和 `scripts/check-task-tool-checks.sh` 阻断；这两个路径未被 Git 跟踪，非本次改动造成。
- 单独执行 `bun run lint:shared` 仍有既有的 5 个 `craft-shared/no-inline-source-auth-check` error，位置在 shared resource/token-refresh 代码与测试，均不在本次变更范围。
