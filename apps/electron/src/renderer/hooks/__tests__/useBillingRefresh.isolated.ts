/**
 * POO-177 QUOTA-01/02 — lifecycle of the bounded in-flight billing refresh.
 *
 * The hook owns exactly one in-flight business operation: concurrent clicks
 * merge into it, a settled receipt carries the scope key captured at trigger
 * and is dropped when the scope moved on (account/space/epoch/revision —
 * App's scope key), a failed read still clears busy, and an unmounted hook
 * never publishes state.
 *
 * The real read function is injectable — these tests run against deferred
 * doubles, never the network.
 */
import { describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()

const { renderHook, act } = await import('@testing-library/react')
const { useBillingRefresh } = await import('../useBillingRefresh')
import type { AdminRefreshBillingRpcInput } from '@polo-ai/shared/admin/schemas'
import type { AdminRefreshBillingRpcResult } from '../../../shared/types'
type BillingRefreshSettlement = import('../useBillingRefresh').BillingRefreshSettlement

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const input: AdminRefreshBillingRpcInput = {
  expectedProductSpaceId: '11111111-2222-3333-4444-555555555555',
  sessionId: 'session-1',
  expectedConnectionSlug: 'polo-space-11111111-2222-3333-4444-555555555555',
}

const okResult: AdminRefreshBillingRpcResult = {
  success: true as const,
  accountId: 'account-1',
  productSpaceId: input.expectedProductSpaceId,
  sessionId: input.sessionId,
  connectionSlug: input.expectedConnectionSlug,
  snapshot: {
    productSpaceId: input.expectedProductSpaceId,
    computedAt: '2026-10-29T00:00:00.000Z',
    billingMode: 'provider_metered' as const,
    preflightOnly: true as const,
    availability: { state: 'available' as const, reason: null },
    quota: null,
  },
}

function setup(options: { scopeKey?: () => string; read?: (input: AdminRefreshBillingRpcInput) => Promise<AdminRefreshBillingRpcResult> } = {}) {
  const readCalls: AdminRefreshBillingRpcInput[] = []
  const scopeKeys: string[] = []
  const hook = renderHook(() => useBillingRefresh({
    read: options.read ?? (async (i: AdminRefreshBillingRpcInput) => {
      readCalls.push(i)
      return okResult
    }),
    getScopeKey: options.scopeKey ?? (() => {
      scopeKeys.push('scope')
      return 'scope'
    }),
  }))
  return {
    hook,
    readCalls,
    scopeKeys,
    refresh: () => hook.result.current.refresh(input),
  }
}

describe('useBillingRefresh', () => {
  it('merges concurrent clicks into one in-flight read', async () => {
    const gate = deferred<AdminRefreshBillingRpcResult>()
    let reads = 0
    const { hook, refresh } = setup({
      read: async () => {
        reads += 1
        return gate.promise
      },
    })
    expect(hook.result.current.busy).toBe(false)

    let first: Promise<unknown> | null = null
    act(() => {
      first = refresh()
    })
    expect(hook.result.current.busy).toBe(true)

    let second: Promise<BillingRefreshSettlement | null> | null = null
    let secondSettled: BillingRefreshSettlement | null | undefined
    act(() => {
      second = refresh()
    })
    await act(async () => {
      gate.resolve(okResult)
      await first
      secondSettled = await second!
    })

    expect(reads).toBe(1)
    expect(secondSettled).toBeNull()
    expect(hook.result.current.busy).toBe(false)
    hook.unmount()
  })

  it('returns the settled receipt with the scope captured at trigger', async () => {
    let scope = 'scope-a'
    const { hook, refresh, scopeKeys } = setup({
      scopeKey: () => {
        scopeKeys.push(scope)
        return scope
      },
    })
    scopeKeys.length = 0

    let settlement: BillingRefreshSettlement | null = null
    await act(async () => {
      settlement = await refresh()
    })

    expect(settlement).not.toBeNull()
    expect(settlement).toMatchObject({ requestId: 1, scopeKey: 'scope-a', error: null })
    expect(settlement!.result).toEqual(okResult)
    // captured at trigger AND re-checked at settle
    expect(scopeKeys).toEqual(['scope-a', 'scope-a'])
    expect(hook.result.current.busy).toBe(false)
    hook.unmount()
  })

  it('drops the receipt when the scope moved on before settle', async () => {
    let scope = 'scope-a'
    const gate = deferred<AdminRefreshBillingRpcResult>()
    const { hook, refresh } = setup({
      scopeKey: () => scope,
      read: () => gate.promise,
    })

    let settlement: Promise<BillingRefreshSettlement | null> | null = null
    let settled: BillingRefreshSettlement | null | undefined
    act(() => {
      settlement = refresh()
    })
    // The account/space/epoch/revision scope changes mid-flight.
    scope = 'scope-b'
    await act(async () => {
      gate.resolve(okResult)
      settled = await settlement!
    })

    expect(settled).toBeNull()
    // busy still clears — the operation IS over; the next click starts fresh.
    expect(hook.result.current.busy).toBe(false)
    hook.unmount()
  })

  it('clears busy and reports a failed read without throwing', async () => {
    const failure = new Error('network unreachable')
    const { hook, refresh } = setup({
      read: async () => {
        throw failure
      },
    })

    let settlement: BillingRefreshSettlement | null = null
    await act(async () => {
      settlement = await refresh()
    })

    expect(settlement).toMatchObject({ requestId: 1, scopeKey: 'scope', error: failure, result: null })
    expect(hook.result.current.busy).toBe(false)
    hook.unmount()
  })

  it('keeps serving a second operation after the first settled', async () => {
    const { hook, refresh, readCalls } = setup()
    await act(async () => {
      await refresh()
    })
    await act(async () => {
      await refresh()
    })
    expect(readCalls.length).toBe(2)
    expect(hook.result.current.busy).toBe(false)
    hook.unmount()
  })
})
