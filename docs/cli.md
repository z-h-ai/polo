# Polo CLI

`polo` is the terminal entry point for Polo AI. The package also installs
`polo-ai` as a compatibility alias; both names execute the same CLI.

The Mac App already contains the CLI, headless server, Bun runtime, and Agent
worker. No separate npm package or installation script is needed. You can use
it directly. Owned connections work while the desktop App is closed; Polo
managed compute uses a running, signed-in App as its authorization broker:

```bash
"/Applications/Polo AI.app/Contents/MacOS/Polo AI" --polo-cli --version
"/Applications/Polo AI.app/Contents/MacOS/Polo AI" --polo-cli exec "Explain this directory"
```

Use your actual App path if it is installed elsewhere. The CLI, server and Bun
runtime are bundled with the App. Polo apps call AI through their host SDK, and
internal Agent tools use the bundled runtime and command paths; neither requires
a system-terminal command or a user shell configuration change.

On macOS, a normal App launch never checks or configures the external `polo`
command and shows no terminal setup dialog. To use the optional short command,
open **Help → polo terminal command…** in the packaged App, then choose
**Enable command**. This creates a managed launcher in `~/.local/bin` and adds
a PATH block to the shell profile; it does not download the CLI. Open a new
Terminal window afterward. The same Help dialog offers **Repair** when needed
and **Disable command** for an existing managed launcher. Merely opening or
closing it does not modify shell configuration. Conflicts are shown there and
never overwrite another command or unrelated shell configuration.

Existing command installations are preserved. Disabling the external command
does not disable built-in AI or remove the bundled CLI/runtime. Shell readiness
checks are asynchronous and bounded, and only run when requested. Windows,
Linux and the explicit shell installer retain their existing installation
behavior; the macOS Help flow does not change their contracts.

Linux and Windows installers manage their existing terminal PATH setup. Open a
new terminal after enabling the command, then verify it:

```bash
polo --version
polo --help
```

For source development, use `bun run apps/cli/src/index.ts --help`. Use `polo`
in new scripts and documentation; `polo-ai` is a deprecated compatibility shim
until Polo 1.0.

## One-shot execution

`run` and `exec` always start a dedicated CLI runtime. They do not connect to a
running Electron runtime, acquire its server lock, or put sessions in an
Electron workspace. The configuration workspace supplies sources, skills,
permissions, and model configuration; the execution directory is independent.

Configuration workspace selection:

1. `--workspace <id|name|path>`
2. the active Polo workspace
3. the global configuration scope

Execution directory selection:

1. `-C, --cd <directory>`
2. the caller's current directory

`-C` does not register a workspace and does not create Polo configuration or
session files in the target directory.

### `polo exec`

`exec` is a non-interactive, Codex-style command. It defaults to Polo's `safe`
permission mode and persists its CLI Thread for resume.

```bash
polo exec "Explain this repository"
polo exec --yolo --json "Run the tests"
polo exec -C ./project -m gpt-5 "Fix the failing test"
cat issue.txt | polo exec "Diagnose this issue"
```

`--yolo` and `--dangerously-bypass-approvals-and-sandbox` select Polo's
application-level `allow-all` mode. They do not claim to provide or disable an
operating-system sandbox.

Core options:

| Option | Meaning |
|---|---|
| `[PROMPT]` | One prompt argument; omit it or use `-` to read stdin |
| `--yolo` | Use Polo `allow-all` |
| `--dangerously-bypass-approvals-and-sandbox` | Alias for `--yolo` |
| `--json` | Emit stable, one-event-per-line JSONL |
| `-m, --model <id>` | Invocation-only model |
| `-C, --cd <dir>` | Execution directory |
| `--ephemeral` | Delete the temporary Thread after cleanup |
| `--color always|never|auto` | Color policy for stderr only |
| `-o, --output-last-message <file>` | Atomically write the final answer |
| `--workspace <id|name|path>` | Configuration workspace |
| `--provider <name>` | Invocation-only provider |
| `--api-key <key>` | Invocation-only API key |
| `--base-url <url>` | Invocation-only endpoint |

If both a prompt and piped stdin are present, stdin is appended as a separate
`<stdin>` context block. In normal mode, successful stdout contains only the
final assistant message and one newline; progress and errors use stderr.
`--json` stdout is JSONL only.

Provider, model, endpoint, and API key overrides apply only to that invocation.
They do not create shared connections or change Electron defaults. The selected
configured connection supplies its existing credential. A resumed Thread only
reuses that credential while its provider, endpoint, and authentication type
still match the configured identity; an unmatched endpoint override must supply
its own credential. Secrets are
not stored in Thread metadata, session JSONL, or CLI JSONL.

### Resume and Thread management

```bash
polo exec resume <thread_id> "Continue"
polo exec resume --last "Continue"
polo exec resume --ephemeral <thread_id> "Try another approach"
polo exec sessions
polo exec delete <thread_id>
```

`resume` continues the original Thread in place and takes a fresh configuration
snapshot. Only one executor can own a Thread at a time. `resume --last` is
limited to the same configuration scope and normalized execution directory.
`resume --ephemeral` runs a temporary copy without modifying the original
Thread or its `lastUsedAt`.

`exec sessions` lists only persistent `cli-exec` Threads in the current
configuration scope and normalized execution directory. `exec delete` removes an
entire inactive Thread and refuses active leases.

### `polo run`

`run` keeps streaming Polo output and defaults to an ephemeral CLI Thread:

```bash
polo run "Explain this repository"
polo run --output-format stream-json "Run the tests"
polo run --workspace my-workspace -C ./project --source github "List open PRs"
```

Useful options:

| Option | Default | Meaning |
|---|---|---|
| `--source <slug>` | — | Enable a source; repeatable |
| `--output-format text|stream-json` | `text` | Native Polo stream format |
| `--mode safe|ask|allow-all` | `allow-all` | Permission mode |
| `--no-cleanup` | `false` | Keep a debug Thread in the CLI root |
| `--send-timeout <ms>` | `300000` | Legacy `run` turn timeout |
| `--workspace-dir <path>` | — | Compatibility shorthand for an already registered configuration workspace and execution directory |

`--workspace-dir` no longer registers a workspace. Use `--workspace` and `-C`
for explicit configuration/execution separation. `run --no-cleanup` prints its
`thread_id` and absolute Thread directory to stderr; retained `cli-run` Threads
cannot be resumed and do not appear in `exec sessions`.

## Storage and lifecycle

CLI Threads are stored separately from Electron sessions:

```text
~/.polo-ai/cli-sessions/<configuration-scope-id>/executions/<thread-id>/
  thread.json
  owner.json
  config-snapshot/
  sessions/
```

All Polo-managed session artifacts for a CLI Thread stay below that Thread.
Electron session discovery, unread state, automation, scheduler, messaging, and
desktop notifications do not scan this root. On Unix and macOS, CLI directories
use mode `0700` and files use `0600`.

The CLI runtime watches its owner process. If the CLI is killed, the runtime
cancels work and exits instead of leaving an orphan listener. Ephemeral cleanup
first moves the complete Thread into the CLI root's `trash/` directory, then
deletes it.

## Exit codes

| Result | Code |
|---|---:|
| Success | `0` |
| Startup, execution, or cleanup failure | `1` |
| Usage or unsupported option/subcommand | `2` |
| `SIGINT` | `130` |
| `SIGTERM` | `143` |
| Other signal | `128 + signal number` |

## Connected-server commands

The existing connected-server commands remain available through the same
binary. For local desktop use they discover and verify Electron's private
runtime endpoint. Explicit `--url`/`POLO_AI_SERVER_URL` and
`--token`/`POLO_AI_SERVER_TOKEN` values take precedence.

```bash
polo app
polo ping
polo health
polo versions
polo workspaces
polo sessions
polo connections
polo sources
polo session create
polo session messages <session-id>
polo session delete <session-id>
polo send <session-id> "message"
polo cancel <session-id>
polo invoke <channel> [json-args...]
polo listen <channel>
```

For a TLS server, use a `wss://` URL and optionally `--tls-ca <path>`.

## Standalone execution authority

The bundled one-shot runtime supports user-owned connections. Before listening,
its server verifies the parent process birth identity, exclusive Thread lease,
private snapshot and rooted session storage. It grants only one root session
and one CLI client the execution RPCs; callbacks, model transports, tools and
session events use the same revocable owner generation. Passing `origin=cli`
or selecting a runtime profile grants no authority. Desktop ProductSpace
admission, account permissions and managed billing retain their existing rules.

Local workspace/project Skills and normal file tools remain available under
`safe`, `ask` and `allow-all`. Non-interactive permission prompts are denied;
UI-only plan/auth/question handoffs and cross-session/browser/business actions
are unsupported. `--yolo` explicitly enables the existing `allow-all` mode.

### Polo personal and enterprise compute

```bash
polo exec --provider polo --model <allowed-model> -C ./work "Read input.csv and report the total"
polo exec --provider polo --space <current-space-id> --yolo -C ./work "Write the result to result.json"
polo exec resume <thread-id> --provider polo "Continue"
```

`--provider polo` uses the running desktop App's current, online personal or
enterprise ProductSpace. A default managed connection follows the same route.
`--space` asserts the current desktop space; it never changes it. The model must
be in that space's canonical model allowlist. `--api-key`, `--base-url`,
`LLM_API_KEY` and `LLM_BASE_URL` cannot override managed compute. Selecting a
provider explicitly never launders a managed connection into an owned route.

The desktop verifies its current Admin session and online space access, then
resolves the canonical compute connection. Its loopback credential proxy owns
every actual HTTP attempt's existing `polo_assistant` start/admission, usage
observation, receipt and finish. Payer, price and amounts remain Admin rules.
No real provider key or Admin token enters the CLI; the short-lived proxy
capability reaches the independent runtime over private stdin and is never
saved to a Thread. Pending settlement stays in the desktop's original-account
billing outbox and is not presented as a confirmed charge.

The CLI still owns its Agent, tools and Thread storage. The desktop registers
only an active execution so switch, logout, account replacement and quit can
revoke the lease and wait for the restricted runtime and worker process group to stop.
A failed stop blocks switching or quitting. Desktop/owner death, socket loss,
lease expiry and Ctrl-C cancel execution; there is no automatic model retry or
fallback to a cached managed key or another endpoint. JSONL `thread.started`
includes `compute_source: "desktop-managed"`; stderr names the space/model.

Managed Threads save only non-secret original account, ProductSpace and Admin
origin provenance. Resume requires that same current owner; another account,
space or owned provider cannot receive the history. Listing hides inaccessible
managed history, including old managed Threads whose owner cannot be proven.
An owned Thread (including an ephemeral resume clone) keeps its saved connection
when the current default changes to Polo compute. The Broker refuses upgrading
owned or unknown historical Threads in place; start a new Polo Thread instead.
`--workspace` selects local
configuration and `-C` the file directory; neither grants ProductSpace access.

This version supports the existing OpenAI chat-completions managed transport on
macOS/Linux. Managed execution provides AI plus the native Read, Write, Edit and
Ls tools. Without OS process containment, Bash, grep/find subprocesses, script
agents, web tools and session/MCP/Source/Skill execution are unavailable. The
verified desktop authority fixes this policy in both host and worker; `--yolo`
only changes the original file-write approval rules and cannot add tools. Safe
mode still denies writes. Denied tools produce failed tool results, with the
stable `POLO_MANAGED_TOOL_UNSUPPORTED` limitation shown on stderr.

Managed workers do not evaluate cwd/global Pi extensions, resolve settings
packages or install their hooks, including during resume and utility queries.
This is a restriction on Agent capabilities, not an OS file sandbox: existing
file paths and permissions retain their rules. Owned CLI and ordinary desktop
Agents retain their original tools and Pi resource loading.

Managed sources and Skills are not enabled: no enterprise Skill is
copied into local discovery or made free by CLI ownership. Owned local Skills
retain their existing rules. Windows managed process supervision is unsupported
and fails closed. No browser or full desktop-session RPC is exposed by a CLI
execution runtime.

Stable failures include `POLO_APP_REQUIRED`, `POLO_LOGIN_REQUIRED`,
`POLO_SPACE_REQUIRED`, `POLO_SPACE_MISMATCH`, `POLO_ONLINE_REQUIRED`,
`POLO_SPACE_ACCESS_DENIED`, `POLO_MODEL_NOT_ALLOWED`,
`POLO_INSUFFICIENT_CREDIT`, `POLO_BILLING_UNAVAILABLE`,
`POLO_MANAGED_OVERRIDE_FORBIDDEN`, `POLO_THREAD_OWNER_MISMATCH`,
`POLO_THREAD_OWNER_UNKNOWN` and `POLO_MANAGED_REVOKED`. They fail before new
unauthorized provider work. A protocol completion without final text or a
successful tool outcome fails with `CLI_EMPTY_RESULT`; it is not retried.

### Release resource preparation

The existing `prepare-platform-runtime.ts` release path prepares Mac sharp and
libvips for the requested arm64/x64 target. It derives exact versions from the
installed, lock-matched sharp manifest and verifies downloaded tarballs against
`bun.lock` integrity. The existing final App payload gate remains mandatory.
Host-only optional dependency installation is not evidence for the other CPU's
release. Complete native package, real provider/billing and product Acceptance
results must be reported separately from controlled fixtures.
