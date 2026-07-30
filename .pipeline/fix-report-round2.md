# POO-16 Reviewer 第 2 轮修复报告

## 变更摘要

基于 `99c8aaea852b9922a25bbbb7a9b51ea1aafeee4c` 完成 Reviewer 第 2 轮全部 10 项修复，保持 CLI/Electron 运行时隔离、严格凭据隔离及 `polo-ai` 兼容入口不变。

1. **封闭旧 `cmdRun` 路径**
   - 删除会启动完整 server、注册 workspace 和写入 Electron session 的旧 `cmdRun` 实现。
   - `run`/`exec` 探测统一使用完整 `CLI_OPTION_ARITY` 定义；值参数在命令前后均不会造成路由回退。
   - `run --url/--token/--tls-ca` 及这些参数位于 `run` 前的形式均明确返回 usage error/exit 2。
   - 保留顶层防御性 guard：若未来解析器发生漂移，`run` 也只会退出 2，不会进入完整 server。
2. **stdio MCP 子进程环境隔离**
   - 为 `PoloMcpClient`/`McpClientPool` 增加显式 runtime-scoped `environmentPolicy`。
   - CLI one-shot 只从批准白名单构造 stdio 环境；宿主自定义 key/token 不再继承。
   - `config.env` 中 credential-like 名称或值在 spawn 前拒绝，非白名单普通变量不传入。
   - Electron/desktop policy 继续保留原有自定义 `process.env` 与 `config.env` 行为。
3. **base URL metadata 秘密防护**
   - `--base-url` 和 resolved connection 两条路径在 Thread 创建/更新前统一规范化。
   - 只允许绝对 `http(s)` URL；拒绝 userinfo、fragment 及 `api_key`、`token`、`access_token`、OAuth、Authorization、password、secret 等敏感 query key。
   - 错误信息不回显原 URL；参数路径在创建 Thread 前失败，resolved connection 路径也不会把秘密写入 `thread.json`。
4. **ACK 后断连与 heartbeat 失败收敛**
   - `CliRpcClient` 暴露一次性 transport disconnect/error Promise。
   - turn terminal result、RPC 断连和 lease lifecycle failure 统一竞速；失败时主动 cancel。
   - heartbeat 持久化失败会触发 turn failed，而不是只记录一个永远不会结束的 cleanup error。
   - cleanup 保持幂等，断连/heartbeat 两条集成路径均写入 `failed`、释放 owner、停止 runtime 并 exit 1。
5. **stale lease 原子接管**
   - 每个 Thread 使用 `O_EXCL` takeover lock，持锁后重新读取 owner，并核对最初观察到的 `leaseId`。
   - owner 替换使用同目录临时文件加原子 rename，整个接管期间 `owner.json` 始终存在，封闭其他进程绕过 takeover lock 直接 `wx` 成功的窗口。
   - 多进程压力测试使用 8 个 contender、5 轮；另以 `--rerun-each=20` 验证 100 轮接管均只有一个成功者。
6. **resume 定位 override 不持久化**
   - 持久 Thread 的 `resume --workspace/-C` 只影响本次 runtime。
   - cleanup 仅更新终态和 `lastUsedAt`，不写回原 Thread 的 scope、workspace/path 或 working directory。
   - 回归覆盖原/新 scope 下的 `exec sessions` 及 `resume --last` 选择行为。
7. **完整可捕获信号生命周期**
   - 按运行平台信号表安装可处理信号，明确排除不可捕获的 `SIGKILL`/`SIGSTOP` 及非中断通知信号。
   - 所有已安装信号统一执行 interrupted、cancel、flush/cleanup、ephemeral 删除、runtime 等待及 lease 释放。
   - 使用 `SIGQUIT` 验证 `128 + signal number`、持久 Thread 终态、ephemeral 删除及无孤儿 runtime。
8. **run stdout ANSI 清理**
   - text delta、tool name、tool intent 和 tool result 所有文本输出统一去除 ANSI。
   - tool result 先清理再截断，避免截断 ANSI 序列留下控制字符。
   - 覆盖 `always|never|auto` 三种 color 模式及 text/tool/stream-JSON 输出。
9. **冻结安装双 bin**
   - 更新 `bun.lock` workspace bin metadata，同时包含 `polo` 与 `polo-ai`。
   - 当前 Bun frozen install 后两个可执行文件均存在并解析到同一 `@polo-ai/cli/src/index.ts`。
10. **顶层帮助以 `polo` 为主**
    - 标题、Usage 和示例全部使用 `polo`。
    - `polo-ai` 仅在一条兼容别名说明中出现，并增加输出回归测试。

## 关键文件

- CLI 路由、帮助与参数定义
  - `apps/cli/src/execution-parser.ts`
  - `apps/cli/src/execution-parser.test.ts`
  - `apps/cli/src/index.ts`
  - `apps/cli/src/index.test.ts`
- CLI 生命周期、输出与 metadata
  - `apps/cli/src/client.ts`
  - `apps/cli/src/one-shot.ts`
  - `apps/cli/src/one-shot.test.ts`
  - `apps/cli/src/server-spawner.integration.test.ts`
  - `apps/cli/src/__fixtures__/base-url-secret.ts`
  - `apps/cli/src/__fixtures__/lifecycle-failure-server.ts`
- Thread lease 接管
  - `apps/cli/src/cli-thread-store.ts`
  - `apps/cli/src/cli-thread-store.test.ts`
  - `apps/cli/src/__fixtures__/lease-takeover-worker.ts`
- MCP runtime 环境策略
  - `packages/shared/src/mcp/client.ts`
  - `packages/shared/src/mcp/mcp-pool.ts`
  - `packages/shared/src/mcp/__tests__/client-environment.test.ts`
  - `packages/shared/src/mcp/__tests__/fixtures/mcp-server-env.mjs`
  - `packages/server-core/src/sessions/SessionManager.ts`
  - `packages/session-tools-core/src/index.ts`
- 安装入口
  - `bun.lock`

## 自测结果

### Reviewer 全量、类型与 build 命令

- `bun run test`
  - 主测试阶段：**4840 pass，19 skip，0 fail**，375 files。
  - isolated 测试阶段合计：**149 pass，0 fail**。
  - 总计：**4989 pass，19 skip，0 fail**；最终退出码 0。
- `bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过；退出码 0。
- `(cd apps/cli && bun run typecheck)`
  - 通过；退出码 0。
- `bun run server:build:subprocess`
  - session MCP server：390 modules，4.58 MB。
  - Pi agent server：3998 modules，20.41 MB。
  - 两个 subprocess bundle 均通过；退出码 0。

### Reviewer 聚焦回归与新增对抗测试

- `bun test apps/cli/src/cli-thread-store.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/terminal-output.test.ts apps/cli/src/credential-reflection.integration.test.ts apps/cli/src/server-spawner.integration.test.ts apps/cli/src/index.test.ts apps/cli/src/execution-parser.test.ts packages/shared/src/sessions/session-storage.test.ts packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts packages/shared/src/mcp/__tests__/client-environment.test.ts packages/session-tools-core/src/runtime/sandbox-env.test.ts packages/session-tools-core/src/source-helpers.test.ts packages/shared/src/utils/__tests__/large-response.test.ts packages/server-core/src/sessions/session-sidecar-permissions.test.ts packages/server-core/src/sessions/import-reservation.test.ts`
  - **96 pass，0 fail，492 expect**，17 files。
- `bun test apps/cli/src/cli-thread-store.test.ts --rerun-each=20`
  - **200 pass，0 fail，1500 expect**。
  - 覆盖 100 轮、每轮 8 个真实进程同时争用 stale lease。
- `bun install --frozen-lockfile`
  - Bun 1.3.14，退出码 0。
- `bun -e '<双 bin readlink smoke>'`
  - `polo=../@polo-ai/cli/src/index.ts`
  - `polo-ai=../@polo-ai/cli/src/index.ts`
- `git diff --check`
  - 通过。

### 必须复现项

- 旧 `cmdRun` routing：通过。`--url/--token/--tls-ca` 位于 `run` 前后均 exit 2，stdout 为空，未创建 Electron `sessions/`。
- stdio MCP env：通过。真实 stdio 子进程看不到宿主自定义 API key/token；credential-like `config.env` 在 spawn 前拒绝；Electron custom env 保持原行为。
- base URL secret：通过。userinfo/query secret 在 args 与 resolved connection 两条路径均未进入 stderr 或 Thread metadata。
- ACK 后断连：通过。exit 1、Thread `failed`、owner 清除、runtime 退出。
- heartbeat 写入失败：通过。主动结束等待并按 failed cleanup。
- stale takeover：通过。最终实现的无空窗原子替换在 20 次 test-file 重跑中 200/200 通过。
- resume scope：通过。显式 workspace/cwd override 不修改原定位 metadata，sessions/`--last` 仍以原 scope 和目录选择。
- 非标准信号：通过。`SIGQUIT` 返回 131，持久 Thread 为 `interrupted`，ephemeral Thread 删除，无孤儿 runtime。
- run ANSI：通过。三种 color 模式的 text/tool/stream-JSON stdout 均无原始 ANSI 控制字符。
- frozen bin：通过。锁定安装同时提供 `polo`/`polo-ai`，且指向同一实现。

### 验证中发现并关闭的问题

- 首次全量重跑通过新增压力用例复现了 owner 替换期间短暂删除 `owner.json` 的竞争窗口：**4839 pass，19 skip，1 fail**。
- 将 stale owner 替换改为保持目标文件存在的原子 rename 后，`--rerun-each=20`、Reviewer 聚焦测试和完整 `bun run test` 全部通过；该失败不属于遗留问题。

## 遗留问题

- 无已知 Reviewer 第 2 轮范围内遗留问题。
- 未使用真实第三方付费 provider credential 发起外网请求；credential/base URL/MCP 环境负向验证使用本地 fixture 和真实本地子进程完成。
- 非标准信号集成测试在 macOS 使用 `SIGQUIT`；Windows 不提供等价 POSIX 信号，本轮未在 Windows 真机执行。
- 需求快照中的 P1 功能仍按原范围不实现。
