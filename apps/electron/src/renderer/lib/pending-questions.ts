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
 * Realtime gate for the Edit Popover pending-question restore RPC (review
 * round 5, issue 1 + round 6, issue 2).
 *
 * The lookup does not know the sessionId up front, so it can only capture the
 * tracker's GLOBAL epoch before the RPC starts. While the RPC is in flight,
 * any pending-state event — a question_resolved committed from another
 * window, or a brand-new question_request — bumps the epoch.
 *
 * The gate DISTINGUISHES the outcomes instead of folding them into null:
 * - fresh:   epoch unchanged AND a result came back → safe to seed.
 * - empty:   epoch unchanged AND the server authoritatively has no pending
 *            question for this scope → restoring may end; a new session may
 *            be created.
 * - drifted: the epoch moved while the RPC was in flight → the result must
 *            NOT be seeded (it may resurrect a resolved card), but this is
 *            NOT an authoritative "no pending" either — the caller must
 *            re-query (bounded) before giving up. Treating drift as empty
 *            would strand a still-pending question behind a new session.
 */
export type RestoredPendingQuestionGate<T> =
  | { outcome: 'fresh'; result: T }
  | { outcome: 'drifted' }
  | { outcome: 'empty' }

export function gateRestoredPendingQuestion<T extends { sessionId: string; request: QuestionRequest }>(
  tracker: PendingQuestionGenerationTracker,
  epochAtFetch: number,
  result: T | null,
): RestoredPendingQuestionGate<T> {
  const drifted = tracker.epoch !== epochAtFetch
  if (!result) {
    return drifted ? { outcome: 'drifted' } : { outcome: 'empty' }
  }
  return drifted ? { outcome: 'drifted' } : { outcome: 'fresh', result }
}

/**
 * Bounded scoped re-query around the restore RPC (review round 6, issue 2;
 * round 7, issue 1).
 *
 * Captures the epoch before every attempt; `fresh` returns the result,
 * `empty` (authoritative, undrifted) ends the restore, and `drifted` retries
 * within the bounded budget. Budget exhaustion returns
 * `{ outcome: 'inconclusive' }` — NEVER a null that could be mistaken for
 * the authoritative empty: a drifted world still knows nothing about the
 * scope, so the caller must keep blocking fresh-session creation and
 * re-query (see {@link restorePendingQuestionUntilAuthoritative}).
 */
export type RestoredPendingQuestionOutcome<T> =
  | { outcome: 'fresh'; result: T }
  | { outcome: 'empty' }
  | { outcome: 'inconclusive' }

export async function restorePendingQuestionWithRealtimeGate<T extends { sessionId: string; request: QuestionRequest }>(
  tracker: PendingQuestionGenerationTracker,
  fetchResult: () => Promise<T | null>,
  maxAttempts = 2,
): Promise<RestoredPendingQuestionOutcome<T>> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const epochAtFetch = tracker.epoch
    const result = await fetchResult()
    const gate = gateRestoredPendingQuestion<T>(tracker, epochAtFetch, result)
    if (gate.outcome === 'fresh') return { outcome: 'fresh', result: gate.result }
    if (gate.outcome === 'empty') return { outcome: 'empty' }
    // drifted → bounded retry
  }
  return { outcome: 'inconclusive' }
}

/**
 * Authoritative restore loop (review round 7, issue 1): wraps
 * {@link restorePendingQuestionWithRealtimeGate} with bounded backoff and
 * re-queries the SAME workspace+owner scope until the answer is
 * authoritative — a fresh pending, or an undrifted empty. Budget exhaustion
 * (`inconclusive`) must never terminate the restore: that would let the
 * popover create a brand-new session while a valid pending question is
 * still held by the old hidden session (an unreachable orphan). Callers
 * keep the restore gate engaged (send disabled) until this resolves.
 */
export async function restorePendingQuestionUntilAuthoritative<T extends { sessionId: string; request: QuestionRequest }>(
  tracker: PendingQuestionGenerationTracker,
  fetchResult: () => Promise<T | null>,
  opts: { backoffMs?: (round: number) => number; maxRounds?: number } = {},
): Promise<RestoredPendingQuestionOutcome<T>> {
  const backoffMs = opts.backoffMs ?? ((round: number) => Math.min(250 * 2 ** round, 2000))
  for (let round = 0; ; round++) {
    const outcome = await restorePendingQuestionWithRealtimeGate(tracker, fetchResult)
    if (outcome.outcome !== 'inconclusive') return outcome
    if (opts.maxRounds !== undefined && round + 1 >= opts.maxRounds) return outcome
    await new Promise(resolve => setTimeout(resolve, backoffMs(round)))
  }
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

  /**
   * Capture generation tokens for EVERY session the tracker knows about.
   * Sessions absent from the returned map implicitly had generation 0 at
   * capture time (they never received a pending-state event) — pairing the
   * snapshot with {@link isSessionUnchangedSince} lets a full-list fetch
   * validate even sessions it did not know existed at capture time.
   */
  captureAll(): Map<string, number> {
    return new Map(this.generations)
  }

  /** Current generation for a session (0 = never received a pending event). */
  generationOf(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0
  }

  /** True when nothing bumped the session since the token was captured. */
  isCurrent(sessionId: string, token: number): boolean {
    return (this.generations.get(sessionId) ?? 0) === token
  }

  /**
   * True when the session provably did not change since a full-generation
   * snapshot was captured: its generation must equal the captured value
   * (sessions absent from the snapshot had generation 0 at capture time).
   */
  isSessionUnchangedSince(sessionId: string, snapshot: Map<string, number>): boolean {
    return this.generationOf(sessionId) === (snapshot.get(sessionId) ?? 0)
  }

  /**
   * True when NOTHING changed globally since the epoch was captured — the
   * snapshot can be applied wholesale.
   */
  isEpochCurrent(epoch: number): boolean {
    return this.globalEpochCounter === epoch
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
 * `generationsAtFetch` must be captured BEFORE the fetch via
 * `tracker.captureAll()` — it records the fetch-start generation of every
 * session, so even newly-returned sessions (no local card at capture time)
 * can be classified: unchanged (generation 0 at capture, still 0) → converge
 * to the snapshot; changed mid-fetch → keep the event-driven state.
 */
export function reconcilePendingQuestionsFromSnapshot(
  previous: Map<string, QuestionRequest>,
  sessions: Array<Pick<QuestionRequestSession, 'id' | 'pendingQuestion'>>,
  generationsAtFetch: Map<string, number>,
  tracker: PendingQuestionGenerationTracker,
  epochAtFetch: number,
  scope: 'full' | 'partial' = 'full',
): Map<string, QuestionRequest> {
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
  // unchanged sessions (fetch-start generation equals the current one — this
  // includes newly-returned sessions that never received an event); keep
  // event-driven state for everything that actually changed.
  let next = new Map(previous)
  const converged = new Set<string>()
  for (const session of sessions) {
    if (!tracker.isSessionUnchangedSince(session.id, generationsAtFetch)) {
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
      if (!returnedIds.has(id) && tracker.isSessionUnchangedSince(id, generationsAtFetch)) {
        next = applyAuthoritativePendingQuestion(next, id, undefined)
      }
    }
  }
  return next
}
