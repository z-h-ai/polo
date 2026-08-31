import type { QuestionRequest } from '../../shared/types'

/**
 * Pending-question map helpers (request_user_input).
 *
 * Pure functions so the cleanup semantics stay unit-testable. At most one
 * pending question exists per session; a new requestId replaces the old one.
 *
 * State model:
 * - REALTIME events (question_request / question_resolved / session_deleted)
 *   are authoritative and mutate the map directly;
 * - session snapshots only FILL HOLES — an existing entry (fresher
 *   event-driven state) is never downgraded, replaced, or resurrected by an
 *   in-flight fetch, and holes made by a NEWER resolution / deletion are
 *   never re-filled by an OLDER snapshot (see {@link PendingQuestionTerminalGuard});
 * - resolutions are guarded by requestId so a stale resolution can never
 *   delete a newer card.
 */

/**
 * Terminal markers for snapshot filling (lightweight per-session /
 * requestId guard).
 *
 * A realtime resolution or deletion makes a HOLE in the map; a session
 * snapshot that was already in flight carries the OLDER state and must not
 * re-fill that hole. The guard records which requestIds (and whole sessions)
 * reached a terminal state locally; {@link syncPendingQuestionFromSession}
 * consults it before filling. A fresh realtime `question_request` re-opens
 * the lifecycle and clears the session's markers.
 */
export class PendingQuestionTerminalGuard {
  /** Session → requestIds whose resolution/deletion removed the local card. */
  private resolved = new Map<string, Set<string>>()
  /** Sessions deleted locally — every snapshot fill for them is stale. */
  private deleted = new Set<string>()

  /** Record a requestId whose card was removed by a realtime resolution. */
  markResolved(sessionId: string, requestId: string): void {
    let ids = this.resolved.get(sessionId)
    if (!ids) {
      ids = new Set()
      this.resolved.set(sessionId, ids)
    }
    ids.add(requestId)
  }

  /** Record a session deletion — blocks every snapshot fill for it. */
  markDeleted(sessionId: string): void {
    this.deleted.add(sessionId)
    this.resolved.delete(sessionId)
  }

  /** A fresh realtime question re-opens the lifecycle — clear the markers. */
  markReplaced(sessionId: string): void {
    this.deleted.delete(sessionId)
    this.resolved.delete(sessionId)
  }

  /** Whether a snapshot payload with this requestId may fill the hole. */
  canFill(sessionId: string, requestId: string): boolean {
    if (this.deleted.has(sessionId)) return false
    return !this.resolved.get(sessionId)?.has(requestId)
  }
}

/**
 * Set (replace) the pending question for a session. A new requestId
 * automatically replaces the previous entry, and a fresh realtime request
 * re-opens the snapshot-fill lifecycle.
 */
export function setPendingQuestionForSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  request: QuestionRequest,
  guard?: PendingQuestionTerminalGuard,
): Map<string, QuestionRequest> {
  const next = new Map(map)
  next.set(sessionId, request)
  guard?.markReplaced(sessionId)
  return next
}

/**
 * Remove the pending question for a session ONLY when its current requestId
 * matches resolvedRequestId. Guards the race where a follow-up question
 * (q2) arrives while an earlier resolution (q1) is still in flight — the
 * stale resolution must not delete the newer card. The removed requestId is
 * recorded as terminal so an older in-flight snapshot cannot resurrect it.
 */
export function removePendingQuestionForSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  resolvedRequestId: string,
  guard?: PendingQuestionTerminalGuard,
): Map<string, QuestionRequest> {
  const current = map.get(sessionId)
  if (!current || current.requestId !== resolvedRequestId) return map
  const next = new Map(map)
  next.delete(sessionId)
  guard?.markResolved(sessionId, resolvedRequestId)
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
 * downgraded or resurrected by an in-flight session fetch, and a payload
 * whose requestId already reached a terminal state locally (resolved /
 * deleted per {@link PendingQuestionTerminalGuard}) is never re-filled from
 * an older snapshot. A snapshot is a hole-filler, never an authority over
 * realtime state.
 */
export function syncPendingQuestionFromSession(
  map: Map<string, QuestionRequest>,
  session: Pick<QuestionRequestSession, 'id' | 'pendingQuestion'>,
  guard?: PendingQuestionTerminalGuard,
): Map<string, QuestionRequest> {
  const payload = session.pendingQuestion
  if (!payload) return map
  if (map.has(session.id)) return map
  if (guard && !guard.canFill(session.id, payload.requestId)) return map
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
 * repeated (multi-window) events must stay idempotent, and no older
 * in-flight snapshot may re-fill the session's card.
 */
export function clearPendingQuestionForDeletedSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  guard?: PendingQuestionTerminalGuard,
): Map<string, QuestionRequest> {
  guard?.markDeleted(sessionId)
  if (!map.has(sessionId)) return map
  const next = new Map(map)
  next.delete(sessionId)
  return next
}
