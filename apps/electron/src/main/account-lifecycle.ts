import { stopRegisteredProductSpaceExecutionsForAccount } from '@polo-ai/server-core/runtime/product-space-executions'

interface StoppableAccountRegistry {
  stopAccount(accountId: string): Promise<void>
}

/**
 * Production account-session-ending sequence (wired into the Admin handler
 * deps from main/index.ts). Fail-closed by design:
 *
 * 1. every registered execution of the account — assistant sessions AND
 *    Local Apps — must reach a terminal state; any failure list throws.
 * 2. the Local App registry cleanup (runtimes recovered from persisted
 *    managers that may never have been registered) is awaited; its
 *    rejection propagates so an account replacement is refused with
 *    `account_transition_pending` instead of landing on top of a live
 *    runtime.
 */
export async function endAccountProductSpaceRuntimes(
  accountId: string,
  registry: StoppableAccountRegistry,
): Promise<void> {
  const stopped = await stopRegisteredProductSpaceExecutionsForAccount(accountId)
  if (!stopped.ok) {
    throw new Error(
      `product_space_execution_stop_failed: ${stopped.failedExecutionIds.join(', ')}`,
    )
  }
  await registry.stopAccount(accountId)
}
