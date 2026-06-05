---
id: polo-auth.workspace-ownership
title: "Add workspace ownership validation + auto-create"
module: polo-auth
priority: 6
estimatedMinutes: 25
depends: ["polo-auth.file-isolation"]
status: completed
spec_ref: "spec-polo-ai.md §4.2, §4.3 (Workspace 归属校验+自动创建)"
startedAt: 2026-06-05T18:02:48.467Z
completedAt: 2026-06-05T18:31:51.758Z
---
# Add workspace ownership validation + auto-create


## Objective

Add `ownerUserId` field to workspace configuration. Implement `assertWorkspaceAccess()` ownership guard. Auto-create a workspace when a user first connects without specifying a workspaceId.

## Acceptance Criteria

### AC1: Workspace ownership field
- TEST: WorkspaceConfig gains `ownerUserId: string` field (stored in config.json)
- TEST: Workspace interface gains `ownerUserId: string | null` (derived from config)
- TEST: Existing workspace configs without ownerUserId load without error (treated as null/unowned)

### AC2: Ownership validation — assertWorkspaceAccess
- TEST: ctx.userId matches workspace.ownerUserId → pass (no error)
- TEST: ctx.userId differs from workspace.ownerUserId → throws ForbiddenError
- TEST: ctx.userId is null (server-token) → pass (skip ownership check)
- TEST: workspace.ownerUserId is null (legacy workspace) → pass (no owner assigned)

### AC3: Auto-create workspace
- TEST: User connects with no workspaceId and userId is set → workspace auto-created with name=username
- TEST: Auto-created workspace has ownerUserId = ctx.userId
- TEST: Same user reconnects → finds existing workspace (no duplicate creation)
- TEST: handshake_ack contains the auto-created workspace ID

### AC4: Handler integration — sessions:*
- TEST: sessions:sendMessage calls assertWorkspaceAccess before proceeding
- TEST: sessions:getSession calls assertWorkspaceAccess
- TEST: sessions:listSessions only returns sessions for ctx.userId's workspaces

### AC5: Handler integration — workspace:*
- TEST: workspace:getWorkspace calls assertWorkspaceAccess
- TEST: workspace:updateWorkspace calls assertWorkspaceAccess
- TEST: workspace:listWorkspaces filtered by ownerUserId in platform mode

### AC6: Handler integration — files:*
- TEST: files:read calls assertWorkspaceAccess
- TEST: files:write calls assertWorkspaceAccess

### AC7: Handler integration — other workspace-scoped handlers
- TEST: workspace:import calls assertWorkspaceAccess
- TEST: workspace:export calls assertWorkspaceAccess
- TEST: workspace:settings calls assertWorkspaceAccess
- TEST: workspace:sources calls assertWorkspaceAccess
- TEST: workspace:skills calls assertWorkspaceAccess

## Boundary Matrix

| ctx.userId | ws.ownerUserId | Result |
|-----------|------------------|--------|
| "user-a" | "user-a" | PASS |
| "user-a" | "user-b" | ForbiddenError |
| null | "user-a" | PASS (system) |
| null | null | PASS |
| "user-a" | null | PASS (legacy) |

## Environment Context

- **Runtime**: Bun
- **Files to modify**: Workspace manager (find in `packages/server-core/`), RPC handlers in `packages/server-core/src/handlers/`
- **New utility**: `assertWorkspaceAccess(ctx, workspace)` 
- **Test file**: New tests for ownership + auto-create
- **Test runner**: `bun test`

## Implementation Notes

- `assertWorkspaceAccess()` should be a standalone function importable by all handlers
- Auto-create uses `workspaceManager.findOrCreate({ name: ctx.username, ownerUserId: ctx.userId })`
- For findOrCreate: scan existing workspaces by ownerUserId, return first match or create new
- Store ownerUserId in the workspace config.json file
