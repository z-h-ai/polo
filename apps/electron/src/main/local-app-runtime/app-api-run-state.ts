import type { AppApiStableErrorCode } from '@polo-ai/shared/product-spaces'

export type AppRunStatus =
  | 'starting_admin'
  | 'start_unconfirmed'
  | 'running'
  | 'finishing'
  | 'finish_unconfirmed'
  | 'terminal'

export type QueryState = 'executing' | 'receipt_unconfirmed' | 'receipt_rejected' | 'settled'

export type QueryOutcome =
  | {
      kind: 'success'
      status: 'completed' | 'partial'
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }
  | { kind: 'no_output'; inputTokens?: number }
  | {
      kind: 'error'
      code: AppApiStableErrorCode
      /** Trusted provider-final usage attached to a terminal Host failure. */
      usage?: { inputTokens: number; outputTokens: number }
    }

export interface RunRecord {
  status: AppRunStatus
  startFingerprint: string
  requestedFinishStatus?: 'completed' | 'failed' | 'cancelled' | 'unknown'
  finishFingerprint?: string
  finalizedBy?: 'app' | 'server' | 'cleanup'
}

export interface QueryRecord {
  state: QueryState
  fingerprint: string
  outcome?: QueryOutcome
  reservedBytes: number
  requiredReceipt: boolean
  receiptConfirmed: boolean
}

export const PER_CAPABILITY_QUERY_SLOTS = 16
export const PER_CAPABILITY_TEXT_BUDGET_BYTES = 8 * 1024 * 1024
export const GLOBAL_QUERY_SLOTS = 256
export const GLOBAL_TEXT_BUDGET_BYTES = 128 * 1024 * 1024
export const QUERY_TEXT_RESERVATION_BYTES = 512 * 1024

export type AdmitQueryResult =
  | { kind: 'admitted' }
  | { kind: 'replay'; record: QueryRecord }
  | { kind: 'request_in_progress' }
  | { kind: 'idempotency_conflict' }
  | { kind: 'response_cache_full' }
  | { kind: 'run_not_ready'; runStatus: AppRunStatus | 'absent' }

const queryKey = (
  capabilityGeneration: number,
  runId: string,
  requestId: string,
) => `${capabilityGeneration}:${runId}:${requestId}`

/**
 * Capability-local Run/request state machine with an atomic admission budget.
 * Run keys are `(capabilityGeneration, runId)` — never a bare runId. Every
 * admitted query atomically reserves one slot and the 512 KiB text budget;
 * slots stay reserved across replayable states so a provider can never be
 * re-run past a bounded cache. Only whole-run and whole-capability release
 * lanes exist: a terminal Run clears exactly its own slots/bytes.
 */
export class AppApiRunState {
  private readonly runs = new Map<string, RunRecord>()
  private readonly queries = new Map<string, QueryRecord>()
  /** Global runId → owning capabilityGeneration: a runId can never be reused
   * by another generation — such requests fail closed as run_state_conflict. */
  private readonly runIdOwners = new Map<string, number>()

  private runKey(capabilityGeneration: number, runId: string): string {
    return `${capabilityGeneration}:${runId}`
  }

  /**
   * Creates a run owned by this capability generation. Returns undefined
   * when the runId is already owned by ANOTHER generation (Plan: the request
   * must fail closed as run_state_conflict).
   */
  createRun(capabilityGeneration: number, runId: string, startFingerprint: string): RunRecord | undefined {
    const owner = this.runIdOwners.get(runId)
    if (owner !== undefined && owner !== capabilityGeneration) return undefined
    const key = this.runKey(capabilityGeneration, runId)
    const existing = this.runs.get(key)
    if (existing) return existing
    this.runIdOwners.set(runId, capabilityGeneration)
    const record: RunRecord = { status: 'starting_admin', startFingerprint }
    this.runs.set(key, record)
    return record
  }

  getRun(capabilityGeneration: number, runId: string): RunRecord | undefined {
    return this.runs.get(this.runKey(capabilityGeneration, runId))
  }

  setRunStatus(capabilityGeneration: number, runId: string, status: AppRunStatus): void {
    const record = this.runs.get(this.runKey(capabilityGeneration, runId))
    if (record) record.status = status
  }

  /** Admits or replays one query inside a single synchronous critical section. */
  admitQuery(
    capabilityGeneration: number,
    runId: string,
    requestId: string,
    fingerprint: string,
  ): AdmitQueryResult {
    const run = this.getRun(capabilityGeneration, runId)
    if (!run || run.status !== 'running') {
      return { kind: 'run_not_ready', runStatus: run?.status ?? 'absent' }
    }
    const key = queryKey(capabilityGeneration, runId, requestId)
    const existing = this.queries.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: 'idempotency_conflict' }
      if (existing.state === 'executing') return { kind: 'request_in_progress' }
      return { kind: 'replay', record: existing }
    }
    const perCap = this.usageForCapability(capabilityGeneration)
    const global = this.usage()
    if (
      perCap.slots + 1 > PER_CAPABILITY_QUERY_SLOTS
      || perCap.bytes + QUERY_TEXT_RESERVATION_BYTES > PER_CAPABILITY_TEXT_BUDGET_BYTES
      || global.slots + 1 > GLOBAL_QUERY_SLOTS
      || global.bytes + QUERY_TEXT_RESERVATION_BYTES > GLOBAL_TEXT_BUDGET_BYTES
    ) {
      return { kind: 'response_cache_full' }
    }
    const record: QueryRecord = {
      state: 'executing',
      fingerprint,
      reservedBytes: QUERY_TEXT_RESERVATION_BYTES,
      requiredReceipt: false,
      receiptConfirmed: false,
    }
    this.queries.set(key, record)
    return { kind: 'admitted' }
  }

  /**
   * Stores the unique Host terminal outcome. Trusted provider-final usage
   * (on success, no_output, or a terminal failure), or the owner-accepted
   * no_output sentinel, always requires a confirmed POL-102 receipt before
   * the response may be released; the 512 KiB reservation shrinks to the
   * retained bytes (0 for error/no_output).
   */
  noteHostTerminal(
    capabilityGeneration: number,
    runId: string,
    requestId: string,
    outcome: QueryOutcome,
  ): QueryRecord | undefined {
    const record = this.queries.get(queryKey(capabilityGeneration, runId, requestId))
    if (!record || record.state !== 'executing') return record
    const requiresReceipt = outcome.kind === 'success'
      || outcome.kind === 'no_output'
      || (outcome.kind === 'error' && outcome.usage !== undefined)
    record.outcome = outcome
    record.requiredReceipt = requiresReceipt
    record.state = requiresReceipt ? 'receipt_unconfirmed' : 'settled'
    record.reservedBytes = outcome.kind === 'success'
      ? Buffer.byteLength(outcome.text, 'utf8')
      : 0
    return record
  }

  getQuery(capabilityGeneration: number, runId: string, requestId: string): QueryRecord | undefined {
    return this.queries.get(queryKey(capabilityGeneration, runId, requestId))
  }

  noteReceiptConfirmed(capabilityGeneration: number, runId: string, requestId: string): void {
    const record = this.getQuery(capabilityGeneration, runId, requestId)
    if (record?.state === 'receipt_unconfirmed') {
      record.state = 'settled'
      record.receiptConfirmed = true
    }
  }

  noteReceiptRejected(capabilityGeneration: number, runId: string, requestId: string): void {
    const record = this.getQuery(capabilityGeneration, runId, requestId)
    if (record?.state === 'receipt_unconfirmed') record.state = 'receipt_rejected'
  }

  /**
   * Shared predicate for App finish and lifecycle cleanup: start confirmed,
   * no executing query, no unconfirmed-or-rejected receipt, and every
   * required receipt confirmed. Usage-less Host failures never block.
   */
  canFinishRun(capabilityGeneration: number, runId: string): boolean {
    const run = this.getRun(capabilityGeneration, runId)
    if (!run || run.status !== 'running') return false
    for (const [key, query] of this.queries) {
      if (!key.startsWith(queryKey(capabilityGeneration, runId, ''))) continue
      if (query.state === 'executing' || query.state === 'receipt_unconfirmed') return false
      if (query.state === 'receipt_rejected') return false
      if (query.requiredReceipt && !query.receiptConfirmed) return false
    }
    return true
  }

  beginFinish(
    capabilityGeneration: number,
    runId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'unknown',
    fingerprint: string,
  ): 'ok' | 'replay' | 'status_conflict' | 'not_running' {
    const run = this.getRun(capabilityGeneration, runId)
    if (!run) return 'not_running'
    if (run.status === 'finishing' || run.status === 'finish_unconfirmed') {
      return run.requestedFinishStatus === status ? 'replay' : 'status_conflict'
    }
    if (run.status === 'terminal') {
      return run.requestedFinishStatus === status ? 'replay' : 'status_conflict'
    }
    if (run.status !== 'running') return 'not_running'
    if (run.finishFingerprint && run.finishFingerprint !== fingerprint) return 'status_conflict'
    run.finishFingerprint = fingerprint
    run.requestedFinishStatus = status
    run.status = 'finishing'
    return 'ok'
  }

  noteFinishUnconfirmed(capabilityGeneration: number, runId: string): void {
    const run = this.getRun(capabilityGeneration, runId)
    if (run?.status === 'finishing') run.status = 'finish_unconfirmed'
  }

  markTerminal(
    capabilityGeneration: number,
    runId: string,
    finalizedBy: RunRecord['finalizedBy'],
  ): void {
    const run = this.getRun(capabilityGeneration, runId)
    if (run) {
      run.status = 'terminal'
      run.finalizedBy = finalizedBy
    }
  }

  /**
   * Terminal Run: clears exactly its own slots/bytes, never other runs'.
   * The runId ownership TOMBSTONE is deliberately retained for the
   * coordinator lifetime — another capability generation reusing the runId
   * must keep failing with run_state_conflict.
   */
  releaseRun(capabilityGeneration: number, runId: string): void {
    const prefix = queryKey(capabilityGeneration, runId, '')
    for (const key of this.queries.keys()) {
      if (key.startsWith(prefix)) this.queries.delete(key)
    }
  }

  /** Releases one executing reservation (e.g. pre-executor failure). */
  releaseQuery(capabilityGeneration: number, runId: string, requestId: string): void {
    this.queries.delete(queryKey(capabilityGeneration, runId, requestId))
  }

  runsForCapability(capabilityGeneration: number): Array<{ runId: string; record: RunRecord }> {
    const prefix = `${capabilityGeneration}:`
    return [...this.runs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, record]) => ({ runId: key.slice(prefix.length), record }))
  }

  queriesForRun(capabilityGeneration: number, runId: string): Array<{
    requestId: string
    record: QueryRecord
  }> {
    const prefix = queryKey(capabilityGeneration, runId, '')
    return [...this.queries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, record]) => ({ requestId: key.slice(prefix.length), record }))
  }

  /**
   * Capability revoke/expiry: clears the whole generation after cleanup.
   * runId ownership tombstones intentionally survive (coordinator lifetime).
   */
  releaseCapability(capabilityGeneration: number): void {
    const prefix = `${capabilityGeneration}:`
    for (const key of this.queries.keys()) {
      if (key.startsWith(prefix)) this.queries.delete(key)
    }
    for (const key of this.runs.keys()) {
      if (key.startsWith(prefix)) this.runs.delete(key)
    }
  }

  usageForCapability(capabilityGeneration: number): { slots: number; bytes: number } {
    let slots = 0
    let bytes = 0
    const prefix = `${capabilityGeneration}:`
    for (const [key, query] of this.queries) {
      if (!key.startsWith(prefix)) continue
      slots += 1
      bytes += query.reservedBytes
    }
    return { slots, bytes }
  }

  usage(): { slots: number; bytes: number } {
    let slots = 0
    let bytes = 0
    for (const query of this.queries.values()) {
      slots += 1
      bytes += query.reservedBytes
    }
    return { slots, bytes }
  }
}
