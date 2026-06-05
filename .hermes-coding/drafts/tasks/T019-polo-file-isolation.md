---
id: polo-auth.file-isolation
title: "Isolate file storage paths per userId in platform mode"
module: polo-auth
priority: 5
estimatedMinutes: 20
depends: ["polo-auth.request-context"]
status: pending
spec_ref: "spec-polo-ai.md §4.1 (文件存储路径)"
---
# Isolate file storage paths per userId in platform mode


## Objective

In platform mode, isolate workspace storage per userId. Currently workspaces live at `~/.polo-ai/workspaces/{slug}/`. In platform mode, new workspaces should be created under `~/.polo-ai/users/{userId}/workspaces/{slug}/`, with `rootPath` pointing to this location. The global workspace registry (if any) must filter by userId. Non-platform mode remains unchanged.

## Acceptance Criteria

### AC1: Platform mode workspace path
- TEST: In platform mode, new workspace rootPath is `~/.polo-ai/users/{userId}/workspaces/{slug}/`
- TEST: WorkspaceConfig stored at `{rootPath}/config.json` as usual
- TEST: In non-platform mode, workspace path remains `~/.polo-ai/workspaces/{slug}/` (unchanged)

### AC2: Workspace creation respects mode
- TEST: createWorkspace() in platform mode uses userId-scoped base directory
- TEST: listWorkspaces() in platform mode only returns workspaces under the userId directory
- TEST: loadWorkspaceConfig(rootPath) works regardless of path location (no path assumptions)

### AC3: User isolation
- TEST: userId="abc", slug="ws1" path does NOT overlap with userId="def", slug="ws1"
- TEST: userId="abc", slug="ws1" → `users/abc/workspaces/ws1/`; userId="def", slug="ws1" → `users/def/workspaces/ws1/`

### AC4: Edge cases
- TEST: userId=null (server-token connection) falls back to original path `~/.polo-ai/workspaces/{slug}/`
- TEST: userId containing `../` or other traversal sequences is rejected (sanitization)
- TEST: slug containing `../` is also rejected
- TEST: Directory is auto-created if it does not exist

## Boundary Matrix

| PLATFORM_KEY set | userId | slug | Resolved path |
|-----------------|--------|------|---------------|
| yes | "abc" | "ws1" | `~/.polo-ai/users/abc/workspaces/ws1/` |
| yes | null | "ws1" | `~/.polo-ai/workspaces/ws1/` |
| no | any | "ws1" | `~/.polo-ai/workspaces/ws1/` |
| yes | "../etc" | "ws1" | ERROR: invalid userId |

## Environment Context

- **Runtime**: Bun
- **Files to modify**: Find the path resolution utility in `packages/server-core/` that constructs workspace paths
- **Workspace types**: `Workspace` has `rootPath: string`, `WorkspaceConfig` has `{ id, name, slug, defaults, localMcpServers, createdAt, updatedAt }`. Path: `~/.polo-ai/workspaces/{slug}/config.json`
- **Env vars**: `PLATFORM_ANTHROPIC_API_KEY` (presence check only)
- **Test file**: New test alongside the modified utility
- **Test runner**: `bun test`

## Implementation Notes

- Create or modify a helper: `getWorkspacePath(userId: string | null, slug: string): string`
- Platform mode detection: `!!process.env.PLATFORM_ANTHROPIC_API_KEY`
- Sanitize path components: reject if they contain `..`, `/`, or null bytes
- UUID-format userIds are inherently safe but validate anyway
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
