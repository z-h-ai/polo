/* eslint-disable polo-ai/no-localstorage -- exercises one-time legacy migration */
import { beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type {
  OrganizationContextStorage,
  OrganizationContextStoragePatch,
} from '@polo-ai/shared/config/organization-context'

GlobalRegistrator.register()

const {
  getOrganizationContextStorage,
  getStoredActiveOrganizationId,
  getUnavailableOrganizationTombstone,
  getVerifiedOrganizationContext,
  resetOrganizationStorageMemoryForTests,
  setUnavailableOrganizationContext,
  setVerifiedOrganizationContext,
} = await import('../organization-storage')

const accountId = 'account:persistent\0设备'
const organization = {
  id: 'organization:persistent\0组织',
  type: 'creator_space' as const,
  name: 'Studio',
  purpose: 'Publish apps',
  membership: {
    id: 'membership:persistent',
    role: 'owner' as const,
    status: 'active' as const,
  },
  memberCount: 1,
}

let persisted = new Map<string, OrganizationContextStorage>()
let failUpdates = false

function installPreferencesApi(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getOrganizationContextStorage: async (targetAccountId: string) =>
        persisted.get(targetAccountId) ?? null,
      updateOrganizationContextStorage: async (
        targetAccountId: string,
        patch: OrganizationContextStoragePatch,
      ) => {
        if (failUpdates) throw new Error('preferences unavailable')
        const next = { ...(persisted.get(targetAccountId) ?? {}) }
        if (patch.verifiedContext === null) delete next.verifiedContext
        else if (patch.verifiedContext) {
          next.verifiedContext = patch.verifiedContext
        }
        if (patch.unavailableTombstone === null) {
          delete next.unavailableTombstone
        } else if (patch.unavailableTombstone) {
          next.unavailableTombstone = patch.unavailableTombstone
        }
        persisted.set(targetAccountId, next)
        return next
      },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  resetOrganizationStorageMemoryForTests()
  persisted = new Map()
  failUpdates = false
  installPreferencesApi()
})

describe('organization preferences storage', () => {
  it('persists verified snapshots and unavailable tombstones through RPC', async () => {
    await setVerifiedOrganizationContext(
      accountId,
      [organization],
      organization.id,
    )
    expect(await getVerifiedOrganizationContext(accountId)).toMatchObject({
      activeOrganizationId: organization.id,
      organizationSummaries: [organization],
    })

    await setUnavailableOrganizationContext(accountId, [], organization)
    expect(await getUnavailableOrganizationTombstone(accountId)).toMatchObject({
      organization: {
        id: organization.id,
        status: 'suspended',
        membership: { status: 'removed' },
      },
    })
    expect(await getVerifiedOrganizationContext(accountId)).toMatchObject({
      activeOrganizationId: null,
      organizationSummaries: [],
    })
    expect(localStorage.length).toBe(0)
  })

  it('migrates valid legacy values once and clears them after durable success', async () => {
    const verifiedKey = `polo-verified-organization-context:${accountId}`
    const unavailableKey = `polo-unavailable-organization:${accountId}`
    const activeKey = `polo-active-organization:${accountId}`
    const verifiedContext = {
      organizationSummaries: [organization],
      activeOrganizationId: organization.id,
      verifiedAt: 42,
    }
    const unavailableTombstone = {
      organization: {
        ...organization,
        status: 'suspended' as const,
        membership: {
          ...organization.membership,
          status: 'removed' as const,
        },
      },
      recordedAt: 43,
    }
    localStorage.setItem(verifiedKey, JSON.stringify(verifiedContext))
    localStorage.setItem(unavailableKey, JSON.stringify(unavailableTombstone))
    localStorage.setItem(activeKey, organization.id)

    expect(await getOrganizationContextStorage(accountId)).toEqual({
      verifiedContext,
      unavailableTombstone,
    })
    expect(persisted.get(accountId)).toEqual({
      verifiedContext,
      unavailableTombstone,
    })
    expect(localStorage.getItem(verifiedKey)).toBeNull()
    expect(localStorage.getItem(unavailableKey)).toBeNull()
    expect(localStorage.getItem(activeKey)).toBeNull()
    expect(getStoredActiveOrganizationId(accountId)).toBe(organization.id)

    expect(await getOrganizationContextStorage(accountId)).toEqual({
      verifiedContext,
      unavailableTombstone,
    })
  })

  it('keeps legacy values when the preferences migration fails', async () => {
    const verifiedKey = `polo-verified-organization-context:${accountId}`
    const verifiedContext = {
      organizationSummaries: [organization],
      activeOrganizationId: organization.id,
      verifiedAt: 42,
    }
    localStorage.setItem(verifiedKey, JSON.stringify(verifiedContext))
    failUpdates = true

    expect(await getOrganizationContextStorage(accountId)).toEqual({
      verifiedContext,
    })
    expect(localStorage.getItem(verifiedKey)).not.toBeNull()
    expect(persisted.has(accountId)).toBe(false)
  })
})
