# POO-16 Reviewer 第 1 轮修复报告

## 变更摘要

基于 `c7332c2136950aa7c4f363cffdd7f44312a8e648` 完成 Reviewer 第 1 轮全部 9 项修复，保持既定 CLI/Electron 独立架构及严格凭据隔离契约。

1. **credential proxy 精确认证与反射防护**
   - capability 只允许出现在 provider 显式声明的 credential header 中，并要求完整值精确匹配；不再扫描或替换任意 header 子串。
   - 真实凭据只注入 provider 明确允许的 `authorization`、`x-api-key`、`api-key` 或 `x-goog-api-key`。
   - upstream credential response header 被移除，其余 header 和 body 统一做真实凭据 redaction；body redactor 可处理跨 chunk 匹配。
   - 移除 upstream `content-length`，禁止压缩响应绕过检查；无法检查的 encoded response fail closed。
   - 新增 adversarial loopback E2E，覆盖模型可见响应、session、metadata、exec JSONL、日志和 Thread metadata。
2. **CLI Thread root symlink 防护**
   - 创建 Thread 前逐级校验 CLI root、scope、`executions` 的 `lstat`/`realpath` 和 canonical containment。
   - 使用逐级非递归私有目录创建；scope 或 `executions` 被替换为 symlink 时，在任何外部写入前失败。
   - Thread 创建失败回滚本次目录，不在 CLI root 外留下数据。
3. **RootedSessionStorage symlink 防护**
   - 为 CLI storage 注入实际 `controlledRoot`；ensure、reserve、artifact/file resolver 和 persistence atomic write 均校验全部已存在祖先。
   - session 目录或中间祖先被替换为 symlink 时拒绝解析、创建和写入。
   - CLI atomic JSONL 临时文件与最终文件继续保持 `0600`，目录保持 `0700`。
4. **`resume --ephemeral` stale source 只读**
   - source lease 增加 `clone-source` 用途；接管 stale owner 时不修复原 Thread 的 `status`、`lastUsedAt` 或其他 Thread metadata。
   - clone 前仍完成 scope/执行目录验证，clone 失败继续完整回滚临时 Thread。
5. **import/fork 原子 reservation**
   - move 使用原 ID 的 `reserveSession`；fork 使用原子 reservation 并在跨进程冲突时重新生成。
   - import persistence 改走注入的 `SessionStorage` queue；bundle restore 或后续写入失败时删除本次 reservation。
   - 新增真实多进程 fork 同候选 ID 重试、move 同 ID 互斥及 restore 失败回滚测试。
6. **CLI-only 工具环境白名单**
   - 通过 runtime profile 和 session context 显式传播 `credentialIsolation`。
   - Pi Bash、Claude Bash、script/session tools 只在 CLI one-shot/CLI Thread 使用 allowlist。
   - Electron Pi 和 script/session tools 恢复原有自定义环境变量行为，同时继续移除既有已知 credential 变量。
7. **`exec sessions` 主 session 摘要**
   - 文本与 JSON 输出均增加主 session 摘要。
   - header 缺失、Thread 缺少 `mainSessionId` 或 JSONL 损坏时，分别输出明确的 `missing`/`corrupt` 降级状态与原因。
8. **`ensureDirectory` 参数语义化**
   - 布尔参数替换为 `{ throwUsageError?: boolean }`。
9. **cleanup/finalization 顺序**
   - lifecycle cleanup 增加分阶段注释。
   - JSON 协议完成事件保持在 runtime shutdown、Thread 终态持久化、`-o`、retention 和 lease release 全部完成之后。

## 关键文件

- Credential proxy 与 provider 接入
  - `packages/shared/src/credentials/invocation-credential-proxy.ts`
  - `packages/shared/src/agent/claude-agent.ts`
  - `packages/shared/src/agent/pi-agent.ts`
  - `packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts`
  - `apps/cli/src/credential-reflection.integration.test.ts`
- Thread 与 SessionStorage 路径安全
  - `apps/cli/src/cli-thread-store.ts`
  - `apps/cli/src/cli-thread-store.test.ts`
  - `packages/shared/src/sessions/session-storage.ts`
  - `packages/shared/src/sessions/persistence-queue.ts`
  - `packages/shared/src/sessions/session-storage.test.ts`
  - `packages/shared/src/utils/bundle-files.ts`
- Import/fork reservation
  - `packages/server-core/src/sessions/SessionManager.ts`
  - `packages/server-core/src/sessions/import-reservation.test.ts`
  - `packages/server-core/src/sessions/__tests__/fixtures/concurrent-import-worker.ts`
- CLI/Electron runtime profile、环境与命令输出
  - `apps/cli/src/one-shot.ts`
  - `apps/cli/src/one-shot.test.ts`
  - `packages/server/src/index.ts`
  - `packages/pi-agent-server/src/index.ts`
  - `packages/session-mcp-server/src/index.ts`
  - `packages/session-tools-core/src/context.ts`
  - `packages/session-tools-core/src/runtime/sandbox-env.ts`
  - `packages/session-tools-core/src/runtime/sandbox-env.test.ts`
  - `packages/shared/src/agent/tool-env-sanitizer.ts`
  - `packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts`

## 自测结果

### Reviewer 全量、类型与 build 命令

- `bun run test`
  - 主测试阶段：**4825 pass，19 skip，0 fail**，373 files。
  - isolated 测试阶段合计：**149 pass，0 fail**。
  - 总计：**4974 pass，19 skip，0 fail**；退出码 0。
- `bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过；退出码 0。
- `(cd apps/cli && bun run typecheck)`
  - 通过；退出码 0。
- `bun run server:build:subprocess`
  - session MCP server：390 modules，4.58 MB。
  - Pi agent server：3998 modules，20.41 MB。
  - 两个 subprocess bundle 均通过；退出码 0。

### Reviewer 聚焦回归与本轮新增对抗测试

- `bun test apps/cli/src/cli-thread-store.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/terminal-output.test.ts packages/shared/src/sessions/session-storage.test.ts packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts packages/session-tools-core/src/runtime/sandbox-env.test.ts packages/session-tools-core/src/source-helpers.test.ts packages/shared/src/utils/__tests__/large-response.test.ts packages/server-core/src/sessions/session-sidecar-permissions.test.ts apps/cli/src/credential-reflection.integration.test.ts packages/server-core/src/sessions/import-reservation.test.ts`
  - **69 pass，0 fail，257 expect**。
- `bun test apps/cli/src/server-spawner.integration.test.ts`
  - **4 pass，0 fail，14 expect**。
  - 覆盖 owner `SIGKILL` 后 runtime EOF 自退出、跨进程并发 resume 拒绝及启动失败 cleanup。
- `bun test packages/server-core/src/sessions/import-reservation.test.ts`
  - **3 pass，0 fail，9 expect**。
- `git diff --check`
  - 通过。

### 必须复现项

- credential reflection：通过。真实 API key、OAuth token 和完整 Authorization credential 均未出现在模型响应、session、metadata、JSONL、日志或 Thread metadata。
- Thread symlink：通过。scope/`executions` symlink 在写入前被拒绝，外部目标保持为空。
- session symlink：通过。session 目录替换及 controlled-root 中间 symlink 均被拒绝，外部无 JSONL。
- stale source lease：通过。`clone-source` lease 不改变原 Thread `status`、`lastUsedAt` 或其他 metadata。
- 多进程 import/fork：通过。fork 碰撞重试得到不同 ID；move 同 ID 只有一个进程成功；失败 reservation 回滚。
- Electron custom env：通过。Electron Pi Bash 不被改写，Electron script/session tool 自定义环境变量保留；CLI one-shot 仍使用 allowlist。

## 遗留问题

- 无已知 Reviewer 第 1 轮范围内遗留问题。
- 未使用真实第三方付费 provider credential 发起外网请求；凭据注入、精确 capability、跨 chunk 反射与可见面隔离使用本地 adversarial loopback upstream 完成 E2E。
- Windows ACL 与进程身份分支未在 Windows 真机执行；Windows 继续使用当前用户 ACL 语义。
- 需求快照列出的 P1 功能仍按原范围不实现。
