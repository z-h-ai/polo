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
  it('drifted attempts within the budget return inconclusive — NOT an authoritative empty', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let fetches = 0
    const outcome = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      tracker.bump('session-noisy')
      return { sessionId: 'session-1', request: makeRequest('session-1', `q-${fetches}`) }
    })
    expect(fetches).toBe(2)
    expect(outcome).toEqual({ outcome: 'inconclusive' })
  })

  it('authoritative empty on an undrifted attempt returns empty', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let fetches = 0
    const outcome = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      return null
    })
    expect(fetches).toBe(1)
    expect(outcome).toEqual({ outcome: 'empty' })
  })
})

describe('restorePendingQuestionWithRealtimeGate transient RPC failures (round 8, issue 1)', () => {
  it('an RPC rejection is absorbed as transient and retried — never returned as an authoritative empty', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let fetches = 0
    const outcome = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      if (fetches === 1) throw new Error('IPC temporarily unavailable (injected)')
      return { sessionId: 'session-1', request: makeRequest('session-1', `q-${fetches}`) }
    })
    expect(fetches).toBe(2)
    expect(outcome.outcome === 'fresh' && outcome.result.sessionId).toBe('session-1')
  })

  it('rejections that exhaust the budget yield inconclusive — NOT an empty that would release the restore gate', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let fetches = 0
    const outcome = await restorePendingQuestionWithRealtimeGate(tracker, async () => {
      fetches++
      throw new Error('session listing failed (injected)')
    })
    expect(fetches).toBe(2) // bounded attempts
    expect(outcome).toEqual({ outcome: 'inconclusive' })
  })
})
