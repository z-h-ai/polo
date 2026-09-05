import type { ExecutionSummary, ExecutionStatus } from "@polo-ai/shared/product-spaces"

/** POO-41 active-execution semantics: preparing/running/waiting/stopping.
    Terminal `stopped`/`failed` executions are never counted. */
export const ACTIVE_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "preparing",
  "running",
  "waiting_for_network",
  "stopping",
])

const RUNTIME_REFRESH_INTERVAL_MS = 5000

/** A registry snapshot is only consumable while its owning scope tuple is
    still the active ProductSpace scope (trusted-boundary ownership). */
export interface OwnedExecutionSnapshot {
  ownerAccountId: string
  ownerProductSpaceId: string
  executions: ExecutionSummary[]
}

export function snapshotBelongsToActiveScope(
  snapshot: OwnedExecutionSnapshot | null,
  accountId: string | null,
  activeProductSpaceId: string | null,
): snapshot is OwnedExecutionSnapshot {
  return Boolean(
    snapshot
    && accountId
    && activeProductSpaceId
    && snapshot.ownerAccountId === accountId
    && snapshot.ownerProductSpaceId === activeProductSpaceId,
  )
}

export interface RegistryExecutionPollerOptions {
  accountId: string
  productSpaceId: string
  intervalMs?: number
  fetchExecutions: (accountId: string, productSpaceId: string) => Promise<ExecutionSummary[] | null>
  onSnapshot: (executions: ExecutionSummary[]) => void
}

/**
 * Single-flight polling loop for the trusted ProductSpace active-execution
 * registry (drives the TopBar runtime count and execution dialog).
 *
 * Every scheduling step is guarded by `disposed` — inside `scheduleNext`,
 * at the top of the timeout callback, and around the recursive re-schedule —
 * so a disposed (scope-changed) loop can never fire another request, even
 * when its last in-flight response arrives late. Stale in-flight responses
 * are additionally dropped by the monotonic generation check, and only
 * non-null (successful) snapshots are published.
 */
export function createRegistryExecutionPoller({
  accountId,
  productSpaceId,
  intervalMs = RUNTIME_REFRESH_INTERVAL_MS,
  fetchExecutions,
  onSnapshot,
}: RegistryExecutionPollerOptions): { dispose(): void } {
  let disposed = false
  let timer: number | undefined
  let generation = 0

  const refresh = async () => {
    const requestGeneration = ++generation
    try {
      const executions = await fetchExecutions(accountId, productSpaceId)
      if (disposed || requestGeneration !== generation) return
      if (executions !== null) onSnapshot(executions)
    } catch {
      // Transient registry failures keep the previous same-scope snapshot.
    }
  }

  const scheduleNext = () => {
    if (disposed) return
    timer = window.setTimeout(() => {
      if (disposed) return
      void refresh().finally(() => {
        if (!disposed) scheduleNext()
      })
    }, intervalMs)
  }

  void refresh().finally(() => {
    if (!disposed) scheduleNext()
  })

  return {
    dispose() {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    },
  }
}
