# POO-16 Reviewer 第 4 轮修复报告

## 变更摘要

基于 `6d3ca668e4998d55b018b373af8bf24191dcf1b2` 完成 Reviewer 第 4 轮全部 2 项 major 修复，并在不扩大安全或兼容风险的前提下完成 2 项去重建议。

1. **完整生命周期信号处理**
   - `executeTurn` 在第一次异步操作前安装平台可捕获信号 handler，并保持到 runtime 停止、Thread 终态持久化、retention、lease 释放等 cleanup 全部完成后才移除。
   - handler 只记录首个信号；已有 session 时立即请求 cancel，RPC 正在 connect 或 `session:create` 且尚无 session ID 时主动断开 client，避免等待完整 RPC timeout。
   - Thread create、配置 snapshot、spawnServer、connect、`session:create`、turn 和 cleanup 都使用同一 interrupted 结果与幂等 cleanup 路径。
   - 新 Thread 在 main session 建立前被中断时删除整个不可恢复 Thread；main session 已原子记录后被中断的持久 Thread 保留为 `interrupted` 并可 resume；ephemeral Thread 始终删除。
   - 新增真实子进程信号注入 fixture，分别在 Thread create（SIGTERM 与 SIGINT）、snapshot、spawnServer、connect 和 `session:create` 精确暂停并发送 OS 信号；同时验证第二个信号不会覆盖首个信号、正确退出码、无 stdout/stderr、无 orphan runtime、无 owner 残留及正确 retention。
2. **历史半创建 Thread 的安全回收**
   - Thread mkdir 后立即写入私有 `creating.json`，记录 PID、process birth identity 和创建时间；`thread.json` 原子完成后删除 marker。
   - `listCliThreads` 与 stale cleaner 共用底层目录 scanner：正常列表仍不广告半创建 Thread，cleaner 则能识别缺失 `thread.json` 的历史目录。
   - 半创建目录只有在 canonical CLI root 内、UUID 目录、创建者/CLI owner/runtime/删除发起者均不存在、lease 失效且最后证据超过十分钟时，才在 Thread state lock 下写 deleting marker 并原子 move-to-trash。
   - 新增“历史半创建目录被回收、仍有有效创建者身份的目录保留”回归。
3. **`resume --last` 完整性筛选**
   - 候选按 `lastUsedAt` 扫描时先排除非 `cli-exec`、非 persistent、scope/cwd 不匹配、running 或 deleting Thread。
   - 再复用 `readCliMainSessionSummary`，只接受 `state=ok`；缺失 `mainSessionId`、缺失 JSONL、非法 header 和其他 corrupt 状态全部跳过并继续扫描更旧候选。
   - 新增真实 CLI/runtime 集成测试：最新 running、deleting、missing main ID、missing JSONL、invalid header 均被跳过，最终选择更旧的有效 Thread；`thread.started.thread_id` 已核对。
4. **provider env mapping 去重**
   - 将 provider 到 API-key 环境变量的映射移入无副作用的 `apps/cli/src/provider-env.ts`。
   - one-shot runner 与兼容 CLI 入口共同导入，删除两份重复定义，不改变优先级或 Electron 行为。
5. **tool environment allowlist 单一来源**
   - session-tools-core 定义规范化 allowlist names，并由其生成 Set、POSIX shell case pattern 和统一 predicate。
   - Bash sanitizer、script sandbox 和 stdio MCP 环境策略均使用该来源。
   - 增加 Set 与 shell pattern 集合一致性测试；通过细粒度 package subpath export 避免把 session-tools-core 整体打入 Pi bundle。

## 关键文件

- 生命周期与 resume 选择
  - `apps/cli/src/one-shot.ts`
  - `apps/cli/src/server-spawner.integration.test.ts`
  - `apps/cli/src/__fixtures__/execution-signal-stage.ts`
- 半创建 Thread 与 stale cleanup
  - `apps/cli/src/cli-thread-store.ts`
  - `apps/cli/src/cli-thread-store.test.ts`
- provider env 单一来源
  - `apps/cli/src/provider-env.ts`
  - `apps/cli/src/index.ts`
  - `apps/cli/src/one-shot.ts`
- tool env allowlist 单一来源
  - `packages/session-tools-core/package.json`
  - `packages/session-tools-core/src/index.ts`
  - `packages/session-tools-core/src/runtime/sandbox-env.ts`
  - `packages/session-tools-core/src/runtime/sandbox-env.test.ts`
  - `packages/shared/src/agent/tool-env-sanitizer.ts`
  - `packages/shared/src/mcp/client.ts`

## 自测结果

### Reviewer 要求的全量、类型与 build

- `bun run test`
  - 主测试阶段：**4852 pass，19 skip，0 fail**，377 files。
  - isolated 测试阶段合计：**149 pass，0 fail**。
  - 总计：**5001 pass，19 skip，0 fail**；最终退出码 0。
- `bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过；退出码 0。
- `(cd apps/cli && bun run typecheck)`
  - 通过；退出码 0。
- `bun run server:build:subprocess`
  - session MCP server：390 modules，4.58 MB。
  - Pi agent server：3999 modules，20.41 MB。
  - 两个 subprocess bundle 均通过；退出码 0。
- `git diff --check`
  - 通过。

### Reviewer 聚焦回归

- `bun test apps/cli/src/credential-reflection.integration.test.ts apps/cli/src/cli-thread-store.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/server-spawner.integration.test.ts apps/cli/src/terminal-output.test.ts packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts packages/shared/src/agent/__tests__/invocation-model-env.test.ts packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts packages/shared/src/mcp/__tests__/client-environment.test.ts packages/shared/src/sessions/session-storage.test.ts packages/session-tools-core/src/runtime/sandbox-env.test.ts packages/session-tools-core/src/source-helpers.test.ts packages/server-core/src/handlers/rpc/files-attachment-security.test.ts packages/server-core/src/sessions/import-reservation.test.ts packages/server-core/src/sessions/session-sidecar-permissions.test.ts packages/shared/src/utils/__tests__/large-response.test.ts packages/shared/src/agent/__tests__/build-call-llm-request.test.ts packages/shared/src/agent/__tests__/pi-query-llm.test.ts packages/pi-agent-server/src/session-tool-registration.test.ts`
  - **124 pass，0 fail，699 expect**，19 files。
- `bun test apps/cli/src/server-spawner.integration.test.ts --test-name-pattern "startup lifecycle|resume --last"`
  - **2 pass，0 fail，46 expect**。
- `bun test apps/cli/src/cli-thread-store.test.ts --test-name-pattern "serializes delete" --rerun-each=10`
  - **10 pass，0 fail，900 expect**；覆盖 300 轮真实多进程 delete/acquire 竞争。

### 必须复现项

- startup SIGTERM：通过。默认 persistent exec 在 Thread create 边界收到 SIGTERM 后返回 143，未留下 Thread 目录；随后注入的 SIGINT 不覆盖首个信号。
- startup SIGINT：通过。Thread create 边界返回 130，未留下 Thread 目录。
- snapshot、spawnServer、connect：通过。SIGTERM 均返回 143，未留下不可 resume Thread，runtime/owner 均清理。
- `session:create`：通过。main session ID 先持久化，SIGTERM 后 Thread 为 `interrupted`、owner 已释放、runtime 已退出，可作为合法 resume 候选。
- 历史半创建目录：通过。过期且无任何有效身份/lease 的目录被回收；同样过期但创建者 birth identity 有效的目录不回收。
- corrupt `resume --last`：通过。最新的 running、deleting、missing mainSessionId、missing JSONL、invalid header 候选全部跳过，`thread.started` 选择次新的完整 Thread。
- tool allowlist：通过。Bash shell pattern 与 sandbox Set 从同一 names 列表生成并验证集合一致，Electron 自定义环境回归保持通过。

## 遗留问题

- 无已知 Reviewer 第 4 轮范围内遗留问题。
- POSIX 信号、process birth identity、目录 mode 和多进程回归在 macOS 执行；Windows 不支持相同信号注入，本轮未在 Windows 真机验证。
- 未使用真实第三方付费 provider 发起外网请求；本轮未改动 credential proxy 契约，相关专项与全量回归继续通过。
- 需求快照中的 P1 功能仍按原范围不实现。
