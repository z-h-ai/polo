# POO-16 实现报告

## 变更摘要

从提交 `b78632e` 及 worktree 中已有未提交变更继续完成本轮六项 Reviewer 修复：

1. 配置快照不再解引用 `sources`、`skills` 等配置树中的 symlink；复制后在写入任何种子配置前先校验整棵快照，发现 symlink 时删除失败快照，避免越界读取或通过 workspace 控制的路径向 Thread 外写入。
2. 配置快照显式合并调用开始时的应用级 `permissions/default.json`；workspace 中同名文件不能覆盖应用级默认权限，首次安装时回退到 bundled default。
3. 最终回答改为按 `text_complete.isIntermediate` 区分中间工具说明与最终 assistant 文本；stdout、`-o` 和 JSON agent message 共用未污染的最终消息。
4. `ExecEventAdapter` 改读真实 session event 的 `tokenUsage`，并正确映射 `inputTokens`、`cacheReadTokens` 和 `outputTokens`。
5. `exec sessions`/`exec delete` 使用子命令级选项白名单；`--last`、yolo、model/provider/credential、ephemeral、runtime timeout 及 delete 的 workspace/cwd 等不支持选项均报 usage error 并退出 2。
6. `exec sessions` 在列出持久 `cli-exec` Thread 前，以 Thread state lock 原子检查 owner/process identity/lease heartbeat；owner 和 lease 均失效且仍无终态时修复为 `interrupted`，不改变原 `lastUsedAt` 排序。

每项均增加了对应回归测试，包括真实 CLI 子进程的退出码/敏感参数输出检查和失效 owner Thread 的 sessions 修复检查。

## 关键文件列表

- `apps/cli/src/one-shot.ts`
  - 安全配置快照、应用级默认权限合并、最终 assistant 文本选择、sessions stale 修复入口。
- `apps/cli/src/cli-thread-store.ts`
  - 持久 Thread 的原子 abandoned-state 修复。
- `apps/cli/src/exec-event-adapter.ts`
  - JSONL token usage 映射。
- `apps/cli/src/execution-parser.ts`
  - sessions/delete 子命令选项白名单。
- `apps/cli/src/one-shot.test.ts`
  - symlink、应用级权限、intermediate 文本回归。
- `apps/cli/src/exec-event-adapter.test.ts`
  - `tokenUsage` JSONL 回归。
- `apps/cli/src/execution-parser.test.ts`
  - management 子命令不支持参数矩阵。
- `apps/cli/src/index.test.ts`
  - exit 2、credential 不回显、SIGKILL-abandoned Thread 修复的 CLI 子进程回归。

## 自测结果

- Reviewer 聚焦回归：
  - `bun test apps/cli/src/one-shot.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/execution-parser.test.ts apps/cli/src/index.test.ts apps/cli/src/cli-thread-store.test.ts`
  - 44 pass，0 fail。
- 全量测试：
  - `bun run test`
  - 主测试 4859 pass、19 skip、0 fail（4878 tests / 377 files）。
  - isolated 测试合计 149 pass、0 fail。
  - 总计 5008 pass、19 skip、0 fail；退出码 0。
- 类型检查：
  - `bun run --cwd apps/cli typecheck`：通过。
  - `bun run typecheck:all`：core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- 子进程构建：
  - `bun run server:build:subprocess`：通过。
  - session MCP server：390 modules / 4.58 MB。
  - Pi agent server：3999 modules / 20.41 MB。
- `git diff --check`：通过。

## 遗留问题

- 本轮六项 Reviewer 问题无已知遗留。
- Windows ACL 和 Windows 进程身份分支未在 Windows 真机执行；现有跨平台实现与测试保持通过。
- 需求快照中的 P1 功能仍按约定不在本任务范围内。
