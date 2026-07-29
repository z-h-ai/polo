import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useOrganizationContextState } = await import('../useOrganizationContext')
const {
  clearPendingOrganizationJoinToken,
  getStoredActiveOrganizationId,
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

let organizationList = mock(async () => ({
  success: true as const,
  organizations,
}))
let organizationPreviewJoin = mock(async (_token: string) => ({
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
}) => ({
  success: true as const,
  organization: organizations[0],
  membership: organizations[0].membership,
  replayed: false,
}))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  organizationList = mock(async () => ({
    success: true as const,
    organizations,
  }))
  organizationPreviewJoin = mock(async (_token: string) => ({
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
  }) => ({
    success: true as const,
    organization: organizations[0],
    membership: organizations[0].membership,
    replayed: false,
  }))
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      organizationList: (...args: []) => organizationList(...args),
      organizationPreviewJoin: (...args: [string]) => organizationPreviewJoin(...args),
      organizationCreate: (...args: [Parameters<typeof organizationCreate>[0]]) =>
        organizationCreate(...args),
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

    let next: string | undefined
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
})
