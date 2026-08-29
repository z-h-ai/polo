/**
 * Pending-question map semantics (review fix #6).
 *
 * The renderer must never delete a pending question card whose requestId
 * doesn't match the resolution being applied — otherwise a follow-up
 * question (q2) arriving while an earlier resolution (q1) is in flight gets
 * silently dropped when q1's RPC settles.
 */

import { describe, expect, it } from 'bun:test'
import {
  PendingQuestionGenerationTracker,
  applyAuthoritativePendingQuestion,
  clearPendingQuestionForDeletedSession,
  questionResolutionRequestId,
  reconcilePendingQuestionsFromSnapshot,
  removePendingQuestionForSession,
  setPendingQuestionForSession,
  syncPendingQuestionFromSession,
} from '../pending-questions'
import type { QuestionRequest, QuestionResolution } from '../../../shared/types'

function makeRequest(requestId: string): QuestionRequest {
  return {
    requestId,
    sessionId: 's-1',
    createdAt: Date.now(),
    questions: [{
      id: 'q1',
      header: 'H',
      question: 'Q?',
      options: [
        { id: 'a', label: 'A', description: 'a' },
        { id: 'b', label: 'B', description: 'b' },
      ],
    }],
  }
}

describe('pendingQuestions map helpers', () => {
  it('set replaces the previous pending question for the session', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'))

    expect(map.get('s-1')?.requestId).toBe('q2')
    expect(map.size).toBe(1)
  })

  it('remove deletes only when the current requestId matches', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))

    map = removePendingQuestionForSession(map, 's-1', 'q1')
    expect(map.has('s-1')).toBe(false)
  })

  it('remove keeps the newer card when the resolution is for an older request (q1 answered, q2 active)', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))

    // q1's RPC is in flight when the agent's follow-up q2 arrives
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'))

    // q1 settles (accepted) — must NOT delete q2
    map = removePendingQuestionForSession(map, 's-1', 'q1')
    expect(map.get('s-1')?.requestId).toBe('q2')

    // q2 settles — now the card goes
    map = removePendingQuestionForSession(map, 's-1', 'q2')
    expect(map.has('s-1')).toBe(false)
  })

  it('remove keeps the card for stale / session_missing results on a newer request', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'))

    map = removePendingQuestionForSession(map, 's-1', 'q-stale')
    expect(map.get('s-1')?.requestId).toBe('q2')
  })

  it('remove is a no-op for unknown sessions and returns the same map reference', () => {
    const map = new Map<string, QuestionRequest>()
    map.set('s-1', makeRequest('q1'))
    const same = removePendingQuestionForSession(map, 's-other', 'q1')
    expect(same).toBe(map)
  })

  it('questionResolutionRequestId extracts the id from both resolution shapes', () => {
    const answer: QuestionResolution = {
      action: 'answer',
      response: { requestId: 'q1', answers: [] },
    }
    const cancel: QuestionResolution = { action: 'cancel', requestId: 'q1' }
    expect(questionResolutionRequestId(answer)).toBe('q1')
    expect(questionResolutionRequestId(cancel)).toBe('q1')
  })
})

describe('syncPendingQuestionFromSession (restart/open hydration)', () => {
  it('fills a missing entry from the session payload (same requestId survives open)', () => {
    let map = new Map<string, QuestionRequest>()
    const payload = makeRequest('q-open')
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: payload })

    expect(map.get('s-1')?.requestId).toBe('q-open')
    // Re-syncing the same payload is a no-op
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q-open') })
    expect(map.get('s-1')?.requestId).toBe('q-open')
  })

  it('hydrates a session without an existing entry (restart → open)', () => {
    let map = new Map<string, QuestionRequest>()
    // The map may already carry the entry from getSessions startup hydration —
    // opening the same session must not duplicate or change it
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q-startup'))
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q-startup') })
    expect(map.get('s-1')?.requestId).toBe('q-startup')

    // A DIFFERENT session opened later fills only its own entry
    map = syncPendingQuestionFromSession(map, { id: 's-2', pendingQuestion: makeRequest('q-other') })
    expect(map.get('s-1')?.requestId).toBe('q-startup')
    expect(map.get('s-2')?.requestId).toBe('q-other')
  })

  it('never downgrades a fresher event-driven entry with a stale fetch', () => {
    let map = new Map<string, QuestionRequest>()
    // q2 arrived via question_request while a fetch for the session (q1 era) is in flight
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'))

    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q1') })
    expect(map.get('s-1')?.requestId).toBe('q2')
  })

  it('sessions without a pending payload leave the map untouched', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))
    map = syncPendingQuestionFromSession(map, { id: 's-2', pendingQuestion: undefined })
    expect(map.size).toBe(1)
    expect(map.get('s-1')?.requestId).toBe('q1')
  })
})

describe('clearPendingQuestionForDeletedSession (session_deleted)', () => {
  it('deleting the session with the active question clears its card unconditionally', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))
    map = clearPendingQuestionForDeletedSession(map, 's-1')
    expect(map.has('s-1')).toBe(false)
  })

  it('deleting a non-current session leaves other cards intact', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))
    map = setPendingQuestionForSession(map, 's-2', makeRequest('q2'))

    map = clearPendingQuestionForDeletedSession(map, 's-2')
    expect(map.has('s-2')).toBe(false)
    expect(map.get('s-1')?.requestId).toBe('q1')
  })

  it('repeated deletion events (multi-window fan-out) are idempotent', () => {
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))

    map = clearPendingQuestionForDeletedSession(map, 's-1')
    const same = clearPendingQuestionForDeletedSession(map, 's-1')
    expect(map.has('s-1')).toBe(false)
    expect(same).toBe(map)
  })
})

// Round 6, issue #1: full-list snapshot reconciliation must handle sessions
// that were NOT tracked at fetch start, must keep event-driven state for every
// session that changed mid-fetch (even when present in the snapshot), and a
// session deletion must invalidate in-flight snapshots.
describe('reconcilePendingQuestionsFromSnapshot (deferred getSessions races)', () => {
  function snapshotSession(id: string, requestId?: string) {
    return { id, pendingQuestion: requestId ? makeRequest(requestId) : undefined }
  }

  it('missing → q: a session that received its first event mid-fetch keeps the new card', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const tokensBefore = new Map<string, number>()
    const epochAtFetch = tracker.epoch

    let map = new Map<string, QuestionRequest>()
    // (capture — session s-1 not tracked locally yet)

    // Mid-fetch: question_request arrives for s-1
    tracker.bump('s-1')
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q-new'))

    // Snapshot (stale for s-1, but contains the session) lacks the card
    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-1')],
      tokensBefore,
      tracker,
      epochAtFetch,
    )

    // The event-driven card survives — the snapshot must not drop it
    expect(result.get('s-1')?.requestId).toBe('q-new')
  })

  it('q1 → q2: a mid-fetch replacement keeps q2 even when the snapshot still has q1', () => {
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))
    const tokensBefore = new Map<string, number>()
    tokensBefore.set('s-1', tracker.capture('s-1'))
    const epochAtFetch = tracker.epoch

    // Mid-fetch: q2 replaces q1
    tracker.bump('s-1')
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'))

    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-1', 'q1')],
      tokensBefore,
      tracker,
      epochAtFetch,
    )

    expect(result.get('s-1')?.requestId).toBe('q2')
  })

  it('pending → resolved: a mid-fetch resolution clears the card despite the stale snapshot', () => {
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))
    const tokensBefore = new Map<string, number>()
    tokensBefore.set('s-1', tracker.capture('s-1'))
    const epochAtFetch = tracker.epoch

    // Mid-fetch: question_resolved clears it
    tracker.bump('s-1')
    map = removePendingQuestionForSession(map, 's-1', 'q1')

    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-1', 'q1')],
      tokensBefore,
      tracker,
      epochAtFetch,
    )

    expect(result.has('s-1')).toBe(false)
  })

  it('delete: a mid-fetch session_deleted bumps and prevents snapshot resurrection', () => {
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'))
    const tokensBefore = new Map<string, number>()
    tokensBefore.set('s-1', tracker.capture('s-1'))
    const epochAtFetch = tracker.epoch

    // Mid-fetch: session_deleted (bump + unconditional clear)
    tracker.bump('s-1')
    map = clearPendingQuestionForDeletedSession(map, 's-1')

    // In-flight snapshot still contains the deleted session's card
    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-1', 'q1')],
      tokensBefore,
      tracker,
      epochAtFetch,
    )

    expect(result.has('s-1')).toBe(false)
  })

  it('unchanged epoch: the snapshot is wholesale-authoritative (add/replace/clear)', () => {
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-keep', makeRequest('q-old'))       // replaced by snapshot
    map = setPendingQuestionForSession(map, 's-clear', makeRequest('q-gone'))     // cleared by snapshot
    const tokensBefore = new Map<string, number>()
    for (const id of map.keys()) tokensBefore.set(id, tracker.capture(id))
    const epochAtFetch = tracker.epoch

    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [
        snapshotSession('s-keep', 'q-new'),
        snapshotSession('s-add', 'q-added'),
        snapshotSession('s-clear'),
      ],
      tokensBefore,
      tracker,
      epochAtFetch,
    )

    expect(result.get('s-keep')?.requestId).toBe('q-new')
    expect(result.get('s-add')?.requestId).toBe('q-added')
    expect(result.has('s-clear')).toBe(false)
  })

  it('drifted full scope: unrelated bump + omitted unchanged session still clears its card', () => {
    // The round-7 defect: an UNRELATED session bumping the epoch mid-fetch
    // made the drifted path keep prev wholesale — an unchanged session that
    // the authoritative snapshot omitted was never cleared.
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-omitted', makeRequest('q-old'))
    map = setPendingQuestionForSession(map, 's-other', makeRequest('q-other-old'))
    const tokensBefore = new Map<string, number>()
    for (const id of map.keys()) tokensBefore.set(id, tracker.capture(id))
    const epochAtFetch = tracker.epoch

    // Mid-fetch: an UNRELATED session receives a question (bump epoch)
    tracker.bump('s-other')
    map = setPendingQuestionForSession(map, 's-other', makeRequest('q-other-new'))

    // The authoritative snapshot OMITS s-omitted (no longer pending server-side)
    // and carries s-other's new state.
    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-other', 'q-other-new')],
      tokensBefore,
      tracker,
      epochAtFetch,
      'full',
    )

    // Unchanged + omitted → cleared by the full-scope snapshot
    expect(result.has('s-omitted')).toBe(false)
    // Changed mid-fetch → event-driven state kept
    expect(result.get('s-other')?.requestId).toBe('q-other-new')
  })

  it('drifted partial scope: omitted sessions are preserved (removeMissing=false lists)', () => {
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-omitted', makeRequest('q-old'))
    const tokensBefore = new Map<string, number>()
    tokensBefore.set('s-omitted', tracker.capture('s-omitted'))
    const epochAtFetch = tracker.epoch

    // Unrelated mid-fetch bump drifts the epoch
    tracker.bump('s-other')

    // Partial snapshot omits s-omitted — it must be preserved
    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-other', 'q-x')],
      tokensBefore,
      tracker,
      epochAtFetch,
      'partial',
    )

    expect(result.get('s-omitted')?.requestId).toBe('q-old')
  })

  it('epoch-current partial: an omitted card is preserved (removeMissing=false repro, round 8)', () => {
    // Reviewer repro (exit 42): stale reconnect with removeMissing:false
    // returns a PARTIAL list, and NO pending event raced the fetch
    // (epoch-current) — the omitted session's pending card must survive.
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-omitted', makeRequest('q-old'))
    const tokensBefore = new Map<string, number>()
    tokensBefore.set('s-omitted', tracker.capture('s-omitted'))
    const epochAtFetch = tracker.epoch

    // Partial snapshot: only s-returned; s-omitted is absent, nothing bumped
    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-returned', 'q-returned')],
      tokensBefore,
      tracker,
      epochAtFetch,
      'partial',
    )

    expect(result.get('s-omitted')?.requestId).toBe('q-old')
    expect(result.get('s-returned')?.requestId).toBe('q-returned')
  })

  it('epoch-current full: an omitted card is cleared (absence is authoritative)', () => {
    const tracker = new PendingQuestionGenerationTracker()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-omitted', makeRequest('q-old'))
    const tokensBefore = new Map<string, number>()
    tokensBefore.set('s-omitted', tracker.capture('s-omitted'))
    const epochAtFetch = tracker.epoch

    const result = reconcilePendingQuestionsFromSnapshot(
      map,
      [snapshotSession('s-returned', 'q-returned')],
      tokensBefore,
      tracker,
      epochAtFetch,
      'full',
    )

    expect(result.has('s-omitted')).toBe(false)
    expect(result.get('s-returned')?.requestId).toBe('q-returned')
  })
})
