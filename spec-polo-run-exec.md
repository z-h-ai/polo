# POO-16：`polo run` 独立会话存储与 `polo exec` 非交互命令方案

> 更新日期：2026-07-29<br>
> 状态：方案已完成 review 和 grilling，P0 已实施<br>
> 领域语言：[CONTEXT.md](./CONTEXT.md)
> 架构决策：[docs/adr/](./docs/adr/)

## 1. 目标

保留现有 `polo run`，新增 Codex 风格的非交互命令 `polo exec`。两者始终在独立的 CLI 执行运行时中运行，即使 Electron 已经启动，也不连接或复用 Electron RPC。

必须满足以下不变量：

- CLI Thread 从创建第一刻起不向 Electron workspace 的 `sessions/` 写入任何文件或目录。
- Electron 的 SessionManager、watcher、搜索、未读统计、automation 和通知链路永远不接触 CLI storage root。
- Electron 已运行时，`polo run` 和 `polo exec` 仍可并发启动和完成。
- CLI 运行时不成为完整 Headless Server 的另一个共享实例。
- CLI 默认只读共享配置；命令行覆盖不改变 Electron 的连接、模型、workspace 或凭据。
- 所有 Polo 管理的 CLI 会话产物都位于 CLI storage root。
- `hidden: true` 继续保留，但只作为第二层防护，不能替代物理存储隔离。
- `polo exec --yolo --json` 是 P0 必须可用的命令。

## 2. 领域模型

### 2.1 CLI Thread

一次 CLI 调用创建一个 CLI Thread。Thread 包含：

- 一个主 session。
- 该 session 创建的 branch、fork 和 `spawn_session` 派生 session。
- 一个公开且全局唯一的 UUID `thread_id`。
- 一份持久化 Thread metadata。
- 一份仅用于活跃进程所有权和租约的 owner metadata。

JSONL、`exec sessions`、`exec resume` 和 `exec delete` 都使用 `thread_id`。内部 session slug 不承担公开寻址职责。

### 2.2 Thread 状态

非 ephemeral Thread 的终态为：

```ts
type CliThreadStatus = "completed" | "failed" | "interrupted"
```

三种终态都允许 resume。运行中、删除中和损坏状态属于存储管理状态，不属于成功终态。

### 2.3 配置工作区与执行目录

配置工作区决定 sources、skills、permissions 和默认 LLM 配置；执行目录决定 agent 操作文件和运行命令的位置。两者互不等价。

新调用的配置工作区按以下顺序解析：

1. 显式 `--workspace`。
2. Polo 当前 active workspace。
3. 固定的 `global` 配置 scope。

执行目录按以下顺序解析：

1. 显式 `-C/--cd`。
2. `process.cwd()`。

`-C` 不注册 Polo workspace，不向目标目录写入 Polo 配置，也不承诺构成 sandbox 边界。

## 3. CLI 执行运行时

### 3.1 独立运行

每次 `run`、`exec` 或 `resume` 调用都启动一个独立后台执行进程。Electron 已运行时：

```text
Electron runtime ── manages only Electron sessions

CLI owner process
  └── CLI execution runtime
        └── manages one CLI Thread
```

CLI runtime：

- 使用独立 lock namespace，不获取 Electron 的全局 server lock。
- 同一个 Thread 使用独占租约；同一时间只允许一个活跃执行者。
- 只挂载本次调用需要的配置工作区。
- 不启动 ConfigWatcher、AutomationSystem、scheduler、messaging gateway、桌面通知或后台 model refresh。
- 不加载 Electron session。
- 不对外暴露修改 session storage root 的普通 RPC 参数。
- 被 CLI owner 监督；owner 消失时自行取消任务并退出。

### 3.2 配置快照

每次调用开始时读取一次不可变配置快照：

- 本次执行不实时跟随 Electron 对 model、sources、skills 或 permissions 的修改。
- Electron 后续修改只影响下一次 CLI 调用。
- 每次 resume 重新形成当前配置快照。
- resume 默认使用 Thread 原配置工作区；显式 `--workspace` 可以覆盖。
- 原配置工作区已删除且未显式覆盖时，明确失败，不静默切换。
- `config-snapshot/` 是受控 CLI Thread 内的可信本地配置副本，可以保留共享配置工作区中
  `sources/`、`skills/` 已存在的 header、env、OAuth client secret 等配置值；它不属于
  session、Thread metadata、JSONL 或日志。Unix/macOS 仍必须使用 `0700` 目录与 `0600` 文件权限。

### 3.3 共享配置写入边界

CLI 可以读取 Electron 使用的共享配置和凭据，但：

- 不创建、删除或切换共享 LLM connection。
- 不修改默认模型或 active workspace。
- 命令行 provider、model、base URL 和凭据只作用于本次调用。
- 命令行显式传入的 API key、OAuth token 等调用级秘密不写入配置快照、session、metadata、JSONL 或日志。

唯一允许的共享凭据写入是既有 OAuth credential 的生命周期刷新：

- 只更新同一 credential identity。
- 使用 Electron 与 CLI 共用的 credential manager 和写入锁。
- 不改变默认 connection 或 model。

## 4. 存储架构

### 4.1 路径

Electron 保持现有路径：

```text
~/.polo-ai/workspaces/<workspace>/sessions/<session-id>/
```

CLI 使用 Thread 层级：

```text
~/.polo-ai/cli-sessions/
  <configuration-scope-id>/
    executions/
      <thread-id>/
        thread.json
        owner.json
        sessions/
          <session-id>/
            session.jsonl
            attachments/
            plans/
            data/
            downloads/
            long_responses/
            meta/
```

没有配置工作区时，`configuration-scope-id` 使用固定值 `global`。环境变量中不得传入未展开的 `~`；CLI 必须传递经过规范化和边界校验的绝对路径。

### 4.2 Thread metadata

`thread.json` 只包含非秘密持久化信息，例如：

```ts
interface CliThreadMetadata {
  version: 1
  threadId: string
  origin: "cli-run" | "cli-exec"
  configurationScopeId: string
  configurationWorkspaceId?: string
  workingDirectory: string
  mainSessionId: string
  createdAt: number
  lastUsedAt: number
  persistence: "persistent" | "ephemeral"
  status?: "completed" | "failed" | "interrupted"
  connection?: {
    provider?: string
    model?: string
    baseUrl?: string
    connectionType?: string
  }
}
```

API key、OAuth token、Authorization header 和其他 secret 禁止进入该文件。

### 4.3 Owner metadata 与租约

`owner.json` 用于活跃调用，不代替 Thread metadata：

```ts
interface CliThreadOwner {
  leaseId: string
  cliPid: number
  cliStartedAt: number
  serverPid: number
  serverStartedAt: number
  heartbeatAt: number
}
```

实现必须考虑 PID 重用，不能只使用 `kill(pid, 0)` 判断所有权。租约创建、heartbeat 更新和终态转换必须使用原子写入。

### 4.4 Session storage 注入

不要继续让业务层以 `workspaceRootPath` 推导 session 路径。引入可注入的完整存储服务，而不是只增加一个全局变量：

```ts
interface SessionStorage {
  readonly owner: "electron" | "cli"
  readonly sessionsRoot: string

  getSessionPath(sessionId: string): string
  getSessionFilePath(sessionId: string): string
  ensureSession(sessionId: string): Promise<string>
  create(options: CreateStoredSessionOptions): Promise<StoredSession>
  load(sessionId: string): StoredSession | null
  list(): SessionMetadata[]
  save(session: StoredSession): Promise<void>
  flush(sessionId?: string): Promise<void>
  delete(sessionId: string): Promise<void>
}
```

该实例必须注入：

- SessionManager。
- session persistence queue。
- files RPC。
- session bundle/export/import。
- branch/fork/spawn session。
- browser、MCP 和 tool metadata 的 session path resolver。
- 所有附件、计划、data、download、long response 和 provider anchor sidecar。

CLI runtime 的 `sessionsRoot` 指向当前 Thread 的 `sessions/`。Electron 继续使用 workspace 默认 storage 实现。

现有 `POLO_AI_SESSION_DIR` 只表示单个活跃 session 的运行目录，不能作为 server storage root。

### 4.5 并发与路径安全

- `thread_id` 使用 UUID。
- 内部 session ID 必须通过原子目录占位或全局唯一 ID 创建，不能使用“扫描后创建”的非原子流程。
- 所有删除、移动和写入前验证 realpath 仍位于受控 CLI root。
- Unix/macOS 目录权限为 `0700`，文件权限为 `0600`。
- Windows 使用当前用户 ACL；无法主动设置时不得放宽继承权限。
- P0 不新增会话内容加密，保持与现有本地 Polo session 相同的数据保护级别。

### 4.6 隔离承诺的边界

必须位于 CLI root：

- 所有 Polo session JSONL。
- attachments、plans、data、downloads、long responses。
- branch/fork/spawn session。
- provider resume ID、turn anchor 和 Polo 管理的 sidecar。
- Thread 与 owner metadata。

Provider SDK 在 `~/.claude/` 等自有目录管理的 transcript 或缓存不承诺搬入 CLI root，但不得写入 Electron workspace，也不得被 Electron 索引。

## 5. 命令行为

安装包同时发布：

```text
polo
polo-ai
```

两个 bin 调用同一实现。帮助和新文档使用 `polo`，`polo-ai` 作为兼容别名保留。

### 5.1 `polo run`

- 始终使用独立 CLI runtime。
- 保留现有流式文本和 Polo 原生 `stream-json`。
- 保留现有 `--source`、`--mode`、`--output-format`、`--no-cleanup`、`--provider`、`--model`、`--api-key`、`--base-url` 等参数。
- session metadata 固定记录：

```ts
{
  hidden: true,
  origin: "cli-run"
}
```

- 普通 `run` 的整个 CLI Thread 为 ephemeral，成功、失败或可处理信号中断后删除。
- `run --no-cleanup` 保留整个 Thread，仅作为调试记录。
- `run --no-cleanup` 结束时在 stderr 输出 `thread_id` 和绝对目录。
- `cli-run` Thread 不出现在 `exec sessions`，不能通过 `exec resume` 恢复。
- `SIGKILL` 后残留的普通 `run` Thread 由 stale cleaner 回收。

### 5.2 `polo exec`

- 面向脚本、CI 和 agent orchestration。
- 默认 `permissionMode: safe`。
- 默认持久化整个 `cli-exec` Thread。
- 成功、失败和信号中断后分别记录 `completed`、`failed`、`interrupted`。
- 三种状态都允许 resume。
- `--ephemeral` 在成功、失败和可处理信号中断后删除整个临时 Thread。
- session metadata 固定记录：

```ts
{
  hidden: true,
  origin: "cli-exec"
}
```

### 5.3 `polo exec resume`

P0 支持：

```bash
polo exec resume <thread_id> [PROMPT]
polo exec resume --last [PROMPT]
```

原位 resume：

- 继续原 CLI Thread 和主 session。
- 更新 `lastUsedAt`。
- 默认沿用 Thread 原配置工作区和执行目录。
- 显式 `--workspace` 和 `-C` 可以覆盖。
- 同一 Thread 同时只能有一个活跃执行者。
- 并发 resume 第二个调用立即失败。
- 不自动 fork。

`resume --last`：

- 使用显式 `--workspace`，否则 active workspace，否则 `global`。
- 使用显式 `-C`，否则 `process.cwd()`。
- 配置 scope 和规范化执行目录必须同时匹配。
- 只考虑持久化 `cli-exec` Thread。
- 排除运行中、删除中和损坏 Thread。
- 按 `lastUsedAt` 降序选择。
- 无匹配项时退出 `1`，不跨目录或 workspace 猜测。

`resume --ephemeral`：

- 只读加载原 Thread 历史。
- 创建临时执行副本。
- 本次消息和结果只写入临时 Thread。
- 结束后删除临时 Thread。
- 原 Thread 不追加消息，也不更新 `lastUsedAt`。

### 5.4 `polo exec sessions`

- 只列出 `origin: cli-exec` 的持久化 Thread。
- 默认按当前配置 scope 和规范化执行目录过滤。
- 展示 `thread_id`、状态、创建时间、最近使用时间、执行目录和主 session 摘要。
- 不列 Electron session 或 `cli-run` 调试记录。

### 5.5 `polo exec delete`

```bash
polo exec delete <thread_id>
```

- 删除整个 CLI Thread。
- 正在运行、持有有效租约或删除中的 Thread 拒绝删除。
- 不操作 Electron session。

## 6. 参数与解析

### 6.1 P0

Codex 核心兼容参数：

| 参数 | Polo 行为 |
|---|---|
| `[PROMPT]` | 初始指令 |
| 无 prompt / `-` | 从 stdin 读取 |
| prompt + piped stdin | stdin 追加为独立 `<stdin>` 上下文块 |
| `--yolo` | `permissionMode: allow-all` |
| `--dangerously-bypass-approvals-and-sandbox` | `--yolo` 长别名 |
| `--json` | 稳定 Codex 核心 JSONL 子集 |
| `-m, --model` | 本次执行 model 覆盖 |
| `-C, --cd` | 设置执行目录 |
| `--ephemeral` | 不保留本次 CLI Thread |
| `--color always/never/auto` | 只控制 stderr 装饰 |
| `-o, --output-last-message` | 原子写入最终回答 |
| `-h, --help` | command-aware 帮助 |
| `-V, --version` | Polo CLI 版本 |

Polo P0 扩展：

| 参数 | 行为 |
|---|---|
| `--workspace <id>` | 选择配置工作区 |
| `--provider <name>` | 本次 provider 覆盖 |
| `--api-key <secret>` | 本次 credential 覆盖，永不持久化 |
| `--base-url <url>` | 本次 endpoint 覆盖 |

`--yolo` 映射到 Polo 应用层的 `allow-all`，不宣称实现或绕过 Codex 操作系统 sandbox。

### 6.2 Prompt 与 stdin

- `exec` 只接受一个位置参数作为 prompt。
- 没有 prompt 或 prompt 为 `-` 时读取全部 stdin。
- prompt 与 piped stdin 同时存在时，把 stdin 追加为 `<stdin>...</stdin>`。
- 交互终端无 prompt 时读取到 EOF。
- `--` 后允许 prompt 以 `-` 开头。
- 多余位置参数和空输入退出 `2`。

`run` 继续允许多个普通位置参数拼成 prompt，以保持现有用法。

### 6.3 保留子命令

以下单词在 `polo exec` 后默认解析为子命令：

```text
resume
sessions
delete
help
```

同名 prompt 必须写成：

```bash
polo exec -- "sessions"
```

`exec review` 明确报 `unsupported subcommand` 并退出 `2`。

### 6.4 严格错误

`run` 和 `exec` 遇到以下情况均退出 `2`：

- 未知或未支持选项。
- 缺少选项值。
- 非法枚举。
- 冲突选项。
- 多余位置参数。
- 不存在或不是目录的 `-C` 路径。

未知参数不得静默忽略，也不得拼入 prompt。

### 6.5 P1

以下能力不阻塞 P0：

- `--sandbox read-only|workspace-write|danger-full-access`
- `--add-dir`
- `--skip-git-repo-check`
- `-i, --image`
- `--output-schema`
- `-c, --config key=value`
- `--profile`
- `--enable` / `--disable`
- `--strict-config`
- `--oss` / `--local-provider`
- `--ignore-user-config`
- `--ignore-rules`
- `--dangerously-bypass-hook-trust`
- `exec review`
- 自动 retention/prune
- 显式 fork

P0 中传入这些参数必须明确输出 `unsupported option` 并退出 `2`。

## 7. 输出协议

### 7.1 普通模式

- 成功：stdout 只输出最终 assistant message，并追加一个换行。
- 失败或中断：stdout 为空。
- 进度、警告和错误只进入 stderr。
- stdout 永远不包含 ANSI。
- `--color` 只影响 stderr。
- `auto` 只在 stderr 为 TTY 时启用颜色。
- 非 TTY 默认不显示 spinner。

### 7.2 `--output-last-message`

- 输出文件保存最终 message 原文，不额外添加换行。
- 使用同目录临时文件、flush 和 rename 完成原子替换。
- 先写文件，成功后才允许普通模式写 stdout。
- 写入失败时退出 `1`，普通 stdout 为空。

### 7.3 JSONL

P0 发布稳定的 Codex 核心事件子集：

```jsonl
{"type":"thread.started","thread_id":"<uuid>"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"<item-id>","type":"command_execution","command":"...","status":"in_progress"}}
{"type":"item.completed","item":{"id":"<item-id>","type":"command_execution","command":"...","status":"completed","exit_code":0}}
{"type":"item.completed","item":{"id":"<message-id>","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}
```

失败事件：

```jsonl
{"type":"error","message":"..."}
{"type":"item.failed","item":{"id":"<item-id>","type":"command_execution","status":"failed"}}
{"type":"turn.failed","error":{"message":"..."}}
```

要求：

- 每行可独立 `JSON.parse`。
- stdout 不包含 server 日志、spinner、普通文本或 ANSI。
- 使用独立 `ExecEventAdapter`，不能透传内部 RPC 事件。
- 已定义事件和字段保持向后兼容。
- 使用当前 Codex CLI golden fixtures 做回归，但不承诺全部 Codex 字段或未来版本逐字段等价。
- token usage 有真实值时输出真实值，provider 不提供时使用 `0`。

参数和启动错误：

- 发出 `thread.started` 前：stdout 为空，stderr 报错。
- 发出 `thread.started` 后：使用 JSONL `error` 和 `turn.failed`。
- 默认不把同一运行错误再以普通文本写 stderr。
- `--verbose` 才允许 server 诊断日志进入 stderr。

`--json -o`：

- 可以先发最终 `agent_message` 的 `item.completed`。
- 输出文件写入成功后才发 `turn.completed`。
- 文件写入失败时发 `error` 和 `turn.failed`，退出 `1`。

## 8. 退出码与时限

| 情况 | 退出码 |
|---|---:|
| 成功 | `0` |
| 启动或运行失败 | `1` |
| 用法、未知参数、unsupported option/subcommand | `2` |
| `SIGINT` | `130` |
| `SIGTERM` | `143` |
| 其他信号 | `128 + signal number` |

JSONL `turn.failed` 记录具体 signal。

`polo exec` 不设置整体执行时限：

- agent 等待到完成、失败或信号中断。
- server 启动和 RPC 建连仍有独立短超时。
- CI 如需时限，使用外部 timeout 或编排器。

## 9. 生命周期与 cleanup

### 9.1 Owner 监督

CLI runtime 必须持续确认 CLI owner 存活：

- owner 正常退出时执行标准 cleanup。
- owner 被 `SIGKILL` 后，runtime 检测 owner 消失，自行 cancel 并退出。
- 不允许遗留孤儿 server、listener 或 Electron server lock。

### 9.2 幂等 cleanup

cleanup 只能进入一次，重复信号和错误路径复用同一 Promise：

1. 禁止接受新请求和新输出事件。
2. 必要时请求 cancel，并等待 agent 真正停止。
3. 等待所有 session 写入完成；flush 错误必须向上返回，不能吞掉。
4. 原子更新 Thread 终态和 owner metadata。
5. 成功路径处理 `-o`。
6. 按 persistence 规则保留或删除整个 Thread。
7. 断开 RPC client。
8. 停止 CLI runtime，并等待子进程退出。
9. 释放租约、移除 signal handler。
10. cleanup 完全成功后，普通模式才输出最终 stdout；JSON 模式才发 `turn.completed`。

cleanup 失败属于运行失败，退出 `1`。

### 9.3 Stale cleanup

CLI 启动时执行 opportunistic stale cleanup，不启动常驻清理 daemon。

只有同时满足以下条件才允许回收 Thread：

- `persistence: ephemeral`。
- CLI owner 和 runtime process 均不存在。
- 独占租约失效。
- 最后 heartbeat 超过十分钟。
- Thread 路径仍位于受控 CLI root。

回收过程：

1. 获取短时 root cleaner lock。
2. 将整个 Thread 原子移动到同 root 的 `trash/`。
3. 释放业务索引。
4. 递归删除 trash 中的目录。

不得清理：

- 普通持久化 `exec`。
- `run --no-cleanup`。
- 有效租约或 heartbeat 的并发运行。
- 无法验证所有权的目录。

普通 `exec` 遭 `SIGKILL` 后保留；下一次访问根据失效租约把状态修复为 `interrupted`。

## 10. Resume 凭据与配置优先级

持久化 Thread 只保存非秘密连接信息。resume 的连接解析顺序：

1. 本次 resume 显式 provider/model/base URL/credential。
2. 环境变量。
3. 配置工作区中匹配的既有 credential。

仍找不到 credential 时明确失败并提示提供方式。

配置优先级：

1. 本次显式覆盖。
2. Thread 保存的非秘密 provider/model/base URL。
3. 当前配置快照的默认连接。

## 11. 验收标准

### 11.1 Electron 隔离

- [ ] Electron 已运行时 `polo run` 和 `polo exec` 均能启动，不受 Electron server lock 阻塞。
- [ ] CLI Thread 创建前、运行中、完成后，`<workspaceRoot>/sessions` 均无任何新增文件或目录。
- [ ] CLI 执行期间启动或重启 Electron，CLI Thread 不被加载或显示。
- [ ] Electron SessionManager、watcher、搜索、未读、automation、scheduler 和通知均不接触 CLI root。
- [ ] 普通 Electron session 行为和路径保持不变。

### 11.2 配置副作用

- [ ] CLI runtime 不启动 automation、messaging、scheduler 或全局 session watcher。
- [ ] `-C` 不注册 workspace，不在代码目录创建 Polo 文件。
- [ ] provider/model/API key/base URL 参数不修改共享 connection、默认模型或 active workspace。
- [ ] 只有既有 OAuth credential 的合法 token refresh 可以原子更新共享 credential。
- [ ] 命令行显式传入的 API key、token 和 Authorization header 不进入配置快照、session、metadata、JSONL 或日志；共享配置工作区原有的 source/skill 配置值允许进入受权限保护的 `config-snapshot/`。

### 11.3 Run

- [ ] 普通 `run` 只写 CLI root，终态后删除整个 Thread。
- [ ] `run --no-cleanup` 只在 CLI root 保留 `origin: cli-run` Thread。
- [ ] `run --no-cleanup` 在 stderr 输出 `thread_id` 和绝对路径。
- [ ] `cli-run` 不能通过 `exec resume` 恢复。
- [ ] `run` 保持现有 text 和 Polo `stream-json` 输出。

### 11.4 Exec 与恢复

- [ ] 普通 `exec` 默认 `safe`，默认保留整个 `cli-exec` Thread。
- [ ] `--yolo` 和危险长别名使用 `allow-all`。
- [ ] `exec --ephemeral` 在成功、失败和可处理信号后删除整个 Thread。
- [ ] failed/interrupted 持久化 Thread 可以 resume。
- [ ] `resume <thread_id>` 原位继续，并拒绝并发 resume。
- [ ] `resume --last` 只在相同配置 scope 和 realpath 执行目录内选择。
- [ ] `resume --ephemeral` 不修改原 Thread。
- [ ] `exec sessions` 只列 CLI exec Thread。
- [ ] `exec delete` 删除整个 Thread，并拒绝删除活跃 Thread。

### 11.5 输出与解析

- [ ] `polo exec --yolo --json "hello"` 每行均可独立 `JSON.parse`。
- [ ] JSON stdout 无日志、普通文本、spinner 或 ANSI。
- [ ] 普通 exec 成功 stdout 只有最终回答，失败和中断 stdout 为空。
- [ ] `-o` 原子写入与 stdout 内容一致；写失败退出 `1`。
- [ ] `--json -o` 写失败时以 `turn.failed` 结束。
- [ ] prompt、stdin、`-` 和 `<stdin>` 追加行为通过测试。
- [ ] 未知、缺值、非法、冲突或 unsupported 参数退出 `2`。
- [ ] `run` 的未知选项不再被拼入 prompt。

### 11.6 生命周期与并发

- [ ] Electron 与至少两个并发 CLI runtime 可以同时运行。
- [ ] 并发 CLI Thread 不发生 ID、目录、`.tmp` 或 persistence queue 覆盖。
- [ ] 同一 Thread 只能持有一个活跃租约。
- [ ] CLI owner 被 `kill -9` 后，runtime 自行退出，不遗留 listener 或孤儿进程。
- [ ] 普通 `exec` 的 `kill -9` 残留可修复为 interrupted 且不会被 stale cleaner 删除。
- [ ] ephemeral Thread 只有满足全部 stale 条件后才被回收。
- [ ] cleanup 可重复调用，不重复删除、不抛出二次错误。
- [ ] `SIGINT`、`SIGTERM` 和其他信号返回约定退出码。
- [ ] `exec` 运行超过五分钟不会被内部超时终止。

## 12. 实施顺序

1. 引入 `cli-one-shot` bootstrap profile，解决独立 lock、单配置 scope、禁用后台系统和 owner 监督。
2. 抽象并注入完整 `SessionStorage`，保持 Electron 默认实现不变。
3. 增加 Thread 目录、`thread.json`、`owner.json`、租约和原子 ID 创建。
4. 覆盖 SessionManager、persistence queue、files RPC、bundle、branch/fork/spawn 和所有 sidecar 路径。
5. 增加存储负向测试，证明 CLI 从创建第一刻不触碰 Electron `sessions/`。
6. 增加 `origin`、`hidden`、Thread 状态和旧 Electron session 兼容。
7. 抽取 one-shot runner，使 `run` 使用 CLI Thread storage 且保持输出行为。
8. 实现 command-aware parser、`polo` bin 与 `polo-ai` alias。
9. 实现 `exec` P0 参数、不可变配置快照和 invocation-only LLM 覆盖。
10. 实现 `ExecEventAdapter`、普通输出、JSONL、`-o` 和退出码契约。
11. 实现 `resume`、`resume --last`、ephemeral resume、sessions 和 delete。
12. 实现 parent supervision、租约、heartbeat、幂等 cleanup 和 stale cleaner。
13. 完成 Electron 并存、重启、并发 CLI、`kill -9`、秘密泄漏和共享配置不变的端到端验收。
14. P0 全部通过后再评估 P1 参数、prune 和 fork。

## 13. 已决事项

- 对外正式命令为 `polo`，保留 `polo-ai` 兼容别名。
- 最小 `exec resume`、`exec sessions` 和 `exec delete` 属于 P0。
- JSONL 只承诺稳定 Codex 核心兼容子集。
- `exec` 默认 `safe`，危险参数显式进入 `allow-all`。
- `SIGINT` 返回 `130`，`SIGTERM` 返回 `143`。
- CLI 配置使用调用级快照，不实时跟随 Electron。
- CLI Thread storage 默认仅当前用户可访问。
