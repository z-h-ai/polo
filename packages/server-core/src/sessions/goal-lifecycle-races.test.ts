/**
 * POO-134 R2 race regressions at the REAL SessionManager entry points.
 *
 * F-R2-1: the user's pause/end must be the AUTHORITATIVE state before the
 * running turn is aborted — asserted at the actual cancelProcessing await
 * boundary, with the real turn-termination chain (onProcessingStopped →
 * onTurnAborted) fired INSIDE that window, and with attribution-specific
 * assertions (status + pauseReason), never attribution-agnostic ones.
 *
 * F-R2-7: a message accepted while a Goal turn runs is bound to the Goal at
 * its REAL admission point (steerOrQueueMidStreamSend), bumping the goal
 * version so an in-flight verification verdict can no longer complete it.
 *
 * F-R2-3/4: a final assistant message is captured as goal-produced at the
 * REAL persistence point (processEvent text_complete) — and only for the
 * bound goal turn.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { SessionManager, createManagedSession, GOAL_FACT_SUMMARY_CHARS } from './SessionManager.ts'
import { getSessionFilePath, writeSessionJsonl, type StoredSession } from '@polo-ai/shared/sessions'
import { createGoalRecord, createGoalRuntimeState, type GoalRuntimeState } from './goal-controller.ts'
import { parseGoalUpdateReportPayload, serializeGoalUpdateReport } from '@polo-ai/session-tools-core'
import type { GoalRecord } from '@polo-ai/shared/protocol'
// The merged platform fences the session-event boundary on the committed
// ProductSpace: establish the same runtime context the desktop runtime has.
const { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } = await import('../runtime/product-space-executions')
const { setSyncTrustedProductSpaceAccountId } = await import('../handlers/rpc/trusted-product-space-account')

const TEST_ACCOUNT_ID = 'account-r2'
const TEST_SPACE_ID = 'space-r2'

describe('goal lifecycle races at the real SessionManager entries (R2)', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof SessionManager>
  const seededSessionIds = new Set<string>()

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-races-'))
    sm = new SessionManager()
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      void event
    }) as never)
    setSyncTrustedProductSpaceAccountId(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
  })

  afterEach(async () => {
    const queue = (sm as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
    for (const id of seededSessionIds) {
      try { queue.cancel(id) } catch { /* ignore */ }
    }
    seededSessionIds.clear()
    await new Promise(r => setTimeout(r, 650))
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    setSyncTrustedProductSpaceAccountId(null)
  })

  function buildWorkspace() {
    return {
      id: 'ws_r2',
      name: 'R2 Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  function activeGoal(sessionId: string, overrides: Partial<GoalRecord> = {}): GoalRecord {
    return createGoalRecord({
      sessionId,
      anchorMessageId: 'm-anchor',
      objective: 'Write the report',
      criteria: ['The report exists'],
      now: 1_000,
      ...overrides,
    })
  }

  function seedSession(
    sessionId: string,
    opts: { isProcessing?: boolean; goal?: GoalRecord; runtime?: Partial<GoalRuntimeState> } = {},
  ) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'r2 race session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as unknown as StoredSession
    writeSessionJsonl(filePath, stored)

    const managed = createManagedSession(
      { id: sessionId, name: stored.name, createdAt: stored.createdAt },
      buildWorkspace(),
      { productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    ;(managed as unknown as { isProcessing: boolean }).isProcessing = opts.isProcessing ?? false
    ;(managed as unknown as { agent: unknown }).agent = {
      forceAbort: () => {},
      redirect: () => false,
      getModel: () => 'fake-model',
      isProcessing: () => false,
      interruptForHandoff: () => {},
    }
    if (opts.goal) {
      ;(managed as unknown as { goal: GoalRecord }).goal = opts.goal
      ;(managed as unknown as { goalRuntime: GoalRuntimeState }).goalRuntime = {
        ...createGoalRuntimeState(),
        turn: { goalId: opts.goal.id, runGeneration: opts.goal.runGeneration, generation: 1 },
        ...(opts.runtime ?? {}),
      }
    }
    ;(managed as unknown as { processingGeneration: number }).processingGeneration = 1
    // The session is HYDRATED (as after loadSessionsFromDisk): the cold-persist
    // hydrate path would otherwise replace in-memory messages from disk.
    ;(managed as unknown as { messagesLoaded: boolean }).messagesLoaded = true
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    seededSessionIds.add(sessionId)
    return managed as unknown as {
      id: string
      goal?: GoalRecord
      goalHistory?: GoalRecord[]
      goalRuntime?: GoalRuntimeState
      isProcessing: boolean
      processingGeneration: number
      messages: Array<{ id: string; role: string; isIntermediate?: boolean; content: string }>
      messageQueue: unknown[]
    }
  }

  function goalShape(managed: { goal?: GoalRecord }): string {
    return managed.goal ? `${managed.goal.status}/${managed.goal.pauseReason ?? '-'}` : 'none'
  }

  /** Drain microtasks until `probe` turns truthy (the await boundary under test). */
  async function until(probe: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !probe(); i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  it('F-R2-1: goalPause writes the authoritative manual pause BEFORE cancelling the turn, and a racing turn-abort cannot re-attribute it', async () => {
    const managed = seedSession('goal-pause-order', { isProcessing: true, goal: activeGoal('goal-pause-order') })
    const versionBefore = managed.goal!.version

    // Instrument the REAL cancelProcessing so the test can act inside its
    // await window — exactly where the pre-fix code left the goal unwritten.
    const realCancel = sm.cancelProcessing.bind(sm)
    let goalStateAtCancel: string | undefined
    let releaseCancel!: () => void
    const gate = new Promise<void>(resolve => { releaseCancel = resolve })
    sm.cancelProcessing = async (sessionId: string, silent?: boolean) => {
      goalStateAtCancel = goalShape(managed)
      await realCancel(sessionId, silent)
      await gate
    }

    const pausing = sm.goalPause('goal-pause-order')
    await until(() => goalStateAtCancel !== undefined)

    // THE order assertion: the user's intent is authoritative FIRST.
    expect(goalStateAtCancel).toBe('paused/manual')
    expect(managed.goal?.version).toBe(versionBefore + 1)

    // The turn-termination chain fires INSIDE the cancelProcessing await
    // window (setImmediate void onTurnAborted in production): with the old
    // abort-first order it claimed FIRST attribution as 'error'.
    await (sm as unknown as { onProcessingStopped: (id: string, reason: string) => Promise<void> })
      .onProcessingStopped('goal-pause-order', 'interrupted')
    releaseCancel()

    const outcome = await pausing
    expect(outcome.ok).toBe(true)
    // The user's attribution survived the racing abort chain.
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('manual')
  })

  it('F-R2-1: goalEnd writes the terminal state BEFORE cancelling the turn, and a racing turn-abort cannot resurrect it', async () => {
    const managed = seedSession('goal-end-order', { isProcessing: true, goal: activeGoal('goal-end-order') })

    const realCancel = sm.cancelProcessing.bind(sm)
    let goalStateAtCancel: string | undefined
    let releaseCancel!: () => void
    const gate = new Promise<void>(resolve => { releaseCancel = resolve })
    sm.cancelProcessing = async (sessionId: string, silent?: boolean) => {
      goalStateAtCancel = goalShape(managed)
      await realCancel(sessionId, silent)
      await gate
    }

    const ending = sm.goalEnd('goal-end-order')
    await until(() => goalStateAtCancel !== undefined)

    // Terminal state written first: the live slot is already empty.
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory?.[managed.goalHistory.length - 1]?.status).toBe('ended')

    await (sm as unknown as { onProcessingStopped: (id: string, reason: string) => Promise<void> })
      .onProcessingStopped('goal-end-order', 'interrupted')
    releaseCancel()

    const outcome = await ending
    expect(outcome.ok).toBe(true)
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory).toHaveLength(1)
    expect(managed.goalHistory![0].status).toBe('ended')
  })

  it('F-R2-1: the Stop button pauses the goal BEFORE the force-abort (same Plan-locked order)', async () => {
    const managed = seedSession('goal-stop-order', { isProcessing: true, goal: activeGoal('goal-stop-order') })
    const versionBefore = managed.goal!.version
    const agent = (managed as unknown as { agent: { forceAbort: (reason?: unknown) => void } }).agent
    let goalStateAtAbort: string | undefined
    agent.forceAbort = () => {
      goalStateAtAbort = goalShape(managed)
    }

    await sm.cancelProcessing('goal-stop-order', false)

    expect(goalStateAtAbort).toBe('paused/stop')
    expect(managed.goal?.version).toBe(versionBefore + 1)
    expect(managed.goal?.pauseReason).toBe('stop')
  })

  it('F-R2-7: a message accepted while the goal runs is bound at queue admission and bumps the goal version', async () => {
    const managed = seedSession('goal-queue-admission', { isProcessing: true, goal: activeGoal('goal-queue-admission') })
    const versionBefore = managed.goal!.version

    await (sm as unknown as {
      steerOrQueueMidStreamSend: (args: Record<string, unknown>) => Promise<void>
    }).steerOrQueueMidStreamSend({
      managed: managed as never,
      sessionId: 'goal-queue-admission',
      message: '追加要求：报告必须包含中文摘要',
    })

    // Existing queue semantics preserved: FIFO entry with the REAL message id.
    expect(managed.messageQueue).toHaveLength(1)
    const queued = managed.messages.find(m => m.role === 'user')
    expect(queued?.content).toBe('追加要求：报告必须包含中文摘要')
    // The admission binding: the real persisted id is now a Goal supplement.
    expect(managed.goal?.supplementMessageIds).toContain(queued!.id)
    expect(managed.goal?.version).toBe(versionBefore + 1)

    // Replay of the same message never duplicates the supplement.
    expect(sm.goalControllerForTests.admitSupplementFromQueue(managed as never, queued!.id)).toBe(false)
    expect(managed.goal?.supplementMessageIds.filter((id: string) => id === queued!.id)).toHaveLength(1)
  })

  it('F-R2-7: a message sent during a MANUAL pause stays ordinary chat (never stolen into the goal)', async () => {
    const pausedGoal = { ...activeGoal('goal-queue-paused'), status: 'paused' as const, pauseReason: 'manual' as const, runningSince: undefined }
    const managed = seedSession('goal-queue-paused', { isProcessing: true, goal: pausedGoal })
    const versionBefore = pausedGoal.version

    await (sm as unknown as {
      steerOrQueueMidStreamSend: (args: Record<string, unknown>) => Promise<void>
    }).steerOrQueueMidStreamSend({
      managed: managed as never,
      sessionId: 'goal-queue-paused',
      message: 'ordinary chat while paused',
    })

    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.goal?.supplementMessageIds).toHaveLength(0)
    expect(managed.goal?.version).toBe(versionBefore)
    expect(managed.goal?.pauseReason).toBe('manual')
  })

  it('F-R2-3/4: a final assistant message is captured as goal-produced at its real persistence point', async () => {
    const managed = seedSession('goal-capture', { isProcessing: true, goal: activeGoal('goal-capture') })
    const processEvent = (event: Record<string, unknown>) => (
      sm as unknown as { processEvent: (managed: unknown, e: Record<string, unknown>) => Promise<void> }
    ).processEvent.call(sm, managed as never, event)

    // An intermediate chunk is never captured.
    await processEvent({ type: 'text_complete', text: 'intermediate chunk', isIntermediate: true })
    expect(managed.goal?.producedMessageIds ?? []).toHaveLength(0)

    // The FINAL assistant output of the bound goal turn is captured.
    await processEvent({ type: 'text_complete', text: '最终文字成果：完整总结。', isIntermediate: false })
    const final = managed.messages.filter(m => m.role === 'assistant' && m.isIntermediate !== true)
    expect(final.length).toBe(1)
    expect(managed.goal?.producedMessageIds).toEqual([final[0]!.id])

    // A turn bound to nothing (generation mismatch) is not captured.
    ;(managed as unknown as { processingGeneration: number }).processingGeneration = 99
    await processEvent({ type: 'text_complete', text: 'stray turn output', isIntermediate: false })
    expect(managed.goal?.producedMessageIds).toHaveLength(1)
  })

  it('ICR-5: a late final output is NOT captured while the goal is paused', async () => {
    // PROBE C (reviewer-internal-context-risk): the abort-drain window after a
    // clarification pause still delivers a final assistant message from the
    // aborted turn. Pre-fix it was captured as goal-produced — citable
    // "evidence" of a goal the user had just paused.
    const goal = activeGoal('goal-paused-capture')
    const managed = seedSession('goal-paused-capture', { isProcessing: true, goal })
    const processEvent = (event: Record<string, unknown>) => (
      sm as unknown as { processEvent: (managed: unknown, e: Record<string, unknown>) => Promise<void> }
    ).processEvent.call(sm, managed as never, event)
    const pause = (reason: 'awaiting_user' | 'awaiting_permission', detail: string) => (
      sm as unknown as { goalControllerForTests: { pause: (managed: unknown, reason: string, detail?: string) => Promise<unknown> } }
    ).goalControllerForTests.pause(managed as never, reason, detail)

    // The clarification pause (awaiting_user) stops the clock and pauses.
    await pause('awaiting_user', 'Which summary language?')
    expect(managed.goal?.status).toBe('paused')

    // The aborted turn drains a late final message.
    await processEvent({ type: 'text_complete', text: '迟到的最终输出（被中止回合一侧）', isIntermediate: false })
    expect(managed.goal?.producedMessageIds ?? []).toHaveLength(0)
    // It stays an ordinary transcript message — never discarded, never cited.
    expect(managed.messages.some(m => m.content === '迟到的最终输出（被中止回合一侧）')).toBe(true)

    // awaiting_permission is the same status — one check covers every pause
    // attribution; the capture only resumes with a NEW run generation.
    await pause('awaiting_permission', 'waiting for a permission')
    await processEvent({ type: 'text_complete', text: '迟到的最终输出（权限等待回合一侧）', isIntermediate: false })
    expect(managed.goal?.producedMessageIds ?? []).toHaveLength(0)
  })

  it('ICR-2: the bound goal turn records its real tool facts on the server record', async () => {
    // The Agent has no field in any tool schema that writes here: the facts
    // come from the chat loop's observeTurnEvent of REAL tool_start/tool_result
    // events of THIS goal's own turn.
    const goal = activeGoal('goal-facts-record')
    const managed = seedSession('goal-facts-record', { isProcessing: true, goal })
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 1 }
    const observe = (event: Record<string, unknown>) => (
      sm as unknown as {
        goalControllerForTests: {
          observeTurnEvent: (
            managed: unknown,
            event: Record<string, unknown>,
            binding: unknown,
            generation: number,
          ) => Promise<void>
        }
      }
    ).goalControllerForTests.observeTurnEvent(managed as never, event, binding, 1)

    // The SDK emits tool_start TWICE per call (stream_event with empty input,
    // then the assistant message with the complete input): the second one
    // UPSERTS the parameter summary instead of doubling the fact.
    await observe({ type: 'tool_start', toolUseId: 'tu-write', toolName: 'write', inputSummary: '' })
    await observe({ type: 'tool_start', toolUseId: 'tu-write', toolName: 'write', inputSummary: '{"path":"docs/notes.md"}' })
    // A 2000-char tool result is clipped to the server bound, and the clip is
    // announced in the stored text itself.
    await observe({ type: 'tool_result', toolUseId: 'tu-write', isError: false, resultText: 'r'.repeat(2_000) })
    // A sub-agent call keeps its parent link.
    await observe({ type: 'tool_start', toolUseId: 'tu-child', toolName: 'task', parentToolUseId: 'tu-parent-task' })

    // Commit at the pause control transition (the durable point production
    // uses) and read the record.
    await (sm as unknown as { goalControllerForTests: { pause: (managed: unknown, reason: string, detail?: string) => Promise<unknown> } })
      .goalControllerForTests.pause(managed as never, 'awaiting_permission', 'waiting for a permission')
    const record = managed.goal!
    expect(record.executionFacts).toBeDefined()
    const list = record.executionFacts!.facts
    // ONE fact per call for the doubled tool_start, carrying the param summary.
    const startFacts = list.filter(f => f.toolUseId === 'tu-write' && f.paramSummary !== undefined)
    expect(startFacts).toHaveLength(1)
    expect(startFacts[0]!.toolName).toBe('write')
    expect(startFacts[0]!.paramSummary).toBe('{"path":"docs/notes.md"}')
    // The paired result fact: bounded summary + explicit truncation marker.
    const resultFact = list.find(f => f.toolUseId === 'tu-write' && f.resultSummary !== undefined)
    expect(resultFact?.isError).toBe(false)
    expect(resultFact?.resultSummary).toContain('[truncated: 2000 chars total]')
    // The sub-agent call keeps its parent link — it is never presented as the
    // goal's own turn work.
    const child = list.find(f => f.toolUseId === 'tu-child')
    expect(child?.parentToolUseId).toBe('tu-parent-task')
    // The control transition itself is a recorded fact.
    expect(list.some(f => f.kind === 'paused' && f.detail?.startsWith('awaiting_permission'))).toBe(true)
    expect(record.executionFacts!.truncated).toBe(false)
    // The SM-side bound for host-supplied parameter summaries (the production
    // clip point in the chat loop).
    expect(GOAL_FACT_SUMMARY_CHARS).toBe(400)
  })

  it('ICR-2: more facts than the cap truncate EXPLICITLY (keep-first, dropped count)', async () => {
    const goal = activeGoal('goal-facts-cap')
    const managed = seedSession('goal-facts-cap', { isProcessing: true, goal })
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 1 }
    const controller = (sm as unknown as { goalControllerForTests: {
      observeTurnEvent: (managed: unknown, event: Record<string, unknown>, binding: unknown, generation: number) => Promise<void>
      pause: (managed: unknown, reason: string, detail?: string) => Promise<unknown>
    } }).goalControllerForTests

    for (let i = 0; i < 50; i++) {
      await controller.observeTurnEvent(
        managed as never,
        { type: 'tool_start', toolUseId: `tu-${i}`, toolName: 'read' },
        binding,
        1,
      )
    }
    await controller.pause(managed as never, 'manual', 'paused mid-run')

    const facts = managed.goal!.executionFacts!
    expect(facts.facts.length).toBe(40) // GOAL_EXECUTION_FACTS_LIMIT
    expect(facts.truncated).toBe(true)
    // 50 observed calls + the pause control fact = 51 recorded, 40 kept.
    expect(facts.droppedCount).toBe(11)
    // Keep-FIRST: the earliest observed calls survive, the tail is dropped.
    expect(facts.facts[0]!.toolUseId).toBe('tu-0')
    expect(facts.facts.some(f => f.toolUseId === 'tu-49')).toBe(false)
  })

  it('ICR-2: a sub-agent goal_update can never report for the parent goal (its facts stay parent-linked)', async () => {
    const goal = activeGoal('goal-subagent-report')
    const managed = seedSession('goal-subagent-report', { isProcessing: true, goal })
    const controller = (sm as unknown as { goalControllerForTests: {
      stageReport: (managed: unknown, wire: unknown, generation: number) => void
      observeTurnEvent: (managed: unknown, event: Record<string, unknown>, binding: unknown, generation: number) => Promise<unknown>
    } }).goalControllerForTests

    const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'candidate',
      candidate: { summary: 'The sub-agent claims the parent goal is done', evidence: [] },
    }))!
    controller.stageReport(managed as never, wire, 1)
    // The tool_use id belongs to a call INSIDE a sub-agent task.
    await controller.observeTurnEvent(
      managed as never,
      { type: 'tool_start', toolUseId: 'tu-child-goal-update', toolName: 'goal_update', parentToolUseId: 'tu-parent-task' },
      { goalId: goal.id, runGeneration: goal.runGeneration, generation: 1 },
      1,
    )
    await controller.observeTurnEvent(
      managed as never,
      { type: 'tool_result', toolUseId: 'tu-child-goal-update', isError: false, resultText: serializeGoalUpdateReport(wire), parseReport: parseGoalUpdateReportPayload, parentToolUseId: 'tu-parent-task' },
      { goalId: goal.id, runGeneration: goal.runGeneration, generation: 1 },
      1,
    )

    // No candidate, no verifying state: the parent goal's completion can only
    // ever be claimed by its OWN turn.
    expect(managed.goal?.candidate).toBeUndefined()
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.version).toBe(goal.version)
  })
})
