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
import type {
  AppCatalogCacheEntry,
  AppCatalogSyncResult,
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
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
import type { CatalogApp } from '@polo-ai/shared/admin'

GlobalRegistrator.register()
setupI18n()

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

  it('never merges install operations across colon-colliding catalog identities in one hook', async () => {
    const api = window.electronAPI as any
    let installDispatched = 0
    const installGates: Array<() => void> = []
    installProductSpaceBundle = mock((request: any) => {
      installDispatched += 1
      return new Promise<void>(resolve => {
        installGates.push(resolve)
      }).then(() => ({
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
    })

    // One mounted hook (one ProductSpace context): the catalog swaps between
    // two identities whose delimiter-joined op keys would both be
    // 'product-space:a:b:c:v'.
    let current = {
      kind: 'app' as const,
      catalogEntryId: 'c',
      artifactInstanceId: 'a:b',
      version: { versionId: 'v', version: '1.0.0' },
      name: 'Collision A',
      description: '',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const, name: 'Studio' }],
      permissions: [],
    }
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'op-key-revision',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: [current],
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const appA = result.current.state.catalog!.apps[0]!
    const pendingA = result.current.installProductSpaceBundle(appA)
    await waitFor(() => expect(installDispatched).toBe(1))

    // Swap the catalog to the colliding identity while A's install is still
    // in flight, then install B: it must dispatch its OWN IPC instead of
    // riding A's in-flight promise.
    current = {
      ...current,
      catalogEntryId: 'b:c',
      artifactInstanceId: 'a',
      name: 'Collision B',
    }
    await result.current.sync(true)
    await waitFor(() => {
      expect(result.current.state.catalog?.apps[0]?.catalogEntryId).toBe('b:c')
    })
    const appB = result.current.state.catalog!.apps[0]!
    const pendingB = result.current.installProductSpaceBundle(appB)
    await waitFor(() => expect(installDispatched).toBe(2))

    installGates.forEach(release => release())
    await Promise.all([pendingA, pendingB])
    // Each identity dispatched exactly one install.
    expect(installDispatched).toBe(2)
  })

  it('single-flights concurrent same-instance installs without bypassing the in-flight slot', async () => {
    const api = window.electronAPI as any
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'single-flight-revision',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: [{
        kind: 'app' as const,
        catalogEntryId: 'entry-sf',
        artifactInstanceId: 'artifact-sf',
        version: { versionId: 'version-sf', version: '1.0.0' },
        name: 'Single Flight App',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, name: 'Studio SF' }],
        permissions: [],
      }],
    })
    let installDispatched = 0
    const installGates: Array<() => void> = []
    installProductSpaceBundle = mock((request: any) => {
      installDispatched += 1
      return new Promise<void>(resolve => {
        installGates.push(resolve)
      }).then(() => ({
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
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const app = result.current.state.catalog!.apps[0]!
    const first = result.current.installProductSpaceBundle(app)
    const second = result.current.installProductSpaceBundle(app)
    await waitFor(() => expect(installDispatched).toBe(1))
    // The concurrent duplicate rides the in-flight slot: no second IPC.
    installGates.forEach(release => release())
    await Promise.all([first, second])
    expect(installDispatched).toBe(1)
  })

  it('never merges uninstall operations across colon-collision identities, cross-scope reuse, or versions', async () => {
    const api = window.electronAPI as any
    let uninstallDispatched = 0
    const uninstallGates: Array<() => void> = []
    uninstallProductSpaceBundle = mock((identity: any, _options: { preserveData: boolean }) => {
      uninstallDispatched += 1
      return new Promise<void>(resolve => {
        uninstallGates.push(resolve)
      })
    })

    let current = {
      kind: 'app' as const,
      catalogEntryId: 'c',
      artifactInstanceId: 'a:b',
      version: { versionId: 'v', version: '1.0.0' },
      name: 'Collision A',
      description: '',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const, name: 'Studio' }],
      permissions: [],
    }
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'uninstall-key-revision',
      productSpaceId: 'space-a',
      accessMode: 'online' as const,
      entries: [current],
    })
    api.productSpaceResolveLaunch = async () => ({
      success: true as const,
      launch: {
        contractVersion: 1,
        productSpaceId: 'space-a',
        catalogEntryId: current.catalogEntryId,
        resolvedAt: '2099-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:10:00.000Z',
        subject: {
          kind: 'artifact_instance' as const,
          artifactType: 'app' as const,
          artifactInstanceId: current.artifactInstanceId,
          versionId: current.version.versionId,
          version: current.version.version,
        },
        payer: { kind: 'personal' as const, accountId: 'account-a' },
        delivery: {
          kind: 'web_url' as const,
          url: 'https://app.example.test',
          launchToken: 'launch-token-value',
        },
      },
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const appA = result.current.state.catalog!.apps[0]!

    // Uninstall A (colon-joined key would be product-space:a:b:c:v) and hold
    // the slot open.
    const pendingA = result.current.uninstallProductSpaceBundle(appA, true)
    await waitFor(() => expect(uninstallDispatched).toBe(1))

    // Swap the catalog to the COLLIDING identity (artifact a, entry b:c —
    // same delimiter-joined key) while A's uninstall is in flight: B must
    // dispatch its OWN uninstall instead of riding A's promise.
    current = {
      ...current,
      catalogEntryId: 'b:c',
      artifactInstanceId: 'a',
      name: 'Collision B',
    }
    await result.current.sync(true)
    await waitFor(() => {
      expect(result.current.state.catalog?.apps[0]?.catalogEntryId).toBe('b:c')
    })
    const appB = result.current.state.catalog!.apps[0]!
    const pendingB = result.current.uninstallProductSpaceBundle(appB, true)
    await waitFor(() => expect(uninstallDispatched).toBe(2))

    // Release both gates: each identity completes its own uninstall.
    uninstallGates.forEach(release => release())
    await Promise.all([pendingA, pendingB])
    expect(uninstallDispatched).toBe(2)
  })

  it('single-flights concurrent uninstalls of the same stable instance across version updates', async () => {
    const api = window.electronAPI as any
    let uninstallDispatched = 0
    const uninstallGates: Array<() => void> = []
    uninstallProductSpaceBundle = mock((identity: any, _options: { preserveData: boolean }) => {
      uninstallDispatched += 1
      return new Promise<void>(resolve => {
        uninstallGates.push(resolve)
      })
    })

    let version = { versionId: 'version-1', version: '1.0.0' }
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'uninstall-version-revision',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: [{
        kind: 'app' as const,
        catalogEntryId: 'entry-sf',
        artifactInstanceId: 'artifact-sf',
        version,
        name: 'Versioned App',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, name: 'Studio SF' }],
        permissions: [],
      }],
    })

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const appV1 = result.current.state.catalog!.apps[0]!

    // Two concurrent uninstalls of the same stable instance: the second must
    // ride the in-flight slot (no bypass), even though a version update
    // between them changes the version tuple.
    const first = result.current.uninstallProductSpaceBundle(appV1, true)
    await waitFor(() => expect(uninstallDispatched).toBe(1))

    version = { versionId: 'version-2', version: '2.0.0' }
    await result.current.sync(true)
    const appV2 = result.current.state.catalog!.apps[0]!
    const second = result.current.uninstallProductSpaceBundle(appV2, true)

    uninstallGates.forEach(release => release())
    await Promise.all([first, second])
    // The single-flight slot belongs to the stable instance: exactly one IPC.
    expect(uninstallDispatched).toBe(1)
  })

  it('keeps live and withdrawn install states separate when the same artifactInstanceId is reissued under a new catalogEntryId', async () => {
    const api = window.electronAPI as any
    // Legal cross-version history: entry-old (artifact-X, v1) was withdrawn
    // and the artifact was REISSUED as entry-new (artifact-X, v2). Both
    // identities share the SAME runtime scope (artifact-X) but must remain
    // separately addressable install states.
    api.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      contractVersion: 1,
      catalogRevision: 'reissue-revision',
      productSpaceId: 'organization-a',
      accessMode: 'online' as const,
      entries: [{
        kind: 'app' as const,
        catalogEntryId: 'entry-new',
        artifactInstanceId: 'artifact-X',
        version: { versionId: 'version-2', version: '2.0.0' },
        name: 'Reissued App',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, name: 'Studio A' }],
        permissions: [],
      }],
      withdrawnEntries: [{
        kind: 'app' as const,
        catalogEntryId: 'entry-old',
        artifactInstanceId: 'artifact-X',
        version: { versionId: 'version-1', version: '1.0.0' },
        name: 'Reissued App (old)',
        description: '',
        availability: 'withdrawn' as const,
        sources: [{ kind: 'enterprise_import' as const, name: 'Studio A' }],
        permissions: [],
      }],
    })
    // The retained installation reports through BOTH channels (the runtime
    // scope is the shared artifact instance).
    getProductSpaceInstallStates = mock(async (identities: any[]) =>
      identities.map(identity => ({
        app: identity,
        state: 'installed' as const,
        currentVersion: identity.version as string,
      }))) as never
    getProductSpaceWithdrawnInstallStates = mock(async (identities: any[]) =>
      identities.map(identity => ({
        app: identity,
        state: 'installed' as const,
        currentVersion: identity.version as string,
      })))

    const { result } = renderHook(() => useAppCatalog())
    await waitFor(() => {
      expect(result.current.state.catalog?.apps).toHaveLength(1)
    })
    const live = result.current.state.catalog!.apps[0]!
    const withdrawn = result.current.state.catalog!.withdrawnApps?.[0]!

    // Both echoed states COEXIST (no reconciliation wipe).
    await waitFor(() => {
      expect(result.current.getInstallState(live)?.state).toBe('installed')
      expect(result.current.getInstallState(withdrawn)?.state).toBe('installed')
    })
    expect(result.current.getInstallState(live)?.currentVersion).toBe('2.0.0')
    expect(result.current.getInstallState(withdrawn)?.currentVersion).toBe('1.0.0')

    // The withdrawn row keeps its uninstall entry (its own identity).
    await result.current.uninstallProductSpaceBundle(withdrawn, true)
    expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogEntryId: 'entry-old',
        artifactInstanceId: 'artifact-X',
        versionId: 'version-1',
      }),
      { preserveData: true },
    )
    // ...and the live row uninstalls as its own identity too.
    await result.current.uninstallProductSpaceBundle(live, true)
    expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogEntryId: 'entry-new',
        artifactInstanceId: 'artifact-X',
        versionId: 'version-2',
      }),
      { preserveData: true },
    )
  })
})


describe('real ProductSpace payload projection through useAppCatalog into the UI', () => {
  function rawEntry(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'app' as const,
      catalogEntryId: 'entry-live',
      artifactInstanceId: 'artifact-live',
      version: { versionId: 'version-live', version: '1.0.0' },
      name: 'Live App',
      description: 'launchable',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const, name: 'Studio L' }],
      permissions: [],
      ...overrides,
    }
  }

  async function mountCatalog(entries: unknown[], spaceId = 'organization-a', accountId = 'account-a') {
    productSpaceContextState = productSpaceContext(spaceId, accountId)
    const catalogApi = window.electronAPI as unknown as {
      productSpaceGetCatalog: (
        productSpaceId: string,
        knownRevision?: string,
      ) => Promise<unknown>
    }
    catalogApi.productSpaceGetCatalog = async () => ({
      success: true as const,
      notModified: false as const,
      catalogRevision: `rev-${spaceId}-${accountId}`,
      productSpaceId: spaceId,
      accessMode: 'online' as const,
      entries,
    })
    const react = await import('@testing-library/react')
    const { result } = react.renderHook(() => useAppCatalog())
    await react.waitFor(() => {
      if (result.current.state.catalog === null) throw new Error('catalog pending')
    })
    return result
  }

  it('a version_blocked raw entry reaches the blocked badge, reason reveal, and pin gating', async () => {
    const result = await mountCatalog([
      rawEntry(),
      rawEntry({
        catalogEntryId: 'entry-blocked',
        artifactInstanceId: 'artifact-blocked',
        name: 'Blocked App',
        availability: 'blocked',
        unavailableReason: 'version_blocked',
      }),
    ])
    // The production mapper normalizes the blocked raw entry.
    const blockedApp = result.current.state.catalog!.apps.find(
      (app: CatalogApp) => app.catalogEntryId === 'entry-blocked',
    )
    expect(blockedApp).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'version_blocked',
    })
    // A blocked App can never enter the home pin source (available only).
    expect(
      result.current.state.catalog!.apps.filter(
        (app: CatalogApp) => app.availability === 'available',
      ).map((app: CatalogApp) => app.catalogEntryId),
    ).toEqual(['entry-live'])

    // AllAppsView rendered with the REAL mapped apps and the REAL identity
    // keys from the hook (no test-side algorithm).
    const { AllAppsView } = await import('@/components/tab-browser/AllAppsView')
    const react = await import('@testing-library/react')
    const { createElement } = await import('react')
    const { I18nextProvider } = await import('react-i18next')
    react.render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AllAppsView, {
        spaceName: 'Space',
        spaceKind: 'enterprise',
        apps: result.current.state.catalog!.apps,
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        offline: false,
        restricted: false,
        circleCount: 0,
        pinnedIds: new Set<string>(),
        onPin: () => {},
        getInstallState: () => undefined,
        identityKeyForApp: result.current.uiIdentityKeyForApp,
        onRefresh: () => {},
        onOpen: () => {},
        onUninstall: () => {},
        onBack: () => {},
      }),
    ))
    const blockedKey = result.current.uiIdentityKeyForApp(blockedApp!)
    expect(react.screen.getByText('Blocked')).toBeTruthy()
    const reasonControl = react.screen.getByTestId(`all-apps-reason-${blockedKey}`)
    expect((reasonControl as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    react.fireEvent.click(reasonControl)
    expect(react.screen.getByTestId(`all-apps-reason-text-${blockedKey}`).textContent)
      .toContain('Version blocked')
    expect((reasonControl as HTMLElement).getAttribute('aria-expanded')).toBe('true')
    expect(react.screen.queryByTestId(`all-apps-pin-${blockedKey}`)).toBeNull()
    const liveApp = result.current.state.catalog!.apps.find(
      (app: CatalogApp) => app.catalogEntryId === 'entry-live',
    )
    expect(react.screen.getByTestId(`all-apps-pin-${result.current.uiIdentityKeyForApp(liveApp!)}`))
      .toBeTruthy()
    react.cleanup()
  })

  it('both identity collision directions stay distinct through real pin/open/uninstall behavior', async () => {
    const result = await mountCatalog([
      rawEntry({
        catalogEntryId: 'entry-s1',
        name: 'Shared S1',
      }),
      rawEntry({
        catalogEntryId: 'entry-s2',
        name: 'Shared S2',
      }),
      rawEntry({
        catalogEntryId: 'entry-dup',
        artifactInstanceId: 'artifact-old',
        name: 'Dup Old',
      }),
      rawEntry({
        catalogEntryId: 'entry-dup',
        artifactInstanceId: 'artifact-new',
        name: 'Dup New',
      }),
    ])
    const apps: CatalogApp[] = result.current.state.catalog!.apps
    expect(apps).toHaveLength(4)
    // Production keys: both collision directions produce DISTINCT identities.
    const keys = apps.map(app => result.current.uiIdentityKeyForApp(app))
    expect(new Set(keys).size).toBe(4)

    const { AllAppsView } = await import('@/components/tab-browser/AllAppsView')
    const react = await import('@testing-library/react')
    const { createElement } = await import('react')
    const { I18nextProvider } = await import('react-i18next')
    const onPin = jest.fn()
    const onOpen = jest.fn()
    const onUninstall = jest.fn()
    react.render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AllAppsView, {
        spaceName: 'Space',
        spaceKind: 'enterprise',
        apps,
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        offline: false,
        restricted: false,
        circleCount: 0,
        pinnedIds: new Set<string>(),
        onPin,
        getInstallState: (target: CatalogApp) => target.artifactInstanceId === 'artifact-new'
          ? {
            app: {
              accountId: 'account-a',
              productSpaceId: 'organization-a',
              catalogEntryId: target.catalogEntryId!,
              artifactInstanceId: target.artifactInstanceId!,
              versionId: target.catalogVersion!.versionId,
              version: target.catalogVersion!.version,
            },
            state: 'installed' as const,
            currentVersion: target.catalogVersion!.version,
          }
          : undefined,
        identityKeyForApp: result.current.uiIdentityKeyForApp,
        onRefresh: () => {},
        onOpen,
        onUninstall,
        onBack: () => {},
      }),
    ))
    // Four distinct rows, each pinnable through its own production key.
    expect(react.screen.getAllByTestId('all-apps-row')).toHaveLength(4)
    for (const key of keys) {
      react.fireEvent.click(react.screen.getByTestId(`all-apps-pin-${key}`))
    }
    expect(onPin).toHaveBeenCalledTimes(4)
    const pinnedTargets = new Set(onPin.mock.calls.map((call: any[]) => {
      const app = call[0] as CatalogApp
      return `${app.catalogEntryId}:${app.artifactInstanceId}`
    }))
    expect(pinnedTargets.size).toBe(4)
    // Open targets the exact row's identity — never a colliding sibling.
    for (const app of apps) {
      react.fireEvent.click(react.screen.getByTestId(`all-apps-action-${result.current.uiIdentityKeyForApp(app)}`))
    }
    expect(onOpen.mock.calls.map((call: any[]) => (call[0] as CatalogApp).artifactInstanceId).sort())
      .toEqual(['artifact-live', 'artifact-live', 'artifact-new', 'artifact-old'])
    // Uninstall exists ONLY for the installed artifact-new row and targets it.
    const uninstallButtons = react.screen.getAllByTestId(/^all-apps-uninstall-/)
    expect(uninstallButtons).toHaveLength(1)
    react.fireEvent.click(uninstallButtons[0]!)
    expect(onUninstall).toHaveBeenCalledTimes(1)
    expect((onUninstall.mock.calls[0]![0] as CatalogApp).artifactInstanceId).toBe('artifact-new')
    react.cleanup()
  })

  it('the same entry+artifact under another account/space yields a different production identity', async () => {
    const entries = [rawEntry()]
    const spaceA = await mountCatalog(entries, 'organization-a', 'account-a')
    const spaceB = await mountCatalog(entries, 'organization-b', 'account-b')
    const appA: CatalogApp = spaceA.current.state.catalog!.apps[0]
    const appB: CatalogApp = spaceB.current.state.catalog!.apps[0]
    expect(appA.catalogEntryId).toBe(appB.catalogEntryId)
    expect(appA.artifactInstanceId).toBe(appB.artifactInstanceId)
    expect(spaceA.current.uiIdentityKeyForApp(appA))
      .not.toBe(spaceB.current.uiIdentityKeyForApp(appB))
    cleanup()
  })
})
