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

// Review round 1, issue #4: these race/fault scenarios were accidentally
// deleted relative to the fork point b5bd957f. Each test protects a distinct
// invariant and runs through the REAL handler / sendMessage paths:
//
// 1. "real handler entry: flush failure surfaces as a tool error" —
//    INVARIANT: a durable-persist failure propagates through the REAL
//    request_user_input handler as isError; the model never sees a fake
//    "paused" success and the turn keeps running.
// 2. "real handler entry: delayed callback blocks the tool result" —
//    INVARIANT: the tool result settles only AFTER the durable handoff
//    completes; a slow callback must block, not report success early.
// 3. "resume success → awaited flush clears disk state" —
//    INVARIANT: after a successful answer→resume retry, the recovery state is
//    durably cleared so a crash/restart cannot re-arm the finished recovery.
// 4. "old resume superseded mid-await" —
//    INVARIANT: when an old answer turn is in flight and a NEW recovery state
//    is armed, the old caller's durable clear must not wipe the new state.
// 5. "armed retry + delayed shared revoke + delete" —
//    INVARIANT: deleteSession disarms the retry timer BEFORE the share-revoke
//    window, so a live timer crossing that window cannot start ghost turns.

describe('request_user_input race + fault coverage (restored from b5bd957f)', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof import('./SessionManager').SessionManager>
  let events: Array<Record<string, unknown>>
  let flushCalls: number
  let failFlush: boolean
  const seededSessionIds = new Set<string>()

  const { makeQuestionRequest, makeAnswerResolution } = buildQuestionFixtures()

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-question-races-'))
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
      messages?: Array<Record<string, unknown>>
    } = {},
  ) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'race session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: (opts.messages ?? []) as unknown as StoredSession['messages'],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
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
      ;(managed as unknown as { agent: unknown }).agent = {
        interruptForHandoff: () => { interrupted++ },
        forceAbort: () => {},
        get interruptedCount() { return interrupted },
      }
    }
    if (opts.pendingQuestion) {
      ;(managed as unknown as { pendingQuestion: unknown }).pendingQuestion = opts.pendingQuestion
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

  async function waitForCondition(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('waitForCondition timed out')
  }

  // INVARIANT 1: a durable-persist failure propagates through the REAL
  // request_user_input handler as isError — never a fake "paused" success.
  it('real handler entry: flush failure surfaces as a tool error (isError), not a waiting success', async () => {
    patchPrivateFlush()
    failFlush = true
    const managed = seedSession('r-handler-1', { isProcessing: true, withAgent: true })
    const request = makeQuestionRequest('r-handler-1')
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
    expect(getManaged('r-handler-1').isProcessing).toBe(true)
  })

  // INVARIANT 2: the tool result settles only AFTER the durable handoff
  // completes — a slow callback blocks the result instead of reporting an
  // early success while the pending question is not yet authoritative.
  it('real handler entry: delayed callback blocks the tool result until the handoff completes', async () => {
    patchPrivateFlush()
    const managed = seedSession('r-handler-2', { isProcessing: true, withAgent: true })
    const request = makeQuestionRequest('r-handler-2')
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
    expect(sm.getPendingQuestion('r-handler-2')).not.toBeNull()
  })

  // INVARIANT 3: after a successful answer→resume retry the recovery state is
  // durably cleared — a crash/restart cannot re-arm the finished recovery.
  it('resume success → awaited flush clears disk state; no restart after completion', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('r-real-ok')
    seedSession('r-real-ok', { pendingQuestion: request })

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      agentInitCalls++
      if (agentInitCalls === 1) {
        throw new Error(`agent init failed #${agentInitCalls}`)
      }
      return makeFakeAgent()
    }

    const result = await sm.respondToQuestion('r-real-ok', makeAnswerResolution(request))
    expect(result).toEqual({ status: 'accepted' })

    // Retry succeeded through the real entry
    await waitForCondition(() => agentInitCalls >= 2)
    await waitForCondition(() => getManaged('r-real-ok').pendingAgentResume === undefined)

    // Awaited flush: the disk header no longer carries the recovery state —
    // a crash cannot re-arm the finished recovery.
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'r-real-ok'), 'utf-8').split('\n')[0])
    expect(header.pendingAgentResume).toBeUndefined()

    const callsAfterSuccess = agentInitCalls
    await new Promise(r => setTimeout(r, 1500))
    expect(agentInitCalls).toBe(callsAfterSuccess)
  })

  // INVARIANT 4: while an OLD answer turn is awaiting its chat, a new user
  // message supersedes it and ANOTHER answer arms a NEW resume — the old
  // caller's durable clear (boundary 2) must not wipe the new recovery state.
  it('old resume superseded mid-await: durable clear skips and the new resume survives', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('r-supersede')
    const managed = seedSession('r-supersede', {
      pendingQuestion: request,
      messages: [
        { id: 'msg-old-answer', type: 'user', role: 'user', content: 'old answer', timestamp: Date.now() },
        { id: 'msg-new-answer', type: 'user', role: 'user', content: 'new answer', timestamp: Date.now() },
      ],
    })

    // Old and new answer message ids — names carry the identity semantics
    const oldAnswerMessageId = 'msg-old-answer'
    const newAnswerMessageId = 'msg-new-answer'
    // seedSession only persists to disk — the managed in-memory messages must
    // hold the answer messages for the resume path to find them.
    ;(managed as unknown as { messages: Array<Record<string, unknown>> }).messages.push(
      { id: oldAnswerMessageId, type: 'user', role: 'user', content: 'old answer', timestamp: Date.now() },
      { id: newAnswerMessageId, type: 'user', role: 'user', content: 'new answer', timestamp: Date.now() },
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
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: oldAnswerMessageId, attempts: 0 }
    const oldTurn = (sm as unknown as { resumePendingAgentTurn: (m: unknown) => Promise<void> })
      .resumePendingAgentTurn(managed)

    // Wait until the old turn is genuinely inside its gated chat
    await waitForCondition(() => chatInvocations === 1)
    expect(chatInvocations).toBe(1)

    // Mid-await: a new user message supersedes (production clears), then
    // another answer arms a NEW recovery state with a NEW messageId.
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = undefined
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: newAnswerMessageId, attempts: 0 }

    // Release the old turn — it completes, and boundary 2 must exit silently.
    releaseOldTurn!()
    await oldTurn

    // The NEW recovery state survived (old caller did not clear it)
    const stateAfter = getManaged('r-supersede').pendingAgentResume
    expect(stateAfter?.messageId).toBe(newAnswerMessageId)

    // The new resume still works end-to-end: run it, turn executes, state clears.
    await (sm as unknown as { resumePendingAgentTurn: (m: unknown) => Promise<void> }).resumePendingAgentTurn(managed)
    expect(chatInvocations).toBe(2)
    expect(getManaged('r-supersede').pendingAgentResume).toBeUndefined()
  })

  // INVARIANT 5: deleteSession must disarm the retry timer BEFORE the abort
  // wait / share-revoke window — a live timer during that window can start a
  // ghost turn (identity guard still holds until removal).
  it('armed retry + delayed shared revoke + delete: no ghost turns during the deletion window', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('r-del-window')
    const managed = seedSession('r-del-window', { pendingQuestion: request })
    // Shared session → deleteSession awaits the (stubbed, slow) revoke
    ;(managed as unknown as { sharedId?: string; sharedUrl?: string }).sharedId = 'share-123'
    ;(managed as unknown as { sharedUrl?: string }).sharedUrl = 'https://viewer.example.com/s/share-123'

    let agentInitCalls = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      agentInitCalls++
      throw new Error(`agent init failed #${agentInitCalls}`)
    }

    await sm.respondToQuestion('r-del-window', makeAnswerResolution(request))
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
      const deletePromise = sm.deleteSession('r-del-window')

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
})
