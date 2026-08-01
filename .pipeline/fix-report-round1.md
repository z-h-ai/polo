# POO-16 Review Round 1 修复报告

## 处理结果

### 1. 普通 resume 的连接覆盖不再污染原 Thread

- `executeTurn` 只在执行者拥有新 Thread 时持久化解析后的非敏感 connection：新建 `run/exec` 和 `resume --ephemeral` 副本保持原行为。
- 普通 `exec resume` 的 `--provider`、`--model`、`--base-url` 仅传给本次私有 runtime，不再写回原 Thread 的 `thread.json.connection`。
- 新增隔离 subprocess 回归，连续执行两次真实 resume：第一次显式切到 OpenAI/override model/base URL，并从 runtime bootstrap trace 证明本次覆盖生效；随后确认原 `thread.json.connection` 未变，第二次无参数 resume 又使用原 Anthropic/model/base URL，完成后 metadata 仍未变。

### 2. exec 拒绝 P0 未支持的 legacy/debug 参数

- `exec` 在解析值及 help/version dispatch 前拒绝 `--disable-spinner`、`--no-spinner`、`--verbose`、`-v`、`--server-entry`、`--timeout`、`--workspace-dir`。
- 所有组合均返回 usage error/退出码 2；真实 CLI subprocess 验证 stdout 为空且参数错误发生在 Thread 创建前。
- `run` 和 legacy remote RPC 自身既有参数行为不变。需要注入自定义 server 的进程级测试改用测试 fixture 直接设置内部 `ExecutionArgs.serverEntry`，生产 argv 无法使用该入口。

### 3. Electron sessions watcher 门禁稳定性

- 两个 watcher 测试文件原先都使用模块级 `client-a/client-b`，全量测试并发/交错时可能操作同一全局 watcher map；同时正向断言依赖固定 300ms sleep，慢机器上存在时序窗口。
- 两套测试改用互不相同的 client ID，并把正向事件等待改成带 2 秒上限的条件轮询；负向 cleanup/ignore 断言仍保留超过 100ms debounce 的观察窗口。
- 两个 watcher 文件连续联合运行 10 次，合计 50 pass、0 fail；修复后全量门禁连续两次通过，未再出现 watcher 波动。

## 关键文件

- `apps/cli/src/one-shot.ts`：限制 resolved connection metadata 写入到新建/副本 Thread。
- `apps/cli/src/execution-parser.ts`：exec legacy/debug 选项 fail-fast 白名单边界。
- `apps/cli/src/one-shot.test.ts`、`apps/cli/src/execution-parser.test.ts`、`apps/cli/src/index.test.ts`：连接覆盖、parser 和真实 subprocess 回归。
- `apps/cli/src/__fixtures__/resume-override-persistence.ts`：两次 resume 的独立进程端到端回归。
- `apps/cli/src/__fixtures__/one-shot-with-server.ts`、`execution-signal-stage.ts`、`lifecycle-failure-server.ts`：测试专用 server 注入、runtime connection trace 与成功完成事件。
- `apps/cli/src/server-spawner.integration.test.ts`：移除测试对生产 `--server-entry` argv 的依赖。
- `apps/electron/src/main/handlers/__tests__/session-watcher.test.ts`、`sessions-watchers.test.ts`：watcher client namespace 隔离与确定性等待。

## 自测命令与结果

- `NO_COLOR=1 bun test apps/cli/src/execution-parser.test.ts apps/cli/src/index.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/server-spawner.integration.test.ts apps/electron/src/main/handlers/__tests__/sessions-watchers.test.ts apps/electron/src/main/handlers/__tests__/session-watcher.test.ts`
  - 通过：47 pass，0 fail。
- `for i in {1..10}; do NO_COLOR=1 bun test apps/electron/src/main/handlers/__tests__/sessions-watchers.test.ts apps/electron/src/main/handlers/__tests__/session-watcher.test.ts || exit 1; done`
  - 通过：10/10 轮，每轮 5 pass、0 fail；合计 50 pass、0 fail。
- `NO_COLOR=1 bun test apps/cli/src/run.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/execution-parser.test.ts apps/cli/src/index.test.ts`
  - 通过：44 pass，0 fail；确认新的 resume 回归不受同进程 `run.test.ts` mock 污染。
- `cd apps/cli && NO_COLOR=1 bun run typecheck`
  - 通过：CLI 及新增 fixtures 类型检查退出码 0。
- `NO_COLOR=1 bun run typecheck:all`
  - 通过：core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全量类型检查退出码 0。
- `NO_COLOR=1 bun run server:build:subprocess`
  - 通过：Session MCP 390 modules / 4.58 MB；Pi Agent 3999 modules / 20.41 MB。
- `NO_COLOR=1 bun run test`
  - 最终连续两次通过：普通全量测试和仓库全部 `*.isolated.ts` 测试均退出 0。
- `git diff --check`
  - 通过。

## 门禁调查记录

- 修复实现后的第一次全量运行暴露了本轮最初新增回归自身的测试隔离问题：`one-shot.test.ts` 在全量进程中受 `run.test.ts` 的模块 mock 影响，报 `mockWsServer not initialized`；定向单文件运行不复现。
- 已将该回归改为独立 Bun subprocess，验证真实 runtime 与持久 metadata，消除全量测试的模块 mock 污染。随后两次完整 `bun run test` 均通过。
- Review 所报 Electron watcher 时序波动按上述 client namespace 冲突与固定 sleep 处理，并通过 10 轮定向重复及两轮全量验证，不作为“不可归因基线”豁免。

## 遗留问题

- 本轮 Review 阻断范围内无已知遗留问题。
- 未执行签名、notarization、DMG/NSIS/AppImage 安装测试；与本轮三个阻断项无关。
- 用户已有 `.task/session-analysis/` 未触碰、未纳入提交。
