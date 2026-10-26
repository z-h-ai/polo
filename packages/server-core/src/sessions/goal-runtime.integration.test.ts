/**
 * POO-134 goal runtime integration regressions at the REAL SessionManager
 * entry points (controlled Agent — NOT a live-model E2E run).
 *
 * Everything here drives the production `sm.*` methods against the real
 * session JSONL through the official mapper; only the LLM boundary is a
 * controlled harness.
 *
 * Covered:
 * - ICR-1: an internal goal continuation is a SERVER-side scheduling act,
 *   never a user utterance (no Message, no persist, no `user_message`
 *   broadcast, no first-message title, no queue/steer).
 * - ICR-5: a final assistant message produced while the Goal is paused is
 *   never captured as goal-produced (pinned at controller level; asserted
 *   here through the real send path).
 * - late-stop: a goal pause/end whose terminal write AWAITS must never abort
 *   a NEWER turn that legally started inside that window (the abort may only
 *   target the turn captured at entry).
 *
 * Previously these ICR-1/ICR-5 cases lived in the unplanned
 * `goal-internal-continuation.test.ts`; per plan they are hosted here (the
 * plan-authorized runtime-integration path). They ran and passed there before
 * the move; the run logs are retained in the worker artifact directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath, readSessionJsonl } from '@polo-ai/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createGoalRecord, createGoalRuntimeState } from './goal-controller.ts'
import { serializeGoalUpdateReport } from '@polo-ai/session-tools-core'
import type { GoalRecord } from '@polo-ai/shared/protocol'
import type { StoredSession } from '@polo-ai/shared/sessions'

// The merged platform fences the session-event boundary on the committed
// ProductSpace: establish the same runtime context the desktop runtime has so
// `user_message` broadcasts are actually DELIVERED to the sink (the internal
// send's silence is then a real observation, not a suppressed channel).
const { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } = await import('../runtime/product-space-executions')
// The candidate-completion cases below drive a REAL user send, whose
// registration path resolves the trusted account identity (the same
// trusted-start gate the desktop runtime has committed by this point).
const { setTrustedProductSpaceAccountProvider, setSyncTrustedProductSpaceAccountId } = await import('../handlers/rpc/trusted-product-space-account')
// …and whose backend-context resolution must never reach for the MACHINE's
// global default connection (an Admin ProductSpace connection would demand
// the Admin session owner). One process-local user-managed connection keeps
// the resolution hermetic; it is never persisted.
const { setInvocationLlmConnections, clearInvocationLlmConnections } = await import('@polo-ai/shared/config/storage')

const TEST_ACCOUNT_ID = 'account-icr1'
const TEST_SPACE_ID = 'space-icr1'

/** The server-composed continuation prompt. If any implementation detail ever
 *  leaks it into the transcript as user content, this marker finds it. */
const INTERNAL_PROMPT = '[goal internal] Continue working on the objective. Do not ask the user.'

describe('goal internal continuation is never a user message (ICR-1)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<{ type: string; sessionId?: string }>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-internal-'))
    sm = new SessionManager()
    events = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event as { type: string; sessionId?: string })
    }) as never)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
  })

  afterEach(() => {
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seed(sessionId: string, goal: GoalRecord | undefined) {
    const workspace = {
      id: 'ws_goal_internal',
      name: 'Goal Internal Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: sessionId, name: '', createdAt: Date.now() },
      workspace as never,
      { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    if (goal) {
      ;(managed as unknown as { goal: GoalRecord }).goal = goal
      ;(managed as unknown as { goalRuntime: ReturnType<typeof createGoalRuntimeState> }).goalRuntime = {
        ...createGoalRuntimeState(),
        turn: { goalId: goal.id, runGeneration: goal.runGeneration, generation: 1 },
      }
    }
    return managed as unknown as {
      id: string
      goal?: GoalRecord
      goalHistory?: GoalRecord[]
      goalRuntime?: { turn?: unknown }
      isProcessing: boolean
      stopRequested?: boolean
      messages: Array<{ id: string; role: string; content: string }>
      messageQueue: unknown[]
      lastMessageRole?: string
    }
  }

  function activeGoal(sessionId: string, runGeneration = 1): GoalRecord {
    return { ...createGoalRecord({
      sessionId,
      anchorMessageId: 'm-anchor',
      objective: 'Write the report',
      criteria: ['The report exists'],
      now: 1_000,
    }), runGeneration }
  }

  /** The durable transcript, read through the OFFICIAL mapper. */
  function persisted(sessionId: string): StoredSession | null {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return null
    return readSessionJsonl(path)
  }

  function send(sessionId: string, message: string, internalContinuation?: Record<string, unknown>) {
    return sm.sendMessage(
      sessionId,
      message,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      internalContinuation as never,
    )
  }

  it('an internal continuation persists NO user message and broadcasts NO user_message', async () => {
    const sessionId = 'internal-no-user-message'
    const goal = activeGoal(sessionId)
    const managed = seed(sessionId, goal)

    // The minimal harness throws after the turn commit (agent init needs the
    // platform) — that is exactly the post-persist window the durability
    // contract covers: whatever the send had to write is already on disk.
    await send(sessionId, INTERNAL_PROMPT, {
      source: 'automatic',
      goalId: goal.id,
      runGeneration: goal.runGeneration,
    }).catch(() => { /* expected agent-init failure */ })

    // Nothing in memory, nothing on disk, nothing broadcast.
    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(0)
    const stored = persisted(sessionId)
    expect(stored?.messages ?? []).toHaveLength(0)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
    // A first-message title is a USER-send side effect; the internal prompt
    // must never name the session.
    expect(managed.lastMessageRole).toBeUndefined()
    const raw = existsSync(getSessionFilePath(tmpRoot, sessionId))
      ? readFileSync(getSessionFilePath(tmpRoot, sessionId), 'utf-8')
      : ''
    expect(raw).not.toContain(INTERNAL_PROMPT)
  })

  it('a REAL user send on the same session still creates AND broadcasts its user message (contrast)', async () => {
    const sessionId = 'internal-vs-user'
    const goal = activeGoal(sessionId)
    const managed = seed(sessionId, goal)
    // The queue branch (busy session) needs no agent/registration infra: the
    // send creates, persists and broadcasts the user message exactly as the
    // user-path contract requires.
    managed.isProcessing = true

    await send(sessionId, 'please also add a summary section')

    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(1)
    // The OFFICIAL mapper persists the role under `type` (StoredMessage).
    expect(persisted(sessionId)?.messages.map(m => m.type)).toEqual(['user'])
    const broadcasts = events.filter(e => e.type === 'user_message')
    expect(broadcasts).toHaveLength(1)
    expect((broadcasts[0] as unknown as { message: { content: string } }).message.content)
      .toBe('please also add a summary section')
  })

  it('a continuation whose generation no longer matches converges silently (no turn, no write)', async () => {
    const sessionId = 'internal-stale-generation'
    const goal = activeGoal(sessionId, 3)
    const managed = seed(sessionId, goal)

    // The controller scheduled for runGeneration 3, but the goal has since
    // been paused-and-resumed (runGeneration bumped): the stale identity must
    // never start a turn — and must never surface as an error either.
    await send(sessionId, INTERNAL_PROMPT, {
      source: 'automatic',
      goalId: goal.id,
      runGeneration: 2,
    })

    expect(managed.messages).toHaveLength(0)
    expect(persisted(sessionId)?.messages ?? []).toHaveLength(0)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
  })

  it('a continuation for a paused goal converges silently (paused goals drive nothing)', async () => {
    const sessionId = 'internal-paused-goal'
    const goal = { ...activeGoal(sessionId), status: 'paused' as const, pauseReason: 'manual' as const }
    const managed = seed(sessionId, goal)

    await send(sessionId, INTERNAL_PROMPT, {
      source: 'automatic',
      goalId: goal.id,
      runGeneration: goal.runGeneration,
    })

    expect(managed.messages).toHaveLength(0)
    expect(persisted(sessionId)?.messages ?? []).toHaveLength(0)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
  })

  it('a continuation never steers or queues into a live turn as user content', async () => {
    const sessionId = 'internal-no-queue'
    const goal = activeGoal(sessionId)
    const managed = seed(sessionId, goal)
    managed.isProcessing = true

    await send(sessionId, INTERNAL_PROMPT, {
      source: 'automatic',
      goalId: goal.id,
      runGeneration: goal.runGeneration,
    })

    // The pre-fix path queued the internal prompt for FIFO replay — it would
    // have been re-read aloud as a user turn after the live turn ended.
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(0)
    expect(persisted(sessionId)?.messages ?? []).toHaveLength(0)
  })
})

describe('a late goal stop never kills a NEWER turn (real SM entry, controlled flush gate)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<{ type: string; sessionId?: string }>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-late-stop-'))
    sm = new SessionManager()
    events = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event as { type: string; sessionId?: string })
    }) as never)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
  })

  afterEach(() => {
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedActiveGoal(sessionId: string): ReturnType<typeof seedManaged> {
    const goal: GoalRecord = { ...createGoalRecord({
      sessionId,
      anchorMessageId: 'm-anchor',
      objective: 'Write the report',
      criteria: ['The report exists'],
      now: 1_000,
    }), runGeneration: 1 }
    return seedManaged(sessionId, goal)
  }

  function seedManaged(sessionId: string, goal: GoalRecord) {
    const workspace = {
      id: 'ws_goal_late_stop',
      name: 'Goal Late Stop Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: sessionId, name: '', createdAt: Date.now() },
      workspace as never,
      { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    ;(managed as unknown as { goal: GoalRecord }).goal = goal
    return managed as unknown as {
      id: string
      goal?: GoalRecord
      goalHistory?: GoalRecord[]
      goalRuntime?: { turn?: unknown }
      isProcessing: boolean
      stopRequested?: boolean
      messages: Array<{ id: string; role: string; content: string }>
    }
  }

  /** Hold `host.flushSession` so the goal lifecycle command sits INSIDE its
   *  await window with the terminal/pause write already published — exactly
   *  the window a slow disk (or a real flush) creates. */
  function armFlushGate(): { release: () => void; gate: Promise<void> } {
    const host = (sm as unknown as { goalControllerForTests: { host: Record<string, (...args: unknown[]) => unknown> } }).goalControllerForTests.host
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const realFlush = host.flushSession.bind(host)
    host.flushSession = ((...args: unknown[]) => gate.then(() => realFlush(...args))) as never
    return { release, gate }
  }

  /** The state a real `sendMessage` establishes for a NEW turn before agent
   *  init: processing flips true and a fresh turn binding is installed. */
  function admitNewcomerTurn(managed: ReturnType<typeof seedManaged>) {
    managed.isProcessing = true
    ;(managed as unknown as { goalRuntime: { turn?: unknown } }).goalRuntime = {
      turn: { goalId: 'goal-b-newcomer', runGeneration: 1, generation: 99 },
    }
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 5))

  it('goalEnd with NO live turn at entry must NOT abort a turn that starts inside the flush window', async () => {
    const sessionId = 'late-stop-end'
    const managed = seedActiveGoal(sessionId)
    // Turn gap: A is between turns — nothing processing, no live binding.
    managed.isProcessing = false
    ;(managed as unknown as { goalRuntime?: unknown }).goalRuntime = { ...createGoalRuntimeState(), turn: undefined }

    const { release, gate } = armFlushGate()
    const endPromise = sm.goalEnd(sessionId)
    await Promise.race([gate, settle()]) // the terminal write is published; the flush is held
    expect(managed.goal).toBeUndefined() // A has already left the live slot
    expect((managed.goalHistory ?? []).map(r => r.status)).toEqual(['ended'])

    // A new turn legally starts inside the window (same session, new goal).
    admitNewcomerTurn(managed)

    release()
    const outcome = await endPromise
    expect(outcome.ok).toBe(true)
    // The newcomer turn is UNTOUCHED: still processing, never asked to stop,
    // no interrupted event emitted by the end's tail.
    expect(managed.isProcessing).toBe(true)
    expect(managed.stopRequested ?? false).toBe(false)
    expect(managed.goalRuntime?.turn).toEqual({ goalId: 'goal-b-newcomer', runGeneration: 1, generation: 99 })
    expect(events.filter(e => e.type === 'interrupted')).toHaveLength(0)
  })

  it('goalEnd with the entry turn STILL live after the window still aborts it (control)', async () => {
    const sessionId = 'late-stop-end-control'
    const managed = seedActiveGoal(sessionId)
    const entryTurn = { goalId: 'goal-a', runGeneration: 1, generation: 1 }
    managed.isProcessing = true
    ;(managed as unknown as { goalRuntime?: unknown }).goalRuntime = { ...createGoalRuntimeState(), turn: entryTurn }

    const { release } = armFlushGate()
    const endPromise = sm.goalEnd(sessionId)
    await settle()
    release()
    const outcome = await endPromise
    expect(outcome.ok).toBe(true)
    // The SAME turn that was live at entry is aborted, as before.
    expect(managed.stopRequested).toBe(true)
  })

  it('goalPause with NO live turn at entry must NOT abort a turn that starts inside the flush window', async () => {
    const sessionId = 'late-stop-pause'
    const managed = seedActiveGoal(sessionId)
    managed.isProcessing = false
    ;(managed as unknown as { goalRuntime?: unknown }).goalRuntime = { ...createGoalRuntimeState(), turn: undefined }

    const { release, gate } = armFlushGate()
    const pausePromise = sm.goalPause(sessionId)
    await Promise.race([gate, settle()])
    admitNewcomerTurn(managed)

    release()
    const outcome = await pausePromise
    expect(outcome.ok).toBe(true)
    expect(managed.goal?.status).toBe('paused')
    // The newcomer turn survives the pause's tail.
    expect(managed.isProcessing).toBe(true)
    expect(managed.stopRequested ?? false).toBe(false)
    expect(events.filter(e => e.type === 'interrupted')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POO-134 root-cause regression (candidate → own final → settle): a candidate
// recorded at its tool_result must COMPLETE through the deferred independent
// verification at the real turn-completion point. The assistant's own final
// message is server bookkeeping at the real persistence point (F-R2-3/F-R2-4)
// — it is not a user supplement and must never read as one at the settle
// point's version check.
//
// Unlike the controller-level suites, these drive the REAL chat loop end to
// end: real `sendMessage` → real turn binding → real `processEvent`
// (`text_complete` capture) → the real complete-branch settlement inside the
// still-held lease. Only the LLM boundary is a controlled double (the
// scripted verdict is the explicitly-authorized maintenance fake — the
// production `queryLlm` bridge is what is exercised, never bypassed).
// ─────────────────────────────────────────────────────────────────────────────

/** The REAL production wire for a goal_update tool_result: the JSON string of
 *  MCP text content blocks with the marker+JSON escaped inside the block text
 *  (the shape observed in the authorized real-model run). */
function goalUpdateResultText(report: Record<string, unknown>): string {
  return JSON.stringify([{ type: 'text', text: serializeGoalUpdateReport(report as never) }])
}

describe('a correct candidate completes through the independent query (its own final message is not a supplement)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<Record<string, unknown>>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-candidate-final-'))
    sm = new SessionManager()
    events = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
    }) as never)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
    void setTrustedProductSpaceAccountProvider(async () => TEST_ACCOUNT_ID)
    setSyncTrustedProductSpaceAccountId(TEST_ACCOUNT_ID)
    setInvocationLlmConnections([{
      slug: 'goal-loop-test-connection',
      name: 'Goal Loop Test Connection',
      providerType: 'anthropic',
      authType: 'api_key',
      defaultModel: 'goal-loop-test-model',
      createdAt: Date.now(),
    }], 'goal-loop-test-connection')
  })

  afterEach(() => {
    clearInvocationLlmConnections()
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  interface Harness {
    /** Stage a goal_update report through the REAL production channel — the
     *  same `onGoalUpdateReport` callback the backends invoke at tool-call
     *  initiation, carrying the generation snapshotted at that point. */
    report: (report: Record<string, unknown>) => void
    /** Hook that runs between the candidate tool_result and the final message. */
    midTurn?: () => Promise<void>
    queries: Array<{ request: unknown; options: { isolation?: string; signal?: AbortSignal } | undefined }>
    chatCalls: number
  }

  /** Seed a session with a RUNNING goal (an earlier round's captured output on
   *  the record) and a controlled backend whose FIRST turn plays `script` — a
   *  real async event stream through the real chat loop. Later turns (only
   *  reachable while a stale goal keeps being continued) are quiescent. */
  function seedGoalTurn(
    sessionId: string,
    script: (harness: Harness) => AsyncGenerator<Record<string, unknown>>,
    verdict: Record<string, unknown>,
  ) {
    const workspace = {
      id: 'ws_goal_candidate_final',
      name: 'Goal Candidate Final Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: sessionId, name: 'goal candidate final', createdAt: Date.now() },
      workspace as never,
      { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    const goal: GoalRecord = {
      ...createGoalRecord({
        sessionId,
        anchorMessageId: 'm-anchor',
        objective: 'Write the report',
        criteria: ['The report file exists with the summary'],
        now: 1_000,
      }),
      runGeneration: 1,
    }
    // The goal's EARLIER round already produced a captured final message — the
    // citable message evidence this round's candidate cites (server-captured
    // ownership, per F-R2-3/F-R2-4).
    ;(managed as unknown as { messages: Array<Record<string, unknown>> }).messages.push({
      id: 'm-goal-round1', role: 'assistant', content: 'Draft written to docs/report.md.', timestamp: 2_000, isIntermediate: false,
    })
    goal.producedMessageIds = ['m-goal-round1']
    ;(managed as unknown as { goal: GoalRecord }).goal = goal

    const harness: Harness = {
      queries: [],
      chatCalls: 0,
      report: (report) => {
        agent.onGoalUpdateReport?.(report, agent.sessionTurnGeneration)
      },
    }
    const agent = {
      allowRequestUserInput: false,
      allowRenderUi: false,
      allowGenerateApp: false,
      sessionTurnGeneration: 0,
      onGoalUpdateReport: null as ((report: unknown, generationAtRequest: number) => void) | null,
      setSessionTurnGeneration: (generation: number) => { agent.sessionTurnGeneration = generation },
      postInit: async () => ({}),
      // The independent verification query — the production bridge
      // (controller host → managed agent) is what runs; only the ANSWER is
      // scripted, and it is counted.
      queryLlm: async (request: unknown, options: { isolation?: string; signal?: AbortSignal } | undefined) => {
        harness.queries.push({ request, options })
        return { ok: true as const, text: JSON.stringify(verdict) }
      },
      chat: async function* () {
        harness.chatCalls += 1
        if (harness.chatCalls === 1) yield* script(harness)
        yield { type: 'complete' as const }
      },
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
      setTurnQueryLiveSignal: (fn: () => void) => { fn() },
    }
    ;(managed as unknown as { agent: unknown }).agent = agent
    // The production wiring installs this EXACT delegation (wrapped in the
    // session callback guard) inside the agent-construction block; a seeded
    // double skips that block, so the harness installs the same delegation the
    // guarded callback performs — the controller's staging channel, with the
    // generation the tool call was initiated at. Everything downstream
    // (application at the matching tool_result, identity checks, the deferred
    // settlement) is the real production path.
    agent.onGoalUpdateReport = (report: unknown, generationAtRequest: number) => {
      ;(sm as unknown as {
        goalControllerForTests: { stageReport: (m: unknown, r: unknown, g: number) => void }
      }).goalControllerForTests.stageReport(managed, report, generationAtRequest)
    }
    return { managed: managed as unknown as {
      id: string
      goal?: GoalRecord
      goalHistory?: GoalRecord[]
      goalRuntime?: { turn?: { goalId: string; runGeneration: number; generation: number } }
      isProcessing: boolean
      messageQueue: unknown[]
      messages: Array<{ id: string; role: string; isIntermediate?: boolean; content: string }>
    }, harness }
  }

  /** Post-settle hygiene: the assertions read the state EXACTLY where the
   *  send resolves (the settlement is awaited inside the complete branch, and
   *  any continuation a stale goal schedules fires on a later macrotask).
   *  Afterwards this drains that continuation chain — a goal left running by
   *  a discarded candidate legitimately keeps going until it pauses — and
   *  flushes the persistence queue so no write outlives the temp dir. */
  async function drainGoalTurns(sessionId: string) {
    interface DrainView { goal?: { status?: string }; isProcessing: boolean }
    const managed = (sm as unknown as { sessions: Map<string, DrainView> }).sessions.get(sessionId)
    for (let waited = 0; waited < 10_000; waited += 20) {
      const status = managed?.goal?.status
      if (!status || status === 'paused' || status === 'completed' || status === 'ended') break
      if (!managed?.isProcessing && status !== 'active' && status !== 'verifying') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const status = managed?.goal?.status
    if (status === 'active' || status === 'verifying') {
      throw new Error(`goal still ${status} after 10s of draining (${sessionId})`)
    }
    await (sm as unknown as { sessionStorage: { flush: (id: string) => Promise<void> } }).sessionStorage.flush(sessionId)
  }

  function finalMessageIds(): Array<string> {
    return events.filter(e => e.type === 'text_complete' && e.isIntermediate !== true).map(e => String(e.messageId))
  }

  it('candidate tool_result → the assistant’s own final message → complete: the deferred verification runs EXACTLY once and the goal completes', async () => {
    const sessionId = 'candidate-own-final-completes'
    const progress = { kind: 'progress', note: 'writing the report', todos: [{ id: 't1', label: 'Draft the report', status: 'completed' }] }
    const candidate = {
      kind: 'candidate',
      candidate: {
        summary: 'The report is written.',
        evidence: [{ kind: 'message', messageId: 'm-goal-round1' }],
      },
    }
    const { managed, harness } = seedGoalTurn(sessionId, async function* (h) {
      h.report(progress)
      yield { type: 'tool_start', toolUseId: 'tu-progress', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-progress', isError: false, result: goalUpdateResultText(progress) }
      h.report(candidate)
      yield { type: 'tool_start', toolUseId: 'tu-candidate', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-candidate', isError: false, result: goalUpdateResultText(candidate) }
      // The assistant's own final output — the REAL capture point that
      // appends the produced message id. Nothing else happens in between.
      yield { type: 'text_complete', text: 'The report is written.', isIntermediate: false }
    }, {
      overall: 'passed',
      criteria: [{ criterion: 'The report file exists with the summary', passed: true, evidenceIds: [0], note: 'the persisted message states the report is written' }],
      summary: 'Objective satisfied by the session’s own recorded output.',
    })

    await sm.sendMessage(sessionId, 'please finish the report and report completion')

    // The deferred verification ran — once — through the production bridge,
    // under the no-tools isolation contract.
    expect(harness.queries).toHaveLength(1)
    expect(harness.queries[0].options?.isolation).toBe('no-tools')
    expect(harness.queries[0].options?.signal).toBeInstanceOf(AbortSignal)

    // …and its PASSED verdict completed the goal.
    expect(managed.goal).toBeUndefined()
    expect((managed.goalHistory ?? []).map(r => r.status)).toEqual(['completed'])
    const completed = managed.goalHistory![0]
    expect(completed.verification?.status).toBe('passed')

    // The final message WAS captured as the goal's own output (the internal
    // ledger accounting must survive — only its misreading as a supplement
    // is the bug), and the server-validated evidence stayed message-typed.
    expect(completed.producedMessageIds).toContain(finalMessageIds()[0]!)
    expect(completed.candidate?.evidence[0].kind).toBe('message')

    await drainGoalTurns(sessionId)
  })

  it('Plan r2 A.3: the facts captured at the REAL SM point are semantic and scrubbed', async () => {
    const sessionId = 'candidate-semantic-scrubbed-facts'
    const SYNTHETIC = 'sk-test-SYNTHETICSECRET0123456789'
    const progress = { kind: 'progress', note: 'writing the report' }
    const candidate = {
      kind: 'candidate',
      candidate: { summary: 'The report is written.', evidence: [{ kind: 'message', messageId: 'm-goal-round1' }] },
    }
    const { managed } = seedGoalTurn(sessionId, async function* (h) {
      // A huge Write body and a secret-bearing Bash call — the shapes that the
      // old JSON-echo capture stored verbatim into the record.
      yield { type: 'tool_start', toolUseId: 'tu-write', toolName: 'Write', input: { file_path: '/task/docs/report.md', content: 'x'.repeat(2000) } }
      yield { type: 'tool_result', toolUseId: 'tu-write', isError: false, result: 'File created successfully' }
      yield { type: 'tool_start', toolUseId: 'tu-bash', toolName: 'Bash', input: { command: `curl -H "Authorization: Bearer ${SYNTHETIC}" https://api.example.com` } }
      yield { type: 'tool_result', toolUseId: 'tu-bash', isError: false, result: `export KEY=${SYNTHETIC}\nok` }
      h.report(progress)
      yield { type: 'tool_start', toolUseId: 'tu-progress', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-progress', isError: false, result: goalUpdateResultText(progress) }
      h.report(candidate)
      yield { type: 'tool_start', toolUseId: 'tu-candidate', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-candidate', isError: false, result: goalUpdateResultText(candidate) }
      yield { type: 'text_complete', text: 'The report is written.', isIntermediate: false }
    }, {
      overall: 'passed',
      criteria: [{ criterion: 'The report file exists with the summary', passed: true, evidenceIds: [0], note: 'the persisted message states the report is written' }],
      summary: 'Objective satisfied.',
    })

    await sm.sendMessage(sessionId, 'please finish the report and report completion')
    const completed = managed.goalHistory![0]
    const calls = (completed.executionFacts?.facts ?? []).filter(f => f.kind === 'tool_call')
    const write = calls.find(f => f.toolUseId === 'tu-write')
    const bash = calls.find(f => f.toolUseId === 'tu-bash')
    // The Write fact carries the path and the SIZE — never the payload body.
    expect(write?.paramSummary).toContain('/task/docs/report.md')
    expect(write?.paramSummary).toContain('2000')
    expect(write?.paramSummary?.includes('xxxxxx')).toBe(false)
    // The Bash fact is scrubbed (input AND result) while keeping its meaning.
    expect(bash?.paramSummary).not.toContain(SYNTHETIC)
    expect(bash?.paramSummary).toContain('Authorization')
    expect(bash?.resultSummary).not.toContain(SYNTHETIC)
    expect(bash?.resultSummary).toContain('export KEY=')
    // A goal_update report states its real outcome, not a wire echo.
    const applied = calls.find(f => f.toolUseId === 'tu-candidate')
    expect(applied?.resultSummary).toContain('applied')
    expect(applied?.resultSummary?.includes('{')).toBe(false)

    await drainGoalTurns(sessionId)
  })

  it('a REAL user supplement admitted after the candidate still invalidates it — the final message must not refresh the stale candidate', async () => {
    const sessionId = 'candidate-supplement-then-final'
    const progress = { kind: 'progress', note: 'writing the report', todos: [{ id: 't1', label: 'Draft the report', status: 'completed' }] }
    const candidate = {
      kind: 'candidate',
      candidate: {
        summary: 'The report is written.',
        evidence: [{ kind: 'message', messageId: 'm-goal-round1' }],
      },
    }
    /** State read INSIDE the live turn, between the candidate tool_result and
     *  the final message — the exact window under test. */
    const observed: { versionAfterCandidate?: number; statusAfterCandidate?: string; supplementsAfterCandidate?: number } = {}
    const { managed, harness } = seedGoalTurn(sessionId, async function* (h) {
      h.report(progress)
      yield { type: 'tool_start', toolUseId: 'tu-progress', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-progress', isError: false, result: goalUpdateResultText(progress) }
      h.report(candidate)
      yield { type: 'tool_start', toolUseId: 'tu-candidate', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-candidate', isError: false, result: goalUpdateResultText(candidate) }
      observed.versionAfterCandidate = managed.goal!.version
      observed.statusAfterCandidate = managed.goal!.status
      // the driving send itself is already bound (the same-frame turn-start
      // supplement); the mid-turn message is NOT yet.
      observed.supplementsAfterCandidate = managed.goal!.supplementMessageIds.length
      // The user adds a requirement WHILE the turn runs — the REAL mid-stream
      // admission point (persisted user message + supplement binding + version
      // bump), exactly what the queue branch does in production.
      await (sm as unknown as {
        steerOrQueueMidStreamSend: (args: Record<string, unknown>) => Promise<void>
      }).steerOrQueueMidStreamSend({
        managed: managed as never,
        sessionId,
        message: '追加要求：报告必须包含中文摘要',
      })
      // …and only THEN does the assistant produce its own final message.
      yield { type: 'text_complete', text: 'The report is written.', isIntermediate: false }
    }, {
      overall: 'passed',
      criteria: [{ criterion: 'The report file exists with the summary', passed: true, evidenceIds: [0], note: 'stale snapshot must never be accepted' }],
      summary: 'This verdict must be discarded.',
    })

    await sm.sendMessage(sessionId, 'please finish the report and report completion')

    // The window under test really happened: the candidate was recorded
    // (verifying) BEFORE the supplement and the final message.
    expect(observed.statusAfterCandidate).toBe('verifying')
    expect(observed.versionAfterCandidate).toBeGreaterThan(0)
    expect(observed.supplementsAfterCandidate).toBe(1)

    // The mid-turn supplement was admitted FIRST — its version bump precedes
    // the final message, so the candidate snapshot is already stale when the
    // final lands.
    expect(managed.goal?.supplementMessageIds).toHaveLength(2)

    // The stale candidate never reached the verifier — a real user requirement
    // change is exactly what the version check exists for, and the final
    // message that FOLLOWED it must not be able to refresh the candidate past
    // it.
    expect(harness.queries).toHaveLength(0)
    expect(managed.goalHistory ?? []).toHaveLength(0)

    // The goal is running again so the replayed supplement round re-verifies…
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal!.version).toBeGreaterThan(observed.versionAfterCandidate!)
    // …and the final message was STILL captured as the goal's own output
    // (capture semantics are untouched — only its settle-time reading is).
    expect(managed.goal?.producedMessageIds).toContain(finalMessageIds()[0]!)

    await drainGoalTurns(sessionId)
  })

  it('a sub-agent sidechain final (parent_tool_use_id) is NOT the goal’s own output — the main final alone is captured and completes', async () => {
    const sessionId = 'candidate-sidechain-final-not-own-output'
    const progress = { kind: 'progress', note: 'writing the report', todos: [{ id: 't1', label: 'Draft the report', status: 'completed' }] }
    const candidate = {
      kind: 'candidate',
      candidate: {
        summary: 'The report is written.',
        evidence: [{ kind: 'message', messageId: 'm-goal-round1' }],
      },
    }
    const { managed, harness } = seedGoalTurn(sessionId, async function* (h) {
      h.report(progress)
      yield { type: 'tool_start', toolUseId: 'tu-progress', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-progress', isError: false, result: goalUpdateResultText(progress) }
      h.report(candidate)
      yield { type: 'tool_start', toolUseId: 'tu-candidate', toolName: 'mcp__session__goal_update' }
      yield { type: 'tool_result', toolUseId: 'tu-candidate', isError: false, result: goalUpdateResultText(candidate) }
      // Review r1 F1, reachable Claude-backend order: a Task sub-agent's
      // sidechain stream delivers its OWN final text_complete (parent tool id
      // set) BEFORE the main turn's own final. Both are final messages of the
      // transcript; only the main one is THIS goal's output.
      yield { type: 'text_complete', text: 'sub-agent exploration summary', isIntermediate: false, parentToolUseId: 'tu-task' }
      yield { type: 'text_complete', text: 'The report is written.', isIntermediate: false }
    }, {
      overall: 'passed',
      criteria: [{ criterion: 'The report file exists with the summary', passed: true, evidenceIds: [0], note: 'the persisted message states the report is written' }],
      summary: 'Objective satisfied by the session’s own recorded output.',
    })

    await sm.sendMessage(sessionId, 'please finish the report and report completion')

    // The candidate still settled EXACTLY once and completed — neither capture
    // may be misread as a supplement.
    expect(harness.queries).toHaveLength(1)
    expect(managed.goal).toBeUndefined()
    const completed = managed.goalHistory![0]
    expect(completed.status).toBe('completed')
    expect(completed.verification?.status).toBe('passed')

    // Ownership: the sidechain message persisted to the transcript, but never
    // became citable goal evidence — the goal's produced set holds the main
    // final alone. (Capturing the sidechain final double-counted the ledger
    // and, before review r1, discarded good candidates as stale.)
    const sidechainId = String(events.find(e => e.type === 'text_complete' && e.parentToolUseId === 'tu-task')?.messageId)
    const mainId = String(events.find(e => e.type === 'text_complete' && e.parentToolUseId === undefined && e.isIntermediate !== true && e.text === 'The report is written.')?.messageId)
    expect(sidechainId).toBeTruthy()
    expect(mainId).toBeTruthy()
    expect(completed.producedMessageIds).toContain(mainId)
    expect(completed.producedMessageIds).not.toContain(sidechainId)
    // The transcript itself kept BOTH messages — this is an attribution rule,
    // not a transcription one.
    expect(managed.messages.some(m => m.id === sidechainId)).toBe(true)
    expect(managed.messages.some(m => m.id === mainId)).toBe(true)

    await drainGoalTurns(sessionId)
  })
})

describe('Plan r2 B7: a mid-stream goalIntent.start is refused before the redirect', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<{ type: string; sessionId?: string }>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-b7-'))
    sm = new SessionManager()
    events = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event as { type: string; sessionId?: string })
    }) as never)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
  })

  afterEach(() => {
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seed(sessionId: string, goal: GoalRecord) {
    const workspace = {
      id: 'ws_goal_b7',
      name: 'Goal B7 Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: sessionId, name: '', createdAt: Date.now() },
      workspace as never,
      { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    ;(managed as unknown as { goal: GoalRecord }).goal = goal
    ;(managed as unknown as { goalRuntime: ReturnType<typeof createGoalRuntimeState> }).goalRuntime = {
      ...createGoalRuntimeState(),
      turn: { goalId: goal.id, runGeneration: goal.runGeneration, generation: 1 },
    }
    return managed as unknown as {
      id: string
      goal: GoalRecord
      isProcessing: boolean
      messages: Array<{ id: string; role: string; content: string }>
      messageQueue: Array<{ message: string }>
    }
  }

  function goal(sessionId: string, status: GoalRecord['status'], runGeneration = 1): GoalRecord {
    return { ...createGoalRecord({
      sessionId,
      anchorMessageId: 'm-anchor',
      objective: 'Write the report',
      criteria: ['The report exists'],
      now: 1_000,
    }), status, runGeneration }
  }

  function persistedGoal(sessionId: string): GoalRecord | undefined {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return undefined
    return readSessionJsonl(path)?.goal
  }

  function midStreamStart(sessionId: string) {
    return sm.sendMessage(
      sessionId,
      'Actually, start a brand-new goal for something else entirely',
      undefined,
      undefined,
      { goalIntent: { action: 'start' } },
    )
  }

  it('an ACTIVE goal refuses the mid-stream start with the startGoal contract error and nothing moves', async () => {
    const sessionId = 'b7-active'
    const managed = seed(sessionId, goal(sessionId, 'active'))
    managed.isProcessing = true
    const before = managed.goal

    let error: unknown
    try {
      await midStreamStart(sessionId)
    } catch (caught) {
      error = caught
    }
    // The SAME contract text startGoal returns for a second start — the RPC
    // wrapper surfaces it as a pre-persist rejection.
    expect((error as Error | undefined)?.message).toBe('a goal is already active on this session')
    // Not steered, not queued, not admitted as a supplement, not persisted.
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(0)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
    // Nothing durable changed either: the refusal happens before any persist,
    // so the only goal on disk (if this session was ever flushed) is the old one.
    expect(persistedGoal(sessionId)?.id ?? before.id).toBe(before.id)
    // The old Goal is untouched: same record, same version, no supplement.
    expect(managed.goal).toBe(before)
    expect(managed.goal.version).toBe(before.version)
    expect(managed.goal.supplementMessageIds ?? []).toHaveLength(0)
    expect(managed.goal.status).toBe('active')
  })

  it('a VERIFYING goal refuses the mid-stream start without disturbing the in-flight verification', async () => {
    const sessionId = 'b7-verifying'
    const managed = seed(sessionId, goal(sessionId, 'verifying', 2))
    managed.isProcessing = true
    const before = managed.goal

    let error: unknown
    try {
      await midStreamStart(sessionId)
    } catch (caught) {
      error = caught
    }
    expect((error as Error | undefined)?.message).toBe('a goal is already active on this session')
    expect(managed.goal).toBe(before)
    expect(managed.goal.status).toBe('verifying')
    expect(managed.goal.version).toBe(before.version)
    expect(managed.messageQueue).toHaveLength(0)
  })

  it('a PAUSED goal refuses the mid-stream start too (a start is not a resume)', async () => {
    const sessionId = 'b7-paused'
    const managed = seed(sessionId, goal(sessionId, 'paused'))
    managed.isProcessing = true
    const before = managed.goal

    let error: unknown
    try {
      await midStreamStart(sessionId)
    } catch (caught) {
      error = caught
    }
    expect((error as Error | undefined)?.message).toBe('a goal is already active on this session')
    // The pause attribution is preserved exactly — no re-arm, no version bump.
    expect(managed.goal).toBe(before)
    expect(managed.goal.status).toBe('paused')
    expect(managed.goal.version).toBe(before.version)
    expect(managed.messageQueue).toHaveLength(0)
  })

  it('an ordinary mid-stream message is NOT refused (control)', async () => {
    const sessionId = 'b7-chat-control'
    const managed = seed(sessionId, goal(sessionId, 'active'))
    managed.isProcessing = true
    const before = managed.goal

    await sm.sendMessage(sessionId, 'please also mention the deadline in the report')

    // No error, and the ordinary supplement path does its normal work.
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.goal?.id).toBe(before.id)
  })

  it('a TERMINAL goal does not take the refusal — the ordinary mid-stream flow applies', async () => {
    const sessionId = 'b7-terminal'
    const managed = seed(sessionId, goal(sessionId, 'completed', 3))
    managed.isProcessing = true
    const before = managed.goal

    // No throw: a terminal goal no longer owns the session, so the start is
    // not a conflict here; the queued message binds as a NEW goal at replay.
    await midStreamStart(sessionId)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.goal).toBe(before)
  })
})

describe('review F3: a legal goal start during processing is its own turn, never a steer victim', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<Record<string, unknown>>
  /** Every message handed to the controlled agent's redirect — the steer path
   *  the B7 seeds could never exercise (no agent / redirect false). */
  let redirects: string[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-f3-steer-'))
    sm = new SessionManager()
    events = []
    redirects = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
    }) as never)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
    void setTrustedProductSpaceAccountProvider(async () => TEST_ACCOUNT_ID)
    setSyncTrustedProductSpaceAccountId(TEST_ACCOUNT_ID)
    setInvocationLlmConnections([{
      slug: 'goal-loop-test-connection',
      name: 'Goal Loop Test Connection',
      providerType: 'anthropic',
      authType: 'api_key',
      defaultModel: 'goal-loop-test-model',
      // THE connection shape under test: steer (the B7 blind spot — their
      // stubs resolved to queue or to a redirect that returned false).
      midStreamBehavior: 'steer',
      createdAt: Date.now(),
    }], 'goal-loop-test-connection')
  })

  afterEach(() => {
    clearInvocationLlmConnections()
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function waitFor(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
    for (let waited = 0; waited < timeoutMs; waited += 10) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`condition not met within ${timeoutMs}ms: ${what}`)
  }

  /**
   * A REAL SessionManager session with a CONTROLLED agent whose redirect()
   * reports TRUE — the steer connection the B7 seeds (no agent, or a stub
   * returning false) never exercised. The FIRST turn's chat stream waits on a
   * gate the test holds, so the live turn is genuinely mid-flight when the
   * race is exercised; releasing it lets the turn finish naturally and the
   * FIFO replay be observed for real. No network, no model: the answers are
   * not the point of this race.
   */
  function seed(sessionId: string, terminalHistory: GoalRecord[] = []) {
    let firstTurnStarted = false
    let releaseFirstTurn!: () => void
    const firstTurnGate = new Promise<void>(resolve => { releaseFirstTurn = resolve })
    let progressRound = 0
    const workspace = {
      id: 'ws_goal_f3_steer',
      name: 'Goal F3 Steer Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: sessionId, name: '', createdAt: Date.now() },
      workspace as never,
      { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    if (terminalHistory.length > 0) {
      ;(managed as unknown as { goalHistory: GoalRecord[] }).goalHistory = terminalHistory
    }
    const agent = {
      allowRequestUserInput: false,
      allowRenderUi: false,
      allowGenerateApp: false,
      sessionTurnGeneration: 0,
      onGoalUpdateReport: null as ((report: unknown, generationAtRequest: number) => void) | null,
      setSessionTurnGeneration: (generation: number) => { agent.sessionTurnGeneration = generation },
      postInit: async () => ({}),
      queryLlm: async () => ({ ok: true as const, text: '{}' }),
      chat: async function* () {
        // The FIRST turn stays mid-flight until the test releases it; later
        // turns (the replayed goal start) run straight through — and a real
        // goal turn reports progress, so the goal stays active past it.
        if (!firstTurnStarted) {
          firstTurnStarted = true
          await firstTurnGate
        } else {
          // A real agent mints a FRESH tool-use id every round (the runtime
          // deduplicates repeated ids) and reports ADVANCING structured state:
          // the no-progress accounting fingerprints todos/criteria, so a
          // note-only report can never keep a goal active by design.
          progressRound += 1
          const progressId = `tu-f3-progress-${progressRound}`
          const stepStatus = progressRound % 2 === 1 ? 'in_progress' : 'completed'
          const todos = [{ id: 'step-1', label: 'draft the release notes', status: stepStatus }] as const
          agent.onGoalUpdateReport?.({ kind: 'progress', note: 'starting the new goal', todos }, agent.sessionTurnGeneration)
          yield { type: 'tool_start', toolUseId: progressId, toolName: 'mcp__session__goal_update' }
          yield { type: 'tool_result', toolUseId: progressId, isError: false, result: goalUpdateResultText({ kind: 'progress', note: 'starting the new goal', todos }) }
        }
        yield { type: 'text_complete', text: 'ordinary reply', isIntermediate: false }
        yield { type: 'complete' as const }
      },
      getModel: () => 'fake-model',
      getSessionId: () => null,
      isProcessing: () => false,
      supportsBranching: true,
      setAllSources: () => {},
      setSourceServers: async () => {},
      getSummarizeCallback: () => undefined,
      dispose: () => {},
      generateTitle: async () => 'seeded title',
      interruptForHandoff: () => {},
      forceAbort: () => {},
      respondToPermission: () => {},
      setTurnQueryLiveSignal: (fn: () => void) => { fn() },
      // The steer path under test: reports the message WAS delivered into the
      // live turn (as a real steer connection would).
      redirect: (message: string) => {
        redirects.push(message)
        return true
      },
    }
    ;(managed as unknown as { agent: unknown }).agent = agent
    // The production wiring installs this delegation inside the agent
    // construction block; a seeded double skips that block, so the harness
    // installs the same staging channel the guarded callback performs.
    agent.onGoalUpdateReport = (report: unknown, generationAtRequest: number) => {
      ;(sm as unknown as {
        goalControllerForTests: { stageReport: (m: unknown, r: unknown, g: number) => void }
      }).goalControllerForTests.stageReport(managed, report, generationAtRequest)
    }
    return Object.assign(managed as unknown as {
      id: string
      goal?: GoalRecord
      goalHistory?: GoalRecord[]
      goalRuntime?: { turn?: { goalId: string; runGeneration: number; generation: number } }
      isProcessing: boolean
      messageQueue: Array<{ message: string }>
      messages: Array<{ id: string; role: string; content: string }>
    }, { releaseFirstTurn })
  }

  function completedGoal(sessionId: string): GoalRecord {
    return {
      ...createGoalRecord({
        sessionId,
        anchorMessageId: 'm-anchor',
        objective: 'The earlier objective',
        criteria: ['The earlier criterion'],
        now: 1_000,
      }),
      status: 'completed',
      runGeneration: 2,
    }
  }

  it('a goal start sent while an ordinary chat turn processes is queued for its OWN new turn', async () => {
    const sessionId = 'f3-no-goal-start'
    const managed = seed(sessionId)

    // Turn 1: ordinary chat, really started through the SM entry.
    const first = sm.sendMessage(sessionId, 'what does this repo do?')
    await waitFor(() => managed.isProcessing === true, 'the live turn to start')
    expect(managed.goal).toBeUndefined()

    // The legal start arrives mid-turn on a steer connection.
    await sm.sendMessage(
      sessionId,
      'Start a goal: write the release notes',
      undefined,
      undefined,
      { goalIntent: { action: 'start' } },
    )

    // The start must NOT ride the live turn's redirect…
    expect(redirects).toHaveLength(0)
    // …it must be queued with its own options for a real new turn.
    expect(managed.messageQueue).toHaveLength(1)
    // …and no Goal exists yet (the old turn is not a Goal turn).
    expect(managed.goal).toBeUndefined()

    managed.releaseFirstTurn()
    await first
    // The FIFO replay binds a NEW goal through bindTurn/startGoal.
    await waitFor(() => !!managed.goal, 'the queued start to replay into a goal')
    expect(managed.goal?.objective).toBe('Start a goal: write the release notes')
    // The goal turn REALLY ran: its progress report reached the record through
    // the production staging channel (this also settles the no-progress
    // accounting before the status is read).
    await waitFor(
      () => (managed.goal?.executionFacts?.facts ?? []).some(f => f.toolUseId?.startsWith('tu-f3-progress-')),
      'the goal turn to apply its progress report',
    )
    expect(managed.goal?.status).toBe('active')
    // The queued user message IS the goal's anchor — same message identity.
    const anchor = managed.messages.find(m => m.role === 'user' && m.content.includes('Start a goal'))
    expect(managed.goal?.anchorMessageId).toBe(anchor?.id)
    // The new turn is bound to the goal id + run generation that reports
    // against it (the triple every fact/verdict check is keyed on).
    expect(managed.goalRuntime?.turn?.goalId).toBe(managed.goal?.id)
    expect(managed.goalRuntime?.turn?.runGeneration).toBe(managed.goal?.runGeneration)
  })

  it('the same protection holds while a TERMINAL goal drains: the queued start binds a FRESH goal', async () => {
    const sessionId = 'f3-terminal-draining-start'
    const earlier = completedGoal(sessionId)
    const managed = seed(sessionId, [earlier])

    const first = sm.sendMessage(sessionId, 'follow-up question about the finished goal')
    await waitFor(() => managed.isProcessing === true, 'the live turn to start')

    await sm.sendMessage(
      sessionId,
      'Start a new goal: migrate the docs',
      undefined,
      undefined,
      { goalIntent: { action: 'start' } },
    )

    expect(redirects).toHaveLength(0)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.goal).toBeUndefined()

    managed.releaseFirstTurn()
    await first
    await waitFor(() => !!managed.goal, 'the queued start to replay into a goal')
    // A genuinely NEW record — the completed goal in history is untouched.
    expect(managed.goal?.id).not.toBe(earlier.id)
    expect(managed.goal?.objective).toBe('Start a new goal: migrate the docs')
    expect((managed.goalHistory ?? []).map(r => r.id)).toEqual([earlier.id])
  })

  it('a TERMINAL goal still loaded on the session takes the same queue path (no redirect, no supplement)', async () => {
    const sessionId = 'f3-terminal-record-start'
    const earlier = completedGoal(sessionId)
    const managed = seed(sessionId)
    // The cold-load shape the B7 terminal test uses: the completed record is
    // still ON the session (not yet moved to history).
    ;(managed as unknown as { goal: GoalRecord }).goal = earlier

    const first = sm.sendMessage(sessionId, 'a question about the archived goal')
    await waitFor(() => managed.isProcessing === true, 'the live turn to start')

    await sm.sendMessage(
      sessionId,
      'Start a goal: take over the docs',
      undefined,
      undefined,
      { goalIntent: { action: 'start' } },
    )

    // Not steered into the draining turn, not admitted as its supplement.
    expect(redirects).toHaveLength(0)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.goal).toBe(earlier)

    managed.releaseFirstTurn()
    await first
    await waitFor(() => managed.goal?.id !== earlier.id, 'the queued start to bind a fresh goal')
    expect(managed.goal?.objective).toBe('Start a goal: take over the docs')
  })

  it('ordinary chat mid-stream on an ACTIVE goal still steers (the skip is start-only)', async () => {
    const sessionId = 'f3-chat-still-steers'
    const managed = seed(sessionId)
    const active: GoalRecord = {
      ...createGoalRecord({
        sessionId,
        anchorMessageId: 'm-anchor',
        objective: 'Write the report',
        criteria: ['The report exists'],
        now: 1_000,
      }),
      status: 'active',
      runGeneration: 1,
    }
    ;(managed as unknown as { goal: GoalRecord }).goal = active
    ;(managed as unknown as { goalRuntime: ReturnType<typeof createGoalRuntimeState> }).goalRuntime = {
      ...createGoalRuntimeState(),
      turn: { goalId: active.id, runGeneration: active.runGeneration, generation: 1 },
    }
    managed.isProcessing = true

    // An active goal makes this start a contract violation — refused BEFORE
    // the redirect, exactly as the B7 guard promises (now with a steerable
    // agent proving the ordering).
    let error: unknown
    try {
      await sm.sendMessage(sessionId, 'Start a goal: something else', undefined, undefined, { goalIntent: { action: 'start' } })
    } catch (caught) {
      error = caught
    }
    expect((error as Error | undefined)?.message).toBe('a goal is already active on this session')
    expect(redirects).toHaveLength(0)
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.goal).toBe(active)

    // Ordinary chat is still steered into the live turn (control).
    await sm.sendMessage(sessionId, 'also mention the deadline in the report')
    expect(redirects).toEqual(['also mention the deadline in the report'])
    expect(managed.messageQueue).toHaveLength(0)
  })
})
