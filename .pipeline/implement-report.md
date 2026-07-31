# POO-16 实现报告

## 变更摘要

从当前 HEAD 继续检查并完成需求快照“继续实施起点（2026-07-30）”列出的六项遗留问题；对应实现和回归覆盖均已落地：

1. 配置快照复制 `sources`、`skills` 等配置树时不解引用 symlink，并在快照投入运行前递归拒绝残留链接，防止配置根外文件进入持久 CLI Thread。
2. workspace exec 的配置快照固定采用本次调用开始时的应用级 `permissions/default.json`；workspace 同名文件不能覆盖该默认权限，fresh install 回退到 bundled default。
3. `text_complete.isIntermediate` 标记的工具前 assistant 文本不再进入最终回答；stdout、`-o` 和 JSON `agent_message` 只使用最终 assistant message。
4. `ExecEventAdapter` 从真实 `event.tokenUsage` 映射 input、cache-read 和 output token usage。
5. `exec sessions`、`exec delete` 通过管理子命令白名单拒绝 `--last`、yolo、model/provider/credential 等不支持参数，包含与 help/version 组合的绕过场景，统一返回 usage error（exit 2）。
6. `exec sessions` 列表前在 Thread state lock 下修复 owner 与 lease 均失效且仍无终态的持久 `cli-exec` Thread，将其标记为 `interrupted`；owner sidecar symlink 会安全失败关闭。

## 关键文件列表

- `apps/cli/src/one-shot.ts`：安全配置快照、应用级默认权限快照、最终消息选择与 stale Thread 修复入口。
- `apps/cli/src/cli-thread-store.ts`：abandoned 持久 Thread 的原子修复与 owner 路径安全检查。
- `apps/cli/src/exec-event-adapter.ts`：JSONL token usage 映射。
- `apps/cli/src/execution-parser.ts`：sessions/delete 管理子命令选项白名单。
- `apps/cli/src/one-shot.test.ts`：symlink 越界、应用级权限和 intermediate 文本回归。
- `apps/cli/src/exec-event-adapter.test.ts`：真实 `tokenUsage` 回归。
- `apps/cli/src/execution-parser.test.ts`、`apps/cli/src/index.test.ts`：管理参数 usage error 与 SIGKILL stale Thread 回归。
- `apps/cli/src/cli-thread-store.test.ts`：abandoned Thread 修复安全边界回归。

## 自测结果

- `bun test apps/cli/src/one-shot.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/execution-parser.test.ts apps/cli/src/index.test.ts apps/cli/src/cli-thread-store.test.ts`
  - 本轮实际执行：47 pass，0 fail。
- `bun run test`
  - 本轮实际执行：通过，主测试与全部 `*.isolated.ts` 测试退出码均为 0。
- `bun run typecheck:all`
  - 本轮实际执行：通过，core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全量类型检查均成功。
- `bun run server:build:subprocess`
  - 本轮实际执行：通过；session MCP bundled 390 modules / 4.58 MB，Pi agent bundled 3999 modules / 20.41 MB。
- `git diff --check`
  - 本轮实际执行：通过。

## 遗留问题

- 本轮六项遗留问题无已知未完成项。
- Windows ACL 与 Windows 进程身份分支未在 Windows 真机验证；现有跨平台测试与类型检查通过。
- P1 功能仍按需求快照排除在本任务范围外。
