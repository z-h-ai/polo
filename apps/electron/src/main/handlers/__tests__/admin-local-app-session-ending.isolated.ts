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
  accountId: 'account-a',
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
) => Promise<unknown> = async () => ({ notModified: true })
let listOrganizationsAdmin: (accessToken: string) => Promise<unknown> =
  async () => ({ organizations: [] })
let tokensExpired = false
let denyCatalogCacheError: Error | null = null
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
  getAppCatalogApps: (entry: AppCatalogCacheEntry) => entry.apps,
  getCachedAppCatalog: (
    accountId: string,
    organizationId: string,
  ) => accountId === scope.accountId && organizationId === scope.organizationId
    ? catalog
    : null,
  listCachedAppCatalogs: (accountId: string) =>
    accountId === scope.accountId ? [catalog] : [],
  saveAppCatalog: () => catalog,
  getAppCatalogAccessMode: (accountId: string) =>
    deniedAccounts.has(accountId) ? 'denied' : accessMode ?? 'offline',
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
  getAppCatalogAdmin = async () => ({ notModified: true })
  listOrganizationsAdmin = async () => ({ organizations: [] })
  tokensExpired = false
  denyCatalogCacheError = null
  catalog = createCatalog()
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })))
})

describe('Admin session and scoped local app production wiring', () => {
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
})
