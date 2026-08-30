import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Restore/ownership state machine for the Edit Popover's hidden inline
 * session (review round 2 issues 1–3; round 3 issue 4).
 *
 * The popover's session is hidden and its id only lives in component state,
 * so on every open/scope change this hook:
 *  1. bumps the scope generation and clears the inline session,
 *  2. flips `restoring` on (the popover must keep its send entry disabled
 *     while the adoption query is in flight),
 *  3. asks the server for the popover-origin session that still owns an
 *     active pending question for this workspace + owner, and adopts it.
 *
 * Concurrency contract:
 * - CAS adoption: a late restore result is adopted ONLY when the scope is
 *   unchanged and no session exists / no creation is in flight.
 * - Generation binding (round 3): every create captures the generation of
 *   its scope; when the scope changes (workspace A → B, popover reopen) the
 *   stale creation commits nothing — the created A session is never adopted
 *   into B's scope and B's messages can never land in it.
 * - In-flight dedupe: concurrent sends share ONE create promise, so a double
 *   send creates a single hidden session, never two.
 */
export interface EditPopoverSessionRestoreParams {
  /** Whether the popover is currently open. */
  open: boolean
  /** Current workspace id (adopt + create are scoped to it). */
  workspaceId: string | undefined
  /** Stable owner identity for this popover (fixed-length editor-identity hash). */
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
   * synchronously so an in-flight restore can never overwrite it, and it is
   * bound to the current scope generation: a create that finishes after the
   * scope changed commits nothing and hands back null.
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
  // Increments on every open/scope change (open, workspaceId, popoverOwnerId).
  // In-flight restores AND creations capture the generation they started with
  // and commit nothing once it has moved on.
  const scopeGenerationRef = useRef(0)
  // The in-flight creation, bound to the generation it belongs to (review
  // round 4, issue 1): dedupe happens ONLY between same-generation calls —
  // after a scope switch the new scope starts its OWN creation instead of
  // inheriting the stale one, and a stale settlement can never clear the new
  // scope's in-flight state.
  const creatingRef = useRef<{ generation: number; promise: Promise<string | null> } | null>(null)

  const setSessionId = useCallback((id: string | null) => {
    inlineSessionIdRef.current = id
    setInlineSessionId(id)
  }, [])

  // Reset + adopt on open/scope change. The generation bump invalidates any
  // in-flight work from the previous scope; the CAS guards the "delayed
  // restore + quick send" race; the generation check guards the "scope
  // switched mid-restore" race.
  useEffect(() => {
    scopeGenerationRef.current += 1
    setSessionId(null)
    if (!open || !workspaceId) {
      setRestoring(false)
      return
    }
    const generation = scopeGenerationRef.current
    let cancelled = false
    setRestoring(true)
    void restorePendingSession()
      .then(result => {
        if (cancelled || !result) return
        // CAS + scope guard: only adopt when the scope is unchanged, no
        // session exists, and no creation for THIS scope is in flight. An
        // in-flight creation from an OLD scope does not block this scope's
        // adoption (review round 4, issue 1).
        if (scopeGenerationRef.current !== generation) return
        if (inlineSessionIdRef.current === null && creatingRef.current?.generation !== generation) {
          setSessionId(result.sessionId)
        }
      })
      .catch(error => {
        // Adoption is best-effort: without a reachable pending question the
        // popover falls back to creating a fresh session on the first send.
        console.warn('[EditPopover] failed to restore pending question session:', error)
      })
      .finally(() => {
        if (!cancelled && scopeGenerationRef.current === generation) {
          setRestoring(false)
        }
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
    const generation = scopeGenerationRef.current
    // Dedupe concurrent sends WITHIN the same scope generation only — a
    // double send creates exactly one hidden session, while a scope switch
    // lets the NEW scope start its own creation instead of inheriting the
    // stale one (review round 4, issue 1).
    const inFlight = creatingRef.current
    if (inFlight && inFlight.generation === generation) return inFlight.promise
    // Mark the creation synchronously: an in-flight restore that resolves
    // later must never adopt over this reserved slot.
    const promise = createPopoverSession()
      .then(sessionId => {
        if (scopeGenerationRef.current !== generation) {
          // Scope changed while creating (workspace A → B switch, popover
          // reopen): the stale session must NOT be adopted into the new
          // scope — hand nothing back so no stale message lands in it.
          return null
        }
        if (inlineSessionIdRef.current === null) {
          setSessionId(sessionId)
        }
        return inlineSessionIdRef.current
      })
      .finally(() => {
        // Only clear the in-flight entry if it is still OURS — a stale
        // settlement must never clean up a newer scope's creation.
        if (creatingRef.current?.promise === promise) {
          creatingRef.current = null
        }
      })
    creatingRef.current = { generation, promise }
    return promise
  }, [workspaceId, createPopoverSession, setSessionId])

  return { inlineSessionId, restoring, ensureSessionForSend }
}
