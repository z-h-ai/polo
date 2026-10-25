/**
 * POO-134: the server-side Goal controller.
 *
 * ONE authoritative owner of Goal state: the state machine, the run clock, the
 * persistence boundary, generation/identity checks and the independent
 * completion verification all live here. SessionManager adapts the existing
 * production turn entry points (sendMessage / cancelProcessing /
 * onProcessingStopped / cold-start load) onto this controller — it never grows
 * a second agent scheduler.
 *
 * Authority rules implemented here (Spec r3.5 / Plan r3):
 * - The GoalRecord persisted on the session metadata is the ONLY authority.
 *   Agent reports (goal_update), client flags and renderer state are inputs,
 *   never writes.
 * - A goal_update report is applied only when it arrives from the callback of
 *   the SAME turn generation, matches the turn's captured GoalID/runGeneration,
 *   and the successful goal_update tool_result of the SAME turn was matched to
 *   its tool_start. Late callbacks, other sessions, sub-agents and post-pause
 *   stragglers are rejected.
 * - The clock runs only while a turn is actually executing (runningSince).
 *   Pauses/cold starts fold the live segment into elapsedMs and drop
 *   runningSince, so offline wall time is never counted.
 * - Completion is fail-closed: a candidate only completes the Goal after the
 *   evidence is verified on disk/in-history AND an independent no-tools LLM
 *   query confirms every criterion. Timeouts, parse errors, missing files and
 *   "not satisfied" results never complete a Goal.
 */

import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  GoalCriterionResult,
  GoalEvidence,
  GoalExecutionFact,
  GoalExecutionFacts,
  GoalPauseReason,
  GoalProjection,
  GoalRecord,
  GoalStatus,
  GoalTodoItem,
  GoalVerificationReceipt,
} from '@polo-ai/shared/protocol'
import { computeGoalElapsedMs, isGoalRunning, isGoalTerminal } from '@polo-ai/shared/protocol'
import type { LLMQueryOptions, LLMQueryRequest, LLMQueryResult } from '@polo-ai/shared/agent/llm-tool'
import type { GoalUpdateReport } from '@polo-ai/session-tools-core'

// ============================================================
// Constants
// ============================================================

/** Consecutive progress-less continuation rounds before an auto-pause. */
export const GOAL_MAX_NO_PROGRESS_ROUNDS = 3

/**
 * Fail-safe deadline for the pause-time durable flush. A slow/hung store must
 * never keep a manual stop waiting forever: after the deadline the stop
 * proceeds anyway and the failure is recorded in the transcript.
 */
export const GOAL_FLUSH_DEADLINE_MS = 5_000

/**
 * Deadline for one independent verification query.
 *
 * Tuned against the REAL zhipu/glm endpoint (POO-134 attempts): one isolated
 * no-tools structured verdict took ~43s (attempt-7, passed) but over 120s
 * (attempt-8, deadline abort → fail-closed paused 'error'; attempt-6's
 * verdict spanned 2 SDK-counted turns inside a ~158s goal run). 300s keeps a
 * hard bound while covering the observed tail. The query stays cancellable at
 * any moment by a user pause, and a deadline abort still fails closed.
 */
export const GOAL_VERIFICATION_TIMEOUT_MS = 300_000

/** Per-file and total material budget handed to the verification query. */
export const GOAL_VERIFICATION_MAX_FILE_CHARS = 24_000
export const GOAL_VERIFICATION_MAX_TOTAL_CHARS = 96_000

/** Bounded todo bookkeeping (mirrors session-tools-core report limits). */
const GOAL_MAX_TODOS = 50
const GOAL_MAX_CRITERIA = 12
/** The objective is the anchor message text, bounded for prompt/receipt use. */
const GOAL_OBJECTIVE_MAX_CHARS = 4_000
/** Per-message excerpt of a produced assistant message shown in a continuation. */
const GOAL_CONTINUATION_PRODUCED_EXCERPT_CHARS = 800
/** Bounded per-goal capture of produced assistant messages / accepted supplements. */
const GOAL_MAX_TRACKED_MESSAGES = 200

/**
 * ICR-2 execution-fact record bounds. The record is CONTEXT for the verifier,
 * not a transcript: it is capped hard, and hitting the cap flips the record to
 * explicitly-truncated instead of silently rewriting history. Parameter and
 * result summaries have INDEPENDENT caps (C4) so one huge Write payload cannot
 * crowd out every other fact.
 */
export const GOAL_EXECUTION_FACTS_LIMIT = 40
export const GOAL_FACT_PARAM_CHARS = 400
export const GOAL_FACT_RESULT_CHARS = 600
/** Total budget for the facts block handed to the verification prompt. */
export const GOAL_FACTS_PROMPT_CHARS = 6_000

// ============================================================
// Pure record helpers (unit-tested directly)
// ============================================================

export function createGoalRecord(input: {
  sessionId: string
  anchorMessageId: string
  objective: string
  supplementMessageIds?: string[]
  criteria: string[]
  now: number
}): GoalRecord {
  return {
    id: `goal-${randomUUID()}`,
    sessionId: input.sessionId,
    anchorMessageId: input.anchorMessageId,
    objective: input.objective,
    supplementMessageIds: [...(input.supplementMessageIds ?? [])],
    status: 'active',
    version: 1,
    runGeneration: 1,
    elapsedMs: 0,
    runningSince: input.now,
    criteria: [...input.criteria],
    todos: [],
    createdAt: input.now,
    updatedAt: input.now,
  }
}

/** Fold the live clock segment into elapsedMs and stop the clock. */
export function stopGoalClock(record: GoalRecord, now: number): GoalRecord {
  if (record.runningSince === undefined) return record
  return {
    ...record,
    elapsedMs: computeGoalElapsedMs(record, now),
    runningSince: undefined,
    updatedAt: now,
  }
}

/** (Re)start the clock for a new run segment. */
export function startGoalClock(record: GoalRecord, now: number): GoalRecord {
  if (record.runningSince !== undefined) return record
  return { ...record, runningSince: now, updatedAt: now }
}

function bump(record: GoalRecord, now: number): GoalRecord {
  return { ...record, version: record.version + 1, updatedAt: now }
}

/**
 * Transition a non-terminal record into a pause. Idempotent for already-paused
 * and terminal records (returns the record unchanged).
 */
export function pauseGoalRecord(
  record: GoalRecord,
  reason: GoalPauseReason,
  detail: string | undefined,
  now: number,
): GoalRecord {
  if (isGoalTerminal(record.status)) return record
  if (record.status === 'paused' && record.pauseReason === reason) return record
  const stopped = stopGoalClock(record, now)
  return {
    ...bump(stopped, now),
    status: 'paused',
    pauseReason: reason,
    pauseDetail: detail,
  }
}

/**
 * Explicit resume: a paused record becomes active with a NEW runGeneration.
 * Only real (re)starts bump runGeneration — never report application.
 */
export function resumeGoalRecord(record: GoalRecord, now: number): GoalRecord | { error: string } {
  if (isGoalTerminal(record.status)) return { error: 'goal is terminal' }
  if (isGoalRunning(record.status)) return record
  return {
    ...bump(stopGoalClock(record, now), now),
    status: 'active',
    pauseReason: undefined,
    pauseDetail: undefined,
    runGeneration: record.runGeneration + 1,
    runningSince: now,
  }
}

/** Terminal transition. `clearsProjection` records leave the record in history. */
export function endGoalRecord(
  record: GoalRecord,
  status: Extract<GoalStatus, 'completed' | 'ended'>,
  now: number,
  extra?: { resultMessageId?: string },
): GoalRecord {
  const stopped = stopGoalClock(record, now)
  const ended: GoalRecord = {
    ...bump(stopped, now),
    status,
    endedAt: now,
    pauseReason: undefined,
    pauseDetail: undefined,
    ...(status === 'completed' ? { completedAt: now } : {}),
    ...(extra?.resultMessageId ? { resultMessageId: extra.resultMessageId } : {}),
  }
  return ended
}

/**
 * Merge a reported todo snapshot into the authoritative list.
 *
 * - IDs are STABLE: a reported id updates its existing item in place.
 * - A snapshot that omits a known item never deletes it.
 * - A completed item is never regressed by a later snapshot (the report keeps
 *   its place; the authoritative status stays completed).
 * - New ids are appended with the next server-assigned seq.
 * - Returns null when the snapshot would exceed the bounded list.
 */
export function mergeGoalTodos(
  existing: readonly GoalTodoItem[] | undefined,
  reported: ReadonlyArray<{ id: string; label: string; status: GoalTodoItem['status'] }>,
  now: number,
): GoalTodoItem[] | null {
  const prev = existing ?? []
  const byId = new Map(prev.map(item => [item.id, item]))
  const nextSeq = prev.reduce((max, item) => Math.max(max, item.seq), 0)

  const merged: GoalTodoItem[] = prev.map(item => ({ ...item }))
  const mergedById = new Map(merged.map(item => [item.id, item]))
  let appended = 0

  for (const todo of reported) {
    const current = mergedById.get(todo.id)
    if (current) {
      // Never regress a completed item; never delete it either.
      const status = current.status === 'completed' ? 'completed' : todo.status
      if (current.label !== todo.label || current.status !== status) {
        current.label = todo.label
        current.status = status
        current.updatedAt = now
      }
      continue
    }
    if (merged.length >= GOAL_MAX_TODOS) return null
    appended += 1
    const item: GoalTodoItem = { id: todo.id, label: todo.label, status: todo.status, seq: nextSeq + appended, updatedAt: now }
    merged.push(item)
    mergedById.set(item.id, item)
  }

  // Reconciliation for previously-known items the snapshot dropped: they keep
  // their last known state (a completed item is never silently removed).
  void byId
  return merged
}

/**
 * Additively refine the criteria list. Reported criteria are appended when new;
 * the canonical list never shrinks (a criterion can only be added, so a
 * later report cannot weaken the bar).
 */
export function mergeGoalCriteria(existing: readonly string[], reported: readonly string[] | undefined): string[] | null {
  if (!reported) return [...existing]
  const merged = [...existing]
  for (const criterion of reported) {
    const normalized = criterion.trim()
    if (!normalized) continue
    if (merged.some(c => c.toLowerCase() === normalized.toLowerCase())) continue
    if (merged.length >= GOAL_MAX_CRITERIA) return null
    merged.push(normalized)
  }
  return merged
}

/**
 * Evidence for `message` kind must be a persisted, final assistant message of
 * THIS session that THIS Goal produced — never another session's, never an
 * intermediate stream chunk, and never a message from an earlier Goal or an
 * ordinary-chat turn (F-R2-3: same session ≠ same Goal; without the ownership
 * check a near-named Goal B could complete on Goal A's old output).
 *
 * `ownedMessageIds` is the goal record's `producedMessageIds` — captured
 * server-side at real output persistence, so a client/agent cannot inflate it.
 * A missing/absent set fails closed: no captured ownership, no message evidence.
 */
export function isValidMessageEvidence(
  messages: ReadonlyArray<{ id: string; role: string; isIntermediate?: boolean }>,
  messageId: string | undefined,
  ownedMessageIds: ReadonlyArray<string> | undefined,
): boolean {
  if (!messageId) return false
  if (!ownedMessageIds || ownedMessageIds.length === 0) return false
  if (!ownedMessageIds.includes(messageId)) return false
  const message = messages.find(m => m.id === messageId)
  return !!message && message.role === 'assistant' && message.isIntermediate !== true
}

/**
 * Structural criteria coverage: every authoritative criterion must be matched
 * (case-insensitive exact text) by a report criterion that passed and cites at
 * least one evidence index inside the candidate's evidence array. Structural
 * only — the independent verification query decides substance.
 */
export function checkCriteriaCoverage(
  criteria: readonly string[],
  results: ReadonlyArray<{ criterion: string; passed: boolean; evidenceIds: number[] }>,
  evidenceCount: number,
): { ok: boolean; missing: string[]; unbacked: string[] } {
  const missing: string[] = []
  const unbacked: string[] = []
  for (const criterion of criteria) {
    const match = results.find(r => r.criterion.trim().toLowerCase() === criterion.trim().toLowerCase())
    if (!match) {
      missing.push(criterion)
      continue
    }
    const backed = match.passed
      && match.evidenceIds.length > 0
      && match.evidenceIds.every(id => Number.isInteger(id) && id >= 0 && id < evidenceCount)
    if (!backed) unbacked.push(criterion)
  }
  return { ok: missing.length === 0 && unbacked.length === 0, missing, unbacked }
}

/** The projection handed to clients for a session's Goal state. */
export function buildGoalProjection(
  goal: GoalRecord | undefined,
  revision: number,
  sessionId: string,
): GoalProjection {
  return {
    revision,
    sessionId,
    ...(goal && !isGoalTerminal(goal.status) ? { currentGoalId: goal.id } : {}),
    ...(goal ? { goal } : {}),
  }
}

/**
 * The continuation prompt injected for an internal Goal continuation turn.
 * Clearly framed as an internal continuation (never a fabricated user reply),
 * carrying the original objective, supplements, criteria and the live todo list.
 *
 * `producedMessages` (F-R2-4) are the final assistant messages THIS Goal's own
 * turns already persisted, resolved server-side from the goal record — the only
 * legitimate way a pure-text deliverable becomes citable evidence: the agent
 * cannot enumerate messages itself, so the server hands it the real ids plus a
 * bounded excerpt of what it wrote. No other messages are exposed.
 */
export function buildGoalContinuationPrompt(
  record: GoalRecord,
  supplementTexts: string[],
  producedMessages: ReadonlyArray<{ messageId: string; excerpt: string }> = [],
): string {
  const lines: string[] = []
  lines.push(`<goal_continuation goal_id="${record.id}" run_generation="${record.runGeneration}">`)
  lines.push('Internal continuation of an in-progress goal. This is not a new user message; continue working toward the objective below.')
  lines.push('')
  lines.push('Objective:')
  lines.push(record.objective)
  if (supplementTexts.length > 0) {
    lines.push('')
    lines.push('User supplements:')
    for (const supplement of supplementTexts) lines.push(`- ${supplement}`)
  }
  if (record.criteria.length > 0) {
    lines.push('')
    lines.push('Success criteria:')
    for (const criterion of record.criteria) lines.push(`- ${criterion}`)
  }
  if (record.todos.length > 0) {
    lines.push('')
    lines.push('Current todo list:')
    for (const todo of record.todos) {
      const mark = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'
      lines.push(`- ${mark} ${todo.id}: ${todo.label}`)
    }
  }
  // ICR-2: the LAST independent verification of THIS goal rejected the
  // candidate — the per-criterion reasons are injected here so the next round
  // fixes the actual gaps instead of blindly re-filing the same claim.
  if (record.verification && record.verification.status !== 'passed') {
    lines.push('')
    lines.push('Previous independent verification of this goal did NOT pass. Address these specific findings in this round (do not simply re-file the same candidate):')
    for (const criterion of record.verification.criteria) {
      lines.push(`- ${criterion.passed ? '✓' : '✗'} ${criterion.criterion}${criterion.note ? ` — ${criterion.note}` : ''}`)
    }
    if (record.verification.error) lines.push(`- Verifier notes: ${record.verification.error}`)
  }
  if (producedMessages.length > 0) {
    lines.push('')
    lines.push('Assistant messages this goal already produced (persisted; cite one of THESE ids as message evidence in a candidate — no other message id will verify):')
    for (const produced of producedMessages) {
      lines.push(`- [message ${produced.messageId}] ${produced.excerpt}`)
    }
  }
  lines.push('')
  lines.push('Rules:')
  lines.push('- Report progress with the goal_update tool (kind "progress") each round; a round without a progress report counts as no progress.')
  lines.push('- If requirements are unclear, ask the user in your reply AND file goal_update kind "clarification"; the goal pauses until the user answers in this same conversation.')
  lines.push('- NEVER claim completion yourself, even when every todo is checked: file goal_update kind "candidate" with the real artifact paths (or, for a text deliverable, the persisted assistant message id listed above) plus per-criterion evidence. An independent verification step decides.')
  lines.push('</goal_continuation>')
  return lines.join('\n')
}

/** Strict JSON extraction for the verification answer (fail-closed). */
export function parseVerificationAnswer(text: string | undefined): {
  overall: 'passed' | 'not_satisfied'
  criteria: Array<{ criterion: string; passed: boolean; evidenceIds: number[]; note?: string }>
  summary: string
} | null {
  if (!text) return null
  const trimmed = text.trim()
  // Tolerate a fenced code block, nothing else.
  const jsonText = trimmed.startsWith('```')
    ? trimmed.replace(/^```[a-zA-Z0-9]*\s*/, '').replace(/```\s*$/, '')
    : trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (obj.overall !== 'passed' && obj.overall !== 'not_satisfied') return null
  if (typeof obj.summary !== 'string' || obj.summary.length === 0) return null
  if (!Array.isArray(obj.criteria)) return null
  const criteria: Array<{ criterion: string; passed: boolean; evidenceIds: number[]; note?: string }> = []
  // A verdict may state each criterion EXACTLY once: a repeated criterion is
  // either a contradiction (one line true, one false — the first match would
  // win and the false line would be silently ignored, order-dependently) or a
  // redundant restatement. Both make the verdict internally inconsistent, so
  // both fail closed (F-S2, confirmed by the independent parser supplement
  // review: a true-first duplicate line let a false verdict through).
  const seenCriteria = new Set<string>()
  for (const entry of obj.criteria) {
    if (typeof entry !== 'object' || entry === null) return null
    const c = entry as Record<string, unknown>
    if (typeof c.criterion !== 'string' || c.criterion.length === 0) return null
    if (typeof c.passed !== 'boolean') return null
    // F-S1: an evidence index is an INTEGER — a fractional id (0.5, -0.5) is a
    // malformed reference, never something to truncate into a neighboring real
    // index. Silent normalization previously let 0.5 count as evidence #0.
    if (!Array.isArray(c.evidenceIds) || c.evidenceIds.some(id => typeof id !== 'number' || !Number.isInteger(id))) return null
    const normalizedKey = c.criterion.trim().toLowerCase()
    if (seenCriteria.has(normalizedKey)) return null
    seenCriteria.add(normalizedKey)
    criteria.push({
      criterion: c.criterion,
      passed: c.passed,
      evidenceIds: [...c.evidenceIds],
      ...(typeof c.note === 'string' ? { note: c.note } : {}),
    })
  }
  return { overall: obj.overall, criteria, summary: obj.summary }
}

/** F8 model attribution: name the model that actually answered — the SDK's own
 * report when the result message carries one, otherwise the model THIS query
 * was explicitly addressed to (runtime.verificationModel = the session's
 * effective model at resume/turn start). The real zhipu/glm endpoint
 * (attempt-7/attempt-9) reports usage but NO model on the result message;
 * recording the addressed model is a fact about the query, never an invented
 * value.
 */
function modelAttribution(
  result: { model?: string },
  runtime: { verificationModel?: string },
): { model?: string } {
  const model = result.model ?? runtime.verificationModel
  return model ? { model } : {}
}

export function buildVerificationPrompt(
  record: GoalRecord,
  material: string,
  evidenceCount?: number,
  supplementTexts: ReadonlyArray<{ messageId: string; text: string }> = [],
  executionFacts?: { text: string },
): string {
  const lines: string[] = []
  lines.push('You are an independent completion verifier for a Goal. You have NO tools: judge ONLY from the material below.')
  lines.push('')
  lines.push('Original objective:')
  lines.push(record.objective)
  // F-R2-2: the accepted supplements are BINDING requirements with the same
  // force as the criteria — the verifier sees their REAL persisted text, not a
  // count. An agent that failed to restate a supplement into the criteria
  // snapshot can no longer have it silently excluded from the verdict.
  if (supplementTexts.length > 0) {
    lines.push('')
    lines.push(`User supplements accepted into this goal (each is a binding requirement — judge them together with the criteria below):`)
    for (const supplement of supplementTexts) {
      lines.push(`- [user message ${supplement.messageId}] ${supplement.text}`)
    }
  }
  lines.push('')
  lines.push('Success criteria (each must be verified):')
  record.criteria.forEach((criterion, index) => lines.push(`${index + 1}. ${criterion}`))
  lines.push('')
  lines.push('Agent candidate claim:')
  lines.push(record.candidate?.summary ?? '(no summary)')
  lines.push('')
  // attempt-9 real run: the verifier cited evidenceIds outside the material
  // and the verdict was rightly rejected as unbacked. State the VALID index
  // range explicitly so the boundary is unambiguous, not merely implied.
  if (evidenceCount !== undefined) {
    lines.push(`Verified material (server-validated evidence, real file digests and message excerpts). There are EXACTLY ${evidenceCount} evidence items; every evidenceId MUST be a 0-based index in [0, ${Math.max(0, evidenceCount - 1)}]:`)
  } else {
    lines.push('Verified material (server-validated evidence, real file digests and message excerpts):')
  }
  lines.push(material)
  lines.push('')
  // ICR-2: the server's own execution record rides along as CONTEXT. It is
  // deliberately NOT part of the numbered evidence space (evidenceIds index
  // ONLY the candidate material above), and it is the ONLY channel through
  // which a process-dependent criterion ("researched first", "ran the build")
  // can pass: the agent's own claim about its process is never evidence.
  if (executionFacts?.text) {
    lines.push(executionFacts.text)
    lines.push('')
  }
  lines.push('Answer with ONLY a JSON object, no prose, matching:')
  lines.push('{"overall":"passed"|"not_satisfied","criteria":[{"criterion":"<exact criterion text>","passed":true|false,"evidenceIds":[<0-based evidence indices>],"note":"<short reason>"}],"summary":"<one paragraph verdict>"}')
  lines.push('Rules: judge each criterion strictly against the material; an unsupported or partially-supported criterion is passed=false; overall is "passed" only when every criterion passes; never invent evidence indices; state every criterion exactly once.')
  lines.push('A criterion that describes a PROCESS step (research, running a command, an intermediate write) may only pass when the server-recorded execution facts above actually show that step happening; the candidate\'s own account of its process is a claim, not evidence. If the execution record is empty, truncated or marked incomplete, a process-dependent criterion MUST be passed=false.')
  if (supplementTexts.length > 0) {
    lines.push('The user supplements above bind this verdict exactly like the criteria: if the material does not satisfy a supplement, overall MUST be "not_satisfied" (name the unmet supplement in the summary). A supplement that the criteria list omits is NOT excluded — judge it anyway.')
  }
  return lines.join('\n')
}

export const GOAL_VERIFICATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    overall: { type: 'string', enum: ['passed', 'not_satisfied'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          passed: { type: 'boolean' },
          evidenceIds: { type: 'array', items: { type: 'integer' } },
          note: { type: 'string' },
        },
        required: ['criterion', 'passed', 'evidenceIds'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['overall', 'criteria', 'summary'],
}

// ============================================================
// Runtime (non-persisted) per-session Goal state
// ============================================================

export interface GoalStagedReport {
  report: GoalUpdateReport
  goalId: string
  runGeneration: number
  /** Processing generation snapshotted when the tool call began. */
  generationAtRequest: number
  stagedAt: number
}

export interface GoalTurnBinding {
  goalId: string
  runGeneration: number
  /** The processing generation this Goal turn runs under. */
  generation: number
}

export interface GoalRuntimeState {
  /** Binding of the CURRENT processing generation to the Goal turn. */
  turn?: GoalTurnBinding
  /** goal_update reports staged by the callback, awaiting tool_result match. */
  staged: GoalStagedReport[]
  /** toolUseId → normalized tool name for tool_starts seen THIS turn. */
  toolStarts: Map<string, string>
  /** True once THIS round applied any progress report (reset at bind). */
  progressedThisRound: boolean
  /** Consecutive continuation rounds without any progress report. */
  noProgressRounds: number
  /**
   * Fingerprint of the last ACCEPTED progress report (note + todo/criteria
   * snapshots). A byte-identical repeat is NOT progress — it must never reset
   * the no-progress guard. Survives bindTurn (it is cross-round by design).
   */
  lastProgressFingerprint?: string
  /** In-flight verification (abortable). */
  verification?: { controller: AbortController; goalId: string; runGeneration: number }
  /**
   * ICR-4: a candidate report that was recorded but whose independent
   * verification is DEFERRED to the turn's real completion point (inside the
   * still-held lease). One slot — a later candidate replaces it. Cleared when
   * settled, invalidated or cancelled.
   *
   * `internalLedgerBumps` counts version increments THIS controller made to
   * the pending goal's own record while holding this snapshot — today exactly
   * one site: `noteProducedAssistantMessage`, the server appending the
   * session's OWN final output to `producedMessageIds` at the real
   * persistence point. That is bookkeeping of the goal's own transcript, not
   * a requirement change, so the settle point's "no unprocessed supplement"
   * expectation is `version + internalLedgerBumps`. A USER supplement
   * (`admitSupplementFromQueue` / the same-frame turn binding) never grants a
   * bump: it always leaves a mismatch the settle point refuses, and a
   * supplement that arrived BEFORE a subsequent final message keeps the
   * snapshot stale (the capture's grant precondition below fails, so the
   * final can never refresh the candidate past it). Runtime-only, like the
   * slot itself — never persisted, so old records need no migration.
   */
  pendingVerification?: { goalId: string; runGeneration: number; version: number; internalLedgerBumps?: number }
  /**
   * ICR-2: execution facts observed during THIS run generation, not yet
   * committed onto the persisted record. Committed on every report application
   * and at verification time. Runtime-only scratch; the record is authority.
   */
  factScratch: GoalExecutionFact[]
  factScratchTruncated: boolean
  factScratchDropped: number
  /**
   * Plan r2 A.2: runtime-only pairing index for the CURRENT turn's real tool
   * calls, keyed by the SDK tool-use id. A start, its full-input re-emission
   * and its result are ONE logical fact: they merge only when the goal id,
   * run generation, processing generation AND parent attribution all still
   * match — anything else (a reused id in a later turn, a late result from a
   * superseded goal, an orphan result) stays an honestly-unknown standalone
   * fact, never a fabricated success. Rebound on every real turn and cleared
   * when a new Goal is created; never persisted, so old records need no
   * migration. `factDropped` marks a start that was observed but whose fact
   * could not be stored at the record cap — the reference is then EXPLICITLY
   * missing, never silently dropped.
   */
  toolCallIndex: Map<string, {
    goalId: string
    runGeneration: number
    generation: number
    parentToolUseId?: string
    seq: number
    factDropped?: boolean
  }>
  /**
   * Plan r2 A.2/A.4: tool-use ids whose pairing reference was lost at the
   * record cap (the start was really observed; its fact and its result could
   * not be stored). Runtime-only metadata about the RECORD ITSELF — rendered
   * into the facts block as an explicit gap so a lost reference can never be
   * read as "nothing happened". Durable incompleteness is still declared by
   * the persisted `truncated` flag.
   */
  pairingLosses: string[]
  /**
   * Model the independent verification is locked to, captured at goal start and
   * RE-CAPTURED on every resume, so each run's verification rounds judge with
   * the model that is actually in effect for that run. Runtime only
   * (verification never survives a restart).
   */
  verificationModel?: string
}

export function createGoalRuntimeState(): GoalRuntimeState {
  return {
    staged: [],
    toolStarts: new Map(),
    progressedThisRound: false,
    noProgressRounds: 0,
    factScratch: [],
    factScratchTruncated: false,
    factScratchDropped: 0,
    toolCallIndex: new Map(),
    pairingLosses: [],
    // F-R2-6: a goal whose reports never carry structured state produces the
    // SAME null-shape fingerprint as this seed — so the very first note-only
    // round already counts as no progress and the guard fires after EXACTLY
    // GOAL_MAX_NO_PROGRESS_ROUNDS rounds, not one later.
    lastProgressFingerprint: JSON.stringify({ todos: null, criteria: null }),
  }
}

// ============================================================
// Host adapter (implemented by SessionManager)
// ============================================================

export interface GoalControllerHost {
  now(): number
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void

  /** Session metadata exists and is usable in this runtime. */
  hasSession(sessionId: string): boolean
  /** Durable flush: resolves when the snapshot is on disk, rejects on failure. */
  flushSession(sessionId: string): Promise<void>
  /** Debounced enqueue of the session snapshot (not authoritative on its own). */
  persistSession(sessionId: string): void
  /** Header-only metadata write for cold-start recovery (no message hydration). */
  persistGoalMetadataCold(sessionId: string, goal: GoalRecord | undefined, history: GoalRecord[], revision: number): Promise<void>

  /** Broadcast the projection to renderers. */
  publishProjection(sessionId: string, projection: GoalProjection): void
  /**
   * Tell the USER (transcript event, not just a log line) that an authoritative
   * Goal action could not be written to disk. ICR-3: pause already reports this
   * through the host callers; resume/end/completion go through here so every
   * persist failure is user-visible, never silently swallowed.
   */
  notifyStorageFailure(sessionId: string, message: string): void
  /** Append a persisted, non-user message (info) to the transcript; returns its id. */
  appendGoalMessage(sessionId: string, content: string): Promise<string>
  /** Last known final assistant messages (for message evidence and supplements). */
  getSessionMessages(sessionId: string): Array<{ id: string; role: string; isIntermediate?: boolean; content: string; timestamp: number }>
  /** The production send path, marked internal (server-only). */
  sendInternalContinuation(
    sessionId: string,
    prompt: string,
    meta: { source: 'automatic' | 'manual-resume'; goalId: string; runGeneration: number },
  ): Promise<void>
  /** Effective model id for verification (locked at goal start). */
  getEffectiveModel(sessionId: string): string | undefined
  /** The agent-native isolated query (no tools/MCP/settings), abortable. */
  queryLlm(sessionId: string, request: LLMQueryRequest, options: LLMQueryOptions): Promise<LLMQueryResult>
  /**
   * Validate + read a candidate evidence file INSIDE the existing permission
   * fence: allowed roots only, no symlink escapes, bounded read, server-computed
   * digest. Returns the failure reason instead of throwing for refuse cases.
   */
  inspectEvidenceFile(sessionId: string, rawPath: string): Promise<
    | { ok: true; absolutePath: string; bytes: number; sha256: string; excerpt: string }
    | { ok: false; reason: string }
  >
  /** True when the caller may attempt a continuation send right now. */
  canStartTurn(sessionId: string): boolean
  /** Abort the in-flight independent verification for a session, if any. */
  cancelGoalVerification?(sessionId: string): void
}

// ============================================================
// The controller
// ============================================================

export type GoalTurnEvent =
  | {
      type: 'tool_start'
      toolUseId: string
      toolName: string
      /** Present when the call runs INSIDE a sub-agent task. */
      parentToolUseId?: string
      /** Server-bounded summary of the call parameters (ICR-2/C4). */
      inputSummary?: string
    }
  | {
      type: 'tool_result'
      toolUseId: string
      isError: boolean
      resultText: string
      parentToolUseId?: string
      parseReport: (text: string) => GoalUpdateReport | null
    }

export class GoalController {
  constructor(private readonly host: GoalControllerHost) {}

  // ----------------------------------------------------------
  // Runtime state accessors
  // ----------------------------------------------------------

  runtimeOf(managed: { goalRuntime?: GoalRuntimeState }): GoalRuntimeState {
    if (!managed.goalRuntime) managed.goalRuntime = createGoalRuntimeState()
    return managed.goalRuntime
  }

  /** The turn binding captured at chat-iterator start, if this is a Goal turn. */
  turnBindingOf(managed: { goalRuntime?: GoalRuntimeState }): GoalTurnBinding | undefined {
    return managed.goalRuntime?.turn
  }

  // ----------------------------------------------------------
  // Projection
  // ----------------------------------------------------------

  revisionOf(managed: { goalProjectionRevision?: number }): number {
    return managed.goalProjectionRevision ?? 0
  }

  /** Bump the per-session monotonic revision and publish the projection. */
  publishProjection(
    managed: { id: string; goal?: GoalRecord; goalProjectionRevision?: number },
  ): GoalProjection {
    managed.goalProjectionRevision = this.revisionOf(managed) + 1
    const projection = buildGoalProjection(managed.goal, managed.goalProjectionRevision, managed.id)
    this.host.publishProjection(managed.id, projection)
    return projection
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  /**
   * Create the session's Goal, bound to the anchor user message that carried
   * the goal intent. Refuses when a non-terminal Goal already owns the session.
   */
  startGoal(
    managed: { id: string; goal?: GoalRecord; goalHistory?: GoalRecord[]; goalRuntime?: GoalRuntimeState },
    input: { objective: string; anchorMessageId: string; criteria?: string[] },
  ): { ok: true; goal: GoalRecord } | { ok: false; error: string } {
    const objective = input.objective.trim().slice(0, GOAL_OBJECTIVE_MAX_CHARS)
    if (!objective) return { ok: false, error: 'objective must not be empty' }
    if (managed.goal && !isGoalTerminal(managed.goal.status)) {
      return { ok: false, error: 'a goal is already active on this session' }
    }
    const now = this.host.now()
    const criteria = input.criteria && input.criteria.length > 0
      ? input.criteria.slice(0, GOAL_MAX_CRITERIA)
      : [`The objective is fulfilled: ${objective}`]
    const goal = createGoalRecord({
      sessionId: managed.id,
      anchorMessageId: input.anchorMessageId,
      objective,
      criteria,
      now,
    })
    this.runtimeOf(managed).verificationModel = this.host.getEffectiveModel(managed.id)
    // A new Goal owns a fresh pairing space: nothing from the previous Goal's
    // runtime can merge into (or be attributed to) this one.
    const freshRuntime = this.runtimeOf(managed)
    freshRuntime.toolCallIndex = new Map()
    freshRuntime.pairingLosses = []
    managed.goal = goal
    this.host.info(`[goal] created ${goal.id} for session ${managed.id}`)
    this.host.persistSession(managed.id)
    void this.host.flushSession(managed.id).catch((error: unknown) => {
      this.host.error(`[goal] initial persist failed for ${goal.id}: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.publishProjection(managed)
    return { ok: true, goal }
  }

  /**
   * Explicit pause. Stops the clock, persists durably (awaited, with a
   * fail-safe deadline), then reports whether the durable write succeeded.
   * Execution must stop EITHER WAY.
   */
  async pause(
    managed: { id: string; goal?: GoalRecord },
    reason: GoalPauseReason,
    detail?: string,
  ): Promise<{ ok: boolean; flushed: boolean; error?: string }> {
    const goal = managed.goal
    if (!goal || isGoalTerminal(goal.status)) {
      return { ok: false, flushed: false, error: 'no active goal' }
    }
    if (!isGoalRunning(goal.status)) {
      // Already paused: keep the FIRST attribution. A manual pause is never
      // re-attributed to a later stop/error/no_progress, and vice versa —
      // including the automatic error/handoff pauses below.
      return { ok: true, flushed: true }
    }
    const now = this.host.now()
    // ICR-2: a pause is a real control transition of the run — record it, and
    // commit the facts observed so far so they survive the pause durably.
    this.recordFact(managed, { kind: 'paused', detail: `${reason}${detail ? `: ${clipFactText(detail, GOAL_FACT_RESULT_CHARS)}` : ''}` })
    this.commitFacts(managed)
    const facts = managed.goal?.executionFacts
    managed.goal = pauseGoalRecord(
      facts ? { ...goal, executionFacts: facts } : goal,
      reason,
      detail,
      now,
    )
    this.cancelVerification(managed.id)

    // Authoritative state first, then the awaited durable flush with a
    // deadline. The enqueue is NOT success — only the flushed await is.
    this.host.persistSession(managed.id)
    let flushed = true
    try {
      await this.withFlushDeadline(managed.id)
    } catch (error) {
      flushed = false
      this.host.error(`[goal] pause flush failed for ${managed.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.publishProjection(managed)
    return { ok: true, flushed }
  }

  /**
   * Explicit resume of a paused Goal: new runGeneration, clock restarts, then
   * an internal continuation turn through the production send path. Ordinary
   * chat can never trigger this path — only the goalResume command does.
   * `skipInternalContinuation` is for the native auth-success path: the auth
   * result message that follows IS the resuming turn, so firing an internal
   * continuation here would double-drive the session.
   *
   * ICR-3 fail-safe: when the durable flush of the resumed state FAILS, the
   * resume is ROLLED BACK to the paused record (clock never restarts, no
   * continuation turn is fired) and the failure is reported — the caller is
   * never told "resumed" while the durable state still says paused, and an
   * in-memory-active goal is never left running with nobody able to see why.
   */
  async resume(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    options?: { skipInternalContinuation?: boolean },
  ): Promise<{ ok: boolean; error?: string }> {
    const goal = managed.goal
    if (!goal) return { ok: false, error: 'no goal on this session' }
    if (isGoalTerminal(goal.status)) return { ok: false, error: 'goal already ended' }
    if (!this.host.canStartTurn(managed.id)) {
      return { ok: false, error: 'session is busy; resume when the current turn finishes' }
    }
    const now = this.host.now()
    const resumed = resumeGoalRecord(goal, now)
    if ('error' in resumed) return { ok: false, error: resumed.error }
    managed.goal = resumed
    const runtime = this.runtimeOf(managed)
    runtime.noProgressRounds = 0
    // Re-capture: the user may have switched the session model while paused —
    // the NEXT verification must be attributed to (and run on) the model that
    // is actually in effect for this new run.
    runtime.verificationModel = this.host.getEffectiveModel(managed.id)
    this.recordFact(managed, { kind: 'resumed', detail: 'manual-resume' })
    this.host.persistSession(managed.id)
    try {
      await this.host.flushSession(managed.id)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.host.error(`[goal] resume flush failed for ${managed.id}: ${detail}`)
      // Roll back to the paused record: no active clock, no continuation turn,
      // no active projection. The Goal keeps its paused attribution, elapsed
      // time and history — nothing is lost by failing to resume.
      managed.goal = goal
      this.recordFact(managed, { kind: 'paused', detail: `resume not persisted: ${detail}` })
      this.host.persistSession(managed.id)
      this.publishProjection(managed)
      this.host.notifyStorageFailure(managed.id, `The goal could not be resumed: its state could not be written to disk (${detail}). It stays paused — try again when storage is available.`)
      return { ok: false, error: `the resumed goal state could not be written to disk: ${detail}` }
    }
    this.publishProjection(managed)
    if (!options?.skipInternalContinuation) {
      void this.continueGoal(managed, 'manual-resume').catch((error: unknown) => {
        this.host.error(`[goal] continuation failed for ${goal.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return { ok: true }
  }

  /**
   * Terminal end ("ended"): cancels scheduling, records history, clears
   * projection.
   *
   * ICR-3 fail-safe: the terminal clear is PUBLISHED before any await — a
   * notice-append failure (or its flush) can never leave clients looking at a
   * live goal that is already gone in memory. The bounded flush outcome is
   * reported honestly through `flushed` (the caller warns the user); the end
   * itself stays authoritative either way.
   */
  async end(
    managed: { id: string; goal?: GoalRecord; goalHistory?: GoalRecord[] },
    detail?: string,
  ): Promise<{ ok: boolean; flushed: boolean; error?: string }> {
    const goal = managed.goal
    if (!goal) return { ok: false, flushed: false, error: 'no goal on this session' }
    if (isGoalTerminal(goal.status)) return { ok: false, flushed: false, error: 'goal already ended' }
    const now = this.host.now()
    // ICR-2: the user-end is a real control transition — record it on the
    // record before it leaves the live slot, so the history entry carries the
    // execution story that led here.
    this.recordFact(managed, { kind: 'turn_ended', detail: 'ended by user' })
    this.commitFacts(managed)
    const facts = managed.goal?.executionFacts
    const ended = endGoalRecord(facts ? { ...goal, executionFacts: facts } : goal, 'ended', now)
    this.cancelVerification(managed.id)
    managed.goalHistory = [...(managed.goalHistory ?? []), ended]
    managed.goal = undefined
    this.host.persistSession(managed.id)
    // Terminal projection FIRST — never gated on the notice append below.
    this.publishProjection(managed)
    let flushed = true
    try {
      await this.withFlushDeadline(managed.id)
    } catch (error) {
      flushed = false
      this.host.error(`[goal] end flush failed for ${managed.id}: ${error instanceof Error ? error.message : String(error)}`)
      this.host.notifyStorageFailure(managed.id, 'The goal was ended, but its state could not be written to disk. The end is kept in memory; the durable record may still show the previous state.')
    }
    const message = detail
      ? `Goal ended before completion. ${detail}`
      : 'Goal ended before completion. The work stopped here; files and messages produced so far are kept.'
    try {
      await this.host.appendGoalMessage(managed.id, message)
    } catch (error) {
      // The end stands; only the transcript notice failed. Never surface it as
      // a failed end (that would imply the goal is still running).
      this.host.error(`[goal] end notice failed for ${managed.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: true, flushed }
  }

  /**
   * Cold-start recovery: any Goal found running/verifying becomes paused with
   * `restart_required`; the crash-to-restart gap is NEVER folded into the
   * accumulated runtime (runningSince is simply dropped). Header-only write —
   * no message hydration at boot.
   */
  async recoverOnColdStart(managed: { id: string; goal?: GoalRecord; goalHistory?: GoalRecord[]; goalProjectionRevision?: number }): Promise<void> {
    const goal = managed.goal
    if (!goal || !isGoalRunning(goal.status)) return
    const now = this.host.now()
    // NOT pauseGoalRecord: that folds runningSince into elapsedMs, which would
    // credit the entire crash-to-restart gap as running time. Recovery DROPS
    // the live segment — only observed execution counts.
    managed.goal = {
      ...goal,
      runningSince: undefined,
      status: 'paused',
      pauseReason: 'restart_required',
      pauseDetail: 'The app restarted while this goal was running. Resume explicitly to continue; offline time is not counted.',
      version: goal.version + 1,
      updatedAt: now,
    }
    await this.host.persistGoalMetadataCold(
      managed.id,
      managed.goal,
      managed.goalHistory ?? [],
      this.revisionOf(managed) + 1,
    )
    managed.goalProjectionRevision = this.revisionOf(managed) + 1
    this.host.publishProjection(managed.id, buildGoalProjection(managed.goal, managed.goalProjectionRevision, managed.id))
  }

  // ----------------------------------------------------------
  // Turn binding (chat-iterator-time capture)
  // ----------------------------------------------------------

  /**
   * Decide whether THIS send belongs to the session's Goal and bind the turn.
   * Called once per new processing generation, right after the generation is
   * claimed — the binding is captured here and never re-read from mutable
   * current state later.
   *
   * Rules:
   * - `goalIntent: start` on a Goal-less session CREATES the Goal (anchored to
   *   this user message) and binds the turn.
   * - A running Goal claims user supplements: any user message during an
   *   active/verifying Goal belongs to it.
   * - A paused Goal claims NOTHING — ordinary chat after a manual pause/Stop
   *   is ordinary chat, and only the explicit goalResume path re-arms the
   *   Goal — with TWO state-based exceptions, never keyword matches:
   *   `awaiting_user` (the agent asked a clarification via goal_update; the
   *   next same-frame reply IS the answer to this Goal) and `awaiting_permission`
   *   resolved by a STRUCTURED question answer (`questionAnswer`, the native
   *   request_user_input response metadata — a free-form chat still keeps the
   *   goal paused).
   */
  bindTurn(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    input: { goalIntent?: { action: 'start' }; userMessageId?: string; content: string; generation: number; internalContinuation?: boolean; questionAnswer?: boolean },
  ): { bound: true; binding: GoalTurnBinding } | { bound: false; reason?: string } {
    const runtime = this.runtimeOf(managed)
    runtime.staged = []
    runtime.toolStarts = new Map()
    runtime.progressedThisRound = false
    // Plan r2 A.2: the pairing index is RUNTIME-ONLY and per-turn — a fresh
    // turn rebinds it, so a tool-use id reused in a later turn can never
    // silently merge into a previous turn's fact.
    runtime.toolCallIndex = new Map()

    const goal = managed.goal
    if (input.goalIntent?.action === 'start') {
      const created = this.startGoal(managed, {
        objective: input.content,
        anchorMessageId: input.userMessageId ?? '',
      })
      if (!created.ok) return { bound: false, reason: created.error }
    }

    let current = managed.goal
    if (current?.status === 'paused' && current.pauseReason === 'awaiting_user' && !input.internalContinuation) {
      // The goal asked the user a clarification question; this reply IS the
      // answer. Same-frame supplement + a real (re)start of the run.
      const resumed = resumeGoalRecord(current, this.host.now())
      if (!('error' in resumed)) {
        managed.goal = resumed
        current = resumed
      }
    } else if (current?.status === 'paused' && current.pauseReason === 'awaiting_permission' && input.questionAnswer === true && !input.internalContinuation) {
      // The native structured question was answered; the goal's blocked run
      // continues. Free-form chat does NOT hit this branch — it stays paused.
      const resumed = resumeGoalRecord(current, this.host.now())
      if (!('error' in resumed)) {
        managed.goal = resumed
        current = resumed
      }
    }
    if (!current || !isGoalRunning(current.status)) {
      runtime.turn = undefined
      return { bound: false, reason: 'no running goal' }
    }

    // Same-frame supplement: dedupe by message id (queue replays must not
    // double-append), then persist the supplement binding on the record. The
    // controller's OWN continuation prompt is never a supplement — it is
    // server-composed context, not user intent (ICR-1: an internal continuation
    // carries no user message id at all, so there is nothing to bind).
    const isSupplement = !input.internalContinuation
    if (isSupplement && input.userMessageId && !current.supplementMessageIds.includes(input.userMessageId)) {
      const supplements = [...current.supplementMessageIds, input.userMessageId]
      // Bound the supplement list; the earliest ones are the anchor context.
      managed.goal = {
        ...current,
        supplementMessageIds: supplements.slice(-GOAL_MAX_TRACKED_MESSAGES),
        version: current.version + 1,
        updatedAt: this.host.now(),
      }
      this.host.persistSession(managed.id)
    }

    const bound = managed.goal ?? current
    runtime.turn = {
      goalId: bound.id,
      runGeneration: bound.runGeneration,
      generation: input.generation,
    }
    // ICR-2: a new turn is a real execution boundary — record it (and clear any
    // stale "last turn ended abnormally" marker from the previous round).
    this.markLastTurnIncomplete(managed, undefined)
    this.recordFact(managed, {
      kind: 'turn_started',
      runGeneration: bound.runGeneration,
      detail: input.internalContinuation
        ? 'internal continuation (server-scheduled)'
        : input.goalIntent?.action === 'start'
          ? 'goal start (user objective)'
          : 'user message',
    })
    return { bound: true, binding: runtime.turn }
  }

  // ----------------------------------------------------------
  // Server-side capture (F-R2-3 / F-R2-4 / F-R2-7)
  // ----------------------------------------------------------

  /**
   * Record a final assistant message as produced by THIS Goal.
   *
   * Called by the host at the REAL persistence point of an agent turn's final
   * output (`text_complete`, non-intermediate) — never from the agent, never
   * from a client. Ownership is proven, not assumed: the message is only
   * attributed when the CURRENT processing generation is the turn bound to
   * this exact goal id + run generation, and the goal is still running. An
   * ordinary-chat reply, a message from before the goal existed, a later
   * Goal's output and server-composed notices never qualify — so a same-named
   * successor Goal cannot inherit an earlier Goal's work.
   */
  noteProducedAssistantMessage(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    messageId: string,
    generation: number,
  ): boolean {
    const goal = managed.goal
    const turn = managed.goalRuntime?.turn
    if (!goal || isGoalTerminal(goal.status)) return false
    // ICR-5: a PAUSED goal captures nothing — including the abort-drain window
    // after a user Stop or a clarification, where the SDK still drains a late
    // final from the aborted turn. That output belongs to the native chat
    // transcript (it is kept as an ordinary message) but must never become
    // citable evidence of a goal the user just paused. `awaiting_user` and
    // `awaiting_permission` are the same status, so one check covers every
    // paused attribution; resumption rebinds a NEW run generation and its
    // outputs are captured normally.
    if (goal.status === 'paused') return false
    if (!turn || turn.goalId !== goal.id || turn.runGeneration !== goal.runGeneration) return false
    if (turn.generation !== generation) return false
    if (goal.producedMessageIds?.includes(messageId)) return false
    // POO-134 root-cause fix (own ledger ≠ supplement): when the capture lands
    // on the exact record a pending deferred verification was snapshotted from
    // (same goal, same run generation, still verifying, at the version the
    // snapshot currently EXPECTS), the version bump it causes is THIS
    // controller's own ledger accounting, so the pending snapshot's
    // expectation moves with it — the settle point must not read it as a user
    // supplement. The expectation is `pending.version + internalLedgerBumps`,
    // i.e. it moves with EVERY granted own capture, not just the first one: a
    // Claude-backend turn can legitimately capture several own finals in one
    // turn (a Task sub-agent's sidechain final before the main final), and
    // only the first of them used to be granted — the second drifted the
    // record past the snapshot and a good candidate was discarded as if a
    // supplement had arrived (review r1 F1).
    //
    // A real user supplement bumps the version WITHOUT capturing, so it moves
    // the record off the expectation permanently: no later own capture can
    // re-align them (captures only ever move both sides together, while a
    // supplement moves the record alone), the grant precondition stays false,
    // and the settle point still reads the drift as F-R2-7 staleness. Any
    // other state (a pause, a different run) leaves the pending slot untouched
    // as well: the final message of a turn whose candidate a supplement
    // already invalidated can never refresh that candidate.
    const runtime = managed.goalRuntime
    const pending = runtime?.pendingVerification
    const ownLedgerCapture = !!pending
      && pending.goalId === goal.id
      && pending.runGeneration === goal.runGeneration
      && goal.version === pending.version + (pending.internalLedgerBumps ?? 0)
      && goal.status === 'verifying'
    managed.goal = {
      ...goal,
      producedMessageIds: [...(goal.producedMessageIds ?? []), messageId].slice(-GOAL_MAX_TRACKED_MESSAGES),
      version: goal.version + 1,
      updatedAt: this.host.now(),
    }
    if (ownLedgerCapture && runtime) {
      runtime.pendingVerification = { ...pending!, internalLedgerBumps: (pending!.internalLedgerBumps ?? 0) + 1 }
    }
    return true
  }

  /**
   * Bind a user message to the running Goal at its REAL admission point —
   * the moment the production send path accepts it while a turn is already
   * running (the queue branch). The id is the REAL persisted user message id;
   * nothing is fabricated or duplicated (bindTurn dedupes on replay).
   *
   * Binding BUMPS THE VERSION, which invalidates any in-flight verification
   * snapshot: a verdict that settles after this point can no longer complete
   * the goal on a pre-supplement state (F-R2-7). A manually-paused goal binds
   * nothing — ordinary chat during a pause is ordinary chat.
   */
  admitSupplementFromQueue(
    managed: { id: string; goal?: GoalRecord },
    userMessageId: string,
  ): boolean {
    const goal = managed.goal
    if (!goal || !isGoalRunning(goal.status)) return false
    if (goal.supplementMessageIds.includes(userMessageId)) return false
    managed.goal = {
      ...goal,
      supplementMessageIds: [...goal.supplementMessageIds, userMessageId].slice(-GOAL_MAX_TRACKED_MESSAGES),
      version: goal.version + 1,
      updatedAt: this.host.now(),
    }
    this.host.persistSession(managed.id)
    this.publishProjection(managed)
    return true
  }

  // ----------------------------------------------------------
  // Report staging (callback side) + application (tool_result side)
  // ----------------------------------------------------------

  /**
   * The goal_update tool callback. Validates the turn identity from the
   * closure snapshot and STAGES the report — it never writes the record. The
   * throw path surfaces to the model as a tool error.
   */
  stageReport(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    report: GoalUpdateReport,
    generationAtRequest: number,
  ): void {
    const goal = managed.goal
    if (!goal || isGoalTerminal(goal.status)) {
      throw new Error('goal_update rejected: there is no active goal on this session')
    }
    const runtime = this.runtimeOf(managed)
    const turn = runtime.turn
    if (!turn) {
      throw new Error('goal_update rejected: this turn is not a goal turn')
    }
    if (generationAtRequest !== turn.generation) {
      throw new Error(`goal_update rejected: the reporting turn (generation ${generationAtRequest}) is no longer active`)
    }
    if (goal.id !== turn.goalId || goal.runGeneration !== turn.runGeneration) {
      throw new Error('goal_update rejected: the goal generation changed during the turn')
    }
    runtime.staged.push({
      report,
      goalId: turn.goalId,
      runGeneration: turn.runGeneration,
      generationAtRequest,
      stagedAt: this.host.now(),
    })
  }

  /**
   * Chat-loop observation. Records same-turn tool_starts and, when the
   * matching successful goal_update tool_result arrives, applies the staged
   * report through the controller (the ONLY application path) and runs inline
   * verification for candidates — all inside the live turn lease.
   */
  async observeTurnEvent(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    event: GoalTurnEvent,
    binding: GoalTurnBinding,
    generation: number,
  ): Promise<void> {
    const runtime = this.runtimeOf(managed)
    if (!runtime.turn || runtime.turn.goalId !== binding.goalId || runtime.turn.generation !== generation) {
      // A stale-turn event is normal (events can trail a superseded binding);
      // only the mismatch against an EXPECTED turn would hide a real drop, so
      // this stays quiet when the turn was deliberately unbound.
      return
    }

    if (event.type === 'tool_start') {
      runtime.toolStarts.set(event.toolUseId, normalizeToolName(event.toolName))
      // ICR-2 + Plan r2 A.2: every real tool call of a goal turn is ONE host
      // fact for its whole lifecycle — the start, the SDK's full-input
      // re-emission and the result merge into the same seq. A merge happens
      // ONLY when the goal id, run generation, processing generation AND
      // parent attribution all still match; anything else is a NEW call (or
      // an honestly-unknown result), never a silent merge into stale work.
      // The pairing index is runtime-only and rebound every turn.
      const normalized = normalizeToolName(event.toolName)
      const goalNow = managed.goal!
      const prior = runtime.toolCallIndex.get(event.toolUseId)
      const sameIdentity = !!prior
        && prior.goalId === goalNow.id
        && prior.runGeneration === binding.runGeneration
        && prior.generation === generation
        && (prior.parentToolUseId ?? undefined) === (event.parentToolUseId ?? undefined)
      if (prior && sameIdentity && !prior.factDropped) {
        // SDK double emission of the same start: upsert in place (works even
        // when the fact was already committed mid-turn).
        this.upsertFactFields(managed, prior.seq, fact => ({
          ...fact,
          ...(event.inputSummary && !fact.paramSummary ? { paramSummary: event.inputSummary } : {}),
          ...(event.parentToolUseId && !fact.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        }))
        return
      }
      const stored = this.recordFact(managed, {
        kind: 'tool_call',
        runGeneration: binding.runGeneration,
        toolName: normalized,
        toolUseId: event.toolUseId,
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        ...(event.inputSummary ? { paramSummary: event.inputSummary } : {}),
      })
      runtime.toolCallIndex.set(event.toolUseId, {
        goalId: goalNow.id,
        runGeneration: binding.runGeneration,
        generation,
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        seq: 'seq' in stored ? stored.seq : -1,
        ...('dropped' in stored ? { factDropped: true } : {}),
      })
      return
    }

    // tool_result: merge the outcome into the SAME logical fact when the
    // pairing identity still holds; otherwise record it as an explicitly
    // unknown standalone fact — a result without its start in THIS turn/goal
    // is never dressed up as a known successful operation.
    const startedAs = normalizeToolName(runtime.toolStarts.get(event.toolUseId) ?? '')
    const goalForResult = managed.goal!
    const priorResult = runtime.toolCallIndex.get(event.toolUseId)
    const sameResultIdentity = !!priorResult
      && priorResult.goalId === goalForResult.id
      && priorResult.runGeneration === binding.runGeneration
      && priorResult.generation === generation
      && (priorResult.parentToolUseId ?? undefined) === (event.parentToolUseId ?? undefined)
    const resultSummary = event.resultText
      ? summarizeGoalFactResult(startedAs || 'unknown', event.resultText)
      : undefined
    if (priorResult && sameResultIdentity && !priorResult.factDropped) {
      this.upsertFactFields(managed, priorResult.seq, fact => ({
        ...fact,
        isError: event.isError,
        ...(resultSummary ? { resultSummary } : {}),
        ...(event.parentToolUseId && !fact.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      }))
    } else {
      // Plan r2 A.2: an orphan result (no observed start this turn), a result
      // whose id was reused across turns/goals, or one whose start fact was
      // lost at the record cap. Honest in every case: no invented tool name,
      // no implicit success.
      const capLoss = !!priorResult?.factDropped
      const stored = this.recordFact(managed, {
        kind: 'tool_call',
        runGeneration: binding.runGeneration,
        toolUseId: event.toolUseId,
        isError: event.isError,
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        ...(resultSummary ? { resultSummary } : {}),
        detail: capLoss
          ? `unknown pairing: start ${event.toolUseId} was observed but dropped at the record cap; its outcome cannot be attached`
          : `unknown pairing: no matching start observed for ${event.toolUseId} in this turn/goal`,
      })
      if ('dropped' in stored) runtime.pairingLosses.push(event.toolUseId)
    }

    // tool_result: only a goal_update tool whose start we saw THIS turn, and
    // only a SUCCESSFUL result carrying the canonical wire payload. Results of
    // any other tool are ordinary traffic and pass through quietly; the drops
    // below ARE anomalous for a matched goal_update call, so each stays
    // observable — a silently swallowed report would strand the Goal in
    // no-progress pause with no diagnostic trail (observed in the first
    // real-model run).
    if (startedAs !== 'goal_update') return
    // Plan r2 A.3: the fact copy of a goal_update call states an HONEST
    // outcome — `applied` only after this very wire passed staged-equality AND
    // the apply actually mutated the record; every refusal names its reason and
    // never uses the word `applied` (a transport-level isError=false says
    // nothing about whether the Goal record moved).
    const reportSeq = runtime.toolCallIndex.get(event.toolUseId)
    const recordReportOutcome = (text: string) => {
      if (reportSeq && !reportSeq.factDropped) {
        this.upsertFactFields(managed, reportSeq.seq, fact => ({ ...fact, resultSummary: text }))
      }
    }
    // ICR-2: a goal_update fired INSIDE a sub-agent task never mutates the
    // parent goal. The fact above keeps the parent link so the work is still
    // visible as sub-agent execution; the report itself is refused here — the
    // sub-agent's own session/goal, not this one, owns its reports.
    if (event.parentToolUseId) {
      this.host.warn(`[goal] goal_update from inside a sub-agent task (${event.toolUseId}) cannot report against the parent goal; ignored`)
      recordReportOutcome('wire seen; report not accepted (sub-agent tasks cannot report against the parent goal)')
      return
    }
    if (event.isError) {
      recordReportOutcome('wire seen; report not accepted (the tool result itself errored)')
      return
    }
    const wire = event.parseReport(event.resultText)
    if (!wire) {
      this.host.warn(`[goal] goal_update tool_result for ${event.toolUseId} carried no canonical report payload; ignored`)
      recordReportOutcome('wire seen; report not accepted (no canonical report payload in the result)')
      return
    }
    // Match the staged entry by PAYLOAD, not FIFO: parallel goal_update calls
    // in one turn may stage and resolve in different orders, and a
    // first-by-generation match would pair each result with the WRONG staged
    // report (both then fail the equality check and both are lost).
    const serialized = JSON.stringify(wire)
    const stagedIndex = runtime.staged.findIndex(
      s => s.generationAtRequest === generation && JSON.stringify(s.report) === serialized,
    )
    if (stagedIndex < 0) {
      this.host.warn(`[goal] goal_update tool_result for ${event.toolUseId} matches no staged report of generation ${generation}; ignored`)
      recordReportOutcome('wire seen; report not accepted (no staged report of this turn matched the wire payload)')
      return
    }
    const staged = runtime.staged[stagedIndex]
    runtime.staged.splice(stagedIndex, 1)
    const outcome = await this.applyReport(managed, staged.report, wire, binding)
    if (outcome === 'ignored') {
      recordReportOutcome('wire seen; report not accepted (staged payload diverged or the goal generation moved on)')
      return
    }
    const completedTodos = (managed.goal?.todos ?? []).filter(t => t.status === 'completed').length
    recordReportOutcome(`applied: ${staged.report.kind}; todos completed=${completedTodos}`)
  }

  /**
   * The ONLY place a report mutates the Goal record. `staged` proves the
   * callback path (turn identity validated); `wire` proves the tool_result
   * path (successful result of the same turn). Both must describe the SAME
   * report — the staged entry is a separate parse of the same tool arguments,
   * so object identity can never hold; serialized equality is the check — or
   * the application fails closed.
   */
  private async applyReport(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    staged: GoalUpdateReport,
    wire: GoalUpdateReport,
    binding: GoalTurnBinding,
  ): Promise<'applied' | 'ignored' | 'completed' | 'paused' | 'pending'> {
    const goal = managed.goal
    if (!goal || isGoalTerminal(goal.status)) return 'ignored'
    if (JSON.stringify(staged) !== JSON.stringify(wire)) {
      this.host.warn(`[goal] staged report and wire payload diverged for goal ${goal.id}; report ignored`)
      return 'ignored'
    }
    if (goal.id !== binding.goalId || goal.runGeneration !== binding.runGeneration) {
      this.host.warn(`[goal] report for goal ${binding.goalId} arrived under a stale generation; ignored`)
      return 'ignored'
    }

    const now = this.host.now()
    let next: GoalRecord = { ...goal, version: goal.version + 1, updatedAt: now }

    if (staged.todos) {
      const merged = mergeGoalTodos(goal.todos, staged.todos, now)
      if (!merged) {
        this.host.warn(`[goal] todo snapshot exceeded ${GOAL_MAX_TODOS} items; todos unchanged`)
      } else {
        next.todos = merged
      }
    }
    if (staged.criteria) {
      const merged = mergeGoalCriteria(goal.criteria, staged.criteria)
      if (!merged) {
        this.host.warn(`[goal] criteria snapshot exceeded ${GOAL_MAX_CRITERIA} items; criteria unchanged`)
      } else {
        next.criteria = merged
      }
    }

    const runtime = this.runtimeOf(managed)

    if (staged.kind === 'clarification') {
      // Commit the facts observed so far onto the CURRENT record first (the
      // commit reads managed.goal), then carry them into the paused record.
      this.commitFacts(managed)
      const facts = managed.goal?.executionFacts
      next = pauseGoalRecord(
        facts ? { ...next, executionFacts: facts } : next,
        'awaiting_user',
        staged.clarification?.question,
        now,
      )
      managed.goal = next
      this.host.persistSession(managed.id)
      try {
        await this.host.flushSession(managed.id)
      } catch (error) {
        this.host.warn(`[goal] clarification flush failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.publishProjection(managed)
      return 'paused'
    }

    if (staged.kind === 'candidate') {
      // ICR-4: the candidate is RECORDED here and its independent verification
      // is DEFERRED to the turn's real completion point — the tool_result
      // consumption chain never awaits a long query, so the live turn keeps
      // draining events (a blocked event loop was observed in the real run as
      // a ~97s silent window while the SDK kept working). The goal is already
      // 'verifying' (the clock keeps charging; a user pause during the wait
      // stops everything), and the pending slot carries the identity the
      // settle point must re-validate.
      this.commitFacts(managed)
      const facts = managed.goal?.executionFacts
      const verifying: GoalRecord = {
        ...(facts ? { ...next, executionFacts: facts } : next),
        candidate: {
          summary: staged.candidate?.summary ?? '',
          reportedAt: now,
          evidence: (staged.candidate?.evidence ?? []) as GoalEvidence[],
        },
        status: 'verifying',
      }
      managed.goal = verifying
      runtime.pendingVerification = {
        goalId: verifying.id,
        runGeneration: verifying.runGeneration,
        version: verifying.version,
        internalLedgerBumps: 0,
      }
      this.host.persistSession(managed.id)
      this.publishProjection(managed)
      this.host.info(`[goal] candidate recorded for ${verifying.id}; independent verification deferred to the end of the turn (generation ${binding.generation})`)
      return 'pending'
    }

    // progress: a CHANGED report resets the no-progress counter. A
    // byte-identical repeat is NOT progress — it must never keep a stalled
    // goal running forever.
    // The fingerprint covers STRUCTURED state only — todo statuses and
    // criteria. The free-text `note` is deliberately EXCLUDED: rewording
    // "working on it" into "still working on it" is not progress (self-check
    // a); only the model actually ADVANCING todos or criteria resets the
    // no-progress counter. A goal whose reports carry no structured state at
    // all therefore can never reset the counter — fail-closed by design.
    const fingerprint = JSON.stringify({ todos: staged.todos ?? null, criteria: staged.criteria ?? null })
    if (runtime.lastProgressFingerprint !== fingerprint) {
      runtime.lastProgressFingerprint = fingerprint
      runtime.noProgressRounds = 0
      runtime.progressedThisRound = true
    }
    // CHECKPOINT the observed run (self-check b): fold the live segment into
    // elapsedMs and immediately restart the clock, so every persisted progress
    // report durably records the time observed so far. A cold restart then
    // keeps the whole observed runtime — dropping only the post-crash gap —
    // instead of losing everything since the last pause.
    const checkpointAt = this.host.now()
    this.commitFacts(managed)
    const facts = managed.goal?.executionFacts
    managed.goal = startGoalClock(stopGoalClock(facts ? { ...next, executionFacts: facts } : next, checkpointAt), checkpointAt)
    this.host.persistSession(managed.id)
    this.publishProjection(managed)
    return 'applied'
  }

  // ----------------------------------------------------------
  // Verification
  // ----------------------------------------------------------

  /**
   * ICR-4: settle a DEFERRED candidate verification at the turn's real
   * completion point.
   *
   * The host calls this from the chat loop's complete handling — AFTER the SDK
   * turn has finished (no residual own-task execution) and BEFORE
   * onProcessingStopped releases the processing/execution/admission lease. The
   * independent query therefore runs inside the SAME authorization lease that
   * ran the turn: no fire-and-forget past the lease, no second scheduler.
   *
   * Preconditions (all re-checked here, never assumed from the event type):
   * - a pending candidate exists and is still THIS goal, still 'verifying', at
   *   the SAME version (any supplement bumped the version — the snapshot is
   *   stale and the queued replay must re-verify) and run generation;
   * - the turn is still the bound one for THIS processing generation;
   * - `stillCurrent()` (host-provided) holds BEFORE the query and AGAIN after
   *   it (C3): a user Stop, a cancel timeout, a superseding send or an
   *   account/identity change during the query discards the verdict.
   */
  async settlePendingVerification(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    binding: GoalTurnBinding | undefined,
    options: { generation: number; stillCurrent: () => boolean },
  ): Promise<'settled' | 'stale' | 'none'> {
    const runtime = this.runtimeOf(managed)
    const pending = runtime.pendingVerification
    if (!pending) return 'none'
    const dropPending = () => {
      runtime.pendingVerification = undefined
    }

    const goal = managed.goal
    if (!goal || goal.id !== pending.goalId || goal.runGeneration !== pending.runGeneration) {
      dropPending()
      this.host.warn(`[goal] deferred verification for ${pending.goalId} discarded: the goal moved on`)
      return 'stale'
    }
    if (goal.status !== 'verifying') {
      // Paused (user stop / clarification / handoff) or otherwise no longer
      // waiting on a verdict: the pending snapshot is dead — the authoritative
      // transition already claimed this goal's next step.
      dropPending()
      return 'stale'
    }
    if (goal.version !== pending.version + (pending.internalLedgerBumps ?? 0)) {
      // F-R2-7 at the settle point: a supplement was admitted after the
      // candidate. Restore 'active' so the replayed supplement round re-verifies.
      // The only version drift the ledger accepts is the controller's OWN
      // accounting: `internalLedgerBumps` moves the expected version with every
      // granted own-final capture (review r1 F1 — a turn may legitimately
      // produce several, e.g. a sub-agent sidechain final before the main
      // final). A user supplement never grants a bump: it moves the record off
      // the expectation alone, no later capture can re-align the two sides,
      // and the mismatch survives to this check.
      dropPending()
      managed.goal = { ...goal, status: 'active' }
      this.host.persistSession(managed.id)
      this.publishProjection(managed)
      this.host.warn(`[goal] deferred verification for ${goal.id} discarded: a supplement arrived after the candidate`)
      return 'stale'
    }
    if (!binding || binding.goalId !== goal.id || binding.runGeneration !== goal.runGeneration || binding.generation !== options.generation) {
      dropPending()
      this.host.warn(`[goal] deferred verification for ${goal.id} discarded: the reporting turn is no longer bound`)
      return 'stale'
    }
    if (!options.stillCurrent()) {
      dropPending()
      this.host.warn(`[goal] deferred verification for ${goal.id} discarded: the turn lease is no longer current`)
      return 'stale'
    }

    dropPending()
    const verifying = goal
    const { receipt, evidence: validatedEvidence } = await this.verifyCandidate(managed, binding)
    // C3: re-validate AFTER the query — a Stop, a cancel timeout, a queued
    // superseding send or an identity change during the query means the world
    // moved while the verifier ran. The pre-await snapshot NEVER wins.
    if (!options.stillCurrent()) {
      this.host.warn(`[goal] goal ${verifying.id} changed during verification; verdict discarded`)
      if (receipt.status === 'passed') {
        // A late pass is a transcript notice — never a state write.
        await this.host.appendGoalMessage(managed.id, `Independent verification of goal ${verifying.id} PASSED after the turn ended; recorded here for the record — the goal state was not changed.`)
      }
      const stalled = managed.goal
      if (stalled && stalled.id === verifying.id && stalled.status === 'verifying') {
        managed.goal = { ...stalled, status: 'active' }
        this.host.persistSession(managed.id)
        this.publishProjection(managed)
      }
      return 'stale'
    }
    // CAS re-read: the user may have paused/ended the goal while the
    // independent query was in flight. The pre-await snapshot NEVER wins —
    // only the record that is still THIS goal, still verifying, at the SAME
    // version and run generation may accept the verdict.
    const current = managed.goal
    const unchanged = !!current
      && current.id === verifying.id
      && current.status === 'verifying'
      && current.version === verifying.version
      && current.runGeneration === verifying.runGeneration
    if (!unchanged) {
      this.host.warn(`[goal] goal ${verifying.id} changed during verification (${current ? `${current.status}/v${current.version}` : 'removed'}); verdict discarded`)
      if (receipt.status === 'passed') {
        // A late pass is a transcript notice — never a state write.
        await this.host.appendGoalMessage(managed.id, `Independent verification of goal ${verifying.id} PASSED after the goal was ${current ? `already ${current.status}${current.pauseReason ? ` (${current.pauseReason})` : ''}` : 'ended'}; recorded here for the record — the goal state was not changed.`)
      }
      // F-R2-7: the only change that leaves the record still THIS goal and
      // still 'verifying' is a user supplement admitted while the query was
      // in flight (version bump). Restore 'active' so the next round — which
      // WILL see the supplement — re-verifies; leaving the record parked in
      // 'verifying' would strand the goal with nobody driving it (paused and
      // terminal records keep their own attribution and are left alone).
      const stalled = managed.goal
      if (stalled && stalled.id === verifying.id && stalled.status === 'verifying') {
        managed.goal = { ...stalled, status: 'active' }
        this.host.persistSession(managed.id)
        this.publishProjection(managed)
      }
      return 'stale'
    }
    const withReceipt: GoalRecord = { ...current, verification: receipt, version: current.version + 1, updatedAt: this.host.now() }
    // Persist the server-validated evidence (normalized paths + digests the
    // server actually checked) in place of the agent's claimed evidence.
    withReceipt.candidate = withReceipt.candidate
      ? { ...withReceipt.candidate, evidence: validatedEvidence }
      : withReceipt.candidate
    managed.goal = withReceipt
    if (receipt.status === 'passed') {
      await this.completeGoal(managed)
      return 'settled'
    }
    // not_satisfied → back to active (a continuation round addresses the
    // gaps; the clock never stopped, so the run segment stays continuous);
    // failed (infra) → pause with the real reason.
    if (receipt.status === 'failed') {
      managed.goal = pauseGoalRecord(managed.goal, 'error', receipt.error ?? 'verification failed', this.host.now())
    } else if (managed.goal.executionFacts?.truncated === true) {
      // Plan r2 A.6: the record hit its cap and the dropped facts are gone for
      // good — no continuation round can re-observe them. Another automatic
      // round would re-verify against the same hole with no new information
      // (the real attempt-13 run span 602s doing exactly that), so the goal
      // pauses with an honest explanation instead. An explicit resume still
      // goes through its own permission checks and restarts the clock.
      const detail = 'verification failed against an irreversibly truncated execution record: facts dropped at the record cap cannot be re-observed, so an automatic retry would add no information. An explicit resume continues with a fresh record budget.'
      await this.pause(managed, 'error', detail)
      await this.host.appendGoalMessage(managed.id, `Goal paused: ${detail}`)
    } else {
      managed.goal = { ...managed.goal, status: 'active' }
    }
    this.host.persistSession(managed.id)
    this.publishProjection(managed)
    return 'settled'
  }

  /** Abort an in-flight verification (stop/delete/account switch/restart). */
  cancelVerification(sessionId: string): void {
    // The runtime state lives on the managed session; the host resolves it.
    this.host.cancelGoalVerification?.(sessionId)
  }

  /**
   * Verify the reported completion candidate. Returns the receipt AND the
   * server-validated evidence (normalized paths + server-computed digests) so
   * the caller can persist evidence that reflects what was actually checked,
   * not just what the agent claimed.
   */

  private async verifyCandidate(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    binding: GoalTurnBinding,
  ): Promise<{ receipt: GoalVerificationReceipt; evidence: GoalEvidence[] }> {
    const runtime = this.runtimeOf(managed)
    // Review r1 F2: arm the cancellation BEFORE the first await. The evidence
    // inspection below awaits real file IO; a pause/end/account switch landing
    // in that window calls cancelVerification, which reads
    // `runtime.verification.controller` — slot it BEFORE used to stay empty
    // until just before the query, so the cancellation was a no-op and the
    // paid no-tools query still went out (its verdict was then discarded by
    // the settle-side CAS). Arming at entry closes that window; the query
    // start re-checks the abort so a control transition that arrives during
    // inspection is honored before any query is addressed.
    const controller = new AbortController()
    const goalAtEntry = managed.goal
    runtime.verification = {
      controller,
      goalId: goalAtEntry?.id ?? binding.goalId,
      runGeneration: binding.runGeneration,
    }
    try {
      return await this.verifyCandidateInner(managed, binding, runtime, controller)
    } finally {
      if (runtime.verification?.controller === controller) runtime.verification = undefined
    }
  }

  private async verifyCandidateInner(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    binding: GoalTurnBinding,
    runtime: GoalRuntimeState,
    controller: AbortController,
  ): Promise<{ receipt: GoalVerificationReceipt; evidence: GoalEvidence[] }> {
    const goal = managed.goal
    if (!goal?.candidate) {
      return { receipt: { status: 'failed', criteria: [], error: 'no candidate recorded', verifiedAt: this.host.now() }, evidence: [] }
    }
    if (goal.id !== binding.goalId || goal.runGeneration !== binding.runGeneration) {
      return { receipt: { status: 'failed', criteria: [], error: 'goal generation changed during verification', verifiedAt: this.host.now() }, evidence: [] }
    }

    // ---- 1. Evidence validation (server-side, fail-closed)
    const messages = this.host.getSessionMessages(managed.id)
    const evidence: GoalEvidence[] = []
    /** The agent-claimed path per accepted evidence index (undefined for
     *  message evidence) — the post-verdict re-read goes through the same
     *  host resolution as the pre-query read. */
    const claimedFilePaths: Array<string | undefined> = []
    /** Fail-closed helper: the validated evidence collected so far rides along. */
    const reject = (
      error: string,
      extra: Partial<GoalVerificationReceipt> = {},
    ): { receipt: GoalVerificationReceipt; evidence: GoalEvidence[] } => ({
      receipt: { status: 'failed', criteria: [], error, verifiedAt: this.host.now(), ...extra },
      evidence,
    })
    // F-R2-2: resolve the REAL persisted text of every accepted supplement. A
    // supplement whose message is gone can no longer be judged — verifying
    // without it would silently drop a user requirement, so this fails closed.
    const supplementTexts: Array<{ messageId: string; text: string }> = []
    for (const supplementId of goal.supplementMessageIds) {
      const supplement = messages.find(m => m.id === supplementId)
      if (!supplement) {
        return reject(`accepted supplement message ${supplementId} is no longer persisted; refusing to verify without the user's actual requirement`)
      }
      supplementTexts.push({ messageId: supplement.id, text: supplement.content })
    }
    const materialParts: string[] = []
    let totalChars = 0
    for (let index = 0; index < goal.candidate.evidence.length; index++) {
      const item = goal.candidate.evidence[index]
      if (item.kind === 'file') {
        if (!item.path) {
          return reject(`evidence #${index}: file path missing`)
        }
        const inspected = await this.host.inspectEvidenceFile(managed.id, item.path)
        if (!inspected.ok) {
          return reject(`evidence #${index} (${item.path}): ${inspected.reason}`)
        }
        evidence.push({ kind: 'file', path: inspected.absolutePath, sha256: inspected.sha256, bytes: inspected.bytes, ...(item.note ? { note: item.note } : {}) })
        claimedFilePaths.push(item.path)
        const budget = Math.max(0, Math.min(GOAL_VERIFICATION_MAX_FILE_CHARS, GOAL_VERIFICATION_MAX_TOTAL_CHARS - totalChars))
        totalChars += Math.min(budget, inspected.excerpt.length)
        materialParts.push(`[evidence ${evidence.length - 1}] file ${inspected.absolutePath} (sha256 ${inspected.sha256.slice(0, 16)}…, ${inspected.bytes} bytes):\n${inspected.excerpt.slice(0, budget)}`)
        continue
      }
      if (!isValidMessageEvidence(messages, item.messageId, goal.producedMessageIds)) {
        return reject(`evidence #${index}: messageId ${item.messageId ?? '(missing)'} is not a persisted final assistant message produced by this goal`)
      }
      const message = messages.find(m => m.id === item.messageId)!
      evidence.push({ kind: 'message', messageId: item.messageId, ...(item.note ? { note: item.note } : {}) })
      claimedFilePaths.push(undefined)
      const excerpt = message.content.slice(0, Math.max(0, Math.min(GOAL_VERIFICATION_MAX_FILE_CHARS, GOAL_VERIFICATION_MAX_TOTAL_CHARS - totalChars)))
      totalChars += excerpt.length
      materialParts.push(`[evidence ${evidence.length - 1}] assistant message ${item.messageId}:\n${excerpt}`)
    }

    // ---- 2. Structural coverage: the agent must have judged every criterion
    // with in-range evidence. Coverage results from the verification answer are
    // re-checked below against the SAME rule.
    if (goal.criteria.length === 0) {
      return reject('goal has no criteria to verify')
    }

    // ---- 3. Independent no-tools verification query
    // Review r1 F2: the controller was armed at verifyCandidate ENTRY (before
    // the evidence IO). Re-check the abort here so a pause/end/account switch
    // that arrived during that IO is honored BEFORE the paid query starts —
    // the cancellation used to miss this whole window.
    if (controller.signal.aborted) {
      const abortReason = controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : typeof controller.signal.reason === 'string' && controller.signal.reason
          ? controller.signal.reason
          : 'cancelled'
      return {
        receipt: { status: 'failed', criteria: [], error: `verification was cancelled: ${abortReason}`, verifiedAt: this.host.now() },
        evidence,
      }
    }
    const deadline = setTimeout(() => controller.abort(new Error('verification timed out')), GOAL_VERIFICATION_TIMEOUT_MS)
    // ICR-2: the server's execution record is committed and handed to the
    // verifier as context; whatever is missing/truncated is stated explicitly
    // (and recorded on the receipt) instead of silently assumed complete.
    this.commitFacts(managed)
    const factsBlock = this.factsBlockFor({ ...managed, goal: managed.goal ?? goal })
    let result: LLMQueryResult
    try {
      result = await this.host.queryLlm(
        managed.id,
        {
          prompt: buildVerificationPrompt(goal, materialParts.join('\n\n'), evidence.length, supplementTexts, { text: factsBlock.text }),
          systemPrompt: 'You are a strict, independent completion verifier. Respond with ONLY the requested JSON object.',
          model: runtime.verificationModel,
          temperature: 0,
          outputSchema: GOAL_VERIFICATION_OUTPUT_SCHEMA,
        },
        { signal: controller.signal, isolation: 'no-tools' },
      )
    } catch (error) {
      return reject(`verification query failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // The runtime slot itself is released by the verifyCandidate wrapper's
      // finally — only its OWN controller's slot, never a later one's.
      clearTimeout(deadline)
    }
    if (controller.signal.aborted) {
      // Distinguish the real causes (attempt-8: a deadline abort surfaced as a
      // generic "cancelled", hiding the timeout from the receipt/pause detail).
      const abortReason = controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : typeof controller.signal.reason === 'string' && controller.signal.reason
          ? controller.signal.reason
          : 'cancelled'
      return reject(`verification was cancelled: ${abortReason}`, modelAttribution(result, runtime))
    }

    // FAIL-CLOSED on a non-success query (attempt-6 real counterexample): the
    // SDK independent query ended error_max_turns while salvaging partial
    // text; a parseable "passed" JSON inside that salvage was accepted and the
    // goal was persisted as completed. The verdict of an ABNORMAL query is
    // never a completion — a real not_satisfied verdict comes back with NO
    // warning and stays the distinct 'not_satisfied' outcome below.
    if (result.warning) {
      return reject(`verification query did not complete successfully: ${result.warning}`, {
        ...modelAttribution(result, runtime),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        warning: result.warning,
      })
    }

    const answer = parseVerificationAnswer(result.text)
    if (!answer) {
      return reject('verification answer was not the required JSON verdict', {
        ...modelAttribution(result, runtime),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
      })
    }

    const coverage = checkCriteriaCoverage(goal.criteria, answer.criteria, evidence.length)
    const passed = answer.overall === 'passed' && coverage.ok
    // ICR-4: the query can run for minutes — re-read every file evidence AFTER
    // the verdict and compare against the digest captured BEFORE it. A file
    // that changed or disappeared while the verifier ran can no longer back a
    // pass; the receipt records the real verification moment, and a stale
    // artifact is a non-pass, never a tolerated drift.
    let staleEvidence: string | undefined
    if (passed) {
      for (let index = 0; index < evidence.length; index++) {
        const item = evidence[index]
        if (item.kind !== 'file' || !item.path) continue
        // Re-inspect through the SAME host contract as the pre-query read: the
        // agent-claimed path, re-resolved by the host now. Feeding the already
        // resolved absolute path back in would bypass that resolution.
        const rechecked = await this.host.inspectEvidenceFile(managed.id, claimedFilePaths[index] ?? item.path)
        if (!rechecked.ok) {
          staleEvidence = `evidence file no longer readable at verdict time: ${item.path} (${rechecked.reason})`
          break
        }
        if (rechecked.sha256 !== item.sha256) {
          staleEvidence = `evidence file changed after the verification query started: ${item.path}`
          break
        }
      }
    }
    const effectivePassed = passed && !staleEvidence
    const criteriaResults: GoalCriterionResult[] = goal.criteria.map((criterion) => {
      const match = answer.criteria.find(c => c.criterion.trim().toLowerCase() === criterion.trim().toLowerCase())
      return {
        criterion,
        passed: effectivePassed && !!match?.passed && !coverage.missing.includes(criterion) && !coverage.unbacked.includes(criterion),
        evidenceIds: match?.evidenceIds ?? [],
        ...(match?.note ? { note: match.note } : {}),
        ...(!match ? { note: 'no verdict returned for this criterion' } : {}),
      }
    })
    const noteParts: string[] = []
    if (coverage.missing.length > 0) noteParts.push(`no verdict for: ${coverage.missing.join('; ')}`)
    if (coverage.unbacked.length > 0) noteParts.push(`verdicts without valid evidence: ${coverage.unbacked.join('; ')}`)
    if (staleEvidence) noteParts.push(staleEvidence)
    return {
      evidence,
      receipt: {
        status: effectivePassed ? 'passed' : 'not_satisfied',
        criteria: criteriaResults,
        ...modelAttribution(result, runtime),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
        ...(factsBlock.note ? { executionFactsNote: factsBlock.note } : {}),
        ...(noteParts.length > 0 ? { error: noteParts.join(' | ') } : {}),
        verifiedAt: this.host.now(),
      },
    }
  }

  /**
   * Terminal completion: history retention + projection clear + summary message.
   *
   * ICR-3 ordering: the terminal state (history + live-slot clear + projection)
   * is committed BEFORE any await, so a completion that stalls on its notice
   * can never be overtaken by a user pause/end or a new Goal — those see an
   * empty live slot and are rejected instead of being overwritten by this
   * older completion. A failing durable flush is reported honestly (the
   * completion stays in memory; the user is told it is not durably recorded).
   */
  private async completeGoal(
    managed: { id: string; goal?: GoalRecord; goalHistory?: GoalRecord[] },
  ): Promise<void> {
    const goal = managed.goal
    if (!goal) return
    const now = this.host.now()
    const completed = endGoalRecord(goal, 'completed', now)
    const summaryLines: string[] = []
    summaryLines.push(`Goal completed (${formatDuration(computeGoalElapsedMs(completed, now))}).`)
    summaryLines.push('')
    summaryLines.push(completed.candidate?.summary ?? '')
    if (completed.verification) {
      summaryLines.push('')
      summaryLines.push('Independent verification:')
      for (const criterion of completed.verification.criteria) {
        summaryLines.push(`- ${criterion.passed ? '✓' : '✗'} ${criterion.criterion}${criterion.note ? ` — ${criterion.note}` : ''}`)
      }
      const model = completed.verification.model ?? 'unknown'
      const usage = completed.verification.inputTokens !== undefined || completed.verification.outputTokens !== undefined
        ? ` (tokens: ${completed.verification.inputTokens ?? 'unknown'} in / ${completed.verification.outputTokens ?? 'unknown'} out)`
        : ' (usage unknown)'
      summaryLines.push(`Verified by ${model}${usage}.`)
      if (completed.verification.executionFactsNote) {
        summaryLines.push(`Note: ${completed.verification.executionFactsNote}.`)
      }
    }
    const files = (completed.candidate?.evidence ?? []).filter(e => e.kind === 'file' && e.path)
    if (files.length > 0) {
      summaryLines.push('')
      summaryLines.push('Artifacts:')
      for (const file of files) summaryLines.push(`- ${file.path}`)
    }
    // TERMINAL COMMIT FIRST — no await before this point.
    managed.goalHistory = [...(managed.goalHistory ?? []), completed]
    managed.goal = undefined
    this.host.persistSession(managed.id)
    this.publishProjection(managed)
    let flushed = true
    try {
      const messageId = await this.host.appendGoalMessage(managed.id, summaryLines.join('\n'))
      const withResult = { ...completed, resultMessageId: messageId }
      managed.goalHistory = (managed.goalHistory ?? []).map(entry => (entry.id === completed.id ? withResult : entry))
      this.host.persistSession(managed.id)
    } catch (error) {
      flushed = false
      this.host.error(`[goal] completion notice failed for ${managed.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await this.withFlushDeadline(managed.id)
    } catch (error) {
      flushed = false
      this.host.error(`[goal] completion flush failed for ${managed.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!flushed) {
      this.host.notifyStorageFailure(managed.id, `Goal ${completed.id} completed, but its completion could not be written to disk. The completion is kept in memory; the durable record may still show the goal as running.`)
    }
  }

  // ----------------------------------------------------------
  // Turn completion → continuation decision
  // ----------------------------------------------------------

  /**
   * Called from onProcessingStopped when a Goal turn ended normally
   * (reason 'complete'). Decides whether the Goal continues.
   * Returns the action taken so the caller can log it.
   */
  async onTurnComplete(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    binding: GoalTurnBinding | undefined,
    context: { hasPendingHandoff: boolean; queuedMessages: number },
  ): Promise<'continue' | 'paused_no_progress' | 'paused_handoff' | 'noop'> {
    const goal = managed.goal
    if (!goal || !binding) return 'noop'
    if (isGoalTerminal(goal.status)) return 'noop'
    // A candidate round (verification ran) already decided its own next step.
    if (goal.status === 'verifying') return 'noop'
    // A pending handoff owns the next step: the goal is WAITING on the user
    // (question/authorization), so the clock stops NOW — the walk-away time is
    // never charged. The handoff's own resolution path (answer/approval)
    // resumes execution; free-form chat does not.
    if (context.hasPendingHandoff) {
      await this.pause(
        managed,
        'awaiting_permission',
        'Waiting for you to answer a question or grant a permission. The clock is paused while you are away.',
      )
      return 'paused_handoff'
    }
    // Queued user messages replay first and will bind as supplements.
    if (context.queuedMessages > 0) return 'noop'
    // Paused (clarification / stop / error / no_progress) and terminal Goals
    // never self-resume — resumption is always an explicit user or system act.
    if (!isGoalRunning(goal.status)) return 'noop'

    const runtime = this.runtimeOf(managed)
    // ICR-2: a normally-completed turn is a real execution boundary.
    this.recordFact(managed, { kind: 'turn_ended', runGeneration: binding.runGeneration, detail: 'complete' })
    this.commitFacts(managed)
    this.markLastTurnIncomplete(managed, undefined)
    if (!runtime.progressedThisRound) {
      runtime.noProgressRounds += 1
    }
    if (runtime.noProgressRounds >= GOAL_MAX_NO_PROGRESS_ROUNDS) {
      runtime.noProgressRounds = 0
      const detail = 'Three consecutive rounds produced no progress report. The goal is paused to avoid running without direction; resume explicitly to continue.'
      await this.pause(managed, 'no_progress', detail)
      await this.host.appendGoalMessage(managed.id, `Goal paused: ${detail}`)
      return 'paused_no_progress'
    }
    await this.continueGoal(managed)
    return 'continue'
  }

  /**
   * Called from onProcessingStopped for every NON-complete turn end (error /
   * timeout / interrupt). A goal whose turn died with nobody driving it must
   * not keep its clock running: a pending handoff pauses awaiting_permission;
   * anything else pauses with the real failure reason. An already-paused goal
   * keeps its FIRST attribution (Stop already claimed 'stop' — pause() never
   * re-attributes).
   */
  async onTurnAborted(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    binding: GoalTurnBinding | undefined,
    context: { handoff: boolean },
  ): Promise<'paused' | 'noop'> {
    const goal = managed.goal
    if (!goal || !binding) return 'noop'
    if (goal.id !== binding.goalId) return 'noop'
    if (isGoalTerminal(goal.status)) return 'noop'
    if (!isGoalRunning(goal.status)) return 'noop'
    // ICR-2: an abnormally-ended turn means its record is INCOMPLETE by
    // construction — recorded explicitly, never left to read as a full round.
    this.recordFact(managed, { kind: 'turn_ended', runGeneration: binding.runGeneration, detail: context.handoff ? 'interrupted (waiting for permission/question)' : 'interrupted (error/timeout/stop)' })
    this.commitFacts(managed)
    this.markLastTurnIncomplete(managed, context.handoff ? 'waiting for a permission/question' : 'interrupted (error, timeout, or stop)')
    if (context.handoff) {
      await this.pause(
        managed,
        'awaiting_permission',
        'Waiting for you to answer a question or grant a permission. The clock is paused while you are away.',
      )
      return 'paused'
    }
    await this.pause(
      managed,
      'error',
      'The turn ended unexpectedly (error, timeout, or interruption). The goal is paused; resume explicitly to continue.',
    )
    return 'paused'
  }

  /**
   * The internal continuation: ONE production send path call, marked internal.
   * The prompt is a new, clearly-framed internal continuation message — never a
   * fabricated user reply and never a duplicate of an existing user message.
   * `source` states WHO scheduled this turn ('automatic' = the server decided
   * the goal needs another round after a completed turn without a candidate;
   * 'manual-resume' = the user's explicit goalResume). The host logs it at the
   * REAL scheduling point so a runtime observer can prove an automatic
   * continuation happened without counting message words or generations.
   */
  async continueGoal(
    managed: { id: string; goal?: GoalRecord },
    source: 'automatic' | 'manual-resume' = 'automatic',
  ): Promise<void> {
    const goal = managed.goal
    if (!goal || !isGoalRunning(goal.status)) return
    if (!this.host.canStartTurn(managed.id)) {
      this.host.warn(`[goal] continuation skipped for ${goal.id}: session is busy`)
      return
    }
    const messages = this.host.getSessionMessages(managed.id)
    const supplements = goal.supplementMessageIds
      .map(id => messages.find(m => m.id === id))
      .filter((m): m is { id: string; role: string; isIntermediate?: boolean; content: string; timestamp: number } => !!m)
      .map(m => m.content)
    // F-R2-4: expose only the messages THIS goal produced, with a bounded
    // excerpt, so a text deliverable is citable as message evidence.
    const producedMessages = (goal.producedMessageIds ?? [])
      .map(id => messages.find(m => m.id === id))
      .filter((m): m is { id: string; role: string; isIntermediate?: boolean; content: string; timestamp: number } => !!m)
      .map(m => ({ messageId: m.id, excerpt: m.content.slice(0, GOAL_CONTINUATION_PRODUCED_EXCERPT_CHARS) }))
    await this.host.sendInternalContinuation(managed.id, buildGoalContinuationPrompt(goal, supplements, producedMessages), {
      source,
      goalId: goal.id,
      runGeneration: goal.runGeneration,
    })
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // ICR-2: server-captured execution facts
  // ----------------------------------------------------------

  /**
   * Record ONE host fact from a real runtime event. There is no agent- or
   * client-reachable path that writes here: the callers are the server's own
   * event loop, turn-boundary and lifecycle hooks. Facts accumulate in a
   * bounded runtime scratch and are COMMITTED onto the persisted record at the
   * existing persistence points (report application, verification), so a tool
   * call never triggers a durable write of its own.
   *
   * Bounding policy (C4): the record keeps the FIRST GOAL_EXECUTION_FACTS_LIMIT
   * facts in capture order and counts every further one as dropped. Hitting the
   * cap flips the record to explicitly truncated — it never silently rewrites
   * or hides the gap.
   *
   * Returns the stored fact (with its seq) or `{ dropped: true }` when the cap
   * refused it — the pairing index needs to KNOW the observation happened even
   * though the fact could not be stored, so the reference stays explicitly
   * missing instead of silently vanishing.
   */
  private recordFact(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    fact: Omit<GoalExecutionFact, 'seq' | 'at' | 'runGeneration'> & { at?: number; runGeneration?: number },
  ): { seq: number; fact: GoalExecutionFact } | { dropped: true } {
    const goal = managed.goal
    if (!goal) return { dropped: true }
    const runtime = this.runtimeOf(managed)
    const committed = goal.executionFacts?.facts.length ?? 0
    const lastSeq = Math.max(
      committed > 0 ? goal.executionFacts!.facts[committed - 1]!.seq : 0,
      runtime.factScratch.length > 0 ? runtime.factScratch[runtime.factScratch.length - 1]!.seq : 0,
    )
    if (committed + runtime.factScratch.length >= GOAL_EXECUTION_FACTS_LIMIT) {
      runtime.factScratchTruncated = true
      runtime.factScratchDropped += 1
      return { dropped: true }
    }
    const { runGeneration, at, ...rest } = fact
    const stored: GoalExecutionFact = {
      seq: lastSeq + 1,
      at: at ?? this.host.now(),
      runGeneration: runGeneration ?? goal.runGeneration,
      ...rest,
    }
    runtime.factScratch.push(stored)
    return { seq: stored.seq, fact: stored }
  }

  /**
   * Plan r2 A.2: update ONE stored fact in place (by seq) — the merge target
   * may already be COMMITTED (a result arriving after a mid-turn report
   * application) or still in the runtime scratch. Facts are context, not
   * authority: the merge NEVER bumps the goal version and never touches the
   * CAS-bearing fields, exactly like commitFacts.
   */
  private upsertFactFields(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
    seq: number,
    update: (fact: GoalExecutionFact) => GoalExecutionFact,
  ): void {
    const goal = managed.goal
    if (!goal) return
    const runtime = this.runtimeOf(managed)
    const scratchIndex = runtime.factScratch.findIndex(f => f.seq === seq)
    if (scratchIndex >= 0) {
      runtime.factScratch = runtime.factScratch.map((f, i) => (i === scratchIndex ? update(f) : f))
      return
    }
    const committed = goal.executionFacts
    if (committed?.facts.some(f => f.seq === seq)) {
      managed.goal = {
        ...goal,
        executionFacts: { ...committed, facts: committed.facts.map(f => (f.seq === seq ? update(f) : f)) },
        updatedAt: this.host.now(),
      }
    }
  }

  /**
   * Commit the runtime fact scratch onto the persisted record. Facts are
   * context, not authority: NO version bump (a bump would invalidate an
   * in-flight verification snapshot and break the CAS contract), and no
   * projection publication — the committing caller persists/publishes as part
   * of its own transition.
   */
  private commitFacts(
    managed: { id: string; goal?: GoalRecord; goalRuntime?: GoalRuntimeState },
  ): void {
    const goal = managed.goal
    if (!goal) return
    const runtime = this.runtimeOf(managed)
    if (runtime.factScratch.length === 0 && !runtime.factScratchTruncated) return
    const committed = goal.executionFacts
    const requested = (committed?.facts.length ?? 0) + runtime.factScratch.length
    const facts = [...(committed?.facts ?? []), ...runtime.factScratch].slice(0, GOAL_EXECUTION_FACTS_LIMIT)
    const dropped = (committed?.droppedCount ?? 0) + runtime.factScratchDropped
    const truncated = (committed?.truncated ?? false) || runtime.factScratchTruncated || facts.length < requested
    managed.goal = {
      ...goal,
      executionFacts: {
        facts,
        truncated,
        ...(dropped > 0 ? { droppedCount: dropped } : {}),
        ...(committed?.lastTurnIncomplete ? { lastTurnIncomplete: committed.lastTurnIncomplete } : {}),
      },
      updatedAt: this.host.now(),
    }
    runtime.factScratch = []
    runtime.factScratchTruncated = false
    runtime.factScratchDropped = 0
  }

  /** Record (on the persisted record) that the latest turn did/did not end normally. */
  private markLastTurnIncomplete(
    managed: { id: string; goal?: GoalRecord },
    reason: string | undefined,
  ): void {
    const goal = managed.goal
    if (!goal) return
    const base: GoalExecutionFacts = goal.executionFacts ?? { facts: [], truncated: false }
    const next: GoalExecutionFacts = { ...base }
    if (reason === undefined) delete next.lastTurnIncomplete
    else next.lastTurnIncomplete = reason
    managed.goal = { ...goal, executionFacts: next, updatedAt: this.host.now() }
  }

  /**
   * Public read-only accessor for the bounded facts block — used by the
   * verification prompt builder and by the maintenance tests.
   */
  factsBlockFor(managed: { goal?: GoalRecord; goalRuntime?: GoalRuntimeState }): { text: string; note?: string } {
    return this.buildFactsBlock(managed.goal, managed.goalRuntime)
  }

  /**
   * The bounded facts block handed to the verification prompt as CONTEXT.
   * Deliberately NOT numbered as evidence: candidate evidence keeps the only
   * index space the verifier may cite, so a host fact can never be laundered
   * into a candidate "evidence slot".
   *
   * Plan r2 A.4: the block — header, EVERY retained entry and the notes — fits
   * GOAL_FACTS_PROMPT_CHARS. The old renderer spent the budget head-first and
   * silently dropped whole entries past it (the real attempt-13 run lost the
   * third round exactly that way). Now degradation is uniform and progressive:
   * rich fields first, then result fields, then a bare identity line per entry —
   * an entry is never dropped, and a shortened field says so in its own text
   * (distinguishable from an entry the record never kept).
   */
  private buildFactsBlock(record: GoalRecord | undefined, runtime?: GoalRuntimeState): { text: string; note?: string } {
    const facts = record?.executionFacts
    if (!facts || facts.facts.length === 0) {
      return {
        text: 'Server execution record: EMPTY. No server-recorded execution facts exist for this goal. A criterion that depends on a process step (research, running a command, an intermediate write) MUST be judged passed=false: only its final artifact can be judged.',
        note: 'no server-recorded execution facts',
      }
    }
    const notes: string[] = []
    if (facts.truncated) {
      notes.push(`the server record is TRUNCATED (${facts.droppedCount ?? 'unknown count'} captured facts were dropped at the record cap)`)
    }
    if (facts.lastTurnIncomplete) {
      notes.push(`the most recent turn did NOT end normally (${facts.lastTurnIncomplete}) — its record is incomplete`)
    }
    const lostRefs = runtime?.pairingLosses ?? []
    if (lostRefs.length > 0) {
      notes.push(`tool calls observed but not storable at the record cap (no fact, no proof either way): ${lostRefs.join(', ')}`)
    }
    const header = 'Server-recorded execution facts (CONTEXT ONLY — not candidate evidence; do NOT cite them by evidence index. They prove which steps the server actually observed):'
    // Progressive degradation ladder: (param cap, result cap, compact). The
    // first level that fits the prompt budget wins; the final level keeps every
    // entry's identity line AND the salient parameter (the path / command an
    // operation targeted) — an entry is never dropped, and a shortened field
    // says so in its own text. The 4th element degrades the controller's own
    // detail field WITH the ladder (review F2: a fixed detail cap kept a full
    // record of worst-case legal fields over the block budget).
    const ladder: Array<[number, number, boolean, number]> = [[200, 200, false, 120], [120, 60, false, 80], [80, 0, false, 48], [48, 0, true, 0]]
    const lossNotes = notes.length > 0
      ? `RECORD INCOMPLETE: ${notes.join('; ')}. A criterion that depends on an unrecorded or truncated process step MUST NOT be judged passed on the candidate's claim alone.`
      : ''
    const compose = (level: number): string => {
      const [paramCap, resultCap, compact, detailCap] = ladder[level]!
      const lines = facts.facts.map(f => renderFactLine(f, paramCap, resultCap, compact, detailCap))
      const budgetLine = level >= 1
        ? 'NOTE: parameter and result fields above were shortened (with unknown remainders) to fit the prompt budget; the stored record keeps what it captured.'
        : ''
      return [header, ...lines, ...(budgetLine ? [budgetLine] : []), ...(lossNotes ? [lossNotes] : [])].join('\n')
    }
    let level = 0
    let text = compose(level)
    while (text.length > GOAL_FACTS_PROMPT_CHARS && level < ladder.length - 1) {
      level += 1
      text = compose(level)
    }
    let skeletonNote: string | undefined
    if (text.length > GOAL_FACTS_PROMPT_CHARS) {
      // Review F2: the ladder shrinks fields per entry, but a full 40-entry
      // record of worst-case LEGAL fields can still exceed the block budget
      // (the reviewer measured 13141 chars at the old final level). The final
      // skeleton gives every entry an EQUAL slice of whatever budget remains:
      // identity heads are never cut, shown fields are bounded excerpts that
      // say so, and the block is hard-bounded by construction. True record
      // truncation keeps its separate RECORD INCOMPLETE line either way.
      text = composeBoundedSkeleton(facts.facts, header, lossNotes)
      skeletonNote = 'the block was reduced to bounded per-entry skeletons to fit the prompt budget'
    }
    const note = [
      ...notes,
      ...(level >= 1 ? ['parameter and result fields were shortened to fit the prompt budget'] : []),
      ...(skeletonNote ? [skeletonNote] : []),
    ].join('; ')
    return { text, note: note || undefined }
  }

  private async withFlushDeadline(sessionId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`goal pause flush exceeded ${GOAL_FLUSH_DEADLINE_MS}ms deadline`)), GOAL_FLUSH_DEADLINE_MS)
    })
    try {
      await Promise.race([this.host.flushSession(sessionId), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

// ============================================================
// Small helpers
// ============================================================

/**
 * Canonicalize a candidate-evidence path before the permission fence sees it.
 * The real model cites the artifacts it just wrote as workspace-relative paths
 * (`docs/notes.md`), and the tool schema allows that form — but the fence (the
 * same validateFilePath every tool read goes through) requires absolute paths,
 * so a bare relative path failed verification on path FORM rather than on file
 * content (observed in attempt-3). Workspace-relative inputs are resolved
 * against the session's workspace root and then face the SAME fence; absolute
 * and `~`-rooted paths pass through untouched (`~` expansion stays the fence's
 * job — it knows the real home directory).
 */
export function resolveEvidenceInputPath(rawPath: string, workspaceRootPath: string): string {
  if (!rawPath.trim()) return rawPath
  if (rawPath.startsWith('~')) return rawPath
  return resolve(workspaceRootPath, rawPath)
}

/**
 * The directory relative evidence paths resolve against: the session's
 * EFFECTIVE working directory when one is set (the directory the agent's file
 * tools actually operate in — it can differ from the workspace root), else the
 * workspace root. The permission fence is unchanged either way — a
 * workingDirectory outside the fence simply fails closed.
 */
export function resolveEvidenceBase(managed: { workingDirectory?: string; workspace: { rootPath: string } }): string {
  return managed.workingDirectory?.trim() || managed.workspace.rootPath
}

/**
 * Canonicalize a tool name for same-turn start/result matching. MCP tools
 * surface under their fully-qualified name (`mcp__<server>__<tool>` — observed
 * verbatim in the first real-model run as `mcp__session__goal_update`), so the
 * server qualifier is stripped to the bare tool name; a name without the
 * prefix is returned as-is.
 */
function normalizeToolName(name: string): string {
  const trimmed = name.trim().toLowerCase()
  if (trimmed.startsWith('mcp__')) {
    const parts = trimmed.split('__')
    return parts[parts.length - 1] || trimmed
  }
  return trimmed
}

/**
 * Lossless single-line encoding for a fact field (review F1): shell-significant
 * whitespace is preserved through a traceable escape instead of being collapsed,
 * so `ls\nrm file` never renders as the read-only-looking `ls rm file`, a CRLF
 * break is not mistaken for a space, and `printf '%s' 'a  b'` keeps its inner
 * double space. The escape is idempotent (an already-encoded string re-encodes
 * to itself), so storage-side and render-side callers can both apply it without
 * distorting each other. Collapsing here was the review's F1 finding: the fold
 * destroyed the one boundary that separates a destructive command from a
 * read-only one.
 */
function encodeFactWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\\r\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/**
 * Bounded summary for an execution-fact field (C4): parameter and result
 * summaries are clipped INDEPENDENTLY so one huge Write payload cannot crowd
 * the rest of the record out, and every clip is announced in the text itself —
 * never a silent cut. Whitespace is NOT collapsed (review F1): the command's
 * shell semantics survive the summary (see encodeFactWhitespace). (The prompt
 * RENDER adds its own unknown-remainder clause — see renderClip.)
 */
function clipFactText(text: string, cap: number): string {
  const singleLine = encodeFactWhitespace(text.trim())
  if (singleLine.length <= cap) return singleLine
  return `${singleLine.slice(0, cap)}… [truncated: ${singleLine.length} chars total]`
}

/**
 * Render-side clip: the same honesty contract as clipFactText with a compact
 * marker, so a shortened field announces both that it was cut and that the
 * remainder is unknown — a clipped command or path is never passed off as the
 * complete thing it was cut from (Plan r2 A.4). Also encodes whitespace, a
 * no-op for records stored through clipFactText and the guard that keeps LEGACY
 * records (stored before that encoding) from folding a command's line
 * boundaries away at render time.
 */
/** The compact cut marker: announces BOTH that the field was shortened and
 *  that the remainder is unknown (Plan r2 A.4 / review F1). */
const GOAL_FACT_UNKNOWN_TAIL = '… [truncated, unknown remainder]'

function renderClip(text: string, cap: number): string {
  const singleLine = encodeFactWhitespace(text.trim())
  if (singleLine.length <= cap) return singleLine
  return `${singleLine.slice(0, Math.max(0, cap))}${GOAL_FACT_UNKNOWN_TAIL}`
}

/**
 * An excerpt of `text` that is at most `budget` chars INCLUDING its cut marker,
 * so a bounded field can never silently grow past the slice it was given
 * (review F2 — the marker cost is part of the budget, not on top of it).
 */
function excerptWithin(text: string, budget: number): string {
  const encoded = encodeFactWhitespace(text.trim())
  if (encoded.length <= budget) return encoded
  const keep = Math.max(0, budget - GOAL_FACT_UNKNOWN_TAIL.length)
  return `${encoded.slice(0, keep)}${GOAL_FACT_UNKNOWN_TAIL}`
}

/** How much of the block budget is set aside for the "entries not shown"
 *  declaration in skeleton mode — reserved up front so appending it can never
 *  push the composed block back over budget. */
const GOAL_FACT_SKELETON_RESERVE_CHARS = 260

/** The most of a NON-tool_call fact's own detail an identity head renders
 *  (review F2b) — marker included. Identity (seq/kind) is never cut; this
 *  bounds only the free-text detail the controller stored as-given, so one
 *  multi-KB resume-flush error cannot break the whole-block budget. */
const GOAL_FACT_HEAD_DETAIL_CHARS = 120

/** The largest a bounded RECORD INCOMPLETE line may render in skeleton mode
 *  (a pairing-loss list is runtime-sized; the note must not eat the block). */
const GOAL_FACT_LOSSNOTES_MAX_CHARS = 800

/**
 * One bounded skeleton line (review F2): the identity head is never cut, and
 * whatever budget the line has left is spent on the fields in priority order —
 * the salient parameter first (the path / command the operation targeted),
 * then the result, then the controller detail. Every shown excerpt is bounded
 * (marker cost inside its slice) and a field that cannot say anything honest
 * within its share is omitted rather than rendered as noise.
 */
function skeletonLine(fact: GoalExecutionFact, budget: number): string {
  const head = `- ${renderFactHead(fact)}`
  if (fact.kind !== 'tool_call' || budget <= head.length) return head
  let left = budget - head.length
  const parts: string[] = []
  const addField = (label: string, text: string, share: number): void => {
    // Cost of " <label>: " — the leading space, or " | " when a field is
    // already present — plus the excerpt, all inside what is left.
    const cost = (parts.length > 0 ? 3 : 1) + label.length + 2
    const want = Math.floor(Math.max(0, left - cost) * share)
    if (want < GOAL_FACT_UNKNOWN_TAIL.length + 8) return
    const excerpt = excerptWithin(text, want)
    parts.push(`${label}: ${excerpt}`)
    left -= cost + excerpt.length
  }
  if (fact.paramSummary) addField('params', paramIdentity(fact.paramSummary), 0.6)
  if (fact.resultSummary) addField('result', fact.resultSummary, 0.8)
  if (fact.detail) addField('detail', fact.detail, 1)
  return parts.length > 0 ? `${head} ${parts.join(' | ')}` : head
}

/**
 * The final bounded skeleton (review F2): every entry gets an equal slice of
 * whatever block budget remains after the fixed lines. An entry is never
 * dropped silently — if even the identity heads cannot fit (unreachable at the
 * 40-fact record cap, but the function must be total), the entries that could
 * not be shown are NAMED and declared unrecorded in a fail-closed note, never
 * quietly truncated at a line boundary.
 */
function composeBoundedSkeleton(facts: GoalExecutionFact[], header: string, lossNotes: string): string {
  const noteLine = 'NOTE: the record exceeds the prompt budget; every entry keeps its identity line and each shown field is a bounded excerpt whose remainder is unknown — the stored record keeps what it captured.'
  const boundedLoss = lossNotes ? excerptWithin(lossNotes, GOAL_FACT_LOSSNOTES_MAX_CHARS) : ''
  const fixedChars = header.length + noteLine.length + GOAL_FACT_SKELETON_RESERVE_CHARS + 2
    + (boundedLoss ? boundedLoss.length + 1 : 0)
  const perLine = Math.max(0, Math.floor((GOAL_FACTS_PROMPT_CHARS - fixedChars) / facts.length))
  const lines: string[] = []
  let used = fixedChars
  let unshownFrom: number | undefined
  for (const fact of facts) {
    const line = skeletonLine(fact, perLine)
    // Review F2b: NO unconditional first-line push — the accounting is honest
    // from the first entry on. A head can still exceed its own per-line share
    // (identity is never cut), so the cumulative check is what actually holds
    // the promise: entries that no longer fit are NAMED in the fail-closed
    // RECORD INCOMPLETE line instead of silently pushing the block over budget.
    if (used + line.length + 1 > GOAL_FACTS_PROMPT_CHARS - GOAL_FACT_SKELETON_RESERVE_CHARS) {
      unshownFrom = fact.seq
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  const unshownNote = unshownFrom !== undefined
    ? `RECORD INCOMPLETE: entries from #${unshownFrom} on could not be shown within the prompt budget; treat them as unrecorded (they remain in the stored record).`
    : ''
  return [
    header,
    ...lines,
    noteLine,
    ...(boundedLoss ? [boundedLoss] : []),
    ...(unshownNote ? [unshownNote] : []),
  ].join('\n')
}

/**
 * The salient argument of a stored parameter summary, used ONLY when a param
 * field must be shortened for the prompt budget: a raw-JSON summary (older
 * records) yields the path / command / pattern it names, so the operation's
 * target survives even a very tight budget. Anything else is returned as-is.
 */
function paramIdentity(param: string): string {
  const m = param.match(/"(?:file_path|path|command|pattern|url|query)"\s*:\s*"([^"]{1,200})"/)
  return m?.[1] ?? param
}

function renderParamField(param: string, cap: number, compact: boolean): string {
  if (cap <= 0) return 'params omitted for prompt budget'
  // Measure the param as it will actually render (whitespace-preserving, review
  // F1) — collapsing it here would under-count double-spaced commands and make
  // the "fits" branch hand an over-cap string to the renderer.
  if (param.trim().length <= cap) return renderClip(param, cap)
  // Clipping a raw-JSON parameter summary would keep its boilerplate and cut
  // the one thing that matters (the path / command it names), so the salient
  // argument is surfaced instead. The remainder is announced as unknown either
  // way — never silently discarded.
  const identity = paramIdentity(param)
  if (identity && identity !== param) {
    const identityText = renderClip(identity, cap)
    return compact ? identityText : `${identityText} (other parameter text omitted for prompt budget)`
  }
  return renderClip(param, cap)
}

/**
 * The identity head of one fact line (review F2): seq, tool and outcome — the
 * minimum a verifier needs to know WHICH operation ran. NEVER cut in any
 * budget mode: a whole entry is never dropped from the block, and its identity
 * is never flattened into an omitted-fields placeholder.
 */
/**
 * The identity head of one fact line (review F2): seq, tool and outcome — the
 * minimum a verifier needs to know WHICH operation ran. NEVER cut in any
 * budget mode: a whole entry is never dropped from the block, and its identity
 * is never flattened into an omitted-fields placeholder.
 */
function renderFactHead(fact: GoalExecutionFact): string {
  const scope = fact.parentToolUseId ? ' (sub-agent task)' : ''
  if (fact.kind === 'tool_call') {
    const outcome = fact.isError === true ? ' [ERRORED]' : fact.isError === undefined ? ' [awaiting result]' : ''
    // A fully-qualified MCP tool name can be very long; it is bounded on its
    // own so one name cannot eat the line budget (the unknown remainder is
    // announced — a truncated name is not an operation proof either way).
    return `#${fact.seq} tool ${fact.toolName ? renderClip(fact.toolName, 48) : 'unknown tool'}${scope}${outcome}`
  }
  // Review F2b: the controller's own detail on a NON-tool event (turn
  // started/ended, paused, resumed, …) is stored as-given — the resume-flush
  // failure path stores the raw error message, and a multi-KB legal error is
  // enough to break the whole-block budget if the head embeds it raw. The
  // detail's salient prefix stays (WHICH error/kind it was), the remainder is
  // announced unknown — in every render mode, because the head is shared.
  const boundedDetail = fact.detail ? `, ${excerptWithin(fact.detail, GOAL_FACT_HEAD_DETAIL_CHARS)}` : ''
  if (fact.kind === 'turn_started') {
    return `#${fact.seq} turn started (run ${fact.runGeneration}${boundedDetail})`
  }
  if (fact.kind === 'turn_ended') {
    const endedDetail = fact.detail ? ` (${excerptWithin(fact.detail, GOAL_FACT_HEAD_DETAIL_CHARS)})` : ''
    return `#${fact.seq} turn ended${endedDetail}`
  }
  const otherDetail = fact.detail ? ` (${excerptWithin(fact.detail, GOAL_FACT_HEAD_DETAIL_CHARS)})` : ''
  return `#${fact.seq} ${fact.kind}${otherDetail}`
}

/** One prompt line for one retained fact (Plan r2 A.4). */
function renderFactLine(fact: GoalExecutionFact, paramCap: number, resultCap: number, compact = false, detailCap = 120): string {
  const head = renderFactHead(fact)
  const fields: string[] = []
  if (fact.kind === 'tool_call') {
    if (fact.paramSummary) {
      fields.push(paramCap > 0 ? `params: ${renderParamField(fact.paramSummary, paramCap, compact)}` : 'params omitted for prompt budget')
    }
    if (fact.resultSummary) {
      fields.push(resultCap > 0 ? `result: ${renderClip(fact.resultSummary, resultCap)}` : 'result omitted for prompt budget')
    }
    // The controller's own detail (pairing losses, unknown pairings) degrades
    // WITH the ladder too (review F2) — a fixed 120-char detail would keep a
    // full record of worst-case legal fields over the prompt budget.
    if (fact.detail) {
      fields.push(detailCap > 0 ? `detail: ${renderClip(fact.detail, detailCap)}` : 'detail omitted for prompt budget')
    }
  }
  return fields.length > 0 ? `- ${head} ${fields.join(' | ')}` : `- ${head}`
}

// ------------------------------------------------------------
// Plan r2 A.3 — minimal known-pattern secret scrub for fact copies.
//
// There is NO reusable free-text redactor in this codebase (technical-review
// finding BF1), so this is deliberately the smallest honest thing: it covers
// KNOWN secret shapes only — credential-named fields, Bearer/Basic scheme
// credentials, Authorization/Cookie headers, sensitive URL query parameters and
// well-known token prefixes — and claims nothing about arbitrary secrets.
// Normal identifiers and file hashes pass through untouched. Only the FACT COPY
// is scrubbed: the raw wire/args keep feeding stage/parse/equality, stored
// messages are never rewritten, and the copy is clipped only AFTER scrubbing so
// a cut boundary cannot leave half a secret behind.
// ------------------------------------------------------------

const GOAL_REDACTED = '[REDACTED]'

/** Well-known token shapes (OpenAI/Anthropic/GitHub/AWS/Slack prefixes). */
const GOAL_SECRET_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9-]{8,})/g
/** Scheme credentials keep the scheme visible and drop the credential. */
const GOAL_SECRET_BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi
/** Auth/cookie headers: the header name (and scheme) stays, the value goes. */
const GOAL_SECRET_HEADER_RE = /\b((?:Proxy-)?Authorization|Cookie|Set-Cookie)\s*:\s*(Bearer\s+|Basic\s+|Token\s+)?[^\s"',;]+/gi
/** Sensitive URL query parameters (`?token=…&sig=…`). */
const GOAL_SECRET_URL_RE = /([?&](?:key|token|secret|password|access[-_]?token|api[-_]?key|apikey|sig(?:nature)?|auth|credential)=)[^&\s"']+/gi
/**
 * Credential-named fields in JSON / shell / query form (`api_key: "…"`).
 * `Authorization`/`Cookie` headers are deliberately NOT here — the dedicated
 * header pass above owns them and keeps the auth scheme visible.
 */
const GOAL_SECRET_FIELD_RE = /\b([A-Za-z0-9_.-]*(?:api[-_]?key|apikey|access[-_]?key|secret|password|passwd|pwd|token|credential)[A-Za-z0-9_.-]*|key)\s*(:|=)\s*("[^"]*"|'[^']*'|[^\s,;&)"']+)/gi

/**
 * Redact the KNOWN secret shapes in a fact copy (Plan r2 A.3). Applied before
 * any clipping. Deliberately conservative: it may over-redact a value whose
 * field merely looks credential-named, and it cannot recognize unknown secret
 * formats — it is a best-effort hygiene pass, not a guarantee.
 */
export function scrubGoalFactSecrets(text: string): string {
  let out = text
  // Scheme credentials FIRST, so the scheme word survives the later passes.
  out = out.replace(GOAL_SECRET_BEARER_RE, (_m, scheme: string) => `${scheme} ${GOAL_REDACTED}`)
  out = out.replace(GOAL_SECRET_TOKEN_RE, GOAL_REDACTED)
  out = out.replace(GOAL_SECRET_HEADER_RE, (_m, header: string, scheme: string | undefined) => `${header}: ${scheme ?? ''}${GOAL_REDACTED}`)
  out = out.replace(GOAL_SECRET_URL_RE, (_m, lead: string) => `${lead}${GOAL_REDACTED}`)
  out = out.replace(GOAL_SECRET_FIELD_RE, (match, field: string, sep: string, value: string) =>
    value === GOAL_REDACTED ? match : `${field}${sep}${GOAL_REDACTED}`)
  return out
}

/**
 * Semantic parameter summary for an execution fact, extracted from the REAL
 * tool input BEFORE any clipping (Plan r2 A.3): a Write/Edit records the path
 * and the payload SIZE (never the body), a Read/Glob/Grep records what it
 * targeted, a Bash keeps the whole command (clipped honestly when long — a
 * clipped command is never passed off as complete), and a goal_update records
 * the report kind/note/todo count instead of echoing the whole report. The
 * result is scrubbed, then bounded to GOAL_FACT_PARAM_CHARS.
 */
export function summarizeGoalFactInput(toolName: string, input: unknown): string {
  const normalized = normalizeToolName(toolName)
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  let semantic: string
  if (normalized === 'write' || normalized === 'edit') {
    const path = typeof obj.file_path === 'string' ? obj.file_path : typeof obj.path === 'string' ? obj.path : undefined
    const body = typeof obj.content === 'string' ? obj.content : typeof obj.new_string === 'string' ? obj.new_string : undefined
    semantic = `${normalized === 'write' ? 'write file' : 'edit file'} ${path ?? '<unknown path>'}${body !== undefined ? ` (content ${body.length} chars)` : ''}`
  } else if (normalized === 'bash') {
    semantic = `run command: ${typeof obj.command === 'string' ? obj.command : '<unknown command>'}`
  } else if (normalized === 'read') {
    const path = typeof obj.file_path === 'string' ? obj.file_path : undefined
    const offset = typeof obj.offset === 'number' ? ` from line ${obj.offset}` : ''
    const limit = typeof obj.limit === 'number' ? ` (limit ${obj.limit})` : ''
    semantic = `read file ${path ?? '<unknown path>'}${offset}${limit}`
  } else if (normalized === 'goal_update') {
    const kind = typeof obj.kind === 'string' ? obj.kind : '<unknown kind>'
    const note = typeof obj.note === 'string' ? obj.note : undefined
    const todos = Array.isArray(obj.todos) ? obj.todos.length : 0
    semantic = `report ${kind}${note ? `: ${note}` : ''} (todos in report: ${todos})`
  } else {
    semantic = typeof input === 'string' ? input : JSON.stringify(input ?? {})
  }
  return clipFactText(scrubGoalFactSecrets(semantic), GOAL_FACT_PARAM_CHARS)
}

/**
 * Scrubbed, bounded result summary for an execution fact (Plan r2 A.3): the
 * SAME hygiene pass as the input side, then the result cap. The caller decides
 * whether a goal_update result is described semantically (`applied …` /
 * `report not accepted …`) — this function only handles ordinary traffic.
 */
export function summarizeGoalFactResult(toolName: string, rawResult: string): string {
  const normalized = normalizeToolName(toolName)
  if (normalized === 'goal_update') {
    // The raw wire JSON is consumed by the staged-equality path verbatim; the
    // fact copy gets an honest placeholder until the apply decides the outcome.
    return 'goal_update wire result (see the applied / not-accepted outcome below)'
  }
  return clipFactText(scrubGoalFactSecrets(rawResult), GOAL_FACT_RESULT_CHARS)
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Server-side digest helper shared by the host implementation. */
export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
