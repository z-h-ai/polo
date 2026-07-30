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
): AppCatalogCacheEntry {
  return {
    accountId: 'account-a',
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
): Extract<AppCatalogSyncResult, { success: true }> {
  return {
    success: true,
    catalog: catalog(organizationId, version, apps),
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
let installLocalApp = mock(async (
  _request: { scope: CatalogLocalAppScope },
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
  installLocalApp = mock(async (
    _request: { scope: CatalogLocalAppScope },
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
        install: (request: { scope: CatalogLocalAppScope }) =>
          installLocalApp(request),
        cancelInstall: (scope: CatalogLocalAppScope) => cancelInstall(scope),
        start: (scope: CatalogLocalAppScope) => startLocalApp(scope),
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
  it('propagates a cached catalog 403 into the App auth-failure channel', async () => {
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
    expect(failures).toEqual([{ code: 'FORBIDDEN', status: 403 }])
    unsubscribe()
  })

  it('clears a previously cached catalog when a later sync returns NOT_FOUND', async () => {
    const remoteApp: CatalogApp = {
      ...app('organization-a', 'remote-app'),
      deliveryMode: 'remote_url',
      remoteUrl: 'https://stale.example.com',
      currentRelease: undefined,
    }
    let syncCount = 0
    syncCatalog = mock(async (): Promise<AppCatalogSyncResult> => {
      syncCount += 1
      return syncCount === 1
        ? syncResult('organization-a', 'cached', [remoteApp])
        : {
            success: false,
            errorCode: 'NOT_FOUND',
            message: 'Organization is unavailable',
            status: 404,
          }
    })
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps[0]?.id).toBe('remote-app')
    })
    const staleRemoteApp = result.current.state.catalog!.apps[0]!

    await act(async () => {
      await result.current.sync(true)
    })

    expect(result.current.state.catalog).toBeNull()
    expect(result.current.state.accessMode).toBe('denied')
    expect(result.current.state.errorCode).toBe('NOT_FOUND')
    expect(result.current.state.statuses).toEqual({})
    await expect(result.current.resolveRemoteUrl(staleRemoteApp)).rejects.toThrow()
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
      installOutcome = result.current.install(catalogApp).then(
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
    await expect(result.current.install(catalogApp)).rejects.toThrow()
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
