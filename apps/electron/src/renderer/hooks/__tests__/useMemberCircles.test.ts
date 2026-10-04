import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MemberCircleSnapshot, MemberMembership } from '@polo-ai/shared/admin'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'

GlobalRegistrator.register()

// ---------------------------------------------------------------------------
// Mutable host doubles
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function success<T extends object>(payload: T) {
  return { success: true as const, ...payload }
}

function failure(errorCode: string, message = 'member circle failure') {
  return { success: false as const, errorCode, message }
}

let circleCounter = 0

function circle(circleId: string, overrides: Partial<MemberCircleSnapshot> = {}): MemberCircleSnapshot {
  circleCounter += 1
  return {
    membershipId: `00000000-0000-4000-8000-${String(circleCounter).padStart(12, '0')}`,
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    joinSource: 'share_link',
    joinedAt: '2026-01-01T00:00:00.000Z',
    circle: {
      circleId,
      name: `圈 ${circleId}`,
      purpose: '',
      status: 'active',
      ownerUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
    },
    entitlements: [],
    ...overrides,
  }
}

let membershipCounter = 0

function membership(circleId: string, overrides: Partial<MemberMembership> = {}): MemberMembership {
  membershipCounter += 1
  return {
    membershipId: `00000000-0000-4000-8100-${String(membershipCounter).padStart(12, '0')}`,
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    suspendedReason: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    paymentOrders: [],
    circle: {
      circleId,
      name: `圈 ${circleId}`,
      purpose: '',
      status: 'active',
      joinMode: 'paid',
      membershipPriceMinor: 9900,
      membershipCurrency: 'CNY',
      nextPeriodPriceMinor: null,
      nextPriceEffectiveAt: null,
    },
    ...overrides,
  }
}

// -------------------------------------------------------------------------
// ProductSpace context double (scope source)
// -------------------------------------------------------------------------

interface SpaceContextOverrides {
  accountId?: string | null
  personalProductSpaceId?: string | null
  contextVersion?: number
  spaceKind?: 'personal' | 'enterprise'
}

function spaceContext(overrides: SpaceContextOverrides = {}) {
  const accountId = overrides.accountId === undefined ? 'account-a' : overrides.accountId
  const personalId = overrides.personalProductSpaceId === undefined ? 'personal-space' : overrides.personalProductSpaceId
  const epoch = overrides.contextVersion ?? 1
  const kind = overrides.spaceKind ?? 'personal'
  if (!accountId || !personalId) return null
  return {
    accountId,
    activeProductSpaceId: kind === 'enterprise' ? 'enterprise-space' : personalId,
    personalProductSpaceId: personalId,
    productSpaceContextKey: createProductSpaceContextKey(accountId, kind === 'enterprise' ? 'enterprise-space' : personalId),
    contextVersion: epoch,
    activeProductSpace: {
      id: kind === 'enterprise' ? 'enterprise-space' : personalId,
      kind,
      name: kind === 'enterprise' ? '企业空间' : '个人空间',
      accessMode: 'active',
    },
  }
}

let productSpaceContextState = spaceContext()

mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
}))

// -------------------------------------------------------------------------
// Trusted bridge double (electronAPI.memberCircles)
// -------------------------------------------------------------------------

let listImpl: () => Promise<unknown> = async () => success({ circles: [circle('circle-a')] })
let listMembershipsImpl: () => Promise<unknown> = async () => success({ memberships: [membership('circle-a')] })
let previewRenewalImpl: (_membershipId: string) => Promise<unknown> = async () => failure('not_found')
let leaveImpl: (_membershipId: string) => Promise<unknown> = async () => failure('conflict')
let getOrderImpl: (_orderId: string) => Promise<unknown> = async () => failure('not_found')
let getCheckoutResultImpl: (_orderId: string) => Promise<unknown> = async () => failure('not_found')
let getUpdatesImpl: (_circleId: string) => Promise<unknown> = async () => success({ updates: { availability: 'upstream_pending', contractGap: 'G2' } })
let getProfileImpl: (_circleId: string) => Promise<unknown> = async () => success({ profile: { availability: 'upstream_pending', contractGap: 'G3' } })
let getSupportImpl: () => Promise<unknown> = async () => success({ support: { availability: 'upstream_pending', contractGap: 'G4' } })

const callCounts = {
  list: 0,
  listMemberships: 0,
  previewRenewal: 0,
  leave: 0,
  getOrder: 0,
  getCheckoutResult: 0,
  getUpdates: 0,
  getProfile: 0,
  getSupport: 0,
}

function resetBridge() {
  listImpl = async () => success({ circles: [circle('circle-a')] })
  listMembershipsImpl = async () => success({ memberships: [membership('circle-a')] })
  previewRenewalImpl = async () => failure('not_found')
  leaveImpl = async () => failure('conflict')
  getOrderImpl = async () => failure('not_found')
  getCheckoutResultImpl = async () => failure('not_found')
  getUpdatesImpl = async () => success({ updates: { availability: 'upstream_pending', contractGap: 'G2' } })
  getProfileImpl = async () => success({ profile: { availability: 'upstream_pending', contractGap: 'G3' } })
  getSupportImpl = async () => success({ support: { availability: 'upstream_pending', contractGap: 'G4' } })
  for (const key of Object.keys(callCounts) as Array<keyof typeof callCounts>) {
    callCounts[key] = 0
  }
}

function installBridge() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      memberCircles: {
        list: () => {
          callCounts.list += 1
          return listImpl()
        },
        listMemberships: () => {
          callCounts.listMemberships += 1
          return listMembershipsImpl()
        },
        previewRenewal: (membershipId: string) => {
          callCounts.previewRenewal += 1
          return previewRenewalImpl(membershipId)
        },
        leave: (membershipId: string) => {
          callCounts.leave += 1
          return leaveImpl(membershipId)
        },
        getOrder: (orderId: string) => {
          callCounts.getOrder += 1
          return getOrderImpl(orderId)
        },
        getCheckoutResult: (orderId: string) => {
          callCounts.getCheckoutResult += 1
          return getCheckoutResultImpl(orderId)
        },
        getUpdates: (circleId: string) => {
          callCounts.getUpdates += 1
          return getUpdatesImpl(circleId)
        },
        getProfile: (circleId: string) => {
          callCounts.getProfile += 1
          return getProfileImpl(circleId)
        },
        getSupport: () => {
          callCounts.getSupport += 1
          return getSupportImpl()
        },
      },
    },
  })
}

// -------------------------------------------------------------------------
// Catalog double (H1 shared instance) — mirrors the REAL sync() shape:
// production sync never rejects, failures settle into the instance state.
// -------------------------------------------------------------------------

interface CatalogDoubleState {
  errorCode: string | null
  catalog: import('@polo-ai/shared/admin').AppCatalogCacheEntry | null
}

function minimalCatalog(): import('@polo-ai/shared/admin').AppCatalogCacheEntry {
  return {
    accountId: 'account-a',
    organizationId: 'personal-space',
    appConfigVersion: 'test-1',
    authorizationStatus: 'authorized',
    apps: [],
    syncedAt: 1,
  }
}

let catalogState: CatalogDoubleState = { errorCode: null, catalog: minimalCatalog() }
let catalogSyncImpl: (force?: boolean) => Promise<void> = async () => {}
const catalogSyncCalls: boolean[] = []

function makeCatalog() {
  return {
    // A getter so a test can mutate catalogState mid-flight and the hook's
    // post-sync snapshot reads the settled instance state, like the real one.
    get state() {
      return catalogState
    },
    sync: mock(async (force?: boolean) => {
      catalogSyncCalls.push(Boolean(force))
      await catalogSyncImpl(force)
    }),
  } as unknown as import('@/hooks/useAppCatalog').AppCatalogInstance
}

function resetCatalog() {
  catalogState = { errorCode: null, catalog: minimalCatalog() }
  catalogSyncImpl = async () => {}
  catalogSyncCalls.length = 0
}

const {
  act,
  cleanup,
  renderHook,
  waitFor,
} = await import('@testing-library/react')
const { useMemberCirclesResource } = await import('../useMemberCircles')

beforeEach(() => {
  productSpaceContextState = spaceContext()
  resetBridge()
  resetCatalog()
  installBridge()
})

afterEach(() => {
  cleanup()
})

type CatalogDouble = ReturnType<typeof makeCatalog>

function renderResource(catalog?: CatalogDouble) {
  return renderHook((props: { catalog?: CatalogDouble | null } = {}) => useMemberCirclesResource({ catalog: props.catalog ?? catalog ?? null }))
}

async function waitForPhase(hook: { result: { current: { state: { phase: string } } } }, phase: string) {
  await waitFor(() => {
    if (hook.result.current.state.phase !== phase) {
      throw new Error(`phase is ${hook.result.current.state.phase}, expected ${phase}`)
    }
  })
}

describe('useMemberCirclesResource — P70-CIRCLE-STATE-01 (scope isolation)', () => {
  it('caches under accountId+personalProductSpaceId+epoch and drops a slow previous-account receipt', async () => {
    // Account A: a SLOW authoritative read is in flight.
    const slowList = deferred<unknown>()
    listImpl = () => slowList.promise
    const hook = renderResource()
    await waitForPhase(hook, 'loading')

    // Account B signs in: new account id + new epoch, with its own healthy
    // reads. The binding changes and B's fetch starts immediately.
    listImpl = async () => success({ circles: [circle('circle-a')] })
    listMembershipsImpl = async () => success({ memberships: [membership('circle-a')] })
    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await waitForPhase(hook, 'ready')
    expect(hook.result.current.state.scope).toMatchObject({ accountId: 'account-b' })
    expect(hook.result.current.circles?.[0]?.circle.circleId).toBe('circle-a')
    const listCallsAtB = callCounts.list

    // A's slow reply finally lands — it must NEVER reach B's state.
    await act(async () => {
      slowList.resolve(success({ circles: [circle('circle-from-account-a'), circle('circle-a')] }))
    })
    await act(async () => {})
    expect(hook.result.current.state.scope).toMatchObject({ accountId: 'account-b' })
    expect(hook.result.current.circles?.some(row => row.circle.circleId === 'circle-from-account-a')).toBe(false)
    expect(callCounts.list).toBe(listCallsAtB)
  })

  it('denies enterprise spaces BEFORE issuing any read and never shows the previous rows', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    expect(hook.result.current.circles).toHaveLength(1)

    // Switch to an enterprise space: rows disappear synchronously and no
    // member-circle RPC may be issued for the enterprise scope.
    const listCallsBefore = callCounts.list
    productSpaceContextState = spaceContext({ spaceKind: 'enterprise', contextVersion: 2 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await waitForPhase(hook, 'denied')
    expect(hook.result.current.circles).toBeNull()
    expect(callCounts.list).toBe(listCallsBefore)
    expect(callCounts.listMemberships).toBe(1)

    // Back to the personal space: the read is issued again automatically.
    productSpaceContextState = spaceContext({ contextVersion: 3 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await waitForPhase(hook, 'ready')
    expect(callCounts.list).toBe(listCallsBefore + 1)
  })

  it('keeps a stable fence object per binding and never reuses it across A→B→A', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    const fenceA = hook.result.current.state.scope
    expect(fenceA).toMatchObject({ accountId: 'account-a', personalProductSpaceId: 'personal-space', epoch: 1 })

    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await waitForPhase(hook, 'ready')
    const fenceB = hook.result.current.state.scope

    productSpaceContextState = spaceContext({ contextVersion: 3 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await waitForPhase(hook, 'ready')
    const fenceA2 = hook.result.current.state.scope

    expect(fenceB).toMatchObject({ accountId: 'account-b' })
    expect(fenceA2).toMatchObject({ accountId: 'account-a' })
    // Same account again, but the epoch moved: a NEW binding, never fenceA.
    expect(fenceA2).not.toBe(fenceA)
    expect(fenceA2?.epoch).toBe(3)
  })

  it('reports idle when there is no ProductSpace context at all', async () => {
    productSpaceContextState = null
    const hook = renderResource()
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await waitForPhase(hook, 'idle')
    expect(callCounts.list).toBe(0)
  })

  it('distinguishes a MISSING BRIDGE from a missing scope in refresh outcomes (P3)', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')

    // Remove the trusted bridge entirely (hardened renderer): the fence is
    // fine, so the outcome must not claim 'no_scope'.
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {},
    })
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.refresh()
    })
    expect(outcome).toEqual({ skipped: true, reason: 'bridge_unavailable' })

    // Restore the bridge; the same fence refreshes normally again.
    installBridge()
    await act(async () => {
      outcome = await hook.result.current.refresh()
    })
    expect(outcome).toEqual({ skipped: false, circles: 'ok', memberships: 'ok' })
  })
})

describe('useMemberCirclesResource — P70-CIRCLE-STATE-02 (phases, fencing, retry)', () => {
  it('separates empty (legitimate success) from failures', async () => {
    listImpl = async () => success({ circles: [] })
    listMembershipsImpl = async () => success({ memberships: [] })
    const hook = renderResource()
    await waitForPhase(hook, 'empty')
    expect(hook.result.current.circles).toEqual([])
    expect(hook.result.current.state.circlesError).toBeNull()
  })

  it('a network-class failure with no rows is offline, not empty', async () => {
    listImpl = async () => failure('network_error')
    listMembershipsImpl = async () => failure('timeout')
    const hook = renderResource()
    await waitForPhase(hook, 'offline')
    expect(hook.result.current.circles).toBeNull()
    expect(hook.result.current.state.circlesError).toMatchObject({ code: 'network_error', retryable: true })
    expect(hook.result.current.state.membershipsError).toMatchObject({ code: 'timeout' })
  })

  it('a non-network failure is error, and failed reads never become empty lists', async () => {
    listImpl = async () => failure('unauthorized')
    listMembershipsImpl = async () => failure('unauthorized')
    const hook = renderResource()
    await waitForPhase(hook, 'error')
    expect(hook.result.current.circles).toBeNull()
    expect(hook.result.current.state.circlesError).toMatchObject({ code: 'unauthorized', retryable: true })
  })

  it('a half-successful refresh is partial', async () => {
    listImpl = async () => success({ circles: [circle('circle-a')] })
    listMembershipsImpl = async () => failure('service_unavailable')
    const hook = renderResource()
    await waitForPhase(hook, 'partial')
    expect(hook.result.current.circles).toHaveLength(1)
    expect(hook.result.current.memberships).toBeNull()
    expect(hook.result.current.state.membershipsError).toMatchObject({ code: 'service_unavailable' })
  })

  it('an explicit retry refreshes in place and keeps the last receipt while it runs', async () => {
    listImpl = async () => failure('network_error')
    listMembershipsImpl = async () => failure('network_error')
    const hook = renderResource()
    await waitForPhase(hook, 'offline')

    listImpl = async () => success({ circles: [circle('circle-recovered')] })
    listMembershipsImpl = async () => success({ memberships: [membership('circle-recovered')] })
    let refreshOutcome: unknown
    await act(async () => {
      refreshOutcome = await hook.result.current.refresh()
    })
    expect(refreshOutcome).toEqual({ skipped: false, circles: 'ok', memberships: 'ok' })
    await waitForPhase(hook, 'ready')
    expect(hook.result.current.circles?.[0]?.circle.circleId).toBe('circle-recovered')
    expect(hook.result.current.state.circlesError).toBeNull()
  })

  it('a failed re-refresh keeps the previous receipt as the last known fact', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    expect(hook.result.current.circles).toHaveLength(1)

    listImpl = async () => failure('network_error')
    await act(async () => {
      await hook.result.current.refresh()
    })
    // Not emptied, not converted into an error-only view.
    expect(hook.result.current.circles).toHaveLength(1)
    expect(hook.result.current.state.circlesError).toMatchObject({ code: 'network_error' })
    expect(hook.result.current.state.phase).toBe('ready')
  })

  it('discards a superseded response via the request generation (newest wins)', async () => {
    // gen1 (mount) and gen2 (first refresh) hang on the same slow reply.
    const staleReply = deferred<unknown>()
    listImpl = () => staleReply.promise
    const hook = renderResource()
    await waitForPhase(hook, 'loading')

    let firstRefresh: Promise<unknown> | null = null
    act(() => {
      firstRefresh = hook.result.current.refresh()
    })

    // A newer refresh supersedes both; it succeeds immediately.
    listImpl = async () => success({ circles: [circle('circle-fresh')] })
    await act(async () => {
      await hook.result.current.refresh()
    })
    await waitForPhase(hook, 'ready')
    expect(hook.result.current.circles?.[0]?.circle.circleId).toBe('circle-fresh')

    // The stale reply finally lands — both old generations are discarded.
    await act(async () => {
      staleReply.resolve(success({ circles: [circle('circle-stale-generation')] }))
      await firstRefresh
    })
    await act(async () => {})
    expect(hook.result.current.circles?.some(row => row.circle.circleId === 'circle-stale-generation')).toBe(false)
    expect(hook.result.current.circles?.[0]?.circle.circleId).toBe('circle-fresh')
  })
})

describe('useMemberCirclesResource — P70-CIRCLE-STATE-03 (invalidateAndRefresh + leave)', () => {
  it('leave refreshes the relations AND the shared catalog exactly once', async () => {
    const catalog = makeCatalog()
    const hook = renderResource(catalog)
    await waitForPhase(hook, 'ready')
    expect(callCounts.list).toBe(1)
    expect(callCounts.listMemberships).toBe(1)
    expect(catalogSyncCalls).toHaveLength(0)

    leaveImpl = async () => success({
      membership: {
        membershipId: hook.result.current.state.scope!.accountId,
        circleId: 'circle-a',
        userId: 'aaaaaaaa-0000-4000-8000-000000000001',
        status: 'expired',
        billingKind: 'paid',
        currentPeriodEnd: null,
        modeTransitionEndsAt: null,
        suspendedReason: null,
        joinedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-10-04T00:00:00.000Z',
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
    })
    let leaveResult: unknown
    await act(async () => {
      leaveResult = await hook.result.current.leave('00000000-0000-4000-8000-000000000001')
    })
    expect(leaveResult).toMatchObject({ success: true })
    // One leave ⇒ exactly one authoritative relations refetch + one catalog sync.
    expect(callCounts.list).toBe(2)
    expect(callCounts.listMemberships).toBe(2)
    expect(catalogSyncCalls).toEqual([true])
    await waitForPhase(hook, 'ready')
  })

  it('invalidateAndRefresh drops old rows first, so a partial failure cannot revive them', async () => {
    const hook = renderResource(makeCatalog())
    await waitForPhase(hook, 'ready')
    expect(hook.result.current.memberships).toHaveLength(1)

    // The refetch half-fails: memberships never come back.
    listImpl = async () => success({ circles: [circle('circle-a'), circle('circle-b')] })
    listMembershipsImpl = async () => failure('service_unavailable')
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.invalidateAndRefresh({ circleId: 'circle-a' })
    })
    expect(outcome).toEqual({ relations: 'partial', catalog: 'refreshed', circleId: 'circle-a', orderId: null })
    // The NEW circles receipt is in, and the OLD memberships are NOT revived.
    expect(hook.result.current.circles).toHaveLength(2)
    expect(hook.result.current.memberships).toBeNull()
    expect(hook.result.current.state.phase).toBe('partial')
  })

  it('reports a catalog failure verbatim without rolling the relations back', async () => {
    const catalog = makeCatalog()
    catalogSyncImpl = async () => {
      throw new Error('catalog_down')
    }
    const hook = renderResource(catalog)
    await waitForPhase(hook, 'ready')

    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.invalidateAndRefresh({ orderId: 'order-1' })
    })
    expect(outcome).toEqual({ relations: 'refreshed', catalog: 'failed', circleId: null, orderId: 'order-1' })
    expect(hook.result.current.state.phase).toBe('ready')
  })

  it('reports catalog FAILED when a sync settles WITHOUT rejecting but the instance reports an errorCode (P2)', async () => {
    // The REAL H1 sync never rejects: offline/denied syncs settle into the
    // instance's own errorCode. 'refreshed' must not be faked for that path.
    const catalog = makeCatalog()
    const hook = renderResource(catalog)
    await waitForPhase(hook, 'ready')

    catalogState = { errorCode: 'ADMIN_UNAVAILABLE', catalog: null }
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.invalidateAndRefresh()
    })
    expect(outcome).toEqual({ relations: 'refreshed', catalog: 'failed', circleId: null, orderId: null })
  })

  it('reports catalog PENDING when the sync settles with no catalog and no errorCode (P2)', async () => {
    const catalog = makeCatalog()
    const hook = renderResource(catalog)
    await waitForPhase(hook, 'ready')

    catalogState = { errorCode: null, catalog: null }
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.invalidateAndRefresh({ circleId: 'circle-a' })
    })
    expect(outcome).toEqual({ relations: 'refreshed', catalog: 'pending', circleId: 'circle-a', orderId: null })
  })

  it('reports catalog unavailable when no H1 instance was injected', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.invalidateAndRefresh()
    })
    expect(outcome).toEqual({ relations: 'refreshed', catalog: 'unavailable', circleId: null, orderId: null })
  })

  it('a FAILED leave triggers NO relations refresh and NO catalog sync (P70-CIRCLE-STATE-03 negative)', async () => {
    const catalog = makeCatalog()
    const hook = renderResource(catalog)
    await waitForPhase(hook, 'ready')
    const listCallsBefore = callCounts.list
    expect(catalogSyncCalls).toHaveLength(0)

    leaveImpl = async () => failure('conflict')
    let result: unknown
    await act(async () => {
      result = await hook.result.current.leave('00000000-0000-4000-8000-000000000001')
    })
    expect(result).toMatchObject({ success: false, errorCode: 'conflict' })
    expect(callCounts.list).toBe(listCallsBefore)
    expect(callCounts.listMemberships).toBe(1)
    expect(catalogSyncCalls).toHaveLength(0)
  })
})

describe('useMemberCirclesResource — upstream_pending capabilities (G2/G3/G4)', () => {
  it('caches getUpdates as a READY awaiting-upstream fact, never empty nor error', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    let result: unknown
    await act(async () => {
      result = await hook.result.current.getUpdates('circle-a')
    })
    expect(result).toMatchObject({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } })
    expect(hook.result.current.updateStates['circle-a']).toEqual({
      phase: 'ready',
      state: { availability: 'upstream_pending', contractGap: 'G2' },
    })
  })

  it('refreshUpdates re-reads the same channel', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    await act(async () => {
      await hook.result.current.getUpdates('circle-a')
    })
    await act(async () => {
      await hook.result.current.refreshUpdates('circle-a')
    })
    expect(callCounts.getUpdates).toBe(2)
  })

  it('caches getProfile as a READY awaiting-upstream fact (G3)', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    await act(async () => {
      await hook.result.current.getProfile('circle-a')
    })
    expect(hook.result.current.profileStates['circle-a']).toEqual({
      phase: 'ready',
      state: { availability: 'upstream_pending', contractGap: 'G3' },
    })
  })

  it('caches getSupport verbatim, including upstream_pending (G4)', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    let result: unknown
    await act(async () => {
      result = await hook.result.current.getSupport()
    })
    expect(result).toMatchObject({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } })
    expect(hook.result.current.supportState).toEqual({
      phase: 'ready',
      state: { availability: 'upstream_pending', contractGap: 'G4' },
    })
  })

  it('clears the support state when the scope binding changes', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    await act(async () => {
      await hook.result.current.getSupport()
    })
    expect(hook.result.current.supportState).toMatchObject({ phase: 'ready' })

    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await waitForPhase(hook, 'ready')
    // The previous account's support config must not survive the rebind.
    expect(hook.result.current.supportState).toBeNull()
  })

  it('does NOT strand loading states when there is no personal scope (P3)', async () => {
    productSpaceContextState = spaceContext({ spaceKind: 'enterprise', contextVersion: 9 })
    const hook = renderResource()
    await waitForPhase(hook, 'denied')

    let updates: unknown
    await act(async () => {
      updates = await hook.result.current.getUpdates('circle-a')
    })
    expect(updates).toMatchObject({ success: false, errorCode: 'session_unavailable' })
    let support: unknown
    await act(async () => {
      support = await hook.result.current.getSupport()
    })
    expect(support).toMatchObject({ success: false, errorCode: 'session_unavailable' })
    // No loading phase was written before the fence check, so nothing is
    // stranded: the caches stay empty and no RPC was issued.
    expect(hook.result.current.updateStates['circle-a']).toBeUndefined()
    expect(hook.result.current.profileStates['circle-a']).toBeUndefined()
    expect(hook.result.current.supportState).toBeNull()
    expect(callCounts.getUpdates).toBe(0)
    expect(callCounts.getSupport).toBe(0)
  })

  it('drops an upstream capability receipt whose scope died mid-flight', async () => {
    const slowUpdates = deferred<unknown>()
    getUpdatesImpl = () => slowUpdates.promise
    const hook = renderResource()
    await waitForPhase(hook, 'ready')

    let updatesPromise: Promise<unknown> | null = null
    act(() => {
      updatesPromise = hook.result.current.getUpdates('circle-a')
    })
    expect(hook.result.current.updateStates['circle-a']).toEqual({ phase: 'loading' })

    // The binding dies before the reply lands.
    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await act(async () => {
      slowUpdates.resolve(success({ updates: { availability: 'upstream_pending', contractGap: 'G2' } }))
    })
    let fencedResult: unknown
    await act(async () => {
      fencedResult = await updatesPromise
    })
    expect(fencedResult).toMatchObject({ success: false, errorCode: 'session_changed' })
    // The NEW scope's cache is empty — nothing from the old scope leaked.
    await waitFor(() => {
      expect(hook.result.current.updateStates['circle-a']).toBeUndefined()
    })
  })
})

describe('useMemberCirclesResource — scoped commands', () => {
  it('previews renewal and hands the raw bridge payload through', async () => {
    previewRenewalImpl = async () => success({
      purchaseUrl: '/c/share-1?renew=1',
      resolvedPurchaseUrl: 'https://admin.example.com/c/share-1?renew=1',
      purchaseUrlResolutionError: null,
      preview: {
        membershipId: '00000000-0000-4000-8000-000000000001',
        circleId: 'circle-a',
        billingCycle: 'year' as const,
        periodKind: 'calendar_year' as const,
        priceMinor: 12800,
        currency: 'CNY',
        anchorAt: '2026-06-01T00:00:00.000Z',
        projectedPeriodStartAt: '2026-11-01T00:00:00.000Z',
        projectedPeriodEndAt: '2027-11-01T00:00:00.000Z',
        periodCapEndAt: '2027-11-01T00:00:00.000Z',
        canRenew: true,
        capReason: null,
      },
    })
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    let result: unknown
    await act(async () => {
      result = await hook.result.current.previewRenewal('00000000-0000-4000-8000-000000000001')
    })
    expect(result).toMatchObject({ success: true, resolvedPurchaseUrl: 'https://admin.example.com/c/share-1?renew=1' })
  })

  it('fails a command closed when there is no personal scope (enterprise denial)', async () => {
    productSpaceContextState = spaceContext({ spaceKind: 'enterprise', contextVersion: 9 })
    const hook = renderResource()
    await waitForPhase(hook, 'denied')
    let result: unknown
    await act(async () => {
      result = await hook.result.current.previewRenewal('00000000-0000-4000-8000-000000000001')
    })
    expect(result).toMatchObject({ success: false, errorCode: 'session_unavailable' })
    expect(callCounts.previewRenewal).toBe(0)
  })

  it('fences a leave whose scope died mid-flight (session_changed, no refresh)', async () => {
    const slowLeave = deferred<unknown>()
    leaveImpl = () => slowLeave.promise
    const hook = renderResource(makeCatalog())
    await waitForPhase(hook, 'ready')
    const listCallsBefore = callCounts.list

    let leavePromise: Promise<unknown> | null = null
    act(() => {
      leavePromise = hook.result.current.leave('00000000-0000-4000-8000-000000000001')
    })

    // The binding dies before the leave settles.
    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    await act(async () => {
      hook.rerender({ catalog: null })
    })
    await act(async () => {
      slowLeave.resolve(success({
        membership: {
          membershipId: '00000000-0000-4000-8000-000000000001',
          circleId: 'circle-a',
          userId: 'aaaaaaaa-0000-4000-8000-000000000001',
          status: 'expired',
          billingKind: 'paid',
          currentPeriodEnd: null,
          modeTransitionEndsAt: null,
          suspendedReason: null,
          joinedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-10-04T00:00:00.000Z',
          updatedAt: '2026-10-04T00:00:00.000Z',
        },
      }))
    })
    let fencedResult: unknown
    await act(async () => {
      fencedResult = await leavePromise
    })
    expect(fencedResult).toMatchObject({ success: false, errorCode: 'session_changed' })
    // No invalidation/refresh was triggered by the dead-scope success.
    expect(callCounts.list).toBe(listCallsBefore + 1)
    expect(catalogSyncCalls).toHaveLength(0)
  })

  it('reads an order receipt and the authoritative checkout result on demand', async () => {
    getOrderImpl = async () => success({
      order: {
        orderId: '00000000-0000-4000-8200-000000000001',
        storedStatus: 'paid',
        amountMinor: 9900,
        currency: 'CNY',
        checkoutUrl: 'https://b01.example.com/pay/1',
        periodEndAt: null,
        circle: { circleId: 'circle-a', name: '圈 circle-a' },
        paymentOwner: 'B01',
      },
    })
    getCheckoutResultImpl = async () => success({
      checkout: {
        state: 'success' as const,
        orderId: '00000000-0000-4000-8200-000000000001',
        circleId: 'circle-a',
        circleName: '圈 circle-a',
        amountMinor: 9900,
        currency: 'CNY',
        periodDays: null,
        period: null,
        periodEndAt: null,
        membershipPeriodEndAt: null,
        projectedPeriodEndAt: null,
        periodCapEndAt: null,
        expiresAt: null,
        qrIssuedAt: null,
        qrExpiresAt: null,
        codeUrl: null,
        merchantExpiresAt: null,
        providerState: 'paid' as const,
        canRecoverQr: null,
        canReconsent: null,
        recoveryOrderId: null,
        consentVersion: null,
        channel: null,
        currentPriceMinor: null,
        replacedByOrderId: null,
        canRetry: null,
      },
    })
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    let order: unknown
    await act(async () => {
      order = await hook.result.current.getOrder('00000000-0000-4000-8200-000000000001')
    })
    expect(order).toMatchObject({ success: true, order: { storedStatus: 'paid', paymentOwner: 'B01' } })
    let checkout: unknown
    await act(async () => {
      checkout = await hook.result.current.getCheckoutResult('00000000-0000-4000-8200-000000000001')
    })
    expect(checkout).toMatchObject({ success: true, checkout: { state: 'success' } })
    // No polling: exactly one call per explicit read.
    expect(callCounts.getCheckoutResult).toBe(1)
  })
})

describe('useMemberCirclesResource — getCircle detail projection', () => {
  it('projects the detail from THIS scope only and keeps the creator name pending', async () => {
    const hook = renderResource()
    await waitForPhase(hook, 'ready')
    const detail = hook.result.current.getCircle('circle-a')
    expect(detail).toMatchObject({ availability: 'ready' })
    if (detail.availability === 'ready') {
      expect(detail.circle.circle.circleId).toBe('circle-a')
      expect(detail.creatorName).toEqual({ readiness: 'upstream_pending', contractGap: 'G1' })
    }
    expect(hook.result.current.getCircle('not-in-this-scope')).toEqual({ availability: 'unknown_circle' })
  })
})
