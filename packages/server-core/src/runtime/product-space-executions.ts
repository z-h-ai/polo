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
export const EXECUTION_STOP_DRAIN_CONCURRENCY = 8

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
 * Stops the given registered executions. Each execution receives exactly ONE
 * stop request (dispatched concurrently); the bounded workers only poll
 * liveness until a terminal outcome under one shared deadline. Confirmed
 * terminal executions are unregistered; failures stay registered for retry.
 */
export async function stopRegisteredExecutionsOnce(
  entries: RegisteredProductSpaceExecution[],
): Promise<ExecutionStopResult[]> {
  if (entries.length === 0) return []
  const deadline = Date.now() + EXECUTION_STOP_DRAIN_TIMEOUT_MS

  // One stop request per execution, dispatched concurrently.
  await Promise.allSettled(
    entries.map(entry => entry.stop().catch(() => undefined)),
  )

  const results: ExecutionStopResult[] = []
  let index = 0
  const workerCount = Math.min(EXECUTION_STOP_DRAIN_CONCURRENCY, entries.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < entries.length) {
      const entry = entries[index++]!
      const terminal = await drainExecutionUntilTerminal(entry, deadline)
      if (terminal) {
        registry.delete(entry.scope.executionId)
        results.push({ executionId: entry.scope.executionId, status: 'stopped' })
      } else {
        results.push({
          executionId: entry.scope.executionId,
          status: 'failed',
          errorCode: 'runtime_stop_failed',
        })
      }
    }
  })
  await Promise.all(workers)
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
}

/**
 * The device's currently committed ProductSpace, maintained exclusively by
 * the Main-side switch transaction (never by renderer RPC). While set, the
 * runtime hides sessions and rejects session operations bound to another
 * space; nothing can be re-classified from the renderer side after creation.
 */
let runtimeActiveProductSpaceId: string | null = null

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
  runtimeFenceGeneration += 1
}

export function getRuntimeActiveProductSpace(): string | null {
  return runtimeActiveProductSpaceId
}

/**
 * A prepared (not yet committed) switch transaction. The token is one-time:
 * only the renderer that prepared the switch may commit it, and any revoke
 * invalidates the whole transaction via the fence generation.
 */
export interface PendingSwitchTransaction {
  token: string
  targetProductSpaceId: string
  originProductSpaceId: string
  fenceGeneration: number
  createdAt: number
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
 * While a switch transaction is in flight, every path that could move an
 * execution into running/preparing must refuse to start.
 */
let switchInProgress = false

export function setSwitchInProgress(inProgress: boolean): void {
  switchInProgress = inProgress
}

export function isSwitchInProgress(): boolean {
  return switchInProgress
}
