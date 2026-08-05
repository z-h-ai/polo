# POO-16 实现报告

## 变更摘要

本轮从当前 HEAD `a1059257` 继续，没有重新实施、回退或丢弃已有变更。逐项复核需求快照中的六个 reviewer 问题及 2026-08-04 人工裁决后确认，当前分支已经具备对应实现和回归测试：

1. 配置快照递归复制使用 `dereference: false`，复制后拒绝任何 symlink；外部目标不会进入持久 Thread。
2. workspace exec 会把应用级 `permissions/default.json` 固化进调用开始时的 `config-snapshot/`；全新安装才回退 bundled default。
3. intermediate assistant 文本在 `text_complete.isIntermediate` 时清空，不会拼入最终 stdout、`-o` 或 JSON agent message。
4. `ExecEventAdapter` 从真实 session event 的 `tokenUsage` 映射 JSONL usage。
5. `exec sessions/delete` 对 `--last`、`--yolo`、model/provider/credential 等 execution-only 参数报 usage error，真实 CLI 退出 2；管理子命令使用专属 help。
6. `exec sessions` 会把 owner 和 lease 均失效的非终态持久 `cli-exec` Thread 修复为 `interrupted`。

人工裁决边界保持不变：共享配置工作区中 source/skill 原有配置值允许保留在权限受控的快照中；命令行显式传入的 API key、token 和 Authorization header 仍不得进入持久化产物。credential writer lock 继续使用跨平台 OS 级 native lock。

在重跑定向门禁时，既有 delete/acquire 并发回归稳定复现出一个额外生命周期竞态：`acquireCliThreadLease` 在第一次 containment 检查后调用 `ensurePrivateDir`，若 delete 恰好已把 Thread 原子移动到 trash，该调用会重新创建空 Thread 目录，导致 delete 与 acquire 同时成功。本轮移除 acquire 路径的目录创建；后续 state-lock 获取会重新验证现存 Thread，delete 先完成时 acquire 现在 fail closed。

## 关键文件列表

- `apps/cli/src/cli-thread-store.ts`
  - 修复 delete/acquire 竞态，禁止 lease acquire 重建已被删除的 Thread 目录。
- `apps/cli/src/cli-thread-store.test.ts`
  - 既有跨进程 30 轮 delete/acquire 互斥回归覆盖本轮修复；本轮未改测试文件。
- `apps/cli/src/one-shot.ts`、`apps/cli/src/one-shot.test.ts`
  - 配置 symlink、应用级权限快照、intermediate/final message 边界及回归。
- `apps/cli/src/exec-event-adapter.ts`、`apps/cli/src/exec-event-adapter.test.ts`
  - `tokenUsage` 到稳定 JSONL usage 的映射及回归。
- `apps/cli/src/execution-parser.ts`、`apps/cli/src/execution-parser.test.ts`、`apps/cli/src/index.test.ts`
  - 管理子命令参数白名单、退出码、专属 help 和 SIGKILL 后 sessions 修复回归。
- `packages/shared/src/credentials/backends/native-write-lock.ts`
  - POSIX `flock` / Windows named mutex 的 OS 级 credential writer lock。

## 自测结果

- 六项 reviewer 问题、credential lock 与 Thread store 定向回归：
  - `NO_COLOR=1 bun test apps/cli/src/one-shot.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/execution-parser.test.ts apps/cli/src/index.test.ts apps/cli/src/cli-thread-store.test.ts packages/shared/src/credentials/__tests__/secure-storage-write-lock.test.ts`
  - 通过：64 pass，0 fail，530 expect。
- delete/acquire 竞态压力复验：
  - `for i in {1..5}; do NO_COLOR=1 bun test apps/cli/src/cli-thread-store.test.ts --test-name-pattern 'serializes delete and acquire' || exit 1; done`
  - 通过：连续 5 轮，每轮 30 个跨进程竞争场景均只有一个操作成功。
- 全量测试：
  - `NO_COLOR=1 bun run test`
  - 通过：普通全量 4906 pass、19 skip、0 fail，381 files；随后仓库全部 `*.isolated.ts` 测试通过，命令退出 0。
- 全量类型检查：
  - `NO_COLOR=1 bun run typecheck:all`
  - 通过：core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部退出 0。
- server subprocess 构建：
  - `NO_COLOR=1 bun run server:build:subprocess`
  - 通过：Session MCP 390 modules / 4.58 MB；Pi Agent 3999 modules / 20.41 MB。
- `git diff --check`
  - 通过。

## 遗留问题

- 本轮 coder 范围内无已知遗留实现问题；仍需由独立 reviewer 按任务约定重新验收，不能以 coder 自测替代 review 终态。
- 当前环境未执行 Windows/Linux 实机安装、签名、notarization、DMG、NSIS 或 AppImage/FUSE 安装。
- 用户已有 `.task/session-analysis/` 未改动、未删除、未提交；`.pipeline/fix-report-round1.md`、`.pipeline/fix-report-round2.md` 的既有删除状态保持不纳入本轮提交。
