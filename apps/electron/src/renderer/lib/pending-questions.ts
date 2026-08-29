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
 * session (question_request / question_resolved / RPC cleanup). A snapshot
 * fetch captures the generation at request time; only apply the response when
 * the generation is unchanged — otherwise the fetch raced a fresher event and
 * its payload is stale.
 */
export class PendingQuestionGenerationTracker {
  private generations = new Map<string, number>()

  /** Bump on every realtime state change for the session. */
  bump(sessionId: string): number {
    const next = (this.generations.get(sessionId) ?? 0) + 1
    this.generations.set(sessionId, next)
    return next
  }

  /** Capture the generation token at fetch start. */
  capture(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0
  }

  /** True when nothing bumped the session since the token was captured. */
  isCurrent(sessionId: string, token: number): boolean {
    return (this.generations.get(sessionId) ?? 0) === token
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
