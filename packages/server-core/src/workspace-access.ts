/**
 * workspace-access.ts
 *
 * Utilities for workspace ownership validation and auto-create.
 *
 *   assertWorkspaceAccess(ctx, workspace)
 *     Guards workspace-scoped handlers. Throws ForbiddenError when the
 *     authenticated user does not own the workspace.
 *
 *   findOrCreateUserWorkspace({ userId, username })
 *     Scans the default workspaces directory for the first workspace whose
 *     ownerUserId matches userId. If none is found, creates a new workspace
 *     named after the username and assigns the user as owner.
 */

import type { RequestContext } from './transport/types.js'
import type { LoadedWorkspace, WorkspaceConfig } from '@polo-ai/shared/workspaces'
import {
  getDefaultWorkspacesDir,
  ensureDefaultWorkspacesDir,
  generateUniqueWorkspacePath,
  createWorkspaceAtPath,
  loadWorkspace,
  loadWorkspaceConfig,
} from '@polo-ai/shared/workspaces/storage'
import { getWorkspaceByNameOrId } from '@polo-ai/shared/config'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// ForbiddenError
// ---------------------------------------------------------------------------

/**
 * Thrown when a user tries to access a workspace they do not own.
 * The transport layer reads `err.code` and maps it to the wire error code.
 */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const

  constructor(message = 'Access denied') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

// ---------------------------------------------------------------------------
// assertWorkspaceAccess
// ---------------------------------------------------------------------------

/**
 * Boundary matrix:
 *
 * | ctx.userId  | ws.ownerUserId | Result              |
 * |-------------|----------------|---------------------|
 * | "user-a"    | "user-a"       | PASS                |
 * | "user-a"    | "user-b"       | ForbiddenError      |
 * | null        | "user-a"       | PASS  (system)      |
 * | null        | null           | PASS                |
 * | "user-a"    | null           | PASS  (legacy ws)   |
 */
export function assertWorkspaceAccess(
  ctx: Pick<RequestContext, 'userId'>,
  workspace: Pick<WorkspaceConfig, 'ownerUserId'>,
): void {
  // Server-token requests (userId = null) bypass ownership check
  if (ctx.userId == null) return

  // Legacy workspaces with no owner are accessible to everyone
  const ownerUserId = (workspace as any).ownerUserId
  if (ownerUserId == null) return

  // Ownership check
  if (ctx.userId !== ownerUserId) {
    throw new ForbiddenError(
      `User ${ctx.userId} does not own this workspace (owner: ${ownerUserId})`
    )
  }
}

// ---------------------------------------------------------------------------
// assertWorkspaceAccessById
// ---------------------------------------------------------------------------

/**
 * Load a workspace config by ID and assert ownership.
 *
 * Handlers that receive a `workspaceId` argument and already have access
 * to the workspace's `rootPath` via the global config registry can use this
 * helper to check ownership in one call.
 *
 * @param ctx     - Request context (userId from the authenticated connection)
 * @param rootPath - Absolute path to the workspace folder
 */
export function assertWorkspaceAccessByPath(
  ctx: Pick<RequestContext, 'userId'>,
  rootPath: string,
): void {
  // Fast-path: server-token (userId = null) bypasses ownership check
  if (ctx.userId == null) return

  const config = loadWorkspaceConfig(rootPath)
  if (!config) return // Unknown workspace — allow and let handler throw its own error

  assertWorkspaceAccess(ctx, config as WorkspaceConfig)
}

// ---------------------------------------------------------------------------
// assertCtxWorkspaceAccess
// ---------------------------------------------------------------------------

/**
 * Convenience guard for handlers where the workspace comes from `ctx.workspaceId`.
 *
 * Looks up the workspace by ctx.workspaceId in the global config registry,
 * then asserts ownership using assertWorkspaceAccessByPath.
 *
 * No-op when ctx.workspaceId is null (no workspace context).
 */
export function assertCtxWorkspaceAccess(
  ctx: Pick<RequestContext, 'userId' | 'workspaceId'>,
): void {
  if (ctx.userId == null) return // Server-token bypass
  if (ctx.workspaceId == null) return // No workspace context

  const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
  if (!workspace) return // Unknown workspace — handler will throw its own error

  assertWorkspaceAccessByPath(ctx, workspace.rootPath)
}

// ---------------------------------------------------------------------------
// findOrCreateUserWorkspace
// ---------------------------------------------------------------------------

export interface FindOrCreateOptions {
  userId: string
  username: string
}

/**
 * Find the user's workspace (first owned workspace) or create one.
 *
 * Non-platform mode: scans ~/.polo-ai/workspaces/ for a config whose
 * ownerUserId matches userId. If not found, creates a new workspace
 * named after username with ownerUserId = userId.
 *
 * @returns LoadedWorkspace — the found or newly created workspace.
 */
export async function findOrCreateUserWorkspace(
  options: FindOrCreateOptions,
): Promise<LoadedWorkspace> {
  const { userId, username } = options

  ensureDefaultWorkspacesDir(null)
  const workspacesDir = getDefaultWorkspacesDir(null)

  // Scan for an existing workspace owned by this user
  if (existsSync(workspacesDir)) {
    try {
      const entries = readdirSync(workspacesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const rootPath = join(workspacesDir, entry.name)
        const loaded = loadWorkspace(rootPath)
        if (loaded && (loaded.config as any).ownerUserId === userId) {
          return loaded
        }
      }
    } catch {
      // Ignore scanning errors, fall through to create
    }
  }

  // Not found — create a new workspace for this user
  const rootPath = generateUniqueWorkspacePath(username, workspacesDir)
  const config = createWorkspaceAtPath(rootPath, username, undefined, userId)

  // Load the workspace to return a fully populated LoadedWorkspace
  const loaded = loadWorkspace(rootPath)
  if (!loaded) {
    throw new Error(`Failed to load auto-created workspace at ${rootPath}`)
  }

  return loaded
}
