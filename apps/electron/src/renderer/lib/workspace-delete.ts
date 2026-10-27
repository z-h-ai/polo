/**
 * U1 (product-closure 2026-10-27) — presentation decision for a workspace
 * removal attempt, kept pure so the two switcher variants (sidebar dropdown
 * + compact drawer) render the SAME honest outcome for the SAME result.
 *
 * The confirm dialog itself is the shared confirm-dialog contract (opens
 * focused on cancel, busy-guarded, cancel/Esc/outside never write). What
 * this module owns is the AFTER: success, already-gone (another window),
 * and the partial failure where the config entry is gone but the on-disk
 * session data survived — which must NEVER read as a full success.
 */
import type { RemoveWorkspaceOutcome } from '@polo-ai/shared/config'

export interface WorkspaceRemovalPresentation {
  toast: 'success' | 'error'
  /** i18n key for the toast text. */
  messageKey: string
  /** i18n params (workspace name, failed path). */
  params: Record<string, string>
  /** The config entry is gone — the parent must refresh its list either way. */
  refreshList: boolean
}

export function presentWorkspaceRemoval(
  workspaceName: string,
  outcome: RemoveWorkspaceOutcome,
): WorkspaceRemovalPresentation {
  if (!outcome.removed) {
    // Another window already removed it: the dead end must say so (and the
    // list must refresh so the stale row disappears).
    return {
      toast: 'error',
      messageKey: 'workspaceDelete.alreadyGone',
      params: { name: workspaceName },
      refreshList: true,
    }
  }
  if (outcome.dataCleanupFailure) {
    // Partial failure: the config entry is gone, but sessions/plans/data on
    // disk survived. Never report this as a clean success.
    return {
      toast: 'error',
      messageKey: 'workspaceDelete.dataCleanupFailed',
      params: { path: outcome.dataCleanupFailure.path },
      refreshList: true,
    }
  }
  return {
    toast: 'success',
    messageKey: 'toast.removedWorkspace',
    params: { name: workspaceName },
    refreshList: true,
  }
}
