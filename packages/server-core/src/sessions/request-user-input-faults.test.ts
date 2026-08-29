import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import * as serverCoreDomain from '@polo-ai/server-core/domain'

// Fault injection for releaseBrowserOwnershipOnForcedStop — must be installed
// before SessionManager is imported so the module binding picks up the mock.
let releaseShouldFail = false
const realRelease = serverCoreDomain.releaseBrowserOwnershipOnForcedStop as
  | ((...args: unknown[]) => Promise<unknown>)
  | undefined
mock.module('@polo-ai/server-core/domain', () => ({
  ...serverCoreDomain,
  releaseBrowserOwnershipOnForcedStop: async (...args: unknown[]) => {
    if (releaseShouldFail) {
      throw new Error('release failed (injected)')
    }
    if (realRelease) {
      return await realRelease(...args)
    }
    return undefined
  },
}))

const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { getSessionFilePath, writeSessionJsonl } = await import('@polo-ai/shared/sessions')
type StoredSession = import('@polo-ai/shared/sessions').StoredSession
const { buildQuestionFixtures } = await import('./request-user-input-fixtures.ts')

// Review fixes #2 and #4 (fault injection) and #5 (stop clears pending):
// - question-request flush failure must roll the replacement back and NOT
//   hand off (agent keeps running, no question_request/complete events)
// - release failure must not skip the handoff completion (complete still sent)
// - answer/cancel flush failures must leave the pending question intact so
//   the SAME resolution can be retried (transient_failure is truthful)
// - stop while a question is pending (isProcessing already false after the
//   QuestionRequested handoff) must clear + broadcast; repeated stop is a no-op

describe('request_user_input fault injection + stop lifecycle', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof import('./SessionManager').SessionManager>
  let events: Array<Record<string, unknown>>
  let flushCalls: number
  let failFlush: boolean

  const { makeQuestionRequest, makeAnswerResolution } = buildQuestionFixtures()

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-question-faults-'))
    sm = new SessionManager()
    events = []
    flushCalls = 0
    failFlush = false
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
    }) as never)
  })

  afterEach(() => {
    releaseShouldFail = false
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

  function seedSession(
    sessionId: string,
    opts: {
      pendingQuestion?: ReturnType<typeof makeQuestionRequest>
      isProcessing?: boolean
      withAgent?: boolean
      executingToolMessage?: boolean
    } = {},
  ) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    // Pending questions are persisted BEFORE they become active in production
    // (persist precedes the handoff), so seed them on disk like the real flow.
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'fault session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      ...(opts.pendingQuestion ? { pendingQuestion: opts.pendingQuestion } : {}),
    } as StoredSession
    writeSessionJsonl(filePath, stored)

    const managed = createManagedSession(
      { id: sessionId, name: stored.name, createdAt: stored.createdAt },
      buildWorkspace(),
    )
    ;(managed as unknown as { isProcessing: boolean }).isProcessing = opts.isProcessing ?? false
    if (opts.withAgent) {
      let interrupted = 0
      let aborted = 0
      ;(managed as unknown as { agent: unknown }).agent = {
        interruptForHandoff: () => { interrupted++ },
        forceAbort: () => { aborted++ },
        get interruptedCount() { return interrupted },
      }
    }
    if (opts.pendingQuestion) {
      ;(managed as unknown as { pendingQuestion: unknown }).pendingQuestion = opts.pendingQuestion
    }
    if (opts.executingToolMessage) {
      ;(managed as unknown as { messages: Array<Record<string, unknown>> }).messages.push({
        id: 'tool-1',
        role: 'tool',
        type: 'tool',
        toolName: 'mcp__session__request_user_input',
        toolStatus: 'executing',
        content: '',
        timestamp: Date.now(),
      })
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return managed
  }

  function getManaged(sessionId: string) {
    return (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as unknown as {
      pendingQuestion?: unknown
      isProcessing: boolean
      messages: Array<Record<string, unknown>>
      agent?: { interruptedCount?: number }
    }
  }

  function patchPrivateFlush() {
    // Replace the private flushSession with an instrumented version that can
    // be made to fail while preserving the real flush behavior otherwise.
    const real = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
      flushCalls++
      if (failFlush) {
        return Promise.reject(new Error('disk full (injected)'))
      }
      return real.call(sm, id)
    }
  }

  it('question-request flush failure rolls back the pending replacement and skips the handoff', async () => {
    patchPrivateFlush()
    failFlush = true
    const managed = seedSession('f-req-1', { isProcessing: true, withAgent: true, executingToolMessage: true })
    const questions = makeQuestionRequest('f-req-1').questions

    await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown) => Promise<void> })
      .handleQuestionRequested(managed, questions)

    // Rolled back: the seeded pending question (already on disk) is restored,
    // and no NEW question became active
    expect(sm.getPendingQuestion('f-req-1')).toBeNull()
    // No handoff: agent not interrupted, still processing
    expect(getManaged('f-req-1').isProcessing).toBe(true)
    expect(getManaged('f-req-1').agent?.interruptedCount ?? 0).toBe(0)
    // No renderer notifications
    expect(events.filter(e => e.type === 'question_request' || e.type === 'complete')).toEqual([])
  })

  it('browser-ownership release failure does not skip the handoff completion', async () => {
    patchPrivateFlush()
    releaseShouldFail = true
    const managed = seedSession('f-rel-1', { isProcessing: true, withAgent: true })
    const questions = makeQuestionRequest('f-rel-1').questions

    await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown) => Promise<void> })
      .handleQuestionRequested(managed, questions)

    // Pending persisted and notified BEFORE the handoff (Polo-generated id)
    const pendingAfter = sm.getPendingQuestion('f-rel-1')
    expect(pendingAfter).not.toBeNull()
    expect(pendingAfter?.sessionId).toBe('f-rel-1')
    // Handoff still completed despite the release failure
    expect(getManaged('f-rel-1').isProcessing).toBe(false)
    expect(getManaged('f-rel-1').agent?.interruptedCount ?? 0).toBe(1)

    const types = events.map(e => e.type)
    expect(types).toContain('question_request')
    expect(types).toContain('complete')
    expect(types.indexOf('question_request')).toBeLessThan(types.indexOf('complete'))
  })

  it('answer flush failure returns transient_failure, keeps the pending question, and the retry succeeds', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-ans-1')
    seedSession('f-ans-1', { pendingQuestion: request })
    const resolution = makeAnswerResolution(request)

    let resumeCount = 0
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {
      resumeCount++
    }

    failFlush = true
    const failed = await sm.respondToQuestion('f-ans-1', resolution)
    expect(failed.status).toBe('transient_failure')

    // State intact for retry: same pending question, no answer message
    expect(sm.getPendingQuestion('f-ans-1')?.requestId).toBe(request.requestId)
    expect(getManaged('f-ans-1').messages.filter(m => (m as { questionResponse?: unknown }).questionResponse)).toHaveLength(0)
    expect(resumeCount).toBe(0)

    // Retry with the fault cleared succeeds
    failFlush = false
    const retry = await sm.respondToQuestion('f-ans-1', resolution)
    expect(retry).toEqual({ status: 'accepted' })
    expect(resumeCount).toBe(1)
    expect(sm.getPendingQuestion('f-ans-1')).toBeNull()
    expect(getManaged('f-ans-1').messages.filter(m => (m as { questionResponse?: unknown }).questionResponse)).toHaveLength(1)
  })

  it('cancel flush failure returns transient_failure, keeps the pending question, and the retry succeeds', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-cxl-1')
    seedSession('f-cxl-1', { pendingQuestion: request })

    failFlush = true
    const failed = await sm.respondToQuestion('f-cxl-1', { action: 'cancel', requestId: request.requestId })
    expect(failed.status).toBe('transient_failure')
    expect(sm.getPendingQuestion('f-cxl-1')?.requestId).toBe(request.requestId)
    expect(events.filter(e => e.type === 'question_resolved')).toEqual([])

    failFlush = false
    const retry = await sm.respondToQuestion('f-cxl-1', { action: 'cancel', requestId: request.requestId })
    expect(retry).toEqual({ status: 'cancelled' })
    expect(sm.getPendingQuestion('f-cxl-1')).toBeNull()
  })

  it('stop while a question is pending clears it, notifies renderers, and persists; repeated stop is a no-op', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-stop-1')
    seedSession('f-stop-1', { pendingQuestion: request, isProcessing: false })

    // Stop after the handoff (isProcessing already false)
    await sm.cancelProcessing('f-stop-1')

    expect(sm.getPendingQuestion('f-stop-1')).toBeNull()
    const resolved = events.filter(e => e.type === 'question_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ sessionId: 'f-stop-1', requestId: request.requestId, action: 'cancel' })

    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-stop-1'), 'utf-8').split('\n')[0])
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)

    // Repeated stop: no error, no duplicate broadcast
    await sm.cancelProcessing('f-stop-1')
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(1)
  })

  it('stop with no pending question emits nothing question-related', async () => {
    patchPrivateFlush()
    seedSession('f-stop-2', { isProcessing: true, withAgent: true })

    await sm.cancelProcessing('f-stop-2')

    expect(events.filter(e => String(e.type).startsWith('question_'))).toEqual([])
  })
})
