# POO-16 实现报告

## 变更摘要

本轮从当前 HEAD `c71c5a9e` 继续，没有重新实施、回退或丢弃已有变更。需求快照列出的六项 Ultra-Coding review 问题在当前分支均已完成修复并具备回归覆盖，本轮逐项复核实现后重新执行专项测试、全量测试、全量类型检查和 server subprocess 构建：

1. 配置快照复制使用 `dereference: false`，并在复制后递归拒绝未解析 symlink；失败时清除未完成快照，配置根外文件不会进入持久 CLI Thread。
2. workspace exec 的私有配置快照会复制当前应用级 `permissions/default.json`；仅 fresh install 回退到随包默认权限。
3. turn 输出只采用最后一个非 intermediate assistant message，工具调用前的 commentary 不会污染普通 stdout、`-o` 或 JSON agent message。
4. `ExecEventAdapter` 从真实 `event.tokenUsage` 映射 JSONL `turn.completed.usage`。
5. `exec sessions/delete` 对 `--last`、权限、model/provider/credential、workspace/cd 等执行期选项返回 usage error 和退出码 2；`--help/--version` 不能绕过管理子命令白名单校验。
6. `exec sessions` 会在 owner/runtime identity 均失效且 lease 过期时，将无终态的持久 `cli-exec` Thread 修复为 `interrupted`；owner sidecar 读取前执行受控根和 symlink 校验。

本轮产品源码无需追加修改；实现已存在于 `cfd065ef` 及其后续修复提交中。本次新增完成信号为最新验证结果和本报告更新。

## 关键文件列表

- `apps/cli/src/one-shot.ts`
  - 私有配置快照、应用级默认权限快照、最终 assistant message 选择及 sessions 修复入口。
- `apps/cli/src/cli-thread-store.ts`
  - abandoned persistent exec Thread 修复、lease/process identity 和受控路径校验。
- `apps/cli/src/exec-event-adapter.ts`
  - JSONL token usage 映射。
- `apps/cli/src/execution-parser.ts`
  - `sessions/delete` 管理子命令选项白名单和 usage error。
- `apps/cli/src/one-shot.test.ts`
  - symlink 拒绝、应用级权限快照和 intermediate 文本隔离回归。
- `apps/cli/src/exec-event-adapter.test.ts`
  - `tokenUsage` JSONL 回归。
- `apps/cli/src/execution-parser.test.ts`、`apps/cli/src/index.test.ts`
  - 管理命令非法参数退出 2、SIGKILL abandoned Thread 列表修复回归。
- `apps/cli/src/cli-thread-store.test.ts`
  - owner sidecar symlink fail-closed、lease/stale 并发回归。

## 自测结果

- `NO_COLOR=1 bun test apps/cli/src/exec-event-adapter.test.ts apps/cli/src/execution-parser.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/cli-thread-store.test.ts apps/cli/src/index.test.ts`
  - 通过：50 pass，0 fail，覆盖需求快照列出的六项问题。
- `NO_COLOR=1 bun run typecheck:all`
  - 通过：core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全量类型检查退出码 0。
- `NO_COLOR=1 bun run server:build:subprocess`
  - 通过：Session MCP 390 modules / 4.58 MB；Pi Agent 3999 modules / 20.41 MB。
- `NO_COLOR=1 bun run test`
  - 通过：普通全量测试 4880 pass、19 skip、0 fail；13 个 `*.isolated.ts` 文件全部通过，共 149 pass、0 fail。
- `git diff --check`
  - 通过。

## 遗留问题

- 本轮需求范围内无已知遗留问题。
- 未执行签名、notarization、DMG/NSIS/AppImage 安装测试；这些不属于本轮六项 review 修复及指定验证范围。
- 用户已有 `.task/session-analysis/` 和删除状态的 `.pipeline/fix-report-round1.md`、`.pipeline/fix-report-round2.md` 未触碰、未纳入本轮提交。
