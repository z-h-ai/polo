# POO-16 人工裁决修复实施报告

## 变更摘要

- 完成 Pi 的 Thread 路径注入：web fetch、large response、`call_llm` 及 mini completion 均从当前 `SessionStorage` 解析出的显式 `sessionPath` 工作，不再回退 Electron workspace session root。
- 删除 session MCP 的模块级 mutable resolver；skill validation 通过当前 session context 获取路径。两个临时 title agent 均注入当前 `SessionStorage`。
- 修正 Thread ownership：有效进程启动身份或新鲜 lease heartbeat 任一存在即判活；stale cleaner 仅回收 lease 过期、CLI/runtime 身份均不存在且 heartbeat 超过十分钟的 ephemeral Thread。
- `resume --ephemeral` 在 clone 前完成 scope 和工作目录验证；Thread 创建、clone/copy 任一步失败均回滚临时 Thread。
- Session ID 使用非递归 `mkdir` 原子预留，并在并发冲突时重新生成；保存失败会删除已预留目录。
- 删除和移动 Thread 前使用 `lstat`、`realpath`、canonical CLI root containment 校验并拒绝 symlink；统一受控文件 unlink 路径。
- 落地 invocation-scoped loopback credential proxy：
  - 真实 API key、OAuth access token 和 Authorization header 仅存在 CLI runtime 内存，由 loopback proxy 注入上游请求。
  - Claude/Pi model subprocess 只接收本地 proxy URL 和不透明 capability。
  - ChatGPT Codex 使用只含非秘密 routing claim 的 provider-shaped capability，真实 JWT 不进入 model subprocess；search 同样经 proxy。
  - OAuth 更新只替换 runtime 内 proxy target，child 始终只收到 capability。
  - Bash 和 session-tool 子进程环境改为显式白名单，capability 和任意宿主秘密变量均不进入工具环境。
- Thread JSON、provider anchor、API error、tool metadata 等 sidecar 使用私有临时文件加 rename 原子写入；CLI 目录/文件统一强化为 `0700`/`0600`。web fetch、downloads、large responses 等 artifact 同步使用私有权限。
- `--color` 仅装饰 stderr；普通 stdout、JSONL 和 run 文本输出移除 ANSI。`-o` 仍保留最终 assistant message 原文且无附加换行。

## 关键文件列表

- CLI 生命周期、ownership、路径与输出：
  - `apps/cli/src/cli-thread-store.ts`
  - `apps/cli/src/one-shot.ts`
  - `apps/cli/src/index.ts`
  - `apps/cli/src/exec-event-adapter.ts`
  - `apps/cli/src/terminal-output.ts`
- credential proxy 与 agent 隔离：
  - `packages/shared/src/credentials/invocation-credential-proxy.ts`
  - `packages/shared/src/agent/claude-agent.ts`
  - `packages/shared/src/agent/pi-agent.ts`
  - `packages/shared/src/agent/tool-env-sanitizer.ts`
  - `packages/pi-agent-server/src/index.ts`
  - `packages/pi-agent-server/src/tools/search/resolve-provider.ts`
  - `packages/pi-agent-server/src/tools/search/providers/chatgpt.ts`
  - `packages/pi-agent-server/src/tools/search/providers/google.ts`
- SessionStorage、MCP 与 sidecar：
  - `packages/shared/src/sessions/session-storage.ts`
  - `packages/shared/src/sessions/storage.ts`
  - `packages/server-core/src/sessions/SessionManager.ts`
  - `packages/session-mcp-server/src/index.ts`
  - `packages/session-tools-core/src/source-helpers.ts`
  - `packages/session-tools-core/src/handlers/skill-validate.ts`
  - `packages/session-tools-core/src/runtime/sandbox-env.ts`
  - `packages/shared/src/interceptor-common.ts`
  - `packages/shared/src/utils/binary-detection.ts`
  - `packages/shared/src/utils/large-response.ts`
  - `packages/pi-agent-server/src/tools/web-fetch.ts`
- 新增或扩充的专项测试：
  - `apps/cli/src/cli-thread-store.test.ts`
  - `apps/cli/src/one-shot.test.ts`
  - `apps/cli/src/terminal-output.test.ts`
  - `packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts`
  - `packages/shared/src/sessions/session-storage.test.ts`
  - `packages/server-core/src/sessions/session-sidecar-permissions.test.ts`
  - `packages/session-tools-core/src/source-helpers.test.ts`

## 自测结果

- `bun run test`
  - 最终标准测试阶段：**4809 pass，19 skip，0 fail**，共 4828 tests / 371 files。
  - 随后的 **13/13 isolated test files 全部通过**。
  - 整条命令最终退出码 0。
- 裁决项集中回归：
  - `bun test apps/cli/src/cli-thread-store.test.ts apps/cli/src/one-shot.test.ts apps/cli/src/exec-event-adapter.test.ts apps/cli/src/terminal-output.test.ts packages/shared/src/sessions/session-storage.test.ts packages/shared/src/agent/__tests__/tool-env-sanitizer.test.ts packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts packages/session-tools-core/src/runtime/sandbox-env.test.ts packages/session-tools-core/src/source-helpers.test.ts packages/pi-agent-server/src/tools/search/resolve-provider.test.ts packages/server-core/src/sessions/session-sidecar-permissions.test.ts`
  - **43 pass，0 fail**。
- 最终 credential/output/sidecar 专项：
  - `bun test apps/cli/src/one-shot.test.ts apps/cli/src/terminal-output.test.ts packages/shared/src/credentials/__tests__/invocation-credential-proxy.test.ts packages/pi-agent-server/src/tools/search/providers/chatgpt.test.ts packages/server-core/src/sessions/session-sidecar-permissions.test.ts`
  - **25 pass，0 fail**。
- `bun run typecheck:all`
  - 全部 package TypeScript 检查通过。
- `bun run server:build:subprocess`
  - session MCP server 与 Pi agent server 均成功 bundle。
- CLI 输出 smoke：
  - `bun apps/cli/src/index.ts exec --color always --unsupported`
  - 退出码 2；stdout 为空且无 ANSI；stderr 包含彩色 Error label。
- `git diff --check`
  - 通过。

## 遗留问题

- 无已知 P0 阻塞遗留。
- 本轮未使用真实第三方凭据执行外网 provider E2E；credential proxy 已通过本地 loopback upstream 集成测试、provider-shaped capability 测试、ChatGPT search proxy routing 测试和全量回归验证。
- Windows ACL 与 Windows 进程路径未在 Windows 真机执行；现有 Windows 分支保持当前用户 ACL 语义。
- 需求快照中列明的 P1 参数与功能仍按原范围不实现。

## 提交约定

- 本轮提交信息：`POO-16: 完成人工裁决隔离修复`
- 不执行 push。
