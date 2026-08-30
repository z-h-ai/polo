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

/**
 * Stops one execution and confirms its terminal outcome. An explicit stop
 * failure is terminal for the attempt (no point draining a runtime that
 * refused to stop); a claimed stop is still verified via the liveness probe.
 */
export async function stopAndDrainExecution(
  execution: RegisteredProductSpaceExecution,
  deadline: number,
): Promise<boolean> {
  let outcome: ExecutionStopOutcome
  try {
    outcome = await execution.stop()
  } catch {
    outcome = 'failed'
  }
  if (outcome === 'failed') return false
  return drainExecutionUntilTerminal(execution, deadline)
}

/**
 * Stops every registered execution regardless of space. Used by the one-shot
 * legacy direct-switch cleanup. Stop requests are dispatched concurrently and
 * terminal outcomes are awaited with bounded concurrency under one shared
 * deadline. Executions that fail to reach a terminal state stay registered so
 * a retry can stop them; only confirmed-terminal entries are removed.
 */
export async function stopAllRegisteredProductSpaceExecutions(): Promise<{
  ok: boolean
  failedExecutionIds: string[]
}> {
  const entries = [...registry.values()]
  // Dispatch every stop request concurrently.
  await Promise.allSettled(
    entries.map(entry => entry.stop().catch(() => undefined)),
  )

  const deadline = Date.now() + EXECUTION_STOP_DRAIN_TIMEOUT_MS
  const failedExecutionIds: string[] = []
  let index = 0
  const workerCount = Math.min(EXECUTION_STOP_DRAIN_CONCURRENCY, entries.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < entries.length) {
      const entry = entries[index++]!
      const terminal = await stopAndDrainExecution(entry, deadline)
      if (terminal) {
        registry.delete(entry.scope.executionId)
      } else {
        failedExecutionIds.push(entry.scope.executionId)
      }
    }
  })
  await Promise.all(workers)
  return { ok: failedExecutionIds.length === 0, failedExecutionIds }
}

export function resetProductSpaceExecutionRegistryForTests(): void {
  registry.clear()
}

/**
 * The device's currently committed ProductSpace, declared by the trusted
 * client through the switch transaction. While set, the runtime hides
 * sessions and rejects session operations bound to another space; nothing
 * can be re-classified from the renderer side after creation.
 */
let runtimeActiveProductSpaceId: string | null = null

export function setRuntimeActiveProductSpace(productSpaceId: string | null): void {
  runtimeActiveProductSpaceId = productSpaceId
}

export function getRuntimeActiveProductSpace(): string | null {
  return runtimeActiveProductSpaceId
}
