import type { ProductSpaceExecutionScope } from '@polo-ai/shared/product-spaces'

export type ProductSpaceExecutionKind = 'assistant_session' | 'local_app'

export type ExecutionStopOutcome = 'stopped' | 'failed'

export interface RegisteredProductSpaceExecution {
  /** Immutable scope captured when the execution started. */
  scope: ProductSpaceExecutionScope
  kind: ProductSpaceExecutionKind
  name: string
  /** Runtime reference: session ID for assistant sessions, scope key for apps. */
  ref: string
  /** Returns whether the execution is still in flight. May be async. */
  isActive: () => boolean | Promise<boolean>
  /** Requests a safe stop and waits for a terminal outcome. */
  stop: () => Promise<ExecutionStopOutcome>
}

const registry = new Map<string, RegisteredProductSpaceExecution>()

export function registerProductSpaceExecution(
  execution: RegisteredProductSpaceExecution,
): void {
  registry.set(execution.scope.executionId, execution)
}

export function unregisterProductSpaceExecution(executionId: string): void {
  registry.delete(executionId)
}

export function getRegisteredProductSpaceExecution(
  executionId: string,
): RegisteredProductSpaceExecution | undefined {
  return registry.get(executionId)
}

export function listRegisteredProductSpaceExecutions(): RegisteredProductSpaceExecution[] {
  return [...registry.values()]
}

/** Shared deadline for concurrent stop drains. */
export const EXECUTION_STOP_DRAIN_TIMEOUT_MS = 10_000
export const EXECUTION_STOP_POLL_INTERVAL_MS = 50

/**
 * Awaits a terminal outcome for one execution. Probe failures fail closed:
 * an execution whose liveness cannot be determined is treated as active.
 * Returns true only when the execution is confirmed not active.
 */
export async function drainExecutionUntilTerminal(
  execution: RegisteredProductSpaceExecution,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    let active: boolean
    try {
      active = await execution.isActive()
    } catch {
      active = true
    }
    if (!active) return true
    await new Promise(resolve => setTimeout(resolve, EXECUTION_STOP_POLL_INTERVAL_MS))
  }
  return false
}

export interface ExecutionStopResult {
  executionId: string
  status: 'stopped' | 'failed'
  errorCode?: string
}

/**
 * Awaits a promise under the shared stop deadline. A stop implementation
 * that never resolves must not extend the window beyond the deadline: on
 * timeout the execution keeps its registry entry (retryable) and the caller
 * reports runtime_stop_failed.
 */
function withStopDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | null> {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  const deadlinePromise = new Promise<null>(resolve => {
    const remaining = deadline - Date.now()
    deadlineTimer = setTimeout(() => resolve(null), Math.max(remaining, 0))
  })
  return Promise.race([
    promise,
    deadlinePromise,
  ]).finally(() => {
    if (deadlineTimer) clearTimeout(deadlineTimer)
  })
}

/**
 * Stops the given registered executions. Each execution receives exactly
 * ONE stop request (dispatched concurrently) and each entry's liveness is
 * drained independently within ONE shared deadline: a stop call that never
 * resolves must not consume the window for the others — an execution that
 * reached a terminal state is confirmed, unregistered and reported
 * `stopped` even when a sibling stop hangs. Timed-out or still-active
 * entries keep their registry entry (retryable) and are reported as
 * `runtime_stop_failed`.
 */
export async function stopRegisteredExecutionsOnce(
  entries: RegisteredProductSpaceExecution[],
): Promise<ExecutionStopResult[]> {
  if (entries.length === 0) return []
  const deadline = Date.now() + EXECUTION_STOP_DRAIN_TIMEOUT_MS

  // One stop request per execution, dispatched concurrently. The requests
  // are bounded by the shared deadline but are NOT awaited as a group — a
  // hung stop must not delay sibling confirmations.
  for (const entry of entries) {
    void withStopDeadline(
      entry.stop().catch(() => undefined),
      deadline,
    )
  }

  // Per-entry confirmation, concurrent, all under the same deadline.
  const results = await Promise.all(entries.map(async entry => {
    const terminal = await withStopDeadline(
      drainExecutionUntilTerminal(entry, deadline),
      deadline,
    )
    if (terminal === true) {
      registry.delete(entry.scope.executionId)
      return {
        executionId: entry.scope.executionId,
        status: 'stopped' as const,
      }
    }
    return {
      executionId: entry.scope.executionId,
      status: 'failed' as const,
      errorCode: 'runtime_stop_failed',
    }
  }))
  return results
}

/**
 * Stops every registered execution regardless of space. Used by the one-shot
 * legacy direct-switch cleanup. Executions that fail to reach a terminal
 * state stay registered so a retry can stop them.
 */
export async function stopAllRegisteredProductSpaceExecutions(): Promise<{
  ok: boolean
  failedExecutionIds: string[]
}> {
  const results = await stopRegisteredExecutionsOnce([...registry.values()])
  const failedExecutionIds = results
    .filter(result => result.status === 'failed')
    .map(result => result.executionId)
  return { ok: failedExecutionIds.length === 0, failedExecutionIds }
}

export function resetProductSpaceExecutionRegistryForTests(): void {
  registry.clear()
  lastCommittedSwitch = null
}

/**
 * The one-time token record of the switch transaction that most recently won
 * its final commit gate and moved the fence. It is the linearization anchor
 * for a cancellation whose RPC is processed only AFTER the commit completed:
 * CANCEL_SWITCH can then report the authoritative "already committed" outcome
 * (with the current fence read-back) instead of a meaningless success no-op,
 * so the renderer can converge to the committed target instead of splitting
 * Main fence and renderer projection across two ProductSpaces. A newer
 * commit overwrites the record, so an older token can never claim it.
 *
 * The record is account-bound and fence-generation-bound: CANCEL_SWITCH
 * authenticates the current trusted Admin account against `accountId` and
 * verifies `fenceGeneration` (captured after the fence write) before
 * disclosing anything, and every fence mutation clears the record
 * atomically — a revoked, rebound, restored, logged-out or replaced fence
 * can never authenticate a stale cancellation for another account.
 */
export interface LastCommittedSwitch {
  token: string
  accountId: string
  targetProductSpaceId: string
  /** Fence generation captured immediately after the commit's fence write. */
  fenceGeneration: number
}

let lastCommittedSwitch: LastCommittedSwitch | null = null

export function setLastCommittedSwitch(record: LastCommittedSwitch | null): void {
  lastCommittedSwitch = record
}

export function getLastCommittedSwitch(): LastCommittedSwitch | null {
  return lastCommittedSwitch
}

/**
 * The device's currently committed ProductSpace, maintained exclusively by
 * the Main-side switch transaction (never by renderer RPC). While set, the
 * runtime hides sessions and rejects session operations bound to another
 * space; nothing can be re-classified from the renderer side after creation.
 * The fence is account-scoped: a fence committed for account A is never
 * usable by account B — it must be revoked and re-committed.
 */
let runtimeActiveProductSpaceId: string | null = null
let runtimeActiveAccountId: string | null = null

/**
 * Monotonic fence generation. Every committed switch and every revoke
 * advances it; in-flight switch transactions capture the generation at
 * prepare time and their commit is permanently rejected after any revoke.
 */
let runtimeFenceGeneration = 0

export function getRuntimeFenceGeneration(): number {
  return runtimeFenceGeneration
}

export function setRuntimeActiveProductSpace(productSpaceId: string | null): void {
  runtimeActiveProductSpaceId = productSpaceId
  if (productSpaceId === null) {
    // Clearing the fence is a revoke: the account binding dies with it.
    runtimeActiveAccountId = null
  }
  runtimeFenceGeneration += 1
  // Every fence mutation (revoke, re-commit, rebind, offline restore)
  // invalidates the late-cancel linearization anchor atomically: a commit
  // record for a fence that no longer exists must never authenticate a
  // delayed cancellation.
  lastCommittedSwitch = null
}

/** Binds (or re-binds) the trusted account of the committed fence. */
export function setRuntimeActiveProductSpaceAccount(accountId: string | null): void {
  runtimeActiveAccountId = accountId
  lastCommittedSwitch = null
}

export function getRuntimeActiveProductSpaceAccount(): string | null {
  return runtimeActiveAccountId
}

/** The full committed fence scope, or null when no fence is committed. */
export function getRuntimeActiveProductSpaceScope(): {
  accountId: string
  productSpaceId: string
} | null {
  return runtimeActiveProductSpaceId && runtimeActiveAccountId
    ? { accountId: runtimeActiveAccountId, productSpaceId: runtimeActiveProductSpaceId }
    : null
}

/**
 * True only when a fence is committed AND bound to exactly this account.
 * Every trusted runtime entry derives the account from the Admin session and
 * must refuse a fence that belongs to a replaced account.
 */
export function isRuntimeFenceBoundToAccount(accountId: string | null): boolean {
  return Boolean(
    accountId
    && runtimeActiveProductSpaceId
    && runtimeActiveAccountId === accountId,
  )
}

export function getRuntimeActiveProductSpace(): string | null {
  return runtimeActiveProductSpaceId
}

/**
 * Main-side revoke: clears the fence (and its account binding) and the
 * offline read-only flag inside the switch lock, advancing the fence
 * generation so any prepared switch is permanently invalidated.
 */
export async function revokeRuntimeProductSpaceFence(): Promise<void> {
  await withSwitchLock(async () => {
    setRuntimeOfflineReadOnly(false)
    setRuntimeActiveProductSpace(null)
  })
}

/**
 * Stops and unregisters every registered execution of one account —
 * assistant sessions and Local Apps alike. Used by Admin session-ending and
 * account replacement so a prior account can never keep executions running
 * in the background after its trusted session is gone.
 */
export async function stopRegisteredProductSpaceExecutionsForAccount(accountId: string): Promise<{
  ok: boolean
  failedExecutionIds: string[]
}> {
  const entries = listRegisteredProductSpaceExecutions().filter(
    execution => execution.scope.accountId === accountId,
  )
  const results = await stopRegisteredExecutionsOnce(entries)
  const failedExecutionIds = results
    .filter(result => result.status === 'failed')
    .map(result => result.executionId)
  return { ok: failedExecutionIds.length === 0, failedExecutionIds }
}

/**
 * A prepared (not yet committed) switch transaction. The token is one-time
 * and is created BEFORE any execution is stopped, so the renderer can cancel
 * while stopping is still in progress:
 *
 * - `prepared`: target verified, token held by the renderer, nothing stopped
 *   yet. Cancellation is fully clean — no stop has been dispatched.
 * - `stopping`: the stop phase is dispatching; cancellation prevents any
 *   further dispatch but cannot recall stops already sent.
 * - `ready`: every origin execution confirmed terminal; only now can the
 *   token commit the fence.
 */
export type PendingSwitchStatus = 'prepared' | 'stopping' | 'ready'

export interface PendingSwitchTransaction {
  token: string
  /** Bound at prepare time; only this account may commit the token. */
  accountId: string
  targetProductSpaceId: string
  originProductSpaceId: string
  fenceGeneration: number
  createdAt: number
  status: PendingSwitchStatus
  /** Set by CANCEL_SWITCH; every stop dispatch checks it first. */
  cancelled: boolean
}

const SWITCH_TRANSACTION_TTL_MS = 120_000

let pendingSwitchTransaction: PendingSwitchTransaction | null = null

export function setPendingSwitchTransaction(
  transaction: PendingSwitchTransaction | null,
): void {
  pendingSwitchTransaction = transaction
}

export function getPendingSwitchTransaction(): PendingSwitchTransaction | null {
  const pending = pendingSwitchTransaction
  if (pending && Date.now() - pending.createdAt > SWITCH_TRANSACTION_TTL_MS) {
    pendingSwitchTransaction = null
    return null
  }
  return pending
}

/**
 * While a switch transaction is being prepared, the runtime refuses to move
 * any execution into running/preparing.
 */
let runtimeOfflineReadOnly = false

export function setRuntimeOfflineReadOnly(offline: boolean): void {
  runtimeOfflineReadOnly = offline
}

export function isRuntimeOfflineReadOnly(): boolean {
  return runtimeOfflineReadOnly
}

/**
 * Serializes Main-side switch transactions. Running-item checks, new-start
 * blocking, termination, target verification and the fence commit all run
 * inside this lock so no interleaved registration can slip between
 * enumeration and commit.
 */
let switchLockTail: Promise<unknown> = Promise.resolve()

export async function withSwitchLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = switchLockTail
  let release!: () => void
  switchLockTail = new Promise<void>(resolve => {
    release = resolve
  })
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
  }
}

/**
 * While a switch transaction is in flight — including the async window
 * between prepare and the stop phase — every path that could move an
 * execution into running/preparing must refuse to start. A live (non-
 * expired) pending transaction keeps this true even between RPCs.
 */
let switchInProgress = false

export function setSwitchInProgress(inProgress: boolean): void {
  switchInProgress = inProgress
}

export function isSwitchInProgress(): boolean {
  const pending = getPendingSwitchTransaction()
  // A cancelled transaction is a tombstone kept only so the stop phase can
  // report SWITCH_CANCELLED — it must not keep blocking new starts.
  return switchInProgress || (pending !== null && !pending.cancelled)
}
