# POO-16 实施报告

## 变更摘要

- `polo run` 与 `polo exec` 使用独立 CLI runtime、独立 lock namespace 和 `~/.polo-ai/cli-sessions/` Thread 存储，不连接或复用 Electron RPC，也不把 CLI session 写入 Electron workspace。
- 交付 `polo exec`、`exec resume`、`exec sessions`、`exec delete`，包含严格参数解析、safe/allow-all 权限映射、JSONL 事件适配、原子 `-o`、退出码和持久/临时 Thread 生命周期。
- 完成可注入 `SessionStorage`，覆盖 session persistence、files RPC、bundle/import/fork、MCP、browser/tool metadata、附件与 sidecar 路径。
- 完成 invocation-scoped credential proxy、CLI/model/tool 子进程环境白名单、敏感信息 redaction、私有目录/文件权限、symlink/realpath containment、租约/heartbeat/process birth identity 和 stale cleanup。
- 关闭最终 reviewer 的两项阻断：
  - 持久化 `exec` 与 `run --no-cleanup` 在主 session 创建前收到信号时保留 Thread，并原子记录 `interrupted`；仅 ephemeral Thread 自动删除。
  - `creating.json` 从目录创建第一刻持久化真实 `origin` 与 `persistence`。stale cleaner 仅在该标记可证明 Thread 为 ephemeral 时回收；旧标记、缺失标记、普通持久化 exec 与 `run --no-cleanup` 均 fail closed。

## 关键文件列表

- CLI 命令、生命周期与存储：
  - `apps/cli/src/index.ts`
  - `apps/cli/src/execution-parser.ts`
  - `apps/cli/src/one-shot.ts`
  - `apps/cli/src/cli-thread-store.ts`
  - `apps/cli/src/server-spawner.ts`
  - `apps/cli/src/exec-event-adapter.ts`
  - `apps/cli/src/terminal-output.ts`
- 最终阻断回归：
  - `apps/cli/src/cli-thread-store.test.ts`
  - `apps/cli/src/server-spawner.integration.test.ts`
  - `apps/cli/src/__fixtures__/execution-signal-stage.ts`
- SessionStorage、runtime 与凭据隔离：
  - `packages/shared/src/sessions/session-storage.ts`
  - `packages/shared/src/credentials/invocation-credential-proxy.ts`
  - `packages/server-core/src/sessions/SessionManager.ts`
  - `packages/server-core/src/handlers/rpc/files.ts`
  - `packages/server-core/src/bootstrap/headless-start.ts`
  - `packages/server/src/index.ts`
  - `packages/session-mcp-server/src/index.ts`
  - `packages/session-tools-core/src/runtime/sandbox-env.ts`
  - `packages/pi-agent-server/src/index.ts`

## 自测结果

- `bun test apps/cli/src/cli-thread-store.test.ts apps/cli/src/server-spawner.integration.test.ts`
  - **24 pass，0 fail，292 expect**。
  - 覆盖 persistent exec 与 `run --no-cleanup` 的启动阶段信号保留、ephemeral 删除、创建标记策略、十分钟 stale 回收以及持久/未知目录保护。
- `(cd apps/cli && bun run typecheck)`
  - 通过。
- `bun run test`
  - 标准测试：**4852 pass，19 skip，0 fail**，377 files。
  - 13 个 isolated test files：**149 pass，0 fail**。
  - 整条命令退出码 0。
- `bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- `bun run server:build:subprocess`
  - session MCP server 与 Pi agent server 均成功 bundle。
- `git diff --check`
  - 通过。

## 遗留问题

- 无已知 P0 阻塞。
- 未使用真实第三方付费 provider 凭据执行外网 E2E；凭据代理与泄漏负向路径由本地 loopback、真实子进程和全量回归覆盖。
- POSIX 信号、进程出生身份、目录权限与多进程用例在 macOS 执行；Windows ACL 与 Windows 进程路径未在 Windows 真机复测。
- 需求快照列出的 P1 参数和功能按范围不实现。
