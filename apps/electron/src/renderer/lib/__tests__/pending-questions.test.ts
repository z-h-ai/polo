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
  questionResolutionRequestId,
  removePendingQuestionForSession,
  setPendingQuestionForSession,
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
