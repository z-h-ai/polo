import { describe, expect, it } from 'bun:test'
import {
  EXECUTION_STOP_DRAIN_TIMEOUT_MS,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  resetProductSpaceExecutionRegistryForTests,
  stopRegisteredExecutionsOnce,
  type RegisteredProductSpaceExecution,
} from './product-space-executions'

function executionWithNeverResolvingStop(): RegisteredProductSpaceExecution {
  return {
    scope: {
      contractVersion: 1,
      executionId: 'exec-never-resolving-stop',
      accountId: 'account-a',
      productSpaceId: 'space-a',
      workspaceId: 'ws-a',
      subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
    } as never,
    kind: 'assistant_session',
    name: 'stuck runtime',
    ref: 'session-a',
    isActive: () => true,
    stop: () => new Promise<'stopped'>(() => {
      // Never resolves: a broken or malicious implementation must not extend
      // the stop window beyond the shared deadline.
    }),
  }
}

describe('stopRegisteredExecutionsOnce bounded window', () => {
  it('returns a bounded failure when a stop call never resolves', async () => {
    resetProductSpaceExecutionRegistryForTests()
    const stuck = executionWithNeverResolvingStop()
    registerProductSpaceExecution(stuck)

    const startedAt = Date.now()
    const results = await stopRegisteredExecutionsOnce([stuck])
    const elapsed = Date.now() - startedAt

    expect(results).toEqual([{
      executionId: 'exec-never-resolving-stop',
      status: 'failed',
      errorCode: 'runtime_stop_failed',
    }])
    // The whole window stays bounded by the shared deadline even though the
    // stop promise never settles.
    expect(elapsed).toBeLessThan(EXECUTION_STOP_DRAIN_TIMEOUT_MS + 2_500)
    // The entry stays registered for retry.
    expect(listRegisteredProductSpaceExecutions()
      .some(execution => execution.scope.executionId === 'exec-never-resolving-stop'))
      .toBe(true)
  }, EXECUTION_STOP_DRAIN_TIMEOUT_MS + 5_000)
})
