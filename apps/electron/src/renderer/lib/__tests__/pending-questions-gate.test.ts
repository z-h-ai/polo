import { describe, expect, it } from 'bun:test'
import type { QuestionRequest } from '../../../shared/types'

// Pure renderer lib — no DOM needed.
const { PendingQuestionGenerationTracker, gateRestoredPendingQuestion, restorePendingQuestionWithRealtimeGate } = await import('../pending-questions')

type RestoreResult = { sessionId: string; request: QuestionRequest } | null

function makeRequest(sessionId: string, requestId: string): QuestionRequest {
  return {
    requestId,
    sessionId,
    createdAt: Date.now(),
    questions: [
      {
        id: 'data-handling',
        header: 'Data',
        question: 'What should happen to related data?',
        options: [
          { id: 'trash', label: 'Move to Trash', description: 'Recoverable' },
          { id: 'delete', label: 'Delete permanently', description: 'Gone' },
        ],
      },
    ],
  }
}

describe('gateRestoredPendingQuestion (discriminated outcomes)', () => {
  it('fresh: epoch unchanged with a result', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const epochAtFetch = tracker.epoch
    const result = { sessionId: 'session-1', request: makeRequest('session-1', 'q-1') }
    expect(gateRestoredPendingQuestion(tracker, epochAtFetch, result)).toEqual({ outcome: 'fresh', result })
  })

  it('drifted: a result whose epoch moved is flagged, never seeded directly', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const epochAtFetch = tracker.epoch
    tracker.bump('session-other') // question_resolved / new request elsewhere
    const result = { sessionId: 'session-1', request: makeRequest('session-1', 'q-1') }
    expect(gateRestoredPendingQuestion(tracker, epochAtFetch, result)).toEqual({ outcome: 'drifted' })
  })

  it('empty: undrifted authoritative null', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const epochAtFetch = tracker.epoch
    expect(gateRestoredPendingQuestion(tracker, epochAtFetch, null)).toEqual({ outcome: 'empty' })
  })

  it('drifted: even a null result is not authoritative when the epoch moved', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const epochAtFetch = tracker.epoch
    tracker.bump('session-other')
    expect(gateRestoredPendingQuestion(tracker, epochAtFetch, null)).toEqual({ outcome: 'drifted' })
  })
})

describe('restorePendingQuestionWithRealtimeGate (bounded drift revalidation)', () => {
  it('unrelated session\u2019s new question_request drifts the epoch — the restore RE-QUERIES and recovers the original pending instead of terminating', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    const request = makeRequest('session-1', 'q-1')
    let fetches = 0
    const restored = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      if (fetches === 1) {
        // While the first lookup is in flight, an UNRELATED session receives
        // a brand-new question_request — the global epoch drifts.
        tracker.bump('session-unrelated')
        return { sessionId: 'session-1', request } // the server answer for OUR scope is still valid…
      }
      // Bounded re-query: quiet window, the same authoritative pending.
      return { sessionId: 'session-1', request }
    })
    expect(fetches).toBe(2)
    expect(restored).toEqual({ sessionId: 'session-1', request })
  })

  it('own session resolved during the request: the re-query yields an authoritative empty — the resolved card is NOT resurrected', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    const request = makeRequest('session-1', 'q-1')
    let fetches = 0
    const restored = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      if (fetches === 1) {
        // Another window committed the answer while this lookup was in
        // flight — question_resolved bumps the epoch…
        tracker.bump('session-1')
        return { sessionId: 'session-1', request } // …and the stale snapshot still carries Q1.
      }
      // Re-query: the server authoritatively has NO pending question now.
      return null
    })
    expect(fetches).toBe(2)
    expect(restored).toBeNull()
  })

  it('persistent drift gives up after the bounded attempt budget (no unbounded loop)', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let fetches = 0
    const restored = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      tracker.bump('session-noisy')
      return { sessionId: 'session-1', request: makeRequest('session-1', `q-${fetches}`) }
    }, 2)
    expect(fetches).toBe(2)
    expect(restored).toBeNull()
  })

  it('authoritative empty on the first (undrifted) attempt ends the restore immediately', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let fetches = 0
    const restored = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      return null
    })
    expect(fetches).toBe(1)
    expect(restored).toBeNull()
  })
})
