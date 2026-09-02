import type { ExecutionStatus, ProductSpaceExecutionScope } from '@polo-ai/shared/product-spaces'

export type ProductSpaceExecutionKind = 'assistant_session' | 'local_app' | 'skill_operation'

export type ExecutionStopOutcome = 'stopped' | 'failed'

export interface RegisteredProductSpaceExecution {
  /** Immutable scope captured when the execution started. */
  scope: ProductSpaceExecutionScope
  kind: ProductSpaceExecutionKind
  name: string
  /** Runtime reference: session ID for assistant sessions, scope key for apps. */
  ref: string
  /**
   * Immutable registration generation (R33-4/R34-4). Assigned exactly once
   * by the registry at registration time and never reused: a same-ID
   * replacement is a NEW generation, so an awaited stop cleanup can
   * compare-and-swap the registry against the captured entry instead of
   * blindly deleting. The registry-owned entry is frozen — producer objects
   * are copied at registration and never mutated.
   */
  generation: number
  /** Returns whether the execution is still in flight. May be async. */
  isActive: () => boolean | Promise<boolean>
  /** Real owner-scoped runtime status while active (R32-4). When absent,
   *  active executions project as 'running'. Active statuses are
   *  preparing/running/waiting_for_network/stopping — all of them block a
   *  switch PREPARE/COMMIT exactly like isActive. */
  getStatus?: () => ExecutionStatus
  /** Requests a safe stop and waits for a terminal outcome. */
  stop: () => Promise<ExecutionStopOutcome>
}

const registry = new Map<string, RegisteredProductSpaceExecution>()

/** Monotonic registration generation source (R33-4). */
let registrationSequence = 0

/**
 * Registers an execution and returns the REGISTRY-OWNED entry (R34-4). The
 * registry stores a fresh object with a newly assigned generation — the
 * caller's object is never mutated and never becomes registry state, so
 * re-registering the same caller object is always a NEW immutable
 * generation that an in-flight stop cannot confuse with the old one. The
 * owned entry's generation is registry state: consumers must never
 * reassign it (behavior hooks may still be adjusted on the owned entry by
 * the code that owns the registration).
 */
export function registerProductSpaceExecution(
  execution: RegisteredProductSpaceExecution,
): RegisteredProductSpaceExecution {
  const owned: RegisteredProductSpaceExecution = {
    ...execution,
    generation: ++registrationSequence,
  }
  registry.set(owned.scope.executionId, owned)
  return owned
}

export function unregisterProductSpaceExecution(executionId: string): void {
  registry.delete(executionId)
}

export function getRegisteredProductSpaceExecution(
  executionId: string,
): RegisteredProductSpaceExecution | undefined {
  return registry.get(executionId)
}

/**
 * The generation currently registered for `executionId`, or null. Used by
 * stop callers to revalidate ownership AFTER awaited drains: a completion
 * captured against an older generation must never be reported against the
 * same-ID replacement that now owns the registry slot (R33-4).
 */
export function getRegisteredProductSpaceExecutionGeneration(
  executionId: string,
): number | null {
  return registry.get(executionId)?.generation ?? null
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
  /**
   * R34-4: true when the terminal outcome was reached but the registry slot
   * is now owned by a DIFFERENT registration (same-ID replacement). The
   * stopped work belonged to the captured generation only — callers must
   * never report success against the newer ownership.
   */
  superseded?: boolean
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
 *
 * R34-4: entries are resolved to their REGISTRY-OWNED registration and the
 * generation is captured before any await. The terminal cleanup deletes the
 * slot only when the registry still holds exactly that entry AND generation;
 * any same-ID replacement (a new registry-owned generation) survives and the
 * result is flagged `superseded` so callers report truthful ownership.
 */
export async function stopRegisteredExecutionsOnce(
  entries: RegisteredProductSpaceExecution[],
): Promise<ExecutionStopResult[]> {
  if (entries.length === 0) return []
  const deadline = Date.now() + EXECUTION_STOP_DRAIN_TIMEOUT_MS

  // Resolve to the registry-owned entry (a fresh immutable object created at
  // registration) and capture entry + generation BEFORE any await: the drain
  // below can outlive this ownership.
  const owned = entries.map(entry => ({
    entry: registry.get(entry.scope.executionId) ?? entry,
    capturedGeneration: (registry.get(entry.scope.executionId) ?? entry).generation,
  }))

  // One stop request per execution, dispatched concurrently. The requests
  // are bounded by the shared deadline but are NOT awaited as a group — a
  // hung stop must not delay sibling confirmations.
  for (const { entry } of owned) {
    void withStopDeadline(
      entry.stop().catch(() => undefined),
      deadline,
    )
  }

  // Per-entry confirmation, concurrent, all under the same deadline.
  const results = await Promise.all(owned.map(async ({ entry, capturedGeneration }) => {
    const terminal = await withStopDeadline(
      drainExecutionUntilTerminal(entry, deadline),
      deadline,
    )
    if (terminal === true) {
      // R33-4/R34-4 generation CAS: only the CAPTURED registration may be
      // deleted. A same-ID replacement registered while this stop awaited
      // its terminal probe is a new registry-owned generation — it stays
      // registered and keeps the execution visible to cleanup/switching.
      const current = registry.get(entry.scope.executionId)
      if (current === entry && current.generation === capturedGeneration) {
        registry.delete(entry.scope.executionId)
        return {
          executionId: entry.scope.executionId,
          status: 'stopped' as const,
        }
      }
      // The slot outlived this registration's ownership: the replacement is
      // untouched and the stale completion is reported as superseded.
      return {
        executionId: entry.scope.executionId,
        status: 'stopped' as const,
        superseded: true,
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
  registrationSequence = 0
  lastCommittedSwitch = null
  prepareIntentSequence = 0
  switchActivityClaims.clear()
  restrictedProductSpaces.clear()
}

/**
 * Monotonic Main-side prepare-intent sequence. A PREPARE claims its intent
 * BEFORE the (unlocked) trusted-list fetch and may only install a pending
 * switch transaction if it is still the LATEST claim when it re-enters the
 * switch lock — so two prepares finishing out of order can never let the
 * older one overwrite or invalidate the newer one's pending token.
 */
let prepareIntentSequence = 0

export function claimSwitchPrepareIntent(): number {
  return ++prepareIntentSequence
}

export function getLatestSwitchPrepareIntent(): number {
  return prepareIntentSequence
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
  if (productSpaceId === null) {
    // A revoked fence has no spaces to restrict; the offline read-only view
    // blocks starts on its own until an online switch revalidates.
    restrictedProductSpaces.clear()
  }
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
 * Trusted access-mode restriction fence (R32-3). When a verified online
 * refresh transitions the active enterprise space from `active` to
 * `read_only`, Main records the space here and every Assistant/App/Skill
 * start fails closed while existing executions are terminated through the
 * no-confirmation trusted path. Restoring active access clears the flag
 * without ever auto-restarting prior work.
 */
const restrictedProductSpaces = new Set<string>()

export function setRuntimeProductSpaceRestricted(productSpaceId: string, restricted: boolean): void {
  if (restricted) restrictedProductSpaces.add(productSpaceId)
  else restrictedProductSpaces.delete(productSpaceId)
}

export function isRuntimeProductSpaceRestricted(productSpaceId: string | null | undefined): boolean {
  if (!productSpaceId) return false
  return restrictedProductSpaces.has(productSpaceId)
}

/**
 * Space-scoped no-confirmation termination used by the restriction
 * transition: stops every registered execution of one account inside one
 * ProductSpace and reports the per-item outcomes.
 */
export async function stopRegisteredProductSpaceExecutionsForSpace(
  accountId: string,
  productSpaceId: string,
): Promise<{
  ok: boolean
  failedExecutionIds: string[]
}> {
  const entries = listRegisteredProductSpaceExecutions().filter(
    execution => execution.scope.accountId === accountId
      && execution.scope.productSpaceId === productSpaceId,
  )
  const results = await stopRegisteredExecutionsOnce(entries)
  const failedExecutionIds = results
    .filter(result => result.status === 'failed')
    .map(result => result.executionId)
  return { ok: failedExecutionIds.length === 0, failedExecutionIds }
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
 *
 * R31-6: the in-flight half is OWNER-controlled. Each PREPARE/STOP claims
 * switch activity under its own identity (prepare intent id / one-time
 * token) and releases exactly its own claim — an unconditional release from
 * a stale operation can never clear a newer operation's active gate.
 */
const switchActivityClaims = new Map<string, true>()

export function acquireSwitchActivityClaim(owner: string): void {
  switchActivityClaims.set(owner, true)
}

export function releaseSwitchActivityClaim(owner: string): void {
  switchActivityClaims.delete(owner)
}

export function isSwitchInProgress(): boolean {
  if (switchActivityClaims.size > 0) return true
  const pending = getPendingSwitchTransaction()
  // A cancelled transaction is a tombstone kept only so the stop phase can
  // report SWITCH_CANCELLED — it must not keep blocking new starts.
  return pending !== null && !pending.cancelled
}
