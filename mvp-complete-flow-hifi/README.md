<div align="center">
  <a href="https://trendshift.io/repositories/20714" target="_blank"><img src="https://trendshift.io/api/badge/repositories/20714" alt="polo-ai%2Fpolo-ai-oss | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</div>

# Polo AI

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

## How it Works (Video)
To understand what Polo AI does and how it works watch this video.

[![Demo Video](https://img.youtube.com/vi/xQouiAIilvU/hqdefault.jpg)](https://www.youtube.com/watch?v=xQouiAIilvU)

[Click Here (or on the image above) to watch the video on YouTube →](https://www.youtube.com/watch?v=xQouiAIilvU)


## Why Polo AI was built
Polo AI is a tool for working effectively with agents. It enables intuitive multitasking, no-fluff connection to any API or service, sharing sessions, and a more document-centric workflow in a fluid UI.

It uses the Claude Agent SDK and the Pi SDK side by side—building on what we found great and improving areas where we've desired improvements.

It's built with Agent Native software principles in mind, and is highly customisable out of the box. One of the first of its kind.

Polo AI is open source under the Apache 2.0 license - so you are free to remix, change anything. And that's actually possible. We ourselves are building Polo AI with Polo AI only - no code editors - so really, any customisation is just a prompt away.

We built Polo AI because we wanted a better, more opinionated (and preferably non-CLI way) of working with the most powerful agents in the world. We'll continue to improve it, based on our experiences and intuition.

<img width="1578" height="894" alt="image" src="https://github.com/user-attachments/assets/3f1f2fe8-7cf6-4487-99ff-76f6c8c0a3fb" />

## Things that are hard to believe "just work"

**How do I connect to Linear, Gmail, Slack...?**
Tell the agent "add Linear as a source." It finds public APIs and MCP servers, reads their docs, sets up credentials, and configures everything. No config files, no setup wizards.

[Check out how I just connected to Slack →](https://app.polo.z-h-ai.com/s/DRNQEiy8w2e1v5LPgKl8b)

**I already have my MCP config JSON.**
Paste it. The agent handles the rest.

**What about local MCPs?**
Fully supported. Stdio-based MCP servers run as local subprocesses on your machine. Point it at an npx command, a Python script, or any local binary. It just works.

**Can it handle custom APIs?**
Yes. Paste an OpenAPI spec, some endpoint URLs, screenshots of docs, whatever you have. It figures it out and guides you through the rest.

**APIs too? Not just MCPs?**
Polo AI connects to anything. We have it hooked up to a direct Postgres DB behind a jumpbox. Skills + Sources = magic.

**How do I import my Claude Code skills and MCPs?**
Tell the agent you want to import your skills from Claude Code. It handles the migration.

[Here I imported all my skills in one go →](https://app.polo.z-h-ai.com/s/gWCFqwhObFWaNJIEJmd6j)

**How do I create a new skill?**
Describe what the skill should do, give it context. The agent takes care of the rest.

**Do I need to restart after changes?**
No. Everything is instant. Mention new skills or sources with `@`, even mid-conversation.

**So I can just ask it anything?**
Yes. That's the core idea behind agent-native software. You describe what you want, and it figures out how. That's a good use of tokens.


## Installation

### One-Line Install (Recommended)

**macOS / Linux:**
```bash
curl -fsSL https://app.polo.z-h-ai.com/install-app.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://app.polo.z-h-ai.com/install-app.ps1 | iex
```

### Build from Source

```bash
git clone https://github.com/polo-ai/polo-ai-oss.git
cd polo-ai-oss
bun install
bun run electron:start
```

## Features

- **Multi-Session Inbox**: Desktop app with session management, status workflow, and flagging
- **Claude Code Experience**: Streaming responses, tool visualization, real-time updates
- **Multiple LLM Connections**: Add multiple AI providers and set per-workspace defaults
- **Multi-Provider Support**: Run sessions with Google AI Studio, ChatGPT Plus, GitHub Copilot, or OpenAI API keys alongside Anthropic
- **MCP Integration**: Connect structured tool servers for documents, collections, search, tasks, and other workflows
- **Sources**: Connect to MCP servers, REST APIs (Google, Slack, Microsoft), and local filesystems
- **Permission Modes**: Three-level system (Explore, Ask to Edit, Auto) with customizable rules
- **Background Tasks**: Run long-running operations with progress tracking
- **Dynamic Status System**: Customizable session workflow states (Todo, In Progress, Done, etc.)
- **Theme System**: Cascading themes at app and workspace levels
- **Multi-File Diff**: VS Code-style window for viewing all file changes in a turn
- **Skills**: Specialized agent instructions stored per-workspace
- **File Attachments**: Drag-drop images, PDFs, Office documents with auto-conversion
- **Automations**: Event-driven automation — create agent sessions on label changes, schedules, tool use, and more

## Quick Start

1. **Launch the app** after installation
2. **Choose API Connection**: Use Anthropic (API key or Claude Max), Google AI Studio, ChatGPT Plus (Codex OAuth), or GitHub Copilot OAuth
3. **Create a workspace**: Set up a workspace to organize your sessions
4. **Connect sources** (optional): Add MCP servers, REST APIs, or local filesystems
5. **Start chatting**: Create sessions and interact with Claude

## Desktop App Features

### Session Management

- **Inbox/Archive**: Sessions organized by workflow status
- **Flagging**: Mark important sessions for quick access
- **Status Workflow**: Todo → In Progress → Needs Review → Done
- **Session Naming**: AI-generated titles or manual naming
- **Session Persistence**: Full conversation history saved to disk

### Sources

Connect external data sources to your workspace:

| Type | Examples |
|------|----------|
| **MCP Servers** | Polo AI, Linear, GitHub, Notion, custom servers |
| **REST APIs** | Google (Gmail, Calendar, Drive, YouTube, Search Console), Slack, Microsoft |
| **Local Files** | Filesystem, Obsidian vaults, Git repos |

### Permission Modes

| Mode | Display | Behavior |
|------|---------|----------|
| `safe` | Explore | Read-only, blocks all write operations |
| `ask` | Ask to Edit | Prompts for approval (default) |
| `allow-all` | Auto | Auto-approves all commands |

Use **SHIFT+TAB** to cycle through modes in the chat interface.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New chat |
| `Cmd+1/2/3` | Focus sidebar/list/chat |
| `Cmd+/` | Keyboard shortcuts dialog |
| `SHIFT+TAB` | Cycle permission modes |
| `Enter` | Send message |
| `Shift+Enter` | New line |

## Remote Server (Headless)

Polo AI can run as a headless server on a remote machine (e.g., a Linux VPS), with the desktop app connecting as a thin client. This lets you keep long-running sessions alive, access them from multiple machines, and run compute-heavy tasks on a powerful server.

### Quick Start

From the monorepo root:

```bash
# Generate a token and start the server
POLO_AI_SERVER_TOKEN=$(openssl rand -hex 32) bun run packages/server/src/index.ts
```

The server prints the connection details on startup:

```
POLO_AI_SERVER_URL=ws://203.0.113.5:9100
POLO_AI_SERVER_TOKEN=<generated-token>
```

Copy these values and use them to connect the desktop app.

### Connecting the Desktop App

Launch the Electron app in thin-client mode by passing the server URL and token:

```bash
POLO_AI_SERVER_URL=wss://203.0.113.5:9100 POLO_AI_SERVER_TOKEN=<token> bun run electron:start
```

In thin-client mode, the desktop app renders the UI but all session logic, tool execution, and LLM calls run on the remote server.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POLO_AI_SERVER_TOKEN` | Yes | — | Bearer token for client authentication |
| `POLO_AI_RPC_HOST` | No | `127.0.0.1` | Bind address (`0.0.0.0` for remote access) |
| `POLO_AI_RPC_PORT` | No | `9100` | Bind port |
| `POLO_AI_RPC_TLS_CERT` | No | — | Path to PEM certificate file (enables `wss://`) |
| `POLO_AI_RPC_TLS_KEY` | No | — | Path to PEM private key file (required with cert) |
| `POLO_AI_RPC_TLS_CA` | No | — | Path to PEM CA chain file (optional, for client cert verification) |
| `POLO_AI_DEBUG` | No | `false` | Enable debug logging |

### TLS (Recommended for Remote Access)

When exposing the server over the network, TLS encrypts the WebSocket connection (`wss://` instead of `ws://`).

**Generate a self-signed certificate (development/testing):**

```bash
./scripts/generate-dev-cert.sh
# Creates certs/cert.pem and certs/key.pem (valid 365 days)
```

**Start the server with TLS:**

```bash
POLO_AI_SERVER_TOKEN=<token> \
POLO_AI_RPC_HOST=0.0.0.0 \
POLO_AI_RPC_TLS_CERT=certs/cert.pem \
POLO_AI_RPC_TLS_KEY=certs/key.pem \
bun run packages/server/src/index.ts
```

The server will print `POLO_AI_SERVER_URL=wss://<your-public-ip>:9100`.

**For production**, use certificates from a trusted CA (e.g., Let's Encrypt) or place the server behind a reverse proxy (nginx, Caddy) that terminates TLS.

### Docker

```bash
docker run -d \
  -p 9100:9100 \
  -e POLO_AI_SERVER_TOKEN=<token> \
  -e POLO_AI_RPC_HOST=0.0.0.0 \
  -v polo-ai-data:/root/.polo-ai \
  polo-ai-server
```

To enable TLS in Docker, mount your certificates and set the env vars:

```bash
docker run -d \
  -p 9100:9100 \
  -e POLO_AI_SERVER_TOKEN=<token> \
  -e POLO_AI_RPC_HOST=0.0.0.0 \
  -e POLO_AI_RPC_TLS_CERT=/certs/cert.pem \
  -e POLO_AI_RPC_TLS_KEY=/certs/key.pem \
  -v ./certs:/certs:ro \
  -v polo-ai-data:/root/.polo-ai \
  polo-ai-server
```

## CLI Client

`polo` is the primary command-line entry point. `polo-ai` remains available as
a compatibility alias and invokes the same implementation.

`polo run` and `polo exec` each start an independent, invocation-scoped runtime.
They do not connect to or reuse the Electron server, even when Electron is
already running. CLI Threads are stored separately from Electron sessions.

### Installation

- macOS: launch Polo once and choose **Complete Now** when asked to complete
  setup. The same actions are available later under **Settings → Polo terminal
  features**.
- Linux and Windows: the app installer creates `polo` and adds its managed
  directory to the user PATH.
- `polo-ai` remains a compatibility shim until Polo 1.0.

For source development:

```bash
bun run apps/cli/src/index.ts --help
```

### One-shot commands

| Command | Description |
|---------|-------------|
| `polo run <prompt...>` | Stream a one-shot response using Polo text or `stream-json` output |
| `polo exec [PROMPT]` | Run non-interactively with safe permissions by default |
| `polo exec resume <thread_id> [PROMPT]` | Continue a persistent CLI Thread in place |
| `polo exec resume --last [PROMPT]` | Resume the last Thread matching the configuration scope and working directory |
| `polo exec sessions` | List persistent `cli-exec` Threads |
| `polo exec delete <thread_id>` | Delete an inactive CLI Thread |

Use `-C/--cd` to select the agent's execution directory. It does not register a
Polo workspace and does not create Polo configuration or Electron sessions in
that directory. Use `--workspace` separately to select the configuration
workspace that supplies sources, skills, permissions, and LLM configuration.

```bash
polo exec --yolo --json "hello"
polo exec -C ./my-project "Summarize this repository"
polo exec sessions
polo exec resume --last "Continue"
polo exec delete 550e8400-e29b-41d4-a716-446655440000

polo run "Summarize the README"
polo run --source github -C ./my-project "List open PRs"
```

Provider, model, base URL, and API-key flags apply only to the current
invocation. `polo exec --help` and `polo run --help` show their complete option
sets.

### Remote server commands

The legacy RPC commands connect to a running Polo AI server over WebSocket. They
are separate from the isolated `run` and `exec` paths. For local desktop use,
they discover and verify the private Electron endpoint automatically. Explicit
`POLO_AI_SERVER_URL`/`POLO_AI_SERVER_TOKEN` or `--url`/`--token` values take
precedence.
For self-signed TLS connections (`wss://`), use `--tls-ca <path>`.

| Command | Description |
|---------|-------------|
| `app` | Start or focus the desktop App |
| `ping` | Verify connectivity (clientId + latency) |
| `health` | Check credential store health |
| `versions` | Show server runtime versions |
| `workspaces` | List workspaces |
| `sessions` | List sessions in workspace |
| `connections` | List LLM connections |
| `sources` | List configured sources |
| `session create` | Create a session (`--name`, `--mode`) |
| `session messages <id>` | Print session message history |
| `session delete <id>` | Delete a session |
| `send <id> <message>` | Send message and stream AI response |
| `cancel <id>` | Cancel in-progress processing |
| `invoke <channel> [args]` | Raw RPC call with JSON args |
| `listen <channel>` | Subscribe to push events (Ctrl+C to stop) |
| `--validate-server` | 21-step integration test (auto-spawns server if no `--url`) |

```bash
# Start or focus the desktop app
polo app

# Quick connectivity check
polo ping

# List sessions (human-readable)
polo sessions

# Send a message and stream the AI response
polo send abc-123 "What files are in the current directory?"

# Validate the server (auto-spawns if no --url)
polo --validate-server
polo --validate-server --url ws://127.0.0.1:9100 --token <token>
```

## Architecture

```
polo-ai/
├── apps/
│   ├── cli/                   # Terminal client (CLI)
│   └── electron/              # Desktop GUI (primary)
│       └── src/
│           ├── main/          # Electron main process
│           ├── preload/       # Context bridge
│           └── renderer/      # React UI (Vite + shadcn)
└── packages/
    ├── core/                  # Shared types
    └── shared/                # Business logic
        └── src/
            ├── agent/         # PoloAi, permissions
            ├── auth/          # OAuth, tokens
            ├── config/        # Storage, preferences, themes
            ├── credentials/   # AES-256-GCM encrypted storage
            ├── sessions/      # Session persistence
            ├── sources/       # MCP, API, local sources
            └── statuses/      # Dynamic status system
```

## Development

```bash
# Hot reload development
bun run electron:dev

# Build and run
bun run electron:start

# Type checking
bun run typecheck:all

# Debug logging (writes to ~/Library/Logs/@polo-ai/electron/)
# Logs are automatically enabled in development
```

### Environment Variables

OAuth integrations (Slack, Microsoft) require credentials baked into the build. Create a `.env` file:

```bash
MICROSOFT_OAUTH_CLIENT_ID=your-client-id
SLACK_OAUTH_CLIENT_ID=your-slack-client-id
SLACK_OAUTH_CLIENT_SECRET=your-slack-client-secret
```

**Note:** Google OAuth credentials are NOT baked into the build. Users provide their own credentials via source configuration. See the [Google OAuth Setup](#google-oauth-setup-gmail-calendar-drive) section below.

### Google OAuth Setup (Gmail, Calendar, Drive, YouTube, Search Console)

Google integrations require you to create your own OAuth credentials. This is a one-time setup.

#### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Note your Project ID

#### 2. Enable Required APIs

Go to **APIs & Services → Library** and enable the APIs you need:
- **Gmail API** - for email integration
- **Google Calendar API** - for calendar integration
- **Google Drive API** - for file storage integration

#### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** user type (unless you have Google Workspace)
3. Fill in required fields:
   - App name: e.g., "My Polo AI"
   - User support email: your email
   - Developer contact: your email
4. Add scopes (optional - can leave default)
5. Add yourself as a test user (required for External apps in testing mode)
6. Complete the wizard

#### 4. Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth Client ID**
3. Application type: **Desktop app**
4. Name: e.g., "Polo AI Desktop"
5. Click **Create**
6. Note the **Client ID** and **Client Secret**

#### 5. Configure in Polo AI

When setting up a Google source (Gmail, Calendar, Drive, YouTube, Search Console, etc.), add these fields to your source's `config.json`:

```json
{
  "api": {
    "googleService": "gmail",
    "googleOAuthClientId": "your-client-id.apps.googleusercontent.com",
    "googleOAuthClientSecret": "your-client-secret"
  }
}
```

Or simply tell the agent you want to connect Gmail/Calendar/Drive - it will guide you through entering your credentials.

#### Security Notes

- Your OAuth credentials are stored encrypted alongside other source credentials
- Never commit credentials to version control
- For production use, consider getting your OAuth consent screen verified by Google

## Supported LLM Providers

Polo AI supports multiple ways to connect to LLM providers:

### Direct Connections

| Provider | Auth | Notes |
|----------|------|-------|
| **Anthropic** | API key or Claude Max/Pro OAuth | Direct Claude connection via the Claude Agent SDK |
| **Google AI Studio** | API key | Gemini models with native Google Search grounding built in |
| **ChatGPT Plus / Pro** | Codex OAuth | Sign in with your ChatGPT subscription — uses OpenAI's Codex models |
| **GitHub Copilot** | OAuth (device code) | One-click authentication with your Copilot subscription |

### Third-Party & Self-Hosted Providers

Additional providers are supported through the **Claude / Anthropic API Key** connection by choosing a custom endpoint:

| Provider | Endpoint | Notes |
|----------|----------|-------|
| **OpenRouter** | `https://openrouter.ai/api` | Access Claude, GPT, Llama, Gemini, and hundreds of other models through a single API key. Use `provider/model-name` format (e.g. `anthropic/claude-opus-4.7`). |
| **Vercel AI Gateway** | `https://ai-gateway.vercel.sh` | Route requests through Vercel's AI Gateway with built-in observability and caching. |
| **Ollama** | `http://localhost:11434` | Run open-source models locally. No API key required. |
| **Custom** | Any URL | Any OpenAI-compatible or Anthropic-compatible endpoint. |

### Architecture

Polo AI uses two agent backends:

- **Claude** — powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which natively supports custom base URLs and provider routing. Anthropic API key, Claude Max/Pro OAuth, and all third-party endpoints use this backend.
- **Pi** — powered by the Pi SDK, which handles Google AI Studio, ChatGPT Plus (Codex OAuth), GitHub Copilot OAuth, and OpenAI API key connections. Pi connections route through their own provider infrastructure.

## Configuration

Configuration is stored at `~/.polo-ai/`:

```
~/.polo-ai/
├── config.json              # Main config (workspaces, LLM connections)
├── credentials.enc          # Encrypted credentials (AES-256-GCM)
├── preferences.json         # User preferences
├── theme.json               # App-level theme
└── workspaces/
    └── {id}/
        ├── config.json      # Workspace settings
        ├── theme.json       # Workspace theme override
        ├── automations.json  # Event-driven automations
        ├── sessions/        # Session data (JSONL)
        ├── sources/         # Connected sources
        ├── skills/          # Custom skills
        └── statuses/        # Status configuration
```

### Automations

Automations let you automate workflows by triggering actions when events happen — labels change, sessions start, tools run, or on a cron schedule.

**Just ask the agent:**
- "Set up a daily standup briefing every weekday at 9am"
- "Notify me when a session is labelled urgent"
- "Track permission mode changes and summarise them"
- "Every Friday at 5pm, summarise this week's completed tasks"

Or configure manually in `~/.polo-ai/workspaces/{id}/automations.json`:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "America/New_York",
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Check @github for new issues assigned to me" }
        ]
      }
    ],
    "LabelAdd": [
      {
        "matcher": "^urgent$",
        "actions": [
          { "type": "prompt", "prompt": "An urgent label was added. Triage the session and summarise what needs attention." }
        ]
      }
    ]
  }
}
```

**Prompt actions** create a new agent session with a prompt. They support `@mentions` for sources and skills, and environment variables like `$POLO_AI_LABEL` and `$POLO_AI_SESSION_ID` are expanded automatically.

**Supported events:** `LabelAdd`, `LabelRemove`, `PermissionModeChange`, `FlagChange`, `SessionStatusChange`, `SchedulerTick`, `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, and more.

See the [Automations documentation](https://app.polo.z-h-ai.com/docs/automations/overview) for the full reference.

## Advanced Features

### Large Response Handling

Tool responses exceeding ~60KB are automatically summarized using Claude Haiku with intent-aware context. The `_intent` field is injected into MCP tool schemas to preserve summarization focus.

### Deep Linking

External apps can navigate using `poloai://` URLs:

```
poloai://allSessions                      # All sessions view
poloai://allSessions/session/session123   # Specific session
poloai://settings                         # Settings
poloai://sources/source/github            # Source info
poloai://action/new-chat                  # Create new session
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Bun](https://bun.sh/) |
| AI | [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| AI (Pi) | Pi SDK agent server |
| Desktop | [Electron](https://www.electronjs.org/) + React |
| UI | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS v4 |
| Build | esbuild (main) + Vite (renderer) |
| Credentials | AES-256-GCM encrypted file storage |

## Troubleshooting

### Debug Mode

To launch the packaged app with verbose logging enabled, use `-- --debug` (note the double dash separator):

**macOS:**
```bash
/Applications/Polo\ AI.app/Contents/MacOS/Polo\ AI -- --debug
```

**Windows (PowerShell):**
```powershell
& "$env:LOCALAPPDATA\Programs\@polo-aielectron\Polo AI.exe" -- --debug
```

**Linux:**
```bash
./polo-ai -- --debug
```

Logs are written to:
- **macOS:** `~/Library/Logs/@polo-ai/electron/main.log`
- **Windows:** `%APPDATA%\@polo-ai\electron\logs\main.log`
- **Linux:** `~/.config/@polo-ai/electron/logs/main.log`

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

### Third-Party Licenses

This project uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which is subject to [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).

### Trademark

"Polo AI" is a trademark of Polo AI. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

### Local MCP Server Isolation

When spawning local MCP servers (stdio transport), sensitive environment variables are filtered out to prevent credential leakage to subprocesses. Blocked variables include:

- `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (app auth)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
- `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `STRIPE_SECRET_KEY`, `NPM_TOKEN`

To explicitly pass an env var to a specific MCP server, use the `env` field in the source config.

To report security vulnerabilities, please see [SECURITY.md](SECURITY.md).
