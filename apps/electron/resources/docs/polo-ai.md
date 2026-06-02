# Polo AI CLI Guide

`polo-ai` is the preferred interface for managing workspace config domains such as labels, sources, skills, and automations.

## Usage

```bash
polo-ai <entity> <action> [args] [--flags] [--json '<json>'] [--stdin]
```

### Global flags
- `polo-ai --help`
- `polo-ai --version`
- `polo-ai --discover`

### Input modes
- Flat flags for simple values
- `--json` for structured inputs
- `--stdin` for piped JSON object input

---

<!-- cli:label:start -->
## Label

Manage workspace labels stored under `labels/`.

### Commands
- `polo-ai label list`
- `polo-ai label get <id>`
- `polo-ai label create --name "<name>" [--color "<color>"] [--parent-id <id|root>] [--value-type string|number|date]`
- `polo-ai label update <id> [--name "<name>"] [--color "<color>"] [--value-type string|number|date|none] [--clear-value-type]`
- `polo-ai label delete <id>`
- `polo-ai label move <id> --parent <id|root>`
- `polo-ai label reorder [--parent <id|root>] <ordered-id-1> <ordered-id-2> ...`
- `polo-ai label auto-rule-list <id>`
- `polo-ai label auto-rule-add <id> --pattern "<regex>" [--flags "gi"] [--value-template "$1"] [--description "..."]`
- `polo-ai label auto-rule-remove <id> --index <n>`
- `polo-ai label auto-rule-clear <id>`
- `polo-ai label auto-rule-validate <id>`

### Examples

```bash
polo-ai label list
polo-ai label get bug
polo-ai label create --name "Bug" --color "accent"
polo-ai label create --name "Priority" --value-type number
polo-ai label update bug --json '{"name":"Bug Report","color":"destructive"}'
polo-ai label update priority --value-type none
polo-ai label move bug --parent root
polo-ai label reorder --parent root development content bug
polo-ai label auto-rule-add linear-issue --pattern "\\b([A-Z]{2,5}-\\d+)\\b" --value-template "$1"
polo-ai label auto-rule-list linear-issue
polo-ai label auto-rule-validate linear-issue
```

### Notes
- Use `--json` / `--stdin` for nested or bulk updates.
- IDs are stable slugs generated from name on create.
- Use `--value-type none` or `--clear-value-type` to remove a label value type.
<!-- cli:label:end -->

---

<!-- cli:source:start -->
## Source

Manage workspace sources stored under `sources/{slug}/`.

### Commands
- `polo-ai source list [--include-builtins true|false]`
- `polo-ai source get <slug>`
- `polo-ai source create` (see flags below)
- `polo-ai source update <slug> --json '{...}'`
- `polo-ai source delete <slug>`
- `polo-ai source validate <slug>`
- `polo-ai source test <slug>`
- `polo-ai source init-guide <slug> [--template generic|mcp|api|local]`
- `polo-ai source init-permissions <slug> [--mode read-only]`
- `polo-ai source auth-help <slug>`

### Flags for `source create`

| Flag | Description |
|------|-------------|
| `--name "<name>"` | **(required)** Source display name |
| `--provider "<provider>"` | **(required)** Provider identifier (e.g., `linear`, `github`) |
| `--type mcp\|api\|local` | **(required)** Source type |
| `--enabled true\|false` | Enable/disable source (default: `true`) |
| `--icon "<url-or-emoji>"` | Icon URL (auto-downloaded) or emoji |
| **MCP-specific** | |
| `--url "<url>"` | MCP server URL |
| `--transport http\|stdio` | MCP transport type |
| `--auth-type oauth\|bearer\|none` | MCP authentication type |
| **API-specific** | |
| `--base-url "<url>"` | **(required for api)** API base URL (must have trailing slash) |
| `--auth-type bearer\|header\|query\|basic\|none` | **(required for api)** API auth type |
| **Local-specific** | |
| `--path "<path>"` | **(required for local)** Filesystem path |

### Examples

```bash
polo-ai source list
polo-ai source get linear
# MCP source with flat flags
polo-ai source create --name "Linear" --provider "linear" --type mcp --url "https://mcp.linear.app/sse" --auth-type oauth
# MCP source with --json for nested config
polo-ai source create --name "Linear" --provider "linear" --type mcp --json '{"mcp":{"transport":"http","url":"https://mcp.linear.app/sse","authType":"oauth"}}'
# API source
polo-ai source create --name "Exa" --provider "exa" --type api --base-url "https://api.exa.ai/" --auth-type header
# Local source
polo-ai source create --name "Docs Folder" --provider "filesystem" --type local --path "~/Documents"
polo-ai source update linear --json '{"enabled":false}'
polo-ai source validate linear
polo-ai source test linear
polo-ai source init-guide linear --template mcp
polo-ai source init-permissions linear --mode read-only
polo-ai source auth-help linear
```

### Notes
- Use flat flags for simple values or `--json` for type-specific nested config fields (`mcp`, `api`, `local`).
- `init-guide` scaffolds a practical `guide.md` based on source type.
- `init-permissions` scaffolds read-only `permissions.json` patterns for Explore mode.
- `auth-help` returns the recommended in-session auth tool and mode.
- `test` is lightweight CLI validation; for full in-session auth/connection probing use `source_test` MCP tool.
<!-- cli:source:end -->

---

<!-- cli:skill:start -->
## Skill

Manage workspace skills stored under `skills/{slug}/SKILL.md`.

### Commands
- `polo-ai skill list [--workspace-only] [--project-root <path>]`
- `polo-ai skill get <slug> [--project-root <path>]`
- `polo-ai skill where <slug> [--project-root <path>]`
- `polo-ai skill create` (see flags below)
- `polo-ai skill update <slug> --json '{...}' [--project-root <path>]`
- `polo-ai skill delete <slug>`
- `polo-ai skill validate <slug> [--source workspace|project|global] [--project-root <path>]`

### Flags for `skill create`

| Flag | Description |
|------|-------------|
| `--name "<name>"` | **(required)** Skill display name |
| `--description "<desc>"` | **(required)** Brief description (1-2 sentences) |
| `--slug "<slug>"` | Custom slug (auto-generated from name if omitted) |
| `--body "..."` | Skill content/instructions (markdown body) |
| `--icon "<url>"` | Icon URL (auto-downloaded to `icon.*`) |
| `--globs "*.ts,*.tsx"` | Comma-separated glob patterns for auto-suggestion |
| `--always-allow "Bash,Write"` | Comma-separated tool names to always allow |
| `--required-sources "linear,github"` | Comma-separated source slugs to auto-enable |

### Examples

```bash
polo-ai skill list
polo-ai skill list --workspace-only
polo-ai skill where commit-helper
polo-ai skill create --name "Commit Helper" --description "Generate conventional commits" --slug commit-helper
polo-ai skill create --name "Code Review" --description "Review PRs" --globs "*.ts,*.tsx" --always-allow "Bash" --required-sources "github"
polo-ai skill update commit-helper --json '{"requiredSources":["github"],"body":"Use concise, imperative commit messages."}'
polo-ai skill validate commit-helper
polo-ai skill validate commit-helper --source global
polo-ai skill delete commit-helper
```

### Notes
- `create` / `update` write `SKILL.md` frontmatter and content body.
- Use `where` to inspect project/workspace/global resolution precedence.
- `--project-root` scopes resolution to a project directory (defaults to cwd).
<!-- cli:skill:end -->

---

<!-- cli:automation:start -->
## Automation

Manage workspace automations stored in `automations.json`.

### Commands
- `polo-ai automation list`
- `polo-ai automation get <id>`
- `polo-ai automation create` (see flags below)
- `polo-ai automation update <id>` (same flags as create, all optional)
- `polo-ai automation delete <id>`
- `polo-ai automation enable <id>`
- `polo-ai automation disable <id>`
- `polo-ai automation duplicate <id>`
- `polo-ai automation history [<id>] [--limit <n>]`
- `polo-ai automation last-executed <id>`
- `polo-ai automation test <id> [--match "..."]`
- `polo-ai automation lint`
- `polo-ai automation validate`

### Flags for `automation create` / `update`

| Flag | Description |
|------|-------------|
| `--event <EventName>` | **(required for create)** Event trigger (e.g., `UserPromptSubmit`, `SchedulerTick`, `LabelAdd`) |
| `--name "<name>"` | Display name for the automation |
| `--matcher "<regex>"` | Regex pattern for event matching |
| `--cron "<expression>"` | Cron expression (for `SchedulerTick` events) |
| `--timezone "<tz>"` | IANA timezone (e.g., `Europe/Budapest`) |
| `--permission-mode safe\|ask\|allow-all` | Permission level for created sessions |
| `--enabled true\|false` | Enable/disable the automation |
| `--labels "label1,label2"` | Comma-separated labels for created sessions |
| `--prompt "..."` | Prompt text (creates a prompt action automatically) |
| `--llm-connection "<slug>"` | LLM connection slug for the created session |
| `--model "<model-id>"` | Model ID for the created session |

### Examples

```bash
polo-ai automation list
polo-ai automation validate
# Simple prompt automation with flat flags
polo-ai automation create --event UserPromptSubmit --prompt "Summarize this prompt"
# Scheduled automation with flat flags
polo-ai automation create --event SchedulerTick --cron "0 9 * * 1-5" --timezone "Europe/Budapest" --prompt "Give me a morning briefing" --labels "Scheduled" --permission-mode safe
# Complex automation with --json
polo-ai automation create --event SchedulerTick --json '{"cron":"0 9 * * 1-5","actions":[{"type":"prompt","prompt":"Daily summary"}]}'
polo-ai automation update abc123 --name "Morning Report" --prompt "Updated prompt"
polo-ai automation update abc123 --enabled false
polo-ai automation enable abc123
polo-ai automation duplicate abc123
polo-ai automation history abc123 --limit 10
polo-ai automation last-executed abc123
polo-ai automation test abc123 --match "UserPromptSubmit"
polo-ai automation lint
polo-ai automation delete abc123
```

### Notes
- Use flat flags for simple automations or `--json` for complex matchers with multiple `actions`.
- `--prompt` is a shortcut that auto-wraps the text as a prompt action. Use `--json` with `actions` for multi-action automations.
- `lint` provides quick matcher/action hygiene checks (regex validity, missing actions, oversized prompt mention sets).
- `history` and `last-executed` read from `automations-history.jsonl` when present.
- `validate` runs full schema and semantic checks.
<!-- cli:automation:end -->

---

<!-- cli:permission:start -->
## Permission

Manage Explore mode permissions stored in `permissions.json` (workspace-level and per-source).

### Commands
- `polo-ai permission list`
- `polo-ai permission get [--source <slug>]`
- `polo-ai permission set [--source <slug>] --json '{...}'`
- `polo-ai permission add-mcp-pattern "<pattern>" [--comment "..."] [--source <slug>]`
- `polo-ai permission add-api-endpoint --method GET|POST|... --path "<regex>" [--comment "..."] [--source <slug>]`
- `polo-ai permission add-bash-pattern "<pattern>" [--comment "..."] [--source <slug>]`
- `polo-ai permission add-write-path "<glob>" [--source <slug>]`
- `polo-ai permission remove <index> --type mcp|api|bash|write-path|blocked [--source <slug>]`
- `polo-ai permission validate [--source <slug>]`
- `polo-ai permission reset [--source <slug>]`

### Scope

Without `--source`: operates on workspace-level `permissions.json` (global rules).
With `--source <slug>`: operates on that source's `permissions.json` (auto-scoped).

### Examples

```bash
# List all permissions files (workspace + sources)
polo-ai permission list
# Get workspace permissions
polo-ai permission get
# Get source-specific permissions
polo-ai permission get --source linear
# Add read-only MCP patterns for a source
polo-ai permission add-mcp-pattern "list" --comment "List operations" --source linear
polo-ai permission add-mcp-pattern "get" --comment "Get operations" --source linear
polo-ai permission add-mcp-pattern "search" --comment "Search operations" --source linear
# Add API endpoint rules
polo-ai permission add-api-endpoint --method GET --path ".*" --comment "All GET requests" --source stripe
# Add bash patterns
polo-ai permission add-bash-pattern "^ls\\s" --comment "Allow ls"
# Add write path globs
polo-ai permission add-write-path "/tmp/**"
# Remove a rule by index and type
polo-ai permission remove 1 --type mcp --source linear
# Replace entire config
polo-ai permission set --source github --json '{"allowedMcpPatterns":[{"pattern":"list","comment":"List ops"}]}'
# Validate all permissions
polo-ai permission validate
# Validate source-specific
polo-ai permission validate --source linear
# Delete permissions file (revert to defaults)
polo-ai permission reset --source linear
```

### Notes
- Source-level MCP patterns are auto-scoped at runtime (e.g., `list` becomes `mcp__<slug>__.*list`).
- `remove` uses 0-based index within the specified rule type array. Use `get` to see indices.
- `validate` runs schema + regex validation. Without `--source`, validates workspace + all sources.
- `reset` deletes the permissions file, reverting to defaults.
<!-- cli:permission:end -->

---

<!-- cli:theme:start -->
## Theme

Manage app-level and workspace-level theme settings.

### Commands
- `polo-ai theme get`
- `polo-ai theme validate [--preset <id>]`
- `polo-ai theme list-presets`
- `polo-ai theme get-preset <id>`
- `polo-ai theme set-color-theme <id>`
- `polo-ai theme set-workspace-color-theme <id|default>`
- `polo-ai theme set-override --json '{...}'`
- `polo-ai theme reset-override`

### Examples

```bash
# Inspect current theme state
polo-ai theme get

# Validate app override file
polo-ai theme validate

# Validate one preset file
polo-ai theme validate --preset nord

# List available presets
polo-ai theme list-presets

# Inspect a specific preset
polo-ai theme get-preset dracula

# Set app default preset
polo-ai theme set-color-theme nord

# Set workspace override
polo-ai theme set-workspace-color-theme dracula

# Clear workspace override (inherit app default)
polo-ai theme set-workspace-color-theme default

# Replace app-level theme.json override
polo-ai theme set-override --json '{"accent":"oklch(0.62 0.21 293)","dark":{"accent":"oklch(0.68 0.21 293)"}}'

# Remove app-level override file
polo-ai theme reset-override
```

### Notes
- `set-color-theme` and `set-workspace-color-theme` require an existing preset ID (`default` is always valid).
- `set-override` validates `theme.json` shape before writing.
- Workspace override is stored in `workspace/config.json` under `defaults.colorTheme`.
- App override is stored in `~/.polo-ai/theme.json`.
<!-- cli:theme:end -->

---

## Output contract

All commands return a single JSON envelope on stdout.

### Success
```json
{ "ok": true, "data": {}, "warnings": [] }
```

### Error
```json
{
  "ok": false,
  "error": {
    "code": "USAGE_ERROR",
    "message": "...",
    "suggestion": "..."
  },
  "warnings": []
}
```

Exit codes:
- `0` success
- `1` execution/internal failure
- `2` usage/validation/input failure
