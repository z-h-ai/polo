import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { MemberCirclesResource } from '../MemberCircleResourceContext'

GlobalRegistrator.register()

// -------------------------------------------------------------------------
// Host doubles
// -------------------------------------------------------------------------

let productSpaceContextState: unknown = {
  accountId: 'account-a',
  activeProductSpaceId: 'personal-space',
  personalProductSpaceId: 'personal-space',
  productSpaceContextKey: '["product-space",1,"account-a","personal-space"]',
  contextVersion: 1,
  activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
}

let listCalls = 0
let catalogSyncCalls = 0

mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
}))

beforeEach(() => {
  productSpaceContextState = {
    accountId: 'account-a',
    activeProductSpaceId: 'personal-space',
    personalProductSpaceId: 'personal-space',
    productSpaceContextKey: '["product-space",1,"account-a","personal-space"]',
    contextVersion: 1,
    activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
  }
  listCalls = 0
  catalogSyncCalls = 0
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      memberCircles: {
        list: () => {
          listCalls += 1
          return Promise.resolve({ success: true, circles: [] })
        },
        listMemberships: () => Promise.resolve({ success: true, memberships: [] }),
        previewRenewal: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        leave: () => Promise.resolve({ success: false, errorCode: 'conflict', message: 'x' }),
        getOrder: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        getCheckoutResult: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        getUpdates: () => Promise.resolve({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } }),
        getProfile: () => Promise.resolve({ success: true, profile: { availability: 'upstream_pending', contractGap: 'G3' } }),
        getSupport: () => Promise.resolve({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } }),
      },
    },
  })
})

const { act, cleanup, render } = await import('@testing-library/react')
const { MemberCircleResourceProvider, useMemberCircles } = await import('../MemberCircleResourceContext')

afterEach(() => {
  cleanup()
})

type ProbeRecorder = { current: MemberCirclesResource | null }

function ProbeChild({ recorder }: { recorder: ProbeRecorder }) {
  recorder.current = useMemberCircles()
  return null
}

function makeInjectedResource(): MemberCirclesResource {
  return {
    state: {
      phase: 'ready',
      scope: null,
      circles: null,
      memberships: null,
      circlesError: null,
      membershipsError: null,
      refreshing: false,
      updatedAt: null,
    },
    circles: null,
    memberships: null,
    updateStates: {},
    profileStates: {},
    supportState: null,
    getCircle: () => ({ availability: 'unknown_circle' }),
    refresh: async () => ({ skipped: true, reason: 'no_scope' }),
    invalidateAndRefresh: async () => ({ relations: 'skipped', catalog: 'unavailable', circleId: null, orderId: null }),
    previewRenewal: async () => ({ success: false, errorCode: 'not_found', message: 'injected' }),
    leave: async () => ({ success: false, errorCode: 'conflict', message: 'injected' }),
    getOrder: async () => ({ success: false, errorCode: 'not_found', message: 'injected' }),
    getCheckoutResult: async () => ({ success: false, errorCode: 'not_found', message: 'injected' }),
    getUpdates: async () => ({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } }),
    refreshUpdates: async () => ({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } }),
    getProfile: async () => ({ success: true, profile: { availability: 'upstream_pending', contractGap: 'G3' } }),
    getSupport: async () => ({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } }),
    refreshSupport: async () => ({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } }),
  }
}

describe('MemberCircleResourceProvider (POO-70 C2 single instance holder)', () => {
  it('gives every consumer the SAME resource instance and command identities', async () => {
    const first: ProbeRecorder = { current: null }
    const second: ProbeRecorder = { current: null }
    render(createElement(MemberCircleResourceProvider, {
      children: [
        createElement(ProbeChild, { key: 0, recorder: first }),
        createElement(ProbeChild, { key: 1, recorder: second }),
      ],
    }))
    expect(first.current).not.toBeNull()
    expect(second.current).not.toBeNull()
    // One live instance: identical object and identical command methods.
    expect(first.current).toBe(second.current)
    expect(first.current!.refresh).toBe(second.current!.refresh)
    expect(first.current!.leave).toBe(second.current!.leave)
    expect(first.current!.invalidateAndRefresh).toBe(second.current!.invalidateAndRefresh)
    // The provider mounted the relations hook exactly once (one auto-read).
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(listCalls).toBe(1)
  })

  it('serves an injected pre-built resource without creating a second one', async () => {
    // C9-style transition: an already-held resource is reused verbatim.
    const injected = makeInjectedResource()
    const first: ProbeRecorder = { current: null }
    const second: ProbeRecorder = { current: null }
    render(createElement(MemberCircleResourceProvider, {
      resource: injected,
      children: [
        createElement(ProbeChild, { key: 0, recorder: first }),
        createElement(ProbeChild, { key: 1, recorder: second }),
      ],
    }))
    expect(first.current).toBe(injected)
    expect(second.current).toBe(injected)
    // No second relations hook ran for the injected resource.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(listCalls).toBe(0)
  })

  it('throws a loud error when used outside a provider', () => {
    const recorder: ProbeRecorder = { current: null }
    let renderError: Error | null = null
    try {
      render(createElement(ProbeChild, { recorder }))
    } catch (error) {
      renderError = error as Error
    }
    expect(renderError).toBeInstanceOf(Error)
    expect(renderError!.message).toContain('useMemberCircles must be used within MemberCircleResourceProvider')
    expect(recorder.current).toBeNull()
  })

  it('wires the injected H1 catalog instance into invalidateAndRefresh', async () => {
    let syncCalls = 0
    // Mirrors the real instance shape: sync() resolves (never rejects) and
    // the settled state lives on the instance itself.
    const catalog = {
      state: {
        errorCode: null,
        catalog: { accountId: 'account-a', organizationId: 'personal-space' },
      },
      sync: async () => {
        syncCalls += 1
      },
    } as unknown as import('@/hooks/useAppCatalog').AppCatalogInstance
    const recorder: ProbeRecorder = { current: null }
    render(createElement(MemberCircleResourceProvider, {
      catalog,
      children: createElement(ProbeChild, { recorder }),
    }))
    expect(recorder.current).not.toBeNull()
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const outcome = await act(async () => {
      return recorder.current!.invalidateAndRefresh({ circleId: 'circle-1' })
    })
    // The SAME injected instance was refreshed together with the relations;
    // 'refreshed' is judged from the instance's settled state (live catalog,
    // no errorCode), not merely from the call having been issued.
    expect(syncCalls).toBe(1)
    expect(outcome).toMatchObject({ relations: 'refreshed', catalog: 'refreshed', circleId: 'circle-1' })
    expect(listCalls).toBe(2)
  })

  it('reports catalog FAILED when the injected instance settled into an errorCode without rejecting', async () => {
    let syncCalls = 0
    const catalog = {
      state: {
        errorCode: 'ADMIN_UNAVAILABLE',
        catalog: null,
      },
      sync: async () => {
        syncCalls += 1
      },
    } as unknown as import('@/hooks/useAppCatalog').AppCatalogInstance
    const recorder: ProbeRecorder = { current: null }
    render(createElement(MemberCircleResourceProvider, {
      catalog,
      children: createElement(ProbeChild, { recorder }),
    }))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const outcome = await act(async () => {
      return recorder.current!.invalidateAndRefresh()
    })
    expect(syncCalls).toBe(1)
    expect(outcome).toMatchObject({ relations: 'refreshed', catalog: 'failed' })
  })
})
