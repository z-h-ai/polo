# Permissions Configuration Guide

This guide explains how to configure custom permission rules for Explore mode.

> **Editing workflow:** Permissions are plain JSON config files. Edit the file directly, then validate with the assistant's `config_validate` tool:
> - `config_validate({ target: "permissions" })` — validates the workspace permissions file

## Overview

Explore mode is a read-only mode that blocks potentially destructive operations.
Custom permission rules let you allow specific operations that would otherwise be blocked.

**Mode naming:** The three permission modes are shown in the UI as `Explore` (read-only), `Ask to Edit` (badge shows "Ask"), and `Execute`. Both namings are accepted wherever a mode value is needed — the UI names above and their internal keys `safe` (Explore), `ask` (Ask to Edit), and `allow-all` (Execute). "Explore mode" in this guide means the internal `safe` mode.

Permission files are located at:
- App-level defaults: `~/.polo-ai/permissions/default.json` (shipped with the app; see [App-level defaults](#app-level-defaults))
- Workspace: `~/.polo-ai/workspaces/{slug}/permissions.json`
- Source: `~/.polo-ai/workspaces/{slug}/sources/{source}/permissions.json`

## Auto-Scoping for Source Permissions

**Important:** MCP patterns in a source's `permissions.json` are automatically scoped to that source.

When you write:
```json
{ "pattern": "list", "comment": "Allow list operations" }
```

The system converts it to `mcp__<sourceSlug>__.*list` internally. This means:
- Simple patterns like `list` only affect tools from that source
- No risk of accidentally allowing `list` tools from other sources
- Workspace-level patterns still apply globally (for intentional cross-source rules)

## permissions.json Schema

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "Allow list operations" },
    { "pattern": "get", "comment": "Allow get operations" },
    { "pattern": "search", "comment": "Allow search operations" }
  ],
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests" },
    { "method": "POST", "path": "^/search", "comment": "Search POST" }
  ],
  "allowedBashPatterns": [
    { "pattern": "^ls\\s", "comment": "Allow ls commands" }
  ],
  "allowedWritePaths": [
    "/tmp/**",
    "~/.polo-ai/**"
  ],
  "blockedCommandHints": [
    {
      "command": "printf",
      "reason": "printf is not in the default Explore-mode allowlist.",
      "context": "Explore mode keeps a narrow read-only command set.",
      "tryInstead": [
        "Use echo for simple output",
        "Switch to Ask mode for this command"
      ],
      "example": "echo '--- separator ---'"
    },
    {
      "command": "sed",
      "reason": "Only print-only sed is allowed by default.",
      "whenNotMatching": "^sed\\s+-n\\b"
    }
  ]
}
```

## Rule Types

### allowedMcpPatterns

Regex patterns for MCP tool names to allow in Explore mode.

For **source-level** permissions.json, use simple patterns (auto-scoped):
```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "All list operations for this source" },
    { "pattern": "get", "comment": "All get operations for this source" },
    { "pattern": "search", "comment": "All search operations for this source" }
  ]
}
```

For **workspace-level** permissions.json (global rules), use full patterns:
```json
{
  "allowedMcpPatterns": [
    { "pattern": "^mcp__.*__list", "comment": "List operations across all sources" }
  ]
}
```

### allowedApiEndpoints

Fine-grained rules for API source requests.

```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests" },
    { "method": "POST", "path": "^/search", "comment": "Search POST" },
    { "method": "POST", "path": "^/v1/query$", "comment": "Query endpoint" }
  ]
}
```

### allowedBashPatterns

Regex patterns for bash commands to allow.

```json
{
  "allowedBashPatterns": [
    { "pattern": "^ls\\s", "comment": "ls commands" },
    { "pattern": "^git\\s+status", "comment": "git status" },
    { "pattern": "^pwd$", "comment": "pwd command" }
  ]
}
```

### blockedTools (not configurable)

The blocked tool set is **not configurable** and is reserved. Write, Edit, MultiEdit, and NotebookEdit are always blocked in Explore mode by the runtime itself. Although the schema still accepts a `blockedTools` array, it is **ignored** — adding entries to it has no effect. Do not add this field to permissions files.

### allowedWritePaths

Glob patterns for directories where writes are allowed.

```json
{
  "allowedWritePaths": [
    "/tmp/**",
    "~/.polo-ai/**",
    "/path/to/project/output/**"
  ]
}
```

### blockedCommandHints

Command-specific guidance shown when a Bash command is blocked in Explore mode.
This provides deterministic explanations for known commands instead of relying only on closest-pattern heuristics.

```json
{
  "blockedCommandHints": [
    {
      "command": "printf",
      "reason": "printf is not in the default Explore-mode allowlist.",
      "context": "Explore mode keeps a narrow read-only command set.",
      "tryInstead": [
        "Use echo for simple output",
        "Switch to Ask mode for this command"
      ],
      "example": "echo '--- separator ---'"
    },
    {
      "command": "sed",
      "reason": "Only print-only sed is allowed by default.",
      "whenNotMatching": "^sed\\s+-n\\b"
    }
  ]
}
```

Fields:
- `command` (required): Base command name (e.g. `printf`, `sed`)
- `reason` (required): Primary explanation shown to the user
- `context` (optional): Additional policy/risk context
- `tryInstead` (optional): Suggested alternatives
- `example` (optional): Example command
- `whenNotMatching` (optional): Regex condition; hint applies only when command does **not** match this pattern

## Default Behavior in Explore Mode

**Blocked by default:**
- Bash commands (except read-only commands listed below)
- Write, Edit, MultiEdit, NotebookEdit tools (fixed set — see [blockedTools](#blockedtools-not-configurable))
- MCP tools with write semantics (create, update, delete)
- API POST/PUT/DELETE requests

**Allowed by default:**
- Read, Glob, Grep
- Task, TaskOutput
- WebFetch, WebSearch
- TodoWrite, SubmitPlan
- LSP
- The browser tool `browser_tool` (including namespaced forms such as `mcp__session__browser_tool`; legacy split names like `browser_open` or `browser_snapshot` are still accepted as aliases)
- MCP tools with read semantics (list, get, search)
- Session plans folder writes
- Session data folder writes (the output directory for `transform_data` results)

### Read-Only Bash Commands

The table below lists **common examples**. The authoritative allowlist ships with the app in `~/.polo-ai/permissions/default.json` (about 206 bash patterns) — read that file for the complete, current list.

These commands are allowed in Explore mode without custom configuration:

| Category | Commands |
|----------|----------|
| **File exploration** | `ls`, `tree`, `cat`, `head`, `tail`, `nl`, `file`, `stat`, `wc`, `du`, `df` |
| **Search** | `find`, `grep`, `rg`, `ag`, `fd`, `locate`, `which` |
| **Git (read-only)** | `git status`, `git log`, `git diff`, `git show`, `git branch`, `git blame`, `git reflog` |
| **GitHub CLI** | `gh pr view/list`, `gh issue view/list`, `gh repo view`, `gh api` (GET requests) |
| **Package managers** | `npm ls/list/outdated`, `yarn list`, `pip list`, `cargo tree` |
| **Quality checks (read-only)** | `bun run typecheck`, `bun run typecheck:all`, `bunx tsc --noEmit`, `tsc --noEmit`, `npm run typecheck`, `yarn typecheck`, `pnpm typecheck` |
| **Browser helper** | `bun run browser-tool --help`, `bun run browser-tool list`, `bun run browser-tool template ...`, `bun run browser-tool parse-url <url>` |
| **System info** | `pwd`, `whoami`, `env`, `ps`, `uname`, `hostname`, `date`, `echo` |
| **Text processing** | `awk`/`gawk`/`mawk`/`nawk` (safe forms), `sed -n` (print-only), `jq`, `yq`, `sort`, `uniq`, `cut`, `column`, `tr` |
| **Pagers / monitoring** | `man`, `less`, `more`, `htop`, `top` |
| **Containers / clusters (read-only)** | `docker ps|images|logs|inspect|...`, `docker-compose ps|logs|config`, `kubectl get|describe|logs|top|explain|...` |
| **Document tools** | `pdf-tool extract/info`, `xlsx-tool read/info/export`, `img-tool info`, `docx-tool info/extract`, `pptx-tool info/extract`, `ical-tool read/filter` |
| **Network diagnostics** | `ping`, `dig`, `nslookup`, `netstat` |
| **Version checks** | `node --version`, `python --version`, etc. |
| **Assistant read-only actions** | `polo-ai` read-only subcommands (list/get/validate style queries) |

Notes:
- `echo` is allowed for literal output formatting (e.g. `echo ---`), but non-safe redirects and command substitution are still blocked.
- `awk` family commands are allowed for read-only text processing, but dangerous execution primitives (for example `system(...)`, command-pipe `getline`, or `print | "cmd"`) are blocked.

### Compound Commands

Compound commands using `&&`, `||`, and `|` are **allowed** when all parts are safe:

| Construct | Example | Behavior |
|-----------|---------|----------|
| **Logical AND** | `git status && git log` | ✅ Allowed if both commands are safe |
| **Logical OR** | `git status \|\| echo "failed"` | ✅ Allowed if both commands are safe |
| **Pipes** | `git log \| head` | ✅ Allowed if all commands are safe |

Each command is validated independently. If any command is not in the allowlist, the entire compound command is blocked.

### Blocked Shell Constructs

These constructs are always blocked, even if the base command is allowed:

| Construct | Examples | Why Blocked |
|-----------|----------|-------------|
| **Background execution** | `&` | Runs asynchronously, could hide activity |
| **File-writing redirects** | `>`, `>>`, `>|`, here-documents | Could overwrite files |
| **Command substitution** | `$()`, backticks, `<()`, `>()` | Execute embedded commands |
| **Null byte** | `\0` | Can truncate strings at lower levels |

**Allowed redirects:** input redirects (`<`, `<&`), output to `/dev/null` (e.g. `>/dev/null`, `2>/dev/null`), and file-descriptor duplication (`2>&1`) are **allowed** — they do not write to user files.

**Multi-line commands are not blocked as such.** Newlines and carriage returns are parsed as command separators and each command in the sequence is validated individually; only null bytes are rejected outright.

Example: `git status > file.txt` is blocked because `>` could overwrite files, while `git status >/dev/null 2>&1` is allowed.

## App-level defaults

Below every user config sits an app-level defaults file:

```
~/.polo-ai/permissions/default.json
```

- **All default bash/MCP allow patterns come from this file** (about 206 bash patterns, 15 MCP patterns, 7 blocked-command hints) — they are no longer hardcoded in the app.
- It is replaced/merged automatically when the app updates: if the file is missing or corrupt it is reinstalled from the bundled copy; if the bundled version is newer, new patterns are merged in while existing user edits are preserved.
- **Do not rely on editing it** for custom rules — put those in workspace or source permissions.json so app updates cannot conflict with them.

## Cascading Rules

Rules cascade in this order (later layers extend earlier ones):
1. **App defaults** (`~/.polo-ai/permissions/default.json`) apply everywhere
2. **Workspace rules** extend the app defaults globally
3. **Source rules** extend both for that source (MCP patterns auto-scoped)

Rules are additive - they can only allow more operations, not restrict further.

## Explore Mode Diagnostics

When a tool or command is blocked in Explore mode, the rejection message includes diagnostic context to explain why the agent is in that mode:
- `Effective mode: <mode>` — the mode actually in effect
- `Last mode change: <changedBy> at <timestamp> (modeVersion=<n>)` — who/what last switched the mode and which transition it was

On macOS, commands that require administrator privileges are wrapped into an elevated-approval prompt instead of being silently blocked, so the user can approve the privileged execution explicitly.

## Best Practices

1. **Be specific with patterns** - Use anchors (^, $) to avoid over-matching
2. **Add comments** - Explain why each rule exists
3. **Test patterns** - Verify regex matches expected tool names
4. **Minimal permissions** - Only allow what's needed

## Examples

### Read-only Linear access:
```json
{
  "allowedMcpPatterns": [
    { "pattern": "^mcp__linear__(list|get|search)", "comment": "Read operations" }
  ]
}
```

### Search-only API:
```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*" },
    { "method": "POST", "path": "^/search" }
  ]
}
```

### Safe git commands:
```json
{
  "allowedBashPatterns": [
    { "pattern": "^git\\s+(status|log|diff|branch)", "comment": "Read-only git" }
  ]
}
```

## Planning in Explore Mode

In Explore mode, you can create implementation plans that the user can accept to transition to execution.

### When to Create Plans

Create a plan when:
- The task has multiple complex steps
- You want user approval before making changes
- You've gathered enough context and are ready to implement

### Creating a Plan

1. Write your plan to a markdown file in the session's plans folder
2. Call `SubmitPlan` with the file path
3. The user sees a formatted plan with an "Accept Plan" button
4. Clicking "Accept Plan" exits Explore mode and begins implementation

### Plan Format

```markdown
# Plan Title

## Summary
Brief description of what this plan accomplishes.

## Steps
1. **Step description** - Details and approach
2. **Another step** - More details
3. ...
```

### Explore → Implementation Workflow

The recommended workflow:
1. **Explore** - Read files, search code, understand the codebase
2. **Plan** - Write a structured plan to the plans folder
3. **Submit** - Call `SubmitPlan` to present to user
4. **Accept** - User clicks "Accept Plan" to exit Explore mode
5. **Execute** - Implement the plan with full permissions

This provides a smooth transition from exploration to implementation with user oversight.
