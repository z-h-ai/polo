# POO-16 实现报告

## 变更摘要

- 将 `polo run` 改为始终使用独立的一次性 CLI runtime 和 CLI Thread 存储，不连接 Electron RPC、不获取 Electron server lock；默认清理，`--no-cleanup` 仅在 CLI root 保留调试 Thread。
- 新增 Codex 风格 `polo exec`，覆盖 P0 参数、safe/allow-all 权限映射、stdin 组合、普通最终消息输出、稳定 JSONL、原子 `-o`、退出码和严格用法错误。
- 新增 CLI Thread 存储、UUID、私有权限、原子 metadata、独占租约、heartbeat、stale ephemeral cleaner、resume/sessions/delete 和 owner 消失监督。
- 注入完整 `SessionStorage`，使主 session、branch/fork/spawn、persistence、files、bundle、MCP/session tools、provider anchor 和 sidecar 都落在 CLI Thread root；Electron session 路径保持原状。
- CLI runtime 使用每次调用的配置快照，跳过 ConfigWatcher、automation、scheduler、messaging、通知、全局 session watcher 和后台 model refresh；provider/model/base URL/API key 覆盖不写共享配置。
- 同时发布 `polo` 与兼容别名 `polo-ai`，补充 CLI 文档、架构决策、领域术语和 release note。

## 关键文件列表

- `apps/cli/src/one-shot.ts`
- `apps/cli/src/execution-parser.ts`
- `apps/cli/src/exec-event-adapter.ts`
- `apps/cli/src/cli-thread-store.ts`
- `packages/shared/src/sessions/session-storage.ts`
- `packages/server/src/index.ts`
- `packages/server-core/src/sessions/SessionManager.ts`
- `packages/server-core/src/bootstrap/headless-start.ts`
- `packages/shared/src/config/storage.ts`
- `packages/shared/src/credentials/manager.ts`
- `packages/session-mcp-server/src/index.ts`
- `docs/cli.md`
- `spec-polo-run-exec.md`
- `docs/adr/`

## 自测结果

- `bun test`：4778 pass，19 skip，0 fail；共 4797 tests / 363 files。
- CLI/存储专项测试：14 pass，0 fail，覆盖严格参数解析、Thread 租约与 stale cleanup、JSONL secret 脱敏、CLI storage 路由与权限。
- TypeScript：`shared`、`server-core`、`server`、`session-tools-core`、`session-mcp-server`、`apps/cli` 均通过 `tsc --noEmit`。
- 子进程构建：`bun run server:build:subprocess` 通过，session MCP 和 Pi agent server bundle 成功。
- 手工 smoke：
  - `polo exec --yolo --json` 每行可解析，输出 `thread.started`、turn/item、`turn.completed`，退出 0。
  - 普通持久化 exec 的 stdout 只有最终消息；`-o` 文件原文无附加换行；resume、sessions、delete 均成功。
  - ephemeral exec 与可处理信号中断后 Thread 被删除；SIGINT 返回 130。
  - 新配置根执行后没有共享 `sessions/` 或 `.server.lock` 写入，CLI root secret 扫描无命中。
  - runtime 退出后未发现残留 CLI server、listener 或 Pi agent 子进程。
  - 未知参数实测退出 2。

## 遗留问题

- 无 P0 阻塞遗留。
- 需求列出的 P1 参数、显式 fork 和自动 retention/prune 未实现，按任务范围保留后续处理。
- 当前自测环境为 macOS；Windows ACL 继承和 Windows Job Object 路径未做本机实测。

## 提交

- `fa39f93 POO-16: 隔离 CLI Thread 并新增 exec`
