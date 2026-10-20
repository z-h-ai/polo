import * as React from 'react'

/**
 * Optimistic KB selection persistence for the composer (POO-108 reviews
 * #11/N2). A failed save rolls the optimistic toggle back, but ONLY when the
 * failing request is still (a) the composer's LATEST save request and
 * (b) issued for the session the composer is currently showing.
 *
 * The composer component is reused across sessions, so an unguarded rollback
 * let a stale failure restore session A's selection into session B (and a
 * slow older failure overwrite a newer successful save in the same session).
 * Both guards are captured at request time and re-checked at settlement —
 * a rollback can therefore never move a selection across sessions or
 * backwards in time.
 */
export function useKbSelectionSave(options: {
  /** The session the composer is currently rendering for. */
  sessionId: string | undefined
  /** Persists the selection; a rejection marks the save failed. */
  save: (collectionIds: string[]) => Promise<void> | void
  /** Applies the rollback on a guarded failure. */
  rollback: (previous: string[]) => void
  /** Surfaces the failure to the user; called for every failed save. */
  notifyFailure: () => void
}): (previous: string[], next: string[]) => Promise<void> {
  const { sessionId, save, rollback, notifyFailure } = options
  // Monotonic request sequence: only the latest request may touch the
  // selection state at settlement time.
  const requestSeqRef = React.useRef(0)
  // Mirror of the current session identity, read at failure time.
  const activeSessionRef = React.useRef(sessionId)
  activeSessionRef.current = sessionId

  return React.useCallback(async (previous: string[], next: string[]) => {
    // Captured at invocation (not callback creation) so the guard always
    // reflects the session the click actually happened in.
    const requestSessionId = activeSessionRef.current
    const requestSeq = ++requestSeqRef.current
    try {
      await save(next)
    } catch {
      const isLatestRequest = requestSeq === requestSeqRef.current
      const isCurrentSession = activeSessionRef.current === requestSessionId
      if (isLatestRequest && isCurrentSession) rollback(previous)
      notifyFailure()
    }
  }, [save, rollback, notifyFailure])
}
