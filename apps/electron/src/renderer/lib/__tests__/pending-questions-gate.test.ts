import { describe, expect, it } from 'bun:test'
import type { QuestionRequest } from '../../../shared/types'

// Pure renderer lib — no DOM needed.
const { PendingQuestionGenerationTracker, gateRestoredPendingQuestion } = await import('../pending-questions')

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

describe('gateRestoredPendingQuestion (Edit Popover restore realtime CAS)', () => {
  it('a late restore result is DROPPED when a question_resolved bumped the epoch while the RPC was in flight', async () => {
    const tracker = new PendingQuestionGenerationTracker()
    let resolveRpc!: (value: RestoreResult) => void
    const rpc = new Promise<RestoreResult>(resolve => { resolveRpc = resolve })

    // Renderer starts the restore RPC: capture the epoch BEFORE it resolves.
    const epochAtFetch = tracker.epoch

    // While the RPC is in flight, another window commits the answer — the
    // realtime question_resolved event arrives here and bumps the epoch.
    tracker.bump('session-1')

    // The late RPC result finally lands.
    const lateResult: RestoreResult = { sessionId: 'session-1', request: makeRequest('session-1', 'q-1') }
    const rpcPromise = rpc.then(r => {
      void r
      return gateRestoredPendingQuestion(tracker, epochAtFetch, lateResult)
    })
    resolveRpc(lateResult)
    const gated = await rpcPromise

    // The resolved card must NOT be resurrected.
    expect(gated).toBeNull()
  })

  it('a restore result whose epoch is unchanged (fresh lookup) passes the gate', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const epochAtFetch = tracker.epoch
    const result: RestoreResult = { sessionId: 'session-1', request: makeRequest('session-1', 'q-1') }
    expect(gateRestoredPendingQuestion(tracker, epochAtFetch, result)).toEqual(result)
  })

  it('an empty restore result stays null through the gate', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const epochAtFetch = tracker.epoch
    expect(gateRestoredPendingQuestion(tracker, epochAtFetch, null)).toBeNull()
  })

  it('a new question_request from another session also drifts the epoch and drops the late restore', () => {
    const tracker = new PendingQuestionGenerationTracker()
    const epochAtFetch = tracker.epoch
    tracker.bump('session-other') // new question_request elsewhere
    const result: RestoreResult = { sessionId: 'session-1', request: makeRequest('session-1', 'q-1') }
    expect(gateRestoredPendingQuestion(tracker, epochAtFetch, result)).toBeNull()
  })
})
