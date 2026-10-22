/**
 * Friendly copy for managed-skill enablement failures (POO-106 S1, M3).
 *
 * The RPC error code stays in the console for diagnostics; the toast surfaces
 * a mapped, localized message with a generic fallback for unknown codes.
 */

export const MANAGED_ENABLEMENT_FALLBACK_ERROR_KEY = 'skillsList.enableFailedReason.generic'

const ERROR_KEY_BY_CODE: Record<string, string> = {
  VALIDATION_ERROR: MANAGED_ENABLEMENT_FALLBACK_ERROR_KEY,
  workspace_context_mismatch: 'skillsList.enableFailedReason.workspaceContext',
  OFFLINE_READ_ONLY: 'skillsList.enableFailedReason.offlineReadOnly',
  bundled_skill_not_disableable: 'skillsList.enableFailedReason.bundledSkill',
  managed_skill_not_toggleable: 'skillsList.enableFailedReason.managedSkill',
  shadowed_builtin_not_toggleable: 'skillsList.enableFailedReason.shadowedBuiltin',
  revision_conflict: 'skillsList.enableFailedReason.revisionConflict',
  skill_not_found: 'skillsList.enableFailedReason.skillNotFound',
}

/** Map a raw enablement error code to its i18n key (generic fallback). */
export function managedEnablementErrorKey(errorCode: string): string {
  return ERROR_KEY_BY_CODE[errorCode] ?? MANAGED_ENABLEMENT_FALLBACK_ERROR_KEY
}

/** Extract the raw error code the hook rethrows, for console/debug surfacing. */
export function managedEnablementErrorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
