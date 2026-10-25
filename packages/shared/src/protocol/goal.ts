/**
 * POO-134 Goal protocol — authoritative server-side Goal state contract.
 *
 * The Goal record is PERSISTED SERVER STATE (SessionManager metadata), never a
 * renderer-side or Agent-side authority. Everything here is structural and
 * JSON-serializable so it can live in the session JSONL header and travel to
 * the renderer as a projection event.
 *
 * Backward compatibility: a session JSONL without these fields is an ordinary
 * chat session. Consumers MUST treat `goal === undefined` as "no Goal" and
 * never synthesize one from partial data.
 */

/** Lifecycle of a Goal. Terminal: `completed` / `ended`. */
export type GoalStatus = 'active' | 'paused' | 'verifying' | 'completed' | 'ended'

/**
 * Why a Goal stopped running. The server owns this attribution; a client flag
 * never produces one.
 * - `manual` — the user paused explicitly (goal bar / mode menu).
 * - `stop`   — the native Stop button on a running Goal turn.
 * - `restart_required` — cold start found the Goal running/verifying: the
 *   process died mid-run, so the Goal must be explicitly resumed. Offline wall
 *   time is NEVER folded into the accumulated runtime.
 * - `awaiting_user` — the Agent asked for missing requirements (clarification)
 *   via goal_update; the next same-frame reply is a supplement to THIS Goal.
 * - `awaiting_permission` — a native permission/structured request is pending;
 *   the clock is stopped.
 * - `error` — connection/offline/balance/storage failure.
 * - `no_progress` — three consecutive continuation rounds without progress.
 */
export type GoalPauseReason =
  | 'manual'
  | 'stop'
  | 'restart_required'
  | 'awaiting_user'
  | 'awaiting_permission'
  | 'error'
  | 'no_progress'

export type GoalTodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * One Agent todo line. `id` is STABLE across snapshots: a later report must
 * carry the same id for the same item, and a snapshot that omits a previously
 * completed item never deletes or regresses it.
 */
export interface GoalTodoItem {
  id: string
  label: string
  status: GoalTodoStatus
  /** Server-assigned monotonic per-goal sequence, for ordering only. */
  seq: number
  updatedAt: number
}

/** Evidence binding for one completion criterion. */
export interface GoalEvidence {
  /** `file` — a real artifact on disk; `message` — a persisted assistant message. */
  kind: 'file' | 'message'
  /** Workspace-relative (or absolute within an allowed root) path for `file`. */
  path?: string
  /** Persisted message ID for `message` evidence. */
  messageId?: string
  /** sha256 of the file bytes at verification time (server-computed, never client-claimed). */
  sha256?: string
  /** File size in bytes at verification time. */
  bytes?: number
  /** Free-form note carried by the Agent (untrusted, display only). */
  note?: string
}

/** Per-criterion verdict from the independent verification query. */
export interface GoalCriterionResult {
  criterion: string
  passed: boolean
  /** Indices into the candidate's evidence array that support this verdict. */
  evidenceIds: number[]
  note?: string
}

/**
 * One server-captured execution fact.
 *
 * Every field is recorded by the SERVER from real agent-runtime events at the
 * real execution point (tool_start/tool_result pairing, turn boundaries,
 * pause/resume control transitions). The Agent has no field in any tool schema
 * that writes here, and a client never can — these are host facts, not claims.
 */
export interface GoalExecutionFact {
  /** Server-assigned monotonic sequence within the Goal. */
  seq: number
  /** The run generation whose turn produced the fact. */
  runGeneration: number
  /** Server clock at capture. */
  at: number
  kind:
    | 'turn_started'
    | 'tool_call'
    | 'turn_ended'
    | 'paused'
    | 'resumed'
  /** tool_call facts: normalized tool name + the SDK tool-use id. */
  toolName?: string
  toolUseId?: string
  /**
   * Present when the call ran INSIDE a sub-agent task: the parent tool-use id
   * is preserved so the fact is never presented as the Goal's own turn work.
   */
  parentToolUseId?: string
  /** tool_call facts: whether the result errored. */
  isError?: boolean
  /** Bounded parameter summary (independent cap, server-truncated). */
  paramSummary?: string
  /** Bounded result summary (independent cap, server-truncated). */
  resultSummary?: string
  /** Control facts: pause reason / end reason / scheduling source. */
  detail?: string
}

/**
 * The bounded, persisted execution record of ONE Goal. Server-owned: written
 * only by the GoalController from real host events, read by the independent
 * verification prompt as CONTEXT (never as candidate evidence slots).
 */
export interface GoalExecutionFacts {
  facts: GoalExecutionFact[]
  /**
   * False when the bounded record DROPPED facts (the cap was hit) — the record
   * is then explicitly partial and the verifier is told so.
   */
  truncated: boolean
  /** How many facts were dropped when truncated. */
  droppedCount?: number
  /**
   * Set when the most recent turn did NOT end normally (interrupted / error /
   * timeout) — the latest round's record is incomplete even though nothing was
   * dropped, and the verifier must not treat a missing step as disproved.
   */
  lastTurnIncomplete?: string
}

/**
 * The Agent's structured claim that the Goal is satisfiable. Never authority —
 * it only OPENS verification. Produced exclusively by the goal_update tool on
 * a Goal turn and applied by the server's GoalController.
 */
export interface GoalCandidate {
  summary: string
  reportedAt: number
  evidence: GoalEvidence[]
}

/**
 * Receipt of the independent verification query (a separate queryLlm call with
 * no tools). Fail-closed: anything missing, unparsable, timed out, or not
 * matching the current generation lands here as `not_satisfied`/`failed` —
 * never as a pass.
 */
export interface GoalVerificationReceipt {
  status: 'passed' | 'not_satisfied' | 'failed'
  criteria: GoalCriterionResult[]
  /** Effective model reported by the query (absent = unknown — never faked). */
  model?: string
  /** Token usage when the provider reports it; omitted fields are unknown. */
  inputTokens?: number
  outputTokens?: number
  /** Non-fatal warning from the query. A warning can never produce a pass. */
  warning?: string
  /**
   * What the verifier was told about the server's execution record (ICR-2):
   * present when the record was truncated or the last turn ended abnormally —
   * an explicit incompleteness marker, never a silent gap.
   */
  executionFactsNote?: string
  /** Failure detail when status is `failed`. */
  error?: string
  verifiedAt: number
}

/**
 * The authoritative Goal record.
 *
 * Identity is immutable: `id`, `sessionId` and `anchorMessageId` never change
 * after creation, so a same-named later Goal stays a different Goal and old
 * messages/files are never re-parented.
 */
export interface GoalRecord {
  id: string
  sessionId: string
  /** The user message that started this Goal (immutable anchor). */
  anchorMessageId: string
  objective: string
  /** Persisted IDs of same-frame user supplements accepted into THIS Goal. */
  supplementMessageIds: string[]
  /**
   * Persisted final assistant message IDs produced by THIS Goal's own turns,
   * captured server-side at real output persistence (never client-claimed).
   * These are the ONLY message IDs that may serve as `message` evidence for
   * this Goal: an earlier Goal's output, an ordinary-chat reply or another
   * session's message is never re-parented here (R2 F-R2-3/F-R2-4).
   */
  producedMessageIds?: string[]
  status: GoalStatus
  pauseReason?: GoalPauseReason
  /** Human-readable pause detail (server-composed, shown in chat). */
  pauseDetail?: string
  /** Bumped on every authoritative state transition (per-goal, from 1). */
  version: number
  /**
   * Bumped on every real (re)start of execution. Event application must match
   * the generation captured when the turn started — a late callback from an
   * older generation never mutates the record.
   */
  runGeneration: number
  /** Accumulated running time in ms. Pauses/waiting/failures are excluded. */
  elapsedMs: number
  /** Wall-clock start of the CURRENT run; absent while not running. */
  runningSince?: number
  /** Completion requirements (Agent-refined, server-persisted). */
  criteria: string[]
  todos: GoalTodoItem[]
  candidate?: GoalCandidate
  verification?: GoalVerificationReceipt
  /**
   * Server-captured execution record (ICR-2): bounded host facts from THIS
   * Goal's own turns — tool call/result pairs, turn boundaries, pause/resume
   * control transitions. Never agent- or client-writable; the independent
   * verification reads it as context so a process-dependent criterion can only
   * pass on real recorded execution.
   */
  executionFacts?: GoalExecutionFacts
  /** Assistant message carrying the completion summary (on `completed`). */
  resultMessageId?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
  completedAt?: number
}

/** True when the Goal can no longer run or be resumed. */
export function isGoalTerminal(status: GoalStatus): boolean {
  return status === 'completed' || status === 'ended'
}

/** True while the clock may be running (`active` or `verifying`). */
export function isGoalRunning(status: GoalStatus): boolean {
  return status === 'active' || status === 'verifying'
}

/**
 * The single clock formula. Accumulated time is (stored elapsed) plus the
 * live segment only when `runningSince` is set; a cold start that pauses the
 * Goal simply drops `runningSince`, so offline time is never counted.
 */
export function computeGoalElapsedMs(
  record: Pick<GoalRecord, 'elapsedMs' | 'runningSince'>,
  now: number,
): number {
  if (record.runningSince === undefined) return record.elapsedMs
  return Math.max(0, record.elapsedMs + Math.max(0, now - record.runningSince))
}

/**
 * Per-session Goal projection: what get/list/events/restore hand to clients.
 *
 * `revision` is MONOTONIC PER SESSION (bumped on create/change/terminal
 * clear/recovery) and is the ONLY ordering consumers may trust: a projection
 * with revision <= the highest seen must be dropped, so a stale terminal event
 * for Goal A can never clobber Goal B. Per-goal `version` alone is not enough
 * (every Goal starts at 1).
 */
export interface GoalProjection {
  revision: number
  sessionId: string
  /** Set only while a non-terminal Goal owns the session. */
  currentGoalId?: string
  /** The authoritative record (current while non-terminal, retained after). */
  goal?: GoalRecord
}
