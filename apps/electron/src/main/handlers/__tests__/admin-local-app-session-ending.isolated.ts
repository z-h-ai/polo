import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerDeps } from '@polo-ai/server-core/handlers'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { AppCatalogCacheEntry } from '@polo-ai/shared/admin'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type {
  CatalogLocalAppScope,
  LocalAppCatalogInstallRequest,
  LocalAppInstalledApp,
  LocalAppRuntimeStatus,
  LocalAppStartResult,
} from '@polo-ai/shared/protocol'
import {
  createCatalogRuntimeAppId,
  MAX_CATALOG_STATUS_SCOPES,
  ScopedLocalAppRuntimeRegistry,
  validateCatalogLocalAppScope,
} from '../../local-app-runtime/scoped-registry'
import {
  LocalAppRuntimeManager,
  type LocalAppRuntimeManagerOptions,
} from '../../local-app-runtime/manager'
import { LocalAppRuntimeError } from '../../local-app-runtime/runtime-error'

type StoredTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  userId: string
  username: string
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const scope: CatalogLocalAppScope = {
  kind: 'catalog',
  accountId: 'account\0a',
  organizationId: '16666666-6666-4666-8666-666666666661',
  catalogAppId: 'catalog-app',
}
let tokens: StoredTokens | null = null
let accessMode: 'online' | 'offline' | 'denied' | null = 'online'
const deniedAccounts = new Set<string>()
let runtimeRegistry: ScopedLocalAppRuntimeRegistry | null = null
let remoteLogout: (accessToken: string) => Promise<void> = async () => {}
let refreshAdmin: (refreshToken: string) => Promise<{
  accessToken: string
  refreshToken: string
  expiresIn: number
}> = async () => ({
  accessToken: 'refreshed-access',
  refreshToken: 'refreshed-refresh',
  expiresIn: 3_600,
})
let validateAdmin: (accessToken: string) => Promise<unknown> = async () => ({
  valid: true,
  user: {
    id: scope.accountId,
    username: 'account-a',
    displayName: null,
    role: 'member',
    groupIds: [],
  },
  configVersion: 'catalog-v1',
})
let getAppCatalogAdmin: (
  accessToken: string,
  organizationId: string,
  appConfigVersion?: string,
) => Promise<unknown> = defaultGetAppCatalogAdmin
let listOrganizationsAdmin: (accessToken: string) => Promise<unknown> =
  async () => ({ organizations: [] })
let tokensExpired = false
let denyCatalogCacheError: Error | null = null
let saveCatalogError: Error | null = null
let catalog = createCatalog()
const temporaryRoots: string[] = []

function createCatalog(): AppCatalogCacheEntry {
  return {
    accountId: scope.accountId,
    organizationId: scope.organizationId,
    authorizationStatus: 'authorized' as const,
    appConfigVersion: 'catalog-v1',
    syncedAt: 1,
    apps: [{
      id: scope.catalogAppId,
      organizationId: scope.organizationId,
      name: 'Catalog App',
      description: '',
      deliveryMode: 'local_bundle' as const,
      availability: 'available' as const,
      sortOrder: 0,
      currentRelease: {
        version: '1.0.0',
        runtime: 'static' as const,
        downloadUrl: 'https://catalog.example/app.zip',
        checksum: 'a'.repeat(64),
        sizeBytes: 1,
      },
    }],
  }
}

async function defaultGetAppCatalogAdmin(
  _accessToken: string,
  _organizationId: string,
  appConfigVersion?: string,
): Promise<unknown> {
  return appConfigVersion === undefined
    ? {
        notModified: false,
        appConfigVersion: catalog.appConfigVersion,
        apps: catalog.apps,
      }
    : { notModified: true }
}

class TestAdminError extends Error {
  readonly errorCode: string
  readonly status?: number

  constructor(message: string, errorCode: string, options?: { status?: number }) {
    super(message)
    this.errorCode = errorCode
    this.status = options?.status
  }
}

class TestAdminClient {
  constructor(_adminUrl: string) {}

  refresh(refreshToken: string): Promise<unknown> {
    return refreshAdmin(refreshToken)
  }

  validate(accessToken: string): Promise<unknown> {
    return validateAdmin(accessToken)
  }

  logout(accessToken: string): Promise<void> {
    return remoteLogout(accessToken)
  }

  getAppCatalog(
    accessToken: string,
    organizationId: string,
    appConfigVersion?: string,
  ): Promise<unknown> {
    return getAppCatalogAdmin(accessToken, organizationId, appConfigVersion)
  }

  listOrganizations(accessToken: string): Promise<unknown> {
    return listOrganizationsAdmin(accessToken)
  }
}

const credentialManager = {
  async getAdminTokens(): Promise<StoredTokens | null> {
    return tokens
  },
  async setAdminTokens(next: StoredTokens): Promise<void> {
    tokens = { ...next }
  },
  async deleteAdminTokens(): Promise<boolean> {
    const existed = tokens !== null
    tokens = null
    return existed
  },
  async deleteLlmCredentials(): Promise<void> {},
  isExpired(): boolean {
    return tokensExpired
  },
  async list(): Promise<string[]> {
    return []
  },
  async delete(): Promise<boolean> {
    return false
  },
}

mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => credentialManager,
}))

mock.module('@polo-ai/shared/config', () => ({
  getAdminUrl: () => 'https://admin.example.com',
  getAdminConfigVersion: () => undefined,
  setAdminConfigVersion: () => {},
  getLlmConnections: () => [],
  addLlmConnection: () => true,
  updateLlmConnection: () => true,
  deleteLlmConnection: () => true,
  setDefaultLlmConnection: () => true,
}))

mock.module('@polo-ai/shared/admin', () => ({
  AdminClient: TestAdminClient,
  AdminError: TestAdminError,
  getSafeAdminErrorMessage: () => 'Admin request failed',
  getAppCatalogApps: (entry: AppCatalogCacheEntry) => [
    ...entry.apps,
    ...(entry.withdrawnApps ?? []),
  ],
  getCachedAppCatalog: (
    accountId: string,
    organizationId: string,
  ) => accountId === catalog.accountId && organizationId === catalog.organizationId
    ? catalog
    : null,
  listCachedAppCatalogs: (accountId: string) =>
    accountId === catalog.accountId ? [catalog] : [],
  saveAppCatalog: (
    accountId: string,
    organizationId: string,
    response: {
      appConfigVersion: string
      apps: AppCatalogCacheEntry['apps']
    },
    _syncedAt?: number,
    retainedWithdrawnAppIds: ReadonlySet<string> = new Set(),
  ) => {
    if (saveCatalogError) throw saveCatalogError
    const visibleIds = new Set(response.apps.map(app => app.id))
    const withdrawnById = new Map([
      ...(catalog.withdrawnApps ?? []).filter(app => !visibleIds.has(app.id)),
      ...catalog.apps
        .filter(app => !visibleIds.has(app.id))
        .map(app => ({ ...app, availability: 'withdrawn' as const })),
    ].map(app => [app.id, app]))
    const withdrawnCandidates = [...withdrawnById.values()]
    const retained = withdrawnCandidates.filter(app =>
      retainedWithdrawnAppIds.has(app.id))
    const retainedIds = new Set(retained.map(app => app.id))
    const withdrawnApps = [
      ...retained,
      ...withdrawnCandidates.filter(app => !retainedIds.has(app.id)),
    ].slice(0, 10_000)
    catalog = {
      ...catalog,
      accountId,
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: response.appConfigVersion,
      syncedAt: Date.now(),
      apps: response.apps.map(app => ({
        ...app,
        availability: 'available' as const,
      })),
      withdrawnApps,
    }
    return catalog
  },
  getAppCatalogAccessMode: (accountId: string) =>
    deniedAccounts.has(accountId) ? 'denied' : accessMode ?? 'offline',
  isAppCatalogAccessDeniedForAccount: (accountId: string) =>
    deniedAccounts.has(accountId),
  setAppCatalogAccessMode: (
    _accountId: string,
    _organizationId: string,
    mode: typeof accessMode,
  ) => {
    accessMode = mode
  },
  denyAppCatalogAccessForAccount: (accountId: string) => {
    deniedAccounts.add(accountId)
    if (accountId === scope.accountId && accessMode !== null) {
      accessMode = 'denied'
    }
  },
  resumeAppCatalogAccessForAccount: (accountId: string) => {
    deniedAccounts.delete(accountId)
  },
  denyCachedAppCatalogAuthorization: () => {
    if (denyCatalogCacheError) throw denyCatalogCacheError
    catalog = {
      ...catalog,
      authorizationStatus: 'denied',
      apps: catalog.apps.map(app => ({
        ...app,
        availability: 'unavailable' as const,
      })),
    }
    return catalog
  },
  denyCachedAppCatalogAuthorizationForAccount: (accountId: string) => {
    if (accountId !== scope.accountId) return []
    if (denyCatalogCacheError) throw denyCatalogCacheError
    catalog = {
      ...catalog,
      authorizationStatus: 'denied',
      apps: catalog.apps.map(app => ({
        ...app,
        availability: 'unavailable' as const,
      })),
    }
    return [catalog]
  },
}))

mock.module('../../local-app-runtime', () => ({
  getScopedLocalAppRuntimeRegistry: () => {
    if (!runtimeRegistry) throw new Error('Scoped runtime registry is not ready')
    return runtimeRegistry
  },
  LocalAppRuntimeError,
  MAX_CATALOG_STATUS_SCOPES,
  validateCatalogLocalAppScope,
}))

const { registerAdminHandlers } = await import(
  '@polo-ai/server-core/handlers/rpc/admin'
)
const { registerLocalAppHandlers } = await import('../local-apps')

function createSignedInTokens(): StoredTokens {
  return {
    accessToken: 'account-a-access',
    refreshToken: 'account-a-refresh',
    expiresAt: Date.now() + 60_000,
    userId: scope.accountId,
    username: 'account-a',
  }
}

function installRequest(): LocalAppCatalogInstallRequest {
  const release = catalog.apps[0]!.currentRelease!
  return {
    scope,
    appConfigVersion: catalog.appConfigVersion,
    permissions: [],
    release: {
      version: release.version,
      checksum: release.checksum,
      sizeBytes: release.sizeBytes,
      platform: release.platform ?? null,
      arch: release.arch ?? null,
    },
  }
}

function registerProductionHandlers(
  root: string,
  options: {
    onAdminSessionEnding?: (accountId: string) => Promise<void>
    onAdminCatalogScopeDenied?: (
      accountId: string,
      organizationId: string,
    ) => Promise<void>
    onAdminCatalogAppsWithdrawn?: (
      accountId: string,
      organizationId: string,
      catalogAppIds: readonly string[],
    ) => Promise<void>
    onAdminCatalogAppsAuthorized?: (
      accountId: string,
      organizationId: string,
      catalogAppIds: readonly string[],
    ) => void
    getRetainedCatalogAppIds?: (
      accountId: string,
      organizationId: string,
    ) => Promise<ReadonlySet<string>>
  } = {},
) {
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle(channel, handler) {
      handlers.set(channel, handler)
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
  const deps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: root,
      resourcesPath: root,
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      imageProcessor: {
        async getMetadata() {
          return null
        },
        async process() {
          return Buffer.from('')
        },
      },
    },
    onAdminSessionEnding: options.onAdminSessionEnding
      ?? ((accountId: string) => runtimeRegistry!.stopAccount(accountId)),
    onAdminCatalogScopeDenied: options.onAdminCatalogScopeDenied
      ?? ((accountId: string, organizationId: string) =>
        runtimeRegistry!.stopOrganization(accountId, organizationId)),
    onAdminCatalogAppsWithdrawn: options.onAdminCatalogAppsWithdrawn
      ?? ((
        accountId: string,
        organizationId: string,
        catalogAppIds: readonly string[],
      ) => runtimeRegistry!.stopApps(catalogAppIds.map(catalogAppId => ({
        kind: 'catalog',
        accountId,
        organizationId,
        catalogAppId,
      })))),
    onAdminCatalogAppsAuthorized: options.onAdminCatalogAppsAuthorized
      ?? ((
        accountId: string,
        organizationId: string,
        catalogAppIds: readonly string[],
      ) => runtimeRegistry!.authorizeApps(catalogAppIds.map(catalogAppId => ({
        kind: 'catalog',
        accountId,
        organizationId,
        catalogAppId,
      })))),
    getRetainedCatalogAppIds: options.getRetainedCatalogAppIds
      ?? ((accountId: string, organizationId: string) =>
        runtimeRegistry!.getRetainedCatalogAppIds(
          accountId,
          organizationId,
        )),
    onAdminSessionStarted: (accountId: string) =>
      runtimeRegistry!.resumeAccount(accountId),
  } satisfies HandlerDeps
  registerAdminHandlers(server, deps)
  registerLocalAppHandlers(server)
  return {
    handlers,
    context: {
      clientId: 'renderer',
      workspaceId: null,
      webContentsId: null,
      signal: new AbortController().signal,
    },
  }
}

async function createAuthorizationHarness() {
  const root = await mkdtemp(join(tmpdir(), 'polo-admin-authorization-'))
  temporaryRoots.push(root)
  let managerFactoryCalls = 0
  runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
    rootDir: root,
    managerFactory: () => {
      managerFactoryCalls += 1
      throw new Error('authorization test must not create a runtime manager')
    },
  })
  tokens = createSignedInTokens()
  accessMode = 'denied'
  return {
    ...registerProductionHandlers(root),
    managerFactoryCalls: () => managerFactoryCalls,
  }
}

afterEach(async () => {
  runtimeRegistry = null
  tokens = null
  accessMode = 'online'
  deniedAccounts.clear()
  remoteLogout = async () => {}
  refreshAdmin = async () => ({
    accessToken: 'refreshed-access',
    refreshToken: 'refreshed-refresh',
    expiresIn: 3_600,
  })
  validateAdmin = async () => ({
    valid: true,
    user: {
      id: scope.accountId,
      username: 'account-a',
      displayName: null,
      role: 'member',
      groupIds: [],
    },
    configVersion: 'catalog-v1',
  })
  getAppCatalogAdmin = defaultGetAppCatalogAdmin
  listOrganizationsAdmin = async () => ({ organizations: [] })
  tokensExpired = false
  denyCatalogCacheError = null
  saveCatalogError = null
  catalog = createCatalog()
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })))
})

describe('Admin session and scoped local app production wiring', () => {
  it('accepts full organization entity ids through Catalog sync and batch status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-catalog-entity-id-'))
    temporaryRoots.push(root)
    let managerFactoryCalls = 0
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: () => {
        managerFactoryCalls += 1
        throw new Error('status reads must not materialize a runtime manager')
      },
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    const { handlers, context } = registerProductionHandlers(root)
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!
    const getStatuses = handlers.get(
      RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES,
    )!

    for (const organizationId of [
      'tenant:creator-space',
      '组织：研发圈',
      'organization\0creator',
      `org:${'x'.repeat(508)}`,
    ]) {
      const entityScope = { ...scope, organizationId }
      catalog = {
        ...createCatalog(),
        organizationId,
        apps: createCatalog().apps.map(app => ({ ...app, organizationId })),
      }
      getAppCatalogAdmin = async (
        _accessToken,
        requestedOrganizationId,
        requestedVersion,
      ) => {
        expect(requestedOrganizationId).toBe(organizationId)
        expect(requestedVersion).toBeUndefined()
        return {
          notModified: false,
          appConfigVersion: catalog.appConfigVersion,
          apps: catalog.apps,
        }
      }

      await expect(sync(context, organizationId, { force: true }))
        .resolves.toMatchObject({
          success: true,
          catalog: { organizationId },
        })
      await expect(getStatuses(context, { scopes: [entityScope] }))
        .resolves.toEqual([expect.objectContaining({
          appId: scope.catalogAppId,
          scope: entityScope,
          status: 'not_installed',
        })])
    }
    expect(managerFactoryCalls).toBe(0)
  })

  it('denies cold cached scopes while session cleanup and denied-cache persistence are pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-admin-cold-cache-ending-'))
    temporaryRoots.push(root)
    let managerFactoryCalls = 0
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: () => {
        managerFactoryCalls += 1
        throw new Error('account gate must reject before runtime access')
      },
    })
    tokens = createSignedInTokens()
    accessMode = null
    denyCatalogCacheError = new Error('disk full')
    catalog = {
      ...createCatalog(),
      apps: [
        ...createCatalog().apps,
        {
          id: 'remote-app',
          organizationId: scope.organizationId,
          name: 'Remote App',
          description: '',
          deliveryMode: 'remote_url' as const,
          remoteUrl: 'https://catalog.example/remote',
          availability: 'available' as const,
          sortOrder: 1,
        },
      ],
    }
    const cleanupStarted = createDeferred<void>()
    const finishCleanup = createDeferred<void>()
    const { handlers, context } = registerProductionHandlers(root, {
      onAdminSessionEnding: async () => {
        cleanupStarted.resolve()
        await finishCleanup.promise
      },
    })
    const logout = handlers.get(RPC_CHANNELS.admin.LOGOUT)!
    const resolveRemote = handlers.get(
      RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
    )!
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const remoteScope: CatalogLocalAppScope = {
      ...scope,
      catalogAppId: 'remote-app',
    }

    const pendingLogout = logout(context)
    await cleanupStarted.promise

    expect(catalog.authorizationStatus).toBe('authorized')
    await expect(resolveRemote(context, remoteScope)).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    await expect(start(context, scope)).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    expect(managerFactoryCalls).toBe(0)

    finishCleanup.resolve()
    await expect(pendingLogout).resolves.toEqual({ success: true })
  })

  it('fences an entered start before slow remote logout and stops its process', async () => {
    const startEntered = createDeferred<void>()
    const finishStart = createDeferred<LocalAppStartResult>()
    const processStopped = createDeferred<void>()
    const calls: string[] = []

    class DeferredStartManager extends LocalAppRuntimeManager {
      constructor(options: LocalAppRuntimeManagerOptions) {
        super(options)
      }

      override start(appId: string): Promise<LocalAppStartResult> {
        calls.push('start')
        startEntered.resolve()
        return finishStart.promise
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        processStopped.resolve()
        return { appId, status: 'stopped' }
      }
    }

    const root = await mkdtemp(join(tmpdir(), 'polo-admin-ending-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new DeferredStartManager(options),
    })
    tokens = createSignedInTokens()
    const remoteLogoutStarted = createDeferred<void>()
    const finishRemoteLogout = createDeferred<void>()
    let remoteLogoutCompleted = false
    remoteLogout = async () => {
      remoteLogoutStarted.resolve()
      await finishRemoteLogout.promise
      remoteLogoutCompleted = true
    }

    const { handlers, context } = registerProductionHandlers(root)
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const logout = handlers.get(RPC_CHANNELS.admin.LOGOUT)!

    const pendingStart = start(context, scope)
    await startEntered.promise
    const pendingLogout = logout(context)
    await remoteLogoutStarted.promise

    finishStart.resolve({
      appId: createCatalogRuntimeAppId(scope),
      version: '1.0.0',
      url: 'http://127.0.0.1:4567',
      port: 4567,
    })
    await expect(pendingStart).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    await processStopped.promise
    expect(calls).toEqual(['start', 'stop'])
    expect(remoteLogoutCompleted).toBe(false)
    expect(tokens).toMatchObject({ userId: scope.accountId })

    finishRemoteLogout.resolve()
    await expect(pendingLogout).resolves.toEqual({ success: true })
    expect(tokens).toBeNull()
  })

  it('downgrades online Catalog access when token refresh is offline', async () => {
    const {
      handlers,
      context,
      managerFactoryCalls,
    } = await createAuthorizationHarness()
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!
    const validate = handlers.get(RPC_CHANNELS.admin.VALIDATE)!
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!

    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: true, accessMode: 'online' })
    expect(accessMode).toBe('online')

    tokensExpired = true
    refreshAdmin = async () => {
      throw new TestAdminError('network unavailable', 'NETWORK_ERROR')
    }
    await expect(validate(context)).resolves.toMatchObject({
      loggedIn: true,
      offline: true,
    })
    expect(accessMode).toBe('offline')
    await expect(install(context, installRequest())).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    expect(managerFactoryCalls()).toBe(0)
  })

  it('keeps a persisted denied Catalog closed when cold token refresh is offline', async () => {
    const {
      handlers,
      context,
      managerFactoryCalls,
    } = await createAuthorizationHarness()
    catalog = {
      ...catalog,
      authorizationStatus: 'denied',
      apps: catalog.apps.map(app => ({
        ...app,
        availability: 'available',
      })),
    }
    accessMode = 'denied'
    tokensExpired = true
    refreshAdmin = async () => {
      throw new TestAdminError('network unavailable', 'NETWORK_ERROR')
    }

    const result = await handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!(
      context,
      scope.organizationId,
      { force: true },
    )
    expect(result).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [{
          id: scope.catalogAppId,
          availability: 'unavailable',
        }],
      },
    })
    expect(result.catalog).not.toHaveProperty('trustedReleases')
    expect(result.catalog.apps[0]).not.toHaveProperty('currentRelease')
    expect(result.catalog.apps[0]).not.toHaveProperty('permissions')
    expect(accessMode).toBe('denied')
    expect(tokens).toMatchObject({ userId: scope.accountId })
    await expect(handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
      context,
      installRequest(),
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(handlers.get(RPC_CHANNELS.localApps.START)!(context, scope))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(managerFactoryCalls()).toBe(0)
  })

  it('downgrades online Catalog access when validation is offline', async () => {
    const {
      handlers,
      context,
      managerFactoryCalls,
    } = await createAuthorizationHarness()
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!
    const validate = handlers.get(RPC_CHANNELS.admin.VALIDATE)!
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!

    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: true, accessMode: 'online' })
    validateAdmin = async () => {
      throw new TestAdminError('network unavailable', 'NETWORK_ERROR')
    }
    await expect(validate(context)).resolves.toMatchObject({
      loggedIn: true,
      offline: true,
    })

    expect(accessMode).toBe('offline')
    await expect(install(context, installRequest())).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    expect(managerFactoryCalls()).toBe(0)
  })

  it('preserves account session and local data management after Catalog organization 403', async () => {
    const managerCalls: string[] = []
    class DeniedCatalogDataManager extends LocalAppRuntimeManager {
      override async getRuntimeStatus(appId: string): Promise<LocalAppRuntimeStatus> {
        managerCalls.push('status')
        return {
          appId,
          status: 'installed',
          currentVersion: '1.0.0',
        }
      }

      override async getLogs(): Promise<string> {
        managerCalls.push('logs')
        return 'retained organization logs'
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        managerCalls.push('stop')
        return {
          appId,
          status: 'stopped',
          currentVersion: '1.0.0',
        }
      }

      override async uninstall(): Promise<void> {
        managerCalls.push('uninstall')
      }

      override async start(appId: string): Promise<LocalAppStartResult> {
        managerCalls.push('start')
        return {
          appId,
          version: '1.0.0',
          url: 'http://127.0.0.1:4680',
          port: 4680,
        }
      }
    }

    const root = await mkdtemp(join(tmpdir(), 'polo-catalog-org-denied-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new DeniedCatalogDataManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    const { handlers, context } = registerProductionHandlers(root)
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!

    await expect(runtimeRegistry.getLogs(scope))
      .resolves.toBe('retained organization logs')
    getAppCatalogAdmin = async () => {
      throw new TestAdminError('membership removed', 'FORBIDDEN', {
        status: 403,
      })
    }
    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({
        success: false,
        errorCode: 'FORBIDDEN',
        status: 403,
      })

    expect(tokens).toMatchObject({ userId: scope.accountId })
    expect(deniedAccounts.has(scope.accountId)).toBe(false)
    expect(accessMode as 'online' | 'offline' | 'denied' | null).toBe('denied')
    expect(catalog).toMatchObject({
      authorizationStatus: 'denied',
      apps: [{
        id: scope.catalogAppId,
        availability: 'unavailable',
      }],
    })

    await expect(handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
      context,
      installRequest(),
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    for (const channel of [
      RPC_CHANNELS.localApps.START,
      RPC_CHANNELS.localApps.RESTART,
    ]) {
      await expect(handlers.get(channel)!(context, scope))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }
    await expect(handlers.get(RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE)!(
      context,
      scope,
      null,
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(managerCalls).not.toContain('start')

    await expect(handlers.get(RPC_CHANNELS.localApps.GET_RUNTIME_STATUS)!(
      context,
      scope,
    )).resolves.toMatchObject({
      status: 'installed',
      currentVersion: '1.0.0',
    })
    await expect(handlers.get(RPC_CHANNELS.localApps.GET_LOGS)!(
      context,
      scope,
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(handlers.get(RPC_CHANNELS.localApps.STOP)!(
      context,
      scope,
    )).resolves.toMatchObject({ status: 'stopped' })
    await expect(handlers.get(RPC_CHANNELS.localApps.UNINSTALL)!(
      context,
      scope,
      { preserveData: true },
    )).resolves.toBeUndefined()
    expect(managerCalls).toContain('status')
    expect(managerCalls).toContain('logs')
    expect(managerCalls).toContain('stop')
    expect(managerCalls).toContain('uninstall')
  })

  it('retains local data management when organization listing removes the current organization', async () => {
    const managerCalls: string[] = []
    class RemovedOrganizationDataManager extends LocalAppRuntimeManager {
      override async getRuntimeStatus(appId: string): Promise<LocalAppRuntimeStatus> {
        managerCalls.push('status')
        return {
          appId,
          status: 'running',
          currentVersion: '1.0.0',
          runningVersion: '1.0.0',
        }
      }

      override async getLogs(): Promise<string> {
        managerCalls.push('logs')
        return 'removed organization logs'
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        managerCalls.push('stop')
        return {
          appId,
          status: 'stopped',
          currentVersion: '1.0.0',
        }
      }

      override async uninstall(): Promise<void> {
        managerCalls.push('uninstall')
      }

      override async start(appId: string): Promise<LocalAppStartResult> {
        managerCalls.push('start')
        return {
          appId,
          version: '1.0.0',
          url: 'http://127.0.0.1:4681',
          port: 4681,
        }
      }
    }

    const root = await mkdtemp(join(tmpdir(), 'polo-organization-list-removed-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new RemovedOrganizationDataManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    listOrganizationsAdmin = async () => ({ organizations: [] })
    const { handlers, context } = registerProductionHandlers(root)

    // Materialize the retained installation before the authorization truth
    // changes, matching a previously installed local app.
    await expect(runtimeRegistry.getLogs(scope))
      .resolves.toBe('removed organization logs')
    await expect(handlers.get(RPC_CHANNELS.admin.LIST_ORGANIZATIONS)!(context))
      .resolves.toMatchObject({
        success: true,
        organizations: [],
      })

    expect(tokens).toMatchObject({ userId: scope.accountId })
    expect(deniedAccounts.has(scope.accountId)).toBe(false)
    expect(accessMode as 'online' | 'offline' | 'denied' | null).toBe('denied')
    expect(catalog).toMatchObject({
      authorizationStatus: 'denied',
      apps: [{
        id: scope.catalogAppId,
        availability: 'unavailable',
      }],
    })

    await expect(handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
      context,
      installRequest(),
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    for (const channel of [
      RPC_CHANNELS.localApps.START,
      RPC_CHANNELS.localApps.RESTART,
    ]) {
      await expect(handlers.get(channel)!(context, scope))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }
    await expect(handlers.get(RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE)!(
      context,
      scope,
      null,
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(managerCalls).not.toContain('start')

    await expect(handlers.get(RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES)!(
      context,
      { scopes: [scope] },
    )).resolves.toEqual([
      expect.objectContaining({
        appId: scope.catalogAppId,
        status: 'running',
      }),
    ])
    await expect(handlers.get(RPC_CHANNELS.localApps.GET_LOGS)!(
      context,
      scope,
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(handlers.get(RPC_CHANNELS.localApps.STOP)!(
      context,
      scope,
    )).resolves.toMatchObject({ status: 'stopped' })
    await expect(handlers.get(RPC_CHANNELS.localApps.UNINSTALL)!(
      context,
      scope,
      { preserveData: true },
    )).resolves.toBeUndefined()
    expect(managerCalls).toContain('status')
    expect(managerCalls).toContain('logs')
    expect(managerCalls).toContain('stop')
    expect(managerCalls).toContain('uninstall')
  })

  it('denies lifecycle access when NOT_FOUND cache persistence fails', async () => {
    const {
      handlers,
      context,
      managerFactoryCalls,
    } = await createAuthorizationHarness()
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!

    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: true, accessMode: 'online' })
    denyCatalogCacheError = new Error('disk full')
    getAppCatalogAdmin = async () => {
      throw new TestAdminError('organization unavailable', 'NOT_FOUND', {
        status: 404,
      })
    }
    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: false, errorCode: 'NOT_FOUND' })

    expect(catalog.authorizationStatus).toBe('authorized')
    expect(accessMode).toBe('denied')
    await expect(install(context, installRequest())).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    expect(managerFactoryCalls()).toBe(0)
  })

  it('keeps a failed persisted denial closed when the next Catalog response is 304', async () => {
    catalog = {
      ...createCatalog(),
      apps: [
        ...createCatalog().apps,
        {
          id: 'remote-app',
          organizationId: scope.organizationId,
          name: 'Private Remote App',
          description: '',
          deliveryMode: 'remote_url' as const,
          remoteUrl: 'https://private.example.com/app',
          availability: 'available' as const,
          sortOrder: 1,
        },
      ],
    }
    const { handlers, context } = await createAuthorizationHarness()
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!

    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: true, accessMode: 'online' })
    denyCatalogCacheError = new Error('disk full')
    getAppCatalogAdmin = async () => {
      throw new TestAdminError('organization unavailable', 'NOT_FOUND', {
        status: 404,
      })
    }
    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: false, errorCode: 'NOT_FOUND' })
    expect(catalog.authorizationStatus).toBe('authorized')
    expect(accessMode).toBe('denied')

    const requestedVersions: Array<string | undefined> = []
    getAppCatalogAdmin = async (
      _accessToken,
      _organizationId,
      appConfigVersion,
    ) => {
      requestedVersions.push(appConfigVersion)
      return { notModified: true }
    }
    const retry = await sync(context, scope.organizationId, {})

    expect(requestedVersions).toEqual([undefined])
    expect(retry).toMatchObject({
      success: false,
      errorCode: 'SERVER_ERROR',
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [
          { id: scope.catalogAppId, availability: 'unavailable' },
          { id: 'remote-app', availability: 'unavailable' },
        ],
      },
    })
    expect(retry.catalog.apps[0]).not.toHaveProperty('currentRelease')
    expect(retry.catalog.apps[1]).not.toHaveProperty('remoteUrl')
    expect(retry.catalog).not.toHaveProperty('trustedReleases')
    expect(accessMode).toBe('denied')
    expect(catalog.authorizationStatus).toBe('authorized')
    expect(catalog.apps[0]).toHaveProperty('currentRelease')
    expect(catalog.apps[1]).toHaveProperty('remoteUrl')
  })

  it('keeps every delivery capability closed after denied persistence and transport failures', async () => {
    for (const errorCode of ['NETWORK_ERROR', 'TIMEOUT']) {
      catalog = {
        ...createCatalog(),
        apps: [
          ...createCatalog().apps,
          {
            id: 'remote-app',
            organizationId: scope.organizationId,
            name: 'Private Remote App',
            description: '',
            deliveryMode: 'remote_url' as const,
            remoteUrl: 'https://private.example.com/app',
            availability: 'available' as const,
            sortOrder: 1,
          },
        ],
      }
      getAppCatalogAdmin = defaultGetAppCatalogAdmin
      denyCatalogCacheError = null
      const {
        handlers,
        context,
        managerFactoryCalls,
      } = await createAuthorizationHarness()
      const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!
      const remoteScope = {
        ...scope,
        catalogAppId: 'remote-app',
      }

      await expect(sync(context, scope.organizationId, { force: true }))
        .resolves.toMatchObject({ success: true, accessMode: 'online' })
      denyCatalogCacheError = new Error('disk full')
      getAppCatalogAdmin = async () => {
        throw new TestAdminError('membership removed', 'FORBIDDEN', {
          status: 403,
        })
      }
      await expect(sync(context, scope.organizationId, { force: true }))
        .resolves.toMatchObject({
          success: false,
          errorCode: 'FORBIDDEN',
          accessMode: 'denied',
        })
      expect(catalog.authorizationStatus).toBe('authorized')
      expect(accessMode).toBe('denied')

      getAppCatalogAdmin = async () => {
        throw new TestAdminError('transport unavailable', errorCode)
      }
      const fallback = await sync(
        context,
        scope.organizationId,
        { force: true },
      )

      expect(fallback).toMatchObject({
        success: false,
        errorCode,
        accessMode: 'denied',
        catalog: {
          authorizationStatus: 'denied',
          apps: [
            { id: scope.catalogAppId, availability: 'unavailable' },
            { id: 'remote-app', availability: 'unavailable' },
          ],
        },
      })
      expect(fallback.catalog).not.toHaveProperty('trustedReleases')
      expect(fallback.catalog.apps[0]).not.toHaveProperty('currentRelease')
      expect(fallback.catalog.apps[1]).not.toHaveProperty('remoteUrl')
      await expect(handlers.get(RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL)!(
        context,
        remoteScope,
      )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
      await expect(handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
        context,
        installRequest(),
      )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
      for (const channel of [
        RPC_CHANNELS.localApps.START,
        RPC_CHANNELS.localApps.RESTART,
      ]) {
        await expect(handlers.get(channel)!(context, scope))
          .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
      }
      expect(managerFactoryCalls()).toBe(0)
    }
  })

  it('denies lifecycle access when membership-removal cache persistence fails', async () => {
    const {
      handlers,
      context,
      managerFactoryCalls,
    } = await createAuthorizationHarness()
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!
    const listOrganizations = handlers.get(
      RPC_CHANNELS.admin.LIST_ORGANIZATIONS,
    )!
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!

    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: true, accessMode: 'online' })
    denyCatalogCacheError = new Error('disk full')
    listOrganizationsAdmin = async () => ({ organizations: [] })
    await expect(listOrganizations(context)).resolves.toMatchObject({
      success: true,
      organizations: [],
    })

    expect(catalog.authorizationStatus).toBe('authorized')
    expect(accessMode).toBe('denied')
    await expect(install(context, installRequest())).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    expect(managerFactoryCalls()).toBe(0)
  })

  it('fences an entered start when organization listing removes membership', async () => {
    const startEntered = createDeferred<void>()
    const finishStart = createDeferred<LocalAppStartResult>()
    const processStopped = createDeferred<void>()
    const calls: string[] = []
    class DeferredStartManager extends LocalAppRuntimeManager {
      override start(appId: string): Promise<LocalAppStartResult> {
        calls.push('start')
        startEntered.resolve()
        return finishStart.promise
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        processStopped.resolve()
        return { appId, status: 'stopped' }
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-org-removal-start-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new DeferredStartManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    listOrganizationsAdmin = async () => ({ organizations: [] })
    const { handlers, context } = registerProductionHandlers(root)
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const listOrganizations = handlers.get(
      RPC_CHANNELS.admin.LIST_ORGANIZATIONS,
    )!

    const pendingStart = start(context, scope)
    await startEntered.promise
    await expect(listOrganizations(context)).resolves.toMatchObject({
      success: true,
      organizations: [],
    })
    expect(accessMode as 'online' | 'offline' | 'denied' | null).toBe('denied')

    finishStart.resolve({
      appId: createCatalogRuntimeAppId(scope),
      version: '1.0.0',
      url: 'http://127.0.0.1:4671',
      port: 4671,
    })
    await expect(pendingStart).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    await processStopped.promise
    expect(calls).toEqual(['start', 'stop'])
  })

  it('fences an entered start when a successful Catalog refresh withdraws that app', async () => {
    const startEntered = createDeferred<void>()
    const withdrawalFenced = createDeferred<void>()
    const finishStart = createDeferred<LocalAppStartResult>()
    const processStopped = createDeferred<void>()
    const calls: string[] = []
    class DeferredStartManager extends LocalAppRuntimeManager {
      override start(appId: string): Promise<LocalAppStartResult> {
        calls.push('start')
        startEntered.resolve()
        return finishStart.promise
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        processStopped.resolve()
        return { appId, status: 'stopped' }
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-app-withdrawn-start-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new DeferredStartManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [],
    })
    const { handlers, context } = registerProductionHandlers(root, {
      onAdminCatalogAppsWithdrawn: (
        accountId,
        organizationId,
        catalogAppIds,
      ) => {
        const cleanup = runtimeRegistry!.stopApps(
          catalogAppIds.map(catalogAppId => ({
            kind: 'catalog',
            accountId,
            organizationId,
            catalogAppId,
          })),
        )
        withdrawalFenced.resolve()
        return cleanup
      },
    })
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!

    const pendingStart = start(context, scope)
    await startEntered.promise
    const pendingSync = sync(
      context,
      scope.organizationId,
      { force: true },
    )
    await withdrawalFenced.promise

    finishStart.resolve({
      appId: createCatalogRuntimeAppId(scope),
      version: '1.0.0',
      url: 'http://127.0.0.1:4672',
      port: 4672,
    })
    await expect(pendingStart).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    await expect(pendingSync).resolves.toMatchObject({
      success: true,
      catalog: {
        appConfigVersion: 'catalog-v2',
        apps: [],
        withdrawnApps: [{ id: scope.catalogAppId }],
      },
    })
    await processStopped.promise
    expect(calls).toEqual(['start', 'stop'])
  })

  it('keeps a withdrawn App denied when the replacement Catalog cache write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-app-withdrawn-save-failure-'))
    temporaryRoots.push(root)
    let managerFactoryCalls = 0
    const managerCalls: string[] = []
    class RetainedDataManager extends LocalAppRuntimeManager {
      override async getRuntimeStatus(appId: string): Promise<LocalAppRuntimeStatus> {
        return {
          appId,
          status: 'installed',
          currentVersion: '1.0.0',
        }
      }

      override async getLogs(): Promise<string> {
        managerCalls.push('logs')
        return 'retained logs'
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        managerCalls.push('stop')
        return { appId, status: 'stopped', currentVersion: '1.0.0' }
      }

      override async uninstall(): Promise<void> {
        managerCalls.push('uninstall')
      }

      override async start(appId: string): Promise<LocalAppStartResult> {
        managerCalls.push('start')
        return {
          appId,
          version: '1.0.0',
          url: 'http://127.0.0.1:4674',
          port: 4674,
        }
      }
    }
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => {
        managerFactoryCalls += 1
        return new RetainedDataManager(options)
      },
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    saveCatalogError = new Error('disk full')
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [],
    })
    const { handlers, context } = registerProductionHandlers(root)
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!

    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toEqual({
        success: false,
        errorCode: 'UNKNOWN_ERROR',
        message: 'Admin request failed',
      })
    expect(catalog.appConfigVersion).toBe('catalog-v1')
    expect(catalog.apps).toHaveLength(1)

    for (const channel of [
      RPC_CHANNELS.localApps.START,
      RPC_CHANNELS.localApps.RESTART,
    ]) {
      await expect(handlers.get(channel)!(context, scope))
        .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }
    await expect(handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
      context,
      installRequest(),
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(managerFactoryCalls).toBe(0)

    await expect(handlers.get(RPC_CHANNELS.localApps.GET_RUNTIME_STATUS)!(
      context,
      scope,
    )).resolves.toMatchObject({ status: 'not_installed' })
    await expect(handlers.get(RPC_CHANNELS.localApps.GET_LOGS)!(
      context,
      scope,
    )).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(handlers.get(RPC_CHANNELS.localApps.STOP)!(
      context,
      scope,
    )).resolves.toMatchObject({ status: 'stopped' })
    await expect(handlers.get(RPC_CHANNELS.localApps.UNINSTALL)!(
      context,
      scope,
      { preserveData: true },
    )).resolves.toBeUndefined()
    await expect(runtimeRegistry.getRetainedCatalogAppIds(
      scope.accountId,
      scope.organizationId,
    )).resolves.toEqual(new Set([scope.catalogAppId]))
    expect(managerFactoryCalls).toBe(1)
    expect(managerCalls).toEqual(['stop', 'uninstall'])

    const { availability: _availability, ...networkApp } = catalog.apps[0]!
    saveCatalogError = null
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v3',
      apps: [networkApp],
    })
    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({
        success: true,
        catalog: {
          appConfigVersion: 'catalog-v3',
          apps: [{ id: scope.catalogAppId }],
        },
      })
    await expect(handlers.get(RPC_CHANNELS.localApps.START)!(context, scope))
      .resolves.toMatchObject({ url: 'http://127.0.0.1:4674' })
    expect(managerCalls).toEqual(['stop', 'uninstall', 'start'])
  })

  it('keeps a withdrawn remote URL denied when its replacement cache write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-remote-withdrawn-save-failure-'))
    temporaryRoots.push(root)
    const remoteScope: CatalogLocalAppScope = {
      ...scope,
      catalogAppId: 'remote-app',
    }
    catalog = {
      ...createCatalog(),
      apps: [{
        id: remoteScope.catalogAppId,
        organizationId: remoteScope.organizationId,
        name: 'Remote App',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://stale.example.com/app',
        availability: 'available',
        sortOrder: 0,
      }],
    }
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({ rootDir: root })
    tokens = createSignedInTokens()
    accessMode = 'online'
    saveCatalogError = new Error('disk full')
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [],
    })
    const { handlers, context } = registerProductionHandlers(root)
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!
    const resolveRemoteUrl = handlers.get(
      RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
    )!

    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toEqual({
        success: false,
        errorCode: 'UNKNOWN_ERROR',
        message: 'Admin request failed',
      })
    expect(catalog.appConfigVersion).toBe('catalog-v1')
    expect(catalog.apps).toEqual([
      expect.objectContaining({
        id: remoteScope.catalogAppId,
        remoteUrl: 'https://stale.example.com/app',
        availability: 'available',
      }),
    ])
    await expect(resolveRemoteUrl(context, remoteScope))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
  })

  it('keeps an entered start valid when a successful refresh retains that app', async () => {
    const startEntered = createDeferred<void>()
    const finishStart = createDeferred<LocalAppStartResult>()
    const calls: string[] = []
    class DeferredStartManager extends LocalAppRuntimeManager {
      override start(): Promise<LocalAppStartResult> {
        calls.push('start')
        startEntered.resolve()
        return finishStart.promise
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        return { appId, status: 'stopped' }
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-app-retained-start-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new DeferredStartManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    const { availability: _availability, ...networkApp } = catalog.apps[0]!
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [networkApp],
    })
    const { handlers, context } = registerProductionHandlers(root)
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!

    const pendingStart = start(context, scope)
    await startEntered.promise
    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({
        success: true,
        catalog: {
          appConfigVersion: 'catalog-v2',
          apps: [{ id: scope.catalogAppId }],
        },
      })

    finishStart.resolve({
      appId: createCatalogRuntimeAppId(scope),
      version: '1.0.0',
      url: 'http://127.0.0.1:4673',
      port: 4673,
    })
    await expect(pendingStart).resolves.toMatchObject({
      url: 'http://127.0.0.1:4673',
    })
    expect(calls).toEqual(['start'])
  })

  it('rejects a local-to-remote mode change without fencing an entered start', async () => {
    const startEntered = createDeferred<void>()
    const finishStart = createDeferred<LocalAppStartResult>()
    const calls: string[] = []
    class ModeConflictStartManager extends LocalAppRuntimeManager {
      override start(): Promise<LocalAppStartResult> {
        calls.push('start')
        startEntered.resolve()
        return finishStart.promise
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        return { appId, status: 'stopped', currentVersion: '1.0.0' }
      }

      override async uninstall(): Promise<void> {
        calls.push('uninstall')
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-app-mode-conflict-start-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new ModeConflictStartManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    const currentApp = catalog.apps[0]!
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [{
        ...currentApp,
        deliveryMode: 'remote_url',
        remoteUrl: 'https://catalog.example/changed-mode',
        currentRelease: undefined,
      }],
    })
    const { handlers, context } = registerProductionHandlers(root)
    const pendingStart = handlers.get(RPC_CHANNELS.localApps.START)!(context, scope)
    await startEntered.promise

    await expect(handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!(
      context,
      scope.organizationId,
      { force: true },
    )).resolves.toMatchObject({
      success: true,
      source: 'cache',
      refreshed: false,
      accessMode: 'offline',
      warningCode: 'SERVER_ERROR',
      catalog: {
        appConfigVersion: 'catalog-v1',
        apps: [{
          id: scope.catalogAppId,
          deliveryMode: 'local_bundle',
        }],
      },
    })

    finishStart.resolve({
      appId: createCatalogRuntimeAppId(scope),
      version: '1.0.0',
      url: 'http://127.0.0.1:4675',
      port: 4675,
    })
    await expect(pendingStart).resolves.toMatchObject({
      url: 'http://127.0.0.1:4675',
    })
    await expect(handlers.get(RPC_CHANNELS.localApps.STOP)!(context, scope))
      .resolves.toMatchObject({ status: 'stopped' })
    await expect(handlers.get(RPC_CHANNELS.localApps.UNINSTALL)!(
      context,
      scope,
      { preserveData: true },
    )).resolves.toBeUndefined()
    expect(calls).toEqual(['start', 'stop', 'uninstall'])
  })

  it('rejects a local-to-remote mode change without cancelling an entered install', async () => {
    const installEntered = createDeferred<void>()
    const finishInstall = createDeferred<LocalAppInstalledApp>()
    const calls: string[] = []
    class ModeConflictInstallManager extends LocalAppRuntimeManager {
      override install(): Promise<LocalAppInstalledApp> {
        calls.push('install')
        installEntered.resolve()
        return finishInstall.promise
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-app-mode-conflict-install-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new ModeConflictInstallManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    const currentApp = catalog.apps[0]!
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [{
        ...currentApp,
        deliveryMode: 'remote_url',
        remoteUrl: 'https://catalog.example/changed-mode',
        currentRelease: undefined,
      }],
    })
    const { handlers, context } = registerProductionHandlers(root)
    const pendingInstall = handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
      context,
      installRequest(),
    )
    await installEntered.promise

    await expect(handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!(
      context,
      scope.organizationId,
      { force: true },
    )).resolves.toMatchObject({
      success: true,
      source: 'cache',
      accessMode: 'offline',
      catalog: {
        appConfigVersion: 'catalog-v1',
        apps: [{
          id: scope.catalogAppId,
          deliveryMode: 'local_bundle',
        }],
      },
    })

    finishInstall.resolve({
      appId: createCatalogRuntimeAppId(scope),
      currentVersion: '1.0.0',
      versions: ['1.0.0'],
      runtime: 'static',
      status: 'installed',
      installedAt: 1,
    })
    await expect(pendingInstall).resolves.toMatchObject({
      appId: scope.catalogAppId,
      currentVersion: '1.0.0',
      scope,
    })
    expect(calls).toEqual(['install'])
  })

  it('cancels an entered install when a successful Catalog refresh withdraws that app', async () => {
    const installEntered = createDeferred<void>()
    const finishInstall = createDeferred<LocalAppInstalledApp>()
    const processStopped = createDeferred<void>()
    const calls: string[] = []
    class DeferredInstallManager extends LocalAppRuntimeManager {
      override install(): Promise<LocalAppInstalledApp> {
        calls.push('install')
        installEntered.resolve()
        return finishInstall.promise
      }

      override cancelInstall(): boolean {
        calls.push('cancel-install')
        finishInstall.reject(new LocalAppRuntimeError(
          'INSTALL_CANCELLED',
          'Catalog app was withdrawn',
        ))
        return true
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        processStopped.resolve()
        return { appId, status: 'stopped' }
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-app-withdrawn-install-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new DeferredInstallManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [],
    })
    const { handlers, context } = registerProductionHandlers(root)
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!

    const pendingInstall = install(context, installRequest())
    const installOutcome = pendingInstall.then(
      () => ({ success: true as const }),
      (error: unknown) => ({ success: false as const, error }),
    )
    await installEntered.promise
    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({
        success: true,
        catalog: { apps: [] },
      })

    await expect(installOutcome).resolves.toMatchObject({
      success: false,
      error: { code: 'NOT_AUTHORIZED' },
    })
    await processStopped.promise
    expect(calls).toEqual([
      'install',
      'cancel-install',
      'cancel-install',
      'stop',
    ])
  })

  it('rechecks retained state after fencing an install completed after the first scan', async () => {
    const initialScanReached = createDeferred<void>()
    const releaseInitialScan = createDeferred<void>()
    const installEntered = createDeferred<void>()
    const finishInstall = createDeferred<LocalAppInstalledApp>()
    let runtimeStatus: LocalAppRuntimeStatus = {
      appId: createCatalogRuntimeAppId(scope),
      status: 'installing',
    }
    const calls: string[] = []
    class RetainedBoundaryManager extends LocalAppRuntimeManager {
      override install(): Promise<LocalAppInstalledApp> {
        calls.push('install')
        installEntered.resolve()
        return finishInstall.promise.then(installed => {
          runtimeStatus = {
            appId: installed.appId,
            status: 'installed',
            currentVersion: installed.currentVersion,
          }
          return installed
        })
      }

      override async getRuntimeStatus(): Promise<LocalAppRuntimeStatus> {
        return runtimeStatus
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        runtimeStatus = {
          appId,
          status: 'stopped',
          currentVersion: '1.0.0',
        }
        return runtimeStatus
      }

      override async uninstall(): Promise<void> {
        calls.push('uninstall')
        runtimeStatus = {
          appId: createCatalogRuntimeAppId(scope),
          status: 'not_installed',
        }
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-app-retained-boundary-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new RetainedBoundaryManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    catalog = {
      ...createCatalog(),
      withdrawnApps: Array.from({ length: 10_000 }, (_, index) => ({
        id: `old-tombstone-${index}`,
        organizationId: scope.organizationId,
        name: `Old tombstone ${index}`,
        description: '',
        deliveryMode: 'local_bundle' as const,
        availability: 'withdrawn' as const,
        sortOrder: index + 1,
      })),
    }
    getAppCatalogAdmin = async () => ({
      notModified: false,
      appConfigVersion: 'catalog-v2',
      apps: [],
    })
    let retainedScans = 0
    const { handlers, context } = registerProductionHandlers(root, {
      getRetainedCatalogAppIds: async (accountId, organizationId) => {
        retainedScans += 1
        if (retainedScans === 1) {
          initialScanReached.resolve()
          await releaseInitialScan.promise
          return new Set()
        }
        return runtimeRegistry!.getRetainedCatalogAppIds(
          accountId,
          organizationId,
        )
      },
    })
    const pendingInstall = handlers.get(RPC_CHANNELS.localApps.INSTALL)!(
      context,
      installRequest(),
    )
    await installEntered.promise
    const pendingSync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!(
      context,
      scope.organizationId,
      { force: true },
    )
    await initialScanReached.promise

    finishInstall.resolve({
      appId: createCatalogRuntimeAppId(scope),
      currentVersion: '1.0.0',
      versions: ['1.0.0'],
      runtime: 'static',
      status: 'installed',
      installedAt: 1,
    })
    await expect(pendingInstall).resolves.toMatchObject({
      appId: scope.catalogAppId,
      currentVersion: '1.0.0',
    })
    releaseInitialScan.resolve()

    const syncResult = await pendingSync
    expect(syncResult).toMatchObject({
      success: true,
      catalog: {
        appConfigVersion: 'catalog-v2',
        apps: [],
      },
    })
    expect(syncResult.catalog?.withdrawnApps?.[0]).toMatchObject({
      id: scope.catalogAppId,
      availability: 'withdrawn',
    })
    expect(retainedScans).toBe(2)
    expect(catalog.withdrawnApps).toHaveLength(10_000)
    expect(catalog.withdrawnApps?.[0]).toMatchObject({
      id: scope.catalogAppId,
      availability: 'withdrawn',
    })
    await expect(handlers.get(RPC_CHANNELS.localApps.GET_RUNTIME_STATUS)!(
      context,
      scope,
    )).resolves.toMatchObject({
      status: 'stopped',
      currentVersion: '1.0.0',
    })
    await expect(handlers.get(RPC_CHANNELS.localApps.STOP)!(context, scope))
      .resolves.toMatchObject({ status: 'stopped' })
    await expect(handlers.get(RPC_CHANNELS.localApps.UNINSTALL)!(
      context,
      scope,
      { preserveData: true },
    )).resolves.toBeUndefined()
    expect(calls).toEqual(['install', 'stop', 'stop', 'uninstall'])
  })

  it('cancels an entered install when Catalog returns NOT_FOUND', async () => {
    const installEntered = createDeferred<void>()
    const finishInstall = createDeferred<LocalAppInstalledApp>()
    const processStopped = createDeferred<void>()
    const calls: string[] = []
    class DeferredInstallManager extends LocalAppRuntimeManager {
      override install(): Promise<LocalAppInstalledApp> {
        calls.push('install')
        installEntered.resolve()
        return finishInstall.promise
      }

      override cancelInstall(): boolean {
        calls.push('cancel-install')
        finishInstall.reject(new LocalAppRuntimeError(
          'INSTALL_CANCELLED',
          'Catalog authorization was withdrawn',
        ))
        return true
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        processStopped.resolve()
        return { appId, status: 'stopped' }
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'polo-org-not-found-install-'))
    temporaryRoots.push(root)
    runtimeRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: root,
      managerFactory: options => new DeferredInstallManager(options),
    })
    tokens = createSignedInTokens()
    accessMode = 'online'
    const { handlers, context } = registerProductionHandlers(root)
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL)!
    const sync = handlers.get(RPC_CHANNELS.admin.SYNC_APP_CATALOG)!

    const pendingInstall = install(context, installRequest())
    const installOutcome = pendingInstall.then(
      () => ({ success: true as const }),
      (error: unknown) => ({ success: false as const, error }),
    )
    await installEntered.promise
    getAppCatalogAdmin = async () => {
      throw new TestAdminError('organization unavailable', 'NOT_FOUND', {
        status: 404,
      })
    }
    await expect(sync(context, scope.organizationId, { force: true }))
      .resolves.toMatchObject({ success: false, errorCode: 'NOT_FOUND' })
    expect(accessMode as 'online' | 'offline' | 'denied' | null).toBe('denied')

    await expect(installOutcome).resolves.toMatchObject({
      success: false,
      error: { code: 'NOT_AUTHORIZED' },
    })
    await processStopped.promise
    expect(calls).toEqual([
      'install',
      'cancel-install',
      'cancel-install',
      'stop',
    ])
  })
})
