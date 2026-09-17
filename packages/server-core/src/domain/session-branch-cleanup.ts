export interface BranchRollbackManagedSession {
  agent?: { destroy?: () => void } | null
  poolServer?: { stop?: () => void }
}

interface RollbackParams {
  managed: BranchRollbackManagedSession
  workspaceRootPath: string
  sessionId: string
  deleteFromRuntimeSessions: (sessionId: string) => void
  deleteStoredSession: (workspaceRootPath: string, sessionId: string) => void | boolean | Promise<void | boolean>
}

/**
 * Best-effort rollback when branch creation fails during backend preflight.
 * Ensures no orphan child session remains in memory or persistent storage.
 */
export async function rollbackFailedBranchCreation(params: RollbackParams): Promise<void> {
  const { managed, workspaceRootPath, sessionId, deleteFromRuntimeSessions, deleteStoredSession } = params

  try {
    managed.agent?.destroy?.()
  } catch {
    // Best-effort cleanup
  }
  managed.agent = null

  if (managed.poolServer) {
    try {
      managed.poolServer.stop?.()
    } catch {
      // Best-effort cleanup
    }
    managed.poolServer = undefined
  }

  deleteFromRuntimeSessions(sessionId)

  // The rollback now also covers the Edit Popover orphan cleanup, where a
  // leftover on-disk session is a REAL hazard: an
  // unprivileged leftover is fail-closed, but a partially stamped one must
  // never silently survive. Surface deletion failures instead of swallowing
  // them — the caller has already rejected the creation, this log is the
  // operator's only signal that a manual cleanup may be needed.
  try {
    const deleted = await deleteStoredSession(workspaceRootPath, sessionId)
    if (deleted === false) {
      console.warn(`[session-rollback] failed to delete stored session ${sessionId} from ${workspaceRootPath} — a stale session directory may remain and needs manual cleanup`)
    }
  } catch (deleteError) {
    console.warn(`[session-rollback] error deleting stored session ${sessionId} from ${workspaceRootPath}:`, deleteError)
  }
}
