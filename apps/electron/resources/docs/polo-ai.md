# Polo CLI Guide

This guide covers `polo`, the terminal client bundled with the Polo AI desktop app. Use it to run one-shot agent tasks from scripts, drive existing sessions, and inspect server state — without opening the app.

`polo-ai` is retained as a **deprecated alias** for `polo`: it still works, but prints a deprecation warning. Use `polo`.

## Overview

- `polo run` / `polo exec` start an **independent CLI runtime**, even while the desktop app is running. They do not attach to an Electron session.
- `exec` keeps its runs in **CLI Threads** — persistent, resumable, and stored outside Electron sessions.
- The remaining commands are a thin **remote RPC client**: with no `--url` they discover and talk to the local desktop app's endpoint; with `--url`/`--token` they talk to any Polo server.

| Command | What it does |
|---------|--------------|
| `run <message...>` | One-shot run with streaming text (or `stream-json`) output |
| `exec [PROMPT]` | One-shot non-interactive run, **safe permissions by default** |
| `exec resume <id>` | Continue a persistent CLI Thread |
| `exec resume --last` | Continue the most recently used matching Thread |
| `exec sessions` | List persistent CLI exec Threads |
| `exec delete <id>` | Delete an inactive CLI Thread |
| `ping` | Verify connectivity (clientId + latency) |
| `health` | Check credential store health |
| `versions` | Show server runtime versions |
| `workspaces` | List configuration workspaces |
| `sessions` | List sessions in the workspace |
| `connections` | List LLM connections |
| `sources` | List configured sources |
| `session create` | Create a session (`--name`, `--mode`) |
| `session messages <id>` | Print a session's message history |
| `session delete <id>` | Delete a session |
| `send <id> <message>` | Send a message and stream the AI response |
| `cancel <id>` | Cancel in-progress processing |
| `invoke <channel> [args]` | Raw RPC call with JSON args |
| `listen <channel>` | Subscribe to push events (Ctrl+C to stop) |
| `--validate-server` | Multi-step test of the app or an explicit `--url` server |

## One-Shot Execution

### `run` vs `exec`

| | `run` | `exec` |
|---|-------|--------|
| Default permissions | **allow-all** | **safe** (read-only) |
| Output | Streaming text; `--output-format stream-json` or `--json` for JSONL | Text, or `--json` for a JSONL event stream |
| Send timeout | 5 minutes per send | — |
| Reads stdin | Yes — pipe a prompt in (`echo "…" \| polo run`) | Use the PROMPT argument |
| `--source` (pre-attach sources) | Yes | **Rejected** |
| `--mode` (permission override) | Yes | **Rejected** |
| `--ephemeral` (delete thread after) | **Rejected** | Yes |

**Rule of thumb:** scripts and CI → `exec` (predictable, safe by default, resumable). Quick questions and piped input → `run`.

### CLI Threads

Every `exec` invocation creates a CLI Thread whose id is printed on completion. Threads survive across invocations until deleted:

```bash
polo exec "Refactor the auth module"
polo exec resume <thread-id> "Now write tests for it"
polo exec resume --last "Also update the README"
polo exec sessions
polo exec delete <thread-id>
```

Add `--ephemeral` to delete the thread automatically after completion.

### Execution Options

| Option | Applies to | Description |
|--------|-----------|-------------|
| `-C, --cd <path>` | both | Agent working directory only — does **not** register a workspace |
| `--workspace <id>` | both | Configuration workspace (sources, skills, permissions) |
| `--space <id>` | both | Target product space. **Requires Polo compute** (a managed Polo connection) — rejected with plain providers |
| `--provider <name>` | both | LLM provider |
| `-m, --model <id>` | both | Model to use |
| `--api-key <key>` | both | Invocation-only API key (not stored) |
| `--base-url <url>` | both | Invocation-only custom API endpoint |
| `--json` | both | JSONL events for `run`/`exec` |
| `--yolo` | both | Use allow-all application permissions |
| `--ephemeral` | exec | Delete the CLI Thread after completion |
| `--source <slug>` | run | Pre-attach a source by slug (repeatable) |
| `--output-format <fmt>` | run | `text` (default) or `stream-json` |

### Examples

```bash
polo exec --yolo --json "hello"
polo exec -C ./my-project "Summarize this repo"
polo exec resume --last "Continue"
polo exec sessions
polo run "What files are in the current directory?"
polo run --source team-wiki "Summarize today's daily note"
polo run --provider openai --model gpt-4o "Summarize this repo"
echo "Analyze this code" | polo run
```

## Output Contract

- **Default**: human-readable text with spinners on a TTY (`--no-spinner` / `--disable-spinner` to suppress; `-v` / `--verbose` shows server stderr).
- **`--json` with `run`/`exec`**: a JSONL event stream — one JSON object per line (`text_delta`, `tool_start`, `tool_result`, `error`, `complete`, `interrupted`). Parse line by line; the final `complete` event carries the outcome.
- **`--json` with RPC commands**: pretty-printed JSON, e.g. `polo --json workspaces | jq '.[].name'`.
- **Exit codes**: `0` success · `1` runtime/connection error · `2` usage error (unknown or conflicting flags) · `130` interrupted (Ctrl+C).

## Remote Commands

Connection options (apply to every command below):

| Option | Description |
|--------|-------------|
| `--url <ws[s]://...>` | Server URL. Default: `$POLO_AI_SERVER_URL`, else the local desktop app endpoint |
| `--token <secret>` | Auth token. Default: `$POLO_AI_SERVER_TOKEN` |
| `--timeout <ms>` | Request timeout (default 10000) |
| `--tls-ca <path>` | Custom CA cert for self-signed TLS |

```bash
polo ping
polo health
polo versions
polo workspaces
polo sessions
polo connections
polo sources
polo session create --name "Release notes" --mode safe
polo session messages <session-id>
polo send <session-id> "What files are in the current directory?"
polo cancel <session-id>
polo invoke system:homeDir
polo listen automations:changed
polo --validate-server
```

`send` streams the AI response into your terminal; pair it with `session create` for a scripted multi-turn conversation, or `listen` to follow push events such as automation activity.

## Configuration Management

`polo` does **not** manage labels, sources, skills, automations, permissions, or themes — there are no `polo label …` / `polo source …` style commands. Manage configuration in one of two ways:

- In the app UI (sidebar → Labels / Sources / Skills / Automations, Settings, Appearance).
- By editing the workspace JSON files directly (`config.json`, `automations.json`, `statuses.json`, `labels.json`, `permissions.json`, `theme.json` under `~/.polo-ai/`, or the workspace equivalents) and asking the assistant to run its `config_validate` tool afterwards. See [labels.md](./labels.md), [sources.md](./sources.md), [automations.md](./automations.md), [permissions.md](./permissions.md), [themes.md](./themes.md), and [statuses.md](./statuses.md) for the exact schemas.

## Troubleshooting

### `'polo-ai' is deprecated; use 'polo' instead.`
Expected — `polo-ai` is a compatibility alias. Update your scripts to call `polo`.

### `--space requires Polo compute`
`--space` selects a product space and only works on a managed Polo connection. Either drop the flag, or use an explicit `--provider`/`--api-key` (plain compute) instead.

### `unsupported option for exec: --source` (or `--mode` / `--stdin`)
Those options are `run`-only. Conversely, `--ephemeral` is `exec`-only and `--no-cleanup` is `run`-only.

### Connection refused / timeout
With no `--url`, the CLI looks for the local desktop app's endpoint — start Polo AI first, or point at a server explicitly: `polo --url wss://… --token … sessions`.

### JSON parse errors in scripts
You probably parsed text output. Add `--json` (`run`/`exec` → JSONL events; RPC commands → a single JSON document) and check the exit code before parsing.
