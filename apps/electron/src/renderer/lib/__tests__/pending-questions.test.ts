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
  clearPendingQuestionForDeletedSession,
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
