# Polo CLI

`polo` is the terminal entry point for Polo AI. The package also installs
`polo-ai` as a compatibility alias; both names execute the same CLI.

The Mac App already contains the CLI, headless server, Bun runtime, and Agent
worker. No separate npm package or installation script is needed. You can use
it directly, including while the desktop App is closed:

```bash
"/Applications/Polo AI.app/Contents/MacOS/Polo AI" --polo-cli --version
"/Applications/Polo AI.app/Contents/MacOS/Polo AI" --polo-cli exec "Explain this directory"
```

Use your actual App path if it is installed elsewhere. To enable the shorter
`polo` command on macOS, accept the first-launch terminal prompt or open
**Settings → Polo terminal features → Enable command**. This optional step adds
a managed launcher in `~/.local/bin` and a PATH block in your shell profile;
it does not download the CLI. Repair/remove actions preserve unrelated shell
configuration and refuse to overwrite another command named `polo`.
Readiness checks run asynchronously with a bounded timeout. A timeout keeps
terminal readiness unconfirmed; other settings remain usable.

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

Admin-managed connections, `polo-space-*` routes and managed historical Thread
provenance fail with `CLI_MANAGED_CONTEXT_REQUIRED`, before stored credentials
are borrowed. Synthetic/resumed connections cannot remove that provenance.
Polo platform/enterprise compute requires a future trusted ProductSpace broker
with admission, metering and revocation; this standalone path does not establish
support for that compute. Provider authentication failures exit nonzero.
