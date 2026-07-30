# POL-51 Reviewer 第 1 轮修复报告

## 逐条 Issue 处理结果

### 1. 安装中取消被安装互斥 Promise 吞掉

- 已修复。`cancelInstall` 改用独立的 `cancellationOperationsRef` 互斥通道，不再复用安装、启动等生命周期操作占用的 `operationsRef`。
- 同一完整 scope 的重复取消仍会去重，但取消 RPC 可以与该 scope 正在进行的安装 Promise 并行发出。
- 新增 renderer 交互回归测试：启动一个未决安装后点击取消，确认 `localApps.cancelInstall` 被调用一次、安装 Promise 以取消错误结束，最终状态回到 `not_installed`。

### 2. 批量状态读取后逐 App 调用 Release RPC

- 已修复。renderer 删除 `reconcileVersionStatuses` 和逐项 `setAvailableRelease` 调用。
- 主进程 `GET_RUNTIME_STATUSES` 在一次读取并校验授权 Catalog 后，通过一次 scoped registry 批量状态读取，在内存中为整批结果派生 `update_available` 和 `invalid_semver`。
- 无效 Catalog Release 或无效已安装版本继续保留最后可信 `availableRelease`，并显式返回 `versionError: invalid_semver`。
- 新增 1,000、1,001、10,000 项回归断言：renderer 每个目录只发出一次批量状态 RPC、没有逐 App Release RPC；主进程每批只读取一次授权缓存、只调用一次 scoped registry、不会调用 `setAvailableRelease`。

### 3. 单 App 刷新覆盖整个组织状态 Map

- 已修复。`refreshRuntimeStatuses` 增加明确的 `replace | merge` 模式：
  - Catalog 初次/完整同步使用 `replace`。
  - busy 轮询和安装、启动、停止、卸载、取消完成后的子集刷新使用 `merge`。
- 新增多 App renderer 回归测试：单 App 启动完成后的子集刷新只更新目标 scope，另一 App 的 `running` 状态及整个状态 Map 均保留。

### 4. “最近使用”无条件追加全部内置 App

- 已修复。删除内置 App 的无条件兜底追加逻辑。
- “最近使用”现在只解析真实持久化的最近打开记录；已存在的 builtin 最近记录仍可正常解析和打开。

## 关键文件

- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`

## 自测结果

- `bun run test`：通过；普通测试和全部 `*.isolated.ts` 均为 0 fail。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`（等价执行 `apps/electron` 的 `bun run lint -- --no-cache`）：通过，0 error；保留仓库既有 114 个 warning。
- `bun run lint:i18n:parity`：通过，6 个非英文 locale 与英文基线均为 1689 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:preload`：通过。
- `bun run electron:build:renderer`：通过；仅有既有 Vite chunk size warning。
- `git diff --check`：通过。

定向回归：

- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`：5 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`：7 pass，0 fail。
- `bun test apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts`：6 pass，0 fail。

## 遗留问题

- 未连接真实 POL-52 服务和生产签名 Bundle 做端到端联调；本轮问题已通过主进程 RPC、renderer hook 交互、全量测试、类型检查和生产构建覆盖。
- 工作树中的三份未跟踪规格文档为本轮开始前已有文件，本轮未修改、未纳入提交。
