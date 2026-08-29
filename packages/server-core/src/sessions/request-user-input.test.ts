import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  loadSession,
  writeSessionJsonl,
  type StoredSession,
} from '@polo-ai/shared/sessions'
import type { StoredMessage } from '@polo-ai/core/types'
import type { QuestionRequest, QuestionResolution } from '@polo-ai/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// request_user_input server-side contract:
// - pendingQuestion persists (authority = disk) and hydrates after restart
// - respondToQuestion honors the six-result contract (accepted / cancelled /
//   already_answered / stale / session_missing / transient_failure)
// - answers write exactly ONE readable user message with structured metadata
// - cancellation writes a readable record and never resumes the agent

function makeQuestionRequest(sessionId: string, requestId = 'q-test-1'): QuestionRequest {
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
          { id: 'trash', label: 'Move to Trash', description: 'Recoverable for 30 days', recommended: true },
          { id: 'delete', label: 'Delete permanently', description: 'Immediate, unrecoverable' },
        ],
      },
      {
        id: 'notify',
        header: 'Notifications',
        question: 'Who should be notified?',
        multiple: true,
        options: [
          { id: 'admins', label: 'Admins', description: 'Workspace admins' },
          { id: 'none', label: 'No notifications', description: 'Skip notifications', exclusive: true },
        ],
      },
    ],
  }
}

describe('request_user_input session contract', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-question-'))
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
    opts: {
      messages?: StoredMessage[]
      pendingQuestion?: QuestionRequest
    } = {},
  ) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored: StoredSession = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'question session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: opts.messages ?? [],
      ...(opts.pendingQuestion ? { pendingQuestion: opts.pendingQuestion } : {}),
    } as StoredSession
    writeSessionJsonl(filePath, stored)

    const managed = createManagedSession(
      {
        id: sessionId,
        name: stored.name,
        createdAt: stored.createdAt,
      },
      buildWorkspace(),
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
  }

  function readDiskHeader(sessionId: string): Record<string, unknown> {
    const path = getSessionFilePath(tmpRoot, sessionId)
    const firstLine = readFileSync(path, 'utf-8').split('\n')[0]
    return JSON.parse(firstLine)
  }

  function readDiskMessages(sessionId: string): Array<Record<string, unknown>> {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n').slice(1)
    return lines.map(l => JSON.parse(l))
  }

  it('getPendingQuestion hydrates the authoritative pending state from disk', async () => {
    const request = makeQuestionRequest('hydrate-1')
    seedColdSession('hydrate-1', { pendingQuestion: request })

    expect(sm.getPendingQuestion('hydrate-1')).toBeNull()

    // Loading messages restores pendingQuestion (lazy-load path on open)
    await (sm as unknown as { ensureMessagesLoaded(m: unknown): Promise<void> })
      .ensureMessagesLoaded((sm as unknown as { sessions: Map<string, unknown> }).sessions.get('hydrate-1'))

    const restored = sm.getPendingQuestion('hydrate-1')
    expect(restored?.requestId).toBe(request.requestId)
    expect(restored?.questions).toHaveLength(2)
  })

  it('prunes a pending question on hydration when a resolution record already exists on disk', async () => {
    const request = makeQuestionRequest('prune-1')
    seedColdSession('prune-1', {
      pendingQuestion: request,
      messages: [
        { id: 'm-answer', type: 'user', content: 'Answer', timestamp: Date.now(), questionResponse: { requestId: request.requestId, answers: [] } },
      ],
    })

    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get('prune-1')
    await (sm as unknown as { ensureMessagesLoaded(m: unknown): Promise<void> }).ensureMessagesLoaded(managed)

    expect(sm.getPendingQuestion('prune-1')).toBeNull()
  })

  it('returns session_missing for unknown sessions', async () => {
    const result = await sm.respondToQuestion('ghost', { action: 'cancel', requestId: 'q-x' })
    expect(result).toEqual({ status: 'session_missing' })
  })

  it('returns stale for a requestId that is not the active pending question', async () => {
    const request = makeQuestionRequest('stale-1')
    seedColdSession('stale-1', { pendingQuestion: request })

    const result = await sm.respondToQuestion('stale-1', { action: 'cancel', requestId: 'q-replaced' })
    expect(result).toEqual({ status: 'stale' })

    // Pending question survives a stale resolution attempt
    expect(sm.getPendingQuestion('stale-1')?.requestId).toBe(request.requestId)
  })

  it('returns already_answered for a request with a persisted resolution record', async () => {
    const request = makeQuestionRequest('dup-1')
    seedColdSession('dup-1', {
      messages: [
        { id: 'm-cancel', type: 'user', content: 'Skipped', timestamp: Date.now(), questionResolution: { action: 'cancel', requestId: request.requestId } },
      ],
    })

    const result = await sm.respondToQuestion('dup-1', { action: 'cancel', requestId: request.requestId })
    expect(result).toEqual({ status: 'already_answered' })
  })

  it('cancellation writes a readable record, clears pending, persists, and never resumes the agent', async () => {
    const request = makeQuestionRequest('cancel-1')
    seedColdSession('cancel-1', { pendingQuestion: request })

    let sendMessageCalled = 0
    ;(sm as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {
      sendMessageCalled++
    }

    const result = await sm.respondToQuestion('cancel-1', { action: 'cancel', requestId: request.requestId })
    expect(result).toEqual({ status: 'cancelled' })
    expect(sendMessageCalled).toBe(0)

    expect(sm.getPendingQuestion('cancel-1')).toBeNull()

    // Disk: pending cleared + cancel record persisted with structured metadata
    const header = readDiskHeader('cancel-1')
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)

    const messages = readDiskMessages('cancel-1')
    const cancelMsg = messages.find(m => m.questionResolution)
    expect(cancelMsg).toBeDefined()
    expect((cancelMsg!.questionResolution as Record<string, unknown>).requestId).toBe(request.requestId)
    expect(String(cancelMsg!.content).length).toBeGreaterThan(0)
  })

  it('accepted answers write one readable message, clear pending, and resume the agent with that same message', async () => {
    const request = makeQuestionRequest('accept-1')
    seedColdSession('accept-1', { pendingQuestion: request })

    const resumeCalls: Array<{ message: string; existingMessageId?: string }> = []
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage =
      async (...args: unknown[]) => {
        resumeCalls.push({
          message: args[1] as string,
          existingMessageId: args[5] as string | undefined,
        })
      }

    const resolution: QuestionResolution = {
      action: 'answer',
      response: {
        requestId: request.requestId,
        answers: [
          { questionId: 'data-handling', selectedOptionIds: ['delete'] },
          { questionId: 'notify', selectedOptionIds: ['admins'], otherText: '  audit@example.com  ' },
        ],
      },
    }

    const result = await sm.respondToQuestion('accept-1', resolution)
    expect(result).toEqual({ status: 'accepted' })

    // Agent resumed exactly once, with the persisted answer message id
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.existingMessageId).toBeTruthy()

    expect(sm.getPendingQuestion('accept-1')).toBeNull()

    // Disk: exactly ONE user message carrying the structured answers
    const messages = readDiskMessages('accept-1')
    const answerMessages = messages.filter(m => m.questionResponse)
    expect(answerMessages).toHaveLength(1)
    const meta = (answerMessages[0]!.questionResponse as Record<string, unknown>)
    expect(meta.requestId).toBe(request.requestId)
    expect(String(answerMessages[0]!.content)).toContain('Delete permanently')
    expect(String(answerMessages[0]!.content)).toContain('audit@example.com')

    // Header badge cleared
    const header = readDiskHeader('accept-1')
    expect(header.hasPendingQuestion).toBe(false)
    expect(header.pendingQuestionRequestId).toBeUndefined()

    // Repeated resolution of the same request is idempotent
    const replay = await sm.respondToQuestion('accept-1', resolution)
    expect(replay).toEqual({ status: 'already_answered' })
  })

  it('returns transient_failure for structurally invalid answers without mutating state', async () => {
    const request = makeQuestionRequest('invalid-1')
    seedColdSession('invalid-1', { pendingQuestion: request })

    let sendMessageCalled = 0
    ;(sm as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {
      sendMessageCalled++
    }

    const result = await sm.respondToQuestion('accept-1-invalid', {
      action: 'answer',
      response: { requestId: 'q-test-1', answers: [] },
    })
    expect(result).toEqual({ status: 'session_missing' })

    const bad = await sm.respondToQuestion('invalid-1', {
      action: 'answer',
      response: {
        requestId: request.requestId,
        answers: [
          { questionId: 'data-handling', selectedOptionIds: ['no-such-option'] },
          { questionId: 'notify', selectedOptionIds: ['admins'] },
        ],
      },
    })
    expect(bad.status).toBe('transient_failure')
    expect(sendMessageCalled).toBe(0)

    // Pending question intact for a retry
    expect(sm.getPendingQuestion('invalid-1')?.requestId).toBe(request.requestId)
  })

  it('round-trips pendingQuestion through the production loader (writeSessionJsonl/loadSession)', () => {
    const sessionId = 'roundtrip-1'
    const request = makeQuestionRequest(sessionId)
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      pendingQuestion: request,
    } as StoredSession
    writeSessionJsonl(filePath, stored)

    const header = readDiskHeader(sessionId)
    expect(header.hasPendingQuestion).toBe(true)
    expect(header.pendingQuestionRequestId).toBe(request.requestId)

    const reloaded = loadSession(tmpRoot, sessionId)
    expect(reloaded?.pendingQuestion?.requestId).toBe(request.requestId)
    expect(reloaded?.pendingQuestion?.questions[0]?.id).toBe('data-handling')
  })
})
