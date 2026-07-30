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
  organizationId: 'organization-a',
  catalogAppId: 'catalog-app',
}
let tokens: StoredTokens | null = null
let accessMode: 'online' | 'offline' | 'denied' = 'online'
let runtimeRegistry: ScopedLocalAppRuntimeRegistry | null = null
let remoteLogout: (accessToken: string) => Promise<void> = async () => {}
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

  logout(accessToken: string): Promise<void> {
    return remoteLogout(accessToken)
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
    return false
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
  getAppCatalogAccessMode: () => accessMode,
  setAppCatalogAccessMode: (
    _accountId: string,
    _organizationId: string,
    mode: typeof accessMode,
  ) => {
    accessMode = mode
  },
  denyAppCatalogAccessForAccount: (accountId: string) => {
    if (accountId === scope.accountId) accessMode = 'denied'
  },
  denyCachedAppCatalogAuthorization: () => {
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

afterEach(async () => {
  runtimeRegistry = null
  tokens = null
  accessMode = 'online'
  remoteLogout = async () => {}
  catalog = createCatalog()
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })))
})

describe('Admin logout and scoped local app production wiring', () => {
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
    tokens = {
      accessToken: 'account-a-access',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 60_000,
      userId: scope.accountId,
      username: 'account-a',
    }
    const remoteLogoutStarted = createDeferred<void>()
    const finishRemoteLogout = createDeferred<void>()
    let remoteLogoutCompleted = false
    remoteLogout = async () => {
      remoteLogoutStarted.resolve()
      await finishRemoteLogout.promise
      remoteLogoutCompleted = true
    }

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
      onAdminSessionEnding: (accountId: string) =>
        runtimeRegistry!.stopAccount(accountId),
      onAdminSessionStarted: (accountId: string) =>
        runtimeRegistry!.resumeAccount(accountId),
    } satisfies HandlerDeps
    registerAdminHandlers(server, deps)
    registerLocalAppHandlers(server)

    const context = {
      clientId: 'renderer',
      workspaceId: null,
      webContentsId: null,
      signal: new AbortController().signal,
    }
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
})
