import { describe, expect, it } from 'bun:test'
import type { QuestionRequest } from '../../../shared/types'

// Pure renderer lib — no DOM needed.
const { PendingQuestionGenerationTracker, gateRestoredPendingQuestion, restorePendingQuestionWithRealtimeGate, restorePendingQuestionUntilAuthoritative } = await import('../pending-questions')

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

describe('restorePendingQuestionUntilAuthoritative (round 7, issue 1)', () => {
  it('persistent drift NEVER reports authoritative empty — it keeps blocking fresh-session creation', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let fetches = 0
    const outcome = await restorePendingQuestionUntilAuthoritative(tracker, async () => {
      fetches++
      tracker.bump('session-noisy')
      return { sessionId: 'session-1', request: makeRequest('session-1', `q-${fetches}`) }
    }, { backoffMs: () => 0, maxRounds: 3 })
    // Budget exhaustion is an explicit inconclusive — the caller keeps the
    // restore gate engaged; it is NOT the authoritative empty that would
    // allow orphaning the pending question behind a new session.
    expect(outcome).toEqual({ outcome: 'inconclusive' })
    expect(fetches).toBe(6) // 2 attempts per round × 3 rounds
  })

  it('two drifted rounds then a quiet window: the restore recovers the original pending (no orphan, no premature new session)', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    const request = makeRequest('session-1', 'q-1')
    let fetches = 0
    const outcome = await restorePendingQuestionUntilAuthoritative(tracker, async () => {
      fetches++
      if (fetches <= 4) {
        // Rounds 1–2 (2 attempts each): unrelated sessions keep bumping the
        // epoch — neither result may be seeded.
        tracker.bump('session-noisy')
        return { sessionId: 'session-1', request }
      }
      // Round 3: quiet window — the scoped query is authoritative.
      return { sessionId: 'session-1', request }
    }, { backoffMs: () => 0 })
    expect(fetches).toBe(5)
    expect(outcome).toEqual({ outcome: 'fresh', result: { sessionId: 'session-1', request } })
  })

  it('own session resolved during the request: the re-query yields an authoritative empty — the resolved card is NOT resurrected', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    const request = makeRequest('session-1', 'q-1')
    let fetches = 0
    const outcome = await restorePendingQuestionUntilAuthoritative(tracker, async () => {
      fetches++
      if (fetches === 1) {
        // Another window committed the answer while this lookup was in
        // flight — question_resolved bumps the epoch…
        tracker.bump('session-1')
        return { sessionId: 'session-1', request } // …stale snapshot carries Q1.
      }
      // Re-query: the server authoritatively has NO pending question now.
      return null
    }, { backoffMs: () => 0 })
    expect(fetches).toBe(2)
    expect(outcome).toEqual({ outcome: 'empty' })
  })
})
