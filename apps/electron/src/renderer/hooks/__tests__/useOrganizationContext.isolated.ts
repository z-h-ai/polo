import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useEffect, useState } from 'react'

GlobalRegistrator.register()

const { act, cleanup, render, renderHook, screen } = await import('@testing-library/react')
const { useOrganizationContextState } = await import('../useOrganizationContext')
const { subscribeToAdminAuthFailures } = await import('@/lib/admin-auth-failure')
const {
  clearPendingOrganizationJoinToken,
  getStoredActiveOrganizationId,
  getUnavailableOrganizationTombstone,
  getVerifiedOrganizationContext,
  setPendingOrganizationJoinToken,
  setStoredActiveOrganizationId,
} = await import('@/lib/organization-storage')

const organizations = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'creator_space' as const,
    name: 'Studio',
    purpose: 'Publish apps',
    membership: {
      id: '21111111-1111-4111-8111-111111111111',
      role: 'owner' as const,
      status: 'active' as const,
    },
    memberCount: 1,
  },
  {
    id: '12222222-2222-4222-8222-222222222222',
    type: 'enterprise_workspace' as const,
    name: 'Acme',
    purpose: 'Internal apps',
    membership: {
      id: '22222222-2222-4222-8222-222222222222',
      role: 'member' as const,
      status: 'active' as const,
    },
    memberCount: 4,
  },
]

type OrganizationListResult = Awaited<ReturnType<Window['electronAPI']['organizationList']>>
type OrganizationPreviewJoinResult = Awaited<
  ReturnType<Window['electronAPI']['organizationPreviewJoin']>
>
type OrganizationCreateResult = Awaited<
  ReturnType<Window['electronAPI']['organizationCreate']>
>
type OrganizationAcceptJoinResult = Awaited<
  ReturnType<Window['electronAPI']['organizationAcceptJoin']>
>

let organizationList = mock(async (): Promise<OrganizationListResult> => ({
  success: true as const,
  organizations,
}))
let organizationPreviewJoin = mock(async (
  _token: string,
): Promise<OrganizationPreviewJoinResult> => ({
  success: true as const,
  organization: organizations[0],
  join: {
    kind: 'join_link' as const,
    effectiveStatus: 'active' as const,
    expiresAt: null,
    usesRemaining: null,
    requiresPhoneMatch: false,
  },
}))
let organizationCreate = mock(async (_input: {
  type: 'creator_space' | 'enterprise_workspace'
  name: string
  purpose: string
  idempotencyKey: string
}): Promise<OrganizationCreateResult> => ({
  success: true as const,
  organization: organizations[0],
  membership: organizations[0].membership,
  replayed: false,
}))
let organizationAcceptJoin = mock(async (
  _token: string,
): Promise<OrganizationAcceptJoinResult> => ({
  success: true as const,
  membership: {
    ...organizations[1].membership,
    organizationId: organizations[1].id,
    userId: 'user-race',
  },
  replayed: false,
}))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  organizationList = mock(async (): Promise<OrganizationListResult> => ({
    success: true as const,
    organizations,
  }))
  organizationPreviewJoin = mock(async (
    _token: string,
  ): Promise<OrganizationPreviewJoinResult> => ({
    success: true as const,
    organization: organizations[0],
    join: {
      kind: 'join_link' as const,
      effectiveStatus: 'active' as const,
      expiresAt: null,
      usesRemaining: null,
      requiresPhoneMatch: false,
    },
  }))
  organizationCreate = mock(async (_input: {
    type: 'creator_space' | 'enterprise_workspace'
    name: string
    purpose: string
    idempotencyKey: string
  }): Promise<OrganizationCreateResult> => ({
    success: true as const,
    organization: organizations[0],
    membership: organizations[0].membership,
    replayed: false,
  }))
  organizationAcceptJoin = mock(async (
    _token: string,
  ): Promise<OrganizationAcceptJoinResult> => ({
    success: true as const,
    membership: {
      ...organizations[1].membership,
      organizationId: organizations[1].id,
      userId: 'user-race',
    },
    replayed: false,
  }))
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      organizationList: (...args: []) => organizationList(...args),
      organizationPreviewJoin: (...args: [string]) => organizationPreviewJoin(...args),
      organizationCreate: (...args: [Parameters<typeof organizationCreate>[0]]) =>
        organizationCreate(...args),
      organizationAcceptJoin: (...args: [string]) => organizationAcceptJoin(...args),
    },
  })
})

afterEach(() => {
  cleanup()
  clearPendingOrganizationJoinToken()
})

describe('useOrganizationContextState', () => {
  it('prioritizes a pending join over organization selection and restores selection after dismissal', async () => {
    setPendingOrganizationJoinToken('join-token-12345678901234567890')
    const { result } = renderHook(() => useOrganizationContextState())

    let next: string | null | undefined
    await act(async () => {
      next = await result.current.bootstrap('account-1')
    })

    expect(next).toBe('join')
    expect(result.current.flowState).toBe('join')
    expect(result.current.joinPreview?.organization.name).toBe('Studio')
    expect(organizationList).toHaveBeenCalledTimes(1)
    expect(organizationPreviewJoin).toHaveBeenCalledWith(
      'join-token-12345678901234567890',
    )

    act(() => {
      expect(result.current.dismissJoin()).toBe('select')
    })
    expect(result.current.flowState).toBe('select')

    act(() => {
      result.current.selectOrganization(organizations[1].id)
    })
    expect(result.current.activeOrganizationId).toBe(organizations[1].id)
    expect(result.current.organizationMembershipRole).toBe('member')
    expect(result.current.organizationContextKey).toBe(
      `account-1:${organizations[1].id}`,
    )
    expect(getStoredActiveOrganizationId('account-1')).toBe(organizations[1].id)
    expect(getStoredActiveOrganizationId('account-2')).toBeNull()
  })

  it('routes an account with no organizations to creation', async () => {
    organizationList = mock(async () => ({
      success: true as const,
      organizations: [],
    }))
    const { result } = renderHook(() => useOrganizationContextState())

    await act(async () => {
      expect(await result.current.bootstrap('new-account')).toBe('create')
    })

    expect(result.current.flowState).toBe('create')
    expect(result.current.activeOrganizationId).toBeNull()
  })

  it('automatically activates the sole organization when the stored selection is stale', async () => {
    organizationList = mock(async () => ({
      success: true as const,
      organizations: [organizations[0]],
    }))
    setStoredActiveOrganizationId(
      'returning-account',
      '19999999-9999-4999-8999-999999999999',
    )
    const { result } = renderHook(() => useOrganizationContextState())

    await act(async () => {
      expect(await result.current.bootstrap('returning-account')).toBe('ready')
    })

    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeOrganizationId).toBe(organizations[0].id)
    expect(getStoredActiveOrganizationId('returning-account')).toBe(organizations[0].id)
  })

  it('restores the verified organization on valid-token and refresh network failures', async () => {
    const online = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await online.result.current.bootstrap('offline-account')
    })
    act(() => {
      online.result.current.selectOrganization(organizations[1].id)
    })
    online.unmount()

    expect(getVerifiedOrganizationContext('offline-account')).toMatchObject({
      activeOrganizationId: organizations[1].id,
      organizationSummaries: organizations,
    })

    for (const errorCode of ['NETWORK_ERROR', 'TIMEOUT'] as const) {
      organizationList = mock(async (): Promise<OrganizationListResult> => ({
        success: false,
        errorCode,
        status: errorCode === 'NETWORK_ERROR' ? 503 : undefined,
      }))
      const offline = renderHook(() => useOrganizationContextState())
      await act(async () => {
        expect(await offline.result.current.bootstrap('offline-account')).toBe('ready')
      })
      expect(offline.result.current.activeOrganizationId).toBe(organizations[1].id)
      expect(offline.result.current.organizationMembershipRole).toBe('member')
      expect(offline.result.current.organizationSummaries).toEqual(organizations)
      offline.unmount()
    }
  })

  it('fails closed and removes the organization cache after an explicit 403', async () => {
    const online = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await online.result.current.bootstrap('revoked-account')
    })
    act(() => {
      online.result.current.selectOrganization(organizations[0].id)
    })
    online.unmount()

    const authFailures: string[] = []
    const unsubscribe = subscribeToAdminAuthFailures(error => {
      authFailures.push(error.code)
    })
    organizationList = mock(async (): Promise<OrganizationListResult> => ({
      success: false,
      errorCode: 'FORBIDDEN',
      status: 403,
    }))
    const revoked = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await revoked.result.current.bootstrap('revoked-account').catch(() => {})
    })

    expect(revoked.result.current.flowState).toBe('loading')
    expect(revoked.result.current.activeOrganizationId).toBeNull()
    expect(getVerifiedOrganizationContext('revoked-account')).toBeNull()
    expect(authFailures).toEqual(['FORBIDDEN'])
    unsubscribe()
  })

  it('retains a read-only tombstone when the current organization is removed or suspended', async () => {
    for (const nextOrganizations of [
      [],
      [{
        ...organizations[0],
        membership: {
          ...organizations[0].membership,
          status: 'suspended' as const,
        },
      }],
    ]) {
      localStorage.clear()
      const unavailableMembershipStatus = nextOrganizations.length > 0
        ? 'suspended'
        : 'removed'
      organizationList = mock(async (): Promise<OrganizationListResult> => ({
        success: true,
        organizations: [organizations[0]],
      }))
      const online = renderHook(() => useOrganizationContextState())
      await act(async () => {
        expect(await online.result.current.bootstrap('lost-membership'))
          .toBe('ready')
      })
      expect(online.result.current.activeOrganizationId)
        .toBe(organizations[0].id)

      organizationList = mock(async (): Promise<OrganizationListResult> => ({
        success: true,
        organizations: nextOrganizations,
      }))
      await act(async () => {
        await online.result.current.refreshOrganizations()
      })
      expect(online.result.current.activeOrganizationId)
        .toBe(organizations[0].id)
      expect(online.result.current.flowState).toBe('ready')
      expect(online.result.current.activeOrganization).toMatchObject({
        id: organizations[0].id,
        status: 'suspended',
        membership: { status: unavailableMembershipStatus },
      })
      expect(getStoredActiveOrganizationId('lost-membership')).toBeNull()
      expect(getVerifiedOrganizationContext('lost-membership'))
        .toMatchObject({ activeOrganizationId: null })
      expect(getUnavailableOrganizationTombstone('lost-membership'))
        .toMatchObject({
          organization: {
            id: organizations[0].id,
            status: 'suspended',
            membership: { status: unavailableMembershipStatus },
          },
        })
      expect(() => {
        online.result.current.selectOrganization(organizations[0].id)
      }).toThrow()
      online.unmount()

      organizationList = mock(async (): Promise<OrganizationListResult> => ({
        success: true,
        organizations: nextOrganizations,
      }))
      const rebuilt = renderHook(() => useOrganizationContextState())
      await act(async () => {
        expect(await rebuilt.result.current.bootstrap('lost-membership'))
          .toBe('ready')
      })
      expect(rebuilt.result.current.activeOrganizationId)
        .toBe(organizations[0].id)
      expect(rebuilt.result.current.activeOrganization).toMatchObject({
        status: 'suspended',
        membership: { status: unavailableMembershipStatus },
      })
      rebuilt.unmount()

      organizationList = mock(async (): Promise<OrganizationListResult> => ({
        success: false,
        errorCode: 'NETWORK_ERROR',
        status: 503,
      }))
      const offline = renderHook(() => useOrganizationContextState())
      await act(async () => {
        expect(await offline.result.current.bootstrap('lost-membership'))
          .toBe('ready')
      })
      expect(offline.result.current.activeOrganizationId)
        .toBe(organizations[0].id)
      expect(offline.result.current.flowState).toBe('ready')
      expect(offline.result.current.activeOrganization?.membership.status)
        .toBe(unavailableMembershipStatus)
      offline.unmount()
    }
  })

  it('discards account A bootstrap after clearing A and bootstrapping account B', async () => {
    let resolveAccountA!: (value: OrganizationListResult) => void
    let resolveAccountB!: (value: OrganizationListResult) => void
    let requestCount = 0
    organizationList = mock(() => new Promise<OrganizationListResult>(resolve => {
      requestCount += 1
      if (requestCount === 1) resolveAccountA = resolve
      if (requestCount === 2) resolveAccountB = resolve
    }))

    const { result } = renderHook(() => useOrganizationContextState())
    let bootstrapAccountA!: ReturnType<typeof result.current.bootstrap>
    act(() => {
      bootstrapAccountA = result.current.bootstrap('account-a')
    })
    act(() => {
      result.current.clearAccount('account-a')
    })
    let bootstrapAccountB!: ReturnType<typeof result.current.bootstrap>
    act(() => {
      bootstrapAccountB = result.current.bootstrap('account-b')
    })

    await act(async () => {
      resolveAccountB({
        success: true,
        organizations: [organizations[1]],
      })
      expect(await bootstrapAccountB).toBe('ready')
    })
    expect(result.current.accountId).toBe('account-b')
    expect(result.current.organizationSummaries).toEqual([organizations[1]])
    expect(result.current.activeOrganizationId).toBe(organizations[1].id)
    expect(result.current.organizationMembershipRole).toBe('member')

    await act(async () => {
      resolveAccountA({
        success: true,
        organizations: [organizations[0]],
      })
      expect(await bootstrapAccountA).toBeNull()
    })

    expect(result.current.accountId).toBe('account-b')
    expect(result.current.organizationSummaries).toEqual([organizations[1]])
    expect(result.current.activeOrganizationId).toBe(organizations[1].id)
    expect(result.current.organizationMembershipRole).toBe('member')
    expect(result.current.flowState).toBe('ready')
    expect(getStoredActiveOrganizationId('account-a')).toBeNull()
    expect(getStoredActiveOrganizationId('account-b')).toBe(organizations[1].id)
  })

  it('confirms the owner membership before activating a newly created organization', async () => {
    organizationList = mock(async () => ({
      success: true as const,
      organizations: [],
    }))
    const { result } = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await result.current.bootstrap('new-owner')
    })

    organizationList = mock(async () => ({
      success: true as const,
      organizations: [organizations[0]],
    }))
    const input = {
      type: 'creator_space' as const,
      name: 'Studio',
      purpose: 'Publish apps',
      idempotencyKey: 'create-studio-1',
    }
    await act(async () => {
      await result.current.createOrganization(input)
    })

    expect(organizationCreate).toHaveBeenCalledWith(input)
    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeOrganizationId).toBe(organizations[0].id)
    expect(result.current.organizationMembershipRole).toBe('owner')
  })

  it('discards out-of-order join previews and accepts only the token bound to the visible preview', async () => {
    const tokenA = 'join-token-aaaaaaaaaaaaaaaaaaaa'
    const tokenB = 'join-token-bbbbbbbbbbbbbbbbbbbb'
    type PreviewResult = Awaited<ReturnType<typeof organizationPreviewJoin>>
    let resolvePreviewA!: (value: PreviewResult) => void
    let resolvePreviewB!: (value: PreviewResult) => void
    organizationPreviewJoin = mock((token: string) => new Promise<PreviewResult>(resolve => {
      if (token === tokenA) resolvePreviewA = resolve
      if (token === tokenB) resolvePreviewB = resolve
    }))

    const { result } = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await result.current.bootstrap('account-race')
    })

    let previewA!: Promise<void>
    let previewB!: Promise<void>
    act(() => {
      previewA = result.current.receiveJoinToken(tokenA)
      previewB = result.current.receiveJoinToken(tokenB)
    })

    await act(async () => {
      resolvePreviewB({
        success: true,
        organization: organizations[1],
        join: {
          kind: 'join_link',
          effectiveStatus: 'active',
          expiresAt: null,
          usesRemaining: null,
          requiresPhoneMatch: false,
        },
      })
      await previewB
    })
    expect(result.current.joinPreview?.organization.name).toBe('Acme')

    await act(async () => {
      resolvePreviewA({
        success: true,
        organization: organizations[0],
        join: {
          kind: 'join_link',
          effectiveStatus: 'active',
          expiresAt: null,
          usesRemaining: null,
          requiresPhoneMatch: false,
        },
      })
      await previewA
    })
    expect(result.current.joinPreview?.organization.name).toBe('Acme')

    await act(async () => {
      await result.current.acceptJoin()
    })
    expect(organizationAcceptJoin).toHaveBeenCalledTimes(1)
    expect(organizationAcceptJoin).toHaveBeenCalledWith(tokenB)
    expect(result.current.activeOrganizationId).toBe(organizations[1].id)
  })

  it('routes an organizationList auth failure back to the phone login flow', async () => {
    organizationList = mock(async (): Promise<OrganizationListResult> => ({
      success: false,
      errorCode: 'TOKEN_EXPIRED',
      status: 401,
    }))

    function AuthRoutingHarness() {
      const organization = useOrganizationContextState()
      const [route, setRoute] = useState<'organization' | 'phone-login'>('organization')
      useEffect(() => subscribeToAdminAuthFailures(() => {
        setRoute('phone-login')
      }), [])
      useEffect(() => {
        void organization.bootstrap('expired-account').catch(() => {})
      }, [])
      return createElement('div', null, route)
    }

    render(createElement(AuthRoutingHarness))
    expect(await screen.findByText('phone-login')).toBeTruthy()
  })

  it('emits the same auth failure for organization creation and invitation acceptance', async () => {
    const authFailures: string[] = []
    const unsubscribe = subscribeToAdminAuthFailures(error => {
      authFailures.push(error.code)
    })
    organizationList = mock(async (): Promise<OrganizationListResult> => ({
      success: true,
      organizations: [],
    }))
    organizationCreate = mock(async (): Promise<OrganizationCreateResult> => ({
      success: false,
      errorCode: 'INVALID_TOKEN',
      status: 401,
    }))
    const { result } = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await result.current.bootstrap('expired-account')
    })
    await act(async () => {
      await result.current.createOrganization({
        type: 'creator_space',
        name: 'Studio',
        purpose: 'Publish apps',
        idempotencyKey: 'expired-create-request',
      }).catch(() => {})
    })

    organizationPreviewJoin = mock(async (): Promise<OrganizationPreviewJoinResult> => ({
      success: true,
      organization: organizations[1],
      join: {
        kind: 'invitation',
        effectiveStatus: 'active',
        expiresAt: null,
        usesRemaining: 1,
        requiresPhoneMatch: true,
      },
    }))
    organizationAcceptJoin = mock(async (): Promise<OrganizationAcceptJoinResult> => ({
      success: false,
      errorCode: 'UNAUTHORIZED',
      status: 401,
    }))
    await act(async () => {
      await result.current.receiveJoinToken('auth-failure-token-abcdefghijklmnopqrstuvwxyz')
    })
    await act(async () => {
      await result.current.acceptJoin().catch(() => {})
    })

    expect(authFailures).toEqual(['INVALID_TOKEN', 'UNAUTHORIZED'])
    unsubscribe()
  })

  it('keeps invitation B visible when acceptance of invitation A completes stale', async () => {
    const tokenA = 'accept-token-aaaaaaaaaaaaaaaaaaaa'
    const tokenB = 'accept-token-bbbbbbbbbbbbbbbbbbbb'
    let resolveAcceptA!: (value: OrganizationAcceptJoinResult) => void
    organizationAcceptJoin = mock(() => new Promise<OrganizationAcceptJoinResult>(resolve => {
      resolveAcceptA = resolve
    }))
    organizationPreviewJoin = mock(async (token: string): Promise<OrganizationPreviewJoinResult> => ({
      success: true,
      organization: token === tokenB ? organizations[1] : organizations[0],
      join: {
        kind: 'join_link',
        effectiveStatus: 'active',
        expiresAt: null,
        usesRemaining: null,
        requiresPhoneMatch: false,
      },
    }))

    const { result } = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await result.current.bootstrap('account-stale-accept')
      await result.current.receiveJoinToken(tokenA)
    })

    let acceptA!: ReturnType<typeof result.current.acceptJoin>
    act(() => {
      acceptA = result.current.acceptJoin()
    })
    await act(async () => {
      await result.current.receiveJoinToken(tokenB)
    })
    let outcome!: Awaited<typeof acceptA>
    await act(async () => {
      resolveAcceptA({
        success: true,
        membership: {
          ...organizations[0].membership,
          organizationId: organizations[0].id,
          userId: 'user-stale-accept',
        },
        replayed: false,
      })
      outcome = await acceptA
    })

    expect(outcome.completed).toBe(false)
    expect(result.current.flowState).toBe('join')
    expect(result.current.pendingJoinToken).toBe(tokenB)
    expect(result.current.joinPreview?.organization.name).toBe('Acme')
    expect(result.current.activeOrganizationId).toBeNull()
  })

  it('ignores a late organization A refresh after switching to organization B', async () => {
    const { result } = renderHook(() => useOrganizationContextState())
    await act(async () => {
      await result.current.bootstrap('account-refresh-race')
    })
    act(() => {
      result.current.selectOrganization(organizations[0].id)
    })

    let resolveRefresh!: (value: OrganizationListResult) => void
    organizationList = mock(() => new Promise<OrganizationListResult>(resolve => {
      resolveRefresh = resolve
    }))
    let refreshPromise!: ReturnType<typeof result.current.refreshOrganizations>
    act(() => {
      refreshPromise = result.current.refreshOrganizations()
    })
    act(() => {
      result.current.selectOrganization(organizations[1].id)
    })

    await act(async () => {
      resolveRefresh({
        success: true,
        organizations: organizations.map((item, index) => ({
          ...item,
          name: `Stale ${item.name}`,
          membership: {
            ...item.membership,
            role: index === 0 ? 'manager' : 'owner',
          },
        })),
      })
      await refreshPromise
    })

    expect(result.current.activeOrganizationId).toBe(organizations[1].id)
    expect(result.current.organizationMembershipRole).toBe(
      organizations[1].membership.role,
    )
    expect(result.current.organizationSummaries.map(item => item.name)).toEqual(
      organizations.map(item => item.name),
    )
    expect(result.current.flowState).toBe('ready')
  })
})
