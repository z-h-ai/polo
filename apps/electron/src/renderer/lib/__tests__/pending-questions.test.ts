/**
 * Pending-question map semantics.
 *
 * The renderer must never delete a pending question card whose requestId
 * doesn't match the resolution being applied — otherwise a follow-up
 * question (q2) arriving while an earlier resolution (q1) is in flight gets
 * silently dropped when q1's RPC settles.
 */

import { describe, expect, it } from 'bun:test'
import {
  clearPendingQuestionForDeletedSession,
  PendingQuestionTerminalGuard,
  questionResolutionRequestId,
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

  it('a question_resolved landing mid-snapshot must NOT be resurrected by the stale snapshot (fill-hole guard)', () => {
    const guard = new PendingQuestionTerminalGuard()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'), guard)
    // A session snapshot carrying q1 is now in flight. Meanwhile the user
    // answers: the realtime resolution removes the card and marks the
    // requestId terminal.
    map = removePendingQuestionForSession(map, 's-1', 'q1', guard)
    expect(map.has('s-1')).toBe(false)

    // The STALE snapshot (still carrying q1) returns — it must not re-fill
    // the hole that the newer resolution event made.
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q1') }, guard)
    expect(map.has('s-1')).toBe(false)

    // A snapshot for a DIFFERENT, genuinely unknown session still fills.
    map = syncPendingQuestionFromSession(map, { id: 's-2', pendingQuestion: makeRequest('q9') }, guard)
    expect(map.get('s-2')?.requestId).toBe('q9')
  })

  it('a session_deleted landing mid-snapshot blocks the stale snapshot fill entirely', () => {
    const guard = new PendingQuestionTerminalGuard()
    let map = new Map<string, QuestionRequest>()
    // Snapshot in flight with q1; the session is deleted before it returns.
    map = clearPendingQuestionForDeletedSession(map, 's-1', guard)
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q1') }, guard)
    expect(map.has('s-1')).toBe(false)
  })

  it('TRUSTED REPRO: q1 snapshot in-flight → realtime q2 replaces AND resolves → the stale q1 snapshot does not resurrect q1', () => {
    const guard = new PendingQuestionTerminalGuard()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'), guard)

    // The session snapshot carrying q1 is now in flight. Meanwhile realtime
    // authority moves on TWICE: q2 replaces q1, then q2 is resolved.
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'), guard)
    map = removePendingQuestionForSession(map, 's-1', 'q2', guard)
    expect(map.has('s-1')).toBe(false)

    // The STALE q1 snapshot returns — q1 was superseded (terminal when q2
    // replaced it), so it must NOT be resurrected.
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q1') }, guard)
    expect(map.has('s-1')).toBe(false)

    // And a q2-carrier snapshot is blocked too (resolved terminal).
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q2') }, guard)
    expect(map.has('s-1')).toBe(false)
  })

  it('a resolution marks its requestId terminal EVEN when the displayed card already moved on (no removal)', () => {
    const guard = new PendingQuestionTerminalGuard()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'), guard)
    // q1 resolves while q2 holds the card — the removal is a no-op but the
    // requestId still becomes terminal.
    map = removePendingQuestionForSession(map, 's-1', 'q1', guard)
    expect(map.get('s-1')?.requestId).toBe('q2')
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q1') }, guard)
    expect(map.get('s-1')?.requestId).toBe('q2')
  })

  it('Edit-Popover RPC snapshots use the same ordering guard (fill-only, terminal-aware)', () => {
    const guard = new PendingQuestionTerminalGuard()
    let map = new Map<string, QuestionRequest>()
    // The RPC result seeds a genuinely unknown hidden session.
    const seed = (rid: string) => ({ id: 'pop-1', pendingQuestion: makeRequest(rid) })
    map = syncPendingQuestionFromSession(map, seed('q-pop'), guard)
    expect(map.get('pop-1')?.requestId).toBe('q-pop')

    // A realtime question replaced the seeded card while a SECOND RPC (still
    // carrying q-pop) was in flight — the stale RPC must not overwrite it.
    map = setPendingQuestionForSession(map, 'pop-1', makeRequest('q-pop-2'), guard)
    map = syncPendingQuestionFromSession(map, seed('q-pop'), guard)
    expect(map.get('pop-1')?.requestId).toBe('q-pop-2')

    // After the realtime q-pop-2 is resolved, a stale q-pop-2 RPC must not
    // resurrect the card either.
    map = removePendingQuestionForSession(map, 'pop-1', 'q-pop-2', guard)
    map = syncPendingQuestionFromSession(map, seed('q-pop-2'), guard)
    expect(map.has('pop-1')).toBe(false)
  })

  it('terminal markers stay bounded per session (FIFO, MAX_PER_SESSION)', () => {
    const guard = new PendingQuestionTerminalGuard()
    let map = new Map<string, QuestionRequest>()
    // Rotate more requestIds than the bound; each replaces the previous.
    for (let i = 0; i < 24; i++) {
      map = setPendingQuestionForSession(map, 's-1', makeRequest(`q-${i}`), guard)
    }
    // Old markers beyond the bound are forgotten (fill allowed again), the
    // most recent ones still block.
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q-0') }, guard)
    expect(map.get('s-1')?.requestId).toBe('q-23')
    map = removePendingQuestionForSession(map, 's-1', 'q-23', guard)
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q-23') }, guard)
    expect(map.has('s-1')).toBe(false)
  })

  it('a fresh realtime question re-opens the lifecycle for snapshot fills (per-requestId scoping)', () => {
    const guard = new PendingQuestionTerminalGuard()
    let map = new Map<string, QuestionRequest>()
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q1'), guard)
    map = removePendingQuestionForSession(map, 's-1', 'q1', guard)
    // A NEW question arrives via the realtime path — the lifecycle re-opens.
    map = setPendingQuestionForSession(map, 's-1', makeRequest('q2'), guard)
    expect(map.get('s-1')?.requestId).toBe('q2')
    // The terminal marker stays scoped to q1: a snapshot that still carries
    // q2 fills nothing (entry exists), and an unknown newer session fills.
    map = syncPendingQuestionFromSession(map, { id: 's-1', pendingQuestion: makeRequest('q1') }, guard)
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
