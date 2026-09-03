import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Outcome of ONE scoped restore query. Only `empty` is authoritative —
 * `transient` (I/O / IPC / hydration failure) keeps the restore gate engaged
 * for the bounded retry budget.
 */
export type EditPopoverRestoreOutcome =
  | { outcome: 'found'; sessionId: string }
  | { outcome: 'empty' }
  | { outcome: 'transient'; message?: string }

/** Bounded retry budget for the restore loop (injectable for tests). */
export const EDIT_POPOVER_RESTORE_MAX_ATTEMPTS = 3

/**
 * Fail-closed signal: the scoped pending-question lookup could not produce an
 * authoritative found/empty outcome, so creating a fresh hidden session is
 * NOT authorized (a still-pending question would be orphaned — the popover
 * session is hidden and unreachable through the session list). The caller
 * surfaces this to the user as a retryable send failure.
 */
export class EditPopoverRestoreUnavailableError extends Error {
  constructor(public readonly lastMessage?: string) {
    super(lastMessage
      ? `Edit Popover pending-question restore is temporarily unavailable: ${lastMessage}`
      : 'Edit Popover pending-question restore is temporarily unavailable')
    this.name = 'EditPopoverRestoreUnavailableError'
  }
}

/**
 * Restore/ownership state machine for the Edit Popover's hidden inline
 * session.
 *
 * The popover's session is hidden and its id only lives in component state,
 * so on every open/scope change this hook:
 *  1. bumps the scope generation and clears the inline session,
 *  2. flips `restoring` on (the popover must keep its send entry disabled
 *     while the adoption query is in flight),
 *  3. asks the server for the popover-origin session that still owns an
 *     active pending question for this workspace + owner, and adopts it.
 *
 * Transient failures are retried a BOUNDED number of times with a small
 * backoff. Budget exhaustion releases the `restoring` flag but stays
 * FAIL-CLOSED for creation: a new hidden session may only be created after
 * an AUTHORITATIVE empty lookup. The first send under an inconclusive
 * restore runs one final authoritative query — found adopts it, empty
 * authorizes creation, and a transient rejection throws
 * {@link EditPopoverRestoreUnavailableError} instead of silently creating an
 * orphaning session.
 *
 * Concurrency contract:
 * - CAS adoption: a late restore result is adopted ONLY when the scope is
 *   unchanged and no session exists / no creation is in flight.
 * - Generation binding: every create captures the generation of its scope;
 *   when the scope changes (workspace A → B, popover reopen) the stale
 *   creation commits nothing — the created A session is never adopted into
 *   B's scope and B's messages can never land in it.
 * - In-flight dedupe: concurrent sends share ONE create promise, so a double
 *   send creates a single hidden session, never two.
 */
export interface EditPopoverSessionRestoreParams {
  /** Whether the popover is currently open. */
  open: boolean
  /** Current workspace id (adopt + create are scoped to it). */
  workspaceId: string | undefined
  /** Stable owner identity for this popover (fixed-length editor hash). */
  popoverOwnerId: string
  /** Server lookup for the scoped pending-question session (one attempt). */
  restorePendingSession: () => Promise<EditPopoverRestoreOutcome>
  /** Trusted popover session creation (server stamps the edit-popover origin). */
  createPopoverSession: () => Promise<string>
  /** Backoff between transient retries (ms); injectable for tests. */
  backoffMs?: (attempt: number) => number
}

export interface EditPopoverSessionRestoreState {
  /** The inline session id (adopted or newly created), null until one exists. */
  inlineSessionId: string | null
  /**
   * True while the restore loop is running — the send entry stays disabled.
   * Released by an authoritative found/empty outcome or budget exhaustion;
   * creation stays fail-closed until an authoritative empty (or an adopted
   * session) exists.
   */
  restoring: boolean
  /**
   * Reuse the current inline session or create one. The creation is marked
   * synchronously so an in-flight restore can never overwrite it. Throws
   * {@link EditPopoverRestoreUnavailableError} when the scoped lookup is
   * inconclusive — creation is never authorized by an unknown state.
   */
  ensureSessionForSend: () => Promise<string | null>
}

export function useEditPopoverSessionRestore(params: EditPopoverSessionRestoreParams): EditPopoverSessionRestoreState {
  const { open, workspaceId, popoverOwnerId, restorePendingSession, createPopoverSession, backoffMs: backoffMsParam } = params

  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  // Synchronous mirror of inlineSessionId for CAS checks inside async flows
  // (state updates are not observable within the same tick).
  const inlineSessionIdRef = useRef<string | null>(null)
  // Increments on every open/scope change (open, workspaceId, popoverOwnerId).
  // In-flight restores AND creations capture the generation they started with
  // and commit nothing once it has moved on.
  const scopeGenerationRef = useRef(0)
  // Creation authorization: only an AUTHORITATIVE empty lookup for the
  // CURRENT scope opens it. Budget exhaustion (inconclusive) never does.
  const restoreSettledEmptyRef = useRef(false)
  // The in-flight creation, bound to the generation it belongs to: dedupe
  // happens ONLY between same-generation calls — after a scope switch the
  // new scope starts its OWN creation instead of inheriting the stale one,
  // and a stale settlement can never clear the new scope's in-flight state.
  const creatingRef = useRef<{ generation: number; promise: Promise<string | null> } | null>(null)
  // Dedupes concurrent final authoritative queries under the same scope.
  const finalGateRef = useRef<{ generation: number; promise: Promise<'found' | 'empty'> } | null>(null)

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
    restoreSettledEmptyRef.current = false
    finalGateRef.current = null
    if (!open || !workspaceId) {
      setRestoring(false)
      return
    }
    const generation = scopeGenerationRef.current
    const backoffMs = backoffMsParam ?? ((attempt: number) => Math.min(250 * 2 ** attempt, 2000))
    let cancelled = false
    const run = async (): Promise<void> => {
      setRestoring(true)
      for (let attempt = 0; attempt < EDIT_POPOVER_RESTORE_MAX_ATTEMPTS; attempt++) {
        let outcome: EditPopoverRestoreOutcome
        try {
          outcome = await restorePendingSession()
        } catch (error) {
          // Defensive: restorePendingSession implementations absorb RPC
          // rejections; treat any escape as transient.
          outcome = { outcome: 'transient', message: error instanceof Error ? error.message : String(error) }
        }
        if (cancelled || scopeGenerationRef.current !== generation) return

        if (outcome.outcome === 'found') {
          // CAS: a send that already created/adopted (or is creating) a
          // session keeps priority over this adoption.
          if (inlineSessionIdRef.current === null && creatingRef.current?.generation !== generation) {
            setSessionId(outcome.sessionId)
          }
          setRestoring(false)
          return
        }
        if (outcome.outcome === 'empty') {
          // Authoritative: no pending question for this scope — creating a
          // fresh session on the next send is authorized.
          restoreSettledEmptyRef.current = true
          setRestoring(false)
          return
        }
        // transient → keep the gate closed, back off, re-query the same
        // scope — within the bounded budget only. Inconclusive exhaustion
        // stays fail-closed for creation (see ensureSessionForSend).
        if (attempt < EDIT_POPOVER_RESTORE_MAX_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, backoffMs(attempt)))
          if (cancelled || scopeGenerationRef.current !== generation) return
        }
      }
      // Budget exhausted: release the disable flag, but the restore is
      // INCONCLUSIVE — creation stays blocked until an authoritative lookup
      // (the send's final gate) settles it.
      setRestoring(false)
    }
    void run()
    return () => {
      cancelled = true
    }
    // restorePendingSession/createPopoverSession are stable callbacks owned by
    // the caller; re-running on their identity churn would restart adoption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, popoverOwnerId, setSessionId, backoffMsParam])

  /**
   * ONE authoritative query that may still open the creation gate. Deduped
   * per scope so concurrent sends share the verdict. Returns 'found' only
   * when the session was adopted into the current scope.
   */
  const runFinalAuthoritativeQuery = useCallback(async (generation: number): Promise<'found' | 'empty'> => {
    const inFlight = finalGateRef.current
    if (inFlight && inFlight.generation === generation) return inFlight.promise
    const promise = (async (): Promise<'found' | 'empty'> => {
      const outcome = await restorePendingSession()
      if (scopeGenerationRef.current !== generation) return 'empty' // stale scope: caller will bail anyway
      if (outcome.outcome === 'found') {
        if (inlineSessionIdRef.current === null && creatingRef.current?.generation !== generation) {
          setSessionId(outcome.sessionId)
        }
        return 'found'
      }
      if (outcome.outcome === 'empty') {
        restoreSettledEmptyRef.current = true
        return 'empty'
      }
      throw new EditPopoverRestoreUnavailableError(outcome.message)
    })()
      .finally(() => {
        if (finalGateRef.current?.promise === promise) finalGateRef.current = null
      })
    finalGateRef.current = { generation, promise }
    return promise
  }, [restorePendingSession, setSessionId])

  const ensureSessionForSend = useCallback(async (): Promise<string | null> => {
    const existing = inlineSessionIdRef.current
    if (existing) return existing
    if (!workspaceId) return null
    const generation = scopeGenerationRef.current
    // FAIL-CLOSED CREATION GATE: an inconclusive restore never authorizes a
    // new hidden session (it would orphan a still-pending question that no
    // session-list fallback can reach). One final authoritative query for
    // THIS send settles it: found → adopt, empty → authorize, transient →
    // surface a retryable failure instead of creating.
    if (!restoreSettledEmptyRef.current) {
      const verdict = await runFinalAuthoritativeQuery(generation)
      if (scopeGenerationRef.current !== generation) return null
      if (verdict === 'found') return inlineSessionIdRef.current
    }
    // Dedupe concurrent sends WITHIN the same scope generation only — a
    // double send creates exactly one hidden session, while a scope switch
    // lets the NEW scope start its own creation instead of inheriting the
    // stale one.
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
  }, [workspaceId, createPopoverSession, setSessionId, runFinalAuthoritativeQuery])

  return { inlineSessionId, restoring, ensureSessionForSend }
}
