import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Restore/ownership state machine for the Edit Popover's hidden inline
 * session (review round 2, issues 1–3).
 *
 * The popover's session is hidden and its id only lives in component state,
 * so on every open this hook:
 *  1. clears the inline session,
 *  2. flips `restoring` on (the popover must keep its send entry disabled
 *     while the adoption query is in flight),
 *  3. asks the server for the popover-origin session that still owns an
 *     active pending question for this workspace + owner, and adopts it.
 *
 * Concurrency contract (CAS): a late restore result is adopted ONLY when no
 * session has been created or adopted in the meantime (`inlineSessionIdRef`
 * still null and no creation in flight). A quick send during the restore
 * window wins; the stale restore result is discarded and never yanks the UI
 * back to an old question, and the freshly created session is never stranded.
 */
export interface EditPopoverSessionRestoreParams {
  /** Whether the popover is currently open. */
  open: boolean
  /** Current workspace id (adopt + create are scoped to it). */
  workspaceId: string | undefined
  /** Stable owner identity for this popover (label::filePath). */
  popoverOwnerId: string
  /** Server lookup for the scoped pending-question session. */
  restorePendingSession: () => Promise<{ sessionId: string } | null>
  /** Trusted popover session creation (server stamps the edit-popover origin). */
  createPopoverSession: () => Promise<string>
}

export interface EditPopoverSessionRestoreState {
  /** The inline session id (adopted or newly created), null until one exists. */
  inlineSessionId: string | null
  /** True while the adoption query is in flight — the send entry stays disabled. */
  restoring: boolean
  /**
   * Reuse the current inline session or create one. The creation is marked
   * synchronously so an in-flight restore can never overwrite it.
   */
  ensureSessionForSend: () => Promise<string | null>
}

export function useEditPopoverSessionRestore(params: EditPopoverSessionRestoreParams): EditPopoverSessionRestoreState {
  const { open, workspaceId, popoverOwnerId, restorePendingSession, createPopoverSession } = params

  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  // Synchronous mirror of inlineSessionId for CAS checks inside async flows
  // (state updates are not observable within the same tick).
  const inlineSessionIdRef = useRef<string | null>(null)
  // True while ensureSessionForSend's createPopoverSession is in flight —
  // blocks a late adoption from racing the reserved creation slot.
  const creatingRef = useRef(false)

  const setSessionId = useCallback((id: string | null) => {
    inlineSessionIdRef.current = id
    setInlineSessionId(id)
  }, [])

  // Reset + adopt on open. The CAS guards against the "delayed restore +
  // quick send" race: only adopt when no session exists or is being created.
  useEffect(() => {
    if (!open) return
    setSessionId(null)
    if (!workspaceId) return
    let cancelled = false
    setRestoring(true)
    void restorePendingSession()
      .then(result => {
        if (cancelled || !result) return
        // CAS: a send that already created/adopted (or is creating) a session
        // keeps priority over this stale restore result.
        if (inlineSessionIdRef.current === null && !creatingRef.current) {
          setSessionId(result.sessionId)
        }
      })
      .catch(error => {
        // Adoption is best-effort: without a reachable pending question the
        // popover falls back to creating a fresh session on the first send.
        console.warn('[EditPopover] failed to restore pending question session:', error)
      })
      .finally(() => {
        if (!cancelled) setRestoring(false)
      })
    return () => {
      cancelled = true
    }
    // restorePendingSession/createPopoverSession are stable callbacks owned by
    // the caller; re-running on their identity churn would restart adoption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, popoverOwnerId, setSessionId])

  const ensureSessionForSend = useCallback(async (): Promise<string | null> => {
    const existing = inlineSessionIdRef.current
    if (existing) return existing
    if (!workspaceId) return null
    // Mark the creation synchronously: an in-flight restore that resolves
    // later must never adopt over this reserved slot.
    creatingRef.current = true
    try {
      const sessionId = await createPopoverSession()
      setSessionId(sessionId)
      return sessionId
    } finally {
      creatingRef.current = false
    }
  }, [workspaceId, createPopoverSession, setSessionId])

  return { inlineSessionId, restoring, ensureSessionForSend }
}
