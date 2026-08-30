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
  /** Returns whether the execution is still in flight. */
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

/**
 * Stops every registered execution regardless of space. Used by the one-shot
 * legacy direct-switch cleanup so no pre-switch runtime survives it.
 */
export async function stopAllRegisteredProductSpaceExecutions(): Promise<boolean> {
  const entries = [...registry.values()]
  let allStopped = true
  for (const entry of entries) {
    try {
      const outcome = await entry.stop()
      if (outcome !== 'stopped') allStopped = false
    } catch {
      allStopped = false
    }
    registry.delete(entry.scope.executionId)
  }
  return allStopped
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
