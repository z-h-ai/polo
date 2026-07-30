# POO-16 Reviewer 第 3 轮修复报告

## 变更摘要

基于 `7a384270ceed110a8c329d0610e18354c14e388d` 完成 Reviewer 第 3 轮全部 8 项修复，继续保持 CLI Thread、Electron session、共享凭据和模型/工具子进程之间的既定隔离边界。

1. **可恢复的 takeover lock**
   - `.owner.takeover.lock` 现在记录唯一 lock ID、操作类型、PID、OS process birth identity 和创建时间。
   - 遇到已存在 lock 时先校验完整记录、进程出生身份及 60 秒安全窗口；只有原身份已不存在且超过窗口才允许回收。
   - 回收使用同目录原子 rename，并在 rename 后核对 lock ID，避免误删已被替换的新锁；随后重新进入正常 acquire 流程。
   - 新增过期 orphan takeover lock 负向/恢复测试。
2. **ephemeral 删除证据与 ownerless stale cleanup**
   - 删除前写入私有、原子的 `deleting.json` tombstone，保存 owner/lease、删除发起者身份和最后 heartbeat。
   - 正常 ephemeral cleanup 在持有自身 lease 时进入 deleting 并原子 move-to-trash，不再先释放最后一份 ownership 证据。
   - stale cleaner 可依据 tombstone，或创建后尚未来得及取得 owner 的旧 metadata，严格复核 CLI owner、runtime、删除发起者均不存在、租约失效且 heartbeat 超过十分钟后回收。
   - 新增 ownerless、超时 ephemeral Thread 回收测试。
3. **delete/acquire/stale 共用原子状态机**
   - acquire、heartbeat、release、delete、stale takeover 和 stale move 统一通过 Thread state lock 串行化。
   - delete 先原子进入 `deleting`，随后在同一状态锁内重新读取 owner 并校验期望 lease；acquire 遇到 deleting 立即拒绝。
   - move-to-trash 发生在状态锁保护范围内，防止 delete 判空后 resume 又成功取得 lease。
   - 新增真实多进程 30 轮 delete/acquire 压力测试，每轮只允许一方成功。
4. **按既有 connection identity 解析显式 provider/base URL**
   - 显式 `--provider` 会同时匹配 connection 的 provider、providerType 和 piAuthProvider；显式 `--base-url` 使用移除凭据后的规范化 URL 匹配。
   - 只有配置快照中没有匹配 identity 时才创建 invocation synthetic connection。
   - 凭据优先级统一为命令参数、当前 invocation 环境、匹配 identity 的共享 credential manager。
   - API key 及 OAuth access/refresh/id token 只通过继承 pipe 进入 runtime 内存；Thread metadata 只保留非秘密 connection 快照。
   - OAuth refresh 仍由共享 credential manager 的写入锁原子更新同一 identity，同时刷新 invocation overlay。
5. **Claude 使用 Thread 私有 config/home**
   - invocation-scoped Claude 不再读取、修复或清理共享 `~/.claude.json`、backup 或 corrupted 文件。
   - CLI Claude 使用当前 session `meta/claude-home`，目录 0700、配置文件 0600。
   - Electron/普通 session 继续保持既有 shared-home 行为；共享 OAuth 轮换仍只经 credential manager。
   - 新增共享 HOME 保持原样及私有 Claude config 权限测试。
6. **CLI runtime 与模型子进程显式环境白名单**
   - 新增共享 runtime environment allowlist，只保留进程启动所需的 PATH、locale、临时目录及平台基础变量，再显式加入 Thread 路径、loopback URL 和 opaque capability。
   - CLI runtime 不再以 credential 名称 denylist 作为隔离边界。
   - Claude/Pi invocation 子进程分别使用私有 HOME 和 allowlist；未知自定义 OAuth/API-key 变量以及 Pi `config.env` 不会进入模型子进程。
   - Electron Pi session 仍保留原有 parent/config/AWS/proxy 自定义环境行为。
7. **files RPC 统一使用注入的 SessionStorage**
   - server 与 Electron 都向 files handler 注入当前 `SessionStorage`，attachments 路径由 storage resolver 解析。
   - 创建目录、attachment、thumbnail 和 markdown sidecar 前逐级 `lstat`，拒绝 symlink，并通过 `realpath` 校验 canonical CLI root containment。
   - 文件使用 no-follow、独占创建并固定 0600；目录固定 0700；失败时不跟随外部 symlink 写入。
   - 新增 attachments 被替换为外部 symlink 的负向测试，以及 attachment/thumbnail 权限测试。
8. **顶层帮助与 README 契约对齐**
   - `polo` 作为主入口，`polo-ai` 仅说明为兼容别名。
   - 顶层 help 和 README 列出 `exec`、`exec resume`、`exec sessions`、`exec delete`。
   - 明确 `run`/`exec` 使用独立 CLI runtime 和 CLI Thread root，即使 Electron 已运行也不复用其 server。
   - 明确 `-C/--cd` 只设置执行目录，不注册 Polo workspace。

## 关键文件

- Thread ownership、删除状态机和压力 fixture
  - `apps/cli/src/cli-thread-store.ts`
  - `apps/cli/src/cli-thread-store.test.ts`
  - `apps/cli/src/__fixtures__/thread-state-race-worker.ts`
- connection identity、凭据传递与 runtime 生命周期
  - `apps/cli/src/one-shot.ts`
  - `apps/cli/src/server-spawner.ts`
  - `apps/cli/src/server-spawner.integration.test.ts`
  - `apps/cli/src/__fixtures__/connection-resolution.ts`
  - `apps/cli/src/__fixtures__/noisy-server.ts`
  - `packages/server/src/index.ts`
  - `packages/shared/src/credentials/manager.ts`
- Claude/Pi 子进程环境
  - `packages/shared/src/utils/runtime-env.ts`
  - `packages/shared/src/utils/index.ts`
  - `packages/shared/src/agent/options.ts`
  - `packages/shared/src/agent/claude-agent.ts`
  - `packages/shared/src/agent/pi-agent.ts`
  - `packages/shared/src/agent/__tests__/invocation-model-env.test.ts`
- files RPC
  - `packages/server-core/src/handlers/handler-deps.ts`
  - `packages/server-core/src/handlers/rpc/files.ts`
  - `packages/server-core/src/handlers/rpc/files-attachment-security.test.ts`
  - `apps/electron/src/main/index.ts`
- 帮助与文档
  - `apps/cli/src/index.ts`
  - `apps/cli/src/index.test.ts`
  - `README.md`

## 自测结果

### Reviewer 全量、类型与 build 命令

- `bun run test`
  - 主测试阶段：**4848 pass，19 skip，0 fail**，377 files。
  - isolated 测试阶段合计：**149 pass，0 fail**。
  - 总计：**4997 pass，19 skip，0 fail**；最终退出码 0。
- `bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过；退出码 0。
- `(cd apps/cli && bun run typecheck)`
  - 通过；退出码 0。
- `bun run server:build:subprocess`
  - session MCP server：390 modules，4.58 MB。
  - Pi agent server：3998 modules，20.41 MB。
  - 两个 subprocess bundle 均通过；退出码 0。

### Reviewer 原命令中的聚焦回归

- `bun test apps/cli/src/cli-thread-store.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/credential-reflection.integration.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/terminal-output.test.ts apps/cli/src/server-spawner.integration.test.ts packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts packages/shared/src/mcp/__tests__/client-environment.test.ts packages/shared/src/sessions/session-storage.test.ts packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts packages/session-tools-core/src/runtime/sandbox-env.test.ts packages/session-tools-core/src/source-helpers.test.ts packages/server-core/src/sessions/session-sidecar-permissions.test.ts packages/server-core/src/sessions/import-reservation.test.ts`
  - **67 pass，0 fail，467 expect**，14 files。
- `bun test packages/shared/src/utils/__tests__/large-response.test.ts packages/shared/tests/mcp-pool.test.ts packages/shared/src/agent/__tests__/build-call-llm-request.test.ts packages/shared/src/agent/__tests__/pi-query-llm.test.ts packages/pi-agent-server/src/session-tool-registration.test.ts packages/session-tools-core/src/source-helpers.test.ts`
  - **58 pass，0 fail，205 expect**，6 files。

### 本轮新增与直接相关回归

- `bun test apps/cli/src/cli-thread-store.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/index.test.ts packages/shared/src/agent/__tests__/invocation-model-env.test.ts packages/server-core/src/handlers/rpc/files-attachment-security.test.ts apps/cli/src/server-spawner.integration.test.ts`
  - **38 pass，0 fail，339 expect**，6 files。
- `git diff --check`
  - 通过。

### 必须复现项

- orphan takeover lock：通过。有效身份或安全窗口内拒绝回收；死亡身份且超过窗口时经 CAS rename 回收并取得 lease。
- ownerless stale cleanup：通过。超过十分钟且 CLI/runtime/有效 lease 均不存在的 ephemeral Thread 被移入 trash。
- delete/acquire 竞态：通过。真实多进程 30 轮压力测试中每轮只有 delete 或 acquire 一方成功。
- stored credential identity：通过。显式 provider/base URL 复用配置快照中的 `stored-openai` identity，并从共享 manager 取得 invocation credential；Thread metadata 不含秘密。
- 共享 Claude config：通过。CLI 调用不修改 shared HOME 中 config、backup 或 corrupted 文件，只创建 Thread 私有 0700/0600 配置。
- unknown env secret：通过。真实 runtime、Claude 和 Pi 子进程均看不到未识别的自定义 OAuth/API-key 变量；Electron Pi custom env 回归通过。
- files RPC symlink/mode：通过。被替换为外部 symlink 的 attachments 写入被拒绝且外部目录无新增；正常 attachment、thumbnail、markdown sidecar 均走安全 resolver，目录 0700、文件 0600。
- 顶层 help/README：通过。主入口、管理子命令、独立 runtime 和 `-C` 边界均与需求一致。

## 遗留问题

- 无已知 Reviewer 第 3 轮范围内遗留问题。
- 未使用真实第三方付费 provider credential 发起外网请求；stored identity、OAuth/API-key 内存传递及环境隔离使用本地 credential manager、fixture 和真实本地子进程验证。
- Unix/macOS 的 symlink、process birth identity、mode 和 POSIX 多进程压力测试已执行；本轮未在 Windows 真机验证 ACL 与进程身份实现。
- 需求快照中的 P1 功能仍按原范围不实现。
