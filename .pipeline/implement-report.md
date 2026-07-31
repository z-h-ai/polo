# POO-16 实现报告

## 变更摘要

从当前 HEAD 继续完成并核验本轮 Reviewer 列出的六项修复：

1. 配置快照复制配置树时不解引用 symlink；在运行时可见快照前递归拒绝任何保留的链接，避免把 scope 外文件带入持久 CLI Thread。
2. 快照显式使用调用开始时应用级 `permissions/default.json`；workspace 同名默认权限不能覆盖它，首次安装则回退到 bundled default。
3. 最终回答按 `text_complete.isIntermediate` 分离中间工具说明；普通 stdout、`-o` 和 JSON `agent_message` 只使用最终回答。
4. `ExecEventAdapter` 从真实 `tokenUsage` 映射 input、cache-read 与 output token usage。
5. `exec sessions` 与 `exec delete` 使用子命令选项白名单，拒绝 `--last`、yolo、模型/provider/credential 等不支持参数并返回 usage error。
6. `exec sessions` 列表前以 Thread state lock 修复 owner 和 lease 均已失效的无终态持久 `cli-exec` Thread 为 `interrupted`。

## 关键文件列表

- `apps/cli/src/one-shot.ts`：安全配置快照、应用级权限快照、最终文本选择和 sessions stale 修复入口。
- `apps/cli/src/cli-thread-store.ts`：持久 Thread abandoned-state 的原子修复。
- `apps/cli/src/exec-event-adapter.ts`：JSONL `tokenUsage` 映射。
- `apps/cli/src/execution-parser.ts`：管理子命令的选项白名单。
- `apps/cli/src/one-shot.test.ts`、`exec-event-adapter.test.ts`、`execution-parser.test.ts`、`index.test.ts`：上述行为的回归覆盖。

## 自测结果

- `bun test apps/cli/src/one-shot.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/execution-parser.test.ts apps/cli/src/index.test.ts apps/cli/src/cli-thread-store.test.ts`
  - 44 pass，0 fail。
- `bun run test`
  - 通过（包含主测试和 isolated 测试）。
- `bun run --cwd apps/cli typecheck && bun run typecheck:all`
  - 通过。
- `bun run server:build:subprocess`
  - 通过；session MCP 390 modules / 4.58 MB，Pi agent 3999 modules / 20.41 MB。
- `git diff --check`
  - 通过。

## 遗留问题

- 本轮六项 Reviewer 问题无已知遗留。
- Windows ACL 与进程身份分支未在 Windows 真机执行；现有跨平台类型检查和测试通过。
- P1 功能继续按需求快照排除在本任务范围外。
