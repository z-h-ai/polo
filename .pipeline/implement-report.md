# POO-16 本轮完整修复报告

## 变更摘要

- 保持已审定的 CLI/Electron 隔离架构，完成实例级 `SessionStorage` 注入：Electron 使用 workspace storage；每个 CLI Thread 使用独立 rooted storage、独立 persistence queue 和完整 artifact 路径服务。
- CLI runtime 改用 inherited pipe 传递 invocation-scoped 启动数据，并把该 pipe 同时作为 parent-death sentinel；进程所有权使用 OS 可验证的 PID birth identity。
- 修复凭据隔离、终态判定、JSONL durability、resume 配置优先级、fresh config、quiet stderr drain、tool failure JSONL、早期 lifecycle cleanup 和 `resume ... -- PROMPT` 解析。
- 保留 Electron 默认 session 路径和兼容调用；CLI 执行链不依赖可变的模块级 active storage 或全局 persistence singleton。
- 补齐单元、集成和独立进程 smoke，覆盖凭据扫描、工具子进程环境脱敏、PID reuse、owner `kill -9`、concurrent resume、fresh config、启动失败输出和 JSONL durability。

## 关键文件列表

- CLI 生命周期与协议：
  - `apps/cli/src/one-shot.ts`
  - `apps/cli/src/server-spawner.ts`
  - `apps/cli/src/cli-thread-store.ts`
  - `apps/cli/src/execution-parser.ts`
  - `apps/cli/src/exec-event-adapter.ts`
- runtime 与 SessionManager：
  - `packages/server/src/index.ts`
  - `packages/server-core/src/sessions/SessionManager.ts`
  - `packages/server-core/src/handlers/rpc/files.ts`
  - `packages/server-core/src/handlers/rpc/sessions.ts`
- 存储与持久化：
  - `packages/shared/src/sessions/session-storage.ts`
  - `packages/shared/src/sessions/storage.ts`
  - `packages/shared/src/sessions/persistence-queue.ts`
  - `packages/shared/src/sessions/bundle.ts`
- agent、sidecar 与凭据隔离：
  - `packages/shared/src/agent/base-agent.ts`
  - `packages/shared/src/agent/claude-agent.ts`
  - `packages/shared/src/agent/pi-agent.ts`
  - `packages/shared/src/agent/core/prompt-builder.ts`
  - `packages/shared/src/agent/session-scoped-tools.ts`
  - `packages/shared/src/agent/tool-env-sanitizer.ts`
  - `packages/pi-agent-server/src/index.ts`
  - `packages/shared/src/credentials/backends/secure-storage.ts`
  - `packages/session-tools-core/src/runtime/sandbox-env.ts`
- process identity：
  - `packages/shared/src/utils/process-identity.ts`
- 主要新增测试：
  - `apps/cli/src/one-shot.test.ts`
  - `apps/cli/src/server-spawner.integration.test.ts`
  - `packages/shared/src/sessions/session-storage.test.ts`
  - `packages/shared/src/credentials/__tests__/secure-storage-write-lock.test.ts`
  - `packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts`

## 上一轮 11 个 reviewer issue 的逐项修复

1. **Invocation credential 进入通用环境或持久化边界**
   - API key 不再通过 runtime 环境变量传递，改为 CLI 到 runtime 的 inherited pipe bootstrap frame，并只写入 invocation credential overlay。
   - server child 启动前按 key 和 secret value 双重过滤父环境；quiet diagnostics、event adapter 和 rooted persistence boundary 统一脱敏 Authorization、已知 secret 和常见 key 格式。
   - Claude CLI runtime 不再修改 server `process.env`；model runtime 使用 invocation-scoped override。Claude/Pi 的 Bash tool 命令执行前显式清除全部 credential env；session tools 的 subprocess env 同步扩充 blocked key。
   - OAuth 轮换继续写共享 identity，但使用跨进程写锁、锁内重新读取和原子 store 写入，避免 Electron/CLI 互相覆盖。

2. **`typed_error`/provider auth failure 被后续 `complete` 覆盖**
   - `waitForTurn` 将 `typed_error` 作为 terminal failure；首个 terminal result 胜出，后续 `complete` 无法改写。
   - 普通模式保持 stdout 为空并退出 1；JSON 协议启动后由 cleanup 完成后发 `error` 和 `turn.failed`。

3. **Timer persistence write 不在 in-flight chain**
   - debounce timer 和显式 flush 全部进入同一个 per-session promise chain。
   - `flush`/`flushAll` 循环等待 pending 与 in-flight 同时清空，并传播写入错误；新增真实 JSONL durability race 测试。

4. **Resume 忽略 Thread 保存的 connection**
   - 恢复顺序固定为：显式参数 → invocation 环境凭据 → Thread 保存的非秘密 connection snapshot → 当前配置默认值。
   - Thread 保存 provider/model/base URL/provider type/auth type/custom endpoint；OAuth 等 connection shape 在 resume 时不被错误降级为 API key connection。

5. **`SessionStorage` 仍是全局切换而非完整显式服务**
   - 删除可变 global active storage setter/getter；新增完整实例接口，覆盖 CRUD、flush/delete、attachments、plans、data、downloads、long responses、meta 和 bundle 路径。
   - 每个 storage 实例自有 persistence queue；`SessionManager`、files RPC、search、bundle/import/export、branch/fork/spawn、browser、MCP/session tools、prompt builder、tool metadata、diagnostics 和 provider anchors 显式接收或从 runtime-owned storage 解析。
   - 仅保留 immutable Electron compatibility storage/queue 给旧函数调用；CLI runtime 链路不使用这些 singleton。

6. **Lease 仅按 PID 判断，无法抵御 PID reuse**
   - 新增 OS birth identity：Linux `/proc` start ticks，macOS/Unix process start marker，Windows process start ticks。
   - owner/heartbeat 同时记录 CLI 与 runtime birth identity；active、concurrent resume、owner monitor 和 stale cleanup 都校验 PID + birth identity。
   - stale cleaner 仍只回收 CLI/runtime identity 均不存在、lease 已失效且 heartbeat 超过十分钟的 ephemeral Thread。

7. **全新 config root 缺少默认配置**
   - global 配置根不存在时允许 CLI-first 启动；snapshot 从 bundled read-only `config-defaults.json` 初始化，并生成最小私有 `config.json`。
   - 不依赖 Electron 预先运行或初始化配置。

8. **Quiet runtime 不 drain stderr**
   - 所有模式持续异步 drain stderr。
   - quiet 模式只保留 16 KiB 有界、跨 chunk 脱敏的诊断 tail；启动失败时只把脱敏诊断送入 stderr。

9. **Tool failure 被映射成 `item.completed/exit_code: 0`**
   - `ExecEventAdapter` 根据 `isError` 产生 `item.failed`、`status: failed`、非零 exit code，并脱敏错误内容。
   - 测试明确拒绝同一失败 tool id 出现成功完成事件。

10. **Lease acquisition 和早期失败在 lifecycle cleanup 外**
    - Thread 创建后立即进入单一幂等 cleanup state machine；scope 解析、lease、snapshot、spawn、RPC 和输出处理都受最外层 `try/finally` 控制。
    - 新 Thread 的早期失败会写入 `failed`、释放 owner lease，并按 persistence 规则保留或删除；ephemeral clone 在交给外层前失败会自行 rollback。
    - 独立进程测试覆盖 runtime entry 不存在时 stdout 为空、Thread 为 failed、owner 文件已释放且 Electron sessions 未创建。

11. **Parser 在识别 locator 前处理 `--`**
    - parser 记录 separator 前的位置参数边界，先解析 `resume/delete` 及 thread locator，再把 separator 后内容解释为 prompt。
    - `polo exec resume <uuid> -- continue` 正常；`polo exec -- sessions` 仍把 `sessions` 当 prompt；locator 放到 `--` 后会按缺失 locator 报 usage error。

## 自测结果

- 全量：`bun run test`
  - 标准测试阶段：**4795 pass，19 skip，0 fail**；共 4814 tests / 367 files。
  - 随后的 **13/13 isolated test files 全部通过**。
  - 整条命令退出码 0。
- 类型检查：
  - `bun run typecheck:all`：通过。
  - `(cd apps/cli && bun run typecheck)`：通过。
- 子进程构建：
  - `bun run server:build:subprocess`：通过；session MCP server 和 Pi agent server 均成功 bundle。
- reviewer 缺陷专项：
  - `bun test ./apps/cli/src/execution-parser.test.ts ./apps/cli/src/exec-event-adapter.test.ts ./apps/cli/src/cli-thread-store.test.ts ./apps/cli/src/one-shot.test.ts ./apps/cli/src/server-spawner.integration.test.ts ./packages/shared/src/sessions/session-storage.test.ts ./packages/shared/src/sessions/__tests__/persistence-queue.test.ts ./packages/shared/src/credentials/__tests__/secure-storage-write-lock.test.ts ./packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts`
  - **34 pass，0 fail**。
- 独立进程 smoke：
  - noisy child 连续写 stderr：无 pipe deadlock，诊断不超过 16 KiB，secret 不在 child env/diagnostics。
  - owner 进程 `SIGKILL`：实际 cli-one-shot runtime 通过 inherited-pipe EOF 自行退出，birth identity 不再存活。
  - concurrent resume：独立 contender 立即退出 1，stdout 为空，stderr 报 `already active`。
  - runtime 启动失败：独立 CLI 退出 1，stdout 为空，Thread 终态为 failed，owner lease 已释放。
  - Bash tool credential smoke：独立 Bash 子进程看不到 model runtime 的 `ANTHROPIC_API_KEY`。
- 其他校验：
  - `git diff --check`：通过。
  - `.pipeline/runs/5d61da8b/`：无变更。

## 遗留问题

- 无已知 P0 阻塞遗留。
- 需求中列明的 P1（`--sandbox`、`--add-dir`、`exec review`、自动 retention/prune、显式 fork 等）仍按原范围不实现。
- 本轮独立进程 smoke 在 macOS 完成；Windows ACL、Windows process birth marker 和 Windows Job Object 路径由跨平台实现及现有跳过策略覆盖，但未在 Windows 真机执行。

## 提交

- 本轮提交信息：`POO-16: 修复 CLI runtime 隔离与生命周期缺陷`
- 未执行 push。
