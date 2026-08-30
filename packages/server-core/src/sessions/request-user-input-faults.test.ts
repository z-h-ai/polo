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

const { SessionManager, createManagedSession, computeRequestUserInputEligibility } = await import('./SessionManager.ts')
const { getSessionFilePath, loadSession, writeSessionJsonl } = await import('@polo-ai/shared/sessions')
type StoredSession = import('@polo-ai/shared/sessions').StoredSession
const { buildQuestionFixtures } = await import('./request-user-input-fixtures.ts')

// Round 6/7/8/10 fault-injection and lifecycle coverage for request_user_input:
// - question-request flush failure must roll the replacement back and NOT
//   hand off (agent keeps running, no question_request/complete events)
// - release failure must not skip the handoff completion (complete still sent)
// - answer/cancel flush failures must leave the pending question intact so
//   the SAME resolution can be retried (transient_failure is truthful)
// - stop while a question is pending must clear + broadcast; repeated stop is
//   a no-op
// - getOrCreateAgent failures reset processing and the retry drives the REAL
//   entry again without duplicating the user message
// - the round-10 adjudicated Edit Popover eligibility exception (hidden+mini
//   turn with the explicit marker) and fail-closed paths

describe('request_user_input fault injection + stop lifecycle', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof import('./SessionManager').SessionManager>
  let events: Array<Record<string, unknown>>
  let flushCalls: number
  let failFlush: boolean
  const seededSessionIds = new Set<string>()

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
    // Cancel every pending debounced persistence write and give any
    // already-in-flight write time to finish BEFORE deleting the tmpRoot —
    // otherwise the write fires after rmSync and surfaces as an unhandled
    // ENOENT rejection attributed to the NEXT test.
    const queue = (sm as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
    for (const id of seededSessionIds) {
      try { queue.cancel(id) } catch { /* ignore */ }
    }
    seededSessionIds.clear()
    await new Promise(r => setTimeout(r, 650))
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
      workspace?: { id: string; rootPath: string }
    } = {},
  ) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
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
      opts.workspace
        ? ({ id: opts.workspace.id, name: 'WS', rootPath: opts.workspace.rootPath, createdAt: Date.now() } as never)
        : buildWorkspace(),
    )
    ;(managed as unknown as { isProcessing: boolean }).isProcessing = opts.isProcessing ?? false
    if (opts.withAgent) {
      let interrupted = 0
      ;(managed as unknown as { agent: unknown }).agent = {
        interruptForHandoff: () => { interrupted++ },
        forceAbort: () => {},
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
    seededSessionIds.add(sessionId)
    return managed
  }

  function getManaged(sessionId: string) {
    return (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as unknown as {
      pendingQuestion?: unknown
      pendingAgentResume?: { messageId: string; attempts: number; completed?: boolean }
      isProcessing: boolean
      messages: Array<Record<string, unknown>>
      messageQueue: Array<Record<string, unknown>>
      activeTurnSource?: string
      invocationSource?: string
      turnStartReserved?: boolean
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

  async function waitForCondition(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('waitForCondition timed out')
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
    const resumeState = managed.pendingAgentResume
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
      const managed = getManaged('f-resume-2')
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
    expect(getManaged('f-resume-2').pendingAgentResume).toBeDefined()

    // A user's new message (existingMessageId undefined ≠ resume messageId)
    // supersedes the recovery state.
    await sm.sendMessage('f-resume-2', 'a new user message')
    expect(getManaged('f-resume-2').pendingAgentResume).toBeUndefined()
  })

  it('stop clears an armed answer→resume retry (user stop means no new turns)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-resume-3')
    const managed = seedSession('f-resume-3', { pendingQuestion: request, isProcessing: false, withAgent: true })

    // Arm the recovery state, then stop
    managed.pendingAgentResume = { messageId: 'm-1', attempts: 2 }

    await sm.cancelProcessing('f-resume-3')

    expect(getManaged('f-resume-3').pendingAgentResume).toBeUndefined()
  })

  it('stop with no pending question emits nothing question-related', async () => {
    patchPrivateFlush()
    seedSession('f-stop-2', { isProcessing: true, withAgent: true })

    await sm.cancelProcessing('f-stop-2')

    expect(events.filter(e => String(e.type).startsWith('question_'))).toEqual([])
  })

  // Round 10 + review round 1 fixes: the adjudicated Edit Popover exception
  // (request_id 83c0c3ce-r10-d1) is bound to a SERVER-VERIFIABLE session
  // origin, not a per-turn marker. Only a session created with origin
  // 'edit-popover', hidden AND mini, on a desktop turn gets
  // request_user_input; the generic send API cannot elevate any session.
  describe('Edit Popover eligibility exception (server-verified origin)', () => {
    function compute(
      invocationSource: 'desktop' | 'messaging' | 'automation' | 'headless' | 'internal' | undefined,
      hidden: boolean | undefined,
      isMini: boolean | undefined,
      origin: 'cli-run' | 'cli-exec' | 'edit-popover' | undefined,
    ): boolean {
      return computeRequestUserInputEligibility(invocationSource, hidden, isMini, origin)
    }

    function seedHiddenMini(
      sessionId: string,
      request: ReturnType<typeof makeQuestionRequest>,
      origin?: 'edit-popover',
      popoverOwner?: string,
      workspace?: { id: string; rootPath: string },
    ) {
      const m = seedSession(sessionId, { pendingQuestion: request, workspace })
      ;(m as unknown as { hidden: boolean }).hidden = true
      ;(m as unknown as { systemPromptPreset: string }).systemPromptPreset = 'mini'
      if (origin) {
        ;(m as unknown as { origin?: string }).origin = origin
      }
      if (popoverOwner !== undefined) {
        ;(m as unknown as { popoverOwner?: string }).popoverOwner = popoverOwner
      }
      return m
    }

    const flagCapture: { last: boolean | undefined } = { last: undefined }
    function stubAgentCaptureFlag(manager: unknown = sm): void {
      ;(manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
        const agent = makeFakeAgent()
        Object.defineProperty(agent, 'allowRequestUserInput', {
          get: () => flagCapture.last,
          set: (v: boolean) => { flagCapture.last = v },
        })
        return agent
      }
    }

    it('eligibility matrix: only the trusted edit-popover origin unlocks hidden+mini, on desktop turns', () => {
      // Ordinary desktop, visible session → visible
      expect(compute('desktop', false, false, undefined)).toBe(true)
      // Ordinary hidden/mini sessions (no origin) → fail closed
      expect(compute('desktop', true, false, undefined)).toBe(false)
      expect(compute('desktop', true, true, undefined)).toBe(false)
      expect(compute('desktop', false, true, undefined)).toBe(false)
      // The Edit Popover exception: trusted origin + hidden + mini + desktop
      expect(compute('desktop', true, true, 'edit-popover')).toBe(true)
      // Origin alone is NOT sufficient: hidden non-mini and visible mini
      // popover sessions stay closed
      expect(compute('desktop', true, false, 'edit-popover')).toBe(false)
      expect(compute('desktop', false, true, 'edit-popover')).toBe(false)
      // Other host experiences never unlock hidden/mini sessions
      expect(compute('desktop', true, true, 'cli-run')).toBe(false)
      expect(compute('desktop', true, true, 'cli-exec')).toBe(false)
      // Non-desktop entries fail closed regardless of origin
      expect(compute('messaging', true, true, 'edit-popover')).toBe(false)
      expect(compute('automation', true, true, 'edit-popover')).toBe(false)
      expect(compute('headless', true, true, 'edit-popover')).toBe(false)
      expect(compute('internal', true, true, 'edit-popover')).toBe(false)
      // Missing source defaults to internal → fail closed
      expect(compute(undefined, true, true, 'edit-popover')).toBe(false)
    })

    it('real entry: only the popover-origin hidden+mini session exposes the tool; the generic send API cannot elevate any session', async () => {
      patchPrivateFlush()
      const request = makeQuestionRequest('f-ep-1')
      stubAgentCaptureFlag()

      // Hidden+mini session WITHOUT the trusted origin → tool invisible
      seedHiddenMini('f-ep-closed', request)
      await sm.sendMessage('f-ep-closed', 'ordinary hidden turn', [], [], { invocationSource: 'desktop' })
      expect(flagCapture.last).toBe(false)

      // A forged per-turn marker in the options bag must be ignored: the
      // SendMessageOptions contract no longer carries any grant, and an
      // unknown property cannot elevate eligibility.
      const forgedOptions = { invocationSource: 'desktop' } as Record<string, unknown>
      forgedOptions.editPopoverTurn = true
      await sm.sendMessage('f-ep-closed', 'forged marker turn', [], [], forgedOptions as never)
      expect(flagCapture.last).toBe(false)

      // The REAL Edit Popover session (origin recorded at creation) → visible
      seedHiddenMini('f-ep-open', request, 'edit-popover')
      await sm.sendMessage('f-ep-open', 'edit popover turn', [], [], { invocationSource: 'desktop' })
      expect(flagCapture.last).toBe(true)
    })

    it('real entry: hidden non-mini and visible mini popover sessions stay fail closed', async () => {
      patchPrivateFlush()
      stubAgentCaptureFlag()

      // Hidden but NOT mini, with the trusted origin → closed
      const hiddenNotMini = seedSession('f-ep-hnm', { pendingQuestion: makeQuestionRequest('f-ep-hnm') })
      ;(hiddenNotMini as unknown as { hidden: boolean }).hidden = true
      ;(hiddenNotMini as unknown as { origin?: string }).origin = 'edit-popover'
      await sm.sendMessage('f-ep-hnm', 'hidden non-mini turn', [], [], { invocationSource: 'desktop' })
      expect(flagCapture.last).toBe(false)

      // Mini but visible, with the trusted origin → closed
      const visibleMini = seedSession('f-ep-vm', { pendingQuestion: makeQuestionRequest('f-ep-vm') })
      ;(visibleMini as unknown as { systemPromptPreset: string }).systemPromptPreset = 'mini'
      ;(visibleMini as unknown as { origin?: string }).origin = 'edit-popover'
      await sm.sendMessage('f-ep-vm', 'visible mini turn', [], [], { invocationSource: 'desktop' })
      expect(flagCapture.last).toBe(false)
    })

    it('real entry: a non-desktop source on a popover session stays fail closed', async () => {
      patchPrivateFlush()
      stubAgentCaptureFlag()
      seedHiddenMini('f-ep-msg', makeQuestionRequest('f-ep-msg'), 'edit-popover')

      // The messaging gateway can never turn a session into the desktop
      // popover experience — non-desktop sources fail closed even with the
      // trusted origin present.
      await sm.sendMessage('f-ep-msg', 'messaging turn', [], [], { invocationSource: 'messaging' })
      expect(flagCapture.last).toBe(false)
    })

    // Review round 1, issue #2: the answer→resume path must preserve the
    // trusted entry capability — the Edit Popover's hidden+mini session keeps
    // request_user_input on the resumed turn (and its retries), instead of
    // being re-inferred as an ordinary desktop turn.
    it('answering a popover question resumes with the capability intact so the agent can ask again', async () => {
      patchPrivateFlush()
      const request = makeQuestionRequest('f-ep-resume')
      const popoverRequest: typeof request = {
        ...request,
        invocationSource: 'desktop',
      }
      seedHiddenMini('f-ep-resume', popoverRequest, 'edit-popover')

      let resumedOptions: { invocationSource?: string } | undefined
      let flagAfterResume: boolean | undefined
      ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => {
        resumedOptions = args[4] as { invocationSource?: string }
        // Reproduce the REAL sendMessage eligibility computation against the
        // managed session to prove the resumed turn stays eligible.
        const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get('f-ep-resume') as unknown as {
          hidden: boolean
          systemPromptPreset: string
          origin?: 'edit-popover'
        }
        flagAfterResume = computeRequestUserInputEligibility(
          resumedOptions?.invocationSource as 'desktop' | undefined,
          managed.hidden,
          managed.systemPromptPreset === 'mini',
          managed.origin,
        )
      }

      const result = await sm.respondToQuestion('f-ep-resume', makeAnswerResolution(popoverRequest))
      expect(result).toEqual({ status: 'accepted' })

      // The resume carried the trusted entry source, not a re-inferred value
      expect(resumedOptions?.invocationSource).toBe('desktop')
      // …and the resumed turn kept the tool visible for the popover session
      expect(flagAfterResume).toBe(true)
    })

    it('pendingAgentResume persists the trusted entry source and restart recovery reuses it', async () => {
      patchPrivateFlush()
      const request = makeQuestionRequest('f-ep-restart')
      seedHiddenMini('f-ep-restart', { ...request, invocationSource: 'desktop' }, 'edit-popover')

      // The FIRST resume attempt fails pre-chat — the armed recovery state
      // (with the trusted entry source) is persisted for the retry/restart.
      let sendCalls = 0
      ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {
        sendCalls++
        throw new Error('backend init failed (injected)')
      }
      await sm.respondToQuestion('f-ep-restart', makeAnswerResolution(request))
      const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-ep-restart'), 'utf-8').split('\n')[0])
      expect(header.pendingAgentResume?.invocationSource).toBe('desktop')
      expect(header.pendingAgentResume?.completed).toBeUndefined()
      void sendCalls

      // Restart: a fresh SessionManager hydrates the armed recovery and the
      // popover origin; the retry drives the real entry with the same trusted
      // source instead of re-inferring an ordinary desktop turn.
      const sm2 = new SessionManager()
      try {
        let resumedOptions: { invocationSource?: string } | undefined
        ;(sm2 as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => makeFakeAgent()
        const sm2RealSend = (Object.getPrototypeOf(sm2) as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage
        ;(sm2 as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async function (this: unknown, ...args: unknown[]) {
          resumedOptions = args[4] as { invocationSource?: string }
          return sm2RealSend.apply(this, args)
        }
        const stored = loadSession(tmpRoot, 'f-ep-restart')!
        const managed2 = createManagedSession(
          { id: stored.id, name: stored.name, createdAt: stored.createdAt, hidden: true, systemPromptPreset: 'mini', origin: 'edit-popover' },
          buildWorkspace(),
        )
        ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set('f-ep-restart', managed2)
        await (sm2 as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(managed2)
        await waitForCondition(() => resumedOptions !== undefined)
        expect(resumedOptions?.invocationSource).toBe('desktop')
      } finally {
        ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
      }
    })

    // Review round 1, issue #1 + round 2, issue #2: the popover's hidden
    // session must stay reachable while a question is pending — across reopen
    // (in-memory lookup) and restart (on-disk header scan) — and the lookup
    // must be SCOPED to the requesting workspace + popover owner so
    // concurrent popovers/workspaces can never adopt each other's session.
    describe('pending question reachability (scoped getEditPopoverPendingSession)', () => {
      const OWNER_A = 'Permissions::/ws/a/config.json'
      const OWNER_B = 'Automations::/ws/a/automations.json'

      function seedStoredPopover(
        sessionId: string,
        request: ReturnType<typeof makeQuestionRequest>,
        opts: { popoverOwner?: string; workspaceRoot?: string } = {},
      ) {
        const root = opts.workspaceRoot ?? tmpRoot
        const filePath = getSessionFilePath(root, sessionId)
        mkdirSync(dirname(filePath), { recursive: true })
        const stored = {
          id: sessionId,
          workspaceRootPath: root,
          name: 'popover session',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          hidden: true,
          systemPromptPreset: 'mini',
          origin: 'edit-popover',
          popoverOwner: opts.popoverOwner,
          messages: [] as unknown as StoredSession['messages'],
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
          pendingQuestion: request,
        } as StoredSession
        writeSessionJsonl(filePath, stored)
        seededSessionIds.add(sessionId)
      }

      it('in-memory: exact workspace + owner match only — concurrent popovers never adopt each other, unknown owner gets null', async () => {
        patchPrivateFlush()
        const wsA = { id: 'ws-a', rootPath: tmpRoot }
        const older = { ...makeQuestionRequest('f-reach-a'), createdAt: 1000 }
        seedHiddenMini('f-reach-a', older, 'edit-popover', OWNER_A, wsA)

        const newer = { ...makeQuestionRequest('f-reach-b'), createdAt: 2000 }
        seedHiddenMini('f-reach-b', newer, 'edit-popover', OWNER_B, wsA)

        // Owner A gets ITS session — even though B's request is newer
        const foundA = await sm.getEditPopoverPendingSession('ws-a', OWNER_A)
        expect(foundA?.sessionId).toBe('f-reach-a')
        expect(foundA?.request.requestId).toBe(older.requestId)
        // Owner B gets its own
        const foundB = await sm.getEditPopoverPendingSession('ws-a', OWNER_B)
        expect(foundB?.sessionId).toBe('f-reach-b')
        // An unknown owner (or wrong workspace) never adopts anything
        expect(await sm.getEditPopoverPendingSession('ws-a', 'Unknown::/x')).toBeNull()
        expect(await sm.getEditPopoverPendingSession('ws-other', OWNER_A)).toBeNull()
      })

      it('in-memory: a different workspace can never adopt a popover session from another workspace', async () => {
        patchPrivateFlush()
        const requestA = { ...makeQuestionRequest('f-reach-wsA'), createdAt: 1000 }
        seedHiddenMini('f-reach-wsA', requestA, 'edit-popover', OWNER_A, { id: 'ws-a', rootPath: tmpRoot })
        const requestB = { ...makeQuestionRequest('f-reach-wsB'), createdAt: 5000 }
        seedHiddenMini('f-reach-wsB', requestB, 'edit-popover', OWNER_A, { id: 'ws-b', rootPath: tmpRoot })

        // Same owner id in BOTH workspaces (same edit surface opened on two
        // workspaces): each workspace resolves to its own session only.
        const foundA = await sm.getEditPopoverPendingSession('ws-a', OWNER_A)
        expect(foundA?.sessionId).toBe('f-reach-wsA')
        const foundB = await sm.getEditPopoverPendingSession('ws-b', OWNER_A)
        expect(foundB?.sessionId).toBe('f-reach-wsB')
      })

      it('restart: rediscovers a pending popover question from the on-disk header, scoped to workspace + owner', async () => {
        patchPrivateFlush()
        const request = makeQuestionRequest('f-reach-disk')
        seedStoredPopover('f-reach-disk', request, { popoverOwner: OWNER_A })

        // Fresh manager = restart simulation; the session is NOT in memory.
        const sm2 = new SessionManager({ workspace: buildWorkspace() })
        try {
          // Exact owner match recovers; any other scope returns null WITHOUT
          // adopting the session (no global newest-wins fallback).
          expect(await sm2.getEditPopoverPendingSession('ws_test', OWNER_B)).toBeNull()
          const found = await sm2.getEditPopoverPendingSession('ws_test', OWNER_A)
          expect(found?.sessionId).toBe('f-reach-disk')
          expect(found?.request.requestId).toBe(request.requestId)

          // Hydration prunes nothing here (no resolution on disk), and the
          // session is now managed with the same authoritative request.
          const managed = (sm2 as unknown as { sessions: Map<string, unknown> }).sessions.get('f-reach-disk') as unknown as {
            pendingQuestion?: { requestId: string }
          }
          expect(managed?.pendingQuestion?.requestId).toBe(request.requestId)
        } finally {
          ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })

      it('lifecycle end: answering or skipping clears the association (null, no orphan)', async () => {
        patchPrivateFlush()
        const request = makeQuestionRequest('f-reach-clear')
        seedHiddenMini('f-reach-clear', request, 'edit-popover', OWNER_A)
        expect((await sm.getEditPopoverPendingSession('ws_test', OWNER_A))?.sessionId).toBe('f-reach-clear')

        // Skip ("暂不回答") ends the association — no popover adoption anymore
        ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}
        await sm.respondToQuestion('f-reach-clear', { action: 'cancel', requestId: request.requestId })
        expect(await sm.getEditPopoverPendingSession('ws_test', OWNER_A)).toBeNull()
      })

      // Round 3, issue 3: cold recovery must hydrate the FULL identity from
      // the header (hidden/origin/owner/preset), answering must not degrade
      // the persisted header, and a follow-up question must be recoverable by
      // the same owner.
      it('cold recovery keeps the full popover identity; answering does not degrade the header; a follow-up question is recoverable', async () => {
        patchPrivateFlush()
        const request = makeQuestionRequest('f-reach-identity')
        seedStoredPopover('f-reach-identity', request, { popoverOwner: OWNER_A })

        const sm2 = new SessionManager({ workspace: buildWorkspace() })
        try {
          const found = await sm2.getEditPopoverPendingSession('ws_test', OWNER_A)
          expect(found?.sessionId).toBe('f-reach-identity')

          // The hydrated managed session carries the COMPLETE host identity
          const managed = (sm2 as unknown as { sessions: Map<string, unknown> }).sessions.get('f-reach-identity') as unknown as {
            hidden?: boolean
            origin?: string
            popoverOwner?: string
            systemPromptPreset?: string
            pendingQuestion?: { requestId: string }
          }
          expect(managed.hidden).toBe(true)
          expect(managed.origin).toBe('edit-popover')
          expect(managed.popoverOwner).toBe(OWNER_A)
          expect(managed.systemPromptPreset).toBe('mini')

          // Answer the recovered question (resume stubbed to a no-op turn)
          ;(sm2 as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}
          const result = await sm2.respondToQuestion('f-reach-identity', makeAnswerResolution(request))
          expect(result).toEqual({ status: 'accepted' })

          // The header did NOT degrade: host identity + owner survive the
          // answer's persist; the pending state is cleared.
          const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-reach-identity'), 'utf-8').split('\n')[0])
          expect(header.origin).toBe('edit-popover')
          expect(header.popoverOwner).toBe(OWNER_A)
          expect(header.hidden).toBe(true)
          expect(header.systemPromptPreset).toBe('mini')
          expect(header.pendingQuestion).toBeUndefined()

          // A follow-up question on the same session is recoverable by the
          // same owner (scoped association is intact). Polo regenerates the
          // requestId server-side, so assert on identity + freshness.
          const followUp = makeQuestionRequest('f-reach-identity-2')
          await (sm2 as unknown as { handleQuestionRequested: (m: unknown, q: unknown[]) => Promise<void> })
            .handleQuestionRequested(managed, followUp.questions)
          const foundAgain = await sm2.getEditPopoverPendingSession('ws_test', OWNER_A)
          expect(foundAgain?.sessionId).toBe('f-reach-identity')
          expect(foundAgain?.request.requestId).toBeDefined()
          expect(foundAgain?.request.requestId).not.toBe(request.requestId)
        } finally {
          ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })
    })

    // Review round 2, issue #1: the generic creation path can never grant the
    // 'edit-popover' origin — a forged value is stripped (fail closed), and
    // only the dedicated createEditPopoverSession stamps it server-side.
    describe('trusted origin stamping (generic forge stripped)', () => {
      const OWNER_ID = 'Permissions::/ws/a/config.json'
      const flagOf = () => flagCapture.last

      it('generic createSession strips a forged edit-popover origin; the session stays fail closed', async () => {
        const smS = new SessionManager({ workspace: buildWorkspace() })
        stubAgentCaptureFlag(smS)
        try {
          const session = await (smS as unknown as {
            createSession: (workspaceId: string, options: Record<string, unknown>) => Promise<{ id: string }>
          }).createSession('ws_test', {
            model: 'fast',
            systemPromptPreset: 'mini',
            permissionMode: 'allow-all',
            hidden: true,
            origin: 'edit-popover', // forged through the generic options bag
          })
          seededSessionIds.add(session.id)

          // The persisted header must NOT carry the privileged origin
          const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, session.id), 'utf-8').split('\n')[0])
          expect(header.origin).not.toBe('edit-popover')

          // And a desktop turn on that hidden+mini session stays fail closed
          await smS.sendMessage(session.id, 'turn on forged session', [], [], { invocationSource: 'desktop' })
          expect(flagOf()).toBe(false)
        } finally {
          ;(smS as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })

      it('createEditPopoverSession stamps the origin + owner server-side; the session becomes eligible', async () => {
        const smS = new SessionManager({ workspace: buildWorkspace() })
        stubAgentCaptureFlag(smS)
        try {
          const session = await (smS as unknown as {
            createEditPopoverSession: (workspaceId: string, options: Record<string, unknown>) => Promise<{ id: string }>
          }).createEditPopoverSession('ws_test', {
            model: 'fast',
            systemPromptPreset: 'mini',
            permissionMode: 'allow-all',
            hidden: true,
            popoverOwner: OWNER_ID,
          })
          seededSessionIds.add(session.id)

          // The dedicated path persisted the trusted origin + owner identity
          const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, session.id), 'utf-8').split('\n')[0])
          expect(header.origin).toBe('edit-popover')
          expect(header.popoverOwner).toBe(OWNER_ID)

          // A desktop turn on the hidden+mini popover session is eligible
          await smS.sendMessage(session.id, 'turn on real popover session', [], [], { invocationSource: 'desktop' })
          expect(flagOf()).toBe(true)
        } finally {
          ;(smS as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })

      // Round 4, issue 3: a legal owner built from a deep project path (far
      // beyond the old 200-char bound) must create, stamp, and remain
      // recoverable across a restart — no arbitrary truncation.
      it('a deep-path owner beyond 200 chars creates, stamps, and recovers on reopen/restart', async () => {
        stubAgentCaptureFlag()
        const deepOwner = `Permissions::/Users/alice/${'deep/'.repeat(45)}config.json`
        expect(deepOwner.length).toBeGreaterThan(200)

        const smS = new SessionManager({ workspace: buildWorkspace() })
        stubAgentCaptureFlag(smS)
        try {
          const session = await (smS as unknown as {
            createEditPopoverSession: (workspaceId: string, options: Record<string, unknown>) => Promise<{ id: string }>
          }).createEditPopoverSession('ws_test', {
            model: 'fast',
            systemPromptPreset: 'mini',
            permissionMode: 'allow-all',
            hidden: true,
            popoverOwner: deepOwner,
          })
          seededSessionIds.add(session.id)

          // Stamped durably with the FULL deep-path owner
          const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, session.id), 'utf-8').split('\n')[0])
          expect(header.origin).toBe('edit-popover')
          expect(header.popoverOwner).toBe(deepOwner)

          // In-memory scoped recovery with the same deep owner
          const found = await smS.getEditPopoverPendingSession('ws_test', deepOwner)
          expect(found).toBeNull() // no pending question yet — but no rejection either

          // Reopen/restart: cold recovery matches the exact deep owner
          const request = makeQuestionRequest('f-deep-owner')
          const stored = loadSession(tmpRoot, session.id)!
          writeSessionJsonl(getSessionFilePath(tmpRoot, session.id), {
            ...stored,
            pendingQuestion: request,
          } as StoredSession)
          const sm2 = new SessionManager({ workspace: buildWorkspace() })
          try {
            const found2 = await sm2.getEditPopoverPendingSession('ws_test', deepOwner)
            expect(found2?.sessionId).toBe(session.id)
            expect(found2?.request.requestId).toBe(request.requestId)
            // A different (short) owner never adopts it
            expect(await sm2.getEditPopoverPendingSession('ws_test', 'Permissions::/a/config.json')).toBeNull()
          } finally {
            ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
          }
        } finally {
          ;(smS as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })

      // Round 3, issues 1+2: the owner is a REQUIRED, server-validated
      // identity — a blank/missing owner rejects the creation outright, and a
      // failed durable stamp rolls back to unprivileged (memory + disk). The
      // session must never be "privileged but not persisted".
      it('a blank or missing popoverOwner rejects the creation (fail closed)', async () => {
        const smS = new SessionManager({ workspace: buildWorkspace() })
        try {
          await expect((smS as unknown as {
            createEditPopoverSession: (workspaceId: string, options: Record<string, unknown>) => Promise<{ id: string }>
          }).createEditPopoverSession('ws_test', {
            model: 'fast',
            systemPromptPreset: 'mini',
            permissionMode: 'allow-all',
            hidden: true,
            popoverOwner: '   ',
          })).rejects.toThrow(/popoverOwner/)

          await expect((smS as unknown as {
            createEditPopoverSession: (workspaceId: string, options: Record<string, unknown>) => Promise<{ id: string }>
          }).createEditPopoverSession('ws_test', {
            model: 'fast',
            systemPromptPreset: 'mini',
            permissionMode: 'allow-all',
            hidden: true,
            // cast simulates an RPC caller omitting the required field
          } as never)).rejects.toThrow(/popoverOwner/)

          // Nothing privileged was registered
          for (const managed of (smS as unknown as { sessions: Map<string, unknown> }).sessions.values()) {
            expect((managed as unknown as { origin?: string }).origin).not.toBe('edit-popover')
          }
        } finally {
          ;(smS as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })

      it('a failed durable stamp rolls back to unprivileged (memory + disk); the turn stays fail closed', async () => {
        const smS = new SessionManager({ workspace: buildWorkspace() })
        stubAgentCaptureFlag(smS)
        try {
          // Fail exactly the FIRST flushSession call (the stamp flush); the
          // rollback flush and everything after succeeds.
          const realFlush = (Object.getPrototypeOf(smS) as { flushSession: (id: string) => Promise<void> }).flushSession
          let flushCalls = 0
          ;(smS as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
            flushCalls++
            if (flushCalls === 1) {
              return Promise.reject(new Error('disk full (injected)'))
            }
            return realFlush.call(smS, id)
          }

          const session = await (smS as unknown as {
            createEditPopoverSession: (workspaceId: string, options: Record<string, unknown>) => Promise<{ id: string }>
          }).createEditPopoverSession('ws_test', {
            model: 'fast',
            systemPromptPreset: 'mini',
            permissionMode: 'allow-all',
            hidden: true,
            popoverOwner: OWNER_ID,
          })
          seededSessionIds.add(session.id)

          // In-memory: the stamp was rolled back
          const managed = (smS as unknown as { sessions: Map<string, unknown> }).sessions.get(session.id) as unknown as {
            origin?: string
            popoverOwner?: string
          }
          expect(managed.origin).toBeUndefined()
          expect(managed.popoverOwner).toBeUndefined()

          // Disk: the rolled-back (unprivileged) state was persisted
          const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, session.id), 'utf-8').split('\n')[0])
          expect(header.origin).not.toBe('edit-popover')
          expect(header.popoverOwner).toBeUndefined()

          // The hidden+mini session stays fail closed on a desktop turn
          await smS.sendMessage(session.id, 'turn on unprivileged session', [], [], { invocationSource: 'desktop' })
          expect(flagOf()).toBe(false)
        } finally {
          ;(smS as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })
    })

    // Round 4, issue 2: the invocation source is bound to the ACTIVE
    // processing generation. A messaging/automation message that arrives
    // while a desktop turn is running gets queued — it must never overwrite
    // the running turn's source, so a question asked during that turn still
    // stamps desktop (and the agent flag stays untouched).
    // Round 6, issue 1: EVERYTHING between the synchronous turn-start claim
    // and setProcessing(true) sits inside one cleanup boundary — a
    // pending-plan load failure, a lazy message load failure, or a user
    // message flush failure must release the reservation (and the bound
    // active-turn state), never strand a phantom reservation, and drain any
    // follower that already queued behind it.
    describe('turn-start reservation cleanup boundary', () => {
      it('a pending-plan load failure releases the reservation; the next send claims a fresh turn', async () => {
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => makeFakeAgent()
        seedSession('f-clean-1', {})

        // sessionStorage.load throws ONCE — the first caller inside the
        // pre-start section is clearPendingPlanExecution's session load.
        const storage = (sm as unknown as { sessionStorage: { load: (...args: unknown[]) => unknown } }).sessionStorage
        const realLoad = storage.load.bind(storage)
        let loadCalls = 0
        storage.load = (...args: unknown[]) => {
          loadCalls++
          if (loadCalls === 1) throw new Error('plan-state load failed (injected)')
          return realLoad(...args)
        }

        await expect(sm.sendMessage('f-clean-1', 'first message', [], [], { invocationSource: 'desktop' }))
          .rejects.toThrow('plan-state load failed (injected)')

        // Atomic release: no phantom reservation, no leaked active-turn state.
        const m = getManaged('f-clean-1') as unknown as {
          turnStartReserved?: boolean
          activeTurnSource?: string
          invocationSource?: string
          isProcessing: boolean
        }
        expect(m.turnStartReserved).toBe(false)
        expect(m.activeTurnSource).toBeUndefined()
        expect(m.invocationSource).toBeUndefined()
        expect(m.isProcessing).toBe(false)

        // Recoverable: the next send claims a fresh turn normally.
        await sm.sendMessage('f-clean-1', 'second message', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => getManaged('f-clean-1').isProcessing === false)
        expect(m.turnStartReserved).toBe(false)
        expect(m.activeTurnSource).toBe('desktop')
      })

      it('a lazy message load failure releases the reservation (no phantom claim)', async () => {
        seedSession('f-clean-2', {})
        ;(sm as unknown as { ensureMessagesLoaded: () => Promise<void> }).ensureMessagesLoaded = async () => {
          throw new Error('lazy load failed (injected)')
        }

        await expect(sm.sendMessage('f-clean-2', 'first message', [], [], { invocationSource: 'desktop' }))
          .rejects.toThrow('lazy load failed (injected)')

        const m = getManaged('f-clean-2') as unknown as {
          turnStartReserved?: boolean
          activeTurnSource?: string
          isProcessing: boolean
        }
        expect(m.turnStartReserved).toBe(false)
        expect(m.activeTurnSource).toBeUndefined()
        expect(m.isProcessing).toBe(false)
      })

      it('followers queued behind a failed turn start are drained (no stranded queue)', async () => {
        let chatInvocations = 0
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
          chatInvocations++
          return makeFakeAgent()
        }
        seedSession('f-clean-3', {})

        // Stall the OWNER at its user-message flush (inside the pre-start
        // boundary) so a follower can queue behind the held reservation…
        let rejectFlush: ((e: Error) => void) | null = null
        const flushGate = new Promise<void>((_resolve, reject) => { rejectFlush = reject })
        const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
        let flushCalls = 0
        ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
          flushCalls++
          if (flushCalls === 1) return flushGate.then(() => realFlush.call(sm, id))
          return realFlush.call(sm, id)
        }

        const ownerSend = sm.sendMessage('f-clean-3', 'owner message', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => flushCalls === 1)
        expect(getManaged('f-clean-3').turnStartReserved).toBe(true)

        // …then the follower arrives and must queue (its own flush = call #2
        // goes through immediately).
        await sm.sendMessage('f-clean-3', 'follower message', [], [], { invocationSource: 'messaging' })
        expect(getManaged('f-clean-3').messageQueue.length).toBe(1)

        // The owner's flush fails — the reserved turn never starts. The
        // boundary must release the reservation AND drain the follower.
        rejectFlush!(new Error('pre-start flush failed (injected)'))
        await expect(ownerSend).rejects.toThrow('pre-start flush failed (injected)')
        expect(getManaged('f-clean-3').turnStartReserved).toBe(false)
        expect(getManaged('f-clean-3').activeTurnSource).toBeUndefined()

        // The follower replays as its own turn and completes.
        await waitForCondition(() => getManaged('f-clean-3').messageQueue.length === 0)
        await waitForCondition(() => chatInvocations >= 1)
        expect((getManaged('f-clean-3') as unknown as { activeTurnSource?: string }).activeTurnSource).toBe('messaging')
      })
    })

    // Round 7, issue 2: the answer→resume path must treat a held turn-start
    // reservation as "not startable yet" — entering as a follower would
    // duplicate the single answer message and clear the recovery state
    // without executing the turn.
    describe('answer resume vs turn-start reservation', () => {
      function makeCountingAgentFactory(): { getOrCreateAgent: () => Promise<unknown>; chats: () => number } {
        let chats = 0
        const getOrCreateAgent = async () => {
          chats++
          return makeFakeAgent()
        }
        return { getOrCreateAgent, chats: () => chats }
      }

      const answerMessageCount = (sessionId: string) =>
        (getManaged(sessionId).messages as Array<Record<string, unknown>>)
          .filter(m => (m as { questionResponse?: unknown }).questionResponse).length

      it('reservation in flight while the answer commits: ONE answer message, resume deferred, exactly one answer turn eventually', async () => {
        const factory = makeCountingAgentFactory()
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = factory.getOrCreateAgent
        const request = makeQuestionRequest('f-res-resv')
        seedSession('f-res-resv', { pendingQuestion: { ...request, invocationSource: 'desktop' } })

        // Owner claims the turn start, then stalls at its pre-start flush.
        let releaseFlush: (() => void) | null = null
        const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
        const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
        let flushCalls = 0
        ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
          flushCalls++
          if (flushCalls === 1) return flushGate.then(() => realFlush.call(sm, id))
          return realFlush.call(sm, id)
        }
        const ownerSend = sm.sendMessage('f-res-resv', 'owner message', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => flushCalls === 1)
        expect(getManaged('f-res-resv').turnStartReserved).toBe(true)

        // The answer commits while the reservation is held.
        const result = await sm.respondToQuestion('f-res-resv', makeAnswerResolution(request))
        expect(result).toEqual({ status: 'accepted' })
        // Exactly ONE answer message — the deferred resume must not add one.
        expect(answerMessageCount('f-res-resv')).toBe(1)
        expect(getManaged('f-res-resv').pendingAgentResume).toBeDefined()
        // The resume was deferred: no agent turn has started for it.
        expect(factory.chats()).toBe(0)

        // Owner turn proceeds and completes.
        releaseFlush!()
        await ownerSend

        // The scheduled retry eventually runs the answer turn EXACTLY once.
        await waitForCondition(() => getManaged('f-res-resv').pendingAgentResume === undefined, 8000)
        expect(answerMessageCount('f-res-resv')).toBe(1)
        expect(factory.chats()).toBe(2) // owner turn + one answer turn
        expect(getManaged('f-res-resv').isProcessing).toBe(false)
      })

      it('owner success baseline: the resume runs immediately with one answer message and one answer turn', async () => {
        const factory = makeCountingAgentFactory()
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = factory.getOrCreateAgent
        const request = makeQuestionRequest('f-res-owner-ok')
        seedSession('f-res-owner-ok', { pendingQuestion: { ...request, invocationSource: 'desktop' } })

        const result = await sm.respondToQuestion('f-res-owner-ok', makeAnswerResolution(request))
        expect(result).toEqual({ status: 'accepted' })
        await waitForCondition(() => getManaged('f-res-owner-ok').pendingAgentResume === undefined, 5000)

        expect(answerMessageCount('f-res-owner-ok')).toBe(1)
        expect(factory.chats()).toBe(1)
        expect(getManaged('f-res-owner-ok').turnStartReserved).toBe(false)
      })

      it('owner pre-start failure after the answer committed: the answer is preserved, the recovery survives until the real resume executes once', async () => {
        const factory = makeCountingAgentFactory()
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = factory.getOrCreateAgent
        const request = makeQuestionRequest('f-res-owner-fail')
        seedSession('f-res-owner-fail', { pendingQuestion: { ...request, invocationSource: 'desktop' } })

        // Owner claims, then its pre-start flush FAILS.
        let rejectFlush: ((e: Error) => void) | null = null
        const flushGate = new Promise<void>((_resolve, reject) => { rejectFlush = reject })
        const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
        let flushCalls = 0
        ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
          flushCalls++
          if (flushCalls === 1) return flushGate.then(() => realFlush.call(sm, id))
          return realFlush.call(sm, id)
        }
        const ownerSend = sm.sendMessage('f-res-owner-fail', 'owner message', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => flushCalls === 1)

        // The answer commits while the reservation is held; the resume defers.
        const result = await sm.respondToQuestion('f-res-owner-fail', makeAnswerResolution(request))
        expect(result).toEqual({ status: 'accepted' })
        expect(answerMessageCount('f-res-owner-fail')).toBe(1)
        expect(getManaged('f-res-owner-fail').pendingAgentResume).toBeDefined()
        expect(factory.chats()).toBe(0)

        // The owner turn never starts (pre-start failure).
        rejectFlush!(new Error('pre-start flush failed (injected)'))
        await expect(ownerSend).rejects.toThrow('pre-start flush failed (injected)')

        // The owner failure must NOT clear the armed recovery — the answer
        // turn has not executed yet.
        expect(getManaged('f-res-owner-fail').pendingAgentResume).toBeDefined()
        expect(answerMessageCount('f-res-owner-fail')).toBe(1)

        // The deferred retry eventually runs the answer turn EXACTLY once,
        // and only then clears the recovery.
        await waitForCondition(() => getManaged('f-res-owner-fail').pendingAgentResume === undefined, 8000)
        expect(answerMessageCount('f-res-owner-fail')).toBe(1)
        expect(factory.chats()).toBe(1)
        expect(getManaged('f-res-owner-fail').isProcessing).toBe(false)
      })
    })

    describe('turn source isolation (queued messages never overwrite the active turn)', () => {
      it('a question asked during a desktop turn that has queued messaging messages stamps desktop, not messaging', async () => {
        stubAgentCaptureFlag()
        // Gated fake agent: the desktop turn stays genuinely in flight until
        // the gate releases. redirect() returns false so the mid-stream
        // messaging send falls into the FIFO queue (the isolation hazard).
        let releaseTurn: (() => void) | null = null
        const turnGate = new Promise<void>(resolve => { releaseTurn = resolve })
        let chatInvocations = 0
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
          const n = ++chatInvocations
          const agent: Record<string, unknown> = {
            ...makeFakeAgent(),
            redirect: () => false,
            chat: async function* () {
              if (n === 1) await turnGate
              yield { type: 'complete' as const }
            },
          }
          // Same flag-capture surface as stubAgentCaptureFlag — this factory
          // replaces that stub for the gated turn.
          Object.defineProperty(agent, 'allowRequestUserInput', {
            get: () => flagCapture.last,
            set: (v: boolean) => { flagCapture.last = v },
          })
          return agent
        }

        // Desktop turn starts and is in flight
        seedSession('f-turn-iso', {})
        const desktopTurn = sm.sendMessage('f-turn-iso', 'desktop task', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => chatInvocations === 1)
        expect(getManaged('f-turn-iso').isProcessing).toBe(true)

        // Messaging message arrives mid-turn → queued for FIFO replay (its
        // own options must NOT touch the running turn's source)
        await sm.sendMessage('f-turn-iso', 'messaging reply', [], [], { invocationSource: 'messaging' })
        expect(getManaged('f-turn-iso').messageQueue.length).toBe(1)

        // The agent flag was NOT flipped by the queued message
        expect(flagCapture.last).toBe(true)

        // The desktop turn asks a question — the stamp must be desktop
        const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get('f-turn-iso')
        const questions = makeQuestionRequest('f-turn-iso').questions
        await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown[]) => Promise<void> })
          .handleQuestionRequested(managed, questions)
        const stamped = sm.getPendingQuestion('f-turn-iso')
        expect(stamped?.invocationSource).toBe('desktop')

        // Release the turn; the queued messaging message replays as a NEW
        // turn with ITS own source (messaging → tool not registered).
        releaseTurn!()
        await desktopTurn
        await waitForCondition(() => (getManaged('f-turn-iso').messageQueue.length ?? 0) === 0)
        await waitForCondition(() => chatInvocations >= 2)
        expect(flagCapture.last).toBe(false)
      })

      // Round 5, issue 2: the turn-start claim + source binding must be
      // ATOMIC with respect to the pre-processing awaits. While the desktop
      // FIRST message's pre-processing flush is stalled, a concurrent
      // messaging send must NOT claim a second turn or overwrite the
      // reserved source — it queues, and the desktop turn keeps asking.
      it('concurrent sends during a stalled pre-processing flush: reservation holds desktop, messaging queues, replay applies its own source', async () => {
        // Gated agent factory with flag capture (invocation 1 blocks until
        // the desktop turn's question is stamped).
        let releaseTurn: (() => void) | null = null
        const turnGate = new Promise<void>(resolve => { releaseTurn = resolve })
        let chatInvocations = 0
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
          const n = ++chatInvocations
          const agent: Record<string, unknown> = {
            ...makeFakeAgent(),
            redirect: () => false,
            chat: async function* () {
              if (n === 1) await turnGate
              yield { type: 'complete' as const }
            },
          }
          Object.defineProperty(agent, 'allowRequestUserInput', {
            get: () => flagCapture.last,
            set: (v: boolean) => { flagCapture.last = v },
          })
          return agent
        }

        // Stall the FIRST flushSession call: the desktop sender hangs in its
        // pre-processing flush (before setProcessing(true)) — the exact
        // window where two concurrent senders could both see
        // isProcessing=false.
        let releaseFlush: (() => void) | null = null
        const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
        const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
        let flushCalls = 0
        ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
          flushCalls++
          if (flushCalls === 1) return flushGate.then(() => realFlush.call(sm, id))
          return realFlush.call(sm, id)
        }

        seedSession('f-atomic-1', {})

        // Desktop sender claims the turn start synchronously, then blocks in
        // the flush await.
        const desktopTurn = sm.sendMessage('f-atomic-1', 'desktop task', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => flushCalls === 1)

        const reserved = getManaged('f-atomic-1') as unknown as {
          isProcessing: boolean
          turnStartReserved?: boolean
          activeTurnSource?: string
          invocationSource?: string
          messageQueue: Array<Record<string, unknown>>
        }
        expect(reserved.isProcessing).toBe(false)
        expect(reserved.turnStartReserved).toBe(true)
        expect(reserved.activeTurnSource).toBe('desktop')
        expect(reserved.invocationSource).toBe('desktop')

        // Concurrent messaging send while the reservation is held: it must
        // take the steer/queue branch — queued with its own options, never
        // claiming a second turn or overwriting the reserved source.
        await sm.sendMessage('f-atomic-1', 'messaging reply', [], [], { invocationSource: 'messaging' })
        expect(getManaged('f-atomic-1').messageQueue.length).toBe(1)
        expect(getManaged('f-atomic-1').activeTurnSource).toBe('desktop')
        expect(getManaged('f-atomic-1').invocationSource).toBe('desktop')
        expect(getManaged('f-atomic-1').isProcessing).toBe(false)
        expect(getManaged('f-atomic-1').turnStartReserved).toBe(true)

        // Release the flush — the desktop turn proceeds and asks a question.
        releaseFlush!()
        await waitForCondition(() => chatInvocations === 1)
        const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get('f-atomic-1')
        const questions = makeQuestionRequest('f-atomic-1').questions
        await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown[]) => Promise<void> })
          .handleQuestionRequested(managed, questions)
        expect(sm.getPendingQuestion('f-atomic-1')?.invocationSource).toBe('desktop')

        // Release the chat — the desktop turn completes and the queued
        // messaging message replays as its own turn with ITS source.
        releaseTurn!()
        await desktopTurn
        await waitForCondition(() => getManaged('f-atomic-1').messageQueue.length === 0)
        await waitForCondition(() => chatInvocations >= 2)
        expect((getManaged('f-atomic-1') as unknown as { activeTurnSource?: string }).activeTurnSource).toBe('messaging')
        expect(flagCapture.last).toBe(false)
      })
    })

    // Round 3, issue 5: every invocationSource DEFAULT is internal (fail
    // closed). Legacy/malformed persisted state without a source must never
    // upgrade to a desktop resume — neither on ordinary sessions nor on the
    // privileged edit-popover shape.
    describe('missing invocationSource defaults are fail-closed', () => {
      const OWNER_ID = 'Permissions::/ws/a/config.json'

      it('a legacy pendingQuestion without invocationSource resumes as internal — no eligibility upgrade on a popover session', async () => {
        patchPrivateFlush()
        stubAgentCaptureFlag()
        const request = makeQuestionRequest('f-src-legacy-popover')
        // Legacy shape: pendingQuestion WITHOUT invocationSource
        seedHiddenMini('f-src-legacy-popover', request, 'edit-popover', OWNER_ID)

        const resumed: { options?: { invocationSource?: string } } = {}
        const realSend = (Object.getPrototypeOf(sm) as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage
        ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = function (this: unknown, ...args: unknown[]) {
          resumed.options = args[4] as { invocationSource?: string }
          return realSend.apply(this, args)
        }

        const result = await sm.respondToQuestion('f-src-legacy-popover', makeAnswerResolution(request))
        expect(result).toEqual({ status: 'accepted' })
        expect(resumed.options?.invocationSource).toBe('internal')
        // The hidden+mini popover session must NOT regain the tool
        expect(flagCapture.last).toBe(false)
      })

      it('a legacy pendingQuestion without invocationSource resumes as internal — no eligibility upgrade on an ordinary desktop session', async () => {
        patchPrivateFlush()
        stubAgentCaptureFlag()
        const request = makeQuestionRequest('f-src-legacy-plain')
        seedSession('f-src-legacy-plain', { pendingQuestion: request })

        const resumed: { options?: { invocationSource?: string } } = {}
        const realSend = (Object.getPrototypeOf(sm) as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage
        ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = function (this: unknown, ...args: unknown[]) {
          resumed.options = args[4] as { invocationSource?: string }
          return realSend.apply(this, args)
        }

        const result = await sm.respondToQuestion('f-src-legacy-plain', makeAnswerResolution(request))
        expect(result).toEqual({ status: 'accepted' })
        expect(resumed.options?.invocationSource).toBe('internal')
        expect(flagCapture.last).toBe(false)
      })

      it('a legacy pendingAgentResume without invocationSource stays internal after restart (popover shape)', async () => {
        stubAgentCaptureFlag()
        const request = makeQuestionRequest('f-src-legacy-resume')
        // Seed a persisted answer turn + resume state WITHOUT a source, on a
        // fully privileged popover session header.
        const filePath = getSessionFilePath(tmpRoot, 'f-src-legacy-resume')
        mkdirSync(dirname(filePath), { recursive: true })
        const answerMessage = { id: 'msg-legacy-answer', type: 'user', role: 'user', content: 'legacy answer', timestamp: Date.now() }
        const stored = {
          id: 'f-src-legacy-resume',
          workspaceRootPath: tmpRoot,
          name: 'popover legacy resume',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          hidden: true,
          systemPromptPreset: 'mini',
          origin: 'edit-popover',
          popoverOwner: OWNER_ID,
          messages: [answerMessage] as unknown as StoredSession['messages'],
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
          pendingAgentResume: { messageId: answerMessage.id, attempts: 1 },
        } as StoredSession
        writeSessionJsonl(filePath, stored)
        seededSessionIds.add('f-src-legacy-resume')

        // Restart: hydration re-arms the resume; the retry drives the REAL
        // sendMessage entry with the fail-closed internal default.
        const sm2 = new SessionManager({ workspace: buildWorkspace() })
        try {
          stubAgentCaptureFlag(sm2)
          const resumed: { options?: { invocationSource?: string } } = {}
          const sm2RealSend = (Object.getPrototypeOf(sm2) as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage
          ;(sm2 as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = function (this: unknown, ...args: unknown[]) {
            resumed.options = args[4] as { invocationSource?: string }
            return sm2RealSend.apply(this, args)
          }
          const storedLoaded = loadSession(tmpRoot, 'f-src-legacy-resume')!
          const managed2 = createManagedSession(
            { id: storedLoaded.id, name: storedLoaded.name, createdAt: storedLoaded.createdAt, hidden: true, systemPromptPreset: 'mini', origin: 'edit-popover', popoverOwner: OWNER_ID },
            buildWorkspace(),
          )
          ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set('f-src-legacy-resume', managed2)
          await (sm2 as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(managed2)
          await waitForCondition(() => resumed.options !== undefined)
          expect(resumed.options?.invocationSource).toBe('internal')
          expect(flagCapture.last).toBe(false)
        } finally {
          ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
        }
      })
    })
  })

  // Round 7, issues #2/#3: the resume path must drive the REAL sendMessage
  // (mocking getOrCreateAgent, not sendMessage) so pre-chat failures exercise
  // the processing-reset boundary, the retry drives the real entry again
  // without duplicating the user message, and the retry timer is owned by the
  // session lifecycle (cancelled on delete/stop, no ghost turns).

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
    expect(getManaged('f-real-1').isProcessing).toBe(false)
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

  // Round 7, issue #3: a failed durable clear AFTER a fully executed turn is
  // NOT a resume failure — no fake "could not resume", no turn re-execution;
  // the terminal marker keeps a restart from re-running the answer.
  it('success → clear flush failure: turn executes once, no fake resume error, terminal marker persists, restart does not re-run', async () => {
    // Fail exactly the SECOND flush call (the first is the answer commit,
    // the second is the post-success durable clear).
    let flushFailAtCall = 2
    let flushCallCount = 0
    const real = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
      flushCallCount++
      if (flushCallCount === flushFailAtCall) {
        return Promise.reject(new Error('clear flush failed (injected)'))
      }
      return real.call(sm, id)
    }
    const request = makeQuestionRequest('f-clear-flush')
    seedSession('f-clear-flush', { pendingQuestion: request })

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
    const memoryState = getManaged('f-clear-flush').pendingAgentResume
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
    let sm2ChatInvocations = 0
    ;(sm2 as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      sm2AgentInits++
      const agent = makeFakeAgent()
      return {
        ...agent,
        chat: async function* () {
          sm2ChatInvocations++
          yield { type: 'complete' as const }
        },
      }
    }
    let sm2RealSendCalls = 0
    const sm2RealSend = (Object.getPrototypeOf(sm2) as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage
    ;(sm2 as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = function (this: unknown, ...args: unknown[]) {
      sm2RealSendCalls++
      return sm2RealSend.apply(this, args)
    }
    const stored = loadSession(tmpRoot, 'f-clear-flush')!
    const managed2 = createManagedSession(
      { id: stored.id, name: stored.name, createdAt: stored.createdAt },
      buildWorkspace(),
    )
    ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set('f-clear-flush', managed2)
    await (sm2 as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(managed2)
    await new Promise(r => setTimeout(r, 100))
    await waitForCondition(() => managed2.pendingAgentResume === undefined)

    // The answer turn was NOT re-executed after restart: no real send, no
    // agent creation, no agent chat.
    expect(sm2RealSendCalls).toBe(0)
    expect(sm2AgentInits).toBe(0)
    expect(sm2ChatInvocations).toBe(0)
  })
})
