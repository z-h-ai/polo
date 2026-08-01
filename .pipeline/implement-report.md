# POO-16 实现报告

## 变更摘要

本轮从当前 HEAD `b8a4ac1f` 继续核验，没有重新实施或丢弃已有变更。需求快照“继续实施起点”列出的六项问题在当前分支均已有实现与回归覆盖，本轮逐项复查并重新执行验证：

1. 配置快照复制使用 `dereference: false`，复制后递归拒绝 symlink；失败时删除未完成快照，外部目标不会进入持久 CLI Thread。
2. workspace exec 的私有配置快照会复制当前应用级 `~/.polo-ai/permissions/default.json`；fresh install 才回退到随包默认权限。
3. turn 输出只保留最后一个非 intermediate assistant message；工具调用前 commentary 不再污染普通 stdout、`-o` 或 JSON agent message。
4. `ExecEventAdapter` 从真实 `event.tokenUsage` 映射 JSONL `turn.completed.usage`。
5. `exec sessions/delete` 对 `--last`、权限、模型、provider、credential、workspace/cd 等不支持选项返回 usage error；`--help/--version` 不能绕过白名单校验。
6. `exec sessions` 会在 owner/runtime 身份均失效且 lease 过期时，把无终态的持久 `cli-exec` Thread 修复为 `interrupted`；owner sidecar 读取前执行受控根与 symlink 校验。

本轮没有新增产品源码修改；完成信号为当前实现复核、全量验证结果与本报告更新。

## 关键文件列表

- `apps/cli/src/one-shot.ts`
  - 私有配置快照、应用级默认权限快照、最终 assistant message 选择与 sessions 修复入口。
- `apps/cli/src/cli-thread-store.ts`
  - abandoned persistent exec Thread 修复、lease/process identity 与受控路径校验。
- `apps/cli/src/exec-event-adapter.ts`
  - JSONL token usage 映射。
- `apps/cli/src/execution-parser.ts`
  - `sessions/delete` 管理子命令选项白名单和 usage error。
- `apps/cli/src/one-shot.test.ts`
  - symlink 拒绝、应用级权限快照、intermediate 文本隔离回归。
- `apps/cli/src/exec-event-adapter.test.ts`
  - `tokenUsage` JSONL 回归。
- `apps/cli/src/execution-parser.test.ts`、`apps/cli/src/index.test.ts`
  - 管理命令非法参数退出 2、SIGKILL abandoned Thread 列表修复回归。
- `apps/cli/src/cli-thread-store.test.ts`
  - owner sidecar symlink fail-closed、lease/stale 并发回归。

## 自测结果

- `bun test apps/cli/src/exec-event-adapter.test.ts apps/cli/src/execution-parser.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/cli-thread-store.test.ts apps/cli/src/index.test.ts`
  - 通过：47 pass，0 fail，覆盖需求快照列出的六项问题。
- `NO_COLOR=1 bun run typecheck:all`
  - 通过：core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全量类型检查退出码 0。
- `NO_COLOR=1 bun run server:build:subprocess`
  - 通过：Session MCP 390 modules / 4.58 MB；Pi Agent 3999 modules / 20.41 MB。
- `NO_COLOR=1 bun run test`
  - 通过：普通全量测试及仓库全部 `*.isolated.ts` 测试退出码 0；包含 CLI 配置快照、输出、usage、管理参数、owner SIGKILL、并发 resume、parent-death、权限与存储隔离回归。
- `git diff --check`
  - 通过。

## 遗留问题

- 无本轮需求范围内的已知遗留问题。
- 未执行签名、notarization、DMG/NSIS/AppImage 安装测试；这些不属于本轮要求的六项修复与验证范围。
- 用户已有 `.task/session-analysis/` 及删除状态的 `.pipeline/fix-report-round1.md`、`.pipeline/fix-report-round2.md` 未触碰、未纳入提交。
