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
const { getSessionFilePath, loadSession, writeSessionJsonl } = await import('@polo-ai/shared/sessions')
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

  afterEach(async () => {
    releaseShouldFail = false
    // Drop sessions from previous sm instances: their orphaned retry timers
    // survive the test (plain bun test shares one process) and the identity
    // guard passes while the old map still holds the session — clearing the
    // map makes those guards silently drop cross-test ghost firings.
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.clear()
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
      messages?: Array<Record<string, unknown>>
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
      messages: (opts.messages ?? []) as unknown as StoredSession['messages'],
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

  function makeToolContext(onQuestionRequested: (questions: unknown[]) => Promise<void>) {
    return {
      sessionId: 'ctx',
      workspacePath: tmpRoot,
      get sourcesPath() { return join(tmpRoot, 'sources'); },
      get skillsPath() { return join(tmpRoot, 'skills'); },
      plansFolderPath: join(tmpRoot, 'plans'),
      fs: {
        exists: () => false,
        readFile: () => '',
        readFileBuffer: () => Buffer.alloc(0),
        writeFile: () => {},
        isDirectory: () => false,
        readdir: () => [],
        stat: () => ({ size: 0, isDirectory: () => false }),
      },
      loadSourceConfig: () => null,
      callbacks: {
        onPlanSubmitted: () => {},
        onAuthRequest: () => {},
        onQuestionRequested,
      },
    }
  }

  it('question-request flush failure rolls back the pending replacement and REJECTS (no handoff, no fake success)', async () => {
    patchPrivateFlush()
    failFlush = true
    const managed = seedSession('f-req-1', { isProcessing: true, withAgent: true, executingToolMessage: true })
    const questions = makeQuestionRequest('f-req-1').questions

    // The callback promise must REJECT on durable-persist failure — the tool
    // handler converts this into an isError result instead of "Waiting".
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown) => Promise<void> })
      .handleQuestionRequested(managed, questions)).rejects.toThrow(/NOT paused/)

    // Rolled back: the seeded pending question (already on disk) is restored,
    // and no NEW question became active
    expect(sm.getPendingQuestion('f-req-1')).toBeNull()
    // No handoff: agent not interrupted, still processing
    expect(getManaged('f-req-1').isProcessing).toBe(true)
    expect(getManaged('f-req-1').agent?.interruptedCount ?? 0).toBe(0)
    // No renderer notifications
    expect(events.filter(e => e.type === 'question_request' || e.type === 'complete')).toEqual([])
  })

  it('real handler entry: flush failure surfaces as a tool error (isError), not a waiting success', async () => {
    patchPrivateFlush()
    failFlush = true
    const managed = seedSession('f-handler-1', { isProcessing: true, withAgent: true })
    const request = makeQuestionRequest('f-handler-1')
    const questions = request.questions

    // Wire the REAL session-tools-core handler through the same callback
    // shape production uses (agent callback → SessionManager handoff).
    const { handleRequestUserInput } = await import('@polo-ai/session-tools-core')
    const ctx = makeToolContext((qs: unknown[]) =>
      (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown[]) => Promise<void> })
        .handleQuestionRequested(managed, qs),
    )

    const result = await handleRequestUserInput(ctx, { questions })

    expect(result.isError).toBe(true)
    expect(String((result.content[0] as { text?: string })?.text)).toContain('NOT paused')
    // No fake success state anywhere: no renderer event, no handoff
    expect(events.filter(e => e.type === 'question_request' || e.type === 'complete')).toEqual([])
    expect(getManaged('f-handler-1').isProcessing).toBe(true)
  })

  it('real handler entry: delayed callback blocks the tool result until the handoff completes', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-handler-2', { isProcessing: true, withAgent: true })
    const request = makeQuestionRequest('f-handler-2')
    const questions = request.questions

    const { handleRequestUserInput } = await import('@polo-ai/session-tools-core')

    let releaseCallback: (() => void) | null = null
    const gate = new Promise<void>(resolve => { releaseCallback = resolve })
    let handoffDone = false
    const ctx = makeToolContext(async (qs: unknown[]) => {
      await gate
      await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown[]) => Promise<void> })
        .handleQuestionRequested(managed, qs)
      handoffDone = true
    })

    const handlerPromise = handleRequestUserInput(ctx, { questions })
    let settled = false
    void handlerPromise.then(() => { settled = true })
    await new Promise(r => setTimeout(r, 50))
    // The tool must still be blocked while the durable handoff is in flight
    expect(settled).toBe(false)
    expect(handoffDone).toBe(false)

    releaseCallback!()
    const result = await handlerPromise
    expect(handoffDone).toBe(true)
    expect(result.isError).toBeFalsy()
    expect(String((result.content[0] as { text?: string })?.text)).toContain('Waiting for user input')
    expect(sm.getPendingQuestion('f-handler-2')).not.toBeNull()
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

  it('answer committed but sendMessage rejects before agent init: error surfaced, state recoverable, retry succeeds (never silent-accepted-stranded)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-resume-1')
    seedSession('f-resume-1', { pendingQuestion: request })

    // The first resume attempt fails pre-chat (backend init / credential
    // refresh / source build); the retry succeeds.
    let sendMessageCalls = 0
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => {
      sendMessageCalls++
      if (sendMessageCalls === 1) {
        throw new Error('backend init failed (injected)')
      }
      void args
    }

    const result = await sm.respondToQuestion('f-resume-1', makeAnswerResolution(request))

    // The resolution itself is committed — RPC returns accepted
    expect(result).toEqual({ status: 'accepted' })
    // NOT silent: a user-visible error event was emitted for the failed resume
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    expect(String((errorEvents[0] as { error?: string }).error)).toContain('could not resume')

    // The recovery state is armed and persisted (survives restarts)
    const managed = getManaged('f-resume-1')
    const resumeState = (managed as unknown as { pendingAgentResume?: { messageId: string; attempts: number } }).pendingAgentResume
    expect(resumeState).toBeDefined()
    expect(resumeState?.attempts).toBe(1)
    expect(resumeState?.messageId).toBeTruthy()

    // The stable recovery path retries automatically (backoff 1s for attempt 1)
    await new Promise(r => setTimeout(r, 1600))
    expect(sendMessageCalls).toBeGreaterThanOrEqual(2)
    expect((getManaged('f-resume-1') as unknown as { pendingAgentResume?: unknown }).pendingAgentResume).toBeUndefined()
  })

  it('a new user message supersedes a pending answer→resume (no duplicate turn on retry)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-resume-2')
    seedSession('f-resume-2', { pendingQuestion: request })

    // First call = the failed resume; later calls = user messages, which run
    // the production supersede guard (a message that is NOT the resume's
    // answer message clears the recovery state).
    let sendMessageCalls = 0
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => {
      sendMessageCalls++
      const managed = getManaged('f-resume-2') as unknown as { pendingAgentResume?: { messageId: string } }
      if (sendMessageCalls === 1) {
        throw new Error('backend init failed (injected)')
      }
      const existingMessageId = args[5] as string | undefined
      if (managed.pendingAgentResume && managed.pendingAgentResume.messageId !== existingMessageId) {
        managed.pendingAgentResume = undefined
      }
    }
    void sm.respondToQuestion('f-resume-2', makeAnswerResolution(request))
    await new Promise(r => setTimeout(r, 30))
    // Recovery state armed after the failed first resume
    expect((getManaged('f-resume-2') as unknown as { pendingAgentResume?: unknown }).pendingAgentResume).toBeDefined()

    // A user's new message (existingMessageId undefined ≠ resume messageId)
    // supersedes the recovery state.
    await sm.sendMessage('f-resume-2', 'a new user message')
    expect((getManaged('f-resume-2') as unknown as { pendingAgentResume?: unknown }).pendingAgentResume).toBeUndefined()
  })

  it('stop clears an armed answer→resume retry (user stop means no new turns)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-resume-3')
    const managed = seedSession('f-resume-3', { pendingQuestion: request, isProcessing: false, withAgent: true })

    // Arm the recovery state, then stop
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: 'm-1', attempts: 2 }

    await sm.cancelProcessing('f-resume-3')

    expect((getManaged('f-resume-3') as unknown as { pendingAgentResume?: unknown }).pendingAgentResume).toBeUndefined()
  })

  // Round 6, issues #2/#3: the resume path must drive the REAL sendMessage
  // (mocking getOrCreateAgent, not sendMessage) so pre-chat failures exercise
  // the processing-reset boundary, the retry drives the real entry again
  // without duplicating the user message, and the retry timer is owned by the
  // session lifecycle (cancelled on delete/stop, no ghost turns).

  function makeFakeAgent(): Record<string, unknown> {
    return {
      allowRequestUserInput: false,
      chat: async function* () { yield { type: 'complete' as const } },
      getModel: () => 'fake-model',
      getSessionId: () => null,
      isProcessing: () => false,
      supportsBranching: true,
      setAllSources: () => {},
      setSourceServers: async () => {},
      getSummarizeCallback: () => undefined,
      dispose: () => {},
      interruptForHandoff: () => {},
      forceAbort: () => {},
      respondToPermission: () => {},
    }
  }

  it('getOrCreateAgent failure resets processing (not stuck) and the retry drives the real entry again without duplicating the answer', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-real-1')
    seedSession('f-real-1', { pendingQuestion: request })

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      agentInitCalls++
      throw new Error(`agent init failed #${agentInitCalls}`)
    }

    const result = await sm.respondToQuestion('f-real-1', makeAnswerResolution(request))
    expect(result).toEqual({ status: 'accepted' })

    // Issue #2 core assertion: the pre-chat failure reset processing —
    // the session is NOT stuck at isProcessing=true.
    expect((getManaged('f-real-1') as unknown as { isProcessing: boolean }).isProcessing).toBe(false)
    // User-visible failure event emitted
    expect(events.filter(e => e.type === 'error').length).toBeGreaterThanOrEqual(1)
    // Exactly one answer message — the retry must not add another user turn
    const answerMessages = () => (getManaged('f-real-1').messages as Array<Record<string, unknown>>)
      .filter(m => (m as { questionResponse?: unknown }).questionResponse)
    expect(answerMessages()).toHaveLength(1)

    // Retry (backoff 1s) drives the REAL entry (getOrCreateAgent called again)
    await new Promise(r => setTimeout(r, 1300))
    expect(agentInitCalls).toBeGreaterThanOrEqual(2)
    expect((getManaged('f-real-1') as unknown as { isProcessing: boolean }).isProcessing).toBe(false)
    // Still exactly one answer message
    expect(answerMessages()).toHaveLength(1)
  })

  it('fail → delete: the retry timer never fires for a deleted session (no events, no ghost turns)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-real-del')
    seedSession('f-real-del', { pendingQuestion: request })

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      agentInitCalls++
      throw new Error(`agent init failed #${agentInitCalls}`)
    }

    await sm.respondToQuestion('f-real-del', makeAnswerResolution(request))
    const errorEventsBefore = events.filter(e => e.type === 'error').length
    expect(agentInitCalls).toBe(1)

    // Delete the session while the retry timer is pending
    await sm.deleteSession('f-real-del')
    const errorEventsAfterDelete = events.filter(e => e.type === 'error').length

    // Advance past the scheduled retry — nothing may fire for the deleted session
    await new Promise(r => setTimeout(r, 2000))
    expect(agentInitCalls).toBe(1)
    expect(events.filter(e => e.type === 'error').length).toBe(errorEventsAfterDelete)
    void errorEventsBefore
  })

  it('stop → the armed retry is cancelled and never restarts (immediate, awaited flush)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-real-stop')
    seedSession('f-real-stop', { pendingQuestion: request })

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      agentInitCalls++
      throw new Error(`agent init failed #${agentInitCalls}`)
    }

    await sm.respondToQuestion('f-real-stop', makeAnswerResolution(request))
    expect(agentInitCalls).toBe(1)

    // Stop: clears the armed retry with an awaited flush
    await sm.cancelProcessing('f-real-stop')

    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-real-stop'), 'utf-8').split('\n')[0])
    expect(header.pendingAgentResume).toBeUndefined()

    // Advance past the (cancelled) retry schedule — no new agent init calls
    await new Promise(r => setTimeout(r, 2000))
    expect(agentInitCalls).toBe(1)
  })

  it('resume success → awaited flush clears disk state; no restart after completion', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-real-ok')
    seedSession('f-real-ok', { pendingQuestion: request })

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      agentInitCalls++
      if (agentInitCalls === 1) {
        throw new Error(`agent init failed #${agentInitCalls}`)
      }
      return makeFakeAgent()
    }

    const result = await sm.respondToQuestion('f-real-ok', makeAnswerResolution(request))
    expect(result).toEqual({ status: 'accepted' })

    // Retry succeeded through the real entry
    await waitForCondition(() => agentInitCalls >= 2)
    await waitForCondition(() =>
      (getManaged('f-real-ok') as unknown as { pendingAgentResume?: unknown }).pendingAgentResume === undefined
    )

    // Awaited flush: the disk header no longer carries the recovery state —
    // a crash cannot re-arm the finished recovery.
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-real-ok'), 'utf-8').split('\n')[0])
    expect(header.pendingAgentResume).toBeUndefined()

    const callsAfterSuccess = agentInitCalls
    await new Promise(r => setTimeout(r, 1500))
    expect(agentInitCalls).toBe(callsAfterSuccess)
  })

  // Round 8, issue #2: while an OLD answer turn is awaiting its chat, a new
  // user message supersedes it and ANOTHER answer arms a NEW resume — the old
  // caller's durable clear (boundary 2) must not wipe the new recovery state.
  it('old resume superseded mid-await: durable clear skips and the new resume survives', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-supersede')
    const managed = seedSession('f-supersede', {
      pendingQuestion: request,
      messages: [
        { id: 'msg-old-answer', type: 'user', role: 'user', content: 'old answer', timestamp: Date.now() },
        { id: 'msg-new-answer', type: 'user', role: 'user', content: 'new answer', timestamp: Date.now() },
      ],
    })

    // Two answer messages in history (old answer M1, new answer M2)
    const M1 = 'msg-old-answer'
    const M2 = 'msg-new-answer'
    ;(managed as unknown as { messages: Array<Record<string, unknown>> }).messages.push(
      { id: M1, type: 'user', role: 'user', content: 'old answer', timestamp: Date.now() },
      { id: M2, type: 'user', role: 'user', content: 'new answer', timestamp: Date.now() },
    )

    // Fake agent whose chat blocks until the gate releases — the old turn is
    // genuinely in flight while we supersede it.
    let releaseOldTurn: (() => void) | null = null
    const oldTurnGate = new Promise<void>(resolve => { releaseOldTurn = resolve })
    let chatInvocations = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      const chatInvocationsForThisAgent = ++chatInvocations
      return {
        allowRequestUserInput: false,
        getModel: () => 'fake-model',
        getSessionId: () => null,
        isProcessing: () => false,
        supportsBranching: true,
        setAllSources: () => {},
        setSourceServers: async () => {},
        getSummarizeCallback: () => undefined,
        dispose: () => {},
        chat: async function* (this: unknown, _message?: unknown) {
          if (chatInvocationsForThisAgent === 1) {
            await oldTurnGate
          }
          yield { type: 'complete' as const }
        },
      }
    }

    // Arm the OLD resume and start its turn (not awaited)
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: M1, attempts: 0 }
    const oldTurn = (sm as unknown as { resumePendingAgentTurn: (m: unknown) => Promise<void> })
      .resumePendingAgentTurn(managed)

    // Wait until the old turn is genuinely inside its gated chat
    await new Promise(r => setTimeout(r, 100))
    expect(chatInvocations).toBe(1)

    // Mid-await: a new user message supersedes (production clears), then
    // another answer arms a NEW recovery state with a NEW messageId.
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = undefined
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: M2, attempts: 0 }

    // Release the old turn — it completes, and boundary 2 must exit silently.
    releaseOldTurn!()
    await oldTurn

    // The NEW recovery state survived (old caller did not clear it)
    const stateAfter = (getManaged('f-supersede') as unknown as { pendingAgentResume?: { messageId: string } }).pendingAgentResume
    expect(stateAfter?.messageId).toBe(M2)

    // The new resume still works end-to-end: run it, turn executes, state clears.
    await (sm as unknown as { resumePendingAgentTurn: (m: unknown) => Promise<void> }).resumePendingAgentTurn(managed)
    expect(chatInvocations).toBe(2)
    expect((getManaged('f-supersede') as unknown as { pendingAgentResume?: unknown }).pendingAgentResume).toBeUndefined()
  })

  async function waitForCondition(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('waitForCondition timed out')
  }

  // Round 7, issue #2: deleteSession must disarm the retry timer BEFORE the
  // abort wait / share-revoke window — a live timer during that window can
  // start a ghost turn (identity guard still holds until removal).
  it('armed retry + delayed shared revoke + delete: no ghost turns during the deletion window', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-del-window')
    const managed = seedSession('f-del-window', { pendingQuestion: request })
    // Shared session → deleteSession awaits the (stubbed, slow) revoke
    ;(managed as unknown as { sharedId?: string; sharedUrl?: string }).sharedId = 'share-123'
    ;(managed as unknown as { sharedUrl?: string }).sharedUrl = 'https://viewer.example.com/s/share-123'

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      agentInitCalls++
      throw new Error(`agent init failed #${agentInitCalls}`)
    }

    await sm.respondToQuestion('f-del-window', makeAnswerResolution(request))
    expect(agentInitCalls).toBe(1)

    // Slow external I/O: the share revoke stalls for 1400ms inside
    // deleteSession — the delete promise stays unresolved PAST the 1000ms
    // retry expiry, so this test genuinely crosses the window in which the
    // round-7 defect (timer not disarmed until after the revoke) would fire
    // a ghost turn.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      await new Promise(r => setTimeout(r, 1400))
      throw new Error('revoke stalled (injected)')
    }) as unknown as typeof fetch

    try {
      // Start deletion WITHOUT awaiting — the revoke window is in flight.
      const deletePromise = sm.deleteSession('f-del-window')

      // Cross the 1000ms retry expiry while deletion is still pending.
      await new Promise(r => setTimeout(r, 1200))
      const errorEventsMidWindow = events.filter(e => e.type === 'error').length
      expect(agentInitCalls).toBe(1)
      expect(errorEventsMidWindow).toBe(1)

      // Deletion completes; nothing fired for the deleted session afterwards.
      await deletePromise
      await new Promise(r => setTimeout(r, 1500))
      expect(agentInitCalls).toBe(1)
      expect(events.filter(e => e.type === 'error').length).toBe(errorEventsMidWindow)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  // Round 7, issue #3: a failed durable clear AFTER a fully executed turn is
  // NOT a resume failure — no fake "could not resume", no turn re-execution;
  // the terminal marker keeps a restart from re-running the answer.
  it('success → clear flush failure: turn executes once, no fake resume error, terminal marker persists, restart does not re-run', async () => {
    // Fail exactly the SECOND flush call (the first is the answer commit,
    // the second is the post-success durable clear).
    patchPrivateFlush()
    const request = makeQuestionRequest('f-clear-flush')
    seedSession('f-clear-flush', { pendingQuestion: request })
    let flushFailAtCall = 2

    let flushCalls = 0
    const real = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
      flushCalls++
      if (flushCalls === flushFailAtCall) {
        return Promise.reject(new Error('clear flush failed (injected)'))
      }
      return real.call(sm, id)
    }

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      agentInitCalls++
      return makeFakeAgent()
    }

    const result = await sm.respondToQuestion('f-clear-flush', makeAnswerResolution(request))
    expect(result).toEqual({ status: 'accepted' })

    // NO fake resume-failure error event (the turn fully executed)
    expect(events.filter(e => e.type === 'error').length).toBe(0)
    // The agent turn ran exactly once
    expect(agentInitCalls).toBe(1)

    // The terminal marker (completed) was persisted by the internal retry
    await waitForCondition(() => {
      const diskState = loadSession(tmpRoot, 'f-clear-flush')
      return diskState?.pendingAgentResume?.completed === true
    })
    // In-memory: the record remains as a TERMINAL marker (never re-executed)
    const memoryState = (getManaged('f-clear-flush') as unknown as { pendingAgentResume?: { completed?: boolean } }).pendingAgentResume
    expect(memoryState?.completed).toBe(true)

    // No retry scheduled — the turn never re-executes
    const callsAfterClear = agentInitCalls
    await new Promise(r => setTimeout(r, 1500))
    expect(agentInitCalls).toBe(callsAfterClear)

    // Restart simulation: a fresh SessionManager hydrates the TERMINAL marker
    // and clears it WITHOUT re-executing the answer turn.
    //
    // IMPORTANT (round 8, issue #3): sm2 keeps the REAL sendMessage — wrapped
    // in a counting delegate that calls through to the original. A total stub
    // would silently swallow a wrongful resume and let the test pass.
    flushFailAtCall = 0
    const sm2 = new SessionManager()
    let sm2AgentInits = 0
    ;(sm2 as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      sm2AgentInits++
      const agent = makeFakeAgent()
      return {
        ...agent,
        chat: async function* (this: unknown) {
          sm2ChatInvocations++
          yield { type: 'complete' as const }
        },
      }
    }
    let sm2RealSendCalls = 0
    let sm2ChatInvocations = 0
    const sm2RealSend = (Object.getPrototypeOf(sm2) as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage
    ;(sm2 as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = function (
      this: unknown,
      ...args: unknown[]
    ) {
      sm2RealSendCalls++
      return sm2RealSend.apply(this, args)
    }
    const stored = loadSession(tmpRoot, 'f-clear-flush')!
    const managed2 = createManagedSession(
      { id: stored.id, name: stored.name, createdAt: stored.createdAt },
      { id: 'ws_test', name: 'T', rootPath: tmpRoot, createdAt: Date.now() } as never,
    )
    ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set('f-clear-flush', managed2)
    await (sm2 as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(managed2)
    await new Promise(r => setTimeout(r, 100))
    await waitForCondition(() =>
      (managed2 as unknown as { pendingAgentResume?: unknown }).pendingAgentResume === undefined
    )

    // The answer turn was NOT re-executed after restart: no real send, no
    // agent creation, no agent chat.
    expect(sm2RealSendCalls).toBe(0)
    expect(sm2AgentInits).toBe(0)
    expect(sm2ChatInvocations).toBe(0)
    // And the terminal record was durably cleared
    expect((managed2 as unknown as { pendingAgentResume?: unknown }).pendingAgentResume).toBeUndefined()
  })
})
