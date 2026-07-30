import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { AppCatalogCacheEntry } from '@polo-ai/shared/admin'
import type {
  CatalogLocalAppScope,
  LocalAppRuntimeStatus,
} from '@polo-ai/shared/protocol'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'

type Handler = (
  context: { clientId: string; signal: AbortSignal },
  ...args: unknown[]
) => unknown

let signedInAccountId: string | null = 'account-a'
let accessMode: 'online' | 'offline' | 'denied' = 'online'
let catalog: AppCatalogCacheEntry = createCatalog(1)

const getCachedAppCatalog = mock(() => catalog)
const getAppCatalogAccessMode = mock(() => accessMode)
const scopedInstall = mock(async (request: {
  scope: CatalogLocalAppScope
  version: string
  downloadUrl: string
  checksum: string
  sizeBytes: number
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'arm64' | 'x64'
}) => ({
  appId: request.scope.catalogAppId,
  scope: request.scope,
  currentVersion: request.version,
  versions: [request.version],
  runtime: 'static' as const,
  status: 'installed' as const,
  installedAt: 1,
}))
const scopedStart = mock(async (scope: CatalogLocalAppScope) => ({
  appId: scope.catalogAppId,
  scope,
  version: '1.2.3',
  url: 'http://127.0.0.1:9876',
  port: 9876,
}))
const scopedStatuses = mock(async (
  scopes: CatalogLocalAppScope[],
): Promise<LocalAppRuntimeStatus[]> => scopes.map(scope => ({
  appId: scope.catalogAppId,
  scope,
  status: 'not_installed',
})))
const isInstalledAndReady = mock(async () => true)

const scopedRegistry = {
  install: scopedInstall,
  cancelInstall: mock(async () => false),
  start: scopedStart,
  stop: mock(async (scope: CatalogLocalAppScope) => ({
    appId: scope.catalogAppId,
    scope,
    status: 'stopped' as const,
  })),
  restart: scopedStart,
  uninstall: mock(async () => {}),
  setAvailableRelease: mock(async (scope: CatalogLocalAppScope) => ({
    appId: scope.catalogAppId,
    scope,
    status: 'installed' as const,
  })),
  getInstalledApps: mock(async () => []),
  getRuntimeStatus: mock(async (
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeStatus> => ({
    appId: scope.catalogAppId,
    scope,
    status: 'not_installed',
  })),
  getRuntimeStatuses: scopedStatuses,
  getLogs: mock(async () => ''),
  isInstalledAndReady,
}

const legacyManager = {
  install: mock(async () => ({
    appId: 'legacy-app',
    currentVersion: '1.0.0',
    versions: ['1.0.0'],
    runtime: 'static' as const,
    status: 'installed' as const,
    installedAt: 1,
  })),
  cancelInstall: mock(() => false),
  start: mock(async () => ({
    appId: 'legacy-app',
    version: '1.0.0',
    url: 'http://127.0.0.1:9877',
    port: 9877,
  })),
  stop: mock(async () => ({ appId: 'legacy-app', status: 'stopped' as const })),
  restart: mock(async () => ({
    appId: 'legacy-app',
    version: '1.0.0',
    url: 'http://127.0.0.1:9877',
    port: 9877,
  })),
  uninstall: mock(async () => {}),
  setAvailableRelease: mock(async () => ({
    appId: 'legacy-app',
    status: 'installed' as const,
  })),
  getInstalledApps: mock(async () => []),
  getRuntimeStatus: mock(async () => ({
    appId: 'legacy-app',
    status: 'not_installed' as const,
  })),
  getLogs: mock(async () => ''),
}

mock.module('@polo-ai/shared/admin', () => ({
  getCachedAppCatalog,
  getAppCatalogAccessMode,
  getAppCatalogApps: (entry: AppCatalogCacheEntry) => [
    ...entry.apps,
    ...(entry.withdrawnApps ?? []),
  ],
}))

mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => ({
    getAdminTokens: async () => signedInAccountId
      ? { userId: signedInAccountId }
      : null,
  }),
}))

mock.module('../../local-app-runtime', () => {
  class LocalAppRuntimeError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message)
    }
  }

  return {
    getLocalAppRuntimeManager: () => legacyManager,
    getScopedLocalAppRuntimeRegistry: () => scopedRegistry,
    LocalAppRuntimeError,
    MAX_CATALOG_STATUS_SCOPES: 10_000,
    validateCatalogLocalAppScope(value: unknown): CatalogLocalAppScope {
      if (
        !value
        || typeof value !== 'object'
        || (value as CatalogLocalAppScope).kind !== 'catalog'
      ) {
        throw new LocalAppRuntimeError('INVALID_REQUEST', 'Catalog scope required')
      }
      return value as CatalogLocalAppScope
    },
  }
})

const { registerLocalAppHandlers } = await import('../local-apps')

function createCatalog(count: number): AppCatalogCacheEntry {
  return {
    accountId: 'account-a',
    organizationId: 'organization-a',
    appConfigVersion: 'version-1',
    authorizationStatus: 'authorized' as const,
    apps: Array.from({ length: count }, (_, index) => ({
      id: index === 0 ? '应用.App-ID' : `app-${index}`,
      organizationId: 'organization-a',
      name: `App ${index}`,
      description: '',
      deliveryMode: 'local_bundle' as const,
      currentRelease: {
        version: 'v1.2.3',
        runtime: 'static' as const,
        downloadUrl: 'https://catalog.example/app.zip',
        checksum: 'a'.repeat(64),
        sizeBytes: 321,
        platform: 'darwin' as const,
        arch: 'arm64' as const,
      },
      sortOrder: index,
      availability: 'available' as const,
    })),
    syncedAt: 1,
  }
}

function scope(catalogAppId = '应用.App-ID'): CatalogLocalAppScope {
  return {
    kind: 'catalog',
    accountId: 'account-a',
    organizationId: 'organization-a',
    catalogAppId,
  }
}

describe('local app main-process authorization boundary', () => {
  const handlers = new Map<string, Handler>()
  const context = {
    clientId: 'renderer',
    signal: new AbortController().signal,
  }

  beforeEach(() => {
    signedInAccountId = 'account-a'
    accessMode = 'online'
    catalog = createCatalog(1)
    handlers.clear()
    for (const handlerMock of [
      getCachedAppCatalog,
      getAppCatalogAccessMode,
      scopedInstall,
      scopedStart,
      scopedStatuses,
      isInstalledAndReady,
      scopedRegistry.getRuntimeStatus,
      scopedRegistry.setAvailableRelease,
    ]) {
      handlerMock.mockClear()
    }
    scopedStatuses.mockImplementation(async scopes => scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'not_installed',
    })))
    const server = {
      handle(channel, handler) {
        handlers.set(channel, handler as Handler)
      },
      push() {},
      async invokeClient() {
        return null
      },
      hasClientCapability() {
        return false
      },
      findClientsWithCapability() {
        return []
      },
    } satisfies RpcServer
    registerLocalAppHandlers(server)
  })

  it('constructs catalog installation metadata only from the authorized cached release', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    await install(context, {
      scope: scope(),
      version: '9.9.9',
      downloadUrl: 'https://attacker.example/bundle.zip',
      checksum: 'b'.repeat(64),
      sizeBytes: 999,
    })

    expect(scopedInstall).toHaveBeenCalledWith({
      scope: scope(),
      version: 'v1.2.3',
      downloadUrl: 'https://catalog.example/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 321,
      platform: 'darwin',
      arch: 'arm64',
    }, { signal: context.signal })
  })

  it('derives update state in main and preserves trusted metadata for invalid versions', async () => {
    const setAvailableRelease = handlers.get(
      RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
    )!
    scopedRegistry.getRuntimeStatus.mockResolvedValueOnce({
      appId: '应用.App-ID',
      scope: scope(),
      status: 'installed',
      currentVersion: '1.0.0',
    })

    await setAvailableRelease(context, scope(), null)
    expect(scopedRegistry.setAvailableRelease).toHaveBeenCalledWith(
      scope(),
      catalog.apps[0]!.currentRelease,
    )

    catalog.apps[0] = {
      ...catalog.apps[0]!,
      currentRelease: {
        ...catalog.apps[0]!.currentRelease!,
        version: '1.2.3.4',
      },
    }
    scopedRegistry.getRuntimeStatus.mockResolvedValueOnce({
      appId: '应用.App-ID',
      scope: scope(),
      status: 'update_available',
      currentVersion: '1.0.0',
      availableRelease: { version: '1.1.0' },
    })
    scopedRegistry.setAvailableRelease.mockClear()

    await expect(setAvailableRelease(context, scope(), null)).resolves.toMatchObject({
      versionError: 'invalid_semver',
      availableRelease: { version: '1.1.0' },
    })
    expect(scopedRegistry.setAvailableRelease).not.toHaveBeenCalled()
  })

  it('fails closed for missing scope, remote apps, and missing releases', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    await expect(install(context, {
      appId: '应用.App-ID',
      version: '1.2.3',
    })).rejects.toThrow('explicit catalog or legacy install scope')

    catalog.apps[0] = {
      ...catalog.apps[0]!,
      deliveryMode: 'remote_url',
      remoteUrl: 'https://example.com',
      currentRelease: undefined,
    }
    await expect(install(context, { scope: scope() }))
      .rejects.toThrow('Remote URL apps')

    catalog.apps[0] = {
      ...createCatalog(1).apps[0]!,
      currentRelease: undefined,
    }
    await expect(install(context, { scope: scope() }))
      .rejects.toThrow('no installable release')
  })

  it('resolves remote URLs from the trusted cache and rejects stale access after denial', async () => {
    catalog.apps[0] = {
      ...catalog.apps[0]!,
      deliveryMode: 'remote_url',
      remoteUrl: 'https://trusted.example.com/app',
      currentRelease: undefined,
    }
    const resolveRemoteUrl = handlers.get(
      RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
    )!

    await expect(resolveRemoteUrl(context, scope())).resolves.toEqual({
      appId: '应用.App-ID',
      scope: scope(),
      url: 'https://trusted.example.com/app',
    })

    accessMode = 'denied'
    await expect(resolveRemoteUrl(context, scope()))
      .rejects.toThrow('no longer authorized')

    accessMode = 'online'
    catalog.authorizationStatus = 'denied'
    await expect(resolveRemoteUrl(context, scope()))
      .rejects.toThrow('no longer authorized')
  })

  it('rejects catalog lifecycle operations for another or signed-out account', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    signedInAccountId = 'account-b'
    await expect(start(context, scope()))
      .rejects.toThrow('different or signed-out account')

    signedInAccountId = null
    await expect(start(context, scope()))
      .rejects.toThrow('different or signed-out account')
    expect(scopedStart).not.toHaveBeenCalled()
  })

  it('allows restricted offline start only for an installed prepared app', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    accessMode = 'offline'

    await expect(start(context, scope())).resolves.toMatchObject({
      appId: '应用.App-ID',
    })
    expect(isInstalledAndReady).toHaveBeenCalledWith(scope())
    await expect(install(context, { scope: scope() }))
      .rejects.toThrow('unavailable while offline')

    isInstalledAndReady.mockResolvedValueOnce(false)
    await expect(start(context, scope()))
      .rejects.toThrow('installed and prepared')
  })

  it('retains a full-directory tombstone but rejects its launch and status access', async () => {
    const withdrawn = {
      ...catalog.apps[0]!,
      availability: 'withdrawn' as const,
    }
    catalog.apps = Array.from({ length: 10_000 }, (_, index) => ({
      ...catalog.apps[0]!,
      id: `visible-${index}`,
    }))
    catalog.withdrawnApps = [withdrawn]
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const getStatuses = handlers.get(
      RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES,
    )!

    await expect(start(context, scope(withdrawn.id)))
      .rejects.toThrow('no longer authorized')
    await expect(getStatuses(context, { scopes: [scope(withdrawn.id)] }))
      .resolves.toEqual([{
        appId: withdrawn.id,
        scope: scope(withdrawn.id),
        status: 'not_installed',
      }])
    expect(catalog.apps).toHaveLength(10_000)
    expect(catalog.withdrawnApps).toEqual([withdrawn])
  })

  it('reads authorization once and returns complete 1,000, 1,001, and 10,000 batches', async () => {
    const getStatuses = handlers.get(RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES)!
    scopedStatuses.mockImplementation(async scopes => scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'installed',
      currentVersion: '1.0.0',
    })))

    for (const count of [1_000, 1_001, 10_000]) {
      catalog = createCatalog(count)
      getCachedAppCatalog.mockClear()
      scopedStatuses.mockClear()
      scopedRegistry.setAvailableRelease.mockClear()
      const scopes = catalog.apps.map(app => scope(app.id))
      const statuses = await getStatuses(context, { scopes }) as LocalAppRuntimeStatus[]

      expect(statuses).toHaveLength(count)
      expect(statuses.at(-1)?.appId).toBe(scopes.at(-1)?.catalogAppId)
      expect(statuses[0]).toMatchObject({
        status: 'update_available',
        currentVersion: '1.0.0',
        availableRelease: catalog.apps[0]!.currentRelease,
      })
      expect(getCachedAppCatalog).toHaveBeenCalledTimes(1)
      expect(scopedStatuses).toHaveBeenCalledTimes(1)
      expect(scopedStatuses).toHaveBeenLastCalledWith(scopes)
      expect(scopedRegistry.setAvailableRelease).not.toHaveBeenCalled()
    }
  })

  it('keeps trusted batch update metadata visible when either version is invalid', async () => {
    const getStatuses = handlers.get(RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES)!
    const trustedRelease = {
      ...catalog.apps[0]!.currentRelease!,
      version: '1.1.0',
    }
    scopedStatuses.mockImplementation(async scopes => scopes.map(item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'installed',
      currentVersion: '1.0.0',
    })))
    catalog.apps[0] = {
      ...catalog.apps[0]!,
      currentRelease: {
        ...catalog.apps[0]!.currentRelease!,
        version: '1.2.3.4',
      },
    }
    catalog.trustedReleases = { '应用.App-ID': trustedRelease }

    await expect(getStatuses(context, { scopes: [scope()] })).resolves.toEqual([
      expect.objectContaining({
        status: 'update_available',
        versionError: 'invalid_semver',
        availableRelease: trustedRelease,
      }),
    ])

    catalog = createCatalog(1)
    scopedStatuses.mockImplementation(async scopes => scopes.map(item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'installed',
      currentVersion: 'release-one',
    })))
    await expect(getStatuses(context, { scopes: [scope()] })).resolves.toEqual([
      expect.objectContaining({
        versionError: 'invalid_semver',
        availableRelease: catalog.apps[0]!.currentRelease,
      }),
    ])
    expect(scopedRegistry.setAvailableRelease).not.toHaveBeenCalled()
  })
})
