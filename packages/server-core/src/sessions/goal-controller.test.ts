import { describe, expect, it } from 'bun:test'
import {
  buildGoalContinuationPrompt,
  buildGoalProjection,
  buildVerificationPrompt,
  checkCriteriaCoverage,
  createGoalRecord,
  GOAL_VERIFICATION_OUTPUT_SCHEMA,
  createGoalRuntimeState,
  GOAL_FACT_PARAM_CHARS,
  summarizeGoalFactInput,
  summarizeGoalFactResult,
  endGoalRecord,
  GOAL_MAX_NO_PROGRESS_ROUNDS,
  GOAL_VERIFICATION_TIMEOUT_MS,
  GoalController,
  isValidMessageEvidence,
  mergeGoalCriteria,
  mergeGoalTodos,
  parseVerificationAnswer,
  pauseGoalRecord,
  resumeGoalRecord,
  startGoalClock,
  stopGoalClock,
  type GoalControllerHost,
  type GoalRuntimeState,
} from './goal-controller.ts'
import type { GoalRecord } from '@polo-ai/shared/protocol'
import { serializeGoalUpdateReport } from '@polo-ai/session-tools-core'
import { parseGoalUpdateReportPayload } from '@polo-ai/session-tools-core'
import { resolveEvidenceBase, resolveEvidenceInputPath } from './goal-controller.ts'
import {
  getSessionFilePath,
  readSessionHeader,
  readSessionJsonl,
  writeSessionJsonl,
  updateSessionMetadata,
  WorkspaceSessionStorage,
  type StoredSession,
} from '@polo-ai/shared/sessions'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// POO-134 unit contract for the ONE authoritative Goal controller: clock
// accounting never counts offline/paused time, todo merging never deletes or
// regresses, report application is identity-checked and fail-closed, and
// completion requires real evidence plus an independent verdict.

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    ...createGoalRecord({
      sessionId: 's1',
      anchorMessageId: 'm-anchor',
      objective: 'Write the report file',
      criteria: ['The file exists with the summary'],
      now: 1_000,
    }),
    ...overrides,
  }
}

interface HostState {
  now: number
  flushed: number
  persistGoalMetadataCold: Array<{ sessionId: string; goal: GoalRecord | undefined; history: GoalRecord[]; revision: number }>
  projections: Array<{ revision: number; goalId?: string }>
  appended: string[]
  storageFailures: string[]
  continuations: string[]
  queryResults: Array<{
    ok: true
    text: string
    warning?: string
    /** Optional scripted attribution (F8): what the SDK result actually reported. */
    model?: string
    inputTokens?: number
    outputTokens?: number
  } | { ok: false; error: string }>
  files: Map<string, { content: string }>
  messages: Array<{ id: string; role: string; isIntermediate?: boolean; content: string; timestamp: number }>
  busy: boolean
  lastQueryOptions: { signal?: AbortSignal; isolation?: string } | undefined
  /** The verification prompt as actually addressed (ICR-2 assertions). */
  lastPrompt: string | undefined
  /** How many independent verification queries the host really addressed. */
  queryCalls: number
}

function makeHost(overrides: Partial<HostState> = {}): { host: GoalControllerHost; state: HostState } {
  const state: HostState = {
    now: 10_000,
    flushed: 0,
    persistGoalMetadataCold: [],
    projections: [],
    appended: [],
    storageFailures: [],
    continuations: [],
    queryResults: [],
    files: new Map(),
    messages: [
      { id: 'm-anchor', role: 'user', content: 'Write the report file', timestamp: 1_000 },
      { id: 'm-a1', role: 'assistant', isIntermediate: false, content: 'I wrote the file.', timestamp: 2_000 },
    ],
    busy: false,
    lastQueryOptions: undefined,
    lastPrompt: undefined,
    queryCalls: 0,
    ...overrides,
  }
  const host: GoalControllerHost = {
    now: () => state.now,
    info: () => {},
    warn: () => {},
    error: () => {},
    hasSession: () => true,
    flushSession: async () => { state.flushed++ },
    persistSession: () => {},
    persistGoalMetadataCold: async (_sessionId, goal, history, revision) => {
      state.persistGoalMetadataCold.push({ sessionId: _sessionId, goal, history, revision })
    },
    publishProjection: (_sessionId, projection) => {
      state.projections.push({ revision: projection.revision, goalId: projection.currentGoalId })
    },
    notifyStorageFailure: (_sessionId, message) => {
      state.storageFailures.push(message)
    },
    appendGoalMessage: async (_sessionId, content) => {
      state.appended.push(content)
      const id = `m-goal-${state.appended.length}`
      state.messages.push({ id, role: 'assistant', isIntermediate: false, content, timestamp: state.now })
      return id
    },
    getSessionMessages: () => state.messages,
    sendInternalContinuation: async (_sessionId, prompt) => { state.continuations.push(prompt) },
    getEffectiveModel: () => 'test-verifier-model',
    queryLlm: async (_sessionId, request, options) => {
      state.queryCalls += 1
      state.lastQueryOptions = options
      state.lastPrompt = request.prompt
      const next = state.queryResults.shift()
      if (!next) throw new Error('no scripted verification result')
      if (!next.ok) throw new Error(next.error)
      // F-R2-5: STRICT passthrough — the stub never fabricates model/usage
      // defaults. Attribution appears only when a test scripts it, exactly
      // like the real SDK result message (the zhipu endpoint reports usage
      // but no model; the receipt's model then comes from the ADDRESSED
      // verification model, which getEffectiveModel supplies below).
      return {
        text: next.text,
        ...(next.warning ? { warning: next.warning } : {}),
        ...(next.model ? { model: next.model } : {}),
        ...(next.inputTokens !== undefined ? { inputTokens: next.inputTokens } : {}),
        ...(next.outputTokens !== undefined ? { outputTokens: next.outputTokens } : {}),
      }
    },
    inspectEvidenceFile: async (_sessionId, rawPath) => {
      const file = state.files.get(rawPath)
      if (!file) return { ok: false as const, reason: 'file not found' }
      return {
        ok: true as const,
        absolutePath: `/resolved${rawPath}`,
        bytes: file.content.length,
        sha256: 'a'.repeat(64),
        excerpt: file.content,
      }
    },
    canStartTurn: () => !state.busy,
    cancelGoalVerification: () => {},
  }
  return { host, state }
}

function managedWith(goal?: GoalRecord, runtime?: Partial<GoalRuntimeState>) {
  const managed: {
    id: string
    goal?: GoalRecord
    goalHistory?: GoalRecord[]
    goalProjectionRevision?: number
    goalRuntime: GoalRuntimeState
  } = { id: 's1', goal, goalRuntime: { ...createGoalRuntimeState(), ...runtime } }
  return managed
}

describe('goal clock accounting', () => {
  it('accumulates only the live running segment', () => {
    const goal = makeGoal({ runningSince: 5_000, elapsedMs: 1_000 })
    const stopped = stopGoalClock(goal, 8_000)
    expect(stopped.elapsedMs).toBe(4_000)
    expect(stopped.runningSince).toBeUndefined()
  })

  it('never counts time while paused (no runningSince)', () => {
    const goal = makeGoal({ runningSince: undefined, elapsedMs: 4_000 })
    const later = stopGoalClock(goal, 999_000)
    expect(later.elapsedMs).toBe(4_000)
  })

  it('startGoalClock only starts when stopped; pause folds and resume starts a new segment', () => {
    let goal = makeGoal({ runningSince: undefined, elapsedMs: 100 })
    goal = startGoalClock(goal, 2_000)
    expect(goal.runningSince).toBe(2_000)
    goal = startGoalClock(goal, 3_000) // idempotent
    expect(goal.runningSince).toBe(2_000)
    goal = pauseGoalRecord(goal, 'manual', 'paused', 5_000)
    expect(goal.status).toBe('paused')
    expect(goal.pauseReason).toBe('manual')
    expect(goal.elapsedMs).toBe(3_100)
    expect(goal.runningSince).toBeUndefined()
    const resumed = resumeGoalRecord(goal, 9_000)
    if ('error' in resumed) throw new Error('resume refused')
    expect(resumed.status).toBe('active')
    expect(resumed.runGeneration).toBe(goal.runGeneration + 1)
    expect(resumed.runningSince).toBe(9_000)
    expect(resumed.pauseReason).toBeUndefined()
  })

  it('terminal records never pause and terminal goals refuse resume', () => {
    const completed = endGoalRecord(makeGoal(), 'completed', 5_000)
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).toBe(5_000)
    expect(pauseGoalRecord(completed, 'manual', undefined, 6_000).status).toBe('completed')
    expect(resumeGoalRecord(completed, 6_000)).toEqual({ error: 'goal is terminal' })
  })

  it('running goals are not double-resumed (no generation inflation)', () => {
    const active = makeGoal({ status: 'active' })
    expect(resumeGoalRecord(active, 5_000)).toEqual(active)
  })
})

describe('todo and criteria merging', () => {
  it('updates in place by stable id and never deletes omitted items', () => {
    const existing = [
      { id: 't1', label: 'Draft', status: 'completed' as const, seq: 1, updatedAt: 1 },
      { id: 't2', label: 'Review', status: 'pending' as const, seq: 2, updatedAt: 1 },
    ]
    const merged = mergeGoalTodos(existing, [
      { id: 't2', label: 'Review', status: 'in_progress' },
      { id: 't3', label: 'Ship', status: 'pending' },
    ], 5)
    expect(merged).toHaveLength(3)
    expect(merged!.find(t => t.id === 't1')).toMatchObject({ status: 'completed', seq: 1 })
    expect(merged!.find(t => t.id === 't2')).toMatchObject({ status: 'in_progress', seq: 2 })
    expect(merged!.find(t => t.id === 't3')).toMatchObject({ seq: 3 })
  })

  it('never regresses a completed item', () => {
    const existing = [{ id: 't1', label: 'Draft', status: 'completed' as const, seq: 1, updatedAt: 1 }]
    const merged = mergeGoalTodos(existing, [{ id: 't1', label: 'Draft', status: 'pending' }], 5)
    expect(merged![0].status).toBe('completed')
  })

  it('refuses snapshots beyond the bounded list', () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, label: `t${i}`, status: 'pending' as const, seq: i + 1, updatedAt: 1 }))
    expect(mergeGoalTodos(existing, [{ id: 'new', label: 'new', status: 'pending' }], 5)).toBeNull()
  })

  it('criteria are additive and case-insensitive; the bar never shrinks', () => {
    const merged = mergeGoalCriteria(['File exists'], ['file EXISTS', 'Digest matches'])
    expect(merged).toEqual(['File exists', 'Digest matches'])
    expect(mergeGoalCriteria(['a'], undefined)).toEqual(['a'])
  })
})

describe('evidence validation', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
    { id: 'a1', role: 'assistant', isIntermediate: false, content: 'final', timestamp: 2 },
    { id: 'a2', role: 'assistant', isIntermediate: true, content: 'delta', timestamp: 3 },
  ]

  it('accepts only persisted final assistant messages THIS goal produced', () => {
    // F-R2-3: same session ≠ same goal — ownership is the goal's own captured
    // producedMessageIds, and an absent set fails closed entirely.
    const owned = ['a1']
    expect(isValidMessageEvidence(messages, 'a1', owned)).toBe(true)
    expect(isValidMessageEvidence(messages, 'u1', owned)).toBe(false)
    expect(isValidMessageEvidence(messages, 'a2', owned)).toBe(false)
    expect(isValidMessageEvidence(messages, 'ghost', owned)).toBe(false)
    expect(isValidMessageEvidence(messages, undefined, owned)).toBe(false)
    // An earlier goal's final message that this session still holds is NOT
    // evidence for this goal.
    expect(isValidMessageEvidence(messages, 'a1', ['other-message'])).toBe(false)
    // No captured ownership at all → no message evidence, ever.
    expect(isValidMessageEvidence(messages, 'a1', undefined)).toBe(false)
    expect(isValidMessageEvidence(messages, 'a1', [])).toBe(false)
  })

  it('coverage requires every criterion judged with in-range evidence', () => {
    const criteria = ['A exists', 'B matches']
    const ok = checkCriteriaCoverage(criteria, [
      { criterion: 'A exists', passed: true, evidenceIds: [0] },
      { criterion: 'b matches', passed: true, evidenceIds: [0, 1] },
    ], 2)
    expect(ok.ok).toBe(true)

    const missing = checkCriteriaCoverage(criteria, [
      { criterion: 'A exists', passed: true, evidenceIds: [0] },
    ], 2)
    expect(missing.ok).toBe(false)
    expect(missing.missing).toEqual(['B matches'])

    const unbacked = checkCriteriaCoverage(criteria, [
      { criterion: 'A exists', passed: true, evidenceIds: [0] },
      { criterion: 'B matches', passed: true, evidenceIds: [9] },
    ], 2)
    expect(unbacked.ok).toBe(false)
    expect(unbacked.unbacked).toEqual(['B matches'])

    const noEvidence = checkCriteriaCoverage(criteria, [
      { criterion: 'A exists', passed: true, evidenceIds: [] },
      { criterion: 'B matches', passed: true, evidenceIds: [0] },
    ], 2)
    expect(noEvidence.ok).toBe(false)
  })
})

describe('evidence path normalization (real-model wire)', () => {
  const ROOT = '/tmp/poo134-goal-isolate/task'

  it('resolves a WORKSPACE-RELATIVE evidence path against the workspace root', () => {
    // attempt-3: the real model naturally cites artifacts as workspace-relative
    // paths (`docs/notes.md` — exactly what it wrote via the file tools), the
    // tool schema allows it, and the permission fence then rejected the bare
    // relative path ("Only absolute file paths are allowed") — the candidate
    // failed verification on a path FORM, not on its content.
    expect(resolveEvidenceInputPath('docs/notes.md', ROOT)).toBe(`${ROOT}/docs/notes.md`)
  })

  it('resolves relative navigations and collapses redundant separators', () => {
    expect(resolveEvidenceInputPath('./docs/../docs/notes.md', ROOT)).toBe(`${ROOT}/docs/notes.md`)
  })

  it('leaves absolute paths untouched', () => {
    expect(resolveEvidenceInputPath('/abs/evidence.md', ROOT)).toBe('/abs/evidence.md')
  })

  it('leaves home-relative paths for the permission fence to expand', () => {
    // `~` expansion stays the fence's job (it knows the real homedir);
    // resolving it against the root would corrupt the path.
    expect(resolveEvidenceInputPath('~/notes.md', ROOT)).toBe('~/notes.md')
  })

  it('does not let an empty path through', () => {
    expect(resolveEvidenceInputPath('', ROOT)).toBe('')
    expect(resolveEvidenceInputPath('   ', ROOT)).toBe('   ')
  })
})

describe('evidence base: the session effective workingDirectory, not blindly the workspace root', () => {
  it('resolves against the session workingDirectory when one is set (differs from the workspace root)', () => {
    // The agent's file tools run in the session workingDirectory; a relative
    // citation like `docs/notes.md` names a file THERE, not at the workspace
    // root. The permission fence is unchanged — this only picks the base.
    const managed = { workingDirectory: '/tmp/poo134-goal-isolate/task/subdir', workspace: { rootPath: '/tmp/poo134-goal-isolate' } }
    const base = resolveEvidenceBase(managed)
    expect(base).toBe('/tmp/poo134-goal-isolate/task/subdir')
    expect(resolveEvidenceInputPath('docs/notes.md', base)).toBe('/tmp/poo134-goal-isolate/task/subdir/docs/notes.md')
  })

  it('falls back to the workspace root when no workingDirectory is set (or blank)', () => {
    expect(resolveEvidenceBase({ workspace: { rootPath: '/tmp/poo134-goal-isolate' } })).toBe('/tmp/poo134-goal-isolate')
    expect(resolveEvidenceBase({ workingDirectory: '   ', workspace: { rootPath: '/tmp/poo134-goal-isolate' } })).toBe('/tmp/poo134-goal-isolate')
  })
})

describe('verification answer parsing (fail-closed)', () => {
  it('parses a valid verdict', () => {
    const answer = parseVerificationAnswer(JSON.stringify({
      overall: 'passed',
      criteria: [{ criterion: 'A', passed: true, evidenceIds: [0], note: 'ok' }],
      summary: 'All good',
    }))
    expect(answer?.overall).toBe('passed')
    expect(answer?.criteria[0].evidenceIds).toEqual([0])
  })

  it('tolerates a fenced code block', () => {
    const answer = parseVerificationAnswer('```json\n{"overall":"not_satisfied","criteria":[],"summary":"no"}\n```')
    expect(answer?.overall).toBe('not_satisfied')
  })

  it('rejects prose, wrong enums, missing fields and non-numeric evidence', () => {
    expect(parseVerificationAnswer('The goal passed.')).toBeNull()
    expect(parseVerificationAnswer(JSON.stringify({ overall: 'complete', criteria: [], summary: 'x' }))).toBeNull()
    expect(parseVerificationAnswer(JSON.stringify({ overall: 'passed', criteria: [], summary: '' }))).toBeNull()
    expect(parseVerificationAnswer(JSON.stringify({ overall: 'passed', summary: 'x' }))).toBeNull()
    expect(parseVerificationAnswer(JSON.stringify({
      overall: 'passed',
      criteria: [{ criterion: 'A', passed: 'yes', evidenceIds: [0] }],
      summary: 'x',
    }))).toBeNull()
    expect(parseVerificationAnswer(JSON.stringify({
      overall: 'passed',
      criteria: [{ criterion: 'A', passed: true, evidenceIds: ['0'] }],
      summary: 'x',
    }))).toBeNull()
    expect(parseVerificationAnswer(undefined)).toBeNull()
  })
})

describe('prompts and projection', () => {
  it('the continuation prompt frames an internal continuation with rules', () => {
    const goal = makeGoal({
      todos: [{ id: 't1', label: 'Draft', status: 'completed', seq: 1, updatedAt: 1 }],
      supplementMessageIds: ['m-supp'],
    })
    const prompt = buildGoalContinuationPrompt(goal, ['Also add a chart'])
    expect(prompt).toContain('<goal_continuation')
    expect(prompt).toContain(goal.objective)
    expect(prompt).toContain('Also add a chart')
    expect(prompt).toContain('[x] t1: Draft')
    expect(prompt).toContain('goal_update')
    expect(prompt).toContain('NEVER claim completion yourself')
  })

  it('the verification prompt carries objective, criteria, material and JSON contract', () => {
    const goal = makeGoal({ candidate: { summary: 'Done the work', reportedAt: 1, evidence: [] } })
    const prompt = buildVerificationPrompt(goal, '[evidence 0] file /tmp/x')
    expect(prompt).toContain('NO tools')
    expect(prompt).toContain('Write the report file')
    expect(prompt).toContain('[evidence 0] file /tmp/x')
    expect(prompt).toContain('"not_satisfied"')
  })

  it('projection revision is monotonic and clears currentGoalId on terminal records', () => {
    const active = buildGoalProjection(makeGoal(), 3, 's1')
    expect(active.revision).toBe(3)
    expect(active.currentGoalId).toBeDefined()
    const completed = buildGoalProjection(makeGoal({ status: 'completed' }), 4, 's1')
    expect(completed.currentGoalId).toBeUndefined()
    expect(completed.goal?.status).toBe('completed')
    const cleared = buildGoalProjection(undefined, 5, 's1')
    expect(cleared.currentGoalId).toBeUndefined()
    expect(cleared.goal).toBeUndefined()
  })
})

/**
 * The PRODUCTION sequence: the agent's goal_update callback stages the
 * report (identity-validated), then the chat loop observes the successful
 * goal_update tool_result and applies it. Tests must drive both channels —
 * a tool_result without a staged report is ignored by design.
 */
async function stageThenObserve(
  controller: GoalController,
  managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
  binding: { goalId: string; runGeneration: number; generation: number },
  generation: number,
  wire: ReturnType<typeof parseGoalUpdateReportPayload>,
  toolUseId = 'tu1',
  toolName = 'goal_update',
) {
  controller.stageReport(managed, wire!, generation)
  // Production order: tool_start of goal_update is observed first — only a
  // tool whose start was seen THIS turn can have its result applied.
  await controller.observeTurnEvent(
    managed,
    { type: 'tool_start', toolUseId, toolName },
    binding,
    generation,
  )
  // The wire payload travels in the tool_result; stage and wire are distinct
  // parses of the same tool arguments, exactly as in production.
  await controller.observeTurnEvent(
    managed,
    { type: 'tool_result', toolUseId, isError: false, resultText: serializeGoalUpdateReport(wire!), parseReport: parseGoalUpdateReportPayload },
    binding,
    generation,
  )
  // ICR-4: a candidate is only RECORDED at the tool_result (status →
  // 'verifying'); the verification itself is settled later, at the chat loop's
  // turn-complete point — never inside the tool_result consumption chain.
  if (wire?.kind === 'candidate') await settleNow(controller, managed, binding)
}

/**
 * The host-provided lease predicate the SessionManager passes to
 * settlePendingVerification: the turn lease is still the bound one for THIS
 * processing generation. It deliberately knows nothing about the goal record —
 * a user pause/end during the query is the CAS re-read's job (F1/F-R2-1).
 */
function leaseIsCurrent(
  managed: { goalRuntime?: GoalRuntimeState },
  binding: GoalTurnBinding,
) {
  return () => managed.goalRuntime?.turn === binding
}

/** The production settle half: run the deferred verification to its verdict. */
async function settleNow(
  controller: GoalController,
  managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
  binding: GoalTurnBinding,
) {
  return controller.settlePendingVerification(managed, binding, {
    generation: binding.generation,
    stillCurrent: leaseIsCurrent(managed, binding),
  })
}

describe('report application (identity-checked)', () => {
  // F-R2-6: a progress report that resets the no-progress guard carries
  // CHANGED STRUCTURED state — a note-only report is never progress.
  function progressReport(note = 'working') {
    const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'progress',
      note,
      todos: [{ id: 't1', label: 'Draft', status: 'in_progress' }],
    }))!
    return wire
  }

  it('applies a same-turn progress report and resets no-progress rounds', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal, { noProgressRounds: 2 })
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding

    await stageThenObserve(controller, managed, binding, 5, progressReport())
    expect(managed.goal?.status).toBe('active')
    expect(managed.goalRuntime!.progressedThisRound).toBe(true)
    expect(managed.goalRuntime!.noProgressRounds).toBe(0)
    expect(state.projections.length).toBeGreaterThan(0)
  })

  it('applies a report that arrives under the REAL production wire: MCP-qualified tool name + wrapped text content blocks', async () => {
    // Observed verbatim in the first authorized real-model run (attempt-1):
    // the chat loop surfaces the tool as `mcp__session__goal_update` and the
    // tool_result text is the JSON string of MCP text content blocks with the
    // marker+JSON escaped inside. The bare-name scanner dropped every real
    // report (goal stranded in no-progress pause); this test pins BOTH.
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal, { noProgressRounds: 2 })
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding

    const report = progressReport('real wire round')
    controller.stageReport(managed, report, 5)
    await controller.observeTurnEvent(
      managed,
      { type: 'tool_start', toolUseId: 'call_realwire', toolName: 'mcp__session__goal_update' },
      binding,
      5,
    )
    const wrapped = JSON.stringify([
      { type: 'text', text: `Progress recorded.\n${serializeGoalUpdateReport(report)}` },
    ])
    await controller.observeTurnEvent(
      managed,
      { type: 'tool_result', toolUseId: 'call_realwire', isError: false, resultText: wrapped, parseReport: parseGoalUpdateReportPayload },
      binding,
      5,
    )
    expect(managed.goalRuntime!.progressedThisRound).toBe(true)
    expect(managed.goalRuntime!.noProgressRounds).toBe(0)
    expect(state.projections.length).toBeGreaterThan(0)
  })

  it('ignores other tools results quietly while a goal_update report is staged', async () => {
    // bash/read/write results arrive between the goal_update staging and its
    // own tool_result; they are ordinary tool traffic, not anomalies.
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const versionBefore = goal.version

    controller.stageReport(managed, progressReport(), 5)
    await controller.observeTurnEvent(
      managed,
      { type: 'tool_result', toolUseId: 'call_bash1', isError: false, resultText: 'done', parseReport: parseGoalUpdateReportPayload },
      binding,
      5,
    )
    expect(managed.goal?.version).toBe(versionBefore)
    // the staged report must survive for its own tool_result
    expect(managed.goalRuntime!.staged).toHaveLength(1)
  })

  it('rejects a tool_result whose start was never seen this turn (late/foreign result)', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const versionBefore = goal.version

    await controller.observeTurnEvent(
      managed,
      { type: 'tool_result', toolUseId: 'unknown-id', isError: false, resultText: serializeGoalUpdateReport(progressReport()), parseReport: parseGoalUpdateReportPayload },
      binding,
      5,
    )
    expect(managed.goal?.version).toBe(versionBefore)
  })

  it('rejects observations whose generation no longer matches the binding', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const versionBefore = goal.version

    await controller.observeTurnEvent(
      managed,
      { type: 'tool_result', toolUseId: 'tu1', isError: false, resultText: serializeGoalUpdateReport(progressReport()), parseReport: parseGoalUpdateReportPayload },
      binding,
      6, // a NEWER generation observed with the OLD binding
    )
    expect(managed.goal?.version).toBe(versionBefore)
  })

  it('stageReport refuses non-goal turns, stale generations and generation drift', () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const report = progressReport()

    // No turn binding at all (ordinary chat turn).
    expect(() => controller.stageReport(managed, report, 5)).toThrow(/not a goal turn/)

    // Bound to generation 5, callback arrives claiming generation 4.
    managed.goalRuntime!.turn = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    expect(() => controller.stageReport(managed, report, 4)).toThrow(/no longer active/)

    // Goal moved on (new runGeneration) between bind and report.
    managed.goal = { ...goal, runGeneration: goal.runGeneration + 1 }
    expect(() => controller.stageReport(managed, report, 5)).toThrow(/generation changed/)
  })

  it('a clarification report pauses the goal with awaiting_user and flushes', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal({ runningSince: 9_000, elapsedMs: 100 })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const clarification = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'clarification',
      note: 'need input',
      clarification: { question: 'Which output format?', options: ['Markdown', 'PDF'] },
    }))!

    state.flushed = 0
    await stageThenObserve(controller, managed, binding, 5, clarification)
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('awaiting_user')
    expect(managed.goal?.pauseDetail).toBe('Which output format?')
    // The clock was folded into elapsedMs at pause time.
    expect(managed.goal?.runningSince).toBeUndefined()
    expect(state.flushed).toBeGreaterThan(0)
  })
})

function candidateReport(evidence: Array<Record<string, unknown>>, summary = 'The report is written.') {
  return parseGoalUpdateReportPayload(serializeGoalUpdateReport({
    kind: 'candidate',
    note: 'done',
    candidate: { summary, evidence: evidence as never },
  }))!
}

function candidateTurn() {
  const goal = makeGoal({
    runningSince: 9_000,
    elapsedMs: 500,
    criteria: ['The file exists with the summary'],
  })
  const managed = managedWith(goal)
  const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
  managed.goalRuntime!.turn = binding
  // F-R2-5: production captures the ADDRESSED verification model at
  // startGoal (getEffectiveModel); mirror that here instead of having the
  // stub fabricate a model on every result.
  managed.goalRuntime!.verificationModel = 'test-verifier-model'
  return { goal, managed, binding }
}

describe('candidate verification and completion (fail-closed)', () => {
  it('missing file evidence fails closed — never completes', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.queryResults.push({ ok: true, text: JSON.stringify({ overall: 'passed', criteria: [], summary: 'x' }) })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/missing.md' }]))
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('error')
    expect(managed.goal?.verification?.status).toBe('failed')
    expect(managed.goal?.verification?.error).toContain('/tmp/missing.md')
    // The verification query never even ran (fail before the LLM call).
    expect(state.lastQueryOptions).toBeUndefined()
  })

  it('message evidence must be a persisted final assistant message', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.queryResults.push({ ok: true, text: '{"overall":"passed","criteria":[],"summary":"x"}' })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'message', messageId: 'm-nope' }]))
    expect(managed.goal?.verification?.status).toBe('failed')
    expect(managed.goal?.verification?.error).toContain('not a persisted final assistant message')
  })

  it('a verifier exception pauses with the real error and records no fake usage', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report\nAll done.' })
    state.queryResults.push({ ok: false, error: 'provider unavailable' })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.verification?.status).toBe('failed')
    expect(managed.goal?.verification?.error).toContain('provider unavailable')
    expect(managed.goal?.verification?.inputTokens).toBeUndefined()
    expect(managed.goal?.verification?.outputTokens).toBeUndefined()
  })

  it('an unparsable verdict fails closed even when the model claims success', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report' })
    state.queryResults.push({ ok: true, text: 'It all looks complete to me.' })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.verification?.status).toBe('failed')
    expect(managed.goal?.verification?.error).toContain('not the required JSON verdict')
  })

  it('a not_satisfied verdict keeps the goal running with the clock restarted and real usage recorded', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { goal, managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report' })
    // F-R2-5: attribution is SCRIPTED, never stub-fabricated — the receipt's
    // model comes from the addressed verification model (getEffectiveModel),
    // the usage from what the query actually reported.
    state.queryResults.push({ ok: true, text: JSON.stringify({
      overall: 'not_satisfied',
      criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'summary section missing' }],
      summary: 'The file exists but lacks the required summary section.',
    }), inputTokens: 11, outputTokens: 7 })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.verification?.status).toBe('not_satisfied')
    expect(managed.goal?.verification?.model).toBe('test-verifier-model')
    expect(managed.goal?.verification?.inputTokens).toBe(11)
    expect(managed.goal?.verification?.outputTokens).toBe(7)
    expect(managed.goal?.verification?.criteria[0].passed).toBe(false)
    expect(managed.goal?.runningSince).toBeDefined()
    // The verification query ran under the isolation contract.
    expect(state.lastQueryOptions?.isolation).toBe('no-tools')
  })

  it('a passed verdict completes the goal: history retention, projection cleared, summary message', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report\nsummary present' })
    state.queryResults.push({ ok: true, text: JSON.stringify({
      overall: 'passed',
      criteria: [{ criterion: 'The file exists with the summary', passed: true, evidenceIds: [0], note: 'file digest matches content' }],
      summary: 'Objective satisfied by the on-disk report.',
    }) })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory).toHaveLength(1)
    const completed = managed.goalHistory![0]
    expect(completed.status).toBe('completed')
    expect(completed.resultMessageId).toBeDefined()
    expect(completed.verification?.status).toBe('passed')
    expect(completed.verification?.criteria[0].passed).toBe(true)
    expect(completed.candidate?.evidence[0].sha256).toBe('a'.repeat(64))
    expect(state.appended.join('\n')).toContain('Independent verification')
    expect(state.appended.join('\n')).toContain('/resolved/tmp/report.md')
    // Projection: the terminal clear advanced the revision.
    expect(state.projections.at(-1)?.goalId).toBeUndefined()
  })

  it('a passed overall with uncovered criteria does NOT complete (structural gate)', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report' })
    state.queryResults.push({ ok: true, text: JSON.stringify({
      overall: 'passed',
      criteria: [{ criterion: 'A criterion the model invented', passed: true, evidenceIds: [0] }],
      summary: 'claiming success',
    }) })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.verification?.status).toBe('not_satisfied')
    expect(managed.goal?.verification?.error).toContain('no verdict for')
  })
})

describe('pause / resume / end lifecycle', () => {
  it('pause is idempotent for the same reason and keeps the FIRST attribution', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const managed = managedWith(makeGoal({ status: 'paused', pauseReason: 'stop' }))
    const outcome = await controller.pause(managed, 'manual', 'later manual')
    expect(outcome.ok).toBe(true)
    expect(managed.goal?.pauseReason).toBe('stop')
  })

  it('pause flushes durably and reports flush failure without refusing to stop', async () => {
    const state: Partial<HostState> = {}
    const { host } = makeHost(state)
    const failing = makeHost()
    failing.state.flushed = 0
    const brokenHost: GoalControllerHost = {
      ...failing.host,
      flushSession: async () => { throw new Error('disk full') },
    }
    const controller = new GoalController(brokenHost)
    const managed = managedWith(makeGoal())
    const outcome = await controller.pause(managed, 'manual', 'paused')
    expect(outcome.ok).toBe(true)
    expect(outcome.flushed).toBe(false)
    expect(managed.goal?.status).toBe('paused')
  })

  it('end moves the record to history and clears the projection', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const managed = managedWith(makeGoal())
    const outcome = await controller.end(managed, 'Ended by you.')
    expect(outcome.ok).toBe(true)
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory).toHaveLength(1)
    expect(managed.goalHistory![0].status).toBe('ended')
    expect(state.projections.at(-1)?.goalId).toBeUndefined()
  })
})

describe('no-progress guard and continuation', () => {
  it('three consecutive rounds without progress pause the goal instead of looping', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding

    for (let round = 0; round < GOAL_MAX_NO_PROGRESS_ROUNDS; round++) {
      const action = await controller.onTurnComplete(managed, binding, { hasPendingHandoff: false, queuedMessages: 0 })
      if (round < GOAL_MAX_NO_PROGRESS_ROUNDS - 1) {
        expect(action).toBe('continue')
        expect(state.continuations).toHaveLength(round + 1)
        // Bind the next continuation round (resets per-round observation state).
        controller.bindTurn(managed, { userMessageId: `m-cont-${round}`, content: state.continuations[round], generation: 6 + round, internalContinuation: true })
      }
    }
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('no_progress')
    expect(state.appended.join('\n')).toContain('Goal paused')
  })

  it('a progress report resets the no-progress counter', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal, { noProgressRounds: GOAL_MAX_NO_PROGRESS_ROUNDS - 1 })
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding

    const report = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'progress',
      note: 'still working',
      todos: [{ id: 't1', label: 'Draft', status: 'completed' }],
    }))!
    await stageThenObserve(controller, managed, binding, 5, report)
    const action = await controller.onTurnComplete(managed, binding, { hasPendingHandoff: false, queuedMessages: 0 })
    expect(action).toBe('continue')
    expect(managed.goal?.status).toBe('active')
  })

  it('paused goals, pending handoffs and queued messages never self-resume', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const paused = managedWith(makeGoal({ status: 'paused', pauseReason: 'manual' }))
    const binding = { goalId: paused.goal!.id, runGeneration: paused.goal!.runGeneration, generation: 5 }
    paused.goalRuntime!.turn = binding

    expect(await controller.onTurnComplete(paused, binding, { hasPendingHandoff: false, queuedMessages: 0 })).toBe('noop')
    expect(state.continuations).toHaveLength(0)

    const running = managedWith(makeGoal({ runningSince: 10_000, elapsedMs: 5_000 }))
    running.goalRuntime!.turn = binding
    // A pending permission/question handoff is a REAL pause (F2): the goal
    // stops running and the clock folds — it must not keep charging time
    // while the user is away.
    expect(await controller.onTurnComplete(running, binding, { hasPendingHandoff: true, queuedMessages: 0 })).toBe('paused_handoff')
    expect(running.goal?.status).toBe('paused')
    expect(running.goal?.pauseReason).toBe('awaiting_permission')
    expect(running.goal?.runningSince).toBeUndefined()
    expect(await controller.onTurnComplete(running, binding, { hasPendingHandoff: false, queuedMessages: 2 })).toBe('noop')
    expect(state.continuations).toHaveLength(0)
  })

  it('resume requires an idle session and continues through the production send path', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const managed = managedWith(makeGoal({ status: 'paused', pauseReason: 'manual' }))
    state.busy = true
    expect(await controller.resume(managed)).toEqual({ ok: false, error: 'session is busy; resume when the current turn finishes' })
    expect(managed.goal?.status).toBe('paused')

    state.busy = false
    const outcome = await controller.resume(managed)
    expect(outcome.ok).toBe(true)
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.runGeneration).toBe(2)
    expect(state.continuations).toHaveLength(1)
    expect(state.continuations[0]).toContain('<goal_continuation')
  })
})

describe('cold-start recovery', () => {
  it('a running goal becomes paused/restart_required with NO offline time counted', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const managed = managedWith(makeGoal({ runningSince: 5_000, elapsedMs: 1_000 }))
    state.now = 900_000 // a long crash-to-restart gap

    await controller.recoverOnColdStart(managed)
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('restart_required')
    expect(managed.goal?.elapsedMs).toBe(1_000) // gap NOT folded in
    expect(managed.goal?.runningSince).toBeUndefined()
    expect(state.persistGoalMetadataCold).toHaveLength(1)
    expect(state.persistGoalMetadataCold[0].revision).toBe(1)
  })

  it('terminal and paused goals are left untouched', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const completed = managedWith(makeGoal({ status: 'completed' }))
    await controller.recoverOnColdStart(completed)
    const paused = managedWith(makeGoal({ status: 'paused', pauseReason: 'manual' }))
    await controller.recoverOnColdStart(paused)
    const none = managedWith(undefined)
    await controller.recoverOnColdStart(none)
    expect(state.persistGoalMetadataCold).toHaveLength(0)
  })
})

// ============================================================
// Review round 1 regressions (F1–F8 + Spec clock semantics).
// Each block pins the behavior the independent reviewer
// reproduced against the frozen sources (probe-findings.test.ts /
// probe-history.test.ts in the reviewer dir); the maintenance
// copies here are the permanent guards.
// ============================================================

import type { GoalTurnBinding } from './goal-controller.ts'

/** Deferred verification query: the test decides when the verdict resolves.
 *  ICR-4: the query only STARTS at the settle point, so this also records the
 *  options — untilQueryStarted() waits on that signal. */
function deferQuery(host: GoalControllerHost, state: HostState) {
  let release!: (result: { ok: true; text: string }) => void
  host.queryLlm = async (_sessionId, _request, options) => {
    state.lastQueryOptions = options
    return await new Promise<{ ok: true; text: string }>(resolve => { release = resolve })
  }
  return {
    resolve(text: string) {
      release({ ok: true, text })
    },
  }
}

function verdict(overall: 'passed' | 'not_satisfied'): string {
  return JSON.stringify({
    overall,
    criteria: [{ criterion: 'The file exists with the summary', passed: overall === 'passed', evidenceIds: [0] }],
    summary: overall === 'passed' ? 'ok' : 'missing summary section',
  })
}

/** Drive a candidate report through stage → tool_start → successful tool_result.
 *  ICR-4: this only RECORDS the candidate (status → 'verifying'); await it,
 *  then call startSettle() + untilQueryStarted() to reach the in-flight
 *  verification window the race tests act inside. */
async function submitCandidate(
  controller: GoalController,
  managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
  binding: GoalTurnBinding,
): Promise<void> {
  const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
    kind: 'candidate',
    candidate: { summary: 'Done', evidence: [{ kind: 'file', path: 'docs/notes.md' }] },
  }))!
  controller.stageReport(managed, wire, binding.generation)
  await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-candidate', toolName: 'goal_update' }, binding, binding.generation)
  await controller.observeTurnEvent(
    managed,
    { type: 'tool_result', toolUseId: 'tu-candidate', isError: false, resultText: serializeGoalUpdateReport(wire), parseReport: parseGoalUpdateReportPayload },
    binding,
    binding.generation,
  )
}

/** Start the deferred settle WITHOUT awaiting it: the verification query runs
 *  while the test acts (pause/end/admission) — the F1 race window, now at the
 *  chat loop's turn-complete point instead of the tool_result chain. */
function startSettle(
  controller: GoalController,
  managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
  binding: GoalTurnBinding,
): Promise<unknown> {
  return controller.settlePendingVerification(managed, binding, {
    generation: binding.generation,
    stillCurrent: leaseIsCurrent(managed, binding),
  })
}

/** Let the settle reach the in-flight verification query. Macrotask ticks so
 *  the settle pre-checks drain and the deferred query is parked. */
async function untilQueryStarted(state: { lastQueryOptions?: unknown }): Promise<void> {
  for (let i = 0; i < 200 && state.lastQueryOptions === undefined; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  if (state.lastQueryOptions === undefined) throw new Error('verification query never started')
}

describe('verification fail-closed on non-success query warnings (attempt-6 counterexample)', () => {
  it('a valid-looking passed JSON + a non-success warning does NOT complete the goal — it pauses with the real reason', async () => {
    // attempt-6 real counterexample: the SDK independent query ended
    // error_max_turns (partial 1439-char salvage), its warning was copied
    // onto the receipt and the parseable passed JSON was accepted — a failed
    // verification was persisted as goal.completed. The verdict of an
    // abnormal query is NEVER a completion.
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report\nsummary present' })
    state.queryResults.push({
      ok: true,
      text: JSON.stringify({
        overall: 'passed',
        criteria: [{ criterion: 'The file exists with the summary', passed: true, evidenceIds: [0] }],
        summary: 'looks complete',
      }),
      warning: 'Model stopped early: Claude Code returned an error result: Reached maximum number of turns (1) (accumulated 1439 chars of partial text)',
    })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))

    // NOT completed: the goal must be paused with the real failure reason.
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('error')
    expect(managed.goal?.verification?.status).toBe('failed')
    // The REAL reason (attempt-6's thrown-path message — the salvage path has
    // no subtype, only the SDK's own error text) is preserved verbatim.
    expect(managed.goal?.verification?.error).toContain('Reached maximum number of turns (1)')
    // The real warning rides the receipt for the record (never fabricated away).
    expect(managed.goal?.verification?.warning).toContain('Model stopped early')
    // Nothing was appended as a completion message.
    expect(state.appended.join('\n')).not.toContain('completed')
  })

  it('a genuine not_satisfied verdict (no warning) stays not_satisfied — distinct from an abnormal query', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report\nsummary present' })
    state.queryResults.push({
      ok: true,
      text: JSON.stringify({
        overall: 'not_satisfied',
        criteria: [{ criterion: 'The file exists with the summary', passed: false, evidenceIds: [0] }],
        summary: 'summary section missing',
      }),
    })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))

    expect(managed.goal?.status).toBe('active') // a real verdict keeps the goal running for another round
    expect(managed.goal?.verification?.status).toBe('not_satisfied')
    expect(managed.goal?.verification?.warning).toBeUndefined()
  })
})

describe('verification cancellation surfaces its REAL cause (attempt-8)', () => {
  it('a deadline abort fails closed, pauses with error, and the receipt names the timeout — not a generic "cancelled"', async () => {
    // attempt-8 real run: the isolated verification query exceeded the
    // deadline, the abort was surfaced as a generic "verification was
    // cancelled", and the goal paused with no trace of WHY. The deadline's
    // own reason must reach the receipt.
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    // The real query resolves after the abort (the SDK consumer salvages and
    // returns); the cancellation decision is the controller's.
    host.queryLlm = (_sessionId, _request, options) => {
      state.lastQueryOptions = options
      return new Promise(resolve => {
        options?.signal?.addEventListener('abort', () => resolve({ text: '{"overall":"passed","criteria":[],"summary":"late"}' }), { once: true })
      })
    }

    await submitCandidate(controller, managed, binding)
    const settled = startSettle(controller, managed, binding)
    await untilQueryStarted(state)
    // Exactly what the GOAL_VERIFICATION_TIMEOUT_MS deadline does.
    managed.goalRuntime!.verification!.controller.abort(new Error('verification timed out'))
    await settled

    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('error')
    expect(managed.goal?.verification?.status).toBe('failed')
    expect(managed.goal?.verification?.error).toContain('verification timed out')
  })

  it('the deadline keeps a hard bound covering the observed real-model tail', () => {
    // Real zhipu/glm isolated verdicts: ~43s (attempt-7) and >120s
    // (attempt-8's deadline abort). 120s was below the observed tail; the
    // bound must stay ≥ 300s — and must stay bounded (never unlimited).
    expect(GOAL_VERIFICATION_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000)
    expect(GOAL_VERIFICATION_TIMEOUT_MS).toBeLessThanOrEqual(600_000)
  })
})

describe('F1: an in-flight verification never overwrites a user pause/end (CAS)', () => {
  it('a manual pause during verification SURVIVES the late not_satisfied verdict, clock stays stopped', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const managed = managedWith(makeGoal({ runningSince: 10_000, elapsedMs: 5_000 }))
    const binding = { goalId: managed.goal!.id, runGeneration: managed.goal!.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    const deferred = deferQuery(host, state)

    await submitCandidate(controller, managed, binding)
    // ICR-4: recorded at the tool_result, query not yet addressed.
    expect(managed.goal?.status).toBe('verifying')
    expect(state.lastQueryOptions).toBeUndefined()
    const settled = startSettle(controller, managed, binding)
    await untilQueryStarted(state)

    // The user pauses WHILE the independent query is in flight.
    await controller.pause(managed, 'manual', 'Paused by you.')
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('manual')

    deferred.resolve(verdict('not_satisfied'))
    await settled

    // The stale pre-pause snapshot must NOT resurrect the goal.
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('manual')
    expect(managed.goal?.runningSince).toBeUndefined()
  })

  it('an END during verification is final: no resurrection, no duplicate history entry, a late pass is notice-only', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const managed = managedWith(makeGoal({ runningSince: 10_000, elapsedMs: 5_000 }))
    const binding = { goalId: managed.goal!.id, runGeneration: managed.goal!.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    const deferred = deferQuery(host, state)

    await submitCandidate(controller, managed, binding)
    const settled = startSettle(controller, managed, binding)
    await untilQueryStarted(state)

    await controller.end(managed, 'Ended by you.')
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory).toHaveLength(1)

    deferred.resolve(verdict('passed'))
    await settled

    // The ended goal stays ended — history gains NO second entry for it.
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory).toHaveLength(1)
    // The late pass surfaces as a transcript notice only (never a state write).
    expect(state.appended.join('\n')).toContain('PASSED after the goal was ended')
  })
})

describe('F2: pending handoffs and abnormal turn ends stop the clock', () => {
  it('a turn that completes with a pending handoff pauses the goal awaiting_permission with the clock stopped', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal({ runningSince: 10_000, elapsedMs: 5_000 })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    state_now(host, 12_000)

    const action = await controller.onTurnComplete(managed, binding, { hasPendingHandoff: true, queuedMessages: 0 })
    expect(action).toBe('paused_handoff')
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('awaiting_permission')
    // Clock stopped at the handoff: the wait for the user is NEVER charged.
    expect(managed.goal?.runningSince).toBeUndefined()
    expect(managed.goal?.elapsedMs).toBe(7_000)
  })

  it('an error/timeout turn end pauses the goal with error', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal({ runningSince: 10_000, elapsedMs: 5_000 })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    state_now(host, 12_000)

    const action = await controller.onTurnAborted(managed, binding, { handoff: false })
    expect(action).toBe('paused')
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('error')
    expect(managed.goal?.runningSince).toBeUndefined()
    expect(managed.goal?.elapsedMs).toBe(7_000)
  })

  it('a handoff turn end pauses awaiting_permission; the FIRST pause attribution survives later aborts', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal({ runningSince: 10_000 })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    state_now(host, 11_000)

    await controller.onTurnAborted(managed, binding, { handoff: true })
    expect(managed.goal?.pauseReason).toBe('awaiting_permission')
    expect(managed.goal?.elapsedMs).toBe(1_000)

    // A later error attempt must NOT re-attribute the pause.
    await controller.onTurnAborted(managed, binding, { handoff: false })
    expect(managed.goal?.pauseReason).toBe('awaiting_permission')
  })
})

describe('F3: cold-start recovery preserves the loaded goal history', () => {
  it('passes the hydrated goalHistory through to the cold metadata write', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const completed = makeGoal({ status: 'completed', elapsedMs: 60_000 })
    const managed = managedWith(makeGoal({ runningSince: 5_000, elapsedMs: 1_000 }))
    managed.goalHistory = [completed]
    state.now = 900_000

    await controller.recoverOnColdStart(managed)
    expect(state.persistGoalMetadataCold).toHaveLength(1)
    expect(state.persistGoalMetadataCold[0].history).toContain(completed)
  })
})

describe('F4: bindTurn special-cases waiting-for-user pauses only', () => {
  it('an awaiting_user pause binds the same-frame reply as a supplement and resumes the goal', () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal({ status: 'paused', pauseReason: 'awaiting_user', runningSince: undefined })
    const managed = managedWith(goal)

    const bound = controller.bindTurn(managed, { userMessageId: 'm-answer', content: '用 PDF 格式，并附目录', generation: 7 })
    expect(bound.bound).toBe(true)
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.supplementMessageIds).toContain('m-answer')
    expect(managed.goalRuntime?.turn?.generation).toBe(7)
    // A real (re)start bumps the run generation.
    expect(managed.goal?.runGeneration).toBe(goal.runGeneration + 1)
  })

  it('manual/stop pauses keep ordinary chat ordinary', () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const manual = managedWith(makeGoal({ status: 'paused', pauseReason: 'manual', runningSince: undefined }))
    expect(controller.bindTurn(manual, { userMessageId: 'm-chat', content: 'hi', generation: 7 }).bound).toBe(false)
    expect(manual.goal?.status).toBe('paused')
    expect(manual.goal?.supplementMessageIds).toHaveLength(0)

    const awaitingPermission = managedWith(makeGoal({ status: 'paused', pauseReason: 'awaiting_permission', runningSince: undefined }))
    expect(controller.bindTurn(awaitingPermission, { userMessageId: 'm-chat-2', content: 'hello?', generation: 8 }).bound).toBe(false)
    expect(awaitingPermission.goal?.status).toBe('paused')
  })

  it('a forged/late structured answer can NEVER resurrect a manual or Stop pause (self-check c)', () => {
    // The structured-answer resume applies ONLY to the native-handoff pause
    // ('awaiting_permission'). A questionResponse metadata flag arriving for a
    // goal the user paused by hand or via Stop stays paused — a stale auth
    // completion must not un-pause a deliberate pause.
    const { host } = makeHost()
    const controller = new GoalController(host)

    const stopped = managedWith(makeGoal({ status: 'paused', pauseReason: 'stop', runningSince: undefined }))
    expect(controller.bindTurn(stopped, {
      userMessageId: 'm-forged-1',
      content: 'Auth completed for source x',
      generation: 11,
      questionAnswer: true,
    }).bound).toBe(false)
    expect(stopped.goal?.status).toBe('paused')
    expect(stopped.goal?.pauseReason).toBe('stop')

    const manual = managedWith(makeGoal({ status: 'paused', pauseReason: 'manual', runningSince: undefined }))
    expect(controller.bindTurn(manual, {
      userMessageId: 'm-forged-2',
      content: 'answer',
      generation: 12,
      questionAnswer: true,
    }).bound).toBe(false)
    expect(manual.goal?.status).toBe('paused')
    expect(manual.goal?.pauseReason).toBe('manual')
  })

  it('restart_required (cold start) also refuses a structured-answer resume', () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const restarted = managedWith(makeGoal({ status: 'paused', pauseReason: 'restart_required', runningSince: undefined }))
    expect(controller.bindTurn(restarted, {
      userMessageId: 'm-answer-3',
      content: 'continue',
      generation: 13,
      questionAnswer: true,
    }).bound).toBe(false)
    expect(restarted.goal?.status).toBe('paused')
  })

  it('an awaiting_permission pause binds a STRUCTURED question answer (never a free-form chat)', () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal({ status: 'paused', pauseReason: 'awaiting_permission', runningSince: undefined })
    const managed = managedWith(goal)

    const bound = controller.bindTurn(managed, {
      userMessageId: 'm-answer-2',
      content: 'Allow',
      generation: 9,
      questionAnswer: true,
    })
    expect(bound.bound).toBe(true)
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.pauseReason).toBeUndefined()
  })
})

describe('F5: parallel same-turn reports match by content, not FIFO', () => {
  it('two parallel reports whose stage/result orders differ are BOTH applied', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding

    const reportA = parseGoalUpdateReportPayload(serializeGoalUpdateReport({ kind: 'progress', note: 'A: wrote notes', todos: [{ id: 'a1', label: 'Notes', status: 'completed' }] }))!
    const reportB = parseGoalUpdateReportPayload(serializeGoalUpdateReport({ kind: 'progress', note: 'B: wrote checklist', todos: [{ id: 'b1', label: 'Checklist', status: 'in_progress' }] }))!
    // Staging order B then A; results arrive A then B — legal for parallel calls.
    controller.stageReport(managed, reportB, 5)
    controller.stageReport(managed, reportA, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu1', toolName: 'goal_update' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu2', toolName: 'goal_update' }, binding, 5)

    const versionBefore = goal.version
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu1', isError: false, resultText: serializeGoalUpdateReport(reportA), parseReport: parseGoalUpdateReportPayload }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu2', isError: false, resultText: serializeGoalUpdateReport(reportB), parseReport: parseGoalUpdateReportPayload }, binding, 5)

    expect(managed.goal?.version).toBe(versionBefore + 2)
    expect(managed.goalRuntime?.progressedThisRound).toBe(true)
    expect(managed.goalRuntime?.staged).toHaveLength(0)
  })

  it('a result whose payload matches NO staged report is dropped observably', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding

    const reportA = parseGoalUpdateReportPayload(serializeGoalUpdateReport({ kind: 'progress', note: 'A' }))!
    controller.stageReport(managed, reportA, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu1', toolName: 'goal_update' }, binding, 5)
    const ghost = parseGoalUpdateReportPayload(serializeGoalUpdateReport({ kind: 'progress', note: 'never staged' }))!
    const versionBefore = goal.version
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu1', isError: false, resultText: serializeGoalUpdateReport(ghost), parseReport: parseGoalUpdateReportPayload }, binding, 5)
    expect(managed.goal?.version).toBe(versionBefore)
    expect(managed.goalRuntime?.staged).toHaveLength(1)
  })
})

describe('F6: byte-identical progress reports cannot stall the no-progress guard forever', () => {
  it('the same report every round still reaches the no-progress pause', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    let pausedRound = -1

    for (let round = 0; round < 5; round++) {
      const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 10 + round }
      managed.goalRuntime!.turn = binding
      managed.goalRuntime!.progressedThisRound = false // bindTurn resets this at the start of every real turn
      const same = parseGoalUpdateReportPayload(serializeGoalUpdateReport({ kind: 'progress', note: 'working on it' }))!
      controller.stageReport(managed, same, binding.generation)
      await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: `tu${round}`, toolName: 'goal_update' }, binding, binding.generation)
      await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: `tu${round}`, isError: false, resultText: serializeGoalUpdateReport(same), parseReport: parseGoalUpdateReportPayload }, binding, binding.generation)
      const action = await controller.onTurnComplete(managed, binding, { hasPendingHandoff: false, queuedMessages: 0 })
      if (action === 'paused_no_progress') { pausedRound = round; break }
    }
    // F-R2-6: a note-only report is NEVER progress — not even the first one.
    // The guard counts it from round 0, so the pause lands on the round that
    // brings the counter to GOAL_MAX_NO_PROGRESS_ROUNDS (0-based: exactly 3
    // note-only rounds, never 4).
    expect(pausedRound).toBe(GOAL_MAX_NO_PROGRESS_ROUNDS - 1)
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('no_progress')
    void state
  })

  it('a note-only change does NOT reset the guard (self-check a: rewording is not progress)', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)

    // Turn 1 is ALREADY no progress (F-R2-6: the seed fingerprint is the
    // null shape, so a note-only report matches it from the very first
    // round) — three note-only rounds pause exactly on the third.
    const notes = ['working on it', 'still working on it', 'a DIFFERENT round', 'yet another wording']
    let action = ''
    let roundsRun = 0
    for (let round = 0; round < notes.length; round++) {
      const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 10 + round }
      managed.goalRuntime!.turn = binding
      controller.bindTurn(managed, { userMessageId: `m-seed${round}`, content: 'seed', generation: 10 + round, internalContinuation: true })
      const report = parseGoalUpdateReportPayload(serializeGoalUpdateReport({ kind: 'progress', note: notes[round] }))!
      await stageThenObserve(controller, managed, binding, 10 + round, report, `tu-${round}`)
      action = await controller.onTurnComplete(managed, binding, { hasPendingHandoff: false, queuedMessages: 0 })
      roundsRun = round + 1
      if (action !== 'continue') break
    }

    // Every note is different, yet NONE of them is progress: the guard fires
    // after EXACTLY GOAL_MAX_NO_PROGRESS_ROUNDS note-only rounds (never 4 —
    // F-R2-6) and pauses.
    expect(action).toBe('paused_no_progress')
    expect(roundsRun).toBe(GOAL_MAX_NO_PROGRESS_ROUNDS)
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('no_progress')
  })

  it('a STRUCTURED change (todos advanced) resets the guard', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal, { noProgressRounds: 2 })
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    controller.bindTurn(managed, { userMessageId: 'm-seed', content: 'seed', generation: 5, internalContinuation: true })

    const advanced = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'progress',
      note: 'still going',
      todos: [{ id: 't1', label: 'Draft report', status: 'completed' }],
    }))!
    await stageThenObserve(controller, managed, binding, 5, advanced, 'tu-advanced')
    const action = await controller.onTurnComplete(managed, binding, { hasPendingHandoff: false, queuedMessages: 0 })
    expect(action).toBe('continue')
    expect(managed.goal?.status).toBe('active')
    expect(managed.goalRuntime?.noProgressRounds).toBe(0)
  })

  it('every persisted progress report checkpoints the observed run time (self-check b)', async () => {
    // The live segment is folded into elapsedMs at each progress write and the
    // clock restarts — a cold restart then keeps the OBSERVED runtime (only
    // the post-crash gap is dropped), instead of losing everything since the
    // last pause.
    const { host, state } = makeHost()
    state.now = 20_000
    const controller = new GoalController(host)
    const goal = makeGoal({ runningSince: 15_000, elapsedMs: 4_000 })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    controller.bindTurn(managed, { userMessageId: 'm-seed', content: 'seed', generation: 5, internalContinuation: true })

    const report = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'progress',
      todos: [{ id: 't1', label: 'Survey', status: 'completed' }],
    }))!
    await stageThenObserve(controller, managed, binding, 5, report, 'tu-checkpoint')

    // 4000 observed + (20000-15000) live segment = 9000, and the clock keeps
    // running from the checkpoint instant.
    expect(managed.goal?.elapsedMs).toBe(9_000)
    expect(managed.goal?.runningSince).toBe(20_000)
  })
})

describe('F8/Spec: verification stays inside the running goal; model attribution is honest', () => {
  it('the clock keeps RUNNING through verification and a pause during it stops the clock immediately', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal({ runningSince: 10_000, elapsedMs: 5_000 })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    const deferred = deferQuery(host, state)

    await submitCandidate(controller, managed, binding)
    const settled = startSettle(controller, managed, binding)
    await untilQueryStarted(state)
    // Spec (内部核对仍在运行期): the goal is verifying AND still charging time.
    expect(managed.goal?.runningSince).toBe(10_000)

    // A manual pause DURING verification stops the clock at once.
    await controller.pause(managed, 'manual', 'Paused by you.')
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.runningSince).toBeUndefined()
    expect(managed.goal?.elapsedMs).toBe(5_000) // host.now() is frozen at 10_000

    deferred.resolve(verdict('not_satisfied'))
    await settled
    expect(managed.goal?.pauseReason).toBe('manual')
  })

  it('resume() re-captures the verification model for the next run', async () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const managed = managedWith(makeGoal({ status: 'paused', pauseReason: 'manual' }))
    host.getEffectiveModel = () => 'switched-model'
    await controller.resume(managed)
    expect(managed.goalRuntime?.verificationModel).toBe('switched-model')
  })

  it('a verdict whose result carries usage but NO model attributes the ADDRESSED verification model (attempt-9)', async () => {
    // attempt-9 real run: the zhipu result message reported inputTokens/
    // outputTokens but no model field, so the completed-path receipt carried
    // usage with model=undefined. The query was explicitly ADDRESSED to
    // runtime.verificationModel — recording that is a fact about the query,
    // never an invented value.
    // F-R2-5: `ok: true` is required by the wire contract; the completed
    // receipt lives on the TERMINAL HISTORY record (completeGoal clears
    // managed.goal), so the assertions read the history entry.
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    managed.goalRuntime!.verificationModel = 'glm-5.3-flash'
    state.queryResults.push({
      ok: true,
      text: JSON.stringify({
        overall: 'passed',
        criteria: [{ criterion: 'The file exists with the summary', passed: true, evidenceIds: [0] }],
        summary: 'complete',
      }),
      inputTokens: 6958,
      outputTokens: 5600,
      // model deliberately ABSENT — exactly what the real endpoint returned.
    })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: 'docs/notes.md' }]))

    expect(managed.goal).toBeUndefined()
    const completed = managed.goalHistory![managed.goalHistory!.length - 1]
    expect(completed.status).toBe('completed')
    expect(completed.verification?.status).toBe('passed')
    expect(completed.verification?.model).toBe('glm-5.3-flash')
    expect(completed.verification?.inputTokens).toBe(6958)
    expect(completed.verification?.outputTokens).toBe(5600)
  })

  it('an SDK-reported model always WINS over the addressed model (no overwrite)', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    managed.goalRuntime!.verificationModel = 'addressed-model'
    state.queryResults.push({
      ok: true,
      text: JSON.stringify({
        overall: 'passed',
        criteria: [{ criterion: 'The file exists with the summary', passed: true, evidenceIds: [0] }],
        summary: 'complete',
      }),
      model: 'sdk-reported-model',
    })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: 'docs/notes.md' }]))

    const completed = managed.goalHistory![managed.goalHistory!.length - 1]
    expect(completed.status).toBe('completed')
    expect(completed.verification?.model).toBe('sdk-reported-model')
  })

  it('the verification prompt states the EXACT valid evidence index range (attempt-9 unbacked verdicts)', () => {
    const goal = makeGoal()
    const prompt = buildVerificationPrompt(goal, '[evidence 0] file docs/notes.md', 2)
    expect(prompt).toContain('EXACTLY 2 evidence items')
    expect(prompt).toContain('[0, 1]')
    // The legacy shape (no count) still renders.
    expect(buildVerificationPrompt(goal, 'material')).toContain('Verified material (server-validated evidence')
  })
})

/** Pin the host clock (tests assert elapsed math against it). */
function state_now(host: GoalControllerHost, now: number): void {
  ;(host as unknown as { now: (n?: number) => number }).now = () => now
}

describe('F3: cold-start recovery keeps the persisted goal history (real storage stack)', () => {
  it('async: recoverOnColdStart\'s header write preserves the completed goalHistory on disk', async () => {
    // Reproduces reviewer F3 against the REAL WorkspaceSessionStorage +
    // writeSessionJsonl + updateSessionMetadata stack: the controller must
    // forward the ALREADY-LOADED history through persistGoalMetadataCold —
    // the host persists exactly what it is given, so passing [] erased every
    // completed record on the first restart after a goal.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-history-'))
    try {
      const completedGoal: GoalRecord = {
        ...makeGoal(),
        id: 'goal-completed-1',
        status: 'completed',
        elapsedMs: 60_000,
        completedAt: 2_000,
      }

      const sessionFile = getSessionFilePath(tmpRoot, 's1')
      mkdirSync(join(sessionFile, '..'), { recursive: true })
      const session = {
        id: 's1',
        name: 'goal-history-regression',
        createdAt: 1,
        lastUsedAt: 2,
        messages: [],
        workspaceRootPath: tmpRoot,
      } as unknown as StoredSession
      ;(session as unknown as Record<string, unknown>).goal = { ...completedGoal, id: 'goal-running-2', status: 'active', runningSince: 3_000 }
      ;(session as unknown as Record<string, unknown>).goalHistory = [completedGoal]
      ;(session as unknown as Record<string, unknown>).goalProjectionRevision = 7
      writeSessionJsonl(sessionFile, session)

      expect(((readSessionHeader(sessionFile) as unknown as Record<string, unknown>).goalHistory as unknown[])).toHaveLength(1)

      // The controller + the production-shaped host: recoverOnColdStart on a
      // hydrated session (history loaded from the header), and the host
      // persisting EXACTLY what it receives through updateSessionMetadata —
      // the same bounded slice the SessionManager host forwards.
      const { host } = makeHost()
      host.persistGoalMetadataCold = async (sessionId, goal, history, revision) => {
        await updateSessionMetadata(tmpRoot, sessionId, {
          goal,
          goalHistory: history.slice(-20),
          goalProjectionRevision: revision,
        }, new WorkspaceSessionStorage())
      }
      const controller = new GoalController(host)
      const managed = managedWith({ ...completedGoal, id: 'goal-running-2', status: 'active', runningSince: 3_000 })
      managed.goalHistory = [completedGoal]
      managed.goalProjectionRevision = 7
      await controller.recoverOnColdStart(managed)

      // The running goal is recovered; the completed record SURVIVES on disk.
      expect(managed.goal?.status).toBe('paused')
      expect(managed.goal?.pauseReason).toBe('restart_required')
      expect(managed.goal?.runningSince).toBeUndefined()
      const header = readSessionHeader(sessionFile) as unknown as Record<string, unknown>
      const persistedHistory = (header.goalHistory as GoalRecord[]) ?? []
      expect(persistedHistory).toHaveLength(1)
      expect(persistedHistory[0].id).toBe('goal-completed-1')
      expect(persistedHistory[0].elapsedMs).toBe(60_000)
      expect(header.goalProjectionRevision).toBe(8)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

// ============================================================
// R2 review fixes: F-S1/F-S2 (parser), F-R2-2 (prompt materials),
// F-R2-3/4 (goal-owned evidence), F-R2-6 (no-progress seed),
// F-R2-7 (queue admission vs in-flight verdict), F-R2-1 (controller half).
// ============================================================

describe('F-S1/F-S2: the verification parser is strict (fail-closed)', () => {
  const legal = {
    overall: 'passed',
    criteria: [{ criterion: 'The file exists with the summary', passed: true, evidenceIds: [0], note: 'digest matches' }],
    summary: 'Satisfied.',
  }

  it('a legal verdict still parses (control)', () => {
    expect(parseVerificationAnswer(JSON.stringify(legal))).not.toBeNull()
  })

  it('a fractional evidence id is REJECTED, never truncated to a neighbor (F-S1)', () => {
    // Supplement-review probe: 0.5 previously truncated to evidence #0 and
    // was accepted as a real citation; -0.5 truncated to -0 === 0.
    for (const bad of [0.5, -0.5, 1.5, -1.25]) {
      const verdict = {
        ...legal,
        criteria: [{ ...legal.criteria[0], evidenceIds: [bad] }],
      }
      expect(parseVerificationAnswer(JSON.stringify(verdict))).toBeNull()
    }
  })

  it('a repeated criterion is rejected even when both lines agree (F-S2)', () => {
    const duplicated = {
      ...legal,
      criteria: [legal.criteria[0], { ...legal.criteria[0], note: 'restated' }],
    }
    expect(parseVerificationAnswer(JSON.stringify(duplicated))).toBeNull()
  })

  it('a contradictory criterion pair is rejected in EITHER order (F-S2)', () => {
    const passedLine = { criterion: 'The file exists with the summary', passed: true, evidenceIds: [0] }
    const failedLine = { criterion: 'the FILE EXISTS WITH THE SUMMARY', passed: false, evidenceIds: [0] }
    // true-first: find()-based coverage previously took the true line and
    // ignored the false one; the verdict must fail closed instead.
    expect(parseVerificationAnswer(JSON.stringify({ ...legal, criteria: [passedLine, failedLine] }))).toBeNull()
    expect(parseVerificationAnswer(JSON.stringify({ ...legal, criteria: [failedLine, passedLine] }))).toBeNull()
  })

  it('integers, including 0 and the last index, still parse', () => {
    const verdict = { ...legal, criteria: [{ ...legal.criteria[0], evidenceIds: [0, 2] }] }
    expect(parseVerificationAnswer(JSON.stringify(verdict))?.criteria[0].evidenceIds).toEqual([0, 2])
  })

  it('the output schema demands integers for evidenceIds', () => {
    const schema = GOAL_VERIFICATION_OUTPUT_SCHEMA as {
      properties: { criteria: { items: { properties: { evidenceIds: { items: { type: string } } } } } }
    }
    expect(schema.properties.criteria.items.properties.evidenceIds.items.type).toBe('integer')
  })
})

describe('F-R2-2: the verification prompt carries the REAL accepted supplement text', () => {
  it('renders every supplement body as a binding requirement, not a count', () => {
    const goal = makeGoal({ supplementMessageIds: ['m-supp-1', 'm-supp-2'] })
    const prompt = buildVerificationPrompt(goal, '[evidence 0] file /tmp/x', 1, [
      { messageId: 'm-supp-1', text: '必须包含中文摘要' },
      { messageId: 'm-supp-2', text: 'Add a chart' },
    ])
    expect(prompt).toContain('必须包含中文摘要')
    expect(prompt).toContain('Add a chart')
    expect(prompt).toContain('[user message m-supp-1]')
    expect(prompt).toContain('binding requirement')
    // The verifier is told a supplement omitted from the criteria list is
    // NOT excluded from the judgment.
    expect(prompt).toContain('not_satisfied')
    expect(prompt).toContain('judge it anyway')
  })

  it('verifyCandidate injects the RESOLVED persisted supplement text into the real query', async () => {
    const { host, state } = makeHost()
    state.messages.push({ id: 'm-supp-1', role: 'user', content: '必须包含中文摘要', timestamp: 1_500 })
    const controller = new GoalController(host)
    const goal = makeGoal({ supplementMessageIds: ['m-supp-1'] })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    managed.goalRuntime!.verificationModel = 'test-verifier-model'
    state.files.set('/tmp/report.md', { content: '# Report' })
    let capturedPrompt = ''
    host.queryLlm = async (_sessionId, request) => {
      capturedPrompt = request.prompt
      return { text: JSON.stringify({ overall: 'not_satisfied', criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'no Chinese summary' }], summary: 'supplement unmet' }) }
    }

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))

    // The REAL prompt material the verifier judged on includes the supplement.
    expect(capturedPrompt).toContain('必须包含中文摘要')
    expect(capturedPrompt).toContain('[user message m-supp-1]')
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.verification?.status).toBe('not_satisfied')
  })

  it('a supplement whose message is no longer persisted fails verification closed', async () => {
    const { host, state } = makeHost()
    // m-gone is recorded as accepted but the message body is not in history.
    const controller = new GoalController(host)
    const goal = makeGoal({ supplementMessageIds: ['m-gone'] })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    state.files.set('/tmp/report.md', { content: '# Report\nsummary present' })
    state.queryResults.push({ ok: true, text: verdict('passed') })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))

    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.verification?.status).toBe('failed')
    expect(managed.goal?.verification?.error).toContain('m-gone')
    expect(managed.goal?.verification?.error).toContain('no longer persisted')
  })
})

describe('F-R2-3/F-R2-4: message evidence belongs to the goal that produced it', () => {
  it('noteProducedAssistantMessage captures only the bound goal turn at its own generation', () => {
    const { host } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 7 }
    managed.goalRuntime!.turn = binding
    const versionBefore = goal.version

    expect(controller.noteProducedAssistantMessage(managed, 'm-final', 7)).toBe(true)
    expect(managed.goal?.producedMessageIds).toEqual(['m-final'])
    expect(managed.goal?.version).toBe(versionBefore + 1)

    // A different processing generation (a superseded/foreign turn) never
    // re-parents its output onto this goal.
    expect(controller.noteProducedAssistantMessage(managed, 'm-stray', 8)).toBe(false)
    expect(managed.goal?.producedMessageIds).toEqual(['m-final'])

    // Duplicate capture is a no-op.
    expect(controller.noteProducedAssistantMessage(managed, 'm-final', 7)).toBe(false)

    // An unbound turn captures nothing.
    const unbound = managedWith(makeGoal())
    unbound.goalRuntime!.turn = undefined
    expect(controller.noteProducedAssistantMessage(unbound, 'm-x', 7)).toBe(false)
    expect(unbound.goal?.producedMessageIds).toBeUndefined()

    // A terminal goal captures nothing (a later goal's output is never
    // inherited by a completed record).
    const ended = managedWith(makeGoal({ status: 'completed' }))
    expect(controller.noteProducedAssistantMessage(ended, 'm-y', 7)).toBe(false)
  })

  it('message evidence cites ONLY goal-produced ids; an earlier goal\'s final message fails closed', async () => {
    const { host, state } = makeHost()
    // The session still holds the PREVIOUS goal's final message…
    state.messages.push({ id: 'm-older-goal', role: 'assistant', isIntermediate: false, content: 'Old goal output', timestamp: 2_000 })
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    managed.goalRuntime!.verificationModel = 'test-verifier-model'
    // …but THIS goal never produced it.
    void state.queryResults.push({ ok: true, text: verdict('passed') })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'message', messageId: 'm-older-goal' }]))

    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.verification?.status).toBe('failed')
    expect(managed.goal?.verification?.error).toContain('produced by this goal')

    // The SAME session, with the id captured as THIS goal's own output,
    // verifies normally.
    const { host: host2, state: state2 } = makeHost()
    state2.messages.push({ id: 'm-own', role: 'assistant', isIntermediate: false, content: 'This goal\'s own text deliverable', timestamp: 3_000 })
    const controller2 = new GoalController(host2)
    const goal2 = makeGoal()
    const managed2 = managedWith(goal2)
    const binding2 = { goalId: goal2.id, runGeneration: goal2.runGeneration, generation: 5 }
    managed2.goalRuntime!.turn = binding2
    managed2.goalRuntime!.verificationModel = 'test-verifier-model'
    controller2.noteProducedAssistantMessage(managed2, 'm-own', 5)
    state2.queryResults.push({ ok: true, text: verdict('passed') })

    await stageThenObserve(controller2, managed2, binding2, 5, candidateReport([{ kind: 'message', messageId: 'm-own' }]))

    expect(managed2.goal).toBeUndefined()
    const completed = managed2.goalHistory![managed2.goalHistory!.length - 1]
    expect(completed.status).toBe('completed')
    expect(completed.candidate?.evidence[0].kind).toBe('message')
  })

  it('the continuation prompt exposes ONLY this goal\'s produced message ids with excerpts (F-R2-4)', async () => {
    const { host, state } = makeHost()
    state.messages.push({ id: 'm-own', role: 'assistant', isIntermediate: false, content: '纯文字成果：本次讨论的完整总结。', timestamp: 3_000 })
    state.messages.push({ id: 'm-unrelated', role: 'assistant', isIntermediate: false, content: 'Ordinary chat the goal never produced', timestamp: 3_100 })
    const controller = new GoalController(host)
    const goal = makeGoal({ producedMessageIds: ['m-own'] })
    const managed = managedWith(goal)

    await controller.continueGoal(managed)

    expect(state.continuations).toHaveLength(1)
    const prompt = state.continuations[0]
    expect(prompt).toContain('[message m-own]')
    expect(prompt).toContain('纯文字成果：本次讨论的完整总结。')
    expect(prompt).toContain('no other message id will verify')
    // An unproduced message is never exposed.
    expect(prompt).not.toContain('m-unrelated')
  })

  it('admitSupplementFromQueue binds a real queued message id and bumps the version', () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const versionBefore = goal.version

    expect(controller.admitSupplementFromQueue(managed, 'm-queued-1')).toBe(true)
    expect(managed.goal?.supplementMessageIds).toContain('m-queued-1')
    expect(managed.goal?.version).toBe(versionBefore + 1)
    expect(state.projections.length).toBeGreaterThan(0)

    // Replay of the SAME message id (queue replay → bindTurn) never duplicates.
    expect(controller.admitSupplementFromQueue(managed, 'm-queued-1')).toBe(false)
    expect(managed.goal?.supplementMessageIds.filter(id => id === 'm-queued-1')).toHaveLength(1)

    // A manually-paused goal binds nothing: ordinary chat stays ordinary chat.
    const paused = managedWith(makeGoal({ status: 'paused', pauseReason: 'manual' }))
    expect(controller.admitSupplementFromQueue(paused, 'm-queued-2')).toBe(false)
    expect(paused.goal?.supplementMessageIds).toHaveLength(0)
    expect(paused.goal?.version).toBe(makeGoal({ status: 'paused', pauseReason: 'manual' }).version)
  })
})

describe('F-R2-7: a supplement admitted during verification invalidates the in-flight verdict', () => {
  it('a verdict settling AFTER the admission is discarded and the goal returns to active (never completed, never stranded)', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    const deferred = deferQuery(host, state)

    await submitCandidate(controller, managed, binding)
    const settled = startSettle(controller, managed, binding)
    await untilQueryStarted(state)

    // The user's message is accepted at the REAL admission point while the
    // independent query is still in flight.
    const versionAtVerifying = managed.goal?.version
    expect(controller.admitSupplementFromQueue(managed, 'm-queued-mid-verify')).toBe(true)
    expect(managed.goal?.version).toBe(versionAtVerifying! + 1)

    deferred.resolve(verdict('passed'))
    await settled

    // The pre-supplement verdict can no longer complete the goal…
    expect(managed.goal).toBeDefined()
    expect(managed.goal?.status).toBe('active')
    expect(managed.goalHistory ?? []).toHaveLength(0)
    // …the goal is NOT stranded in 'verifying', and the supplement is bound
    // for the next round.
    expect(managed.goal?.supplementMessageIds).toContain('m-queued-mid-verify')
    expect(state.appended.join('\n')).toContain('PASSED after the goal was already verifying')
  })
})

describe('F-R2-1 (controller half): pause/end invalidates the in-flight verdict before the abort', () => {
  it('a verdict settling after an explicit END cannot complete the goal', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    const deferred = deferQuery(host, state)

    await submitCandidate(controller, managed, binding)
    const settled = startSettle(controller, managed, binding)
    await untilQueryStarted(state)

    // The user ends the goal while the query is in flight: terminal state
    // written + flushed FIRST, verification cancelled.
    await controller.end(managed, 'Ended by you.')
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory![managed.goalHistory!.length - 1].status).toBe('ended')

    deferred.resolve(verdict('passed'))
    await settled

    // The late pass stays a transcript notice; the goal is NOT completed.
    expect(managed.goalHistory![managed.goalHistory!.length - 1].status).toBe('ended')
    expect(managed.goalHistory).toHaveLength(1)
    expect(state.appended.join('\n')).toContain('PASSED after the goal was ended')
  })

  it('a verdict settling after an explicit PAUSE cannot complete the goal and keeps the manual attribution', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    const deferred = deferQuery(host, state)

    await submitCandidate(controller, managed, binding)
    const settled = startSettle(controller, managed, binding)
    await untilQueryStarted(state)

    await controller.pause(managed, 'manual', 'Paused by you.')
    deferred.resolve(verdict('passed'))
    await settled

    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('manual')
    expect(managed.goalHistory ?? []).toHaveLength(0)
  })
})

// ============================================================
// POO-134 ICR regressions (internal review round 3).
// Each block pins the behavior the internal code review demanded;
// the probes in reviewer-internal-context-risk expected the BUG
// state — these maintenance copies expect the correct behavior.
// ============================================================

describe('ICR-2: server execution facts reach the verifier as CONTEXT, never as evidence', () => {
  function factsCandidateTurn() {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { goal, managed, binding } = candidateTurn()
    // Two real tool calls recorded by the host before the candidate.
    managed.goalRuntime!.factScratch = [
      { seq: 1, runGeneration: goal.runGeneration, at: 9_500, kind: 'tool_call', toolName: 'write', toolUseId: 'tu-w', paramSummary: '{"path":"docs/notes.md"}' },
      { seq: 2, runGeneration: goal.runGeneration, at: 9_600, kind: 'tool_call', toolUseId: 'tu-w', isError: false, resultSummary: 'wrote 23 bytes' },
    ]
    state.files.set('/tmp/report.md', { content: '# Report\nsummary present' })
    state.queryResults.push({ ok: true, text: JSON.stringify({
      overall: 'not_satisfied',
      criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'summary missing' }],
      summary: 'not there yet',
    }) })
    return { host, state, controller, goal, managed, binding }
  }

  it('the facts block rides in the prompt OUTSIDE the numbered evidence space', async () => {
    const { state, controller, managed, binding } = factsCandidateTurn()
    // ONE file evidence item → EXACTLY 1 evidence slot; the 2 facts must not
    // grow that space (a verifier citing the record by index would be citing
    // nothing the server validated as candidate material).
    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))

    // The prompt as actually addressed to the verification model.
    const recordedPrompt = state.lastPrompt ?? ''
    expect(recordedPrompt).toContain('Server-recorded execution facts')
    expect(recordedPrompt).toContain('CONTEXT ONLY')
    expect(recordedPrompt).toContain('tool write')
    expect(recordedPrompt).toContain('EXACTLY 1 evidence items')
    // The process-step rule: a process criterion cannot pass without facts.
    expect(recordedPrompt).toContain('PROCESS step')
  })

  it('an EMPTY record is stated, and the verifier is told what that forbids', async () => {
    // A goal whose execution facts were never committed (defensive state, e.g.
    // an older record resumed by a newer binary): the verifier must be TOLD,
    // and the incompleteness must land on the receipt.
    const { state, controller, managed, binding } = factsCandidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    await submitCandidate(controller, managed, binding)
    expect(managed.goal?.status).toBe('verifying')
    // A goal whose facts were never committed (defensive state, e.g. a record
    // written by an older binary).
    managed.goal = { ...managed.goal!, executionFacts: undefined }
    managed.goalRuntime!.factScratch = []
    await settleNow(controller, managed, binding)
    expect(state.lastPrompt).toContain('Server execution record: EMPTY')
    expect(state.lastPrompt).toContain('MUST be judged passed=false')
    expect(managed.goal?.verification?.executionFactsNote).toContain('no server-recorded execution facts')
  })

  it('a truncated record announces the drop to the verifier and on the receipt', async () => {
    const { state, controller, managed, binding } = factsCandidateTurn()
    // Pre-existing record already at the cap with an explicit drop count.
    managed.goal = { ...managed.goal!, executionFacts: { facts: [], truncated: true, droppedCount: 7 } }
    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    const recordedPrompt = state.lastPrompt ?? ''
    expect(recordedPrompt).toContain('RECORD INCOMPLETE')
    expect(recordedPrompt).toContain('TRUNCATED')
    expect(managed.goal?.verification?.executionFactsNote).toContain('TRUNCATED')
  })
})

describe('ICR-2: the rejected verdict of round N is injected into round N+1', () => {
  it('the continuation prompt carries the per-criterion findings of the failed verification', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { goal, managed, binding } = candidateTurn()
    state.files.set('/tmp/report.md', { content: '# Report' })
    state.queryResults.push({ ok: true, text: JSON.stringify({
      overall: 'not_satisfied',
      criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'the summary section is missing' }],
      summary: 'file exists but lacks the required summary',
    }) })

    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.verification?.status).toBe('not_satisfied')

    await controller.continueGoal(managed, 'automatic')
    expect(state.continuations).toHaveLength(1)
    const prompt = state.continuations[0]!
    expect(prompt).toContain('Previous independent verification of this goal did NOT pass')
    expect(prompt).toContain('the summary section is missing')
    // The binding identity is the SERVER's, and the prompt is not a user turn.
    expect(prompt).toContain(`goal_id="${goal.id}"`)
    expect(prompt).toContain('This is not a new user message')
  })

  it('a PASSED goal never injects rejection feedback (terminal path takes over)', async () => {
    const prompt = buildGoalContinuationPrompt({
      ...createGoalRecord({ sessionId: 's1', anchorMessageId: 'm', objective: 'o', criteria: ['c'], now: 1 }),
      verification: { status: 'passed', criteria: [], verifiedAt: 1 },
    } as GoalRecord, [])
    expect(prompt).not.toContain('did NOT pass')
  })
})

describe('ICR-3: persistence failure is fail-safe and user-visible', () => {
  it('a FAILED resume flush rolls back to the paused record and tells the user', async () => {
    const failing = makeHost()
    failing.state.flushed = 0
    const brokenHost: GoalControllerHost = {
      ...failing.host,
      flushSession: async () => { throw new Error('disk full') },
    }
    const controller = new GoalController(brokenHost)
    const paused = makeGoal({ status: 'paused', pauseReason: 'manual', elapsedMs: 5_000, runningSince: undefined })
    const managed = managedWith(paused)

    const outcome = await controller.resume(managed)
    // The resume is REFUSED — never reported as running while the durable
    // state still says paused.
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('disk full')
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('manual')
    expect(managed.goal?.runningSince).toBeUndefined()
    expect(managed.goal?.version).toBe(paused.version)
    // Nothing was scheduled: no continuation turn for a goal that did not resume.
    expect(failing.state.storageFailures.join(' ')).toContain('could not be resumed')
  })

  it('a FAILED end flush still publishes the terminal projection and reports the failure', async () => {
    const { host, state } = makeHost()
    let flushes = 0
    const brokenHost: GoalControllerHost = {
      ...host,
      flushSession: async () => { flushes++; throw new Error('disk full') },
    }
    const controller = new GoalController(brokenHost)
    const managed = managedWith(makeGoal())

    const outcome = await controller.end(managed, 'Ended by you.')
    expect(outcome.ok).toBe(true)
    expect(outcome.flushed).toBe(false)
    // Terminal projection is published BEFORE the flush is awaited.
    expect(state.projections.at(-1)?.goalId).toBeUndefined()
    expect(managed.goal).toBeUndefined()
    expect(managed.goalHistory![0].status).toBe('ended')
    expect(state.storageFailures.join(' ')).toContain('could not be written to disk')
    expect(flushes).toBe(1)
  })
})

describe('ICR-4: the deferred verification is settled inside the turn lease only', () => {
  it('a settle whose processing generation moved on discards the pending WITHOUT a query (C1)', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })

    await submitCandidate(controller, managed, binding)
    expect(managed.goal?.status).toBe('verifying')
    // The WRONG generation (a newer turn owns the session now): the pending
    // verification of the old turn is dropped before any query is addressed.
    const outcome = await controller.settlePendingVerification(managed, binding, {
      generation: binding.generation + 1,
      stillCurrent: () => true,
    })
    expect(outcome).toBe('stale')
    expect(state.lastQueryOptions).toBeUndefined()
    expect(managed.goal?.status).toBe('verifying') // untouched, still waiting its own settle
  })

  it('a verdict arriving after the turn lease ended is discarded with a late-pass notice (C3)', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    const deferred = deferQuery(host, state)

    let leaseCurrent = true
    await submitCandidate(controller, managed, binding)
    const settled = controller.settlePendingVerification(managed, binding, {
      generation: binding.generation,
      stillCurrent: () => leaseCurrent,
    })
    await untilQueryStarted(state)

    // The turn ENDS (natural completion) while the query is in flight.
    leaseCurrent = false
    deferred.resolve(verdict('passed'))
    const outcome = await settled

    expect(outcome).toBe('stale')
    // A late pass is a transcript notice — never a state write.
    expect(state.appended.join('\n')).toContain('PASSED after the turn ended')
    expect(managed.goalHistory ?? []).toHaveLength(0)
    // The goal is un-stranded: back to active, ready for the next round.
    expect(managed.goal?.status).toBe('active')
  })

  it('a settle with NO pending candidate is a no-op (never queries)', async () => {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    const outcome = await controller.settlePendingVerification(managed, binding, {
      generation: binding.generation,
      stillCurrent: () => true,
    })
    expect(outcome).toBe('none')
    expect(state.lastQueryOptions).toBeUndefined()
  })

  it('a supplement admitted BEFORE the settle query starts discards the pending with NO query at all', async () => {
    // The counterpart of the in-flight F-R2-7 case, kept as its OWN scenario:
    // here the admission happens while the reporting turn is still live and the
    // settle has not yet addressed the verifier. The version precondition must
    // drop the stale snapshot before ANY query — the verifier is never asked to
    // judge a candidate the goal has already moved past.
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })

    await submitCandidate(controller, managed, binding)
    expect(managed.goal?.status).toBe('verifying')

    // The supplement is admitted (queue admission) while the reporting turn is
    // still bound: the version bump orphans the recorded candidate.
    expect(controller.admitSupplementFromQueue(managed, 'm-queued-before-query')).toBe(true)

    // The reporting turn then completes; the settle sees the stale version.
    const settled = await controller.settlePendingVerification(managed, binding, {
      generation: binding.generation,
      stillCurrent: () => true,
    })
    expect(settled).toBe('stale')
    expect(state.queryCalls).toBe(0) // the stale candidate is dropped BEFORE any query
    // Not stranded: the goal returns to active so the admitted supplement
    // round re-verifies with the supplement bound.
    expect(managed.goal?.status).toBe('active')
    expect(managed.goalHistory ?? []).toHaveLength(0)
    expect(managed.goal?.supplementMessageIds).toContain('m-queued-before-query')
  })

  it('a candidate deferred across an auth-retry window settles EXACTLY ONCE on the retry turn (C2)', async () => {
    // The chat loop's complete branch returns early while an auth retry is in
    // flight, so no settle happens for the reporting turn. The pending slot is
    // the only carrier across that window: the retry turn re-binds (retry does
    // NOT bump the run generation), and ITS complete branch settles the SAME
    // pending exactly once — one query, one receipt, one completion.
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { managed, binding } = candidateTurn()
    state.files.set('docs/notes.md', { content: '# Notes\nsummary present' })
    state.queryResults.push({ ok: true, text: verdict('passed') })

    await submitCandidate(controller, managed, binding)
    expect(managed.goal?.status).toBe('verifying')
    expect(managed.goal?.runGeneration).toBe(binding.runGeneration)

    // AUTH-RETRY WINDOW: the reporting turn's complete branch never settles.
    // The retry turn starts and re-binds the session's turn lease at a NEW
    // processing generation (the goal record itself is untouched).
    const rebound = controller.bindTurn(managed, { content: '[retry turn re-bind]', generation: binding.generation + 1, internalContinuation: true })
    expect(rebound.bound).toBe(true)
    const retryBinding = rebound.bound ? rebound.binding : binding
    expect(retryBinding.generation).toBe(binding.generation + 1)
    expect(retryBinding.runGeneration).toBe(binding.runGeneration) // a retry never bumps the run generation
    expect(managed.goal?.status).toBe('verifying') // the pending survived the window

    // The retry turn's complete branch settles — with the RETRY generation.
    const settled = await controller.settlePendingVerification(managed, retryBinding, {
      generation: retryBinding.generation,
      stillCurrent: () => managed.goalRuntime?.turn === retryBinding,
    })
    expect(settled).toBe('settled')
    // Completion moves the record into the history and clears the live slot.
    const completedRecord = (managed.goalHistory ?? []).find(r => r.id === binding.goalId) as GoalRecord | undefined
    expect(managed.goal).toBeUndefined()
    expect(completedRecord?.status).toBe('completed')
    expect(completedRecord?.verification?.status).toBe('passed')

    // And exactly once: the pending slot is consumed, a second settle is a
    // no-op that never re-queries and never re-completes.
    expect(state.queryCalls).toBe(1)
    const again = await controller.settlePendingVerification(managed, retryBinding, {
      generation: retryBinding.generation,
      stillCurrent: () => true,
    })
    expect(again).toBe('none')
    expect(state.queryCalls).toBe(1)
    expect((managed.goalHistory ?? []).filter(r => r.id === binding.goalId)).toHaveLength(1)
  })
})

describe('C6: the internal-turn transcript asymmetry survives a cold start', () => {
  it('async: after internal turns the JSONL holds only REAL input, and a restart still yields a resumable goal whose continuation prompt rebuilds the full lineage', async () => {
    // ICR-1 stopped persisting internal continuation prompts. The SDK
    // subprocess side still SEES those turns, while the durable JSONL does
    // not — C6 asks that this asymmetry never breaks the restart→resume
    // path: the anchor, the goal-owned produced messages and the history
    // must all still resolve from the durable record alone.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sm-goal-c6-asymmetry-'))
    try {
      const sessionFile = getSessionFilePath(tmpRoot, 's-c6')
      mkdirSync(join(sessionFile, '..'), { recursive: true })
      // What the DURABLE record looks like after ICR-1: the real user
      // objective and the goal's own produced answers. NO internal prompt,
      // even though the model ran through two internal rounds.
      const session = {
        id: 's-c6',
        name: 'c6-asymmetry',
        createdAt: 1,
        lastUsedAt: 2,
        workspaceRootPath: tmpRoot,
        messages: [
          { id: 'm-user-1', type: 'user', role: 'user', content: 'Write the report file', timestamp: 1_000 },
          { id: 'm-a-1', type: 'assistant', role: 'assistant', isIntermediate: false, content: 'Round 1 draft.', timestamp: 2_000 },
          { id: 'm-a-2', type: 'assistant', role: 'assistant', isIntermediate: false, content: 'Round 2 finished the report.', timestamp: 3_000 },
        ],
      } as unknown as StoredSession
      const runningGoal = {
        ...makeGoal({ id: 'goal-c6', status: 'active', runningSince: 2_500, elapsedMs: 1_500 }),
        anchorMessageId: 'm-user-1',
        producedMessageIds: ['m-a-1', 'm-a-2'],
        executionFacts: {
          facts: [
            { seq: 1, runGeneration: 1, at: 2_600, kind: 'turn_started' as const },
            { seq: 2, runGeneration: 1, at: 2_700, kind: 'tool_call' as const, toolName: 'goal_update', toolUseId: 'tu-1', isError: false },
          ],
          truncated: false,
          droppedCount: 0,
        },
      }
      ;(session as unknown as Record<string, unknown>).goal = runningGoal
      ;(session as unknown as Record<string, unknown>).goalHistory = []
      writeSessionJsonl(sessionFile, session)

      // The durable record never contained an internal prompt.
      const rawBefore = readSessionJsonl(sessionFile)
      expect(rawBefore?.messages.filter(m => m.type === 'user').map(m => m.content)).toEqual(['Write the report file'])

      // COLD START: the real controller recovers the running goal from the
      // durable header alone.
      const { host, state } = makeHost()
      state.messages = session.messages.map(m => ({
        id: m.id,
        role: (m as unknown as { role: string }).role,
        isIntermediate: (m as { isIntermediate?: boolean }).isIntermediate ?? false,
        content: m.content,
        timestamp: m.timestamp ?? 0,
      }))
      host.persistGoalMetadataCold = async (sessionId, goal, history, revision) => {
        await updateSessionMetadata(tmpRoot, sessionId, {
          goal,
          goalHistory: history.slice(-20),
          goalProjectionRevision: revision,
        }, new WorkspaceSessionStorage())
      }
      const controller = new GoalController(host)
      const managed = managedWith({ ...runningGoal, runGeneration: 1 })
      managed.goalHistory = []
      managed.goalProjectionRevision = 3
      await controller.recoverOnColdStart(managed)

      // Recovered as paused-restart_required, lineage intact.
      expect(managed.goal?.status).toBe('paused')
      expect(managed.goal?.pauseReason).toBe('restart_required')
      expect(managed.goal?.anchorMessageId).toBe('m-user-1')
      expect(managed.goal?.producedMessageIds).toEqual(['m-a-1', 'm-a-2'])

      // RESUME: the continuation prompt is composed from the DURABLE lineage
      // alone — the anchor objective AND the goal-owned produced messages are
      // all present, so the resumed round is not blinded by the missing
      // internal turns.
      const resumed = await controller.resume(managed)
      expect(resumed.ok).toBe(true)
      expect(state.continuations).toHaveLength(1)
      const prompt = state.continuations[0]!
      expect(prompt).toContain('<goal_continuation')
      expect(prompt).toContain('Write the report file')
      expect(prompt).toContain('m-a-1')
      expect(prompt).toContain('m-a-2')
      // ...and what the prompt carries is server-composed ONLY: the durable
      // record it was rebuilt from still holds no internal prompt.
      const rawAfter = readSessionJsonl(sessionFile)
      expect(rawAfter?.messages.some(m => m.content.includes('<goal_continuation'))).toBe(false)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

// ====================================================================
// Review r1 F1 (production / medium): SEVERAL own-final captures in the SAME
// turn are the controller's OWN ledger accounting — none of them is a user
// supplement. A Claude-backend turn reaches this for real: after the candidate
// goal_update, a Task sub-agent's sidechain stream delivers a NON-intermediate
// text_complete BEFORE the main turn's own final, and both landed in
// noteProducedAssistantMessage. Only the FIRST capture was granted an
// internalLedgerBump, so the settle point compared pending.version+1 against
// goal.version+2 and discarded a perfectly good candidate as "a supplement
// arrived after the candidate" — zero verification queries, the goal back to
// active, an extra paid round for nothing.
// ====================================================================

/** Drive a candidate through the REAL production channels (stage at the
 *  callback, apply at the matching tool_result) WITHOUT settling — the
 *  settlement belongs to the turn-complete point, which these tests control
 *  explicitly. */
async function stageCandidateWithoutSettling(
  controller: GoalController,
  managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
  binding: { goalId: string; runGeneration: number; generation: number },
  toolUseId: string,
) {
  const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
    kind: 'candidate',
    candidate: {
      summary: 'Done — the report is written.',
      evidence: [{ kind: 'message', messageId: 'm-a1' }],
    },
  }))!
  controller.stageReport(managed, wire, binding.generation)
  await controller.observeTurnEvent(
    managed,
    { type: 'tool_start', toolUseId, toolName: 'goal_update' },
    binding,
    binding.generation,
  )
  await controller.observeTurnEvent(
    managed,
    { type: 'tool_result', toolUseId, isError: false, resultText: serializeGoalUpdateReport(wire), parseReport: parseGoalUpdateReportPayload },
    binding,
    binding.generation,
  )
}

describe('review r1 F1: multiple own-final captures in one turn are ledger accounting, not supplements', () => {
  function doubleFinalFixture() {
    const { host, state } = makeHost()
    state.queryResults.push({
      ok: true,
      text: JSON.stringify({
        overall: 'passed',
        criteria: [{ criterion: 'The file exists with the summary', passed: true, evidenceIds: [0] }],
        summary: 'verified by the independent no-tools query',
      }),
    })
    const controller = new GoalController(host)
    // An EARLIER round's captured output — the citable message evidence the
    // candidate cites (F-R2-3/F-R2-4 ownership: a message evidence id must be
    // a persisted final assistant message THIS goal produced).
    const goal = makeGoal({ producedMessageIds: ['m-a1'] })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 7 }
    managed.goalRuntime!.turn = binding
    return { state, controller, goal, managed, binding }
  }

  it('TWO legal own finals (a sub-agent sidechain final, then the main final; no supplement anywhere) settle EXACTLY once and complete', async () => {
    const { state, controller, managed, binding } = doubleFinalFixture()
    await stageCandidateWithoutSettling(controller, managed, binding, 'tu-candidate')
    expect(managed.goal?.status).toBe('verifying')

    // Both captures land in the SAME turn, same goal, same run generation —
    // the reachable Claude-backend order (sidechain first, main final second).
    expect(controller.noteProducedAssistantMessage(managed, 'm-sidechain-final', 7)).toBe(true)
    expect(controller.noteProducedAssistantMessage(managed, 'm-main-final', 7)).toBe(true)

    const outcome = await settleNow(controller, managed, binding)
    expect(outcome).toBe('settled')
    expect(state.queryCalls).toBe(1)
    expect(managed.goal).toBeUndefined()
    expect((managed.goalHistory ?? []).map(r => r.status)).toEqual(['completed'])
    // Both messages were captured as the goal's own output — the accounting
    // moves with the capture, it does not un-capture anything.
    expect(managed.goalHistory![0]!.producedMessageIds).toEqual(expect.arrayContaining(['m-sidechain-final', 'm-main-final']))
  })

  it('a REAL supplement admitted between the two own finals still invalidates the candidate', async () => {
    const { state, controller, managed, binding } = doubleFinalFixture()
    await stageCandidateWithoutSettling(controller, managed, binding, 'tu-candidate')
    expect(controller.noteProducedAssistantMessage(managed, 'm-first-final', 7)).toBe(true)
    // The user's requirement change lands mid-turn: its version bump must move
    // the record PAST the (moving) ledger expectation permanently.
    expect(controller.admitSupplementFromQueue(managed, 'm-user-supplement')).toBe(true)
    expect(controller.noteProducedAssistantMessage(managed, 'm-second-final', 7)).toBe(true)

    const outcome = await settleNow(controller, managed, binding)
    expect(outcome).toBe('stale')
    expect(state.queryCalls).toBe(0)
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.supplementMessageIds).toContain('m-user-supplement')
  })

  it('a supplement admitted BEFORE any own final keeps both finals from refreshing the candidate', async () => {
    const { state, controller, managed, binding } = doubleFinalFixture()
    await stageCandidateWithoutSettling(controller, managed, binding, 'tu-candidate')
    expect(controller.admitSupplementFromQueue(managed, 'm-user-supplement')).toBe(true)
    expect(controller.noteProducedAssistantMessage(managed, 'm-first-final', 7)).toBe(true)
    expect(controller.noteProducedAssistantMessage(managed, 'm-second-final', 7)).toBe(true)

    const outcome = await settleNow(controller, managed, binding)
    expect(outcome).toBe('stale')
    expect(state.queryCalls).toBe(0)
    expect(managed.goal?.status).toBe('active')
  })
})

// ====================================================================
// Review r1 F2 (production / low): the verification's cancellation had to be
// armed only AFTER the evidence inspection awaits — a pause/end that landed
// during inspection found NO controller to abort (SessionManager's
// cancelGoalVerification reads runtime.verification.controller), and the
// paid no-tools query still went out, only for its verdict to be discarded by
// the settle-side CAS. The fix arms the AbortController at verifyCandidate
// ENTRY — before the first await — so control transitions during evidence IO
// reach the query, and the query itself re-checks the abort before starting.
// ====================================================================

describe('review r1 F2: a pause during evidence inspection must already have armed the cancellation', () => {
  /** A candidate citing FILE evidence — the shape that drives the inspection
   *  await the finding is about. */
  async function stageFileCandidateWithoutSettling(
    controller: GoalController,
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    binding: { goalId: string; runGeneration: number; generation: number },
  ) {
    const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'candidate',
      candidate: {
        summary: 'Done — the report file is written.',
        evidence: [{ kind: 'file', path: 'docs/report.md' }],
      },
    }))!
    controller.stageReport(managed, wire, binding.generation)
    await controller.observeTurnEvent(
      managed,
      { type: 'tool_start', toolUseId: 'tu-candidate', toolName: 'goal_update' },
      binding,
      binding.generation,
    )
    await controller.observeTurnEvent(
      managed,
      { type: 'tool_result', toolUseId: 'tu-candidate', isError: false, resultText: serializeGoalUpdateReport(wire), parseReport: parseGoalUpdateReportPayload },
      binding,
      binding.generation,
    )
  }

  function fileCandidateFixture() {
    const { host, state } = makeHost()
    state.files.set('docs/report.md', { content: 'The report exists with the summary.' })
    state.queryResults.push({
      ok: true,
      text: JSON.stringify({
        overall: 'passed',
        criteria: [{ criterion: 'The file exists with the summary', passed: true, evidenceIds: [0] }],
        summary: 'verified by the independent no-tools query',
      }),
    })
    const controller = new GoalController(host)
    const goal = makeGoal()
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 7 }
    managed.goalRuntime!.turn = binding
    // The host's cancellation EXACTLY mirrors the production implementation
    // (SessionManager's cancelGoalVerification): abort the controller the
    // runtime slot currently holds, if any. Whether one IS held during the
    // inspection window is exactly what the fix changes.
    host.cancelGoalVerification = () => {
      const armed = managed.goalRuntime?.verification?.controller
      if (armed && !armed.signal.aborted) armed.abort(new Error('verification cancelled'))
    }
    return { host, state, controller, goal, managed, binding }
  }

  it('a pause landing during evidence inspection cancels the verification BEFORE the paid query', async () => {
    const { host, state, controller, managed, binding } = fileCandidateFixture()
    // Gate the inspection INSIDE the inspection window.
    const originalInspect = host.inspectEvidenceFile!.bind(host)
    let releaseInspect: () => void = () => {}
    let inspectEntered = false
    const gate = new Promise<void>(resolve => { releaseInspect = resolve })
    host.inspectEvidenceFile = async (sessionId, rawPath) => {
      inspectEntered = true
      await gate
      return originalInspect(sessionId, rawPath)
    }

    await stageFileCandidateWithoutSettling(controller, managed, binding)
    expect(managed.goal?.status).toBe('verifying')

    const settlePromise = settleNow(controller, managed, binding)
    // The inspection window is real: the gated inspect is in flight while we
    // drive the control transition.
    for (let waited = 0; waited < 5000 && !inspectEntered; waited += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(inspectEntered).toBe(true)

    // The production pause order (F-R2-1): authoritative state first, then the
    // cancellation — exactly what goalPause does.
    managed.goal = pauseGoalRecord(managed.goal!, 'manual', 'user stop', host.now())
    controller.cancelVerification(managed.id)
    releaseInspect()

    const outcome = await settlePromise
    // The paid independent query must NOT have gone out — the cancellation was
    // armed during the inspection window and the query re-checks the abort
    // before starting.
    expect(state.queryCalls).toBe(0)
    // …and the user's pause survived untouched: no verdict, no re-activation,
    // no clock restart.
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('manual')
    expect(outcome).toBe('stale')
  })

  it('the armed cancellation also covers an END landing during evidence inspection', async () => {
    const { host, state, controller, managed, binding } = fileCandidateFixture()
    const originalInspect = host.inspectEvidenceFile!.bind(host)
    let releaseInspect: () => void = () => {}
    let inspectEntered = false
    const gate = new Promise<void>(resolve => { releaseInspect = resolve })
    host.inspectEvidenceFile = async (sessionId, rawPath) => {
      inspectEntered = true
      await gate
      return originalInspect(sessionId, rawPath)
    }

    await stageFileCandidateWithoutSettling(controller, managed, binding)
    const settlePromise = settleNow(controller, managed, binding)
    for (let waited = 0; waited < 5000 && !inspectEntered; waited += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(inspectEntered).toBe(true)

    // The production end order (F-R2-1): authoritative terminal first, then
    // the cancellation.
    managed.goal = endGoalRecord(managed.goal!, 'ended', host.now())
    controller.cancelVerification(managed.id)
    releaseInspect()

    const outcome = await settlePromise
    expect(state.queryCalls).toBe(0)
    // The terminal record survived the discarded verdict untouched — no
    // re-activation, no completion, no clock restart.
    expect(managed.goal?.status).toBe('ended')
    expect(managed.goal?.endedAt).toBe(host.now())
    expect(outcome).toBe('stale')
  })

  it('old A ended during inspection, then a NEW goal B starts: the IO release fires NEITHER a query for A nor any write to B', async () => {
    const { host, state, controller, managed, binding } = fileCandidateFixture()
    const originalInspect = host.inspectEvidenceFile!.bind(host)
    let releaseInspect: () => void = () => {}
    let inspectEntered = false
    const gate = new Promise<void>(resolve => { releaseInspect = resolve })
    host.inspectEvidenceFile = async (sessionId, rawPath) => {
      inspectEntered = true
      await gate
      return originalInspect(sessionId, rawPath)
    }

    await stageFileCandidateWithoutSettling(controller, managed, binding)
    const settlePromise = settleNow(controller, managed, binding)
    for (let waited = 0; waited < 5000 && !inspectEntered; waited += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(inspectEntered).toBe(true)

    // Old A ends authoritatively (F-R2-1 order), THEN the same session starts
    // a NEW goal B — the successor the old verification must never touch.
    managed.goal = endGoalRecord(managed.goal!, 'ended', host.now())
    controller.cancelVerification(managed.id)
    const goalB = makeGoal({ id: 'goal-b-successor', status: 'active', runGeneration: 2 })
    managed.goal = goalB
    const bindingB = { goalId: goalB.id, runGeneration: goalB.runGeneration, generation: 8 }
    managed.goalRuntime!.turn = bindingB

    releaseInspect()
    const outcome = await settlePromise

    // No paid query for old A; the runtime slot is released and belongs to
    // nobody.
    expect(state.queryCalls).toBe(0)
    expect(managed.goalRuntime?.verification).toBeUndefined()
    // Old A stayed terminal (no resurrection, no late verdict write)…
    const history = managed.goalHistory ?? []
    expect(history.some(r => r.id === 'goal-b-successor')).toBe(false)
    // …and NEW goal B was neither completed by A's verdict nor paused by A's
    // teardown: its record is exactly the one the successor turn bound.
    expect(managed.goal?.id).toBe('goal-b-successor')
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.runGeneration).toBe(2)
    // Nothing was transcribed on A's behalf either — no late-pass notice, no
    // completion message: the whole verification never ran.
    expect(state.appended).toEqual([])
    expect(outcome).toBe('stale')
  })
})

// ============================================================
// Plan r2 (facts-budget): one logical fact per real tool call, semantic
// summaries scrubbed before clipping, honest applied semantics, a complete
// facts block within the 6000-char budget, and no unrecoverable-record spin.
// All payloads here are DERIVED from the real attempt-13 event SHAPES
// (controlled replay fixtures), never real provider output.
// ============================================================

/** Test-only accessor: the production commit point, exactly as callers use it. */
function commitForTest(
  controller: GoalController,
  managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
) {
  ;(controller as unknown as { commitFacts: (m: unknown) => void }).commitFacts(managed)
}

/** The persisted tool_call facts of the record (after a commit). */
function committedCalls(managed: { goal?: GoalRecord }) {
  return (managed.goal?.executionFacts?.facts ?? []).filter(f => f.kind === 'tool_call')
}

describe('Plan r2 A.2: one logical fact lifecycle per real tool call', () => {
  function goalTurn(goal: GoalRecord, generation = 5) {
    return { goalId: goal.id, runGeneration: goal.runGeneration, generation }
  }

  it('a start and its result merge into ONE fact with a stable seq', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-1', toolName: 'Write', inputSummary: '{"file_path":"/t/a.md"}' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-1', isError: false, resultText: 'File created successfully', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const calls = committedCalls(managed)
    expect(calls).toHaveLength(1)
    // Direct observeTurnEvent calls (no bindTurn) record no turn_started fact,
    // so the merged call is the FIRST fact of the record: seq 1 and stable —
    // the result merged into the start's seq instead of taking a new one.
    expect(calls[0]!.seq).toBe(1)
    expect(calls[0]!.toolName).toBe('write')
    expect(calls[0]!.toolUseId).toBe('tu-1')
    expect(calls[0]!.paramSummary).toBe('{"file_path":"/t/a.md"}')
    expect(calls[0]!.resultSummary).toBe('File created successfully')
    expect(calls[0]!.isError).toBe(false)
  })

  it('a result arriving AFTER the scratch was committed still merges (cross-commit pairing)', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-1', toolName: 'Bash', inputSummary: '{"command":"ls"}' }, binding, 5)
    commitForTest(controller, managed)
    expect(committedCalls(managed).some(f => f.toolUseId === 'tu-1')).toBe(true)
    // NOW the result arrives — it must merge into the committed fact.
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-1', isError: true, resultText: 'exit 1', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const calls = committedCalls(managed).filter(f => f.toolUseId === 'tu-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.isError).toBe(true)
    expect(calls[0]!.resultSummary).toBe('exit 1')
  })

  it('the SDK double tool_start (stream then full input) never doubles or re-seqs the fact, even across a commit', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-1', toolName: 'Read' }, binding, 5)
    commitForTest(controller, managed)
    // Second emission of the same start, now with the full input.
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-1', toolName: 'Read', inputSummary: '{"file_path":"/t/big.md"}' }, binding, 5)
    commitForTest(controller, managed)
    const calls = committedCalls(managed).filter(f => f.toolUseId === 'tu-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.paramSummary).toBe('{"file_path":"/t/big.md"}')
  })

  it('a toolUseId reused in a LATER turn is a new call — never merged into the previous turn’s fact', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const controller = new GoalController(makeHost().host)
    const b1 = goalTurn(goal, 5)
    managed.goalRuntime!.turn = b1
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-same', toolName: 'Read', inputSummary: '{"file_path":"/t/one.md"}' }, b1, 5)
    commitForTest(controller, managed)
    // New processing generation re-binds the turn (bindTurn resets pairing).
    const b2 = goalTurn(goal, 6)
    managed.goalRuntime!.turn = b2
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-same', toolName: 'Read', inputSummary: '{"file_path":"/t/two.md"}' }, b2, 6)
    commitForTest(controller, managed)
    const calls = committedCalls(managed).filter(f => f.toolUseId === 'tu-same')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.paramSummary).toBe('{"file_path":"/t/one.md"}')
    expect(calls[1]!.paramSummary).toBe('{"file_path":"/t/two.md"}')
  })

  it('a late result under a SUPERSEDED goal/run is recorded honestly, never paired into the new goal’s call', async () => {
    const goalA = makeGoal({ status: 'active' })
    const managed = managedWith(goalA)
    const controller = new GoalController(makeHost().host)
    const bA = goalTurn(goalA, 5)
    managed.goalRuntime!.turn = bA
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-late', toolName: 'Bash', inputSummary: '{"command":"sleep"}' }, bA, 5)
    commitForTest(controller, managed)
    // Old A ended; a NEW goal B owns the session now (new runGeneration).
    const goalB = makeGoal({ id: 'goal-b', status: 'active', runGeneration: 2 })
    managed.goal = goalB
    const bB = goalTurn(goalB, 7)
    managed.goalRuntime!.turn = bB
    // A's late result lands during B's turn.
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-late', isError: false, resultText: 'done', parseReport: parseGoalUpdateReportPayload }, bB, 7)
    commitForTest(controller, managed)
    const facts = managed.goal?.executionFacts?.facts ?? []
    // The pairing index was rebound for B's turn: the late result must NOT be
    // merged into A's fact, and B's record must not present it as B's own
    // successful operation — it stays an honestly-unknown orphan result.
    const bCalls = facts.filter(f => f.runGeneration === 2 && f.kind === 'tool_call')
    expect(bCalls).toHaveLength(1)
    expect(bCalls[0]!.toolUseId).toBe('tu-late')
    expect(bCalls[0]!.toolName).toBeUndefined()
    expect(bCalls[0]!.detail).toContain('unknown pairing')
  })

  it('an orphan result (no observed start this turn) is an explicit unknown — never a fabricated success', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-ghost', isError: false, resultText: 'looked successful', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const calls = committedCalls(managed)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBeUndefined()
    expect(calls[0]!.detail).toContain('unknown pairing')
  })

  it('an errored result keeps isError and is never dressed up as success', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-1', toolName: 'Bash' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-1', isError: true, resultText: 'command failed', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const call = committedCalls(managed)[0]!
    expect(call.isError).toBe(true)
    expect(call.resultSummary).toContain('command failed')
  })

  it('sub-agent calls keep the parent link through the merge', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-child', toolName: 'Read', parentToolUseId: 'tu-parent-1' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-child', isError: false, resultText: 'ok', parentToolUseId: 'tu-parent-1', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const call = committedCalls(managed)[0]!
    expect(call.parentToolUseId).toBe('tu-parent-1')
  })

  it('a result whose start fact was dropped at the record cap is an explicit missing ref', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    // Fill the record to the cap: 40 merged start+result calls = 40 facts.
    for (let i = 0; i < 40; i++) {
      await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: `tu-fill-${i}`, toolName: 'Read', inputSummary: `{"file_path":"/t/f${i}"}` }, binding, 5)
      await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: `tu-fill-${i}`, isError: false, resultText: 'ok', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    }
    commitForTest(controller, managed)
    expect((managed.goal?.executionFacts?.facts ?? []).length).toBe(40)
    // The record is full; the NEXT call cannot be stored, but its start is a
    // real observation — the pairing index still knows it happened.
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-over', toolName: 'Bash', inputSummary: '{"command":"echo hi"}' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-over', isError: false, resultText: 'hi', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const facts = managed.goal?.executionFacts?.facts ?? []
    expect(facts.some(f => f.toolUseId === 'tu-over')).toBe(false) // capped out
    expect(managed.goal?.executionFacts?.truncated).toBe(true)
    // The missing ref is EXPLICIT (never silent): the rendered facts block
    // names the tool-use id whose start/result could not be stored, and says
    // the record cap is why.
    const verify = (controller as unknown as {
      factsBlockFor: (m: unknown) => { text: string }
    }).factsBlockFor(managed)
    expect(verify.text).toContain('tu-over')
    expect(verify.text).toContain('record cap')
  })

  it('pairing merges never bump the goal version (facts are context, not authority)', async () => {
    const goal = makeGoal({ status: 'active', version: 4 })
    const managed = managedWith(goal)
    const binding = goalTurn(goal)
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-1', toolName: 'Read' }, binding, 5)
    commitForTest(controller, managed)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-1', isError: false, resultText: 'ok', parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    expect(managed.goal?.version).toBe(4)
  })
})

describe('Plan r2 A.3: semantic summaries, scrub-before-clip, honest applied semantics', () => {
  const SYNTHETIC = 'sk-test-SYNTHETICSECRET0123456789'

  it('a Write input summary carries the path and size, not the payload body', () => {
    // The input summary is built ONCE, at the SessionManager capture point,
    // from the real tool input; the controller stores what it is given. So the
    // semantic-extraction unit under test here is the exported summarizer.
    const body = 'x'.repeat(2000)
    const summary = summarizeGoalFactInput('Write', { file_path: '/task/docs/notes.md', content: body })
    expect(summary).toContain('/task/docs/notes.md')
    expect(summary).toContain('2000')
    // The payload body itself never enters the record.
    expect(summary.includes('xxxxxx')).toBe(false)
    // …and it is bounded by the parameter cap, announcing the cut.
    expect(summary.length).toBeLessThanOrEqual(GOAL_FACT_PARAM_CHARS)
  })

  it('a known secret shape in the input is redacted in the fact copy', () => {
    const summary = summarizeGoalFactInput('Bash', {
      command: `curl -H "Authorization: Bearer ${SYNTHETIC}" https://api.example.com`,
    })
    expect(summary).not.toContain(SYNTHETIC)
    expect(summary).toContain('Bearer')
    // The same pass covers credential-named fields and sensitive URL queries.
    const fields = summarizeGoalFactInput('Bash', { command: `deploy --api-key=${SYNTHETIC} --region eu` })
    expect(fields).not.toContain(SYNTHETIC)
    const url = summarizeGoalFactInput('Bash', { command: `curl "https://api.example.com/v1?token=${SYNTHETIC}&x=1"` })
    expect(url).not.toContain(SYNTHETIC)
    expect(url).toContain('x=1')
    // Ordinary identifiers and file hashes survive untouched.
    const benign = summarizeGoalFactInput('Bash', { command: `sha256sum build.tar.gz # ${'a'.repeat(64)}` })
    expect(benign).toContain('a'.repeat(64))
  })

  it('a known secret shape in the RESULT is redacted too', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-r', toolName: 'Bash' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-r', isError: false, resultText: `export KEY=${SYNTHETIC}\nok`, parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const call = committedCalls(managed)[0]!
    expect(call.resultSummary).toBeDefined()
    expect(call.resultSummary).not.toContain(SYNTHETIC)
  })

  it('the raw wire is untouched: a secret-bearing goal_update still applies by exact equality', async () => {
    const { host } = makeHost()
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(host)
    const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'progress',
      note: `deploying with token ${SYNTHETIC}`,
      todos: [{ id: 't1', label: 'Ship', status: 'in_progress' }],
    }))!
    controller.stageReport(managed, wire, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-g', toolName: 'goal_update' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-g', isError: false, resultText: serializeGoalUpdateReport(wire), parseReport: parseGoalUpdateReportPayload }, binding, 5)
    // The report applied (equality on the RAW wire held)…
    expect(managed.goal?.todos?.some(t => t.id === 't1')).toBe(true)
    // …while the fact copy never echoes the raw wire (and so never the secret).
    commitForTest(controller, managed)
    const call = committedCalls(managed).find(f => f.toolUseId === 'tu-g')!
    expect(call.resultSummary).toBeDefined()
    expect(call.resultSummary).not.toContain(SYNTHETIC)
    expect(call.resultSummary).toContain('applied')
  })

  it('a goal_update result fact says APPLIED only after the real apply, with kind and completion counts', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({
      kind: 'progress',
      note: 'halfway',
      todos: [
        { id: 't1', label: 'A', status: 'completed' },
        { id: 't2', label: 'B', status: 'completed' },
        { id: 't3', label: 'C', status: 'pending' },
      ],
    }))!
    controller.stageReport(managed, wire, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-a', toolName: 'goal_update' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-a', isError: false, resultText: serializeGoalUpdateReport(wire), parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const call = committedCalls(managed).find(f => f.toolUseId === 'tu-a')!
    expect(call.resultSummary).toContain('applied')
    expect(call.resultSummary).toContain('progress')
    expect(call.resultSummary).toContain('2') // completed todo count
  })

  it('a goal_update wire that matches no staged report is NEVER recorded as applied', async () => {
    const goal = makeGoal({ status: 'active' })
    const managed = managedWith(goal)
    const binding = { goalId: goal.id, runGeneration: goal.runGeneration, generation: 5 }
    managed.goalRuntime!.turn = binding
    const controller = new GoalController(makeHost().host)
    const wire = parseGoalUpdateReportPayload(serializeGoalUpdateReport({ kind: 'progress', note: 'ghost' }))!
    await controller.observeTurnEvent(managed, { type: 'tool_start', toolUseId: 'tu-ghost', toolName: 'goal_update' }, binding, 5)
    await controller.observeTurnEvent(managed, { type: 'tool_result', toolUseId: 'tu-ghost', isError: false, resultText: serializeGoalUpdateReport(wire), parseReport: parseGoalUpdateReportPayload }, binding, 5)
    commitForTest(controller, managed)
    const call = committedCalls(managed).find(f => f.toolUseId === 'tu-ghost')!
    expect(call.resultSummary!.includes('applied')).toBe(false)
  })
})

describe('review F1: a multi-line shell command keeps its semantics in the fact copy', () => {
  it('a newline between two commands is never folded into an argument separator', () => {
    const destructive = summarizeGoalFactInput('Bash', { command: 'ls\nrm file' })
    const spaceForm = summarizeGoalFactInput('Bash', { command: 'ls rm file' })
    // The review's exact counterexample: `ls\nrm file` must not summarize as
    // the read-only-looking `ls rm file` — those are two different operations.
    expect(destructive).not.toBe(spaceForm)
    expect(destructive.includes('ls rm file')).toBe(false)
    // The newline stays visible as a traceable escape a reader can decode.
    expect(destructive).toContain('ls\\nrm file')
  })

  it('CRLF and tab survive as their own escapes (not folded into a space)', () => {
    const crlf = summarizeGoalFactInput('Bash', { command: 'make\r\nclean' })
    expect(crlf).toContain('make\\r\\nclean')
    const tabbed = summarizeGoalFactInput('Bash', { command: 'echo\tscore' })
    expect(tabbed).toContain('echo\\tscore')
    expect(tabbed.includes('echo score')).toBe(false)
  })

  it('inner whitespace inside quotes is preserved verbatim', () => {
    const quoted = summarizeGoalFactInput('Bash', { command: `printf '%s' 'a  b'` })
    expect(quoted).toContain(`'a  b'`)
    expect(quoted.includes(`'a b'`)).toBe(false)
  })

  it('a secret assignment followed by a newline keeps the next command readable', () => {
    const summary = summarizeGoalFactInput('Bash', {
      command: 'export KEY=sk-test-SYNTHETICSECRET0123456789\nrm -rf /tmp/stale',
    })
    // Scrub still happens BEFORE the clip, and the line boundary between the
    // (redacted) assignment and the destructive command survives the scrub.
    expect(summary).not.toContain('sk-test-SYNTHETICSECRET0123456789')
    expect(summary).toContain('rm -rf /tmp/stale')
    expect(summary).toContain('\\nrm -rf')
  })

  it('a multi-line RESULT keeps the same distinction', () => {
    const multi = summarizeGoalFactResult('Bash', 'ls\nrm file\nok')
    const flat = summarizeGoalFactResult('Bash', 'ls rm file ok')
    expect(multi).not.toBe(flat)
    expect(multi.includes('ls rm file ok')).toBe(false)
    expect(multi).toContain('ls\\nrm file\\nok')
  })

  it('a long multi-line command is still bounded, announcing the cut', () => {
    const long = summarizeGoalFactInput('Bash', { command: `ls\n${'x'.repeat(600)}` })
    // The KEPT command text is bounded by the cap; the true encoded total is
    // announced after it — a cut command is never passed off as complete.
    const cutAt = long.indexOf('… [truncated:')
    expect(cutAt).toBeGreaterThan(0)
    expect(cutAt).toBeLessThanOrEqual(GOAL_FACT_PARAM_CHARS)
    expect(long).toContain('chars total]')
    expect(long).toContain('ls\\n')
  })

  it('the rendered facts block keeps a stored multi-line command on one traceable line', () => {
    const facts: NonNullable<GoalRecord['executionFacts']>['facts'] = [
      {
        seq: 1,
        at: 1,
        runGeneration: 2,
        kind: 'tool_call',
        toolName: 'bash',
        toolUseId: 'tu-nl',
        // A record stored BEFORE the storage-side encoding may hold a raw
        // newline: the render side must not fold it into a space either.
        paramSummary: 'run command: ls\nrm file',
        resultSummary: 'ok',
      },
    ]
    const controller = new GoalController(makeHost().host)
    const block = (controller as unknown as { factsBlockFor: (m: unknown) => { text: string } }).factsBlockFor({
      goal: { id: 'g', executionFacts: { facts, truncated: false } } as unknown as GoalRecord,
      goalRuntime: createGoalRuntimeState(),
    })
    const line = block.text.split('\n').find(l => l.includes('#1 tool'))!
    expect(line).toContain('ls\\nrm file')
    expect(line.includes('ls rm file')).toBe(false)
  })
})

describe('Plan r2 A.4: the facts block is complete and compact within the 6000-char budget', () => {
  /**
   * A DERIVED replay of the real attempt-13 record SHAPE (three staged
   * rounds; long Write payloads; goal_update calls between them), with
   * synthetic payloads of the same magnitude — never real provider output.
   * The old renderer consumed its 6000-char budget from the HEAD of the
   * record and dropped everything after entry 18, which hid exactly the
   * third round the verifier needed to see.
   */
  function real13ShapedFacts(padTo = 40): GoalRecord['executionFacts'] {
    const facts: NonNullable<GoalRecord['executionFacts']>['facts'] = []
    let seq = 0
    const push = (f: Omit<NonNullable<GoalRecord['executionFacts']>['facts'][number], 'seq' | 'at' | 'runGeneration'>) => {
      seq += 1
      facts.push({ seq, at: 1_000 + seq, runGeneration: 2, ...f })
    }
    push({ kind: 'turn_started', detail: 'internal continuation (server-scheduled)' })
    // Round 1: research (readonly) + progress.
    push({ kind: 'tool_call', toolName: 'read', toolUseId: 'tu-r1', paramSummary: `{"file_path":"/task/README.md","limit":200} ${( 'ctx '.repeat(120)).trim()}`, resultSummary: `('# Workspace '.repeat(60)).trim()` })
    push({ kind: 'tool_call', toolName: 'glob', toolUseId: 'tu-r2', paramSummary: '{"pattern":"**/*.md"}', resultSummary: '3 files' })
    push({ kind: 'tool_call', toolName: 'goal_update', toolUseId: 'tu-r3', paramSummary: `{"kind":"progress","note":"${'survey '.repeat(80).trim()}"}`, resultSummary: 'applied: progress; todos completed=0' })
    // Round 2: write notes.md (long payload — the kind of entry the old
    // renderer spent its whole budget on) + progress.
    push({ kind: 'tool_call', toolName: 'write', toolUseId: 'tu-w1', paramSummary: `{"file_path":"/task/docs/notes.md","content":"${'x'.repeat(2400)}"}`, resultSummary: 'File created successfully' })
    push({ kind: 'tool_call', toolName: 'goal_update', toolUseId: 'tu-r4', paramSummary: `{"kind":"progress","note":"notes written"}`, resultSummary: 'applied: progress; todos completed=1' })
    // Round 3: write checklist.md + candidate — the entries the real run lost.
    push({ kind: 'tool_call', toolName: 'write', toolUseId: 'tu-w2', paramSummary: `{"file_path":"/task/docs/checklist.md","content":"${'y'.repeat(2400)}"}`, resultSummary: 'File created successfully' })
    push({ kind: 'tool_call', toolName: 'goal_update', toolUseId: 'tu-r5', paramSummary: `{"kind":"candidate","summary":"${'done '.repeat(60).trim()}"}`, resultSummary: 'applied: candidate' })
    push({ kind: 'turn_ended', detail: 'complete' })
    // Pad to the full 40-entry record with earlier-round reads.
    while (seq < padTo) {
      const i = seq
      push({ kind: 'tool_call', toolName: 'read', toolUseId: `tu-pad-${i}`, paramSummary: `{"file_path":"/task/f${i}.md"} ${('pad '.repeat(60)).trim()}`, resultSummary: `content ${('z'.repeat(400))}` })
    }
    return { facts, truncated: false }
  }

  async function promptFor(facts: NonNullable<GoalRecord['executionFacts']>, overrides: Partial<GoalRecord> = {}) {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { goal, managed, binding } = candidateTurn()
    managed.goal = { ...goal, executionFacts: facts, ...overrides }
    state.files.set('/tmp/report.md', { content: '# Report\nsummary present' })
    state.queryResults.push({ ok: true, text: JSON.stringify({ overall: 'not_satisfied', criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'n' }], summary: 's' }) })
    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    return { prompt: state.lastPrompt ?? '', managed }
  }

  it('every retained fact appears in the prompt — no single-sided drop of the last round', async () => {
    const { prompt } = await promptFor(real13ShapedFacts()!)
    // The first AND last recorded seq both have visible lines.
    expect(prompt).toContain('#1 ')
    expect(prompt).toContain('#40 ')
    // The third-round entries the real run lost are all present.
    expect(prompt).toContain('checklist.md')
    expect(prompt).toContain('#38 ')
    expect(prompt).toContain('#39 ')
  })

  it('the whole facts block (header + notes) stays within GOAL_FACTS_PROMPT_CHARS', async () => {
    const { prompt } = await promptFor(real13ShapedFacts()!)
    const start = prompt.indexOf('Server-recorded execution facts')
    // The evidence section precedes the facts block, so the block ends where
    // the verifier instructions resume.
    const end = prompt.indexOf('Answer with ONLY a JSON object', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const block = prompt.slice(start, end)
    expect(block.length).toBeLessThanOrEqual(6_000)
  })

  it('prompt-budget dropping of whole entries is GONE; record-cap truncation stays explicit', async () => {
    // Two slots left below the 40-fact cap: the verification turn's own facts
    // fit, so the record never hit the cap and must NOT claim truncation.
    const { prompt } = await promptFor(real13ShapedFacts(38)!)
    // The old wording meant "entries after this were dropped for budget".
    expect(prompt).not.toContain('truncated for the prompt after')
    // A full record that never hit the cap must NOT claim truncation.
    expect(prompt).not.toContain('RECORD INCOMPLETE')
  })

  describe('review F2: the whole block stays within budget even for worst-case LEGAL fields', () => {
    /**
     * The reviewer's probe3 counterexample, rebuilt from the REAL producers:
     * every field is a legal storage shape (param/result summaries are exactly
     * what summarizeGoalFactInput/Result store for a long command and a long
     * result; the detail is the controller's own unknown-pairing text with a
     * long tool-use id). No field exceeds its cap — which is precisely why the
     * ladder's missing final guard let this render to 13141 chars unchecked.
     */
    function worstCaseRecord() {
      const facts = Array.from({ length: 40 }, (_, i) => ({
        seq: i + 1,
        at: 1_000 + i,
        runGeneration: 2,
        kind: 'tool_call' as const,
        toolName: 'bash',
        toolUseId: `tu-worst-${i + 1}`,
        paramSummary: summarizeGoalFactInput('Bash', { command: 'echo verylongargument; '.repeat(30) }),
        resultSummary: summarizeGoalFactResult('Bash', 'ok '.repeat(200)),
        detail: `unknown pairing: no matching start observed for ${'tu-verylongidentifier'.repeat(4)} in this turn/goal`,
      }))
      return { facts, truncated: false }
    }

    function blockFor(executionFacts: NonNullable<GoalRecord['executionFacts']>, runtime?: GoalRuntimeState) {
      const controller = new GoalController(makeHost().host)
      return (controller as unknown as { factsBlockFor: (m: unknown) => { text: string; note?: string } }).factsBlockFor({
        goal: { id: 'g', executionFacts } as unknown as GoalRecord,
        goalRuntime: runtime ?? createGoalRuntimeState(),
      })
    }

    it('40 fully compliant facts still render within GOAL_FACTS_PROMPT_CHARS', () => {
      const block = blockFor(worstCaseRecord())
      expect(block.text.length).toBeLessThanOrEqual(6_000)
    })

    it('every entry keeps its identity line — no head/tail drop of whole events', () => {
      const block = blockFor(worstCaseRecord())
      for (let seq = 1; seq <= 40; seq++) {
        expect(block.text).toContain(`#${seq} tool bash`)
      }
      // The first and last entries' operations are still told apart from each
      // other (identity preserved is not identity flattened).
      expect(block.text).toContain('#1 ')
      expect(block.text).toContain('#40 ')
    })

    it('shortened fields still announce that their remainder is unknown', () => {
      const block = blockFor(worstCaseRecord())
      expect(block.text).toContain('unknown remainder')
    })

    it('the notes/metadata lines count against the same budget', () => {
      const record = { ...worstCaseRecord(), truncated: true, droppedCount: 5 }
      const runtime: GoalRuntimeState = {
        ...createGoalRuntimeState(),
        pairingLosses: ['tu-lost-1 (no fact: record cap)'],
      }
      const block = blockFor(record, runtime)
      // True record truncation keeps its own fail-closed line, separate from
      // any per-field excerpt note.
      expect(block.text).toContain('RECORD INCOMPLETE')
      expect(block.text).toContain('TRUNCATED')
      expect(block.text).toContain('tu-lost-1')
      expect(block.text.length).toBeLessThanOrEqual(6_000)
    })
  })

  describe('review F2b: non-tool_call head details are bounded in EVERY render mode', () => {
    /**
     * The r2 reviewer's residual edge, rebuilt from the REAL producer: the
     * resume-flush failure path stores an as-given error message
     * (goal-controller pause detail, 'resume not persisted: <error.message>').
     * Ordinary errors are short (why r1 allowed the real run first), but a
     * multi-KB message is a legal stored shape — and renderFactHead embedded a
     * non-tool_call detail RAW while composeBoundedSkeleton unconditionally
     * pushed the first line, so the block went to 6535 > 6000.
     */
    const giantResumeError = `resume not persisted: ${'E'.repeat(6000)}`

    function pausedFacts(count: number, detail: string) {
      return Array.from({ length: count }, (_, i) => ({
        seq: i + 1,
        at: 1_000 + i,
        runGeneration: 2,
        kind: 'paused' as const,
        detail: i === 0 ? detail : `resume not persisted: ${'E'.repeat(40)} #${i + 1}`,
      }))
    }

    function blockFor(executionFacts: NonNullable<GoalRecord['executionFacts']>) {
      const controller = new GoalController(makeHost().host)
      return (controller as unknown as { factsBlockFor: (m: unknown) => { text: string } }).factsBlockFor({
        goal: { id: 'g', executionFacts } as unknown as GoalRecord,
        goalRuntime: createGoalRuntimeState(),
      })
    }

    it('a FIRST-position paused fact with a multi-KB detail stays within budget', () => {
      const block = blockFor({ facts: pausedFacts(1, giantResumeError), truncated: false })
      expect(block.text.length).toBeLessThanOrEqual(6_000)
    })

    it('40 paused facts with giant details stay within budget AND every identity line survives', () => {
      const facts = pausedFacts(40, giantResumeError)
      const block = blockFor({ facts, truncated: false })
      expect(block.text.length).toBeLessThanOrEqual(6_000)
      // Identity is preserved, never flattened: every event is either shown
      // with its own #seq line or explicitly NAMED as unshown — never dropped
      // by a silent head/tail slice.
      const shown = new Array(40).fill(false).map((_, i) => block.text.includes(`#${i + 1} paused`)).filter(Boolean).length
      if (shown < 40) expect(block.text).toContain('RECORD INCOMPLETE')
      expect(block.text).toContain('#1 paused')
      // The clipped detail keeps its salient prefix (which error it was).
      expect(block.text).toContain('resume not persisted')
    })

    it('mixed tool_call/paused/turn_started/turn_ended facts with a legacy JSON param stay within budget', () => {
      const facts: Array<Record<string, unknown>> = [
        {
          seq: 1, at: 1_000, runGeneration: 2, kind: 'turn_started', detail: `run bootstrap ${'B'.repeat(6000)}`,
        },
        {
          seq: 2, at: 1_001, runGeneration: 2, kind: 'tool_call' as const, toolName: 'Read',
          toolUseId: 'tu-mix-1',
          // legacy raw-JSON param summary (older records predate the summarizers)
          paramSummary: JSON.stringify({ file_path: `/w/${'legacy'.repeat(500)}.md` }),
          resultSummary: 'ok',
        },
        {
          seq: 3, at: 1_002, runGeneration: 2, kind: 'paused', detail: giantResumeError,
        },
        { seq: 4, at: 1_003, runGeneration: 2, kind: 'turn_ended', detail: `complete ${'C'.repeat(6000)}` },
      ]
      const block = blockFor({ facts: facts as never, truncated: false })
      expect(block.text.length).toBeLessThanOrEqual(6_000)
      for (const seq of [1, 2, 3, 4]) expect(block.text).toContain(`#${seq} `)
      // The legacy param's salient argument survives the bounded render.
      expect(block.text).toContain('file_path')
    })

    it('turn_started/turn_ended details are bounded in the plain (non-skeleton) render too', async () => {
      const facts = {
        facts: [{
          seq: 1, at: 1_000, runGeneration: 2, kind: 'turn_started' as const, detail: `run bootstrap ${'B'.repeat(6000)}`,
        }],
        truncated: false,
      }
      const { prompt } = await promptFor(facts as never)
      expect(prompt.length).toBeLessThan(6_000)
      expect(prompt).toContain('#1 turn started')
    })
  })

  it('a record that hit the 40-fact cap still says RECORD INCOMPLETE and fails closed', async () => {
    const facts = real13ShapedFacts()!
    facts.truncated = true
    ;(facts as { droppedCount?: number }).droppedCount = 3
    const { prompt } = await promptFor(facts)
    expect(prompt).toContain('RECORD INCOMPLETE')
    expect(prompt).toContain('TRUNCATED')
    expect(prompt).toContain('3')
  })

  it('a long command is not passed off as complete: clipping is announced with an unknown suffix', async () => {
    const facts: NonNullable<GoalRecord['executionFacts']>['facts'] = [
      { seq: 1, at: 1, runGeneration: 2, kind: 'tool_call', toolName: 'bash', toolUseId: 'tu-b', paramSummary: `{"command":"${'echo a && '.repeat(60)}echo END"}`, resultSummary: 'ok' },
    ]
    const { prompt } = await promptFor({ facts, truncated: false })
    const line = prompt.split('\n').find(l => l.includes('echo a &&'))!
    expect(line).toContain('truncated')
    expect(line).toContain('unknown')
  })

  it('a very long (MCP) tool name is bounded on its own line field, with an unknown remainder', async () => {
    const longName = `mcp__session__${'verylongtoolname'.repeat(6)}`
    const facts: NonNullable<GoalRecord['executionFacts']>['facts'] = [
      { seq: 1, at: 1, runGeneration: 2, kind: 'tool_call', toolName: longName, toolUseId: 'tu-l', paramSummary: '{"path":"/t/a.md"}', resultSummary: 'ok' },
    ]
    const { prompt } = await promptFor({ facts, truncated: false })
    const line = prompt.split('\n').find(l => l.includes('#1 tool'))!
    // The name is bounded and announced as cut — it is not an operation proof.
    expect(line.length).toBeLessThan(200)
    expect(line).toContain('unknown remainder')
    expect(line.includes(longName)).toBe(false)
  })
})

describe('Plan r2 A.6: an irreversibly truncated record pauses instead of spinning', () => {
  function truncatedGoal() {
    const { host, state } = makeHost()
    const controller = new GoalController(host)
    const { goal, managed, binding } = candidateTurn()
    // The record hit the 40-fact cap earlier in this run: those facts are
    // gone for good — no continuation can ever re-observe them.
    managed.goal = { ...goal, executionFacts: { facts: [], truncated: true, droppedCount: 6 } }
    state.files.set('/tmp/report.md', { content: '# Report\nsummary present' })
    return { host, state, controller, managed, binding, goal }
  }

  it('a not_satisfied verdict on a truncated record pauses with an honest explanation', async () => {
    const { state, controller, managed, binding, goal } = truncatedGoal()
    state.queryResults.push({ ok: true, text: JSON.stringify({ overall: 'not_satisfied', criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'process step unproven' }], summary: 'record incomplete' }) })
    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.status).toBe('paused')
    expect(managed.goal?.pauseReason).toBe('error')
    // The transcript explains WHY — no silent stall, no info-free retry loop.
    expect(state.appended.join('\n')).toContain('truncated')
    expect(state.appended.join('\n')).toContain('resume')
  })

  it('a not_satisfied verdict on a COMPLETE record still returns to active (no over-pause)', async () => {
    const { host, state, controller, managed, binding, goal } = truncatedGoal()
    managed.goal = { ...goal, executionFacts: { facts: [], truncated: false } } // not truncated
    state.queryResults.push({ ok: true, text: JSON.stringify({ overall: 'not_satisfied', criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'n' }], summary: 's' }) })
    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.verification?.status).toBe('not_satisfied')
  })

  it('the explicit resume after such a pause works through the original path', async () => {
    const { state, controller, managed, binding, goal } = truncatedGoal()
    state.queryResults.push({ ok: true, text: JSON.stringify({ overall: 'not_satisfied', criteria: [{ criterion: goal.criteria[0], passed: false, evidenceIds: [0], note: 'n' }], summary: 's' }) })
    await stageThenObserve(controller, managed, binding, 5, candidateReport([{ kind: 'file', path: '/tmp/report.md' }]))
    expect(managed.goal?.status).toBe('paused')
    state.busy = false
    const resumed = await controller.resume(managed)
    expect(resumed.ok).toBe(true)
    expect(managed.goal?.status).toBe('active')
    expect(managed.goal?.runGeneration).toBe(goal.runGeneration + 1)
  })
})
