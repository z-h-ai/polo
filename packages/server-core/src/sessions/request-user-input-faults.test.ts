import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
// Repo root (this file: packages/server-core/src/sessions/) — used to point
// the spawned session MCP server at its SOURCE entry (bun executes TS).
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
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

// Optional park point for the sendMessage OWNER path: the owner's pre-section plan-state clear. Lets a test hold the
// turn-start reservation while the question-state lock stays FREE — so an
// answer/cancel can still commit (the round-8 critical section serialized
// those behind the owner section). Only set per-test; null = pass-through.
// bun's mock.module retargets the module globally, so the factory must
// provide a WORKING implementation (same semantics as
// clearPendingPlanExecution) built from the pass-through storage helpers.
const actualSessions = await import('@polo-ai/shared/sessions')
let planClearGate: Promise<void> | null = null
mock.module('@polo-ai/shared/sessions', () => ({
  ...actualSessions,
  clearPendingPlanExecution: async (
    workspaceRootPath: string,
    sessionId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storage: any = actualSessions.defaultWorkspaceSessionStorage,
  ): Promise<void> => {
    if (planClearGate) await planClearGate
    // Same semantics as the original clearPendingPlanExecution, via the
    // index-passed-through default-storage helpers.
    const session = actualSessions.loadSession(workspaceRootPath, sessionId)
    if (!session) return
    delete session.pendingPlanExecution
    await actualSessions.saveSession(session)
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
//   a no-op; a stop whose durable clear FAILS restores the pending (retryable)
//   and never broadcasts — only the converged second stop broadcasts ONCE
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
    let stampedGeneration = 0
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
      setSessionTurnGeneration: (generation: number) => { stampedGeneration = generation },
      get sessionTurnGeneration() { return stampedGeneration },
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
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, questions, 0)).rejects.toThrow(/NOT paused/)

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

    await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, questions, 0)

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

  // the lifecycle clear is FAILURE-ATOMIC — a
  // failed flush must restore the pending (the next stop stays a real retry,
  // not a no-op) and must NOT broadcast question_resolved. Only the durable
  // clear converges memory + disk + renderers, exactly once.
  it('a failed stop flush restores the pending; the next stop converges memory + JSONL + renderers with ONE terminal event', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-stop-2')
    seedSession('f-stop-2', { pendingQuestion: request, isProcessing: false })

    // FIRST stop: the durable clear fails (transient disk fault) and the
    // failure is surfaced — not a silent "stopped" with a stranded card.
    failFlush = true
    await expect(sm.cancelProcessing('f-stop-2')).rejects.toThrow('disk full')

    // Memory: the authoritative pending is RESTORED (retryable state).
    expect(sm.getPendingQuestion('f-stop-2')?.requestId).toBe(request.requestId)
    // Disk: the JSONL header still holds the pending question.
    const headerDuringFault = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-stop-2'), 'utf-8').split('\n')[0])
    expect(headerDuringFault.pendingQuestion?.requestId).toBe(request.requestId)
    expect(headerDuringFault.hasPendingQuestion).toBe(true)
    // Renderers: no terminal broadcast while the clear is not durable.
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(0)

    // Fault clears: the SECOND stop converges everything and broadcasts ONCE.
    failFlush = false
    await sm.cancelProcessing('f-stop-2')

    expect(sm.getPendingQuestion('f-stop-2')).toBeNull()
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-stop-2'), 'utf-8').split('\n')[0])
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)
    const resolved = events.filter(e => e.type === 'question_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ sessionId: 'f-stop-2', requestId: request.requestId, action: 'cancel' })
  })

  // ---- resolution vs lifecycle SERIALIZATION ----
  // A stop's staged clear and a concurrent answer/cancel commit share the same
  // per-session question-state lock: whichever lands first settles the
  // question, and the other observes the settled world — no stale-then-
  // restored divergence.

  /** Instrument the flush so the FIRST call hangs until the test releases it. */
  function hangFirstFlush() {
    const real = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
    let calls = 0
    let settle!: (err?: Error) => void
    const hung = new Promise<void>((resolve, reject) => {
      settle = (err?: Error) => (err ? reject(err) : resolve())
    })
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
      calls++
      if (calls === 1) return hung
      return real.call(sm, id)
    }
    return { release: settle }
  }

  it('an answer submitted while a stop flush is paused waits for the lock; a FAILED clear keeps the pending and the answer commits', async () => {
    const request = makeQuestionRequest('f-conv-1')
    seedSession('f-conv-1', { pendingQuestion: request, isProcessing: false })
    // Resume stub: the accepted answer kicks resumePendingAgentTurn → sendMessage.
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}

    const { release } = hangFirstFlush()

    // Window A: stop (its staged clear flush hangs).
    const stopPromise = sm.cancelProcessing('f-conv-1')
    await new Promise(r => setTimeout(r, 30))
    // STAGED visibility: the pending question is NOT exposed as absent while
    // the durable clear is in flight.
    expect(sm.getPendingQuestion('f-conv-1')?.requestId).toBe(request.requestId)
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(0)

    // Window B: the same request is answered — it must WAIT on the lock.
    const answerPromise = sm.respondToQuestion('f-conv-1', makeAnswerResolution(request))
    let answerSettled = false
    void answerPromise.then(() => { answerSettled = true })
    await new Promise(r => setTimeout(r, 30))
    expect(answerSettled).toBe(false)

    // The paused clear FAILS: the lifecycle surfaces the error with the
    // pending intact, then the serialized answer commits normally.
    release(new Error('disk full (injected)'))
    await expect(stopPromise).rejects.toThrow('disk full')
    expect(await answerPromise).toEqual({ status: 'accepted' })

    // Convergence: memory + JSONL + events all reflect the ANSWER, broadcast
    // exactly once — never the half-cleared divergence.
    expect(sm.getPendingQuestion('f-conv-1')).toBeNull()
    const resolved = events.filter(e => e.type === 'question_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ sessionId: 'f-conv-1', requestId: request.requestId, action: 'answer' })
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-conv-1'), 'utf-8').split('\n')[0])
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)
    const stored = loadSession(tmpRoot, 'f-conv-1')
    const persistedAnswers = (stored?.messages ?? []).filter(m => (m as { questionResponse?: { requestId?: string } }).questionResponse)
    expect(persistedAnswers).toHaveLength(1)
    expect((persistedAnswers[0] as { questionResponse: { requestId: string } }).questionResponse.requestId).toBe(request.requestId)
  })

  it('an answer submitted while a stop flush is paused returns stale when the clear commits durably (one cancel broadcast)', async () => {
    const request = makeQuestionRequest('f-conv-2')
    seedSession('f-conv-2', { pendingQuestion: request, isProcessing: false })
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}

    const { release } = hangFirstFlush()

    const stopPromise = sm.cancelProcessing('f-conv-2')
    await new Promise(r => setTimeout(r, 30))
    const answerPromise = sm.respondToQuestion('f-conv-2', makeAnswerResolution(request))
    let answerSettled = false
    void answerPromise.then(() => { answerSettled = true })
    await new Promise(r => setTimeout(r, 30))
    expect(answerSettled).toBe(false)

    // The paused clear COMMITS: the question is terminally resolved — the
    // serialized answer observes the settled world and reports stale.
    release()
    await stopPromise
    expect(await answerPromise).toEqual({ status: 'stale' })

    expect(sm.getPendingQuestion('f-conv-2')).toBeNull()
    const resolved = events.filter(e => e.type === 'question_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ sessionId: 'f-conv-2', requestId: request.requestId, action: 'cancel' })
    // Land the staged cleared snapshot (the hang patch bypassed the real
    // queue flush; in production the debounce would do this).
    await sm.flushSession('f-conv-2')
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-conv-2'), 'utf-8').split('\n')[0])
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)
    const stored = loadSession(tmpRoot, 'f-conv-2')
    expect((stored?.messages ?? []).filter(m => (m as { questionResponse?: unknown }).questionResponse)).toHaveLength(0)
  })

  it('an archive flush failure rolls back the FULL lifecycle snapshot; the retry converges memory + JSONL + events', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-arch-1')
    seedSession('f-arch-1', { pendingQuestion: request })

    // FIRST archive: a flush fails mid-lifecycle.
    failFlush = true
    await expect(sm.archiveSession('f-arch-1')).rejects.toThrow('disk full')

    // Full rollback: NOT archived, pending kept, zero lifecycle broadcasts,
    // disk untouched.
    const duringFault = getManaged('f-arch-1') as unknown as { isArchived?: boolean; archivedAt?: number }
    expect(duringFault.isArchived).toBeFalsy()
    expect(duringFault.archivedAt).toBeUndefined()
    expect(sm.getPendingQuestion('f-arch-1')?.requestId).toBe(request.requestId)
    expect(events.filter(e => e.type === 'question_resolved' || e.type === 'session_archived')).toHaveLength(0)
    const headerDuringFault = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-arch-1'), 'utf-8').split('\n')[0])
    expect(headerDuringFault.pendingQuestion?.requestId).toBe(request.requestId)
    expect(headerDuringFault.isArchived).toBeFalsy()

    // Fault clears: the retry converges everything exactly once.
    failFlush = false
    await sm.archiveSession('f-arch-1')

    expect(sm.getPendingQuestion('f-arch-1')).toBeNull()
    const after = getManaged('f-arch-1') as unknown as { isArchived?: boolean }
    expect(after.isArchived).toBe(true)
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-arch-1'), 'utf-8').split('\n')[0])
    expect(header.isArchived).toBe(true)
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)
    const resolved = events.filter(e => e.type === 'question_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ sessionId: 'f-arch-1', requestId: request.requestId, action: 'cancel' })
    expect(events.filter(e => e.type === 'session_archived')).toHaveLength(1)
  })

  // ---- the archive clear + archive flags commit
  // in ONE staged flush. A flush failure can therefore NEVER leave a
  // "cancel already broadcast + active question lost" half-commit — the
  // pre-round-3 two-phase shape could do exactly that when the first phase
  // (clear) succeeded and the second (archive state) failed.

  it('archive unified commit: a flush failure keeps the ACTIVE question and the resume retry, broadcasts nothing, and the retry converges once', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-arch-2')
    const managed = seedSession('f-arch-2', { pendingQuestion: request }) as unknown as {
      pendingAgentResume?: { messageId: string; attempts: number }
      resumeRetryTimer?: unknown
    }
    // An armed answer→resume retry also dies with the archive — and must be
    // restored (timer re-armed) when the unified commit rolls back.
    managed.pendingAgentResume = { messageId: 'msg-resume-arch', attempts: 1 }

    failFlush = true
    await expect(sm.archiveSession('f-arch-2')).rejects.toThrow('disk full')

    // NOTHING was broadcast and NOTHING was lost: the active question AND the
    // recovery state survive a failed archive intact.
    expect(sm.getPendingQuestion('f-arch-2')?.requestId).toBe(request.requestId)
    expect(managed.pendingAgentResume?.messageId).toBe('msg-resume-arch')
    expect(managed.resumeRetryTimer).toBeTruthy() // pre-archive retry re-armed
    expect(events.filter(e => e.type === 'question_resolved' || e.type === 'session_archived')).toHaveLength(0)
    const headerDuringFault = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-arch-2'), 'utf-8').split('\n')[0])
    expect(headerDuringFault.pendingQuestion?.requestId).toBe(request.requestId)
    expect(headerDuringFault.isArchived).toBeFalsy()

    failFlush = false
    await sm.archiveSession('f-arch-2')

    // ONE durable convergence: question cancelled + archived, each exactly once.
    expect(sm.getPendingQuestion('f-arch-2')).toBeNull()
    expect(managed.pendingAgentResume).toBeUndefined()
    expect(managed.resumeRetryTimer).toBeUndefined() // cleared with the archive
    const resolved = events.filter(e => e.type === 'question_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ sessionId: 'f-arch-2', requestId: request.requestId, action: 'cancel' })
    expect(events.filter(e => e.type === 'session_archived')).toHaveLength(1)
  })

  // ---- lifecycle tombstone + generation gate ----
  // After a durable stop/archive, a LATE onQuestionRequested callback of the
  // stopped agent must be rejected: no pending rebuild, no question_request.

  it('a late question callback after a durable stop is rejected by the tombstone (no rebuild, no re-broadcast)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-tomb-1')
    const managed = seedSession('f-tomb-1', { pendingQuestion: request, isProcessing: false })
    const generation = (managed as unknown as { processingGeneration: number }).processingGeneration

    // Stop completes: durable clear + cancel broadcast + tombstone.
    await sm.cancelProcessing('f-tomb-1')
    expect(sm.getPendingQuestion('f-tomb-1')).toBeNull()
    const cancelsBefore = events.filter(e => e.type === 'question_resolved').length
    expect(cancelsBefore).toBe(1)

    // The OLD agent's callback arrives late — dispatch-time generation
    // snapshot equals the active one (stop does not bump it); the TOMBSTONE
    // must reject it.
    const questions = makeQuestionRequest('f-tomb-1-late').questions
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, questions, generation)).rejects.toThrow(/terminally stopped/)

    // No pending resurrection, no second terminal broadcast, no new card.
    expect(sm.getPendingQuestion('f-tomb-1')).toBeNull()
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(cancelsBefore)
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(0)
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-tomb-1'), 'utf-8').split('\n')[0])
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)
  })

  it('a stale-generation callback is rejected even on a live session; the CURRENT generation may ask again', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-tomb-2', {}) as unknown as { processingGeneration: number; questionLifecycleTombstone?: unknown }
    const staleGeneration = managed.processingGeneration
    // Simulate a NEW turn having started (generation bump + tombstone clear —
    // exactly what the turn-start boundary does after a prior stop).
    managed.processingGeneration = staleGeneration + 1
    managed.questionLifecycleTombstone = undefined

    // The OLD turn's callback is stale even though the tombstone is gone.
    const questions = makeQuestionRequest('f-tomb-2-old').questions
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, questions, staleGeneration)).rejects.toThrow(/no longer active/)
    expect(sm.getPendingQuestion('f-tomb-2')).toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(0)

    // The CURRENT turn may legitimately ask — the gate is generation-scoped.
    const current = makeQuestionRequest('f-tomb-2-new').questions
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, current, managed.processingGeneration)).resolves.toBeUndefined()
    expect(sm.getPendingQuestion('f-tomb-2')).not.toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)
  })

  // ---- the completed tool activity and the
  // pending question commit in the SAME durable flush — a visible question
  // can never hydrate with an activity still stuck on 'executing'.

  it('a failed question commit rolls the tool activity back to executing; a successful commit hydrates completed + pending together', async () => {
    patchPrivateFlush()
    // The executing activity lives on DISK (the production shape) — hydration
    // inside the callback reloads messages from the stored session.
    const toolMessage = {
      id: 'tool-act-1',
      role: 'tool',
      type: 'tool',
      toolName: 'mcp__session__request_user_input',
      toolStatus: 'executing',
      content: '',
      timestamp: Date.now(),
    }
    const managed = seedSession('f-toolact-1', { messages: [toolMessage] }) as unknown as {
      messages: Array<{ toolName?: string; toolStatus?: string; content?: string }>
    }

    // FIRST attempt: the single durable commit fails.
    failFlush = true
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, makeQuestionRequest('f-toolact-1').questions, 0)).rejects.toThrow(/NOT paused/)

    // FULL rollback: the activity is executing again, no pending, no events,
    // and the disk is consistent (no visible question, activity not completed).
    const toolMsg = managed.messages.find(m => m.toolName?.includes('request_user_input'))
    expect(toolMsg?.toolStatus).toBe('executing')
    expect(toolMsg?.content).toBe('')
    expect(sm.getPendingQuestion('f-toolact-1')).toBeNull()
    expect(events.filter(e => e.type === 'question_request' || e.type === 'complete')).toHaveLength(0)
    const headerDuringFault = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-toolact-1'), 'utf-8').split('\n')[0])
    expect(headerDuringFault.pendingQuestion).toBeUndefined()
    const storedDuringFault = loadSession(tmpRoot, 'f-toolact-1')
    const storedToolDuringFault = (storedDuringFault?.messages ?? []).find(m => (m as { toolName?: string }).toolName?.includes('request_user_input'))
    expect((storedToolDuringFault as { toolStatus?: string } | undefined)?.toolStatus).toBe('executing')

    // Retry with a healthy flush: ONE commit makes BOTH durable.
    failFlush = false
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, makeQuestionRequest('f-toolact-1-retry').questions, 0)).resolves.toBeUndefined()

    expect(toolMsg?.toolStatus).toBe('completed')
    expect(toolMsg?.content).toBe('Waiting for user input')
    expect(sm.getPendingQuestion('f-toolact-1')).not.toBeNull()

    // Restart hydration reads exactly this state: pending badge + COMPLETED
    // activity — never 'executing' under a visible question.
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-toolact-1'), 'utf-8').split('\n')[0])
    expect(header.hasPendingQuestion).toBe(true)
    const stored = loadSession(tmpRoot, 'f-toolact-1')
    const storedTool = (stored?.messages ?? []).find(m => (m as { toolName?: string }).toolName?.includes('request_user_input'))
    expect((storedTool as { toolStatus?: string } | undefined)?.toolStatus).toBe('completed')
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)
  })

  // ---- the tombstone does not depend on a
  // pending question existing. A stop with NO active question still terminates
  // the question scope (the callback may not have arrived yet).

  it('a stop with NO active question still tombstones the lifecycle; the late callback is rejected', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-tomb-3', { isProcessing: false }) as unknown as { processingGeneration: number }
    const generation = managed.processingGeneration

    // Stop with nothing pending: no clear, no cancel broadcast — but the
    // lifecycle still terminates the question scope.
    await sm.cancelProcessing('f-tomb-3')
    expect(sm.getPendingQuestion('f-tomb-3')).toBeNull()
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(0)

    // The old agent's callback arrives late — the tombstone must reject it.
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, makeQuestionRequest('f-tomb-3-late').questions, generation)).rejects.toThrow(/terminally stopped/)

    expect(sm.getPendingQuestion('f-tomb-3')).toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(0)
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(0)
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-tomb-3'), 'utf-8').split('\n')[0])
    expect(header.pendingQuestion).toBeUndefined()
    expect(header.hasPendingQuestion).toBe(false)
  })

  // ---- the archive lifecycle snapshot is read
  // INSIDE the lock. While the archive waits, an in-flight answer can fail and
  // roll the pending question back — a pre-lock snapshot would clobber that
  // restored pending with a stale value on the archive's own rollback.

  it('archive queued behind a failing answer: rollback restores the answer\u2019s restored pending (no stale-snapshot clobber); the retry converges', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-arch-race')
    const managed = seedSession('f-arch-race', { pendingQuestion: request }) as unknown as {
      pendingAgentResume?: { messageId: string; attempts: number } | undefined
    }
    ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}

    // Flush injection: call #1 (the answer commit) HANGS; call #2 (the
    // archive's unified commit) FAILS; everything after is healthy.
    const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
    let flushCalls = 0
    let settleAnswerFlush!: (err?: Error) => void
    const hungAnswerFlush = new Promise<void>((resolve, reject) => {
      settleAnswerFlush = (err?: Error) => (err ? reject(err) : resolve())
    })
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
      flushCalls++
      if (flushCalls === 1) return hungAnswerFlush
      // #2 = the answer rollback's best-effort re-persist, #3 = the archive's
      // unified commit — both fail; everything after is healthy.
      if (flushCalls === 2 || flushCalls === 3) return Promise.reject(new Error('disk full (injected)'))
      return realFlush.call(sm, id)
    }

    // The answer holds the lock with its flush hung; memory already shows the
    // intermediate state (pending cleared, resume armed).
    const answerPromise = sm.respondToQuestion('f-arch-race', makeAnswerResolution(request))
    await new Promise(r => setTimeout(r, 30))

    // The archive is called NOW — a pre-lock snapshot would read the
    // intermediate state (pending=undefined, resume=armed) as "prev".
    const archivePromise = sm.archiveSession('f-arch-race')
    await new Promise(r => setTimeout(r, 30))

    // The answer's flush FAILS: the resolution rolls back — pending is
    // RESTORED and the resume state disarmed — then releases the lock.
    settleAnswerFlush(new Error('disk full (injected)'))
    expect(await answerPromise).toMatchObject({ status: 'transient_failure' })
    expect(sm.getPendingQuestion('f-arch-race')?.requestId).toBe(request.requestId)
    expect(managed.pendingAgentResume).toBeUndefined()

    // The archive then runs on the SETTLED world: its own flush fails too, and
    // its rollback must reflect the lock-observed state — the restored pending
    // survives, nothing stale is written back, nothing is broadcast.
    await expect(archivePromise).rejects.toThrow('disk full')
    expect(sm.getPendingQuestion('f-arch-race')?.requestId).toBe(request.requestId)
    expect(managed.pendingAgentResume).toBeUndefined()
    expect(events.filter(e => e.type === 'question_resolved' || e.type === 'session_archived')).toHaveLength(0)
    const headerDuringFault = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-arch-race'), 'utf-8').split('\n')[0])
    expect(headerDuringFault.pendingQuestion?.requestId).toBe(request.requestId)

    // Retry with a healthy flush: one durable convergence.
    failFlush = false
    await sm.archiveSession('f-arch-race')
    expect(sm.getPendingQuestion('f-arch-race')).toBeNull()
    const resolved = events.filter(e => e.type === 'question_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ sessionId: 'f-arch-race', requestId: request.requestId, action: 'cancel' })
    expect(events.filter(e => e.type === 'session_archived')).toHaveLength(1)
  })

  // ---- deletion LINEARIZATION. The delete's
  // declaration (tombstone + availability removal) lives INSIDE the
  // question-state lock, so it is mutually exclusive with the sendMessage
  // owner transaction and with resolution commits — whichever acquires the
  // lock first wins, and no intermediate state is visible.

  it('a resolution that queues AHEAD of the delete declaration commits; the delete then completes after it', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-del-1')
    seedSession('f-del-1', { pendingQuestion: request })

    // Hold the question-state lock so the resolution must queue.
    let releaseLock!: () => void
    const hungLock = new Promise<void>(resolve => { releaseLock = resolve })
    void (sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<void>) => Promise<void> })
      .withQuestionStateLock('f-del-1', () => hungLock)

    // The resolution queues FIRST — it acquires the lock before the delete's
    // declaration, so it commits legitimately.
    const answerPromise = sm.respondToQuestion('f-del-1', makeAnswerResolution(request))
    await new Promise(r => setTimeout(r, 30))

    const deletePromise = sm.deleteSession('f-del-1')
    await new Promise(r => setTimeout(r, 10))
    releaseLock()

    expect(await answerPromise).toEqual({ status: 'accepted' })
    await deletePromise

    // The delete then converges everything: storage copy removed.
    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-1'))).toBe(false)
    expect(loadSession(tmpRoot, 'f-del-1')).toBeNull()
  })

  // ---- the DELETE-START gate. The marker is
  // established synchronously at the first instant of deletion — a resolution
  // that was already queued when the delete began observes session_missing,
  // even though its own lock turn runs BEFORE the delete's cleanup.

  it('a resolution that queues BEHIND the delete declaration observes session_missing (no persistence, no events)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-del-2')
    seedSession('f-del-2', { pendingQuestion: request })

    // Hold the lock; the DELETE's declaration queues FIRST.
    let releaseLock!: () => void
    const hungLock = new Promise<void>(resolve => { releaseLock = resolve })
    void (sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<void>) => Promise<void> })
      .withQuestionStateLock('f-del-2', () => hungLock)

    const deletePromise = sm.deleteSession('f-del-2')
    await new Promise(r => setTimeout(r, 30))

    // The resolution queues SECOND — it commits after the declaration
    // (tombstone + availability removal) and must observe session_missing.
    const answerPromise = sm.respondToQuestion('f-del-2', makeAnswerResolution(request))
    await new Promise(r => setTimeout(r, 30))
    releaseLock()

    expect(await answerPromise).toEqual({ status: 'session_missing' })
    await deletePromise

    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-2'))).toBe(false)
    expect(events.filter(e => e.type === 'question_resolved' || e.type === 'user_message')).toHaveLength(0)
  })

  // ---- a send that
  // arrives after the deletion completed is rejected — the session is
  // unavailable and nothing is resurrected.

  it('a sendMessage after the deletion completes is rejected (session unavailable)', async () => {
    patchPrivateFlush()
    seedSession('f-del-turn', {})

    await sm.deleteSession('f-del-turn')

    await expect(sm.sendMessage('f-del-turn', 'late message', [], [], { invocationSource: 'desktop' }))
      .rejects.toThrow()
    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-turn'))).toBe(false)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
  })

  // ---- linearization (b) — the
  // sendMessage transaction acquires the lock BEFORE the delete's
  // declaration, so the user message commits (persisted + ONE accepted
  // broadcast). The delete declaration then lands, and the round-12 lazy
  // agent creation gate refuses the agent — the turn converges as deleted
  // (no ghost turn), and the delete's cleanup converges the storage.

  it('linearization (b): the send transaction commits first, but the delete declaration blocks lazy agent creation (turn converges as deleted)', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-del-resv', {}) as unknown as { questionLifecycleTombstone?: { reason: string }; turnStartReserved?: boolean; isProcessing: boolean }
    let agentCreations = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      agentCreations++
      return makeFakeAgent()
    }

    // Hold the question lock: the send claims its reservation synchronously
    // and parks at the critical-section entry; the delete's declaration then
    // queues BEHIND it.
    let releaseLock!: () => void
    const hungLock = new Promise<void>(resolve => { releaseLock = resolve })
    void (sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<void>) => Promise<void> })
      .withQuestionStateLock('f-del-resv', () => hungLock)

    const sendPromise = sm.sendMessage('f-del-resv', 'winning message', [], [], { invocationSource: 'desktop' })
    await new Promise(r => setTimeout(r, 30))
    expect(managed.turnStartReserved).toBe(true)

    const deletePromise = sm.deleteSession('f-del-resv')
    await new Promise(r => setTimeout(r, 30))

    releaseLock()
    // T1: the send transaction commits — exactly one accepted broadcast.
    // T2: the delete declaration lands. T3: the lazy agent creation gate
    // observes the deletion and refuses — the turn converges as deleted
    // (no ghost turn, no agent creation).
    await waitForCondition(() => getManaged('f-del-resv') === undefined, 3000).catch(() => {})
    // The lazy agent creation gate converges the turn SILENTLY as deleted
    // (no rejection surface, no ghost turn, no agent creation).
    await sendPromise
    expect(agentCreations).toBe(0)
    expect(events.filter(e => e.type === 'user_message' && (e as { status?: string }).status === 'accepted')).toHaveLength(1)

    // The delete MUST complete; the tombstone MUST stay terminal.
    await deletePromise
    expect(managed.questionLifecycleTombstone?.reason).toBe('deleted')
    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-resv'))).toBe(false)
  })

  // ---- linearization (a) — the delete's
  // declaration acquires the lock BEFORE the sendMessage critical section, so
  // the send observes the tombstone BEFORE any persistence: no message, no
  // broadcast, reservation released, session_missing.

  it('linearization (a): a delete declaration that precedes the sendMessage critical section aborts the send (no persist, no broadcast)', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-del-gap', {}) as unknown as {
      questionLifecycleTombstone?: { reason: string }
      turnStartReserved?: boolean
      isProcessing: boolean
      messages: Array<Record<string, unknown>>
    }

    // Hold the lock: the DELETE's declaration queues FIRST; the send's
    // critical section queues behind it.
    let releaseLock!: () => void
    const hungLock = new Promise<void>(resolve => { releaseLock = resolve })
    void (sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<void>) => Promise<void> })
      .withQuestionStateLock('f-del-gap', () => hungLock)

    const deletePromise = sm.deleteSession('f-del-gap')
    await new Promise(r => setTimeout(r, 30))

    let acked = false
    const sendPromise = sm.sendMessage(
      'f-del-gap', 'racing message', [], [],
      { invocationSource: 'desktop' },
      undefined,
      undefined,
      () => { acked = true },
    )
    await new Promise(r => setTimeout(r, 30))
    expect(managed.turnStartReserved).toBe(true)

    releaseLock()
    // The declaration ran first — the send's section re-validates and aborts
    // BEFORE any persistence or broadcast.
    await expect(sendPromise).rejects.toThrow(/session_missing/)

    expect(acked).toBe(false)
    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(0)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
    expect(managed.questionLifecycleTombstone?.reason).toBe('deleted')
    expect(managed.turnStartReserved).toBe(false)
    expect(managed.isProcessing).toBe(false)

    await deletePromise
    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-gap'))).toBe(false)
  })

  // ---- the session MCP/Codex callback chain
  // lands in the SAME durable handoff — a parsed question_requested stderr
  // message drives handleQuestionRequested (persist + broadcast + handoff).

  it('a session MCP question_requested callback drives the durable handoff (persist + question_request)', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-mcp-cb', { isProcessing: true, withAgent: true }) as unknown as { processingGeneration: number }
    const { parseSessionMcpCallbackLine, isQuestionRequestedCallback } = await import('@polo-ai/shared/agent')

    // Simulate the session MCP server's stderr line for THIS turn's tool call.
    const payload = {
      __callback__: 'question_requested',
      sessionId: 'f-mcp-cb',
      questions: makeQuestionRequest('f-mcp-cb').questions,
      generationAtRequest: managed.processingGeneration,
    }
    const parsed = parseSessionMcpCallbackLine(`__CALLBACK__${JSON.stringify(payload)}`)
    expect(isQuestionRequestedCallback(parsed!)).toBe(true)
    if (!isQuestionRequestedCallback(parsed!)) return

    // The host routes the parsed callback into the durable handoff.
    await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void> })
      .handleQuestionRequested(managed, parsed.questions as never, parsed.generationAtRequest)

    // Durable: pending question authoritative + renderer notified.
    expect(sm.getPendingQuestion('f-mcp-cb')).not.toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-mcp-cb'), 'utf-8').split('\n')[0])
    expect(header.hasPendingQuestion).toBe(true)
  })

  // ---- the PRODUCTION callback router — the
  // host HTTP route that the session MCP server POSTs to — lands in the same
  // durable handoff and answers with the protocol result.

  it('the session MCP callback router routes /request-user-input into the durable handoff (accepted + session_missing)', async () => {
    const { createSessionMcpCallbackHandler } = await import('./session-mcp-callback-router.ts')
    const handler = createSessionMcpCallbackHandler(sm)
    const managed = seedSession('f-mcp-cb-2', { isProcessing: true, withAgent: true }) as unknown as { processingGeneration: number }
    const request = makeQuestionRequest('f-mcp-cb-2')

    const server = Bun.serve({
      port: 0,
      fetch: req => handler(req),
    })
    try {
      // ACCEPTED: the payload routes into the durable handoff.
      const accepted = await fetch(
        `http://localhost:${server.port}/request-user-input`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'f-mcp-cb-2',
            questions: request.questions,
            generationAtRequest: managed.processingGeneration,
          }),
        },
      )
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({ status: 'accepted' })
      expect(sm.getPendingQuestion('f-mcp-cb-2')).not.toBeNull()
      expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)

      // SESSION_MISSING: a payload for an unknown session degrades honestly.
      const missing = await fetch(
        `http://localhost:${server.port}/request-user-input`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'no-such-session',
            questions: request.questions,
            generationAtRequest: 0,
          }),
        },
      )
      expect(missing.status).toBe(200)
      expect(await missing.json()).toEqual({ status: 'session_missing' })

      // Unknown paths are not routed.
      const notFound = await fetch(`http://localhost:${server.port}/other`, { method: 'POST' })
      expect(notFound.status).toBe(404)
    } finally {
      server.stop(true)
    }
  })

  // ---- Ownership: the per-turn sidecar is the EXTERNAL engine's channel
  // (gated to externally registered sessions); the EMBEDDED agent wiring goes
  // DIRECT to the durable handoff and never runs a sidecar — one
  // owner/channel per engine, no stdio/HTTP callback loop, no double delivery.

  it('embedded sessions spawn NO per-turn sidecar and their agent wiring goes DIRECT to the durable handoff (single channel)', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-wire-1', {}) as unknown as { processingGeneration: number }
    // A fully functional fake agent runs the turn; the question field is
    // wired EXACTLY like the production onQuestionRequested wiring (direct
    // durable routing via routeAgentQuestionRequested).
    const fake = makeFakeAgent()
    fake.onQuestionRequested = (questions: unknown[], generation: number) =>
      (sm as unknown as {
        routeAgentQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void>
      }).routeAgentQuestionRequested(managed, questions, generation)
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => fake

    const entryPath = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'session-mcp-server', 'src', 'index.ts')
    await sm.startSessionMcpHost({ serverEntryPath: entryPath, nodeRuntimePath: process.execPath })

    // An embedded session is NOT registered for external consumption: the
    // config surface fails closed and the turn spawns NO sidecar — the
    // in-process registry is its single owner/channel, structurally.
    expect(await sm.getSessionExternalModelToolset('f-wire-1', 'desktop', managed.processingGeneration)).toBeNull()
    await sm.sendMessage('f-wire-1', 'turn one', [], [], { invocationSource: 'desktop' })
    const host = (sm as unknown as { sessionMcpHost: { children: Map<string, unknown> } | null }).sessionMcpHost
    expect(host?.children.has('f-wire-1')).toBe(false)

    // The model calls the tool — the embedded wiring lands DIRECTLY in the
    // durable handoff.
    const request = makeQuestionRequest('f-wire-1')
    await (fake.onQuestionRequested as ((q: unknown[], g: number) => Promise<void>) | undefined)!(
      request.questions as never,
      managed.processingGeneration,
    )
    const pending = sm.getPendingQuestion('f-wire-1')
    expect(pending).not.toBeNull()
    // ONE tool call → exactly ONE durable handoff.
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)

    // Terminal: answering settles the question.
    await sm.respondToQuestion('f-wire-1', makeAnswerResolution(pending!))
    expect(sm.getPendingQuestion('f-wire-1')).toBeNull()

    sm.stopSessionMcpHost()
  }, 30000)

  // ---- node host adversarial — body size
  // limit (413) and deterministic listen-failure rejection.

  it('real host: a valid JSON body behind a non-JSON Content-Type is rejected with 415 and NEVER reaches the durable handoff', async () => {
    seedSession('f-node-ctype', {})
    const request = makeQuestionRequest('f-node-ctype')
    const port = await sm.startSessionMcpHost({ serverEntryPath: join(tmpRoot, 'e.js') })

    // A simple cross-origin text/plain POST needs no CORS preflight — the
    // state-changing loopback endpoint must reject it before parsing.
    const response = await fetch(`http://127.0.0.1:${port}/request-user-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        sessionId: 'f-node-ctype',
        questions: request.questions,
        generationAtRequest: 0,
      }),
    })
    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: 'Unsupported Media Type: expected application/json' })
    // The durable handoff never saw the payload.
    expect(sm.getPendingQuestion('f-node-ctype')).toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(0)

    // The production consumer's exact media type still works end-to-end.
    const ok = await fetch(`http://127.0.0.1:${port}/request-user-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        sessionId: 'f-node-ctype',
        questions: request.questions,
        generationAtRequest: 0,
      }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ status: 'accepted' })
    expect(sm.getPendingQuestion('f-node-ctype')).not.toBeNull()
    sm.stopSessionMcpHost()
  })

  it('node http host: a 2MiB body is rejected with 413 at the boundary', async () => {
    seedSession('f-node-413', {})
    const port = await sm.startSessionMcpHost({ serverEntryPath: join(tmpRoot, 'e.js') })

    const bigBody = JSON.stringify({
      sessionId: 'f-node-413',
      questions: makeQuestionRequest('f-node-413').questions,
      generationAtRequest: 0,
      padding: 'x'.repeat(2 * 1024 * 1024),
    })
    const response = await fetch(`http://127.0.0.1:${port}/request-user-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigBody,
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Request body too large' })
    // The oversized payload never reached the durable handoff.
    expect(sm.getPendingQuestion('f-node-413')).toBeNull()
    sm.stopSessionMcpHost()
  })

  it('node http host: a port conflict rejects startup deterministically (no uncaught error, no half-open host)', async () => {
    seedSession('f-node-port', {})
    const firstPort = await sm.startSessionMcpHost({ serverEntryPath: join(tmpRoot, 'e.js') })

    // A second host on the SAME port must fail deterministically.
    await expect(sm.startSessionMcpHost({ serverEntryPath: join(tmpRoot, 'e.js'), callbackPort: firstPort }))
      .rejects.toThrow()

    // The first host keeps serving; the failed start left no stray state.
    const response = await fetch(`http://127.0.0.1:${firstPort}/request-user-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'f-node-port', questions: makeQuestionRequest('f-node-port').questions, generationAtRequest: 0 }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'accepted' })
    sm.stopSessionMcpHost()
  })

  // ---- the PRODUCTION host — a listening
  // localhost callback server + per-turn server spawns driven from the
  // sendMessage capability boundary. desktop→messaging→desktop capability
  // switching is expressed in the spawned args; ONE tool call produces ONE
  // durable handoff (the stderr delivery mirror is gone).

  it('session MCP host: desktop→messaging→desktop spawn switching and single-delivery durable handoff', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-host-1', {}) as unknown as { processingGeneration: number }
    let chats = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      chats++
      return makeFakeAgent()
    }

    // Stub server entry + start the production host; the session is
    // registered for external-engine consumption (the sidecar gate).
    const entry = join(tmpRoot, 'session-mcp-stub.js')
    writeFileSync(entry, 'process.exit(0)\n')
    const hostPort = await sm.startSessionMcpHost({ serverEntryPath: entry })
    expect(hostPort).toBeGreaterThan(0)
    sm.markSessionExternalEngine('f-host-1')

    // TURN 1 — desktop: capability ON.
    await sm.sendMessage('f-host-1', 'turn one', [], [], { invocationSource: 'desktop' })
    await waitForCondition(() => chats === 1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec1 = (sm as unknown as { sessionMcpHost: { lastSpawnSpec: { args: string[] } | null } }).sessionMcpHost!.lastSpawnSpec!
    expect(spec1.args).toContain('--allow-request-user-input')
    expect(spec1.args[spec1.args.indexOf('--turn-generation') + 1]!).toBe(String(managed.processingGeneration))
    expect(spec1.args[spec1.args.indexOf('--callback-port') + 1]!).toBe(String(hostPort))

    // TURN 2 — messaging: capability OFF (fail closed, args switched).
    await sm.sendMessage('f-host-1', 'turn two', [], [], { invocationSource: 'messaging' })
    await waitForCondition(() => chats === 2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec2 = (sm as unknown as { sessionMcpHost: { lastSpawnSpec: { args: string[] } | null } }).sessionMcpHost!.lastSpawnSpec!
    expect(spec2.args).not.toContain('--allow-request-user-input')
    expect(spec2.args[spec2.args.indexOf('--turn-generation') + 1]!).toBe(String(managed.processingGeneration))

    // TURN 3 — desktop again: capability back ON.
    await sm.sendMessage('f-host-1', 'turn three', [], [], { invocationSource: 'desktop' })
    await waitForCondition(() => chats === 3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec3 = (sm as unknown as { sessionMcpHost: { lastSpawnSpec: { args: string[] } | null } }).sessionMcpHost!.lastSpawnSpec!
    expect(spec3.args).toContain('--allow-request-user-input')

    // SINGLE DELIVERY: one tool call (one POST to the host route) → exactly
    // one durable handoff: one pending requestId, one question_request event.
    const request = makeQuestionRequest('f-host-1-q')
    const response = await fetch(`http://127.0.0.1:${hostPort}/request-user-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'f-host-1',
        questions: request.questions,
        generationAtRequest: managed.processingGeneration,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'accepted' })

    const pending = sm.getPendingQuestion('f-host-1')
    expect(pending).not.toBeNull()
    // Exactly ONE durable handoff for the single tool call.
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)

    sm.stopSessionMcpHost()
  })

  // ---- The host listener is a node:http server (the Electron main process
  // is a NODE runtime) — a real POST round-trip through the ONLY host path.

  it('host startup listens on node:http with a real POST round-trip', async () => {
    seedSession('f-node-host', {})
    const request = makeQuestionRequest('f-node-host')

    const port = await sm.startSessionMcpHost({
      serverEntryPath: join(tmpRoot, 'whatever-entry.js'),
    })
    expect(port).toBeGreaterThan(0)

    const response = await fetch(`http://127.0.0.1:${port}/request-user-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'f-node-host',
        questions: request.questions,
        generationAtRequest: 0,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'accepted' })
    expect(sm.getPendingQuestion('f-node-host')).not.toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)

    sm.stopSessionMcpHost()
  })

  // ---- the SPAWN-CONFIG↔EXTERNAL-HARNESS↔
  // STDIO↔TOOL↔CALLBACK↔DURABLE-HANDOFF closed loop, cross-process: the
  // harness builds its model MCP config from the PRODUCTION config surface
  // (getSessionExternalModelToolset) and its tool call reaches the durable
  // handoff through its own stdio connection to the spawned server.

  it('cross-process loop: the externally registered session serves request_user_input over the harness stdio config into the durable handoff (ONE requestId)', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const managed = seedSession('f-mcp-loop', {}) as unknown as { processingGeneration: number }
    // The packaged server entry — point at the SOURCE and let the bun
    // runtime execute it (nodeRuntimePath = process.execPath).
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')

    await sm.startSessionMcpHost({
      serverEntryPath: serverEntry,
      nodeRuntimePath: process.execPath,
    })
    // PRODUCTION registration: the session is externally driven; the
    // sendMessage turn spawns and awaits the per-turn sidecar.
    sm.markSessionExternalEngine('f-mcp-loop')
    patchPrivateFlush()
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => makeFakeAgent()
    await sm.sendMessage('f-mcp-loop', 'turn one', [], [], { invocationSource: 'desktop' })

    // The harness model MCP config comes from the PRODUCTION surface.
    const config = await sm.getSessionExternalModelToolset('f-mcp-loop', 'desktop', managed.processingGeneration)
    expect(config).not.toBeNull()
    expect(config!.args).toContain('--allow-request-user-input')

    // The external engine connects per that config and its model discovers
    // the tool in the model-visible toolset.
    const transport = new StdioClientTransport({
      command: config!.command,
      args: config!.args,
      stderr: 'pipe',
    })
    const harness = new Client({ name: 'external-codex-harness', version: '1.0.0' })
    await harness.connect(transport)
    const tools = await harness.listTools()
    expect(tools.tools.map(t => t.name)).toContain('request_user_input')

    // ONE model tool call over the harness config → ONE durable handoff.
    const request = makeQuestionRequest('f-mcp-loop')
    const result = await harness.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('Waiting for user input')

    const pending = sm.getPendingQuestion('f-mcp-loop')
    expect(pending).not.toBeNull()
    expect(pending?.requestId).toEqual(expect.any(String))
    // ONE tool call → exactly ONE durable handoff (single delivery).
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)

    // Terminal: answering settles the question.
    await sm.respondToQuestion('f-mcp-loop', makeAnswerResolution(pending!))
    expect(sm.getPendingQuestion('f-mcp-loop')).toBeNull()

    await harness.close()
    sm.stopSessionMcpHost()
  }, 60000)

  it('cross-process fail-closed: a non-desktop harness config serves no request_user_input tool', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    seedSession('f-mcp-nd', {})
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')

    await sm.startSessionMcpHost({
      serverEntryPath: serverEntry,
      nodeRuntimePath: process.execPath,
    })
    sm.markSessionExternalEngine('f-mcp-nd')
    const config = await sm.getSessionExternalModelToolset('f-mcp-nd', 'messaging', 1)
    expect(config).not.toBeNull()
    expect(config!.args).not.toContain('--allow-request-user-input')

    const transport = new StdioClientTransport({
      command: config!.command,
      args: config!.args,
      stderr: 'pipe',
    })
    const harness = new Client({ name: 'external-codex-harness', version: '1.0.0' })
    await harness.connect(transport)
    const tools = await harness.listTools()
    expect(tools.tools.map(t => t.name)).not.toContain('request_user_input')

    const result = await harness.callTool({ name: 'request_user_input', arguments: { questions: makeQuestionRequest('f-mcp-nd').questions } })
    expect(result.isError).toBe(true)

    expect(sm.getPendingQuestion('f-mcp-nd')).toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(0)
    await harness.close()
    sm.stopSessionMcpHost()
  }, 60000)

  // ---- the "turn committed, lazy agent not
  // yet created" deletion window. A delete that wins the declaration BLOCKS
  // lazy agent creation (in-lock gate) — no ghost turn, no agent leak.

  it('delete interleaved with a SLOW in-flight agent creation: the turn converges before chat — no ghost turn, no agent leak, no cancel exception', async () => {
    patchPrivateFlush()
    seedSession('f-del-agent', {})
    let agentCreations = 0
    let agentDisposed = 0
    let chatStarted = 0
    let resolveCreationStarted!: () => void
    const creationStarted = new Promise<void>(resolve => { resolveCreationStarted = resolve })
    let releaseCreationGate!: () => void
    const creationGate = new Promise<void>(resolve => { releaseCreationGate = resolve })
    // The lazy creation genuinely hangs IN-FLIGHT (production: a cold
    // backend build) until the test releases it — the delete interleaves.
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      agentCreations++
      resolveCreationStarted()
      await creationGate
      // Mirror the real getOrCreateAgent: the created agent is assigned to
      // the session (that is what the convergence gate's dispose targets).
      ;(getManaged('f-del-agent') as unknown as { agent: unknown }).agent = disposableFakeAgent
      return disposableFakeAgent
    }
    const disposableFakeAgent = {
      ...makeFakeAgent(),
      chat: async function* () {
        chatStarted++
        yield { type: 'complete' as const }
      },
      dispose: () => { agentDisposed++ },
    }

    // T1: the send commits its turn and enters the SLOW in-lock creation.
    const sendPromise = sm.sendMessage('f-del-agent', 'message before delete', [], [], { invocationSource: 'desktop' })
    await creationStarted
    expect(agentCreations).toBe(1)
    expect(chatStarted).toBe(0)

    // T2: the delete queues BEHIND the creation's lock and its declaration
    // (tombstone + availability removal) lands the moment creation yields.
    const deletePromise = sm.deleteSession('f-del-agent')
    await new Promise(r => setTimeout(r, 30))
    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-agent'))).toBe(true)

    // Release the slow creation: the delete's declaration runs, the
    // chat-start convergence gate sees the deletion, disposes the fresh
    // agent (no leak) and returns SILENTLY (no error to the caller, no
    // ghost chat on the deleted session).
    releaseCreationGate!()
    await sendPromise
    expect(agentDisposed).toBe(1)
    expect(chatStarted).toBe(0)

    // The delete's own cleanup removes the storage copy.
    await deletePromise
    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-agent'))).toBe(false)
    expect(events.filter(e => e.type === 'user_message' && (e as { status?: string }).status === 'accepted')).toHaveLength(1)
    expect(events.filter(e => e.type === 'error')).toHaveLength(0)
  })

  it('a delete that lands BEFORE the creation gate blocks creation entirely (no ghost turn, no agent leak)', async () => {
    patchPrivateFlush()
    seedSession('f-del-agent-2', {})
    let agentCreations = 0
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      agentCreations++
      return makeFakeAgent()
    }

    // Hold the question lock: the send's critical section queues FIRST (T1);
    // the delete's declaration queues SECOND (T2); the lazy agent creation
    // gate queues THIRD (T3, after the declaration).
    let releaseLock!: () => void
    const hungLock = new Promise<void>(resolve => { releaseLock = resolve })
    void (sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<void>) => Promise<void> })
      .withQuestionStateLock('f-del-agent-2', () => hungLock)

    const sendPromise = sm.sendMessage('f-del-agent-2', 'message before delete', [], [], { invocationSource: 'desktop' })
    await new Promise(r => setTimeout(r, 30))
    const deletePromise = sm.deleteSession('f-del-agent-2')
    await new Promise(r => setTimeout(r, 30))

    releaseLock()
    // T1: the send transaction commits (isProcessing true)…
    await waitForCondition(() => getManaged('f-del-agent-2') === undefined || getManaged('f-del-agent-2').isProcessing === false, 3000).catch(() => {})
    // T2: the declaration lands (tombstone + availability removal).
    // T3: the lazy agent creation gate observes the deletion and converges
    // the turn SILENTLY as deleted — no agent is ever created and no ghost
    // turn runs.
    await sendPromise
    expect(agentCreations).toBe(0)

    await deletePromise
    expect(existsSync(getSessionFilePath(tmpRoot, 'f-del-agent-2'))).toBe(false)
    expect(events.filter(e => e.type === 'user_message' && (e as { status?: string }).status === 'accepted')).toHaveLength(1)
  })

  // ---- the generation is bound to the callback
  // CLOSURE at the issuing turn (agent-stamped at tool-call time). A late
  // callback carrying its ISSUING generation is rejected once a newer turn
  // claimed the session — even with the tombstone cleared, where the old
  // execution-time read would have compared the NEW generation against
  // itself and passed.

  it('a late callback carrying its ISSUING generation is rejected after a newer turn claimed the session', async () => {
    patchPrivateFlush()
    const managed = seedSession('f-tomb-4', {}) as unknown as { processingGeneration: number; questionLifecycleTombstone?: unknown }
    const issuingGeneration = managed.processingGeneration

    // Turn 1 is stopped, then a NEW turn claims the next generation — the
    // production turn-start boundary (bump + tombstone clear + agent re-stamp).
    managed.processingGeneration = issuingGeneration + 1
    managed.questionLifecycleTombstone = undefined

    // The late generation-N callback executes now. Reading the CURRENT
    // generation at execution time would compare N+1 against N+1 and pass;
    // the closure snapshot N must fail the gate.
    await expect((sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown, g: number) => Promise<void> })
      .handleQuestionRequested(managed, makeQuestionRequest('f-tomb-4-late').questions, issuingGeneration)).rejects.toThrow(/no longer active/)

    expect(sm.getPendingQuestion('f-tomb-4')).toBeNull()
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(0)
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

      // Round 8, issue 1: a session-list I/O failure or a hydration failure
      // is TRANSIENT — the lookup must REJECT (RPC error → renderer retries)
      // instead of returning an authoritative null that would release the
      // restore gate and orphan the still-persisted pending question.
      it('storage.list I/O failure rejects as transient (never an authoritative empty)', async () => {
        const request = makeQuestionRequest('f-reach-io')
        seedStoredPopover('f-reach-io', request, { popoverOwner: OWNER_A })

        // Cold-path manager (runtime workspace present, session not in memory).
        const smC = new SessionManager({ workspace: buildWorkspace() })
        const storage = (smC as unknown as { sessionStorage: { list: (root: string) => unknown } }).sessionStorage
        const realList = storage.list.bind(storage)
        storage.list = () => {
          throw new Error('session listing failed (injected)')
        }
        try {
          await expect(smC.getEditPopoverPendingSession('ws_test', OWNER_A))
            .rejects.toThrow('temporarily unavailable')
        } finally {
          storage.list = realList
        }

        // After the transient failure clears, the SAME lookup is authoritative.
        const found = await smC.getEditPopoverPendingSession('ws_test', OWNER_A)
        expect(found?.sessionId).toBe('f-reach-io')
      })

      it('cold-session hydration failure rejects as transient (never an authoritative empty)', async () => {
        const request = makeQuestionRequest('f-reach-hyd')
        seedStoredPopover('f-reach-hyd', request, { popoverOwner: OWNER_A })

        const smC = new SessionManager({ workspace: buildWorkspace() })
        ;(smC as unknown as { getSession: () => Promise<unknown> }).getSession = async () => {
          throw new Error('hydration failed (injected)')
        }
        await expect(smC.getEditPopoverPendingSession('ws_test', OWNER_A))
          .rejects.toThrow('temporarily unavailable')
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
          await (sm2 as unknown as { handleQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void> })
            .handleQuestionRequested(managed, followUp.questions, (managed as unknown as { processingGeneration: number }).processingGeneration)
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

      // a failed durable stamp (or a failed
      // rollback) must REJECT the creation — never hand back a silently
      // unprivileged session. The just-created hidden orphan is removed from
      // memory AND disk, and a retry with the fault cleared succeeds and is
      // fully eligible.
      it('a failed durable stamp rejects the creation and removes the orphan (memory + disk); a retry succeeds eligible', async () => {
        const smS = new SessionManager({ workspace: buildWorkspace() })
        stubAgentCaptureFlag(smS)
        try {
          // Fail exactly the FIRST flushSession call (the stamp flush); the
          // retry creation's flushes succeed.
          const realFlush = (Object.getPrototypeOf(smS) as { flushSession: (id: string) => Promise<void> }).flushSession
          let flushCalls = 0
          ;(smS as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
            flushCalls++
            if (flushCalls === 1) {
              return Promise.reject(new Error('disk full (injected)'))
            }
            return realFlush.call(smS, id)
          }

          // The RPC REJECTS as transient — no silent "created" session.
          await expect((smS as unknown as {
            createEditPopoverSession: (workspaceId: string, options: Record<string, unknown>) => Promise<{ id: string }>
          }).createEditPopoverSession('ws_test', {
            model: 'fast',
            systemPromptPreset: 'mini',
            permissionMode: 'allow-all',
            hidden: true,
            popoverOwner: OWNER_ID,
          })).rejects.toThrow(/temporarily unavailable/)

          // MEMORY: no orphan runtime session remains registered.
          expect((smS as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)

          // DISK: the stored orphan was removed (no session directories left).
          const sessionsDir = join(tmpRoot, 'sessions')
          const leftovers = existsSync(sessionsDir) ? readdirSync(sessionsDir) : []
          expect(leftovers).toEqual([])

          // RETRY: with the fault cleared, the same call succeeds, stamps the
          // trusted origin + owner durably, and the session is eligible.
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

          const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, session.id), 'utf-8').split('\n')[0])
          expect(header.origin).toBe('edit-popover')
          expect(header.popoverOwner).toBe(OWNER_ID)

          await smS.sendMessage(session.id, 'turn on retried popover session', [], [], { invocationSource: 'desktop' })
          expect(flagOf()).toBe(true)
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

      it('reservation in flight while the answer commits: ONE answer message, resume deferred, and the durable owner turn supersedes the recovery (the agent sees the answer in its context)', async () => {
        const factory = makeCountingAgentFactory()
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = factory.getOrCreateAgent
        const request = makeQuestionRequest('f-res-resv')
        seedSession('f-res-resv', { pendingQuestion: { ...request, invocationSource: 'desktop' } })

        // Owner claims the turn start, then stalls BEFORE the round-8
        // critical section (plan-state clear) — the question-state lock stays
        // FREE so the answer can commit while the reservation is held.
        let releaseOwner!: () => void
        planClearGate = new Promise<void>(resolve => { releaseOwner = resolve })
        const ownerSend = sm.sendMessage('f-res-resv', 'owner message', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => getManaged('f-res-resv').turnStartReserved === true)

        // The answer commits while the reservation is held.
        const result = await sm.respondToQuestion('f-res-resv', makeAnswerResolution(request))
        expect(result).toEqual({ status: 'accepted' })
        // Exactly ONE answer message — the deferred resume must not add one.
        expect(answerMessageCount('f-res-resv')).toBe(1)
        expect(getManaged('f-res-resv').pendingAgentResume).toBeDefined()
        // The resume was deferred: no agent turn has started for it.
        expect(factory.chats()).toBe(0)

        // Owner turn proceeds and completes. The owner message was durably
        // persisted BEFORE the answer was committed, so when the owner turn
        // claims its generation the (round-8) durable supersede clears the
        // recovery: the owner turn's context already includes the answer
        // message, and a separate resume turn would double-run it.
        releaseOwner!()
        planClearGate = null
        await ownerSend

        await waitForCondition(() => getManaged('f-res-resv').pendingAgentResume === undefined, 8000)
        expect(answerMessageCount('f-res-resv')).toBe(1)
        expect(factory.chats()).toBe(1) // the owner turn consumed the answer context
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

        // Owner claims, then stalls BEFORE the round-8 critical section.
        let releaseOwner!: () => void
        planClearGate = new Promise<void>(resolve => { releaseOwner = resolve })

        // The OWNER's user-message flush fails (pre-start failure). Call #1
        // is the ANSWER's commit flush (must succeed); call #2 is the
        // owner's — gated to fail.
        let rejectFlush: ((e: Error) => void) | null = null
        const flushGate = new Promise<void>((_resolve, reject) => { rejectFlush = reject })
        // The gate may be rejected slightly before the owner's flush awaits
        // it — swallow the raw rejection so bun doesn't flag it unhandled.
        flushGate.catch(() => {})
        const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
        let flushCalls = 0
        ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
          flushCalls++
          if (flushCalls === 2) return flushGate.then(() => { throw new Error('pre-start flush failed (injected)') })
          return realFlush.call(sm, id)
        }
        const ownerSend = sm.sendMessage('f-res-owner-fail', 'owner message', [], [], { invocationSource: 'desktop' })
        await waitForCondition(() => getManaged('f-res-owner-fail').turnStartReserved === true)

        // The answer commits while the reservation is held; the resume defers.
        const result = await sm.respondToQuestion('f-res-owner-fail', makeAnswerResolution(request))
        expect(result).toEqual({ status: 'accepted' })
        expect(answerMessageCount('f-res-owner-fail')).toBe(1)
        expect(getManaged('f-res-owner-fail').pendingAgentResume).toBeDefined()
        expect(factory.chats()).toBe(0)

        // The owner turn never starts (pre-start failure).
        releaseOwner!()
        planClearGate = null
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
        await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void> })
          .handleQuestionRequested(managed, questions, (managed as unknown as { processingGeneration: number }).processingGeneration)
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
        await (sm as unknown as { handleQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void> })
          .handleQuestionRequested(managed, questions, (managed as unknown as { processingGeneration: number }).processingGeneration)
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

    // Round 8, issue 2: the pending answer→resume supersede is applied only
    // AFTER the replacement message is durably persisted — a pre-start
    // failure (pending-plan cleanup, lazy load, user-message flush) must
    // preserve the armed recovery so the deferred retry can still complete
    // the answer turn. A successful takeover clears it exactly once.
    describe('supersede recovery consistency (pre-start failures preserve the recovery)', () => {
      const answerMessageCount = (sessionId: string) =>
        (getManaged(sessionId).messages as Array<Record<string, unknown>>)
          .filter(m => (m as { questionResponse?: unknown }).questionResponse).length

      function setupResumeFailureScenario(sessionId: string): { request: ReturnType<typeof makeQuestionRequest> } {
        const request = makeQuestionRequest(sessionId)
        seedSession(sessionId, { pendingQuestion: { ...request, invocationSource: 'desktop' } })

        // The FIRST automatic resume fails pre-chat (agent init) — the
        // recovery is armed and its retry scheduled.
        let agentInits = 0
        ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
          agentInits++
          if (agentInits === 1) throw new Error('first resume init failed (injected)')
          return makeFakeAgent()
        }
        void sm.respondToQuestion(sessionId, makeAnswerResolution(request))
        return { request }
      }

      for (const [label, inject] of [
        ['pending-plan load', 'plan'],
        ['lazy message load', 'lazy'],
        ['user-message flush', 'flush'],
      ] as const) {
        it(`a failed new message at the ${label} stage preserves the armed recovery; the retry completes the answer turn`, async () => {
          patchPrivateFlush()
          const sessionId = `f-sups-${inject}`
          const { request } = setupResumeFailureScenario(sessionId)
          await waitForCondition(() => getManaged(sessionId).pendingAgentResume !== undefined)

          // Failure injection is ARMED right before the superseding send so
          // it hits exactly that call (earlier resume attempts already
          // consumed their own load/flush calls).
          let failArmed = false
          if (inject === 'plan') {
            // clearPendingPlanExecution loads the session JSONL directly via
            // getSessionFilePath → readSessionJsonl — the storage PATH lookup
            // is the injectable seam.
            const storage = (sm as unknown as { sessionStorage: { getSessionFilePath: (root: string, id: string) => string } }).sessionStorage
            const realPath = storage.getSessionFilePath.bind(storage)
            storage.getSessionFilePath = (root: string, id: string) => {
              if (failArmed && id === sessionId) {
                failArmed = false
                throw new Error('plan-state load failed (injected)')
              }
              return realPath(root, id)
            }
          } else if (inject === 'lazy') {
            ;(sm as unknown as { ensureMessagesLoaded: () => Promise<void> }).ensureMessagesLoaded = async () => {
              if (failArmed) {
                failArmed = false
                throw new Error('lazy load failed (injected)')
              }
            }
          } else {
            const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
            ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
              if (failArmed) {
                failArmed = false
                return Promise.reject(new Error('flush failed (injected)'))
              }
              return realFlush.call(sm, id)
            }
          }

          // The superseding send FAILS pre-start…
          failArmed = true
          await expect(sm.sendMessage(sessionId, 'a new user message', [], [], { invocationSource: 'desktop' }))
            .rejects.toThrow(/injected/)

          // …and the armed recovery SURVIVES (supersede never ran).
          expect(getManaged(sessionId).pendingAgentResume).toBeDefined()
          expect(answerMessageCount(sessionId)).toBe(1)

          // The recovery retry eventually completes the answer turn exactly
          // once, and only then clears the recovery.
          await waitForCondition(() => getManaged(sessionId).pendingAgentResume === undefined, 8000)
          expect(answerMessageCount(sessionId)).toBe(1)
          expect(getManaged(sessionId).isProcessing).toBe(false)
        })
      }

      it('a successful takeover supersedes the recovery exactly once (no duplicate answer turn)', async () => {
        patchPrivateFlush()
        const sessionId = 'f-sups-ok'
        setupResumeFailureScenario(sessionId)
        await waitForCondition(() => getManaged(sessionId).pendingAgentResume !== undefined)

        // The user's new message succeeds: it supersedes the recovery…
        await sm.sendMessage(sessionId, 'a new user message', [], [], { invocationSource: 'desktop' })

        // …and the recovery is cleared WITHOUT starting the answer turn: the
        // queued answer retry must find nothing to do.
        await waitForCondition(() => getManaged(sessionId).pendingAgentResume === undefined, 5000)
        expect(answerMessageCount(sessionId)).toBe(1)
        const settledChats = (getManaged(sessionId).messages as Array<Record<string, unknown>>).length
        void settledChats
        await new Promise(r => setTimeout(r, 2500))
        expect(answerMessageCount(sessionId)).toBe(1)
        expect(getManaged(sessionId).pendingAgentResume).toBeUndefined()
      })
    })

    // Concurrent resolutions of the SAME sessionId+requestId serialize on the
    // question-state lock — the ENTIRE durable commit (mutation + flush +
    // rollback) is in-lock, so the loser always reads fully-committed or
    // fully-rolled-back state and never derives a fake outcome. Which caller
    // reaches the lock first is microtask-order (not call-order); the
    // INVARIANT is the outcome SET: exactly one durable commit, the other
    // idempotent.
    describe('resolution serialization (question-state lock)', () => {
      it('concurrent duplicate answers serialize: one accepted commit + one already_answered, ONE answer message', async () => {
        patchPrivateFlush()
        const request = makeQuestionRequest('f-flight-1')
        seedSession('f-flight-1', { pendingQuestion: request })
        ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}

        const p1 = sm.respondToQuestion('f-flight-1', makeAnswerResolution(request))
        const p2 = sm.respondToQuestion('f-flight-1', makeAnswerResolution(request))
        const [r1, r2] = await Promise.all([p1, p2])
        // Exactly ONE submission performs the durable commit; the other reads
        // the durable settled world and succeeds idempotently.
        expect([r1, r2].map(r => r.status).sort()).toEqual(['accepted', 'already_answered'])
        expect(answerMessageCountByFixture('f-flight-1')).toBe(1)
        expect(sm.getPendingQuestion('f-flight-1')).toBeNull()
      })

      it('a broken disk makes EVERY early commit truthfully transient; the pending stays intact and a later retry succeeds', async () => {
        patchPrivateFlush()
        const request = makeQuestionRequest('f-flight-2')
        seedSession('f-flight-2', { pendingQuestion: request })
        ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}

        let diskBroken = true
        const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
        ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
          if (diskBroken) return Promise.reject(new Error('disk full (injected)'))
          return realFlush.call(sm, id)
        }

        const p1 = sm.respondToQuestion('f-flight-2', makeAnswerResolution(request))
        const p2 = sm.respondToQuestion('f-flight-2', makeAnswerResolution(request))
        const [r1, r2] = await Promise.all([p1, p2])
        // Both early commits fail while the disk is broken — each outcome is
        // truthful, the pending question stays intact (rolled back in-lock).
        expect(r1).toEqual({ status: 'transient_failure', message: 'disk full (injected)' })
        expect(r2).toEqual({ status: 'transient_failure', message: 'disk full (injected)' })
        expect(sm.getPendingQuestion('f-flight-2')?.requestId).toBe(request.requestId)
        expect(answerMessageCountByFixture('f-flight-2')).toBe(0)

        // Once the disk recovers, the SAME resolution succeeds — exactly one
        // durable answer message exists.
        diskBroken = false
        const retry = await sm.respondToQuestion('f-flight-2', makeAnswerResolution(request))
        expect(retry).toEqual({ status: 'accepted' })
        expect(sm.getPendingQuestion('f-flight-2')).toBeNull()
        expect(answerMessageCountByFixture('f-flight-2')).toBe(1)
      })

      it('concurrent duplicate cancels serialize too: one cancelled + one already_answered, one cancel record, agent not resumed', async () => {
        patchPrivateFlush()
        const request = makeQuestionRequest('f-flight-3')
        seedSession('f-flight-3', { pendingQuestion: request })
        ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}

        const p1 = sm.respondToQuestion('f-flight-3', { action: 'cancel', requestId: request.requestId })
        const p2 = sm.respondToQuestion('f-flight-3', { action: 'cancel', requestId: request.requestId })
        const [r1, r2] = await Promise.all([p1, p2])
        expect([r1, r2].map(r => r.status).sort()).toEqual(['already_answered', 'cancelled'])
        const cancelRecords = (getManaged('f-flight-3').messages as Array<Record<string, unknown>>)
          .filter(m => (m as { questionResolution?: unknown }).questionResolution)
        expect(cancelRecords).toHaveLength(1)
        expect(sm.getPendingQuestion('f-flight-3')).toBeNull()
      })

      function answerMessageCountByFixture(sessionId: string): number {
        return (getManaged(sessionId).messages as Array<Record<string, unknown>>)
          .filter(m => (m as { questionResponse?: unknown }).questionResponse).length
      }
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

  it('TRUSTED PROBE: while the durable clear flush is pending, the live recovery state stays ARMED (never runtime-cleared + stale disk)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-clear-probe')
    seedSession('f-clear-probe', { pendingQuestion: request })
    const managed = getManaged('f-clear-probe') as unknown as { pendingAgentResume?: { messageId: string; attempts: number } }
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: 'msg-probe', attempts: 0 }

    // Gate the flush: the durable write is in flight while we observe.
    let releaseFlush: (() => void) | null = null
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
      return flushGate.then(() => realFlush.call(sm, id))
    }

    let clearDone = false
    const clearPromise = (sm as unknown as { clearPendingAgentResume: (m: unknown, reason: string) => Promise<void> })
      .clearPendingAgentResume(managed, 'probe').then(() => { clearDone = true })

    // INSIDE the flush window: the live ManagedSession is still ARMED —
    // an observer (or a crash) sees a consistent armed world.
    await new Promise(r => setTimeout(r, 50))
    expect(clearDone).toBe(false)
    expect(managed.pendingAgentResume).toEqual({ messageId: 'msg-probe', attempts: 0 })

    // Durable commit lands → only now is the in-memory clear published.
    releaseFlush!()
    await clearPromise
    expect(clearDone).toBe(true)
    expect(managed.pendingAgentResume).toBeUndefined()
    const header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-clear-probe'), 'utf-8').split('\n')[0])
    expect(header.pendingAgentResume).toBeUndefined()
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = realFlush
  })

  it('durable resume clear is STAGED: the awaited call converges memory + disk; a failed flush rolls the memory back (never runtime-cleared + stale disk)', async () => {
    patchPrivateFlush()
    const request = makeQuestionRequest('f-clear-stage')
    seedSession('f-clear-stage', { pendingQuestion: request })
    const managed = getManaged('f-clear-stage') as unknown as { pendingAgentResume?: { messageId: string; attempts: number } }
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: 'msg-stage', attempts: 0 }

    // SUCCESS: after the awaited clear, an observer sees runtime AND disk
    // converged — the durable completion boundary is deterministic.
    await (sm as unknown as { clearPendingAgentResume: (m: unknown, reason: string) => Promise<void> })
      .clearPendingAgentResume(managed, 'staged clear (success)')
    expect(managed.pendingAgentResume).toBeUndefined()
    let header = JSON.parse(readFileSync(getSessionFilePath(tmpRoot, 'f-clear-stage'), 'utf-8').split('\n')[0])
    expect(header.pendingAgentResume).toBeUndefined()

    // FAILURE: the flush breaks — the in-memory clear is ROLLED BACK so the
    // runtime matches the (still-armed) disk state; the error propagates to
    // the caller (retry / terminal marking).
    let diskBroken = false
    const realFlush = (Object.getPrototypeOf(sm) as { flushSession: (id: string) => Promise<void> }).flushSession
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = (id: string) => {
      if (diskBroken) return Promise.reject(new Error('disk full (injected)'))
      return realFlush.call(sm, id)
    }
    diskBroken = true
    ;(managed as unknown as { pendingAgentResume: unknown }).pendingAgentResume = { messageId: 'msg-stage-2', attempts: 0 }
    await expect((sm as unknown as { clearPendingAgentResume: (m: unknown, reason: string) => Promise<void> })
      .clearPendingAgentResume(managed, 'staged clear (failure)')).rejects.toThrow('disk full (injected)')
    // The live state was never published-cleared — still armed, matching
    // the (still-armed) disk; the caller retries or marks terminal.
    expect(managed.pendingAgentResume).toEqual({ messageId: 'msg-stage-2', attempts: 0 })
    diskBroken = false
    ;(sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession = realFlush
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
