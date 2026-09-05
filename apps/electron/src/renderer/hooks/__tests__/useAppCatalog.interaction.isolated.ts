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
} from '@polo-ai/shared/admin'
import type {
  CatalogLocalAppScope,
  LocalAppCatalogInstallRequest,
  LocalAppRuntimeStatus,
  LocalAppStartResult,
} from '@polo-ai/shared/protocol'
import { createLocalAppScopeKey } from '@polo-ai/shared/protocol'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'

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

let productSpaceContextState = productSpaceContext('organization-a')
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
let getProductSpaceInstallStates = mock(async (identities: any[]) =>
  identities.map(identity => ({ app: identity, state: 'not_installed' as const })))
let getProductSpaceWithdrawnInstallStates: any = mock(async (identities: any[]) =>
  identities.map(identity => ({ app: identity, state: 'not_installed' as const })))
let installProductSpaceBundle = mock(async (request: any) => ({
  appId: request.app.artifactInstanceId,
  scope: {
    kind: 'catalog' as const,
    accountId: request.app.accountId,
    organizationId: request.app.productSpaceId,
    catalogAppId: request.app.artifactInstanceId,
  },
  status: 'installed' as const,
  currentVersion: request.app.version,
}))
let uninstallProductSpaceBundle = mock(async (
  _identity: any,
  _options: { preserveData: boolean },
) => {})

function productSpaceContext(organizationId: string, accountId = 'account-a') {
  return {
    accountId,
    activeProductSpaceId: organizationId,
    productSpaceContextKey: createProductSpaceContextKey(
      accountId,
      organizationId,
    ),
    activeProductSpace: {
      id: organizationId,
      kind: 'enterprise' as const,
      name: organizationId,
    },
  }
}

mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
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
  productSpaceContextState = productSpaceContext('organization-a')
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
  getProductSpaceInstallStates = mock(async (identities: any[]) =>
    identities.map(identity => ({ app: identity, state: 'not_installed' as const })))
  getProductSpaceWithdrawnInstallStates = mock(async (identities: any[]) =>
    identities.map(identity => ({ app: identity, state: 'not_installed' as const })))
  installProductSpaceBundle = mock(async (request: any) => ({
    appId: request.app.artifactInstanceId,
    scope: {
      kind: 'catalog' as const,
      accountId: request.app.accountId,
      organizationId: request.app.productSpaceId,
      catalogAppId: request.app.artifactInstanceId,
    },
    status: 'installed' as const,
    currentVersion: request.app.version,
  }))
  uninstallProductSpaceBundle = mock(async (
    _identity: any,
    _options: { preserveData: boolean },
  ) => {})
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      productSpaceGetCatalog: (
        productSpaceId: string,
        _knownRevision?: string,
      ) => syncCatalog(productSpaceId).then((result: AppCatalogSyncResult) => {
        if (!result.success) {
          return {
            success: false as const,
            errorCode: result.errorCode ?? 'request_failed',
            message: result.message ?? 'catalog unavailable',
            status: result.status,
            ...(result.accessMode === 'denied' && result.catalog
              ? { accessMode: 'denied' as const, catalog: result.catalog }
              : {}),
          }
        }
        return {
          success: true as const,
          notModified: false as const,
          catalogRevision: result.catalog.appConfigVersion,
          productSpaceId,
          accessMode: result.accessMode,
          warningCode: result.warningCode,
          entries: result.catalog.apps.map(app => ({
            kind: 'app',
            catalogEntryId: app.id,
            name: app.name,
            description: app.description,
            availability: app.availability === 'available' ? 'available' : 'unavailable',
            deliveryMode: app.deliveryMode,
            remoteUrl: app.remoteUrl,
            currentRelease: app.currentRelease,
            permissions: app.permissions,
            sortOrder: app.sortOrder,
          })),
          withdrawnEntries: (result.catalog.withdrawnApps ?? []).map(app => ({
            kind: 'app',
            catalogEntryId: app.id,
            name: app.name,
            description: app.description,
            availability: 'withdrawn',
            deliveryMode: app.deliveryMode,
            remoteUrl: app.remoteUrl,
            currentRelease: app.currentRelease,
            permissions: app.permissions,
            sortOrder: app.sortOrder,
          })),
        }
      }),
      localApps: {
        getProductSpaceInstallStates: (identities: any[]) =>
          getProductSpaceInstallStates(identities),
        getProductSpaceWithdrawnInstallStates: (identities: any[]) =>
          getProductSpaceWithdrawnInstallStates(identities),
        installProductSpaceBundle: (request: any) =>
          installProductSpaceBundle(request),
        uninstallProductSpaceBundle: (identity: any, options: any) =>
          uninstallProductSpaceBundle(identity, options),
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

describe('useAppCatalog creator circle relations', () => {
  it('clears derived creator circles when a Catalog refresh fails', async () => {
    // The wrapper stub maps entries from catalog.apps; for this test the
    // product-space RPC is replaced directly so raw entries (with
    // creator_circle sources) reach the hook.
    const entriesWithCircle = [{
      kind: 'app',
      catalogEntryId: 'circle-app',
      name: 'Circle App',
      description: '',
      availability: 'available',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://example.com/circle-app',
      sortOrder: 0,
      sources: [{
        kind: 'creator_circle',
        circleId: 'circle-1',
        name: '桥岸圈子',
      }],
    }]
    const catalogApi = window.electronAPI as unknown as {
      productSpaceGetCatalog: (
        productSpaceId: string,
        knownRevision?: string,
      ) => Promise<unknown>
    }
    catalogApi.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      catalogRevision: 'rev-circles',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: entriesWithCircle,
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion).toBe('rev-circles')
    })
    // The creator_circle source is derived into a visible relation.
    expect(result.current.creatorCircles).toEqual([
      { circleId: 'circle-1', name: '桥岸圈子' },
    ])

    // The refresh fails: stale relations are invalidated (fail-closed) and
    // the relation entry must not re-echo the previous Catalog.
    catalogApi.productSpaceGetCatalog = async () => ({
      success: false as const,
      errorCode: 'NETWORK_ERROR',
      message: 'catalog unavailable',
    })
    await result.current.sync(true)
    await waitFor(() => {
      expect(result.current.state.errorCode).toBe('NETWORK_ERROR')
    })
    expect(result.current.creatorCircles).toEqual([])
  })

  it('clears derived creator circles when a Catalog refresh throws', async () => {
    const entriesWithCircle = [{
      kind: 'app',
      catalogEntryId: 'circle-app',
      name: 'Circle App',
      description: '',
      availability: 'available',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://example.com/circle-app',
      sortOrder: 0,
      sources: [{
        kind: 'creator_circle',
        circleId: 'circle-1',
        name: '桥岸圈子',
      }],
    }]
    const catalogApi = window.electronAPI as unknown as {
      productSpaceGetCatalog: (
        productSpaceId: string,
        knownRevision?: string,
      ) => Promise<unknown>
    }
    catalogApi.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      catalogRevision: 'rev-circles',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: entriesWithCircle,
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion).toBe('rev-circles')
    })
    expect(result.current.creatorCircles).toEqual([
      { circleId: 'circle-1', name: '桥岸圈子' },
    ])

    // THROWN failure (the fetch promise rejects — distinct from the
    // success:false errorCode path): stale relations are still invalidated.
    catalogApi.productSpaceGetCatalog = async () => {
      throw new Error('socket down')
    }
    await result.current.sync(true)
    await waitFor(() => {
      expect(result.current.state.errorCode).toBe('request_failed')
    })
    expect(result.current.creatorCircles).toEqual([])
  })

  it('clears derived creator circles on a thrown authorization failure', async () => {
    const entriesWithCircle = [{
      kind: 'app',
      catalogEntryId: 'circle-app',
      name: 'Circle App',
      description: '',
      availability: 'available',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://example.com/circle-app',
      sortOrder: 0,
      sources: [{
        kind: 'creator_circle',
        circleId: 'circle-1',
        name: '桥岸圈子',
      }],
    }]
    const catalogApi = window.electronAPI as unknown as {
      productSpaceGetCatalog: (
        productSpaceId: string,
        knownRevision?: string,
      ) => Promise<unknown>
    }
    catalogApi.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      catalogRevision: 'rev-circles',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: entriesWithCircle,
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.appConfigVersion).toBe('rev-circles')
    })
    expect(result.current.creatorCircles).toEqual([
      { circleId: 'circle-1', name: '桥岸圈子' },
    ])

    // THROWN authorization failure (FORBIDDEN, catalog-scoped): the denied
    // fail-closed branch must also invalidate the stale relations.
    catalogApi.productSpaceGetCatalog = async () => {
      throw Object.assign(new Error('Admin request is not permitted'), {
        code: 'FORBIDDEN',
      })
    }
    await result.current.sync(true)
    await waitFor(() => {
      expect(result.current.state.accessMode).toBe('denied')
    })
    expect(result.current.creatorCircles).toEqual([])
  })
})

describe('useAppCatalog ProductSpace launch binding', () => {
  function installStrictCatalogAndResolver(overrides: Record<string, unknown> = {}) {
    const api = window.electronAPI as any
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'strict-revision-1',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: [{
        kind: 'app',
        catalogEntryId: 'catalog-entry-a',
        artifactInstanceId: 'artifact-instance-a',
        version: { versionId: 'version-a', version: '2.3.4' },
        name: 'Bound App',
        description: 'Bound to one artifact instance',
        availability: 'available',
        sources: [{ kind: 'enterprise_import', name: 'Studio A' }],
        permissions: [],
      }],
    })
    api.productSpaceResolveLaunch = mock(async () => ({
      success: true as const,
      launch: {
        contractVersion: 1,
        productSpaceId: 'organization-a',
        catalogEntryId: 'catalog-entry-a',
        resolvedAt: '2099-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:10:00.000Z',
        subject: {
          kind: 'artifact_instance' as const,
          artifactType: 'app' as const,
          artifactInstanceId: 'artifact-instance-a',
          versionId: 'version-a',
          version: '2.3.4',
        },
        payer: { kind: 'personal' as const, accountId: 'account-a' },
        delivery: {
          kind: 'web_url' as const,
          url: 'https://app.example.test',
          launchToken: 'fresh-launch-token',
        },
        ...overrides,
      },
    }))
    return api.productSpaceResolveLaunch as ReturnType<typeof mock>
  }

  it('carries the exact ProductSpace, artifact instance, and version', async () => {
    const resolver = installStrictCatalogAndResolver()
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps[0]?.artifactInstanceId)
        .toBe('artifact-instance-a')
    })

    const app = result.current.state.catalog!.apps[0]!
    const launch = await result.current.resolveLaunch(app)

    expect(resolver).toHaveBeenCalledWith('organization-a', 'catalog-entry-a')
    expect(launch.subject).toMatchObject({
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-a',
      version: '2.3.4',
    })
  })

  it('rejects a valid-looking launch response for another ProductSpace', async () => {
    installStrictCatalogAndResolver({ productSpaceId: 'organization-b' })
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })

    await expect(result.current.resolveLaunch(
      result.current.state.catalog!.apps[0]!,
    )).rejects.toThrow()
  })

  it('binds installation and removal to the exact Catalog artifact version', async () => {
    installStrictCatalogAndResolver()
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const catalogApp = result.current.state.catalog!.apps[0]!

    await result.current.installProductSpaceBundle(catalogApp)
    expect(installProductSpaceBundle).toHaveBeenCalledWith({
      app: {
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        catalogEntryId: 'catalog-entry-a',
        artifactInstanceId: 'artifact-instance-a',
        versionId: 'version-a',
        version: '2.3.4',
      },
    })

    await result.current.uninstallProductSpaceBundle(catalogApp, true)
    expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogEntryId: 'catalog-entry-a',
        artifactInstanceId: 'artifact-instance-a',
        versionId: 'version-a',
      }),
      { preserveData: true },
    )
  })
})

describe('withdrawn tombstones emitted by the Main catalog authority', () => {
  function strictEntry(version: { versionId: string; version: string } = {
    versionId: 'version-a',
    version: '2.3.4',
  }) {
    return {
      kind: 'app' as const,
      catalogEntryId: 'catalog-entry-a',
      artifactInstanceId: 'artifact-instance-a',
      version,
      name: 'Bound App',
      description: 'Bound to one artifact instance',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const, name: 'Studio A' }],
      permissions: ['camera'],
    }
  }

  function withdrawnTombstoneEntry() {
    return {
      kind: 'app' as const,
      catalogEntryId: 'catalog-entry-w',
      artifactInstanceId: 'artifact-w',
      version: { versionId: 'version-w', version: '1.5.0' },
      name: 'Withdrawn App',
      description: 'No longer distributed',
      availability: 'withdrawn' as const,
      sources: [{ kind: 'enterprise_import' as const, name: 'Studio W' }],
      permissions: [],
    }
  }

  function withdrawnInstallStatesInstalled() {
    getProductSpaceWithdrawnInstallStates = mock(async (identities: any[]) =>
      identities.map(identity => ({
        app: identity,
        state: 'installed' as const,
        currentVersion: identity.version as string,
      })))
  }

  it('hydrates persisted tombstones on renderer restart and keeps them uninstallable', async () => {
    const api = window.electronAPI as any
    // Restart scenario: the FIRST response already carries the Main
    // authority's persisted tombstone alongside the live entries.
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'restart-revision-1',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: [strictEntry()],
      withdrawnEntries: [withdrawnTombstoneEntry()],
    })
    withdrawnInstallStatesInstalled()
    const { result } = renderHook(() => useAppCatalog())

    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const tombstone = result.current.state.catalog?.withdrawnApps?.[0]
    expect(tombstone).toMatchObject({
      id: 'catalog-entry-w',
      catalogEntryId: 'catalog-entry-w',
      artifactInstanceId: 'artifact-w',
      catalogVersion: { versionId: 'version-w', version: '1.5.0' },
      availability: 'withdrawn',
      sourceNames: ['Studio W'],
      deliveryMode: 'resolve_launch',
    })
    expect(tombstone?.currentRelease).toBeUndefined()
    expect(tombstone?.remoteUrl).toBeUndefined()

    // The retained installation stays visible and uninstallable through the
    // restricted withdrawn identity channel.
    await waitFor(() => {
      expect(result.current.getInstallState(tombstone!)?.state).toBe('installed')
    })
    expect(getProductSpaceWithdrawnInstallStates).toHaveBeenCalledWith([{
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: 'catalog-entry-w',
      artifactInstanceId: 'artifact-w',
      versionId: 'version-w',
      version: '1.5.0',
    }])

    // A tombstone can never be opened.
    await expect(result.current.resolveLaunch(tombstone!)).rejects.toThrow()

    // Uninstall routes through the withdrawn identity.
    await result.current.uninstallProductSpaceBundle(tombstone!, true)
    expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogEntryId: 'catalog-entry-w',
        artifactInstanceId: 'artifact-w',
      }),
      { preserveData: true },
    )
  })

  it('does not create tombstones on version upgrades and keeps install states fresh', async () => {
    const api = window.electronAPI as any
    let entries = [strictEntry()]
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'upgrade-revision',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries,
    })
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    expect(result.current.state.catalog?.withdrawnApps ?? []).toHaveLength(0)
    const v1 = result.current.state.catalog!.apps[0]!

    // Version upgrade v1 -> v2: the SAME catalogEntryId + artifactInstanceId.
    entries = [strictEntry({ versionId: 'version-b', version: '3.0.0' })]
    await act(async () => {
      await result.current.sync(true)
    })
    await waitFor(() => {
      expect(result.current.state.catalog?.apps[0]?.catalogVersion?.version).toBe('3.0.0')
    })
    // NO tombstone for the old version; the live row replaced it.
    expect(result.current.state.catalog?.withdrawnApps ?? []).toHaveLength(0)
    expect(result.current.state.catalog!.apps).toHaveLength(1)

    const v2 = result.current.state.catalog!.apps[0]!
    expect(v2.catalogVersion).toEqual({ versionId: 'version-b', version: '3.0.0' })
    // Install state keys stayed consistent (no stale active/withdrawn mix).
    await waitFor(() => {
      expect(result.current.getInstallState(v2)).toBeDefined()
    })
    // Direct open resolves against the fresh v2 context.
    const apiResolve = window.electronAPI as any
    apiResolve.productSpaceResolveLaunch = mock(async () => ({
      success: true as const,
      launch: {
        contractVersion: 1,
        productSpaceId: 'organization-a',
        catalogEntryId: 'catalog-entry-a',
        resolvedAt: '2099-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:10:00.000Z',
        subject: {
          kind: 'artifact_instance' as const,
          artifactType: 'app' as const,
          artifactInstanceId: 'artifact-instance-a',
          versionId: 'version-b',
          version: '3.0.0',
        },
        payer: { kind: 'personal' as const, accountId: 'account-a' },
        delivery: {
          kind: 'web_url' as const,
          url: 'https://v2.example.com',
          launchToken: 'v2-launch-token',
        },
      },
    }))
    const resolved = await result.current.resolveLaunch(v2)
    expect(resolved.subject).toMatchObject({ versionId: 'version-b', version: '3.0.0' })
    // The stale v1 object can never resolve (version drift fails closed).
    await expect(result.current.resolveLaunch(v1)).rejects.toThrow()
  })

  it('shows a tombstone after the entry disappears from the fresh Catalog', async () => {
    const api = window.electronAPI as any
    let payload: { entries: unknown[]; withdrawnEntries?: unknown[] } = { entries: [strictEntry()] }
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'disappear-revision',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      ...payload,
    })
    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })

    // Main authority diff: the entry stopped being distributed and returns
    // as a withdrawn tombstone while the fresh entries no longer list it.
    payload = { entries: [], withdrawnEntries: [withdrawnTombstoneEntry()] }
    await act(async () => {
      await result.current.sync(true)
    })

    const tombstone = result.current.state.catalog?.withdrawnApps?.[0]
    expect(tombstone).toBeTruthy()
    expect(result.current.state.catalog?.apps).toHaveLength(0)
    await expect(result.current.resolveLaunch(tombstone!)).rejects.toThrow()
  })

  it('keeps live and withdrawn install states separate when a catalogEntryId is reused across artifact instances', async () => {
    const api = window.electronAPI as any
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'collision-revision',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: [{
        kind: 'app' as const,
        catalogEntryId: 'entry-1',
        artifactInstanceId: 'artifact-new',
        version: { versionId: 'version-new', version: '2.0.0' },
        name: 'Reused Entry',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, name: 'Studio A' }],
        permissions: [],
      }],
      withdrawnEntries: [{
        kind: 'app' as const,
        catalogEntryId: 'entry-1',
        artifactInstanceId: 'artifact-old',
        version: { versionId: 'version-old', version: '1.0.0' },
        name: 'Reused Entry (old)',
        description: '',
        availability: 'withdrawn' as const,
        sources: [{ kind: 'enterprise_import' as const, name: 'Studio A' }],
        permissions: [],
      }],
    })
    getProductSpaceWithdrawnInstallStates = mock(async (identities: any[]) =>
      identities.map(identity => ({
        app: identity,
        state: 'installed' as const,
        currentVersion: identity.version as string,
      })))
    getProductSpaceInstallStates = mock(async (identities: any[]) =>
      identities.map(identity => ({
        app: identity,
        state: 'installed' as const,
        currentVersion: identity.version as string,
      }))) as never

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const live = result.current.state.catalog!.apps[0]!
    const tombstone = result.current.state.catalog!.withdrawnApps?.[0]!
    expect(tombstone).toMatchObject({
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-old',
      availability: 'withdrawn',
    })

    // Both rows keep SEPARATE install states despite the shared
    // catalogEntryId.
    await waitFor(() => {
      expect(result.current.getInstallState(live)?.state).toBe('installed')
      expect(result.current.getInstallState(tombstone)?.state).toBe('installed')
    })
    expect(result.current.getInstallState(live)?.currentVersion).toBe('2.0.0')
    expect(result.current.getInstallState(tombstone)?.currentVersion).toBe('1.0.0')

    // The withdrawn old instance stays uninstallable.
    await result.current.uninstallProductSpaceBundle(tombstone!, true)
    expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogEntryId: 'entry-1',
        artifactInstanceId: 'artifact-old',
        versionId: 'version-old',
      }),
      { preserveData: true },
    )
    // ...and the live new instance keeps its own uninstall path too.
    await result.current.uninstallProductSpaceBundle(live, true)
    expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogEntryId: 'entry-1',
        artifactInstanceId: 'artifact-new',
      }),
      { preserveData: true },
    )
  })
})
