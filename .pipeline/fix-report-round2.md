# POL-51 第 2 轮修复报告

## 阻塞问题处理结果

### 1. retained 日志在 App 重新授权后的迟到提交

- 已修复。
- 主进程 `GET_LOGS` 在 retained 日志尾部读取完成后，重新读取当前 Catalog、access mode 与 App deny fence。
- 若读取期间 withdrawn / denied App 已恢复 delivery access，旧 retained 请求统一返回 `NOT_AUTHORIZED`，不向 renderer 提交健康运行日志。
- 正常 available App 仍走原有 broken-only failure-recovery 日志校验；denied / withdrawn 管理闭环保持可用。
- renderer 的日志读取同时记录请求进入时的 delivery / retained 能力，并在 RPC 返回后与当前同 scope Catalog App 复核；同组织刷新重新收录 App 后，旧结果按 stale context 丢弃。
- 新增确定性 production-wiring 测试：withdrawn App 的 retained 日志读取挂起，Catalog v3 重新收录并释放 deny fence，迟到日志必须失败。
- 新增 renderer hook 回归：同组织重新授权后，挂起的 retained 日志结果不得返回。

### 2. denied / withdrawn `GET_INSTALLED_APPS` 投影过宽

- 已修复。
- `LocalAppRestrictedInstalledApp` 收窄为 `appId`、完整 `scope`、`currentVersion` 与 `status`。
- restricted 投影移除 `name`、`previousVersion`、`versions`、`runtime`、`installedAt` 和 `availableRelease` 等非管理闭环字段。
- 投影函数增加条件返回类型，调用方在 `false` 权限分支只能获得 restricted DTO，避免类型层继续宣称完整安装元数据可用。
- denied 403 与 withdrawn production IPC 测试均使用精确对象断言，确认 runtime、版本列表、安装时间、私有 Release 下载信息不会泄露；日志、STOP 和 UNINSTALL 所需 scope / 状态仍保留。

## 关键文件

- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/shared/types.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `packages/shared/src/protocol/__tests__/local-apps.test.ts`

## 自测结果

- shared protocol、main handler 与 renderer hook 定向测试：54 passed、0 failed。
- production-wiring 定向测试：23 passed、0 failed。
- `bun run typecheck:shared`：通过。
- `bun run typecheck:electron`：通过。
- 本轮修改文件 ESLint：0 errors、0 warnings。
- `bun run test`：全量测试通过。
- `bun run validate:ci`：通过（全包类型检查、shared/config/doc-tools 测试与 i18n parity/sorted/coverage）。
- `git diff --check`：通过。

## 遗留问题

- 本轮 2 项阻塞问题均已修复，无已知功能性遗留。
