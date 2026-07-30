import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type {
  AppCatalogCacheEntry,
  AppCatalogSyncResult,
  CatalogApp,
} from '@polo-ai/shared/admin'
import type {
  CatalogLocalAppScope,
  LocalAppRuntimeStatus,
  LocalAppStartResult,
} from '@polo-ai/shared/protocol'

GlobalRegistrator.register()

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

function app(organizationId: string): CatalogApp {
  return {
    id: 'shared-app-id',
    organizationId,
    name: `App ${organizationId}`,
    description: '',
    deliveryMode: 'local_bundle',
    currentRelease: {
      version: '1.0.0',
      runtime: 'static',
      downloadUrl: 'https://example.com/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
    },
    sortOrder: 0,
    availability: 'available',
  }
}

function catalog(organizationId: string, appConfigVersion: string): AppCatalogCacheEntry {
  return {
    accountId: 'account-a',
    organizationId,
    appConfigVersion,
    authorizationStatus: 'authorized',
    apps: [app(organizationId)],
    syncedAt: 1,
  }
}

function syncResult(
  organizationId: string,
  version: string,
): Extract<AppCatalogSyncResult, { success: true }> {
  return {
    success: true,
    catalog: catalog(organizationId, version),
    source: 'network',
    refreshed: true,
    accessMode: 'online',
  }
}

let organizationContext = organization('organization-a')
let syncCatalog = mock(async (
  organizationId: string,
  _options?: { force?: boolean },
): Promise<AppCatalogSyncResult> => syncResult(organizationId, 'initial'))
let getRuntimeStatuses = mock(async (
  request: { scopes: CatalogLocalAppScope[] },
): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
  appId: scope.catalogAppId,
  scope,
  status: 'not_installed',
})))
let startLocalApp = mock(async (
  scope: CatalogLocalAppScope,
): Promise<LocalAppStartResult> => ({
  appId: scope.catalogAppId,
  scope,
  version: '1.0.0',
  url: 'http://127.0.0.1:9876',
  port: 9876,
}))

function organization(organizationId: string) {
  return {
    accountId: 'account-a',
    activeOrganizationId: organizationId,
    organizationContextKey: `account-a:${organizationId}`,
    organizationSummaries: [{
      id: organizationId,
      type: 'creator_space' as const,
      name: organizationId,
      purpose: '',
      membership: {
        id: `membership-${organizationId}`,
        role: 'member' as const,
        status: 'active' as const,
      },
      memberCount: 1,
    }],
  }
}

mock.module('@/context/OrganizationContext', () => ({
  useOptionalOrganizationContext: () => organizationContext,
}))

const {
  act,
  cleanup,
  renderHook,
  waitFor,
} = await import('@testing-library/react')
const { useAppCatalog } = await import('../useAppCatalog')

beforeEach(() => {
  organizationContext = organization('organization-a')
  syncCatalog = mock(async (
    organizationId: string,
    _options?: { force?: boolean },
  ): Promise<AppCatalogSyncResult> => syncResult(organizationId, 'initial'))
  getRuntimeStatuses = mock(async (
    request: { scopes: CatalogLocalAppScope[] },
  ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
    appId: scope.catalogAppId,
    scope,
    status: 'not_installed',
  })))
  startLocalApp = mock(async (
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppStartResult> => ({
    appId: scope.catalogAppId,
    scope,
    version: '1.0.0',
    url: 'http://127.0.0.1:9876',
    port: 9876,
  }))
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      adminSyncAppCatalog: (
        organizationId: string,
        options?: { force?: boolean },
      ) => syncCatalog(organizationId, options),
      localApps: {
        getHostInfo: async () => ({ platform: 'darwin', arch: 'arm64' }),
        getRuntimeStatuses: (
          request: { scopes: CatalogLocalAppScope[] },
        ) => getRuntimeStatuses(request),
        setAvailableRelease: async (
          scope: CatalogLocalAppScope,
        ): Promise<LocalAppRuntimeStatus> => ({
          appId: scope.catalogAppId,
          scope,
          status: 'not_installed',
        }),
        start: (scope: CatalogLocalAppScope) => startLocalApp(scope),
      },
    },
  })
})

afterEach(() => {
  cleanup()
})

describe('useAppCatalog scoped async state', () => {
  it('discards an out-of-order response after the organization changes', async () => {
    const organizationA = deferred<AppCatalogSyncResult>()
    const organizationB = deferred<AppCatalogSyncResult>()
    syncCatalog = mock((
      organizationId: string,
      _options?: { force?: boolean },
    ) => (
      organizationId === 'organization-a'
        ? organizationA.promise
        : organizationB.promise
    ))
    const { result, rerender } = renderHook(() => useAppCatalog())

    organizationContext = organization('organization-b')
    rerender()
    await act(async () => {
      organizationB.resolve(syncResult('organization-b', 'newer'))
      await organizationB.promise
    })
    await waitFor(() => {
      expect(result.current.state.catalog?.organizationId).toBe('organization-b')
    })

    await act(async () => {
      organizationA.resolve(syncResult('organization-a', 'stale'))
      await organizationA.promise
    })

    expect(result.current.state.catalog?.organizationId).toBe('organization-b')
    expect(Object.values(result.current.state.statuses)).toEqual([
      expect.objectContaining({
        scope: expect.objectContaining({ organizationId: 'organization-b' }),
      }),
    ])
  })

  it('does not deduplicate the same app id across organizations and rejects the stale operation', async () => {
    const startA = deferred<LocalAppStartResult>()
    const startB = deferred<LocalAppStartResult>()
    startLocalApp = mock((scope: CatalogLocalAppScope) => (
      scope.organizationId === 'organization-a' ? startA.promise : startB.promise
    ))
    const { result, rerender } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.organizationId).toBe('organization-a')
    })

    let promiseA!: Promise<LocalAppStartResult>
    act(() => {
      promiseA = result.current.start(result.current.state.catalog!.apps[0]!)
    })

    organizationContext = organization('organization-b')
    rerender()
    await waitFor(() => {
      expect(result.current.state.catalog?.organizationId).toBe('organization-b')
    })

    let promiseB!: Promise<LocalAppStartResult>
    act(() => {
      promiseB = result.current.start(result.current.state.catalog!.apps[0]!)
    })
    await act(async () => {
      startB.resolve({
        appId: 'shared-app-id',
        scope: {
          kind: 'catalog',
          accountId: 'account-a',
          organizationId: 'organization-b',
          catalogAppId: 'shared-app-id',
        },
        version: '1.0.0',
        url: 'http://127.0.0.1:9877',
        port: 9877,
      })
      await promiseB
    })
    startA.resolve({
      appId: 'shared-app-id',
      scope: {
        kind: 'catalog',
        accountId: 'account-a',
        organizationId: 'organization-a',
        catalogAppId: 'shared-app-id',
      },
      version: '1.0.0',
      url: 'http://127.0.0.1:9876',
      port: 9876,
    })

    await expect(promiseA).rejects.toThrow()
    expect(startLocalApp).toHaveBeenCalledTimes(2)
    expect(startLocalApp.mock.calls.map(call => call[0].organizationId))
      .toEqual(['organization-a', 'organization-b'])
    expect(result.current.state.catalog?.organizationId).toBe('organization-b')
  })
})
