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
 * Terminal markers for snapshot filling (lightweight, requestId-scoped).
 *
 * A requestIds' lifecycle is terminal the moment realtime authority moves
 * past it — it is RESOLVED (answer/cancel/skip) or SUPERSEDED (a newer
 * question_request replaced it) or the whole session was DELETED. A session
 * snapshot that was already in flight carries OLDER state and must never
 * re-fill a terminal requestId's card. {@link syncPendingQuestionFromSession}
 * consults this guard before filling. Sets are bounded per session (FIFO) —
 * snapshot staleness windows are short, so a small memory is sufficient.
 */
export class PendingQuestionTerminalGuard {
  /** Bounded number of remembered terminal requestIds per session. */
  private static readonly MAX_PER_SESSION = 16
  /**
   * Session → TERMINAL requestIds (resolved, cancelled, skipped OR
   * superseded by a newer realtime question), FIFO-bounded. A terminal
   * requestId can never legitimately re-fill from an older snapshot.
   */
  private terminal = new Map<string, Set<string>>()
  /** Sessions deleted locally — every snapshot fill for them is stale. */
  private deleted = new Set<string>()

  /** Record a requestId as terminally settled (resolution consumed it). */
  markResolved(sessionId: string, requestId: string): void {
    this.markTerminal(sessionId, requestId)
  }

  /**
   * Record the card a fresh realtime question REPLACED as terminal — the
   * superseded requestId can never legitimately re-fill, even though its
   * card was swapped (not removed) by the newer question.
   */
  markSuperseded(sessionId: string, requestId: string): void {
    this.markTerminal(sessionId, requestId)
  }

  private markTerminal(sessionId: string, requestId: string): void {
    let ids = this.terminal.get(sessionId)
    if (!ids) {
      ids = new Set()
      this.terminal.set(sessionId, ids)
    }
    ids.add(requestId)
    if (ids.size > PendingQuestionTerminalGuard.MAX_PER_SESSION) {
      const oldest = ids.values().next().value
      if (oldest !== undefined) ids.delete(oldest)
    }
  }

  /** Record a session deletion — blocks every snapshot fill for it. */
  markDeleted(sessionId: string): void {
    this.deleted.add(sessionId)
    this.terminal.delete(sessionId)
  }

  /**
   * A fresh realtime question re-opens the lifecycle for DELETION markers
   * only. Terminal requestId markers are NEVER cleared: a settled or
   * superseded requestId stays terminal even when a newer question took
   * over.
   */
  markReplaced(sessionId: string): void {
    this.deleted.delete(sessionId)
  }

  /** Whether a snapshot payload with this requestId may fill the hole. */
  canFill(sessionId: string, requestId: string): boolean {
    if (this.deleted.has(sessionId)) return false
    return !this.terminal.get(sessionId)?.has(requestId)
  }
}

/**
 * Set (replace) the pending question for a session. A new requestId
 * automatically replaces the previous entry; the REPLACED requestId (if a
 * card was displayed) is recorded terminal — superseded requestIds can never
 * be re-filled by an older in-flight snapshot — and deletion markers for the
 * session are re-opened by the fresh realtime authority.
 */
export function setPendingQuestionForSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  request: QuestionRequest,
  guard?: PendingQuestionTerminalGuard,
): Map<string, QuestionRequest> {
  const next = new Map(map)
  const previous = next.get(sessionId)
  next.set(sessionId, request)
  if (guard && previous && previous.requestId !== request.requestId) {
    guard.markSuperseded(sessionId, previous.requestId)
  }
  guard?.markReplaced(sessionId)
  return next
}

/**
 * Remove the pending question for a session ONLY when its current requestId
 * matches resolvedRequestId — a stale resolution must not delete a newer
 * card. The resolved requestId is marked terminal REGARDLESS of the match:
 * the realtime resolution proves that requestId is terminal even when the
 * displayed card has already moved on, so an older in-flight snapshot can
 * never re-fill it.
 */
export function removePendingQuestionForSession(
  map: Map<string, QuestionRequest>,
  sessionId: string,
  resolvedRequestId: string,
  guard?: PendingQuestionTerminalGuard,
): Map<string, QuestionRequest> {
  guard?.markResolved(sessionId, resolvedRequestId)
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
