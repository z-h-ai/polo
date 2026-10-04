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
const toastErrorSpy = jest.fn()
const toastSuccessSpy = jest.fn()

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps: BUILTIN_APP_DEFINITIONS,
    openApp,
    removeApp: async () => {},
  }),
}))

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorSpy(...args),
    success: (...args: unknown[]) => toastSuccessSpy(...args),
  },
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
)
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { MemberCatalogProvider } = await import('@/context/MemberCatalogContext')
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
      onStopSwitchExecution: () => {},
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
          // H3 mount contract: HomePage consumes the catalog through the
          // App-level MemberCatalogProvider (own-instance branch of the REAL
          // hook — this harness wires the REAL RPCs below).
          children: createElement(
            MemberCatalogProvider,
            null,
            createElement(HomePage),
          ),
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
  toastErrorSpy.mockClear()
  toastSuccessSpy.mockClear()
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
        if (patch.legacyCleanup === null) delete next.legacyCleanup
        else if (patch.legacyCleanup) {
          next.legacyCleanup = patch.legacyCleanup
        }
        productSpaceContextStorage = next
        return next
      },
      productSpacePrepareSwitch: async (targetProductSpaceId: string) => ({
        success: true as const,
        token: `token-${targetProductSpaceId}`,
        from: null,
        to: targetProductSpaceId,
        executions: [],
      }),
      productSpaceStopSwitchExecutions: async () => ({
        success: true as const,
        executions: [],
      }),
      productSpaceCommitSwitch: async (_token: string, targetProductSpaceId: string) => ({
        success: true as const,
        from: null,
        to: targetProductSpaceId,
      }),
      productSpaceCancelSwitch: async () => ({ success: true }),
      productSpaceRestoreOfflineView: async () => ({
        success: true as const,
        snapshot: {
          contractVersion: 1,
          personalProductSpaceId: 'space-personal-offline',
          productSpaces: [
            {
              id: 'space-personal-offline',
              kind: 'personal' as const,
              name: '我的空间',
              accessMode: 'active' as const,
              payer: { kind: 'account' as const },
            },
            {
              id: enterpriseSpaceId,
              kind: 'enterprise' as const,
              enterpriseId: 'enterprise-offline',
              name: 'Offline Studio',
              role: 'member' as const,
              accessMode: 'active' as const,
              payer: { kind: 'enterprise' as const, enterpriseId: 'enterprise-offline' },
            },
          ],
          activeProductSpaceId: enterpriseSpaceId,
        },
      }),
      productSpaceRevokeActiveContext: async () => ({ success: true }),
      productSpaceGetRestrictionState: async () => ({ success: true as const, restricted: false }),
      productSpaceCleanupLegacyState: async () => ({
        success: true,
        results: {
          legacyRuntimeStopped: true,
          registeredExecutionsStopped: true,
          legacySessionIndexRemoved: true,
          legacyInstallationStateRemoved: true,
          legacyCatalogCacheRemoved: true,
          legacySkillCachesRemoved: true,
          legacyAuthorizationCacheRemoved: true,
        },
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
          artifactInstanceId: 'offline-app-instance',
          version: { versionId: 'offline-app-version', version: '1.0.0' },
          name: 'Offline App',
          description: 'Prepared locally',
          availability: 'available',
          deliveryMode: 'local_bundle',
          // H1 projection contract: the row must prove its authorization from
          // authoritative sources — an unprovable row is refused fail-closed.
          sources: [{ kind: 'enterprise_import', name: 'Offline Studio' }],
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
  it('restores the verified ProductSpace but fails a new launch closed', async () => {
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AppHomeHarness),
    ))

    // H3 home: the complete directory renders directly on the page — the
    // offline App row stays visible with the offline banner, and opening it
    // fails closed BEFORE any launch authority is asked.
    await waitFor(() => {
      expect(screen.getByTestId('home-directory-offline-banner')).toBeTruthy()
      expect(screen.getByTestId('home-directory-app')).toBeTruthy()
      expect(screen.getByText('Offline App')).toBeTruthy()
      expect(screen.getByText(/You are offline/)).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('home-directory-app'))
    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalled()
    })
    expect(start).not.toHaveBeenCalled()
    expect(openApp).not.toHaveBeenCalled()
  })
})
