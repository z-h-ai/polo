# polo — Terminal Reference

`polo` is bundled with every Polo desktop release. It uses the Bun runtime,
CLI bundle, and headless-server bundle inside the installed App, so ordinary
users do not need Node.js, npm, Bun, or a Polo source checkout.

## Install Polo terminal features

- **macOS:** launch Polo once and choose **Complete Now** in the setup prompt.
  You can also use **Settings → Polo terminal features** to install, repair,
  or uninstall it later. Polo installs a managed launcher at `~/.local/bin/polo`
  and configures the default shell's PATH after your confirmation.
- **Linux:** the AppImage installer creates `~/.local/bin/polo` and adds its
  managed directory to the user PATH.
- **Windows:** the installer creates `%LOCALAPPDATA%\Polo AI\bin\polo.cmd`
  and adds that directory to the user PATH.

Open a new terminal after installation, then verify it:

```bash
polo --version
polo --help
```

`polo-ai` is a compatibility shim until Polo 1.0. It prints a migration
warning; use `polo` in documentation, scripts, and new integrations.

### Quick start

```bash
# Start or focus the desktop App
polo app

# Run once from the current directory. If the App is not running, Polo starts
# a temporary packaged headless server and removes it after the task finishes.
ANTHROPIC_API_KEY=sk-... polo run "Hello, world!"
```

### Source development

Development from a checkout still requires Bun:

```bash
bun run apps/cli/src/index.ts --help
```

This path is for contributors only. It is not the desktop-release installation
flow and does not replace the packaged `polo` command.

## Connection options

| Flag | Environment variable | Default | Description |
|------|----------------------|---------|-------------|
| `--url <ws[s]://...>` | `POLO_AI_SERVER_URL` | — | Server WebSocket URL |
| `--token <secret>` | `POLO_AI_SERVER_TOKEN` | — | Authentication token |
| `--workspace <id>` | — | auto-detect | Workspace ID |
| `--timeout <ms>` | — | `10000` | Request timeout |
| `--tls-ca <path>` | `POLO_AI_TLS_CA` | — | Custom CA certificate for a self-signed server |
| `--json` | — | `false` | Raw JSON output for scripting |
| `--send-timeout <ms>` | — | `300000` | Timeout for `send` (five minutes) |

Explicit `--url` / `--token` options take precedence over local App discovery.
Without them, resource commands read Polo's private runtime-discovery file,
validate the local PID, loopback endpoint, file permissions, and major version,
then complete an RPC handshake. No port or token needs to be copied from the
App. If no running App is available, resource commands explain how to start one
with `polo app`; only `polo run` starts a temporary server automatically.

## Commands

| Command | Description |
|---------|-------------|
| `polo app` | Start or focus the desktop App |
| `polo run <prompt>` | Reuse the App or start a temporary server, run once, then exit |
| `polo ping` | Verify connectivity (client ID and latency) |
| `polo health` | Check credential-store health |
| `polo versions` | Show server runtime versions |
| `polo workspaces` | List workspaces |
| `polo sessions` | List sessions in a workspace |
| `polo connections` | List LLM connections |
| `polo sources` | List configured sources |
| `polo session create` | Create a session (`--name`, `--mode`) |
| `polo session messages <id>` | Print a session's message history |
| `polo session delete <id>` | Delete a session |
| `polo send <id> <message>` | Send a message and stream output |
| `polo cancel <id>` | Cancel an in-progress session |
| `polo invoke <channel> [...]` | Invoke a raw RPC channel with JSON arguments |
| `polo listen <channel>` | Subscribe to push events until interrupted |
| `polo --validate-server` | Run the multi-step validation against a running App or explicit server |

### Run

`polo run` registers the current directory as a workspace when necessary,
creates a temporary session, streams the result, and removes that session by
default. When it cannot reuse a verified running App, it uses the packaged
headless server instead. SIGINT and SIGTERM cancel the session and clean up the
temporary server.

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace-dir <path>` | — | Use this directory as the workspace |
| `--source <slug>` | — | Enable a source; repeat for multiple sources |
| `--output-format <format>` | `text` | `text` or `stream-json` |
| `--mode <mode>` | `allow-all` | Permission mode for the session |
| `--no-cleanup` | `false` | Keep the created session after the run |
| `--server-entry <path>` | — | Development-only custom server entry |
| `--provider <name>` | `anthropic` | LLM provider, or `$LLM_PROVIDER` |
| `--model <id>` | provider default | Model ID, or `$LLM_MODEL` |
| `--api-key <key>` | provider environment | API key, or `$LLM_API_KEY` |
| `--base-url <url>` | — | Custom endpoint, or `$LLM_BASE_URL` |

```bash
polo run "Summarize the README"
polo run --workspace-dir ./my-project --source github "List open PRs"
polo run --provider openai --model gpt-4o "Summarize this repo"
OPENAI_API_KEY=... polo run --provider openai "Hello"
echo "Analyze this code" | polo run
```

### Sessions and scripting

```bash
# List sessions from the running desktop App
polo sessions

# Send a message and stream its response
polo send abc-123 "Run the test suite and report results"

# Work with JSON output
WORKSPACES=$(polo --json workspaces | jq -r '.[].id')
SESSION_ID=$(polo --json session create --name "CI Run" | jq -r '.id')
polo session delete "$SESSION_ID"
```

### Validate a running server

```bash
# Discover and validate a running Polo App
polo --validate-server

# Validate an explicitly selected remote server
polo --validate-server --url ws://127.0.0.1:9100 --token <token>
```

`--validate-server` validates a running App when no `--url` is supplied. Run
`polo app` first, or use `polo run` for the self-contained temporary-server
workflow. Validation creates temporary resources and removes them on completion.

## TLS / wss://

```bash
# Trusted certificate
polo --url wss://server.example.com:9100 ping

# Self-signed certificate
polo --url wss://server.example.com:9100 --tls-ca /path/to/ca.pem ping
```

`--tls-ca` sets `NODE_EXTRA_CA_CERTS` before the client connects. You can also
set `POLO_AI_TLS_CA` in the environment.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Polo App is not running` | A resource command could not discover the App | Run `polo app`, then retry; or pass `--url` and `--token` for a remote server |
| Runtime is stale or unreachable | The App exited or its RPC endpoint is unavailable | Restart with `polo app` and retry |
| `AUTH_FAILED` | Wrong remote token | Check `POLO_AI_SERVER_TOKEN` or the `--token` value |
| Version incompatibility | App and CLI major versions differ | Update Polo so the installed App and terminal launcher match |
| `No workspace available` | No workspace exists in the running App | Create one in Polo, or use `polo run --workspace-dir <path>` |
| `WebSocket connection error` | Network issue or TLS problem | Verify the server URL; for self-signed TLS use `--tls-ca` |
