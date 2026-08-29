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
 * Hydrate the pendingQuestions map from a fully-loaded Session payload.
 *
 * Only FILLS a missing entry — an existing entry (fresher event-driven state:
 * question_request / question_resolved / resolution cleanup) is never
 * downgraded or resurrected by an in-flight session fetch. This restores the
 * card after restart/session-switch once the session is opened, complementing
 * the list-badge hydration from getSessions.
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
