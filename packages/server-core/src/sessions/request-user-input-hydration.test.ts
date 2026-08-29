import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  listSessions,
  writeSessionJsonl,
  type SessionMetadata,
  type StoredSession,
} from '@polo-ai/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { buildQuestionFixtures } from './request-user-input-fixtures.ts'

// Review round 2, issue #1: restart hydration must preserve the pending
// question through the metadata path:
//   initialize → (loadSessionsFromDisk) → header → metadata → ManagedSession
//   → getSessions() carries hasPendingQuestion + requestId + full payload
//   → opening the session restores the SAME requestId (no message load needed
//     to know a question is waiting).

describe('request_user_input restart hydration', () => {
  let tmpRoot: string
  let sm: SessionManager

  const { makeQuestionRequest } = buildQuestionFixtures()

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-question-hydration-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildWorkspace() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  function seedColdSession(
    sessionId: string,
    opts: { pendingQuestion?: ReturnType<typeof makeQuestionRequest> } = {},
  ) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: `session ${sessionId}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      ...(opts.pendingQuestion ? { pendingQuestion: opts.pendingQuestion } : {}),
    } as StoredSession
    writeSessionJsonl(filePath, stored)
  }

  function loadSessionsLikeStartup(): void {
    // Mirrors loadSessionsFromDisk: metadata-only ManagedSessions from headers.
    const metas = listSessions(tmpRoot)
    for (const meta of metas) {
      const managed = createManagedSession(meta, buildWorkspace())
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(meta.id, managed)
    }
  }

  it('metadata keeps the full pendingQuestion payload from the header', () => {
    const request = makeQuestionRequest('hyd-1')
    seedColdSession('hyd-1', { pendingQuestion: request })
    seedColdSession('hyd-2')

    const metas = listSessions(tmpRoot)
    const withPending = metas.find(m => m.id === 'hyd-1') as SessionMetadata
    const withoutPending = metas.find(m => m.id === 'hyd-2') as SessionMetadata

    expect(withPending.hasPendingQuestion).toBe(true)
    expect(withPending.pendingQuestionRequestId).toBe(request.requestId)
    expect(withPending.pendingQuestion?.requestId).toBe(request.requestId)
    expect(withPending.pendingQuestion?.questions).toHaveLength(2)
    expect(withoutPending.hasPendingQuestion).toBe(false)
    expect(withoutPending.pendingQuestion).toBeUndefined()
  })

  it('initialize-style cold start → getSessions exposes badge + requestId + payload without loading messages', async () => {
    const request = makeQuestionRequest('hyd-3')
    seedColdSession('hyd-3', { pendingQuestion: request })
    seedColdSession('hyd-4')

    loadSessionsLikeStartup()

    const sessions = sm.getSessions()
    const withPending = sessions.find(s => s.id === 'hyd-3')
    const withoutPending = sessions.find(s => s.id === 'hyd-4')

    expect(withPending?.hasPendingQuestion).toBe(true)
    expect(withPending?.pendingQuestionRequestId).toBe(request.requestId)
    expect(withPending?.pendingQuestion?.requestId).toBe(request.requestId)
    expect(withPending?.pendingQuestion?.questions[0]?.id).toBe('data-handling')
    expect(withoutPending?.hasPendingQuestion).toBe(false)
  })

  it('opening the session restores the SAME requestId for the card', async () => {
    const request = makeQuestionRequest('hyd-5')
    seedColdSession('hyd-5', { pendingQuestion: request })

    loadSessionsLikeStartup()

    // Badge already correct before any message load
    expect(sm.getSessions().find(s => s.id === 'hyd-5')?.hasPendingQuestion).toBe(true)

    // "Open" the session (full load path used by getSessionMessages)
    const opened = await sm.getSession('hyd-5')
    expect(opened?.pendingQuestion?.requestId).toBe(request.requestId)

    // The renderer card would be built from this exact requestId
    expect(sm.getPendingQuestion('hyd-5')?.requestId).toBe(request.requestId)
    expect(sm.getPendingQuestion('hyd-5')?.questions.map(q => q.id)).toEqual(['data-handling', 'notify'])
  })

  it('a pending question hydrated at cold start still answers correctly (end-to-end)', async () => {
    const request = makeQuestionRequest('hyd-6')
    seedColdSession('hyd-6', { pendingQuestion: request })
    loadSessionsLikeStartup()

    let resumeCalls = 0
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {
      resumeCalls++
    }

    const result = await sm.respondToQuestion('hyd-6', {
      action: 'answer',
      response: {
        requestId: request.requestId,
        answers: [
          { questionId: 'data-handling', selectedOptionIds: ['trash'] },
          { questionId: 'notify', selectedOptionIds: ['none'] },
        ],
      },
    })

    expect(result).toEqual({ status: 'accepted' })
    expect(resumeCalls).toBe(1)
    expect(sm.getPendingQuestion('hyd-6')).toBeNull()
  })
})
