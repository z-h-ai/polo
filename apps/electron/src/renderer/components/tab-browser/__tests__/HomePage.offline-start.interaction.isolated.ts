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
  ProductSpaceContextStorage,
  ProductSpaceContextStoragePatch,
} from '@polo-ai/shared/config/product-space-context'
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
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { useProductSpaceContextState } = await import('@/hooks/useProductSpaceContext')
const {
  resetProductSpaceStorageMemoryForTests,
  setVerifiedProductSpaceContext,
} = await import('@/lib/product-space-storage')
const { HomePage } = await import('../HomePage')

const accountId = 'account-offline'
const personalSpaceId = 'space-personal-offline'
const enterpriseSpaceId = '11111111-1111-4111-8111-111111111111'
const catalogApp = {
  id: 'offline-app',
  organizationId: enterpriseSpaceId,
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
let productSpaceContextStorage: ProductSpaceContextStorage | null = null

function AppHomeHarness() {
  const context = useProductSpaceContextState()
  useEffect(() => {
    void context.bootstrap(accountId)
  }, [context.bootstrap])

  const contextValue = (
    context.activeProductSpaceId
    && context.activeProductSpace
    && context.personalProductSpaceId
    && context.productSpaceContextKey
  ) ? {
      accountId,
      activeProductSpaceId: context.activeProductSpaceId,
      activeProductSpace: context.activeProductSpace,
      productSpaces: context.productSpaces,
      allProductSpaces: context.allProductSpaces,
      personalProductSpaceId: context.personalProductSpaceId,
      productSpaceContextKey: context.productSpaceContextKey,
      contextVersion: context.contextVersion,
      pendingSwitch: context.pendingSwitch,
      onSelectProductSpace: (productSpaceId: string) => {
        void context.requestSwitch(productSpaceId)
      },
      onRefreshProductSpaces: () => {},
      onConfirmStopAndSwitch: () => {},
      onRetryFailedStops: () => {},
      onRetryTargetLoad: () => {},
      onCancelSwitch: () => {},
      onDismissTargetAccessLost: () => {},
    } : null

  return contextValue
    ? createElement(
        ProductSpaceProvider,
        {
          value: contextValue,
          children: createElement(HomePage, { onAddApp: () => {} }),
        },
      )
    : createElement('div', { 'data-testid': 'product-space-flow' }, context.flowState)
}

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  resetProductSpaceStorageMemoryForTests()
  openApp.mockClear()
  start.mockClear()
  await i18n.changeLanguage('en')
  productSpaceContextStorage = null

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      productSpaceList: async () => ({
        success: false as const,
        errorCode: 'NETWORK_ERROR',
        message: 'offline',
      }),
      productSpaceListActiveExecutions: async () => ({
        success: true as const,
        executions: [],
      }),
      productSpaceStopAllExecutions: async () => ({
        success: true as const,
        result: { allStopped: true, executions: [] },
      }),
      getProductSpaceContextStorage: async () => productSpaceContextStorage,
      updateProductSpaceContextStorage: async (
        _accountId: string,
        patch: ProductSpaceContextStoragePatch,
      ) => {
        const next = { ...(productSpaceContextStorage ?? {}) }
        if (patch.verifiedContext === null) delete next.verifiedContext
        else if (patch.verifiedContext) {
          next.verifiedContext = patch.verifiedContext
        }
        productSpaceContextStorage = next
        return next
      },
      productSpaceSetActiveSpace: async () => ({ success: true }),
      productSpaceCleanupLegacyState: async () => ({
        success: true,
        results: {},
      }),
      productSpaceGetCatalog: async () => ({
        success: true as const,
        notModified: false as const,
        catalogRevision: 'v1',
        productSpaceId: enterpriseSpaceId,
        accessMode: 'offline' as const,
        warningCode: 'NETWORK_ERROR',
        entries: [{
          kind: 'app',
          catalogEntryId: 'offline-app',
          name: 'Offline App',
          description: 'Prepared locally',
          availability: 'available',
          deliveryMode: 'local_bundle',
          currentRelease: {
            version: '1.0.0',
            runtime: 'static' as const,
            downloadUrl: 'https://example.com/offline-app.zip',
            checksum: 'a'.repeat(64),
            sizeBytes: 1,
          },
        }],
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
  await setVerifiedProductSpaceContext(
    accountId,
    {
      contractVersion: 1,
      personalProductSpaceId: personalSpaceId,
      productSpaces: [
        {
          id: personalSpaceId,
          kind: 'personal',
          name: '我的空间',
          accessMode: 'active',
          payer: { kind: 'account' },
        },
        {
          id: enterpriseSpaceId,
          kind: 'enterprise',
          enterpriseId: 'enterprise-offline',
          name: 'Offline Studio',
          role: 'member',
          accessMode: 'active',
          payer: { kind: 'enterprise', enterpriseId: 'enterprise-offline' },
        },
      ],
    },
    enterpriseSpaceId,
  )
})

afterEach(() => {
  cleanup()
})

describe('restricted offline App to HomePage start flow', () => {
  it('restores the verified ProductSpace and starts a prepared local app', async () => {
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
