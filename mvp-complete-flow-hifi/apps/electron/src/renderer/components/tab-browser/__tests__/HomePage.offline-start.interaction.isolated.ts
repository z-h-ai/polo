import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useEffect } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { CatalogLocalAppScope } from '@polo-ai/shared/protocol'
import type {
  OrganizationContextStorage,
  OrganizationContextStoragePatch,
} from '@polo-ai/shared/config/organization-context'
import { BUILTIN_APP_DEFINITIONS } from '../../../../shared/tab-browser-types'

GlobalRegistrator.register()
setupI18n()

const openApp = jest.fn()

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps: BUILTIN_APP_DEFINITIONS,
    openApp,
    removeApp: async () => {},
  }),
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
)
const { OrganizationProvider } = await import('@/context/OrganizationContext')
const { useOrganizationContextState } = await import('@/hooks/useOrganizationContext')
const {
  resetOrganizationStorageMemoryForTests,
  setVerifiedOrganizationContext,
} = await import('@/lib/organization-storage')
const { HomePage } = await import('../HomePage')

const accountId = 'account-offline'
const organization = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'creator_space' as const,
  name: 'Offline Studio',
  purpose: 'Offline apps',
  membership: {
    id: '21111111-1111-4111-8111-111111111111',
    role: 'member' as const,
    status: 'active' as const,
  },
  memberCount: 1,
}
const catalogApp = {
  id: 'offline-app',
  organizationId: organization.id,
  name: 'Offline App',
  description: 'Prepared locally',
  deliveryMode: 'local_bundle' as const,
  currentRelease: {
    version: '1.0.0',
    runtime: 'static' as const,
    downloadUrl: 'https://example.com/offline-app.zip',
    checksum: 'a'.repeat(64),
    sizeBytes: 1,
  },
  sortOrder: 0,
  availability: 'available' as const,
}
const start = jest.fn(async (scope: CatalogLocalAppScope) => ({
  appId: scope.catalogAppId,
  scope,
  version: '1.0.0',
  url: 'http://127.0.0.1:9876',
  port: 9876,
}))
let organizationContextStorage: OrganizationContextStorage | null = null

function AppHomeHarness() {
  const context = useOrganizationContextState()
  useEffect(() => {
    void context.bootstrap(accountId)
  }, [context.bootstrap])

  const contextValue = (
    context.activeOrganizationId
    && context.organizationMembershipRole
    && context.organizationContextKey
  ) ? {
      accountId,
      activeOrganizationId: context.activeOrganizationId,
      organizationSummaries: context.organizationSummaries,
      organizationMembershipRole: context.organizationMembershipRole,
      organizationContextKey: context.organizationContextKey,
      contextVersion: context.contextVersion,
      onSelectOrganization: context.selectOrganization,
      onManageOrganization: () => {},
      onCreateOrganization: context.showCreate,
    } : null

  return contextValue
    ? createElement(
        OrganizationProvider,
        {
          value: contextValue,
          children: createElement(HomePage, { onAddApp: () => {} }),
        },
      )
    : createElement('div', { 'data-testid': 'organization-flow' }, context.flowState)
}

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  resetOrganizationStorageMemoryForTests()
  openApp.mockClear()
  start.mockClear()
  await i18n.changeLanguage('en')
  organizationContextStorage = null

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      organizationList: async () => ({
        success: false as const,
        errorCode: 'NETWORK_ERROR',
        status: 503,
        message: 'offline',
      }),
      getOrganizationContextStorage: async () => organizationContextStorage,
      updateOrganizationContextStorage: async (
        _accountId: string,
        patch: OrganizationContextStoragePatch,
      ) => {
        const next = { ...(organizationContextStorage ?? {}) }
        if (patch.verifiedContext === null) delete next.verifiedContext
        else if (patch.verifiedContext) {
          next.verifiedContext = patch.verifiedContext
        }
        if (patch.unavailableTombstone === null) {
          delete next.unavailableTombstone
        } else if (patch.unavailableTombstone) {
          next.unavailableTombstone = patch.unavailableTombstone
        }
        organizationContextStorage = next
        return next
      },
      adminSyncAppCatalog: async () => ({
        success: true as const,
        catalog: {
          accountId,
          organizationId: organization.id,
          authorizationStatus: 'authorized' as const,
          appConfigVersion: 'v1',
          syncedAt: 1,
          apps: [catalogApp],
        },
        source: 'cache' as const,
        refreshed: false,
        accessMode: 'offline' as const,
        warningCode: 'NETWORK_ERROR',
      }),
      localApps: {
        getHostInfo: async () => ({ platform: 'darwin' as const, arch: 'arm64' as const }),
        getRuntimeStatuses: async ({ scopes }: { scopes: CatalogLocalAppScope[] }) =>
          scopes.map(scope => ({
            appId: scope.catalogAppId,
            scope,
            status: 'stopped' as const,
            currentVersion: '1.0.0',
          })),
        start: (...args: [CatalogLocalAppScope]) => start(...args),
      },
    },
  })
  await setVerifiedOrganizationContext(
    accountId,
    [organization],
    organization.id,
  )
})

afterEach(() => {
  cleanup()
})

describe('restricted offline App to HomePage start flow', () => {
  it('restores the verified organization and starts a prepared local app', async () => {
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AppHomeHarness),
    ))

    await waitFor(() => {
      expect(screen.getByText('Offline App')).toBeTruthy()
      expect(screen.getByText(/You are offline/)).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('organization-app-action-offline-app'))

    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1)
      expect(openApp).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Offline App',
        url: 'http://127.0.0.1:9876',
      }))
    })
  })
})
