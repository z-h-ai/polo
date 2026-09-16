import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { AppCatalogCacheEntry } from '@polo-ai/shared/admin'
import type {
  CatalogLocalAppScope,
  LocalAppInstalledApp,
  LocalAppRuntimeStatus,
} from '@polo-ai/shared/protocol'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'

type Handler = (
  context: { clientId: string; signal: AbortSignal },
  ...args: unknown[]
) => unknown

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

let signedInAccountId: string | null = 'account-a'
let accessMode: 'online' | 'offline' | 'denied' = 'online'
let accountAccessDenied = false
let appAccessDenied = false
let catalog: AppCatalogCacheEntry = createCatalog(1)

const getCachedAppCatalog = mock(() => catalog)
const getAppCatalogAccessMode = mock(() => accessMode)
const getAppReleaseDownload = mock(async (
  _accessToken: string,
  _organizationId: string,
  _appId: string,
  releaseId: string,
) => ({
  releaseId,
  downloadUrl: 'https://catalog.example/signed-download',
  expiresAt: '2026-08-01T12:10:00.000Z',
  checksum: 'a'.repeat(64),
  sizeBytes: 321,
  runtime: 'static' as const,
  platform: 'darwin' as const,
  arch: 'arm64' as const,
}))
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
const scopedRuntimeStatus = mock(async (
  scope: CatalogLocalAppScope,
): Promise<LocalAppRuntimeStatus> => ({
  appId: scope.catalogAppId,
  scope,
  status: 'not_installed',
}))
const scopedInstalledApps = mock(async (
  _scope: CatalogLocalAppScope,
): Promise<LocalAppInstalledApp[]> => [])
const scopedFailureRecoveryLogs = mock(async (
  scope: CatalogLocalAppScope,
  _options?: { tail?: number },
) => {
  const status = await scopedRuntimeStatus(scope)
  if (status.status !== 'broken') {
    throw Object.assign(new Error('Logs require a broken runtime'), {
      code: 'NOT_AUTHORIZED',
    })
  }
  return ''
})
const scopedRetainedManagementLogs = mock(async (
  scope: CatalogLocalAppScope,
  _options?: { tail?: number },
) => {
  const status = await scopedRuntimeStatus(scope)
  if (
    !status.currentVersion
    || ![
      'installed',
      'running',
      'stopped',
      'broken',
      'update_available',
    ].includes(status.status)
  ) {
    throw Object.assign(new Error('Logs require a retained installation'), {
      code: 'NOT_AUTHORIZED',
    })
  }
  return ''
})
const isInstalledAndReady = mock(async () => true)
const assertAppAuthorized = mock(() => {
  if (appAccessDenied) {
    throw Object.assign(new Error('Catalog app authorization is ending'), {
      code: 'NOT_AUTHORIZED',
    })
  }
})

const scopedRegistry = {
  assertAppAuthorized,
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
  getInstalledApps: scopedInstalledApps,
  getRuntimeStatus: scopedRuntimeStatus,
  getRuntimeStatuses: scopedStatuses,
  getLogs: mock(async () => ''),
  getFailureRecoveryLogs: scopedFailureRecoveryLogs,
  getRetainedManagementLogs: scopedRetainedManagementLogs,
  isInstalledAndReady,
}

mock.module('@polo-ai/shared/admin', () => ({
  AdminClient: class {
    getAppReleaseDownload = getAppReleaseDownload
  },
  analyzeCreatorAppPayload: () => ({ status: 'invalid', message: 'not configured' }),
  createCanonicalCreatorAppBundle: () => { throw new Error('not configured') },
  decodeCreatorAppPayloadZip: () => { throw new Error('not configured') },
  normalizeCreatorAppPayloadRoot: (entries: unknown) => entries,
  resolveCreatorAppPublishingOrganization: () => ({ organizationId: null, source: 'none' }),
  getCachedAppCatalog,
  getAppCatalogAccessMode,
  isAppCatalogAccessDeniedForAccount: () => accountAccessDenied,
  getAppCatalogApps: (entry: AppCatalogCacheEntry) => [
    ...entry.apps,
    ...(entry.withdrawnApps ?? []),
  ],
}))

mock.module('@polo-ai/shared/config', () => ({
  getAdminUrl: () => 'https://admin.example.com',
}))

mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => ({
    getAdminTokens: async () => signedInAccountId
      ? { userId: signedInAccountId, accessToken: `${signedInAccountId}-access` }
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
    getLocalAppRuntimeManager: () => {
      throw new Error('renderer RPC must never reach the trusted legacy manager')
    },
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

function confirmedRelease() {
  return {
    version: 'v1.2.3',
    runtime: 'static' as const,
    checksum: 'a'.repeat(64),
    sizeBytes: 321,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
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
    accountAccessDenied = false
    appAccessDenied = false
    catalog = createCatalog(1)
    getAppReleaseDownload.mockClear()
    handlers.clear()
    for (const handlerMock of [
      getCachedAppCatalog,
      getAppCatalogAccessMode,
      assertAppAuthorized,
      scopedInstall,
      scopedRegistry.cancelInstall,
      scopedStart,
      scopedRegistry.stop,
      scopedRegistry.uninstall,
      scopedStatuses,
      isInstalledAndReady,
      scopedRegistry.getInstalledApps,
      scopedRuntimeStatus,
      scopedRegistry.setAvailableRelease,
      scopedRegistry.getLogs,
      scopedFailureRecoveryLogs,
      scopedRetainedManagementLogs,
    ]) {
      handlerMock.mockClear()
    }
    scopedStatuses.mockImplementation(async scopes => scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'not_installed',
    })))
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'not_installed',
    }))
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

  it('requests a short-lived download grant for the currently authorized release', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    catalog.apps[0] = {
      ...catalog.apps[0]!,
      currentRelease: {
        ...catalog.apps[0]!.currentRelease!,
        id: 'release-1',
        downloadUrl: undefined,
      },
    }

    await expect(install(context, {
      scope: scope(),
      appConfigVersion: 'version-1',
      permissions: [],
      release: confirmedRelease(),
    })).resolves.toMatchObject({ status: 'installed' })

    expect(getAppReleaseDownload).toHaveBeenCalledWith(
      'account-a-access',
      'organization-a',
      '应用.App-ID',
      'release-1',
    )
    expect(scopedInstall).toHaveBeenCalledWith(expect.objectContaining({
      downloadUrl: 'https://catalog.example/signed-download',
      checksum: 'a'.repeat(64),
    }), expect.anything())
  })

  it('constructs catalog installation metadata only from the authorized cached release', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    await install(context, {
      scope: scope(),
      appConfigVersion: 'version-1',
      permissions: [],
      release: confirmedRelease(),
      downloadUrl: 'https://attacker.example/bundle.zip',
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

  it('rejects every stale confirmed Release fingerprint before download', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    const staleFingerprints = [
      { ...confirmedRelease(), version: '1.2.2' },
      { ...confirmedRelease(), checksum: 'b'.repeat(64) },
      { ...confirmedRelease(), sizeBytes: 322 },
      { ...confirmedRelease(), platform: null },
      { ...confirmedRelease(), arch: null },
    ]

    for (const release of staleFingerprints) {
      await expect(install(context, {
        scope: scope(),
        appConfigVersion: 'version-1',
        permissions: [],
        release,
      })).rejects.toMatchObject({ code: 'RELEASE_CHANGED' })
    }
    expect(scopedInstall).not.toHaveBeenCalled()
  })

  it('rejects changed permissions from the confirmed Catalog snapshot', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    catalog.apps[0] = {
      ...catalog.apps[0]!,
      permissions: ['camera', 'selected files'],
    }

    await expect(install(context, {
      scope: scope(),
      appConfigVersion: 'version-1',
      permissions: ['camera'],
      release: confirmedRelease(),
    })).rejects.toMatchObject({ code: 'RELEASE_CHANGED' })
    expect(scopedInstall).not.toHaveBeenCalled()
  })

  it('compares confirmed permissions as a normalized set', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    catalog.apps[0] = {
      ...catalog.apps[0]!,
      permissions: ['selected files', 'camera', 'camera'],
    }

    await install(context, {
      scope: scope(),
      appConfigVersion: 'version-1',
      permissions: [' camera ', 'selected files', 'camera'],
      release: confirmedRelease(),
    })

    expect(scopedInstall).toHaveBeenCalledTimes(1)
  })

  it('rejects a confirmation from an older appConfigVersion', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    catalog = {
      ...catalog,
      appConfigVersion: 'version-2',
    }

    await expect(install(context, {
      scope: scope(),
      appConfigVersion: 'version-1',
      permissions: [],
      release: confirmedRelease(),
    })).rejects.toMatchObject({ code: 'RELEASE_CHANGED' })
    expect(scopedInstall).not.toHaveBeenCalled()
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

  it('keeps large numeric SemVer identifiers valid and ordered in main', async () => {
    const setAvailableRelease = handlers.get(
      RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
    )!
    catalog.apps[0] = {
      ...catalog.apps[0]!,
      currentRelease: {
        ...catalog.apps[0]!.currentRelease!,
        version: '90071992547409931234567890.0.0',
      },
    }
    scopedRegistry.getRuntimeStatus.mockResolvedValueOnce({
      appId: '应用.App-ID',
      scope: scope(),
      status: 'installed',
      currentVersion: '9007199254740993123456789.0.0',
    })

    await setAvailableRelease(context, scope(), null)

    expect(scopedRegistry.setAvailableRelease).toHaveBeenCalledWith(
      scope(),
      catalog.apps[0]!.currentRelease,
    )
  })

  it('rejects padded and uppercase-V SemVer consistently in the main process', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    const setAvailableRelease = handlers.get(
      RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
    )!
    catalog.apps[0] = {
      ...catalog.apps[0]!,
      currentRelease: {
        ...catalog.apps[0]!.currentRelease!,
        version: ' 1.2.3',
      },
    }
    scopedRegistry.getRuntimeStatus.mockResolvedValueOnce({
      appId: '应用.App-ID',
      scope: scope(),
      status: 'installed',
      currentVersion: '1.0.0',
    })

    await expect(setAvailableRelease(context, scope(), null)).resolves.toMatchObject({
      versionError: 'invalid_semver',
    })
    expect(scopedRegistry.setAvailableRelease).not.toHaveBeenCalled()

    await expect(install(context, {
      scope: scope(),
      appConfigVersion: 'version-1',
      permissions: [],
      release: {
        ...confirmedRelease(),
        version: ' 1.2.3',
      },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(scopedInstall).not.toHaveBeenCalled()

    catalog.apps[0] = {
      ...catalog.apps[0]!,
      currentRelease: {
        ...catalog.apps[0]!.currentRelease!,
        version: 'V1.2.3',
      },
    }
    scopedRegistry.getRuntimeStatus.mockResolvedValueOnce({
      appId: '应用.App-ID',
      scope: scope(),
      status: 'installed',
      currentVersion: '1.0.0',
    })

    await expect(setAvailableRelease(context, scope(), null)).resolves.toMatchObject({
      versionError: 'invalid_semver',
    })
    expect(scopedRegistry.setAvailableRelease).not.toHaveBeenCalled()

    await expect(install(context, {
      scope: scope(),
      appConfigVersion: 'version-1',
      permissions: [],
      release: {
        ...confirmedRelease(),
        version: 'V1.2.3',
      },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(scopedInstall).not.toHaveBeenCalled()
  })

  it('fails closed for missing scope, remote apps, and missing releases', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    await expect(install(context, {
      appId: '应用.App-ID',
      version: '1.2.3',
    })).rejects.toThrow('explicit Catalog install scope')

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

  it('rejects forged renderer legacy install and start in every access mode', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const legacyScope = { kind: 'legacy', appId: 'trusted-looking.app' }
    const scenarios: Array<{
      mode: 'online' | 'offline' | 'denied'
      accountId: string | null
    }> = [
      { mode: 'online', accountId: 'account-a' },
      { mode: 'offline', accountId: 'account-a' },
      { mode: 'denied', accountId: 'account-a' },
      { mode: 'online', accountId: null },
    ]

    for (const scenario of scenarios) {
      accessMode = scenario.mode
      signedInAccountId = scenario.accountId
      await expect(install(context, {
        scope: legacyScope,
        appId: legacyScope.appId,
        version: '1.0.0',
        downloadUrl: 'https://attacker.example/app.zip',
        checksum: 'a'.repeat(64),
        sizeBytes: 1,
        platform: 'darwin',
        arch: 'arm64',
      })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
      await expect(start(context, legacyScope))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }

    expect(scopedInstall).not.toHaveBeenCalled()
    expect(scopedStart).not.toHaveBeenCalled()
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

    appAccessDenied = true
    await expect(resolveRemoteUrl(context, scope()))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    appAccessDenied = false
    accessMode = 'denied'
    await expect(resolveRemoteUrl(context, scope()))
      .rejects.toThrow('no longer authorized')

    accessMode = 'online'
    catalog.authorizationStatus = 'denied'
    await expect(resolveRemoteUrl(context, scope()))
      .rejects.toThrow('no longer authorized')
  })

  it('fails every public Catalog app RPC while session-ending access is denied', async () => {
    accessMode = 'denied'
    accountAccessDenied = true
    const calls: Array<[string, ...unknown[]]> = [
      [
        RPC_CHANNELS.localApps.INSTALL,
        {
          scope: scope(),
          appConfigVersion: 'version-1',
          permissions: [],
          release: confirmedRelease(),
        },
      ],
      [RPC_CHANNELS.localApps.CANCEL_INSTALL, scope()],
      [RPC_CHANNELS.localApps.START, scope()],
      [RPC_CHANNELS.localApps.STOP, scope()],
      [RPC_CHANNELS.localApps.RESTART, scope()],
      [RPC_CHANNELS.localApps.UNINSTALL, scope(), { preserveData: true }],
      [RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE, scope(), null],
      [RPC_CHANNELS.localApps.GET_INSTALLED_APPS, scope()],
      [RPC_CHANNELS.localApps.GET_RUNTIME_STATUS, scope()],
      [RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES, { scopes: [scope()] }],
      [RPC_CHANNELS.localApps.GET_LOGS, scope(), { tail: 10 }],
    ]

    for (const [channel, ...args] of calls) {
      await expect(handlers.get(channel)!(context, ...args))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }

    catalog.apps[0] = {
      ...catalog.apps[0]!,
      deliveryMode: 'remote_url',
      remoteUrl: 'https://trusted.example.com/app',
      currentRelease: undefined,
    }
    await expect(handlers.get(
      RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
    )!(context, scope())).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    for (const runtimeCall of [
      scopedInstall,
      scopedRegistry.cancelInstall,
      scopedStart,
      scopedRegistry.stop,
      scopedRegistry.uninstall,
      scopedStatuses,
      scopedRegistry.getInstalledApps,
      scopedRegistry.getRuntimeStatus,
      scopedRegistry.setAvailableRelease,
      scopedRegistry.getLogs,
    ]) {
      expect(runtimeCall).not.toHaveBeenCalled()
    }
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

  it('keeps denied installed apps manageable while lifecycle RPCs fail closed', async () => {
    const privateRelease = {
      version: '2.0.0',
      downloadUrl: 'https://private.example.com/app.zip',
      checksum: 'b'.repeat(64),
      sizeBytes: 42,
      platform: 'darwin' as const,
      arch: 'arm64' as const,
    }
    catalog = {
      ...catalog,
      authorizationStatus: 'denied',
      apps: catalog.apps.map(app => ({
        ...app,
        availability: 'unavailable',
      })),
    }
    accessMode = 'denied'
    scopedStatuses.mockImplementation(async scopes => scopes.map(item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
      url: 'http://127.0.0.1:9876',
      port: 9876,
      pid: 1234,
      installationStatus: 'downloading',
      progress: {
        phase: 'downloading',
        bytesDownloaded: 10,
        sizeBytes: 42,
        percent: 23,
      },
      availableRelease: privateRelease,
      error: {
        code: 'START_FAILED',
        message: 'health check failed',
        details: {
          url: 'http://127.0.0.1:9876',
          pid: 1234,
          secret: 'private',
        },
      },
    })))
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
      url: 'http://127.0.0.1:9876',
      port: 9876,
      pid: 1234,
      progress: {
        phase: 'downloading',
        bytesDownloaded: 10,
        sizeBytes: 42,
        percent: 23,
      },
      availableRelease: privateRelease,
    }))
    scopedInstalledApps.mockImplementationOnce(async () => [{
      appId: scope().catalogAppId,
      scope: scope(),
      currentVersion: '1.0.0',
      versions: ['1.0.0'],
      runtime: 'static' as const,
      status: 'update_available' as const,
      installedAt: 1,
      availableRelease: privateRelease,
    }])
    scopedRegistry.stop.mockImplementationOnce(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'stopped' as const,
      currentVersion: '1.0.0',
      availableRelease: privateRelease,
    }))

    const deniedScope = scope()
    const batchStatuses = await handlers.get(
      RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES,
    )!(
      context,
      { scopes: [deniedScope] },
    ) as LocalAppRuntimeStatus[]
    expect(batchStatuses).toMatchObject([{
      appId: deniedScope.catalogAppId,
      status: 'running',
    }])
    expect(batchStatuses[0]).toEqual({
      appId: deniedScope.catalogAppId,
      scope: deniedScope,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
      error: {
        code: 'START_FAILED',
        message: 'health check failed',
      },
    })
    const runtimeStatus = await handlers.get(
      RPC_CHANNELS.localApps.GET_RUNTIME_STATUS,
    )!(
      context,
      deniedScope,
    ) as LocalAppRuntimeStatus
    expect(runtimeStatus).toEqual({
      appId: deniedScope.catalogAppId,
      scope: deniedScope,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
    })
    const installedApps = await handlers.get(
      RPC_CHANNELS.localApps.GET_INSTALLED_APPS,
    )!(context, deniedScope) as Array<Record<string, unknown>>
    expect(installedApps).toHaveLength(1)
    expect(installedApps[0]).toEqual({
      appId: deniedScope.catalogAppId,
      scope: deniedScope,
      currentVersion: '1.0.0',
      status: 'update_available',
    })
    await expect(handlers.get(RPC_CHANNELS.localApps.GET_LOGS)!(
      context,
      deniedScope,
    )).resolves.toBe('')
    expect(scopedRetainedManagementLogs).toHaveBeenCalledWith(
      deniedScope,
      undefined,
    )
    const stopped = await handlers.get(RPC_CHANNELS.localApps.STOP)!(
      context,
      deniedScope,
    ) as LocalAppRuntimeStatus
    expect(stopped).toEqual({
      appId: deniedScope.catalogAppId,
      scope: deniedScope,
      status: 'stopped',
      currentVersion: '1.0.0',
    })
    await expect(handlers.get(RPC_CHANNELS.localApps.UNINSTALL)!(
      context,
      deniedScope,
      { preserveData: true },
    )).resolves.toBeUndefined()

    for (const channel of [
      RPC_CHANNELS.localApps.START,
      RPC_CHANNELS.localApps.RESTART,
      RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
    ]) {
      await expect(handlers.get(channel)!(context, deniedScope, null))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }
    await expect(handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
      context,
      {
        scope: deniedScope,
        appConfigVersion: catalog.appConfigVersion,
        permissions: [],
        release: confirmedRelease(),
      },
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    expect(scopedRegistry.stop).toHaveBeenCalledWith(deniedScope)
    expect(scopedRetainedManagementLogs).toHaveBeenCalledWith(
      deniedScope,
      undefined,
    )
    expect(scopedRegistry.getLogs).not.toHaveBeenCalled()
    expect(scopedRegistry.uninstall).toHaveBeenCalledWith(
      deniedScope,
      { preserveData: true },
    )
    expect(scopedStart).not.toHaveBeenCalled()
    expect(scopedInstall).not.toHaveBeenCalled()
  })

  it('redacts a running batch status after the App withdrawal fence precedes cache commit', async () => {
    const privateRelease = {
      version: '2.0.0',
      downloadUrl: 'https://private.example.com/app.zip',
      checksum: 'b'.repeat(64),
      sizeBytes: 42,
    }
    const statusStarted = createDeferred<void>()
    const releaseStatus = createDeferred<LocalAppRuntimeStatus[]>()
    scopedStatuses.mockImplementationOnce(async () => {
      statusStarted.resolve()
      return releaseStatus.promise
    })
    const batch = handlers.get(
      RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES,
    )!(
      context,
      { scopes: [scope()] },
    ) as Promise<LocalAppRuntimeStatus[]>

    await statusStarted.promise
    appAccessDenied = true
    releaseStatus.resolve([{
      appId: scope().catalogAppId,
      scope: scope(),
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
      url: 'http://127.0.0.1:9876',
      port: 9876,
      pid: 1234,
      installationStatus: 'installing',
      progress: {
        phase: 'preparing',
        bytesDownloaded: 42,
        sizeBytes: 42,
        percent: 100,
      },
      availableRelease: privateRelease,
      error: {
        code: 'START_FAILED',
        message: 'failure',
        details: { secret: 'private' },
      },
    }])

    const [status] = await batch
    expect(catalog.authorizationStatus).toBe('authorized')
    expect(catalog.apps[0]?.availability).toBe('available')
    expect(status).toEqual({
      appId: scope().catalogAppId,
      scope: scope(),
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
      error: {
        code: 'START_FAILED',
        message: 'failure',
      },
    })
  })

  it('allows bounded logs for retained denied and withdrawn installations', async () => {
    const getLogs = handlers.get(RPC_CHANNELS.localApps.GET_LOGS)!
    for (const runtimeStatus of ['installed', 'running', 'stopped'] as const) {
      scopedRuntimeStatus.mockResolvedValueOnce({
        appId: scope().catalogAppId,
        scope: scope(),
        status: runtimeStatus,
        currentVersion: '1.0.0',
      })
      await expect(getLogs(context, scope(), { tail: 20 }))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }

    catalog = {
      ...catalog,
      authorizationStatus: 'denied',
      apps: catalog.apps.map(app => ({
        ...app,
        availability: 'unavailable',
      })),
    }
    accessMode = 'denied'
    for (
      const runtimeStatus of [
        'installed',
        'running',
        'stopped',
        'broken',
        'update_available',
      ] as const
    ) {
      scopedRuntimeStatus.mockResolvedValueOnce({
        appId: scope().catalogAppId,
        scope: scope(),
        status: runtimeStatus,
        currentVersion: '1.0.0',
      })
      await expect(getLogs(context, scope(), { tail: 20 })).resolves.toBe('')
    }

    const withdrawnApp = {
      ...catalog.apps[0]!,
      availability: 'withdrawn' as const,
    }
    catalog = {
      ...catalog,
      authorizationStatus: 'authorized',
      apps: [],
      withdrawnApps: [withdrawnApp],
    }
    accessMode = 'online'
    for (
      const runtimeStatus of [
        'installed',
        'running',
        'stopped',
        'broken',
        'update_available',
      ] as const
    ) {
      scopedRuntimeStatus.mockResolvedValueOnce({
        appId: scope().catalogAppId,
        scope: scope(),
        status: runtimeStatus,
        currentVersion: '1.0.0',
      })
      await expect(getLogs(context, scope(), { tail: 20 })).resolves.toBe('')
    }

    scopedRuntimeStatus.mockResolvedValueOnce({
      appId: scope().catalogAppId,
      scope: scope(),
      status: 'not_installed',
    })
    await expect(getLogs(context, scope(), { tail: 20 }))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    catalog = createCatalog(1)
    scopedRuntimeStatus.mockResolvedValueOnce({
      appId: scope().catalogAppId,
      scope: scope(),
      status: 'broken',
      currentVersion: '1.0.0',
      error: {
        code: 'START_FAILED',
        message: 'health check failed',
      },
    })
    await expect(getLogs(context, scope(), { tail: 20 })).resolves.toBe('')
    expect(scopedFailureRecoveryLogs).toHaveBeenCalledTimes(4)
    expect(scopedFailureRecoveryLogs).toHaveBeenLastCalledWith(
      scope(),
      { tail: 20 },
    )
    expect(scopedRetainedManagementLogs).toHaveBeenCalledTimes(11)
    expect(scopedRetainedManagementLogs).toHaveBeenLastCalledWith(
      scope(),
      { tail: 20 },
    )
    expect(scopedRegistry.getLogs).not.toHaveBeenCalled()
  })

  it('rejects a retained log result when the App is re-authorized before commit', async () => {
    const logsEntered = createDeferred<void>()
    const pendingTail = createDeferred<string>()
    scopedRetainedManagementLogs.mockImplementationOnce(async () => {
      logsEntered.resolve()
      return pendingTail.promise
    })
    const withdrawnApp = {
      ...catalog.apps[0]!,
      availability: 'withdrawn' as const,
    }
    catalog = {
      ...catalog,
      apps: [],
      withdrawnApps: [withdrawnApp],
    }

    const pendingLogs = handlers.get(RPC_CHANNELS.localApps.GET_LOGS)!(
      context,
      scope(),
      { tail: 20 },
    )
    await logsEntered.promise

    catalog = createCatalog(1)
    accessMode = 'online'
    appAccessDenied = false
    pendingTail.resolve('stale retained logs')

    await expect(pendingLogs).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
  })

  it('retains a full-directory tombstone with status access but rejects launch', async () => {
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

  it('isolates prototype-named business IDs with invalid versions in batch wiring', async () => {
    const getStatuses = handlers.get(RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES)!
    const prototypeNamedIds = ['constructor', 'toString', '__proto__']
    const healthyId = 'healthy-app'
    const ids = [...prototypeNamedIds, healthyId]
    catalog = createCatalog(ids.length)
    catalog.apps = catalog.apps.map((app, index) => ({
      ...app,
      id: ids[index]!,
      currentRelease: {
        ...app.currentRelease!,
        version: index < prototypeNamedIds.length ? '1.2.3.4' : '1.2.3',
      },
    }))
    catalog.trustedReleases = {}
    scopedStatuses.mockImplementation(async scopes => scopes.map((item, index) => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'installed',
      currentVersion: index < prototypeNamedIds.length
        ? `invalid-installed-${index}`
        : '1.2.3',
    })))
    const scopes = ids.map(scope)

    const result = await getStatuses(
      context,
      { scopes },
    ) as LocalAppRuntimeStatus[]

    expect(result).toHaveLength(ids.length)
    for (const [index, id] of prototypeNamedIds.entries()) {
      expect(result[index]).toEqual(expect.objectContaining({
        appId: id,
        currentVersion: `invalid-installed-${index}`,
        versionError: 'invalid_semver',
      }))
    }
    expect(result[prototypeNamedIds.length]).toEqual(expect.objectContaining({
      appId: healthyId,
      status: 'installed',
      currentVersion: '1.2.3',
    }))
    expect(result[prototypeNamedIds.length]).not.toHaveProperty('versionError')
  })
})
