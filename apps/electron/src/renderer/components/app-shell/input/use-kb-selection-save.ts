import * as React from 'react'

/**
 * Optimistic KB selection persistence for the composer (POO-108 reviews
 * #11/N2). A failed save rolls the selection back — but to the last CONFIRMED
 * server snapshot, never to an optimistic guess, and only when the failing
 * request is still (a) the composer's LATEST save request, (b) issued for the
 * session the composer is currently showing, and (c) not older than the
 * session LIFECYCLE generation current at settlement.
 *
 * The composer component is reused across sessions, so an unguarded rollback
 * let a stale failure restore session A's selection into session B, let a
 * slow older failure overwrite a newer save in the same session, and let an
 * A→B→A round trip resurrect a request issued before the switches — its
 * session id matched again, so the earlier guards let it through. Requests
 * are now additionally bound to a generation that advances on EVERY session
 * change, and the rollback target is the confirmed snapshot: the value the
 * server is known to hold, fed by save successes AND by the server-pushed
 * scope arriving through `serverValue`, ordered by a monotonic confirmation
 * sequence. A rollback can therefore never move a selection across sessions,
 * backwards in time, or away from what the server actually holds.
 */
export function useKbSelectionSave(options: {
  /** The session the composer is currently rendering for. */
  sessionId: string | undefined
  /** The server-pushed scope of the current session — the confirmed truth. */
  serverValue: string[]
  /** Persists the selection; a rejection marks the save failed. */
  save: (collectionIds: string[]) => Promise<void> | void
  /** Applies the rollback; receives the confirmed server snapshot. */
  rollback: (confirmed: string[]) => void
  /** Surfaces the failure to the user; called for every failed save. */
  notifyFailure: () => void
}): (next: string[]) => Promise<void> {
  const { sessionId, serverValue, save, rollback, notifyFailure } = options
  // Monotonic request sequence: only the latest request may touch the
  // selection state at settlement time.
  const requestSeqRef = React.useRef(0)
  // Session LIFECYCLE generation: advanced on EVERY sessionId change —
  // A→B→A included — so a request issued before a switch can never settle
  // after it, even when the session id matches again (review N2).
  const generationRef = React.useRef(0)
  const lastSessionIdRef = React.useRef(sessionId)
  if (lastSessionIdRef.current !== sessionId) {
    lastSessionIdRef.current = sessionId
    generationRef.current += 1
  }
  // Mirrors read at settlement time: a failure callback runs after awaits,
  // so it must consult the CURRENT session, generation and server scope, not
  // the ones captured when the request was issued.
  const activeSessionRef = React.useRef(sessionId)
  activeSessionRef.current = sessionId
  const activeGenerationRef = React.useRef(0)
  activeGenerationRef.current = generationRef.current
  const activeServerValueRef = React.useRef(serverValue)
  activeServerValueRef.current = serverValue

  // The CONFIRMED server snapshot. Two sources feed it (review #11): a
  // settled save (the server accepted that exact value) and the
  // server-pushed scope arriving through `serverValue` — a scope event while
  // a request is pending always becomes the newer confirmation, so a later
  // rollback lands on it, not on the pending optimistic guess. Writes
  // overwrite the record whole, so the most recent confirmation in real time
  // is always what a settlement reads.
  const confirmedRef = React.useRef<{
    sessionId: string
    generation: number
    value: string[]
  } | null>(null)
  const serverValueKey = JSON.stringify(serverValue)
  const lastServerValueKeyRef = React.useRef<string | null>(null)
  if (sessionId !== undefined && serverValueKey !== lastServerValueKeyRef.current) {
    lastServerValueKeyRef.current = serverValueKey
    confirmedRef.current = {
      sessionId,
      generation: generationRef.current,
      value: [...serverValue],
    }
  }

  return React.useCallback(async (next: string[]) => {
    // Captured at invocation (not callback creation) so the guard always
    // reflects the session, generation and sequence of the click that
    // actually happened.
    const requestSessionId = activeSessionRef.current
    const requestGeneration = activeGenerationRef.current
    const requestSeq = ++requestSeqRef.current
    try {
      await save(next)
      // A settled save CONFIRMS its value — but only while it is still the
      // latest request: a stale success must not drag the confirmed snapshot
      // behind a scope event that already moved it (review #11).
      if (requestSessionId !== undefined && requestSeq === requestSeqRef.current) {
        confirmedRef.current = {
          sessionId: requestSessionId,
          generation: requestGeneration,
          value: [...next],
        }
      }
    } catch {
      const isLatestRequest = requestSeq === requestSeqRef.current
      const currentSession = activeSessionRef.current
      const currentGeneration = activeGenerationRef.current
      const confirmed = confirmedRef.current
      // Rollback target: the newest confirmation of the CURRENT session and
      // generation; when none matches (fresh session, no event and no settled
      // save yet) the live server scope is that truth by definition.
      const confirmedSnapshot = confirmed
        && confirmed.sessionId === currentSession
        && confirmed.generation === currentGeneration
        ? confirmed.value
        : [...activeServerValueRef.current]
      if (isLatestRequest
        && requestSessionId !== undefined
        && currentSession === requestSessionId
        && currentGeneration === requestGeneration
      ) {
        rollback(confirmedSnapshot)
      }
      notifyFailure()
    }
  }, [save, rollback, notifyFailure])
}
