import { describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ExecutionSummary } from '@polo-ai/shared/product-spaces'
import { createRegistryExecutionPoller } from '../registry-execution-poller'

GlobalRegistrator.register()

const emptyExecutions: ExecutionSummary[] = []

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function deferredFetch() {
  const deferred = createDeferred<ExecutionSummary[] | null>()
  return {
    promise: deferred.promise,
    resolve: deferred.resolve,
    fetch: () => deferred.promise,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createRegistryExecutionPoller dispose guard', () => {
  it('a scope-A response resolved AFTER dispose never re-schedules another A request', async () => {
    const calls: Array<{ accountId: string; productSpaceId: string }> = []
    const requestA = deferredFetch()
    const poller = createRegistryExecutionPoller({
      accountId: 'acc-1',
      productSpaceId: 'ps_personal_e2e_fixture',
      intervalMs: 10,
      fetchExecutions: async (accountId, productSpaceId) => {
        calls.push({ accountId, productSpaceId })
        return requestA.fetch()
      },
      onSnapshot: () => {},
    })

    // The in-flight A request exists, then the scope changes: dispose.
    await sleep(5)
    expect(calls.length).toBe(1)
    poller.dispose()

    // The stale A response arrives late — after dispose.
    requestA.resolve(emptyExecutions)
    await requestA.promise
    // Wait well past one interval: a pre-fix poller would re-schedule here.
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({ accountId: 'acc-1', productSpaceId: 'ps_personal_e2e_fixture' })
  })

  it('the live scope keeps polling on its interval while not disposed', async () => {
    const calls: string[] = []
    const poller = createRegistryExecutionPoller({
      accountId: 'acc-1',
      productSpaceId: 'ps_enterprise_b',
      intervalMs: 10,
      fetchExecutions: async (_accountId, productSpaceId) => {
        calls.push(productSpaceId)
        return emptyExecutions
      },
      onSnapshot: () => {},
    })

    // Initial request + repeated interval ticks for the live scope.
    await sleep(60)
    poller.dispose()
    const ticksBeforeDispose = calls.length
    expect(ticksBeforeDispose).toBeGreaterThanOrEqual(3)
    expect(calls.every((id) => id === 'ps_enterprise_b')).toBe(true)

    // After dispose the loop stops: no further ticks.
    await sleep(40)
    expect(calls.length).toBe(ticksBeforeDispose)
  })

  it('a stale disposed-scope response never publishes a snapshot', async () => {
    let published: ExecutionSummary[] | null = null
    let call = 0
    const requestA = deferredFetch()
    const poller = createRegistryExecutionPoller({
      accountId: 'acc-1',
      productSpaceId: 'ps_personal_e2e_fixture',
      intervalMs: 10,
      fetchExecutions: async () => {
        call += 1
        return requestA.fetch()
      },
      onSnapshot: (executions) => {
        published = executions
      },
    })

    // First request hangs; dispose, then resolve it late — nothing publishes.
    await sleep(5)
    poller.dispose()
    requestA.resolve(emptyExecutions)
    await sleep(20)
    expect(published).toBeNull()
    expect(call).toBe(1)
  })
})
