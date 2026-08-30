import { useCallback, useEffect, useRef, useState } from 'react'
import { i18n } from '@polo-ai/shared/i18n'

/**
 * Outcome of ONE scoped restore query (review round 8, issue 1). Only
 * `empty` is authoritative — `transient` (I/O / IPC / hydration failure)
 * must keep the restore gate engaged so a valid pending question is never
 * orphaned behind a brand-new session.
 */
export type EditPopoverRestoreOutcome =
  | { outcome: 'found'; sessionId: string }
  | { outcome: 'empty' }
  | { outcome: 'transient'; message?: string }

/**
 * Restore/ownership state machine for the Edit Popover's hidden inline
 * session (review round 2 issues 1–3; round 3 issue 4; rounds 5–8).
 *
 * The popover's session is hidden and its id only lives in component state,
 * so on every open/scope change this hook:
 *  1. bumps the scope generation and clears the inline session,
 *  2. flips `restoring` on (the popover must keep its send entry disabled
 *     while the adoption query is in flight),
 *  3. asks the server for the popover-origin session that still owns an
 *     active pending question for this workspace + owner, and adopts it.
 *
 * Transient failures (RPC rejection, `transient` outcome) NEVER release the
 * gate: the hook retries with bounded backoff and exposes a readable
 * `restoreNote` while doing so (review round 8, issue 1). Only an
 * authoritative `found`/`empty` settles the restore.
 *
 * Concurrency contract:
 * - CAS adoption: a late restore result is adopted ONLY when the scope is
 *   unchanged and no session exists / no creation is in flight.
 * - Generation binding (round 3/4): every create captures the generation of
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
   * Released ONLY by an authoritative found/empty outcome.
   */
  restoring: boolean
  /** Readable retry state while transient failures keep the gate closed. */
  restoreNote: string | null
  /**
   * Reuse the current inline session or create one. The creation is marked
   * synchronously so an in-flight restore can never overwrite it.
   */
  ensureSessionForSend: () => Promise<string | null>
}

export function useEditPopoverSessionRestore(params: EditPopoverSessionRestoreParams): EditPopoverSessionRestoreState {
  const { open, workspaceId, popoverOwnerId, restorePendingSession, createPopoverSession, backoffMs: backoffMsParam } = params

  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
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
  //
  // TRANSIENT failures (review round 8, issue 1): an RPC rejection or a
  // `transient` outcome (session-list I/O, hydration, IPC) does NOT release
  // the restore gate — the hook retries with bounded backoff and surfaces a
  // readable note. Only an authoritative found/empty settles the restore.
  useEffect(() => {
    scopeGenerationRef.current += 1
    setSessionId(null)
    if (!open || !workspaceId) {
      setRestoring(false)
      setRestoreNote(null)
      return
    }
    const generation = scopeGenerationRef.current
    const backoffMs = backoffMsParam ?? ((attempt: number) => Math.min(250 * 2 ** attempt, 2000))
    let cancelled = false
    const run = async (): Promise<void> => {
      setRestoring(true)
      for (let attempt = 0; ; attempt++) {
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
          setRestoreNote(null)
          setRestoring(false)
          return
        }
        if (outcome.outcome === 'empty') {
          // Authoritative: no pending question for this scope — creating a
          // fresh session on the next send is safe.
          setRestoreNote(null)
          setRestoring(false)
          return
        }
        // transient → keep the gate closed, show a readable retry state,
        // back off, and re-query the same scope.
        setRestoreNote(i18n.t('chat.questionRestoreRetrying'))
        await new Promise(resolve => setTimeout(resolve, backoffMs(attempt)))
        if (cancelled || scopeGenerationRef.current !== generation) return
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // restorePendingSession/createPopoverSession are stable callbacks owned by
    // the caller; re-running on their identity churn would restart adoption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, popoverOwnerId, setSessionId, backoffMsParam])

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

  return { inlineSessionId, restoring, restoreNote, ensureSessionForSend }
}
