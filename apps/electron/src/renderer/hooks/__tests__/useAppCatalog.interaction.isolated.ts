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
  DeniedAppCatalogSnapshot,
} from '@z-h-ai/shared/admin'
import type {
  CatalogLocalAppScope,
  LocalAppCatalogInstallRequest,
  LocalAppRuntimeStatus,
  LocalAppStartResult,
} from '@z-h-ai/shared/protocol'
import { createLocalAppScopeKey } from '@z-h-ai/shared/protocol'
import { createOrganizationContextKey } from '@/lib/organization-storage'

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

function app(
  organizationId: string,
  id = 'shared-app-id',
): CatalogApp {
  return {
    id,
    organizationId,
    name: `App ${organizationId} ${id}`,
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

function catalog(
  organizationId: string,
  appConfigVersion: string,
  apps: CatalogApp[] = [app(organizationId)],
  accountId = 'account-a',
): AppCatalogCacheEntry {
  return {
    accountId,
    organizationId,
    appConfigVersion,
    authorizationStatus: 'authorized',
    apps,
    syncedAt: 1,
  }
}

function syncResult(
  organizationId: string,
  version: string,
  apps?: CatalogApp[],
  accountId?: string,
): Extract<AppCatalogSyncResult, { success: true }> {
  return {
    success: true,
    catalog: catalog(organizationId, version, apps, accountId),
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
let stopLocalApp = mock(async (
  scope: CatalogLocalAppScope,
): Promise<LocalAppRuntimeStatus> => ({
  appId: scope.catalogAppId,
  scope,
  status: 'stopped',
}))
let uninstallLocalApp = mock(async (
  _scope: CatalogLocalAppScope,
  _options: { preserveData: boolean },
): Promise<void> => {})
let getLocalAppLogs = mock(async (
  _scope: CatalogLocalAppScope,
  _options: { tail: number },
): Promise<string> => 'retained logs')
let installLocalApp = mock(async (
  _request: LocalAppCatalogInstallRequest,
): Promise<void> => {})
let cancelInstall = mock(async (
  _scope: CatalogLocalAppScope,
): Promise<boolean> => true)
let setAvailableRelease = mock(async (
  scope: CatalogLocalAppScope,
): Promise<LocalAppRuntimeStatus> => ({
  appId: scope.catalogAppId,
  scope,
  status: 'not_installed',
}))

function organization(organizationId: string, accountId = 'account-a') {
  return {
    accountId,
    activeOrganizationId: organizationId,
    organizationContextKey: createOrganizationContextKey(
      accountId,
      organizationId,
    ),
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
const { subscribeToAdminAuthFailures } = await import('@/lib/admin-auth-failure')

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
  stopLocalApp = mock(async (
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeStatus> => ({
    appId: scope.catalogAppId,
    scope,
    status: 'stopped',
  }))
  uninstallLocalApp = mock(async (
    _scope: CatalogLocalAppScope,
    _options: { preserveData: boolean },
  ): Promise<void> => {})
  getLocalAppLogs = mock(async (
    _scope: CatalogLocalAppScope,
    _options: { tail: number },
  ): Promise<string> => 'retained logs')
  installLocalApp = mock(async (
    _request: LocalAppCatalogInstallRequest,
  ): Promise<void> => {})
  cancelInstall = mock(async (
    _scope: CatalogLocalAppScope,
  ): Promise<boolean> => true)
  setAvailableRelease = mock(async (
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeStatus> => ({
    appId: scope.catalogAppId,
    scope,
    status: 'not_installed',
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
        setAvailableRelease: (
          scope: CatalogLocalAppScope,
        ) => setAvailableRelease(scope),
        install: (request: LocalAppCatalogInstallRequest) =>
          installLocalApp(request),
        cancelInstall: (scope: CatalogLocalAppScope) => cancelInstall(scope),
        start: (scope: CatalogLocalAppScope) => startLocalApp(scope),
        stop: (scope: CatalogLocalAppScope) => stopLocalApp(scope),
        uninstall: (
          scope: CatalogLocalAppScope,
          options: { preserveData: boolean },
        ) => uninstallLocalApp(scope, options),
        getLogs: (
          scope: CatalogLocalAppScope,
          options: { tail: number },
        ) => getLocalAppLogs(scope, options),
        resolveRemoteUrl: async (scope: CatalogLocalAppScope) => ({
          appId: scope.catalogAppId,
          scope,
          url: 'https://trusted.example.com',
        }),
      },
    },
  })
})

afterEach(() => {
  cleanup()
})

describe('useAppCatalog scoped async state', () => {
  it('keeps a local app status unknown until its initial batch resolves', async () => {
    const pendingStatuses = deferred<LocalAppRuntimeStatus[]>()
    getRuntimeStatuses = mock(() => pendingStatuses.promise)
    const view = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(view.result.current.state.catalog?.apps).toHaveLength(1)
    })
    const catalogApp = view.result.current.state.catalog!.apps[0]!
    const scope = view.result.current.scopeForApp(catalogApp)
    const scopeKey = createLocalAppScopeKey(scope)

    expect(view.result.current.state.loading).toBe(false)
    expect(view.result.current.state.statusLoadingScopeKeys[scopeKey]).toBe(true)
    expect(view.result.current.getStatus(catalogApp)).toBeUndefined()

    pendingStatuses.resolve([{
      appId: catalogApp.id,
      scope,
      status: 'not_installed',
    }])
    await waitFor(() => {
      expect(view.result.current.state.statusLoadingScopeKeys[scopeKey])
        .toBeUndefined()
      expect(view.result.current.getStatus(catalogApp)?.status)
        .toBe('not_installed')
    })
  })

  it('keeps a cached Catalog 403 out of the account auth-failure channel', async () => {
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => ({
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'Admin request is not permitted',
      status: 403,
    }))
    const failures: Array<{ code: string; status?: number }> = []
    const unsubscribe = subscribeToAdminAuthFailures(error => {
      failures.push(error)
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.errorCode).toBe('FORBIDDEN')
    })
    expect(failures).toEqual([])
    unsubscribe()
  })

  for (const [errorCode, status] of [
    ['FORBIDDEN', 403],
    ['MEMBERSHIP_REMOVED', 409],
    ['NETWORK_ERROR', undefined],
  ] as const) {
    it(`hydrates the first denied ${errorCode} Catalog with real local status and management`, async () => {
      const localApp = app(
        'organization-a',
        `retained-${errorCode.toLowerCase()}`,
      )
      const deniedCatalog: DeniedAppCatalogSnapshot = {
        accountId: 'account-a',
        organizationId: 'organization-a',
        appConfigVersion: 'denied-catalog',
        authorizationStatus: 'denied',
        apps: [{
          id: localApp.id,
          organizationId: localApp.organizationId,
          name: localApp.name,
          description: localApp.description,
          deliveryMode: localApp.deliveryMode,
          sortOrder: localApp.sortOrder,
          availability: 'unavailable',
        }],
        syncedAt: 1,
      }
      syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => ({
        success: false,
        errorCode,
        message: 'Organization access is unavailable',
        status,
        accessMode: 'denied',
        catalog: deniedCatalog,
      }))
      getRuntimeStatuses = mock(async (
        request: { scopes: CatalogLocalAppScope[] },
      ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
        appId: scope.catalogAppId,
        scope,
        status: 'running',
        currentVersion: '1.0.0',
        runningVersion: '1.0.0',
      })))

      const { result } = renderHook(() => useAppCatalog())
      await waitFor(() => {
        expect(result.current.state.catalog?.authorizationStatus).toBe('denied')
        expect(result.current.getStatus(
          result.current.state.catalog!.apps[0]!,
        )?.status).toBe('running')
      })

      const retainedApp = result.current.state.catalog!.apps[0]!
      expect(retainedApp.availability).toBe('unavailable')
      expect(retainedApp).not.toHaveProperty('currentRelease')
      expect(retainedApp).not.toHaveProperty('permissions')
      expect(result.current.state.accessMode).toBe('denied')
      expect(getRuntimeStatuses).toHaveBeenCalledTimes(1)
      expect(getRuntimeStatuses).toHaveBeenCalledWith({
        scopes: [{
          kind: 'catalog',
          accountId: 'account-a',
          organizationId: 'organization-a',
          catalogAppId: retainedApp.id,
        }],
      })

      await expect(result.current.install(retainedApp, 'denied-catalog'))
        .rejects.toThrow()
      await expect(result.current.start(retainedApp)).rejects.toThrow()
      expect(installLocalApp).not.toHaveBeenCalled()
      expect(startLocalApp).not.toHaveBeenCalled()

      await expect(result.current.getLogs(retainedApp))
        .resolves.toBe('retained logs')
      await act(async () => {
        await result.current.stop(retainedApp)
        await result.current.uninstall(retainedApp, true)
      })
      expect(getLocalAppLogs).toHaveBeenCalled()
      expect(stopLocalApp).toHaveBeenCalled()
      expect(uninstallLocalApp).toHaveBeenCalledWith(
        expect.objectContaining({ catalogAppId: retainedApp.id }),
        { preserveData: true },
      )
    })
  }

  it('rejects deferred retained logs after a same-context re-authorization', async () => {
    const retainedApp: CatalogApp = {
      ...app('organization-a'),
      availability: 'withdrawn',
    }
    const availableApp: CatalogApp = {
      ...retainedApp,
      availability: 'available',
    }
    let syncCall = 0
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => {
      syncCall += 1
      return syncCall === 1
        ? {
            success: true,
            catalog: {
              ...catalog('organization-a', 'withdrawn', []),
              withdrawnApps: [retainedApp],
            },
            source: 'cache',
            refreshed: false,
            accessMode: 'online',
          }
        : syncResult('organization-a', 're-authorized', [availableApp])
    })
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
    })))
    const pendingTail = deferred<string>()
    getLocalAppLogs = mock(() => pendingTail.promise)

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.withdrawnApps?.[0]?.availability)
        .toBe('withdrawn')
    })
    const admittedApp = result.current.state.catalog!.withdrawnApps![0]!
    const pendingLogs = result.current.getLogs(admittedApp)
    await waitFor(() => expect(getLocalAppLogs).toHaveBeenCalledTimes(1))

    await act(async () => {
      await result.current.sync(true)
    })
    expect(result.current.state.catalog?.apps[0]?.availability).toBe('available')

    pendingTail.resolve('stale retained logs')
    await expect(pendingLogs).rejects.toThrow()
  })

  it('propagates an account-disabled Catalog response into the auth-failure channel', async () => {
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => ({
      success: false,
      errorCode: 'ACCOUNT_DISABLED',
      message: 'Admin account is disabled',
      status: 403,
    }))
    const failures: Array<{ code: string; status?: number }> = []
    const unsubscribe = subscribeToAdminAuthFailures(error => {
      failures.push(error)
    })

    renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(failures).toEqual([{ code: 'ACCOUNT_DISABLED', status: 403 }])
    })
    unsubscribe()
  })

  for (const errorCode of [
    'FORBIDDEN',
    'MEMBERSHIP_REMOVED',
    'unknown_body_error',
  ]) {
    it(`treats Catalog HTTP 401 with ${errorCode} as account session loss`, async () => {
      syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => ({
        success: false,
        errorCode,
        message: 'Admin session is unauthorized',
        status: 401,
      }))
      const failures: Array<{ code: string; status?: number }> = []
      const unsubscribe = subscribeToAdminAuthFailures(error => {
        failures.push(error)
      })

      const { result } = renderHook(() => useAppCatalog())
      await waitFor(() => {
        expect(failures).toEqual([{ code: errorCode, status: 401 }])
      })
      expect(result.current.state.catalog).toBeNull()
      expect(result.current.state.accessMode).toBeNull()
      expect(getRuntimeStatuses).not.toHaveBeenCalled()
      unsubscribe()
    })
  }

  it('keeps denied installed app data manageable after a later NOT_FOUND', async () => {
    const localApp = app('organization-a', 'installed-app')
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
    })))
    let syncCount = 0
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => {
      syncCount += 1
      return syncCount === 1
        ? syncResult('organization-a', 'cached', [localApp])
        : {
            success: false,
            errorCode: 'NOT_FOUND',
            message: 'Organization is unavailable',
            status: 404,
          }
    })
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.getStatus(result.current.state.catalog!.apps[0]!)?.status)
        .toBe('running')
    })
    await act(async () => {
      await result.current.sync(true)
    })

    expect(result.current.state.catalog).toMatchObject({
      authorizationStatus: 'denied',
      apps: [{
        id: 'installed-app',
        availability: 'unavailable',
      }],
    })
    expect(result.current.state.accessMode).toBe('denied')
    expect(result.current.state.errorCode).toBe('NOT_FOUND')
    expect(result.current.getStatus(result.current.state.catalog!.apps[0]!)?.status)
      .toBe('running')
    await expect(result.current.start(result.current.state.catalog!.apps[0]!))
      .rejects.toThrow()
    expect(startLocalApp).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.stop(result.current.state.catalog!.apps[0]!)
    })
    expect(stopLocalApp).toHaveBeenCalled()
  })

  it('discards a start result that returns after organization access is denied', async () => {
    const pendingStart = deferred<LocalAppStartResult>()
    startLocalApp = mock(() => pendingStart.promise)
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion).toBe('initial')
    })
    const localApp = result.current.state.catalog!.apps[0]!
    let start!: Promise<LocalAppStartResult>
    act(() => {
      start = result.current.start(localApp)
    })
    await waitFor(() => {
      expect(startLocalApp).toHaveBeenCalledTimes(1)
    })

    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => ({
      success: false,
      errorCode: 'NOT_FOUND',
      message: 'Organization is unavailable',
      status: 404,
    }))
    await act(async () => {
      await result.current.sync(true)
    })
    await act(async () => {
      pendingStart.resolve({
        appId: localApp.id,
        scope: result.current.scopeForApp(result.current.state.catalog!.apps[0]!),
        version: '1.0.0',
        url: 'http://127.0.0.1:9999',
        port: 9999,
      })
      await expect(start).rejects.toThrow()
    })

    expect(result.current.state.catalog?.authorizationStatus).toBe('denied')
  })

  it('retries a superseded startup sync until the no-cache caller receives the committed catalog', async () => {
    let calls = 0
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => {
      calls += 1
      return calls === 1
        ? {
            success: false,
            errorCode: 'REQUEST_SUPERSEDED',
            message: 'A newer startup sync owns the result',
          }
        : syncResult('organization-a', 'committed-no-cache')
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion)
        .toBe('committed-no-cache')
    })

    expect(syncCatalog).toHaveBeenCalledTimes(2)
    expect(result.current.state.errorCode).toBeNull()
  })

  it('retries a superseded refresh instead of leaving the Home caller on old cache', async () => {
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion).toBe('initial')
    })
    let calls = 0
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => {
      calls += 1
      return calls === 1
        ? {
            success: false,
            errorCode: 'REQUEST_SUPERSEDED',
            message: 'A newer startup sync owns the result',
          }
        : syncResult('organization-a', 'committed-after-cache')
    })

    await act(async () => {
      await result.current.sync(true)
    })

    expect(syncCatalog).toHaveBeenCalledTimes(2)
    expect(result.current.state.catalog?.appConfigVersion)
      .toBe('committed-after-cache')
    expect(result.current.state.errorCode).toBeNull()
  })

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

  it('discards a Catalog response across legacy-colliding contexts', async () => {
    const accountA = 'account:west'
    const organizationAId = '组织'
    const accountB = 'account'
    const organizationBId = 'west:组织'
    expect(`${accountA}:${organizationAId}`)
      .toBe(`${accountB}:${organizationBId}`)

    const catalogA = deferred<AppCatalogSyncResult>()
    syncCatalog = mock((
      organizationId: string,
      _options?: { force?: boolean },
    ) => (
      organizationId === organizationAId
        ? catalogA.promise
        : Promise.resolve(syncResult(
            organizationBId,
            'current-b',
            undefined,
            accountB,
          ))
    ))
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ) => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'installed',
      currentVersion: '1.0.0',
    })))
    organizationContext = organization(organizationAId, accountA)
    const { result, rerender } = renderHook(() => useAppCatalog())

    organizationContext = organization(organizationBId, accountB)
    rerender()
    await waitFor(() => {
      expect(result.current.state.catalog).toMatchObject({
        accountId: accountB,
        organizationId: organizationBId,
        appConfigVersion: 'current-b',
      })
      expect(Object.values(result.current.state.statuses)).toEqual([
        expect.objectContaining({
          status: 'installed',
          scope: expect.objectContaining({
            accountId: accountB,
            organizationId: organizationBId,
          }),
        }),
      ])
    })

    await act(async () => {
      catalogA.resolve(syncResult(
        organizationAId,
        'stale-a',
        undefined,
        accountA,
      ))
      await catalogA.promise
    })

    expect(result.current.state.catalog).toMatchObject({
      accountId: accountB,
      organizationId: organizationBId,
      appConfigVersion: 'current-b',
    })
    expect(Object.values(result.current.state.statuses)).toEqual([
      expect.objectContaining({
        status: 'installed',
        scope: expect.objectContaining({
          accountId: accountB,
          organizationId: organizationBId,
        }),
      }),
    ])
  })

  it('discards a status response across legacy-colliding contexts', async () => {
    const accountA = 'account:west'
    const organizationAId = '组织'
    const accountB = 'account'
    const organizationBId = 'west:组织'
    const statusA = deferred<LocalAppRuntimeStatus[]>()
    syncCatalog = mock(async (
      organizationId: string,
      _options?: { force?: boolean },
    ) => syncResult(
      organizationId,
      `catalog-${organizationId}`,
      undefined,
      organizationId === organizationAId ? accountA : accountB,
    ))
    getRuntimeStatuses = mock((
      request: { scopes: CatalogLocalAppScope[] },
    ) => (
      request.scopes[0]?.accountId === accountA
        ? statusA.promise
        : Promise.resolve(request.scopes.map(scope => ({
            appId: scope.catalogAppId,
            scope,
            status: 'installed' as const,
            currentVersion: '1.0.0',
          })))
    ))
    organizationContext = organization(organizationAId, accountA)
    const { result, rerender } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog).toMatchObject({
        accountId: accountA,
        organizationId: organizationAId,
      })
      expect(getRuntimeStatuses).toHaveBeenCalledTimes(1)
    })

    organizationContext = organization(organizationBId, accountB)
    rerender()
    await waitFor(() => {
      expect(result.current.state.catalog).toMatchObject({
        accountId: accountB,
        organizationId: organizationBId,
      })
      expect(Object.values(result.current.state.statuses)).toEqual([
        expect.objectContaining({
          status: 'installed',
          scope: expect.objectContaining({
            accountId: accountB,
            organizationId: organizationBId,
          }),
        }),
      ])
    })

    await act(async () => {
      statusA.resolve([{
        appId: 'shared-app-id',
        scope: {
          kind: 'catalog',
          accountId: accountA,
          organizationId: organizationAId,
          catalogAppId: 'shared-app-id',
        },
        status: 'running',
        currentVersion: '1.0.0',
        runningVersion: '1.0.0',
      }])
      await statusA.promise
    })

    expect(result.current.state.catalog).toMatchObject({
      accountId: accountB,
      organizationId: organizationBId,
    })
    expect(Object.values(result.current.state.statuses)).toEqual([
      expect.objectContaining({
        status: 'installed',
        scope: expect.objectContaining({
          accountId: accountB,
          organizationId: organizationBId,
        }),
      }),
    ])
  })

  it('does not deduplicate the same app id across organizations and rejects the stale operation', async () => {
    const accountA = 'account:west'
    const organizationAId = '组织'
    const accountB = 'account'
    const organizationBId = 'west:组织'
    const startA = deferred<LocalAppStartResult>()
    const startB = deferred<LocalAppStartResult>()
    startLocalApp = mock((scope: CatalogLocalAppScope) => (
      scope.accountId === accountA ? startA.promise : startB.promise
    ))
    syncCatalog = mock(async (
      organizationId: string,
      _options?: { force?: boolean },
    ) => syncResult(
      organizationId,
      `catalog-${organizationId}`,
      undefined,
      organizationId === organizationAId ? accountA : accountB,
    ))
    organizationContext = organization(organizationAId, accountA)
    const { result, rerender } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog).toMatchObject({
        accountId: accountA,
        organizationId: organizationAId,
      })
    })

    let promiseA!: Promise<LocalAppStartResult>
    act(() => {
      promiseA = result.current.start(result.current.state.catalog!.apps[0]!)
    })

    organizationContext = organization(organizationBId, accountB)
    rerender()
    await waitFor(() => {
      expect(result.current.state.catalog).toMatchObject({
        accountId: accountB,
        organizationId: organizationBId,
      })
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
          accountId: accountB,
          organizationId: organizationBId,
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
        accountId: accountA,
        organizationId: organizationAId,
        catalogAppId: 'shared-app-id',
      },
      version: '1.0.0',
      url: 'http://127.0.0.1:9876',
      port: 9876,
    })

    await expect(promiseA).rejects.toThrow()
    expect(startLocalApp).toHaveBeenCalledTimes(2)
    expect(startLocalApp.mock.calls.map(call => [
      call[0].accountId,
      call[0].organizationId,
    ])).toEqual([
      [accountA, organizationAId],
      [accountB, organizationBId],
    ])
    expect(result.current.state.catalog).toMatchObject({
      accountId: accountB,
      organizationId: organizationBId,
    })
  })

  it('keeps a successful start result when the same organization refreshes', async () => {
    const pendingStart = deferred<LocalAppStartResult>()
    startLocalApp = mock(() => pendingStart.promise)
    let syncCount = 0
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => {
      syncCount += 1
      return syncResult('organization-a', `catalog-${syncCount}`)
    })
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion).toBe('catalog-1')
    })
    const catalogApp = result.current.state.catalog!.apps[0]!

    let started!: Promise<LocalAppStartResult>
    act(() => {
      started = result.current.start(catalogApp)
    })
    await waitFor(() => {
      expect(result.current.getStatus(catalogApp)?.status).toBe('starting')
    })

    await act(async () => {
      await result.current.sync(true)
    })
    expect(result.current.state.catalog?.appConfigVersion).toBe('catalog-2')

    const localUrl = 'http://127.0.0.1:9911'
    let startResult!: LocalAppStartResult
    await act(async () => {
      pendingStart.resolve({
        appId: catalogApp.id,
        scope: {
          kind: 'catalog',
          accountId: 'account-a',
          organizationId: 'organization-a',
          catalogAppId: catalogApp.id,
        },
        version: '1.0.0',
        url: localUrl,
        port: 9911,
      })
      startResult = await started
    })

    expect(startResult).toMatchObject({ url: localUrl })
    expect(startLocalApp).toHaveBeenCalledTimes(1)
  })

  it('sends stop once while start for the same scope is still pending', async () => {
    const pendingStart = deferred<LocalAppStartResult>()
    startLocalApp = mock(() => pendingStart.promise)
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const catalogApp = result.current.state.catalog!.apps[0]!

    let started!: Promise<LocalAppStartResult>
    let startOutcome!: Promise<'fulfilled' | 'rejected'>
    act(() => {
      started = result.current.start(catalogApp)
      startOutcome = started.then(
        () => 'fulfilled',
        () => 'rejected',
      )
    })
    await waitFor(() => {
      expect(startLocalApp).toHaveBeenCalledTimes(1)
    })

    let stopped!: Promise<void>
    act(() => {
      stopped = result.current.stop(catalogApp)
    })
    await waitFor(() => {
      expect(stopLocalApp).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await stopped
    })

    await act(async () => {
      pendingStart.resolve({
        appId: catalogApp.id,
        scope: {
          kind: 'catalog',
          accountId: 'account-a',
          organizationId: 'organization-a',
          catalogAppId: catalogApp.id,
        },
        version: '1.0.0',
        url: 'http://127.0.0.1:9912',
        port: 9912,
      })
      expect(await startOutcome).toBe('rejected')
    })

    expect(stopLocalApp).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: 'shared-app-id',
    }))
    expect(stopLocalApp).toHaveBeenCalledTimes(1)
  })

  it('keeps STOP status when older full and START-finally reads resolve later', async () => {
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.getStatus(result.current.state.catalog!.apps[0]!)?.status)
        .toBe('not_installed')
    })

    const fullRead = deferred<LocalAppRuntimeStatus[]>()
    const startFinallyRead = deferred<LocalAppRuntimeStatus[]>()
    const stopFinallyRead = deferred<LocalAppRuntimeStatus[]>()
    const statusReads = [fullRead, startFinallyRead, stopFinallyRead]
    let readIndex = 0
    getRuntimeStatuses = mock(() => statusReads[readIndex++]!.promise)

    let pendingSync!: Promise<void>
    act(() => {
      pendingSync = result.current.sync(true)
    })
    await waitFor(() => {
      expect(getRuntimeStatuses).toHaveBeenCalledTimes(1)
    })
    const catalogApp = result.current.state.catalog!.apps[0]!
    const runtimeScope = result.current.scopeForApp(catalogApp)
    const runningStatus: LocalAppRuntimeStatus = {
      appId: catalogApp.id,
      scope: runtimeScope,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
    }
    const stoppedStatus: LocalAppRuntimeStatus = {
      appId: catalogApp.id,
      scope: runtimeScope,
      status: 'stopped',
      currentVersion: '1.0.0',
    }

    let startOutcome!: Promise<'fulfilled' | 'rejected'>
    act(() => {
      startOutcome = result.current.start(catalogApp).then(
        () => 'fulfilled',
        () => 'rejected',
      )
    })
    await waitFor(() => {
      expect(getRuntimeStatuses).toHaveBeenCalledTimes(2)
    })

    let pendingStop!: Promise<void>
    act(() => {
      pendingStop = result.current.stop(catalogApp)
    })
    await waitFor(() => {
      expect(getRuntimeStatuses).toHaveBeenCalledTimes(3)
    })
    await act(async () => {
      stopFinallyRead.resolve([stoppedStatus])
      await pendingStop
    })
    expect(result.current.getStatus(catalogApp)?.status).toBe('stopped')

    await act(async () => {
      startFinallyRead.resolve([runningStatus])
      expect(await startOutcome).toBe('rejected')
    })
    await act(async () => {
      fullRead.resolve([runningStatus])
      await pendingSync
    })

    expect(getRuntimeStatuses).toHaveBeenCalledTimes(3)
    expect(result.current.getStatus(catalogApp)?.status).toBe('stopped')
  })

  it('cancels an in-flight install through an independent cancellation channel', async () => {
    const pendingInstall = deferred<void>()
    installLocalApp = mock(() => pendingInstall.promise)
    cancelInstall = mock(async () => {
      pendingInstall.reject(new Error('cancelled'))
      return true
    })
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
      expect(result.current.state.host).not.toBeNull()
    })
    const catalogApp = result.current.state.catalog!.apps[0]!

    let installOutcome!: Promise<'fulfilled' | 'rejected'>
    act(() => {
      installOutcome = result.current.install(catalogApp, 'initial').then(
        () => 'fulfilled',
        () => 'rejected',
      )
    })
    await waitFor(() => {
      expect(result.current.getStatus(catalogApp)?.status).toBe('downloading')
    })

    let cancelPromise!: Promise<void>
    act(() => {
      cancelPromise = result.current.cancelInstall(catalogApp)
    })
    await act(async () => {
      await cancelPromise
      expect(await installOutcome).toBe('rejected')
    })

    expect(installLocalApp).toHaveBeenCalledTimes(1)
    expect(cancelInstall).toHaveBeenCalledTimes(1)
    expect(cancelInstall).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: 'shared-app-id',
    }))
    expect(result.current.getStatus(catalogApp)?.status).toBe('not_installed')
  })

  it('refreshes a changed Release and requires confirmation of the new fingerprint', async () => {
    const releaseA: CatalogApp = {
      ...app('organization-a'),
      permissions: ['selected files', 'camera', 'camera'],
      currentRelease: {
        version: '1.0.0',
        runtime: 'static',
        downloadUrl: 'https://example.com/a.zip',
        checksum: 'a'.repeat(64),
        sizeBytes: 100,
        platform: 'darwin',
        arch: 'arm64',
      },
    }
    const releaseB: CatalogApp = {
      ...releaseA,
      currentRelease: {
        ...releaseA.currentRelease!,
        version: '2.0.0',
        downloadUrl: 'https://example.com/b.zip',
        checksum: 'b'.repeat(64),
        sizeBytes: 200,
      },
    }
    let syncCount = 0
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => {
      syncCount += 1
      return syncResult(
        'organization-a',
        syncCount === 1 ? 'release-a' : 'release-b',
        [syncCount === 1 ? releaseA : releaseB],
      )
    })
    installLocalApp = mock(async () => {
      throw Object.assign(new Error('Release changed'), {
        code: 'RELEASE_CHANGED',
      })
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion).toBe('release-a')
      expect(result.current.state.host).not.toBeNull()
    })
    const confirmedApp = result.current.state.catalog!.apps[0]!

    await act(async () => {
      await expect(result.current.install(
        confirmedApp,
        'release-a',
      )).rejects.toMatchObject({
        code: 'RELEASE_CHANGED',
      })
    })

    expect(installLocalApp).toHaveBeenCalledWith({
      scope: {
        kind: 'catalog',
        accountId: 'account-a',
        organizationId: 'organization-a',
        catalogAppId: 'shared-app-id',
      },
      appConfigVersion: 'release-a',
      permissions: ['camera', 'selected files'],
      release: {
        version: '1.0.0',
        runtime: 'static',
        checksum: 'a'.repeat(64),
        sizeBytes: 100,
        platform: 'darwin',
        arch: 'arm64',
      },
    })
    expect(syncCatalog).toHaveBeenCalledTimes(2)
    expect(result.current.state.catalog).toMatchObject({
      appConfigVersion: 'release-b',
      apps: [{
        currentRelease: {
          version: '2.0.0',
          checksum: 'b'.repeat(64),
          sizeBytes: 200,
        },
      }],
    })
  })

  it('merges a completed single-app refresh without dropping other app statuses', async () => {
    const apps = [
      app('organization-a', 'app-a'),
      app('organization-a', 'app-b'),
    ]
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> =>
      syncResult('organization-a', 'two-apps', apps))
    let appAStarted = false
    startLocalApp = mock(async (
      scope: CatalogLocalAppScope,
    ): Promise<LocalAppStartResult> => {
      appAStarted = true
      return {
        appId: scope.catalogAppId,
        scope,
        version: '1.0.0',
        url: 'http://127.0.0.1:9876',
        port: 9876,
      }
    })
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: scope.catalogAppId === 'app-a'
        ? (appAStarted ? 'running' : 'installed')
        : 'running',
      currentVersion: '1.0.0',
    })))

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(Object.keys(result.current.state.statuses)).toHaveLength(2)
    })
    const [appA, appB] = result.current.state.catalog!.apps

    await act(async () => {
      await result.current.start(appA!)
    })

    expect(getRuntimeStatuses.mock.calls.map(call => call[0].scopes.length))
      .toEqual([2, 1])
    expect(result.current.getStatus(appA!)?.status).toBe('running')
    expect(result.current.getStatus(appB!)?.status).toBe('running')
    expect(Object.keys(result.current.state.statuses)).toHaveLength(2)
  })

  it('opens a prepared app from a restricted offline catalog without enabling install', async () => {
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => ({
      ...syncResult('organization-a', 'offline'),
      source: 'cache',
      refreshed: false,
      accessMode: 'offline',
      warningCode: 'NETWORK_ERROR',
    }))
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'installed',
      currentVersion: '1.0.0',
    })))
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.accessMode).toBe('offline')
      expect(result.current.getStatus(result.current.state.catalog!.apps[0]!)?.status)
        .toBe('installed')
    })
    const catalogApp = result.current.state.catalog!.apps[0]!

    let started!: LocalAppStartResult
    await act(async () => {
      started = await result.current.start(catalogApp)
    })
    expect(started).toMatchObject({
      url: 'http://127.0.0.1:9876',
    })
    expect(startLocalApp).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: 'shared-app-id',
    }))
    await expect(result.current.install(
      catalogApp,
      result.current.state.catalog!.appConfigVersion,
    )).rejects.toThrow()
    expect(installLocalApp).not.toHaveBeenCalled()
  })

  it('uses one batch status RPC and no per-app release RPC for large catalogs', async () => {
    for (const count of [1_000, 1_001, 10_000]) {
      const apps = Array.from(
        { length: count },
        (_, index) => app('organization-a', `app-${index}`),
      )
      syncCatalog = mock(async (): Promise<AppCatalogSyncResult> =>
        syncResult('organization-a', `catalog-${count}`, apps))
      getRuntimeStatuses = mock(async (
        request: { scopes: CatalogLocalAppScope[] },
      ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
        appId: scope.catalogAppId,
        scope,
        status: 'installed',
        currentVersion: '1.0.0',
      })))
      setAvailableRelease = mock(async (
        scope: CatalogLocalAppScope,
      ): Promise<LocalAppRuntimeStatus> => ({
        appId: scope.catalogAppId,
        scope,
        status: 'installed',
      }))

      const view = renderHook(() => useAppCatalog())
      await waitFor(() => {
        expect(Object.keys(view.result.current.state.statuses)).toHaveLength(count)
      }, { timeout: 5_000 })

      expect(getRuntimeStatuses).toHaveBeenCalledTimes(1)
      expect(getRuntimeStatuses.mock.calls[0]![0].scopes).toHaveLength(count)
      expect(setAvailableRelease).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('reads the installed withdrawn app after 10,000 visible apps in a second batch', async () => {
    const visibleApps = Array.from(
      { length: 10_000 },
      (_, index) => app('organization-a', `visible-${index}`),
    )
    const withdrawn = {
      ...app('organization-a', 'installed-withdrawn'),
      availability: 'withdrawn' as const,
    }
    const catalogResult = syncResult(
      'organization-a',
      'visible-plus-withdrawn',
      visibleApps,
    )
    catalogResult.catalog.withdrawnApps = [withdrawn]
    syncCatalog = mock(async () => catalogResult)
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: scope.catalogAppId === withdrawn.id ? 'running' : 'not_installed',
      ...(scope.catalogAppId === withdrawn.id
        ? { currentVersion: '1.0.0', runningVersion: '1.0.0' }
        : {}),
    })))

    const view = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(Object.keys(view.result.current.state.statuses)).toHaveLength(10_001)
    }, { timeout: 10_000 })

    expect(getRuntimeStatuses.mock.calls.map(call => call[0].scopes.length))
      .toEqual([10_000, 1])
    expect(view.result.current.getStatus(withdrawn)).toMatchObject({
      appId: 'installed-withdrawn',
      status: 'running',
      currentVersion: '1.0.0',
    })
    view.unmount()
  })

  it('merges successful status batches and preserves trusted state when the second batch fails', async () => {
    const apps = Array.from(
      { length: 10_001 },
      (_, index) => app('organization-a', `app-${index}`),
    )
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> =>
      syncResult('organization-a', 'partial-batch', apps))
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'installed',
      currentVersion: '1.0.0',
    })))

    const view = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(Object.keys(view.result.current.state.statuses)).toHaveLength(10_001)
    }, { timeout: 10_000 })

    let batch = 0
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => {
      batch += 1
      if (batch === 2) throw new Error('second batch unavailable')
      return request.scopes.map(scope => ({
        appId: scope.catalogAppId,
        scope,
        status: 'running',
        currentVersion: '1.0.0',
        runningVersion: '1.0.0',
      }))
    })
    await act(async () => {
      await view.result.current.refreshRuntimeStatuses()
    })

    expect(view.result.current.getStatus(apps[0]!)?.status).toBe('running')
    expect(view.result.current.getStatus(apps.at(-1)!)?.status).toBe('installed')
    expect(Object.values(view.result.current.state.statuses)
      .some(status => status.status === 'not_installed')).toBe(false)
    expect(view.result.current.state.statusErrorCode).toBe('status_read_failed')
    expect(view.result.current.state.statusErrorScopeKeys[
      view.result.current.scopeKeyForApp(apps[0]!)
    ]).toBeUndefined()
    expect(view.result.current.state.statusErrorScopeKeys[
      view.result.current.scopeKeyForApp(apps.at(-1)!)
    ]).toBe(true)

    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'stopped',
      currentVersion: '1.0.0',
    })))
    await act(async () => {
      await view.result.current.refreshRuntimeStatuses()
    })
    expect(view.result.current.getStatus(apps.at(-1)!)?.status).toBe('stopped')
    expect(view.result.current.state.statusErrorCode).toBeNull()
    expect(view.result.current.state.statusErrorScopeKeys).toEqual({})
    view.unmount()
  })

  it('reads the maximum retained tombstone boundary without truncation', async () => {
    const visibleApps = Array.from(
      { length: 10_000 },
      (_, index) => app('organization-a', `visible-${index}`),
    )
    const withdrawnApps = Array.from(
      { length: 10_000 },
      (_, index) => ({
        ...app('organization-a', `withdrawn-${index}`),
        availability: 'withdrawn' as const,
      }),
    )
    const catalogResult = syncResult(
      'organization-a',
      'maximum-tombstones',
      visibleApps,
    )
    catalogResult.catalog.withdrawnApps = withdrawnApps
    syncCatalog = mock(async () => catalogResult)
    getRuntimeStatuses = mock(async (
      request: { scopes: CatalogLocalAppScope[] },
    ): Promise<LocalAppRuntimeStatus[]> => request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: scope.catalogAppId === 'withdrawn-9999'
        ? 'installed'
        : 'not_installed',
      ...(scope.catalogAppId === 'withdrawn-9999'
        ? { currentVersion: '1.0.0' }
        : {}),
    })))

    const view = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(Object.keys(view.result.current.state.statuses)).toHaveLength(20_000)
    }, { timeout: 15_000 })

    expect(getRuntimeStatuses.mock.calls.map(call => call[0].scopes.length))
      .toEqual([10_000, 10_000])
    expect(view.result.current.getStatus(withdrawnApps.at(-1)!)).toMatchObject({
      appId: 'withdrawn-9999',
      status: 'installed',
      currentVersion: '1.0.0',
    })
    view.unmount()
  })
})
