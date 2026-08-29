import type { QuestionRequest } from '../../shared/types'

/**
 * Pending-question map helpers (request_user_input).
 *
 * Pure functions so the cleanup semantics stay unit-testable. At most one
 * pending question exists per session; a new requestId replaces the old one.
 */

/**
 * Set (replace) the pending question for a session. A new requestId
 * automatically replaces the previous entry.
 */
export function setPendingQuestionForSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  request: QuestionRequest,
): Map<string, QuestionRequest> {
  const next = new Map(map)
  next.set(sessionId, request)
  return next
}

/**
 * Remove the pending question for a session ONLY when its current requestId
 * matches resolvedRequestId. Guards the race where a follow-up question
 * (q2) arrives while an earlier resolution (q1) is still in flight — the
 * stale resolution must not delete the newer card.
 */
export function removePendingQuestionForSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  resolvedRequestId: string,
): Map<string, QuestionRequest> {
  const current = map.get(sessionId)
  if (!current || current.requestId !== resolvedRequestId) return map
  const next = new Map(map)
  next.delete(sessionId)
  return next
}

/** The requestId a resolution targets (answer payload or explicit cancel). */
export function questionResolutionRequestId(
  resolution: import('../../shared/types').QuestionResolution,
): string {
  return resolution.action === 'answer' ? resolution.response.requestId : resolution.requestId
}

/**
 * Apply an authoritative pending-question snapshot for one session.
 *
 * The server (StoredSession) is the single source of truth — a COMPLETE
 * session snapshot can add, REPLACE, or CLEAR the entry for that session:
 * - payload present  → set (replaces any local value, including a different
 *   requestId that only exists because events were missed)
 * - payload absent   → remove (the question no longer exists server-side)
 *
 * Never call this with a snapshot of unknown freshness — pair it with
 * {@link PendingQuestionGenerationTracker} so a stale fetch cannot overwrite
 * a just-arrived question_request / question_resolved event.
 */
export function applyAuthoritativePendingQuestion(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  payload: QuestionRequest | undefined,
): Map<string, QuestionRequest> {
  if (payload) {
    const next = new Map(map)
    next.set(sessionId, payload)
    return next
  }
  if (!map.has(sessionId)) return map
  const next = new Map(map)
  next.delete(sessionId)
  return next
}

/**
 * Per-session generation counter guarding snapshot application.
 *
 * Bump whenever a realtime pending-question event mutates local state for a
 * session (question_request / question_resolved / deletion / RPC cleanup).
 * A snapshot fetch captures the generation at request time; only apply the
 * response when the generation is unchanged — otherwise the fetch raced a
 * fresher event and its payload is stale.
 */
export class PendingQuestionGenerationTracker {
  private generations = new Map<string, number>()

  /**
   * Global monotonic counter bumped on EVERY pending-state change (any per-
   * session bump also bumps this). Captured alongside per-session tokens so a
   * fetch can detect events for sessions it did not know about at capture
   * time (they had no card yet).
   */
  private globalEpochCounter = 0

  /** Bump on every realtime state change for the session. */
  bump(sessionId: string): number {
    this.globalEpochCounter += 1
    const next = (this.generations.get(sessionId) ?? 0) + 1
    this.generations.set(sessionId, next)
    return next
  }

  /** Global epoch at capture time — covers sessions not yet tracked locally. */
  get epoch(): number {
    return this.globalEpochCounter
  }

  /** Capture the generation token at fetch start. */
  capture(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0
  }

  /** True when nothing bumped the session since the token was captured. */
  isCurrent(sessionId: string, token: number): boolean {
    return (this.generations.get(sessionId) ?? 0) === token
  }

  /**
   * True when NOTHING changed globally since the epoch was captured — the
   * snapshot can be applied wholesale.
   */
  isEpochCurrent(epoch: number): boolean {
    return this.globalEpochCounter === epoch
  }

  /**
   * True when the session provably did not change since capture: it must have
   * been locally tracked at capture time (token exists) AND still be current.
   * A session with no captured token is treated as changed — its state at
   * capture time is unknown (it may have received its first event mid-fetch).
   */
  isUnchangedSince(sessionId: string, tokensBeforeFetch: Map<string, number>): boolean {
    const token = tokensBeforeFetch.get(sessionId)
    return token !== undefined && this.isCurrent(sessionId, token)
  }
}

/**
 * Hydrate the pendingQuestions map from a fully-loaded Session payload.
 *
 * Only FILLS a missing entry — an existing entry (fresher event-driven state:
 * question_request / question_resolved / resolution cleanup) is never
 * downgraded or resurrected by an in-flight session fetch. Prefer
 * {@link applyAuthoritativePendingQuestion} with a generation token when the
 * snapshot is known to be complete for the session.
 */
export function syncPendingQuestionFromSession(
  map: Map<string, QuestionRequest>,
  session: Pick<QuestionRequestSession, 'id' | 'pendingQuestion'>,
): Map<string, QuestionRequest> {
  const payload = session.pendingQuestion
  if (!payload) return map
  const existing = map.get(session.id)
  if (existing && existing.requestId === payload.requestId) return map
  if (existing) return map
  const next = new Map(map)
  next.set(session.id, payload)
  return next
}

/** Minimal structural shape needed from the Session DTO. */
type QuestionRequestSession = {
  id: string
  pendingQuestion?: QuestionRequest
}

/**
 * Unconditionally clear the pending question for a deleted session.
 * Deletion is a session terminal state — no requestId condition applies,
 * and repeated (multi-window) events must stay idempotent.
 */
export function clearPendingQuestionForDeletedSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
): Map<string, QuestionRequest> {
  if (!map.has(sessionId)) return map
  const next = new Map(map)
  next.delete(sessionId)
  return next
}

/**
 * Reconcile the pendingQuestions map against a list snapshot
 * (App-level logic extracted from loadSessionsFromServer /
 * refreshSessionListMetadataFromServer — see those for the wiring).
 *
 * `scope`:
 * - `'full'` — the snapshot is the COMPLETE authoritative set
 *   (loadSessionsFromServer; metadata refresh with removeMissing=true).
 *   Processes the UNION of snapshot IDs and previously-tracked IDs: sessions
 *   provably unchanged since capture are converged to the snapshot — including
 *   a snapshot ABSENCE, which clears the card (deletion / resolution that the
 *   local map missed). Changed or capture-unknown sessions keep their
 *   event-driven state.
 * - `'partial'` — the snapshot may legitimately omit sessions
 *   (metadata refresh with removeMissing=false). **Starts from previous and
 *   only converges snapshot-present sessions** — omitted sessions are NEVER
 *   cleared, in the epoch-current normal path and the drifted path alike.
 *
 * `tokensBeforeFetch` must be captured BEFORE the fetch for every session in
 * `previous` (see App's loadSessionsFromServer).
 */
export function reconcilePendingQuestionsFromSnapshot(
  previous: Map<string, QuestionRequest>,
  sessions: Array<Pick<QuestionRequestSession, 'id' | 'pendingQuestion'>>,
  tokensBeforeFetch: Map<string, number>,
  tracker: PendingQuestionGenerationTracker,
  epochAtFetch: number,
  scope: 'full' | 'partial' = 'full',
): Map<string, QuestionRequest> {
  // Returned-ID set: replaces O(P×S) `sessions.some` scans below.
  const returnedIds = new Set(sessions.map(s => s.id))

  if (tracker.isEpochCurrent(epochAtFetch)) {
    // No pending event raced the fetch. Snapshot-present sessions converge;
    // **partial scope starts from previous** — absent sessions are never
    // cleared (a removeMissing=false list may legitimately omit sessions).
    // Full scope treats absence as authoritative and clears omitted cards.
    let next = new Map(previous)
    for (const session of sessions) {
      next = applyAuthoritativePendingQuestion(next, session.id, session.pendingQuestion)
    }
    if (scope === 'full') {
      for (const id of previous.keys()) {
        if (!returnedIds.has(id)) {
          next = applyAuthoritativePendingQuestion(next, id, undefined)
        }
      }
    }
    return next
  }

  // Epoch drifted: some event raced the fetch. Converge only provably-
  // unchanged sessions; keep event-driven state for everything else.
  let next = new Map(previous)
  const converged = new Set<string>()
  for (const session of sessions) {
    if (!tracker.isUnchangedSince(session.id, tokensBeforeFetch)) {
      continue
    }
    next = applyAuthoritativePendingQuestion(next, session.id, session.pendingQuestion)
    converged.add(session.id)
  }
  if (scope === 'full') {
    // Snapshot absence is authoritative for provably-unchanged sessions that
    // the complete list no longer contains — clear their cards too.
    for (const id of previous.keys()) {
      if (converged.has(id)) continue
      if (!returnedIds.has(id) && tracker.isUnchangedSince(id, tokensBeforeFetch)) {
        next = applyAuthoritativePendingQuestion(next, id, undefined)
      }
    }
  }
  return next
}
