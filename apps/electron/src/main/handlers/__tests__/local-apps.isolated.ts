import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { statSync } from 'node:fs'
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
let workspaceExists = true
let accessMode: 'online' | 'offline' | 'denied' = 'online'
let accountAccessDenied = false
let appAccessDenied = false
let catalog: AppCatalogCacheEntry = createCatalog(1)

// Trusted Catalog authority fixture: Main-owned FULL identity tuples
// (catalogEntryId + artifactInstanceId + versionId + version) the renderer
// may reference for withdrawn management, keyed by account|space (seeded
// per test).
const authorityTuplesByScope = new Map<string, Set<string>>()

function authorityScopeKey(accountId = 'account-a', productSpaceId = 'organization-a'): string {
  return `${accountId}|${productSpaceId}`
}

function seedAuthorityBinding(
  accountId = 'account-a',
  productSpaceId = 'organization-a',
  catalogEntryId = 'catalog-entry-a',
  artifactInstanceId = 'artifact-instance-a',
  versionId = 'version-a',
  version = '2.3.4',
): void {
  const scope = authorityScopeKey(accountId, productSpaceId)
  const set = authorityTuplesByScope.get(scope) ?? new Set<string>()
  set.add(JSON.stringify([catalogEntryId, artifactInstanceId, versionId, version]))
  authorityTuplesByScope.set(scope, set)
}

function seedAuthorityTuples(
  productSpaceId = 'organization-a',
  count: number,
  prefix = 'authority',
): void {
  const set = authorityTuplesByScope.get(authorityScopeKey('account-a', productSpaceId))
    ?? new Set<string>()
  for (let index = 0; index < count; index += 1) {
    set.add(JSON.stringify([
      `${prefix}-entry-${index}`,
      `${prefix}-artifact-${index}`,
      `${prefix}-version-${index}`,
      '1.0.0',
    ]))
  }
  authorityTuplesByScope.set(authorityScopeKey('account-a', productSpaceId), set)
}

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
const listProductSpaces = mock(async () => ({
  contractVersion: 1,
  defaultProductSpaceId: 'organization-a',
  productSpaces: [{
    id: 'organization-a',
    kind: 'enterprise' as const,
    enterpriseId: 'enterprise-a',
    name: 'Organization A',
    role: 'manager' as const,
    accessMode: 'active' as const,
  }],
}))
const defaultProductSpaceCatalog = async () => ({
  contractVersion: 1,
  productSpaceId: 'organization-a',
  catalogRevision: 'revision-a',
  entries: [{
    kind: 'app' as const,
    catalogEntryId: 'catalog-entry-a',
    artifactInstanceId: 'artifact-instance-a',
    version: {
      versionId: 'version-a',
      version: '2.3.4',
      checksum: 'b'.repeat(64),
    },
    name: 'ProductSpace App',
    description: '',
    availability: 'available' as const,
    sources: [{ kind: 'enterprise_import' as const, enterpriseId: 'enterprise-a' }],
    permissions: [],
  }],
})
const getProductSpaceCatalog = mock(defaultProductSpaceCatalog)
const resolveProductSpaceLaunch = mock(async () => ({
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
  payer: { kind: 'enterprise' as const, enterpriseId: 'enterprise-a' },
  delivery: {
    kind: 'bundle' as const,
    downloadUrl: 'https://catalog.example/product-space-app.zip',
    expiresAt: '2099-01-01T00:10:00.000Z',
    checksum: 'b'.repeat(64),
    sizeBytes: 456,
  },
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
const activeRuntimesByKey = new Map<string, Record<string, unknown>>()
const activeRuntimesByExecution = new Map<string, Record<string, unknown>>()

function runtimeIdentityKey(identity: {
  accountId: string
  productSpaceId: string
  artifactInstanceId: string
  versionId: string
  version: string
}): string {
  return JSON.stringify([
    identity.accountId,
    identity.productSpaceId,
    identity.artifactInstanceId,
    identity.versionId,
    identity.version,
  ])
}

const defaultStartExact = async (
  _scope: CatalogLocalAppScope,
  version: string,
  hooks?: { processEnvironment?: (input: { runtimeKind: 'python' | 'js'; runtimeGeneration: number; scopeGeneration: number }) => unknown },
) => {
  const signing = hooks?.processEnvironment?.({
    runtimeKind: 'python',
    runtimeGeneration: 41,
    scopeGeneration: 7,
  }) as { env: Record<string, string>; sensitiveValues: string[] } | undefined
  void signing
  return {
    appId: 'artifact-instance-a',
    scope: { kind: 'catalog', accountId: 'account-a', organizationId: 'organization-a', catalogAppId: 'artifact-instance-a' },
    version,
    url: 'http://127.0.0.1:9876',
    port: 9876,
    runtimeKind: 'python' as const,
    runtimeGeneration: 41,
    scopeGeneration: 7,
  }
}

const scopedStartExact = mock(defaultStartExact)
const scopedStopExact = mock(async (
  scope: CatalogLocalAppScope,
  expectedRuntimeGeneration: number,
): Promise<LocalAppRuntimeStatus> => {
  if (expectedRuntimeGeneration !== 41) {
    throw Object.assign(new Error('stale'), { code: 'STALE_RUNTIME_GENERATION' })
  }
  return {
    appId: scope.catalogAppId,
    scope,
    status: 'stopped' as const,
    currentVersion: '2.3.4',
  }
})

const runtimeCoordinator = {
  ensureGateway: mock(async () => 'http://127.0.0.1:9/local-app-api/v1'),
  signCapability: mock((input: Record<string, unknown>) => {
    void input
    return {
      capabilityGeneration: 11,
      token: 'capability-token',
      environment: {
        POLO_APP_API_URL: 'http://127.0.0.1:9/local-app-api/v1',
        POLO_APP_API_TOKEN: 'capability-token',
      },
      sensitiveValues: ['capability-token'],
    }
  }),
  registerActiveRuntime: mock((input: Record<string, unknown>) => {
    const identity = (input as { identity: {
      accountId: string
      productSpaceId: string
      artifactInstanceId: string
      versionId: string
      version: string
    } }).identity
    const runtime = {
      ...input,
      identity,
      controller: new AbortController(),
    }
    activeRuntimesByKey.set(runtimeIdentityKey(identity), runtime)
    activeRuntimesByExecution.set(
      (input as { executionId: string }).executionId,
      runtime,
    )
    return runtime
  }),
  getActiveRuntime: mock((identity: {
    accountId: string
    productSpaceId: string
    artifactInstanceId: string
    versionId: string
    version: string
  }): unknown => activeRuntimesByKey.get(runtimeIdentityKey(identity)) ?? null),
  getActiveRuntimeByExecution: mock((executionId: unknown): unknown =>
    activeRuntimesByExecution.get(executionId as string) ?? null),
  revokeSignedCapability: mock(() => {}),
  teardownRuntime: mock(async (...args: unknown[]) => {
    const runtime = args[0] as {
      identity: {
        accountId: string
        productSpaceId: string
        artifactInstanceId: string
        versionId: string
        version: string
      }
      executionId: string
    }
    activeRuntimesByKey.delete(runtimeIdentityKey(runtime.identity))
    activeRuntimesByExecution.delete(runtime.executionId)
    // REAL-coordinator semantics: a failing stopProcess is RECORDED (never
    // thrown) and the teardown resolves with the SAME immutable shared
    // outcome carrying the failure — the frozen handler boundary consumes
    // the OUTCOME (never a racy per-execution take).
    const stopProcess = args[2] as (() => Promise<void>) | undefined
    let stopFailure: unknown
    try {
      await stopProcess?.()
    } catch (error) {
      stopFailure = error
    }
    const outcome = Object.freeze({ executionId: runtime.executionId, stopFailure })
    if (stopFailure !== undefined) {
      recordedRollbackStopFailures.set(runtime.executionId, outcome)
    } else {
      recordedRollbackStopFailures.delete(runtime.executionId)
    }
    return outcome
  }),
  handleUnexpectedExit: mock(async () => {}),
  consumeTeardownOutcome: mock(
    (outcome: { executionId: string; stopFailure: unknown }): unknown => {
      // REAL-coordinator semantics: the failure travels ON the shared
      // outcome; consumption only retires the retained record when it
      // belongs to THIS exact teardown.
      if (recordedRollbackStopFailures.get(outcome.executionId) === outcome) {
        recordedRollbackStopFailures.delete(outcome.executionId)
      }
      return outcome.stopFailure
    },
  ),
  takeRollbackStopFailure: mock((executionId: unknown): unknown => {
    const outcome = recordedRollbackStopFailures.get(executionId as string) as
      | { stopFailure?: unknown }
      | undefined
    if (outcome !== undefined) {
      recordedRollbackStopFailures.delete(executionId as string)
    }
    return outcome?.stopFailure
  }),
}
const recordedRollbackStopFailures = new Map<string, unknown>()
const assertAppAuthorized = mock(() => {
  if (appAccessDenied) {
    throw Object.assign(new Error('Catalog app authorization is ending'), {
      code: 'NOT_AUTHORIZED',
    })
  }
})

let scopedRegistryOverride: unknown = null

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
  startExact: scopedStartExact,
  stopExact: scopedStopExact,
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
    listProductSpaces = listProductSpaces
    getProductSpaceCatalog = getProductSpaceCatalog
    resolveProductSpaceLaunch = resolveProductSpaceLaunch
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
  // The trusted caller-Workspace existence check for ProductSpace starts.
  getWorkspaceByNameOrId: (id: string) =>
    workspaceExists ? { id, rootPath: `/root-${id}` } : null,
}))

const withdrawnTombstonesByScope = new Map<string, Set<string>>()

function seedTombstoneBinding(
  accountId = 'account-a',
  productSpaceId = 'organization-a',
  catalogEntryId = 'catalog-entry-w',
  artifactInstanceId = 'artifact-w',
  versionId = 'version-w',
  version = '2.0.0',
): void {
  const scope = authorityScopeKey(accountId, productSpaceId)
  const set = withdrawnTombstonesByScope.get(scope) ?? new Set<string>()
  set.add(JSON.stringify([catalogEntryId, artifactInstanceId, versionId, version]))
  withdrawnTombstonesByScope.set(scope, set)
}

const trustedRecordByScope = new Map<string, {
  kind: 'authority'
  entries: Array<{ catalogEntryId: string; artifactInstanceId: string; versionId: string; version: string; sources: ReadonlyArray<{ kind: string; name?: string; circleId?: string }> }>
}>()

function seedTrustedBinding(
  accountId: string,
  productSpaceId: string,
  bindings: Array<{
    catalogEntryId: string
    artifactInstanceId: string
    versionId: string
    version: string
    sources: ReadonlyArray<{ kind: string; name?: string; circleId?: string }>
    availability?: 'available' | 'unavailable' | 'blocked' | 'withdrawn'
  }>,
  options: { catalogRevision?: string; tombstones?: Array<Record<string, unknown>> } = {},
): void {
  trustedRecordByScope.set(authorityScopeKey(accountId, productSpaceId), {
    kind: 'authority',
    catalogRevision: options.catalogRevision ?? 'revision-a',
    entries: bindings.map(binding => ({
      ...binding,
      availability: binding.availability ?? ('available' as const),
    })),
    tombstones: options.tombstones ?? [],
  } as never)
}

mock.module('@polo-ai/server-core/runtime/product-space-catalog-authority', () => ({
  getProductSpaceCatalogAuthorityRecord: (accountId: string, productSpaceId: string) =>
    trustedRecordByScope.get(authorityScopeKey(accountId, productSpaceId)) ?? null,
  loadProductSpaceCatalogAuthorityTupleSet: (accountId: string, productSpaceId: string) =>
    authorityTuplesByScope.get(authorityScopeKey(accountId, productSpaceId)) ?? new Set<string>(),
  loadProductSpaceWithdrawnTombstoneTupleSet: (accountId: string, productSpaceId: string) =>
    withdrawnTombstonesByScope.get(authorityScopeKey(accountId, productSpaceId)) ?? new Set<string>(),
  productSpaceCatalogAuthorityTupleKey: (
    catalogEntryId: string,
    artifactInstanceId: string,
    versionId: string,
    version: string,
  ) => JSON.stringify([catalogEntryId, artifactInstanceId, versionId, version]),
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
    readonly details?: Record<string, unknown>
    constructor(
      public readonly code: string,
      message: string,
      details?: Record<string, unknown>,
    ) {
      super(message)
      if (details) this.details = details
    }
  }

  return {
    getLocalAppRuntimeManager: () => {
      throw new Error('renderer RPC must never reach the trusted legacy manager')
    },
    getScopedLocalAppRuntimeRegistry: () => scopedRegistryOverride ?? scopedRegistry,
    getLocalAppRuntimeCoordinator: () => runtimeCoordinator,
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
const {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} = await import(
  '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
)
const {
  resetProductSpaceExecutionRegistryForTests: resetExecutionRegistry,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
  getRuntimeActiveProductSpace,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  revokeRuntimeProductSpaceFence,
} = await import('@polo-ai/server-core/runtime/product-space-executions')
const { runUnderSwitchMutex } = await import('@polo-ai/server-core/runtime/product-space-executions')
const { PRODUCT_SPACE_CONTRACT_VERSION, ProductSpaceExecutionScopeSchema } =
  await import('@polo-ai/shared/product-spaces')
// TEST-ONLY internal seam via an explicit relative source path: the typed
// switch-mutex event registry lets this regression prove FIFO lock order
// without any timing window. The internal module is deliberately NOT
// re-exported through product-space-executions or any package exports map —
// this relative import reaches the same source module instance the
// production handler's runUnderSwitchMutex executes on.
const { pendingSwitchLockTasks, switchLockEventLog } = await import(
  '../../../../../../packages/server-core/src/runtime/switch-lock-internal'
)

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

function productSpaceAppIdentity() {
  return {
    accountId: 'account-a',
    productSpaceId: 'organization-a',
    catalogRevision: 'revision-a',
    catalogEntryId: 'catalog-entry-a',
    artifactInstanceId: 'artifact-instance-a',
    versionId: 'version-a',
    version: '2.3.4',
    // Canonical renderer-sealed sources/availability: they mirror the
    // name-less enterprise_import source and the raw 'available' availability
    // of the default authoritative Catalog row.
    sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
    availability: 'available' as const,
  }
}

describe('local app main-process authorization boundary', () => {
  const handlers = new Map<string, Handler>()
  const context = {
    clientId: 'renderer',
    webContentsId: 1 as number | null,
    signal: new AbortController().signal,
  }
  let windowWorkspaceId: string | null = 'ws-window-a'

  beforeEach(async () => {
    signedInAccountId = 'account-a'
    accessMode = 'online'
    accountAccessDenied = false
    appAccessDenied = false
    catalog = createCatalog(1)
    authorityTuplesByScope.clear()
    withdrawnTombstonesByScope.clear()
    trustedRecordByScope.clear()
    seedAuthorityBinding()
    windowWorkspaceId = 'ws-window-a'
    workspaceExists = true
    context.webContentsId = 1
    getAppReleaseDownload.mockClear()
    listProductSpaces.mockClear()
    getProductSpaceCatalog.mockClear()
    resolveProductSpaceLaunch.mockClear()
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
    scopedStartExact.mockClear()
    scopedStopExact.mockClear()
    runtimeCoordinator.ensureGateway.mockClear()
    runtimeCoordinator.signCapability.mockClear()
    runtimeCoordinator.registerActiveRuntime.mockClear()
    activeRuntimesByKey.clear()
    activeRuntimesByExecution.clear()
    recordedRollbackStopFailures.clear()
    runtimeCoordinator.revokeSignedCapability.mockClear()
    runtimeCoordinator.teardownRuntime.mockClear()
    runtimeCoordinator.consumeTeardownOutcome.mockClear()
    const { resetAppRuntimeCenterForTests } = await import(
      '@polo-ai/server-core/runtime'
    )
    resetAppRuntimeCenterForTests()
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
    registerLocalAppHandlers(server, {
      windowManager: {
        getWorkspaceForWindow: (webContentsId: number) => (
          context.webContentsId === webContentsId ? windowWorkspaceId : null
        ),
      },
    } as never)
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    // The lock-free trusted-account mirror authenticates the start path's
    // critical section; it tracks the same signed-in account.
    setSyncTrustedProductSpaceAccountId(signedInAccountId)
    if (signedInAccountId) {
      setRuntimeActiveProductSpaceAccount(signedInAccountId)
    }
    setRuntimeActiveProductSpace(signedInAccountId ? 'organization-a' : null)
    setRuntimeOfflineReadOnly(false)
    resetExecutionRegistry()
  })

  it('installs a bundle only after revalidating the exact ProductSpace Catalog tuple', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL_PRODUCT_SPACE_BUNDLE)!
    const installed = await install(context, { app: productSpaceAppIdentity() })

    expect(listProductSpaces).toHaveBeenCalledWith('account-a-access')
    expect(getProductSpaceCatalog).toHaveBeenCalledTimes(1)
    expect(resolveProductSpaceLaunch).toHaveBeenCalledWith(
      'account-a-access',
      expect.objectContaining({ id: 'organization-a' }),
      expect.objectContaining({ productSpaceId: 'organization-a' }),
      'catalog-entry-a',
      expect.objectContaining({ platform: expect.any(String), arch: expect.any(String) }),
    )
    expect(scopedInstall).toHaveBeenCalledWith(expect.objectContaining({
      scope: {
        kind: 'catalog',
        accountId: 'account-a',
        organizationId: 'organization-a',
        catalogAppId: 'artifact-instance-a',
      },
      version: '2.3.4',
      checksum: 'b'.repeat(64),
    }), expect.objectContaining({ signal: context.signal }))
    expect(installed).toMatchObject({
      appId: 'artifact-instance-a',
      currentVersion: '2.3.4',
    })
  })

  it('fails closed before install when an artifact version tuple is stale', async () => {
    const install = handlers.get(RPC_CHANNELS.localApps.INSTALL_PRODUCT_SPACE_BUNDLE)!
    await expect(install(context, {
      app: { ...productSpaceAppIdentity(), versionId: 'stale-version' },
    })).rejects.toMatchObject({ code: 'RELEASE_CHANGED' })
    expect(resolveProductSpaceLaunch).not.toHaveBeenCalled()
    expect(scopedInstall).not.toHaveBeenCalled()
  })

  it('projects installation state without exposing Runtime lifecycle controls', async () => {
    scopedStatuses.mockImplementationOnce(async scopes => scopes.map(item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'running' as const,
      currentVersion: '2.3.4',
      runningVersion: '2.3.4',
    })))
    const getStates = handlers.get(
      RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_INSTALL_STATES,
    )!
    const states = await getStates(context, [productSpaceAppIdentity()])
    expect(states).toEqual([{
      app: productSpaceAppIdentity(),
      state: 'installed',
      currentVersion: '2.3.4',
    }])
  })

  it('rejects duplicate ProductSpace App identities in one batch', async () => {
    const getStates = handlers.get(
      RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_INSTALL_STATES,
    )!
    await expect(getStates(context, [
      productSpaceAppIdentity(),
      productSpaceAppIdentity(),
    ])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('projects withdrawn install states through the install identity without consulting the Catalog', async () => {
    scopedStatuses.mockImplementationOnce(async scopes => scopes.map(item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'installed' as const,
      currentVersion: '2.3.4',
    })))
    const getWithdrawnStates = handlers.get(
      RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_WITHDRAWN_INSTALL_STATES,
    )!
    // The identity is NOT in the fresh Catalog (withdrawn) — the restricted
    // withdrawn channel must project the retained installation from the
    // Main-authority artifact-instance binding alone.
    const states = await getWithdrawnStates(context, [productSpaceAppIdentity()])
    expect(getProductSpaceCatalog).not.toHaveBeenCalled()
    expect(scopedStatuses).toHaveBeenCalledWith([{
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: 'artifact-instance-a',
    }])
    expect(states).toEqual([{
      app: productSpaceAppIdentity(),
      state: 'installed',
      currentVersion: '2.3.4',
    }])
  })

  it('rejects withdrawn identities that are not in the trusted Catalog authority', async () => {
    const getWithdrawnStates = handlers.get(
      RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_WITHDRAWN_INSTALL_STATES,
    )!
    // Real binding, but the batch names an UNKNOWN artifact instance.
    await expect(getWithdrawnStates(context, [{
      ...productSpaceAppIdentity(),
      artifactInstanceId: '../../another-installed-app' as never,
    }])).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    // Another space's binding is not valid here either.
    await expect(getWithdrawnStates(context, [{
      ...productSpaceAppIdentity(),
      productSpaceId: 'organization-b' as never,
    }])).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    // Fabricated SQL/XSS-shaped catalogEntryId on a REAL artifact instance —
    // the FULL tuple check rejects it (the state channel is not
    // artifact-scoped anymore).
    await expect(getWithdrawnStates(context, [{
      ...productSpaceAppIdentity(),
      catalogEntryId: "x' OR 1=1 --" as never,
    }])).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(getWithdrawnStates(context, [{
      ...productSpaceAppIdentity(),
      catalogEntryId: '<script>alert(1)</script>' as never,
    }])).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    // Forged versionId / version on a REAL catalog+artifact binding.
    await expect(getWithdrawnStates(context, [{
      ...productSpaceAppIdentity(),
      versionId: 'forged-version' as never,
    }])).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(getWithdrawnStates(context, [{
      ...productSpaceAppIdentity(),
      version: '999.0.0' as never,
    }])).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    // Duplicate identities in one batch are rejected too.
    await expect(getWithdrawnStates(context, [
      productSpaceAppIdentity(),
      productSpaceAppIdentity(),
    ])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(scopedStatuses).not.toHaveBeenCalled()
  })

  it('fails the withdrawn install-state channel closed on empty, cross-space, or signed-out batches', async () => {
    const getWithdrawnStates = handlers.get(
      RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_WITHDRAWN_INSTALL_STATES,
    )!
    await expect(getWithdrawnStates(context, []))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(getWithdrawnStates(context, [
      productSpaceAppIdentity(),
      { ...productSpaceAppIdentity(), productSpaceId: 'organization-b' },
    ])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    signedInAccountId = null
    await expect(getWithdrawnStates(context, [productSpaceAppIdentity()]))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    signedInAccountId = 'account-a'
    setRuntimeActiveProductSpace('organization-b')
    await expect(getWithdrawnStates(context, [productSpaceAppIdentity()]))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedStatuses).not.toHaveBeenCalled()
  })

  it('routes a withdrawn retained installation to the retained-tombstone gate after the fresh Catalog proves the entry gone', async () => {
    // A withdrawn tombstone identity that exists ONLY in the Main authority
    // (the fresh Catalog mock still lists catalog-entry-a with a DIFFERENT
    // identity) — the fresh fetch runs FIRST and its authoritative
    // missing-entry verdict routes the uninstall to the restricted
    // stop/uninstall/local-data path when the FULL tombstone tuple matches.
    seedTombstoneBinding(
      'account-a',
      'organization-a',
      'catalog-entry-w',
      'artifact-w',
      'version-w',
      '2.0.0',
    )
    seedTrustedBinding('account-a', 'organization-a', [], {
      tombstones: [{
        catalogEntryId: 'catalog-entry-w',
        artifactInstanceId: 'artifact-w',
        versionId: 'version-w',
        version: '2.0.0',
        sources: [{ kind: 'enterprise_import', name: null }],
        availability: 'withdrawn' as const,
        withdrawnAt: 1,
      }],
    })
    const withdrawnIdentity = {
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: 'catalog-entry-w',
      artifactInstanceId: 'artifact-w',
      versionId: 'version-w',
      version: '2.0.0',
      catalogRevision: 'revision-a',
      sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
      availability: 'withdrawn' as const,
    }
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    await uninstall(context, withdrawnIdentity, { preserveData: true })

    // The current Catalog IS fetched first; its authoritative missing-entry
    // verdict is what routes the request to the retained-tombstone gate.
    expect(getProductSpaceCatalog).toHaveBeenCalled()
    expect(scopedRegistry.uninstall).toHaveBeenCalledWith({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: 'artifact-w',
    }, { preserveData: true })
  })

  it('rejects KIND drift: old app tombstone + a live same-ID non-app row must NEVER reach the registry', async () => {
    // Old app tombstone retained; the STABLE entry ID now belongs to a
    // non-app (skill) live row in the current Catalog. The uninstall must
    // fail closed as live identity drift — registry zero calls.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: 'catalog-entry-a',
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-a',
      version: '2.3.4',
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-kind-drift',
      entries: [{
        kind: 'skill' as const,
        catalogEntryId: 'catalog-entry-a',
        artifactInstanceId: 'artifact-instance-a',
        version: { versionId: 'version-a', version: '2.3.4' },
        name: 'Same-ID Skill',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, enterpriseId: 'enterprise-a' }],
        enabled: true,
        permissions: [],
      }],
    }))
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    await expect(uninstall(context, productSpaceAppIdentity(), { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('rejects SOURCE drift (enterprise_import → creator_circle, set change) and AVAILABILITY drift (blocked/unavailable) as CATALOG_IDENTITY_DRIFT with zero registry calls', async () => {
    const base = productSpaceAppIdentity()
    const currentRow = {
      kind: 'app' as const,
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      version: { versionId: base.versionId, version: base.version, checksum: 'b'.repeat(64) },
      name: 'ProductSpace App',
      description: '',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const }],
      permissions: [],
    }
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // Main-owned binding mirrors the CONFIRMED sources of this identity.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])

    const driftCatalogs: Array<[string, Record<string, unknown>]> = [
      ['source kind drift', { sources: [{ kind: 'creator_circle' as const, circleId: 'circle-1' as never, name: 'Circle' }] }],
      ['source set change', { sources: [{ kind: 'enterprise_import' as const }, { kind: 'creator_circle' as const, circleId: 'circle-2' as never, name: 'Circle 2' }] }],
      ['availability blocked', { availability: 'blocked' as const }],
      ['availability unavailable', { availability: 'unavailable' as const }],
    ]
    for (const [label, override] of driftCatalogs) {
      getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
        contractVersion: 1,
        productSpaceId: 'organization-a',
        catalogRevision: 'revision-a',
        entries: [{ ...currentRow, ...override }],
      }))
      const callsBefore = scopedRegistry.uninstall.mock.calls.length
      await expect(uninstall(context, base, { preserveData: true }))
        .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
      expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
      void label
    }

    // Unchanged canonical sources + available → live uninstall succeeds.
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    // default catalog source uses enterpriseId-only shape; mirror it.
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-a',
      entries: [currentRow],
    }))
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    await uninstall(context, base, { preserveData: true })
    expect(scopedRegistry.uninstall).toHaveBeenCalled()
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('TOCTOU: concurrent authority commit during parked fresh fetch cannot launder the R1 request (DRIFT, registry 0)', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // Main-owned binding R1: confirmed with the canonical name-less
    // enterprise_import source — the request identity seals the same.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    // fresh fetch PARKED: the handler awaits while a concurrent R2 commit
    // changes the Main-owned binding (source kind + availability).
    const r2Row = {
      kind: 'app',
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      version: { versionId: base.versionId, version: base.version, checksum: 'b'.repeat(64) },
      name: 'ProductSpace App',
      description: '',
      availability: 'available',
      sources: [{ kind: 'creator_circle', circleId: 'circle-1', name: 'Circle 1' }],
      permissions: [],
    }
    let parkFetch: ((catalog: unknown) => void) | undefined
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => {
      const catalog = await new Promise<any>(resolve => { parkFetch = resolve })
      return catalog
    })
    const callsBefore = scopedRegistry.uninstall.mock.calls.length

    const pending = uninstall(context, base, { preserveData: true })
    for (let i = 0; i < 50 && !parkFetch; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!parkFetch) throw new Error('fetch pending')

    // Concurrent R2 commit: the authority binding mutates to R2 sources.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'creator_circle', circleId: 'circle-1', name: 'Circle 1' }],
      availability: 'available' as const,
    }], { catalogRevision: 'rev-r2' })

    // Release the parked fetch: the handler compares the live R2 rows
    // against the PRE-AWAIT captured R1 binding — sources drift → DRIFT.
    parkFetch!({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'rev-r2-live',
      entries: [r2Row],
    })
    await expect(pending).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('TOCTOU: authority already at R2 while renderer carries R1 revision → fail closed before registry', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // Main-owned binding ALREADY at R2 (creator_circle sources); the
    // renderer still carries an R1 revision identity.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'creator_circle', circleId: 'circle-1', name: 'Circle 1' }],
      availability: 'available' as const,
    }], { catalogRevision: 'rev-r2' })
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)

    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    await expect(uninstall(context, base, { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R28: rejects a REVISION-ONLY fresh Catalog change (byte-equivalent row) as CATALOG_IDENTITY_DRIFT with zero registry calls', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // Main-owned binding R1: revision-a with exactly the row content the
    // fresh revision-b Catalog returns below.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    // The fresh Catalog advanced its revision while the App row stayed
    // BYTE-EQUIVALENT (same kind/tuple/sources/availability): identical row
    // content must NEVER launder a stale revision-a page. The uninstall is
    // refused so the renderer refreshes and re-confirms against the current
    // revision.
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-revision-only-r2',
      entries: [{
        kind: 'app' as const,
        catalogEntryId: base.catalogEntryId,
        artifactInstanceId: base.artifactInstanceId,
        version: { versionId: base.versionId, version: base.version, checksum: 'b'.repeat(64) },
        name: 'ProductSpace App',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const }],
        permissions: [],
      }],
    }))
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    await expect(uninstall(context, base, { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R28: rejects request-vs-binding sealed source/availability mismatch BEFORE the fresh fetch (zero Catalog reads, zero registry calls)', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // Binding: the confirmed row carries a creator_circle source.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'creator_circle', circleId: 'circle-1', name: 'Circle 1' }],
      availability: 'available' as const,
    }])
    getProductSpaceCatalog.mockClear()
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    // Sealed SOURCES differ from the binding: a re-rendered page cannot
    // smuggle different sources through the bare-tuple check.
    await expect(uninstall(context, base, { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    // Sealed AVAILABILITY differs from the binding.
    await expect(uninstall(context, { ...base, availability: 'withdrawn' as const }, { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    // Both rejections happened BEFORE the fresh Catalog fetch.
    expect(getProductSpaceCatalog).not.toHaveBeenCalled()
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R28-a1: rejects a revision-drifted authoritative MISSING even with an exact retained tombstone (fresh rev-b vs binding rev-a) with zero registry calls', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // Binding rev-a holds the exact retained tombstone T.
    seedTrustedBinding('account-a', 'organization-a', [], {
      catalogRevision: 'revision-a',
      tombstones: [{
        catalogEntryId: base.catalogEntryId,
        artifactInstanceId: base.artifactInstanceId,
        versionId: base.versionId,
        version: base.version,
        sources: [{ kind: 'enterprise_import', name: null }],
        availability: 'withdrawn' as const,
        withdrawnAt: 1,
      }],
    })
    // The fresh Catalog advanced to rev-b AND no longer lists the entry:
    // the retained-tombstone cleanup path must prove the fresh revision too
    // — a stale page can never launder its uninstall through a tombstone.
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-b-missing',
      entries: [],
    }))
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    await expect(uninstall(context, { ...base, availability: 'withdrawn' as const }, { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R28-a1: same-revision authoritative missing with the exact retained tombstone still cleans up', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    seedTrustedBinding('account-a', 'organization-a', [], {
      catalogRevision: 'revision-a',
      tombstones: [{
        catalogEntryId: base.catalogEntryId,
        artifactInstanceId: base.artifactInstanceId,
        versionId: base.versionId,
        version: base.version,
        sources: [{ kind: 'enterprise_import', name: null }],
        availability: 'withdrawn' as const,
        withdrawnAt: 1,
      }],
    })
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-a',
      entries: [],
    }))
    await uninstall(context, { ...base, availability: 'withdrawn' as const }, { preserveData: true })
    expect(scopedRegistry.uninstall).toHaveBeenCalledWith({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: base.artifactInstanceId,
    }, { preserveData: true })
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R28-a1: a ProductSpace switch parked behind the fresh fetch stops the LIVE uninstall before the registry', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    let parkFetch: ((catalog: unknown) => void) | undefined
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => {
      return new Promise<any>(resolve => { parkFetch = resolve })
    })
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    const pending = uninstall(context, base, { preserveData: true })
    for (let i = 0; i < 50 && !parkFetch; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!parkFetch) throw new Error('fresh fetch never parked')
    // The committed ProductSpace switches to organization-b while the fetch
    // is parked — the unified post-await fence must refuse BEFORE the
    // registry side effect.
    setRuntimeActiveProductSpace('organization-b')
    parkFetch!({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-a',
      entries: [{
        kind: 'app',
        catalogEntryId: base.catalogEntryId,
        artifactInstanceId: base.artifactInstanceId,
        version: { versionId: base.versionId, version: base.version, checksum: 'b'.repeat(64) },
        name: 'ProductSpace App',
        description: '',
        availability: 'available',
        sources: [{ kind: 'enterprise_import' }],
        permissions: [],
      }],
    })
    await expect(pending).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    // Restore global runtime state.
    setRuntimeActiveProductSpace('organization-a')
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R28-a1: a sign-out parked behind the fresh fetch stops the retained-tombstone cleanup before the registry', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    seedTrustedBinding('account-a', 'organization-a', [], {
      catalogRevision: 'revision-a',
      tombstones: [{
        catalogEntryId: base.catalogEntryId,
        artifactInstanceId: base.artifactInstanceId,
        versionId: base.versionId,
        version: base.version,
        sources: [{ kind: 'enterprise_import', name: null }],
        availability: 'withdrawn' as const,
        withdrawnAt: 1,
      }],
    })
    let parkFetch: ((catalog: unknown) => void) | undefined
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => {
      return new Promise<any>(resolve => { parkFetch = resolve })
    })
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    const pending = uninstall(context, { ...base, availability: 'withdrawn' as const }, { preserveData: true })
    for (let i = 0; i < 50 && !parkFetch; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!parkFetch) throw new Error('fresh fetch never parked')
    // The account signs out while the fetch parks — the unified post-await
    // account fence must refuse the tombstone cleanup BEFORE the registry.
    signedInAccountId = null
    parkFetch!({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-a',
      entries: [],
    })
    await expect(pending).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    // Restore global state.
    signedInAccountId = 'account-a'
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R28-a1: schema-valid whitespace round trip — identical padded bytes across request/binding/fresh succeed, single-sided differences still drift', async () => {
    const paddedRevision = ' rev-a '
    const paddedName = ' Organization A '
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // Binding stores the EXACT padded bytes (shared nonBlankString schemas
    // keep the original value; trim is non-blank validation only).
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: 'catalog-entry-a',
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-a',
      version: '2.3.4',
      sources: [{ kind: 'enterprise_import', name: paddedName }],
      availability: 'available' as const,
    }], { catalogRevision: paddedRevision })
    const paddedIdentity = {
      ...productSpaceAppIdentity(),
      catalogRevision: paddedRevision,
      sources: [{ kind: 'enterprise_import', name: paddedName, circleId: null }],
    }
    const paddedCatalog = () => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: paddedRevision,
      entries: [{
        kind: 'app' as const,
        catalogEntryId: 'catalog-entry-a',
        artifactInstanceId: 'artifact-instance-a',
        version: { versionId: 'version-a', version: '2.3.4', checksum: 'b'.repeat(64) },
        name: 'ProductSpace App',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, name: paddedName }],
        permissions: [],
      }],
    })
    // Identical padded bytes on ALL three surfaces → uninstall succeeds.
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => paddedCatalog())
    await uninstall(context, paddedIdentity, { preserveData: true })
    expect(scopedRegistry.uninstall).toHaveBeenCalled()

    // A single-sided difference (the fresh name loses the padding) is
    // NOT trimmed into agreement — it drifts with zero registry calls.
    scopedRegistry.uninstall.mockClear()
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    const unpadded = paddedCatalog()
    unpadded.entries = [{
      ...unpadded.entries[0]!,
      sources: [{ kind: 'enterprise_import' as const, name: 'Organization A' }],
    }]
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => unpadded)
    await expect(uninstall(context, paddedIdentity, { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('R29: a revoke queued behind the uninstall mutex can never flip the completed destructive uninstall into NOT_AUTHORIZED', async () => {
    const base = productSpaceAppIdentity()
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    // 1. Legal live uninstall: trusted binding + fresh Catalog at the SAME
    // revision.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    // A live local_app execution record that the uninstall must unregister
    // (subject artifact instance == the uninstall's scope catalogAppId, the
    // production unregister matching rule).
    registerProductSpaceExecution({
      scope: ProductSpaceExecutionScopeSchema.parse({
        contractVersion: PRODUCT_SPACE_CONTRACT_VERSION,
        executionId: 'local-app:organization-a:r29-exec',
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        workspaceId: 'ws-window-a',
        subject: {
          kind: 'artifact_instance',
          artifactType: 'app',
          artifactInstanceId: base.artifactInstanceId,
          versionId: base.versionId,
          version: base.version,
        },
      }),
      kind: 'local_app',
      name: 'R29 Uninstall Exec',
      ref: 'local-app:organization-a:r29-exec',
      generation: 0,
      isActive: async () => true,
      stop: async () => 'stopped' as const,
    })

    // 2. Defer the registry uninstall and observe the RPC INSIDE the atomic
    // region: the mock resolves the `entered` Deferred synchronously at the
    // top of the side effect, so awaiting it is event-driven — no polling,
    // no timeout, no timing window.
    let releaseRegistry!: () => void
    const registryGate = new Promise<void>(resolve => { releaseRegistry = resolve })
    let registrySettled = false
    let signalRegistryEntered!: () => void
    const registryEntered = new Promise<void>(resolve => { signalRegistryEntered = resolve })
    scopedRegistry.uninstall.mockImplementationOnce(async () => {
      signalRegistryEntered()
      await registryGate
      registrySettled = true
    })
    const pending = uninstall(context, base, { preserveData: true })
    await registryEntered

    // Typed switch-mutex evidence through the test-only internal seam
    // (relative source import — the internal module is NOT re-exported
    // through product-space-executions or any package exports map). The
    // identical pending/event state proves the same module instance backs
    // the production handler. Exactly the uninstall's runtime-public-mutex
    // task is RUNNING.
    expect(switchLockEventLog().map(event => event.token)).toEqual([
      { phase: 'runtime-public-mutex' },
    ])
    expect(pendingSwitchLockTasks()).toBe(1)

    // 3. Queue the production revoke SYNCHRONOUSLY: withSwitchLock registers
    // its typed token before its first await, so the FIFO order behind the
    // running uninstall is observable immediately — no timers, no sleep, no
    // Date.now window.
    let revokeSettled = false
    const revoke = revokeRuntimeProductSpaceFence().then(() => { revokeSettled = true })
    expect(switchLockEventLog().map(event => event.token)).toEqual([
      { phase: 'runtime-public-mutex' },
      { phase: 'runtime-revoke-fence' },
    ])
    expect(pendingSwitchLockTasks()).toBe(2)
    // Both fence-clearing operations of the revoke can only run once it
    // acquires the mutex — it cannot have settled, and the atomic region
    // (execution unregister runs only with the registry) is not interleaved.
    expect(revokeSettled).toBe(false)
    expect(
      listRegisteredProductSpaceExecutions().filter(execution => execution.kind === 'local_app'),
    ).toHaveLength(1)

    // 4. Release the registry: the uninstall RPC RESOLVES TRUTHFULLY — the
    // queued revoke running afterwards can never retroactively turn the
    // completed destructive operation into NOT_AUTHORIZED.
    releaseRegistry!()
    await pending
    expect(registrySettled).toBe(true)
    expect(scopedRegistry.uninstall).toHaveBeenCalledWith({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: base.artifactInstanceId,
    }, { preserveData: true })
    // The queued revoke then completes normally and clears the fence; the
    // final fence/registry/execution state is consistent and the switch
    // mutex drains completely (typed FIFO order fully settled).
    await revoke
    expect(revokeSettled).toBe(true)
    expect(pendingSwitchLockTasks()).toBe(0)
    expect(switchLockEventLog()).toEqual([])
    expect(getRuntimeActiveProductSpace()).toBeNull()
    expect(
      listRegisteredProductSpaceExecutions().filter(execution => execution.kind === 'local_app'),
    ).toHaveLength(0)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('rejects uninstalling an OLD republished tuple when the same entry/artifact is re-released at a NEW version (live drift, not tombstone)', async () => {
    // Sequence: the old version WAS withdrawn and retained as a trusted
    // tombstone; the same stable entry + artifact is then REPUBLISHED at a
    // new version. Uninstalling the OLD tuple must fail closed as live
    // drift — registry and files are untouched.
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: 'catalog-entry-a',
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-old',
      version: '2.0.0',
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }], { catalogRevision: 'revision-republished' })
    seedTombstoneBinding(
      'account-a', 'organization-a',
      'catalog-entry-a', 'artifact-instance-a', 'version-old', '2.0.0',
    )
    getProductSpaceCatalog.mockImplementation(async () => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-republished',
      entries: [{
        kind: 'app' as const,
        catalogEntryId: 'catalog-entry-a',
        artifactInstanceId: 'artifact-instance-a',
        version: {
          versionId: 'version-new',
          version: '3.0.0',
          checksum: 'b'.repeat(64),
        },
        name: 'ProductSpace App',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, enterpriseId: 'enterprise-a' }],
        permissions: [],
      }],
    }))
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    await expect(uninstall(context, {
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: 'catalog-entry-a',
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-old',
      version: '2.0.0',
      catalogRevision: 'revision-republished',
      sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
      availability: 'available' as const,
    }, { preserveData: true })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('covers each per-field drift (artifactInstanceId / versionId / version) as fail-closed live drift, and separates missing-entry routes', async () => {
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    const base = productSpaceAppIdentity()
    const currentEntry = (): Record<string, unknown> => ({
      kind: 'app',
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      version: { versionId: base.versionId, version: base.version, checksum: 'b'.repeat(64) },
      name: 'ProductSpace App',
      description: '',
      availability: 'available',
      sources: [{ kind: 'enterprise_import', name: 'Organization A' }],
      permissions: [],
    })

    // Trusted binding: base entry available (live path must match it).
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])

    // Per-field drift: artifact / versionId / version each → DRIFT.
    for (const drifted of [
      { artifactInstanceId: 'artifact-drifted' },
      { version: { versionId: 'version-drifted', version: '8.8.8' } },
      { version: { versionId: base.versionId, version: '9.9.9' } },
    ] as const) {
      getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
        contractVersion: 1,
        productSpaceId: 'organization-a',
        catalogRevision: 'revision-a',
        entries: [{ ...currentEntry(), ...drifted }],
      }))
      const callsBefore = scopedRegistry.uninstall.mock.calls.length
      await expect(uninstall(context, base, { preserveData: true }))
        .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
      expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    }

    // Genuinely missing entry + trusted retained tombstone → cleanup. The
    // request is the withdrawn view's sealed identity: it carries the
    // tombstone's sources and the raw 'withdrawn' availability.
    seedTrustedBinding('account-a', 'organization-a', [], {
      tombstones: [{
        catalogEntryId: base.catalogEntryId,
        artifactInstanceId: base.artifactInstanceId,
        versionId: base.versionId,
        version: base.version,
        sources: [{ kind: 'enterprise_import', name: null }],
        availability: 'withdrawn' as const,
        withdrawnAt: 1,
      }],
    })
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-a',
      entries: [],
    }))
    await uninstall(context, { ...base, availability: 'withdrawn' as const }, { preserveData: true })
    expect(scopedRegistry.uninstall).toHaveBeenCalled()

    // Missing entry WITHOUT tombstone evidence → fail closed.
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-a',
      entries: [],
    }))
    await expect(uninstall(context, {
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-a',
      catalogEntryId: 'catalog-entry-never',
      artifactInstanceId: 'artifact-never',
      versionId: 'version-never',
      version: '1.0.0',
      sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
      availability: 'available' as const,
    }, { preserveData: true })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)

    // Inactive space → NOT_AUTHORIZED (never a tombstone fallback).
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    listProductSpaces.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      defaultProductSpaceId: 'organization-a',
      productSpaces: [{
        id: 'organization-a',
        kind: 'enterprise' as const,
        enterpriseId: 'enterprise-a',
        name: 'Organization A',
        role: 'manager' as const,
        accessMode: 'billing_restricted' as const,
      }],
    }))
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      versionId: base.versionId,
      version: base.version,
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    await expect(uninstall(context, base, { preserveData: true }))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    listProductSpaces.mockImplementation(async (): Promise<any> => ({
      contractVersion: 1,
      defaultProductSpaceId: 'organization-a',
      productSpaces: [{
        id: 'organization-a',
        kind: 'enterprise' as const,
        enterpriseId: 'enterprise-a',
        name: 'Organization A',
        role: 'manager' as const,
        accessMode: 'active' as const,
      }],
    }))
  })

  it('fails tombstone-evidenced cleanup closed when the fresh fetch itself fails (401)', async () => {
    // Even WITH retained-tombstone evidence, a fresh-fetch auth failure must
    // stay fail-closed: 401/403/network are never tombstone fallbacks.
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: 'catalog-entry-w',
      artifactInstanceId: 'artifact-w',
      versionId: 'version-w',
      version: '2.0.0',
      sources: [{ kind: 'enterprise_import' }],
      availability: 'available' as const,
    }])
    seedTombstoneBinding()
    getProductSpaceCatalog.mockImplementation(async () => {
      throw Object.assign(new Error('session expired'), { errorCode: 'UNAUTHORIZED', status: 401 })
    })
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    await expect(uninstall(context, {
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: 'catalog-entry-w',
      artifactInstanceId: 'artifact-w',
      versionId: 'version-w',
      version: '2.0.0',
      catalogRevision: 'revision-a',
      sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
      availability: 'available' as const,
    }, { preserveData: true })).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED', status: 401 })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('rejects fabricated withdrawn uninstall identities before the registry can run', async () => {
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: 'catalog-entry-a',
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-a',
      version: '2.3.4',
      sources: [{ kind: 'enterprise_import', name: 'Organization A' }],
      availability: 'available' as const,
    }])
    // Fabricated SQL/XSS-shaped catalogEntryId on a REAL artifact instance —
    // the FULL tuple check rejects it before any registry call.
    await expect(uninstall(context, {
      ...productSpaceAppIdentity(),
      catalogEntryId: "x'; DROP TABLE catalog --" as never,
    }, { preserveData: false })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(uninstall(context, {
      ...productSpaceAppIdentity(),
      catalogEntryId: '<img src=x onerror=alert(1)>' as never,
    }, { preserveData: false })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    // Forged versionId on a REAL catalog+artifact binding: the entry EXISTS
    // (live drift) → CATALOG_IDENTITY_DRIFT fail-closed, NEVER a tombstone
    // fallback.
    await expect(uninstall(context, {
      ...productSpaceAppIdentity(),
      versionId: 'forged-version' as never,
    }, { preserveData: false })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })

    // LIVE uninstall: the fresh Catalog matches the FULL identity exactly —
    // success WITHOUT any tombstone evidence. The Main-owned canonical
    // source/availability binding matches the live row.
    seedAuthorityBinding()
    seedTrustedBinding('account-a', 'organization-a', [{
      catalogEntryId: 'catalog-entry-a',
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-a',
      version: '2.3.4',
      sources: [{ kind: 'enterprise_import' }],
    }])
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    await uninstall(context, productSpaceAppIdentity(), { preserveData: true })
    expect(getProductSpaceCatalog).toHaveBeenCalled()
    expect(scopedRegistry.uninstall).toHaveBeenCalledWith({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: 'artifact-instance-a',
    }, { preserveData: true })

    // STALE VERSION drift: the live Catalog holds a different version for
    // the entry → fail closed even with the OLD tuple present in the union.
    getProductSpaceCatalog.mockImplementation(async () => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'revision-upgraded',
      entries: [{
        kind: 'app' as const,
        catalogEntryId: 'catalog-entry-a',
        artifactInstanceId: 'artifact-instance-a',
        version: {
          versionId: 'version-upgraded',
          version: '3.0.0',
          checksum: 'b'.repeat(64),
        },
        name: 'ProductSpace App',
        description: '',
        availability: 'available' as const,
        sources: [{ kind: 'enterprise_import' as const, enterpriseId: 'enterprise-a' }],
        permissions: [],
      }],
    }))
    await expect(uninstall(context, productSpaceAppIdentity(), { preserveData: true }))
      .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    // NOTE: earlier sub-cases in this test already produced successful
    // registry uninstalls; assert the DELTA instead of a global count.
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)

    // FRESH FETCH FAILURE (auth/network/schema): fail closed even when the
    // identity HAS retained-tombstone evidence (covered in its own test
    // below — here the fabricated/stale variants stay fail-closed too).
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    await expect(uninstall(context, {
      ...productSpaceAppIdentity(),
      version: '999.0.0' as never,
    }, { preserveData: false })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    // Unknown artifact instance: the destructive path (preserveData=false)
    // must be refused before the registry can delete any app directory.
    await expect(uninstall(context, {
      ...productSpaceAppIdentity(),
      artifactInstanceId: '../../another-installed-app' as never,
    }, { preserveData: false })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    // A REAL full-tuple authority binding for another space stays invalid here.
    seedAuthorityBinding('account-a', 'organization-b', 'catalog-entry-b', 'artifact-b', 'version-b', '1.0.0')
    await expect(uninstall(context, {
      ...productSpaceAppIdentity(),
      productSpaceId: 'organization-b' as never,
      catalogEntryId: 'catalog-entry-b' as never,
      artifactInstanceId: 'artifact-b' as never,
      versionId: 'version-b' as never,
      version: '1.0.0' as never,
    }, { preserveData: false })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    // R24: the fresh-Catalog revalidation now runs for every uninstall —
    // what matters is that the destructive registry path never runs for the
    // cross-space/fabricated variants above.
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
  })

  it('validates a full 10,000-identity withdrawn batch against a 20,000-tuple authority in one pass', async () => {
    // Product upper bound: 10,000 request identities against an authority
    // holding 10,000 live + 10,000 tombstone tuples. A per-item authority
    // scan would be ~200,000,000 comparisons on the Main thread; the
    // one-shot tuple set keeps the whole batch linear.
    seedAuthorityTuples('organization-a', 20_000)
    const identities = Array.from({ length: 10_000 }, (_, index) => ({
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: `authority-entry-${index}`,
      artifactInstanceId: `authority-artifact-${index}`,
      versionId: `authority-version-${index}`,
      version: '1.0.0',
      catalogRevision: 'revision-a',
      sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
      availability: 'withdrawn' as const,
    }))
    const set = authorityTuplesByScope.get(authorityScopeKey('account-a', 'organization-a'))!
    for (const identity of identities) {
      set.add(JSON.stringify([
        identity.catalogEntryId,
        identity.artifactInstanceId,
        identity.versionId,
        identity.version,
      ]))
    }
    scopedStatuses.mockImplementation(async (scopes: CatalogLocalAppScope[]) =>
      scopes.map(item => ({
        appId: item.catalogAppId,
        scope: item,
        status: 'not_installed' as const,
      })))

    const getWithdrawnStates = handlers.get(
      RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_WITHDRAWN_INSTALL_STATES,
    )!
    const startedAt = Date.now()
    const states = await getWithdrawnStates(context, identities) as unknown[]
    const elapsedMs = Date.now() - startedAt

    expect(states).toHaveLength(10_000)
    expect(elapsedMs).toBeLessThan(5_000)
    expect(getProductSpaceCatalog).not.toHaveBeenCalled()
  })

  it('re-fails the withdrawn state response closed when the account or space changes during the registry await', async () => {
    let releaseStatuses!: (statuses: LocalAppRuntimeStatus[]) => void
    scopedStatuses.mockImplementationOnce(async (scopes: CatalogLocalAppScope[]) => {
      void scopes
      return await new Promise<LocalAppRuntimeStatus[]>(resolve => {
        releaseStatuses = resolve
      })
    })
    const statusRow: LocalAppRuntimeStatus = {
      appId: 'artifact-instance-a',
      scope: {
        kind: 'catalog',
        accountId: 'account-a',
        organizationId: 'organization-a',
        catalogAppId: 'artifact-instance-a',
      },
      status: 'installed',
      currentVersion: '2.3.4',
    }
    const getWithdrawnStates = handlers.get(
      RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_WITHDRAWN_INSTALL_STATES,
    )!

    // Space switch while the registry read is pending.
    const pendingSpaceSwitch = getWithdrawnStates(context, [productSpaceAppIdentity()])
    for (let i = 0; i < 300 && !releaseStatuses; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(releaseStatuses).toBeTruthy()
    setRuntimeActiveProductSpace('organization-b')
    releaseStatuses!([statusRow])
    await expect(pendingSpaceSwitch).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    // Sign-out while the registry read is pending.
    setRuntimeActiveProductSpace('organization-a')
    let releaseSecond!: (statuses: LocalAppRuntimeStatus[]) => void
    scopedStatuses.mockImplementationOnce(async (scopes: CatalogLocalAppScope[]) => {
      void scopes
      return await new Promise<LocalAppRuntimeStatus[]>(resolve => {
        releaseSecond = resolve
      })
    })
    const pendingSignOut = getWithdrawnStates(context, [productSpaceAppIdentity()])
    for (let i = 0; i < 300 && !releaseSecond; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(releaseSecond).toBeTruthy()
    signedInAccountId = null
    releaseSecond!([statusRow])
    await expect(pendingSignOut).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    // No stale projection escaped either window.
    expect(scopedStatuses).toHaveBeenCalledTimes(2)
    signedInAccountId = 'account-a'
  })

  it('fails withdrawn uninstall closed when signed out or outside the active ProductSpace', async () => {
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    signedInAccountId = null
    await expect(uninstall(context, productSpaceAppIdentity(), { preserveData: true }))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedRegistry.uninstall).not.toHaveBeenCalled()

    signedInAccountId = 'account-a'
    setRuntimeActiveProductSpace('organization-b')
    await expect(uninstall(context, productSpaceAppIdentity(), { preserveData: true }))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedRegistry.uninstall).not.toHaveBeenCalled()
  })

  it('validates a full 10,000-identity batch against a 10,000-entry Catalog in one pass', async () => {
    try {
      const count = 10_000
      const identities = Array.from({ length: count }, (_, index) => ({
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        catalogEntryId: `catalog-entry-${index}`,
        artifactInstanceId: `artifact-instance-${index}`,
        versionId: `version-${index}`,
        version: '2.3.4',
        catalogRevision: 'revision-a',
        sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
        availability: 'available' as const,
      }))
      getProductSpaceCatalog.mockImplementation(async () => ({
        contractVersion: 1,
        productSpaceId: 'organization-a',
        catalogRevision: 'revision-a',
        entries: identities.map(identity => ({
          kind: 'app' as const,
          catalogEntryId: identity.catalogEntryId,
          artifactInstanceId: identity.artifactInstanceId,
          version: {
            versionId: identity.versionId,
            version: identity.version,
            checksum: 'b'.repeat(64),
          },
          name: `App ${identity.catalogEntryId}`,
          description: '',
          availability: 'available' as const,
          sources: [{ kind: 'enterprise_import' as const, enterpriseId: 'enterprise-a' }],
          permissions: [],
        })),
      }))
      scopedStatuses.mockImplementation(async (scopes: CatalogLocalAppScope[]) =>
        scopes.map(item => ({
          appId: item.catalogAppId,
          scope: item,
          status: 'not_installed' as const,
        })))

      const getStates = handlers.get(
        RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_INSTALL_STATES,
      )!
      // With the old per-request entries.find this was O(catalog × request)
      // (~100,000,000 comparisons on the Main thread); the indexed check
      // keeps the full-size batch linear and fast.
      const startedAt = Date.now()
      const states = await getStates(context, identities) as Array<{ app: { catalogEntryId: string } }>
      const elapsedMs = Date.now() - startedAt

      expect(states).toHaveLength(count)
      expect(states[count - 1]!.app.catalogEntryId).toBe('catalog-entry-9999')
      expect(elapsedMs).toBeLessThan(5_000)
      expect(getProductSpaceCatalog).toHaveBeenCalledTimes(1)
    } finally {
      getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    }
  })

  it('fails the full-size batch closed when one identity drifted', async () => {
    try {
      const count = 1_000
      const identities = Array.from({ length: count }, (_, index) => ({
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        catalogEntryId: `catalog-entry-${index}`,
        artifactInstanceId: `artifact-instance-${index}`,
        versionId: `version-${index}`,
        version: '2.3.4',
        catalogRevision: 'revision-a',
        sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
        availability: 'available' as const,
      }))
      getProductSpaceCatalog.mockImplementation(async () => ({
        contractVersion: 1,
        productSpaceId: 'organization-a',
        catalogRevision: 'revision-a',
        entries: identities.map(identity => ({
          kind: 'app' as const,
          catalogEntryId: identity.catalogEntryId,
          artifactInstanceId: identity.artifactInstanceId,
          version: {
            versionId: identity.versionId,
            version: identity.version,
            checksum: 'b'.repeat(64),
          },
          name: `App ${identity.catalogEntryId}`,
          description: '',
          availability: 'available' as const,
          sources: [{ kind: 'enterprise_import' as const, enterpriseId: 'enterprise-a' }],
          permissions: [],
        })),
      }))

      const getStates = handlers.get(
        RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_INSTALL_STATES,
      )!
      await expect(getStates(context, [
        ...identities.slice(0, 999),
        { ...identities[999]!, versionId: 'drifted-version' },
      ])).rejects.toMatchObject({ code: 'RELEASE_CHANGED' })
    } finally {
      getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    }
  })

  it('registers a restart as a fresh running execution so switching stays blocked', async () => {
    setRuntimeActiveProductSpace('organization-a')
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'running' as const,
      currentVersion: 'v1.2.3',
    }))
    const restart = handlers.get(RPC_CHANNELS.localApps.RESTART)!
    await restart(context, scope())

    const registered = listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )
    expect(registered).toHaveLength(1)
    expect(registered[0]!.scope.productSpaceId as string).toBe('organization-a')
    expect(registered[0]!.scope.executionId as string).toContain('organization-a')
    expect(await registered[0]!.isActive()).toBe(true)
  })

  it('binds each start to the calling window workspace and refuses workspace-less starts', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    await start(context, scope())
    windowWorkspaceId = 'ws-window-b'
    await start(context, scope())

    const registered = listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )
    expect(registered).toHaveLength(2)
    expect(registered.map(execution => execution.scope.workspaceId as string).sort())
      .toEqual(['ws-window-a', 'ws-window-b'])
    expect(new Set(registered.map(execution => execution.scope.executionId as string)).size).toBe(2)

    // A caller without a Workspace context can never be attributed to an
    // immutable scope, so the start is refused instead of placeholder-bound.
    context.webContentsId = null
    await expect(start(context, scope()))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )).toHaveLength(2)
    context.webContentsId = 1
  })

  it('isolates the same app across workspaces and ProductSpaces', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // Workspace A inside the active space.
    await start(context, scope())
    // Workspace B inside the same active space.
    windowWorkspaceId = 'ws-window-b'
    await start(context, scope())

    let registered = listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )
    expect(registered).toHaveLength(2)
    for (const execution of registered) {
      expect(execution.scope.accountId as string).toBe('account-a')
      expect(execution.scope.productSpaceId as string).toBe('organization-a')
    }

    // A second ProductSpace fence: the same catalog scope from the first
    // space is refused — cross-space starts are impossible.
    setRuntimeActiveProductSpace('organization-b')
    await expect(start(context, scope()))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    registered = listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )
    expect(registered).toHaveLength(2)
    expect(registered.every(execution => execution.scope.productSpaceId === 'organization-a')).toBe(true)
  })

  it('a Local App start keeps the switch lock free while resolving the account and loses to a concurrent account replacement', async () => {
    setRuntimeActiveProductSpace('organization-a')
    // Gate the trusted-account provider: the start must resolve the account
    // BEFORE acquiring the switch lock (global lock order).
    let releaseProvider!: () => void
    const gatedProvider = new Promise<string | null>(resolve => { releaseProvider = () => resolve('account-a') })
    setTrustedProductSpaceAccountProvider(() => gatedProvider)
    // Gate the runtime boot so the start sits inside the switch lock.
    let releaseBoot!: () => void
    const gatedBoot = new Promise<{ appId: string; scope: CatalogLocalAppScope; version: string; url: string; port: number }>(resolve => {
      releaseBoot = () => resolve({
        appId: scope().catalogAppId,
        scope: scope(),
        version: '1.2.3',
        url: 'http://127.0.0.1:9876',
        port: 9876,
      })
    })
    scopedStart.mockImplementationOnce(() => gatedBoot)

    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const starting = start(context, scope())
    for (let i = 0; i < 300 && !scopedStart.mock.calls.length; i += 1) {
      // Wait until the account was resolved and the critical section began.
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // While the start resolves the account (and boots the runtime under the
    // switch lock), the account replacement's revoke path must be able to
    // take the switch lock — the start must NOT hold it across Admin-lock
    // work. Bounded assertion.
    releaseProvider()
    const lockAcquiredDuringBoot = await Promise.race([
      runUnderSwitchMutex(async () => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ])
    expect(lockAcquiredDuringBoot).toBe(true)

    // The replacement wins concurrently: mirror flips to account B and the
    // fence account is rebound — the in-flight start must fail closed.
    setSyncTrustedProductSpaceAccountId('account-b')
    releaseBoot()
    await expect(starting).rejects.toMatchObject({ code: 'SWITCH_IN_PROGRESS' })
    // The booted runtime was stopped again and nothing was registered under
    // the replaced account.
    expect(scopedRegistry.stop).toHaveBeenCalled()
    expect(listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )).toHaveLength(0)
  })

  it('a workspace stop only unregisters the calling workspace execution', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const stop = handlers.get(RPC_CHANNELS.localApps.STOP)!
    await start(context, scope())
    windowWorkspaceId = 'ws-window-b'
    await start(context, scope())

    const byWorkspace = () => Object.fromEntries(
      listRegisteredProductSpaceExecutions()
        .filter(execution => execution.kind === 'local_app')
        .map(execution => [execution.scope.workspaceId as string, execution]),
    )

    // ws-a stops the app: only ws-a's execution record is unregistered, and
    // ws-b's execution stays registered for its own lifecycle. (The
    // underlying POO-12 runtime process is still one per installation —
    // documented residual — so ws-b's liveness probe reads the shared
    // runtime, but its registration and lifecycle ownership are isolated.)
    windowWorkspaceId = 'ws-window-a'
    workspaceExists = true
    context.webContentsId = 1
    await stop(context, scope())
    let registered = byWorkspace()
    expect(registered['ws-window-a']).toBeUndefined()
    expect(registered['ws-window-b']).toBeDefined()

    // ws-b's own stop cleans up its record too.
    windowWorkspaceId = 'ws-window-b'
    context.webContentsId = 2
    await stop(context, scope())
    registered = byWorkspace()
    expect(registered['ws-window-b']).toBeUndefined()
    expect(listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )).toHaveLength(0)
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

  it('resolves no remote URL for a scope outside the committed active space', async () => {
    // The renderer presents a stale scope from a space it switched away
    // from: the Main active-space gate must reject it before any
    // authorization entry is read.
    setRuntimeActiveProductSpace('organization-b')
    const resolveRemoteUrl = handlers.get(
      RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
    )!
    await expect(resolveRemoteUrl(context, scope()))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
  })

  it('resolves no remote URL while the offline read-only view is active', async () => {
    setRuntimeOfflineReadOnly(true)
    try {
      const resolveRemoteUrl = handlers.get(
        RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
      )!
      await expect(resolveRemoteUrl(context, scope()))
        .rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    } finally {
      setRuntimeOfflineReadOnly(false)
    }
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

describe('local app production status projection (R34-3)', () => {
  const handlers = new Map<string, Handler>()
  const context = {
    clientId: 'renderer',
    webContentsId: 1 as number | null,
    signal: new AbortController().signal,
  }
  let windowWorkspaceId: string | null = 'ws-window-a'

  beforeEach(async () => {
    signedInAccountId = 'account-a'
    accessMode = 'online'
    appAccessDenied = false
    catalog = createCatalog(1)
    authorityTuplesByScope.clear()
    seedAuthorityBinding()
    windowWorkspaceId = 'ws-window-a'
    workspaceExists = true
    context.webContentsId = 1
    handlers.clear()
    withdrawnTombstonesByScope.clear()
    trustedRecordByScope.clear()
    getProductSpaceCatalog.mockClear()
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
    listProductSpaces.mockClear()
    scopedStartExact.mockClear()
    scopedStartExact.mockImplementation(defaultStartExact)
    scopedStopExact.mockClear()
    scopedStopExact.mockImplementation(async (
      scope: CatalogLocalAppScope,
      expectedRuntimeGeneration: number,
    ): Promise<LocalAppRuntimeStatus> => {
      if (expectedRuntimeGeneration !== 41) {
        throw Object.assign(new Error('stale'), { code: 'STALE_RUNTIME_GENERATION' })
      }
      return {
        appId: scope.catalogAppId,
        scope,
        status: 'stopped' as const,
        currentVersion: '2.3.4',
      }
    })
    runtimeCoordinator.ensureGateway.mockClear()
    runtimeCoordinator.signCapability.mockClear()
    runtimeCoordinator.registerActiveRuntime.mockClear()
    activeRuntimesByKey.clear()
    activeRuntimesByExecution.clear()
    recordedRollbackStopFailures.clear()
    runtimeCoordinator.revokeSignedCapability.mockClear()
    runtimeCoordinator.teardownRuntime.mockClear()
    runtimeCoordinator.consumeTeardownOutcome.mockClear()
    const { resetAppRuntimeCenterForTests } = await import(
      '@polo-ai/server-core/runtime'
    )
    resetAppRuntimeCenterForTests()
    for (const handlerMock of [
      getCachedAppCatalog,
      getAppCatalogAccessMode,
      assertAppAuthorized,
      scopedStart,
      scopedRegistry.stop,
      scopedRuntimeStatus,
    ]) {
      handlerMock.mockClear()
    }
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'not_installed',
    }))
    scopedRegistry.stop.mockImplementation(async (item: CatalogLocalAppScope) => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'stopped' as const,
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
    registerLocalAppHandlers(server, {
      windowManager: {
        getWorkspaceForWindow: (webContentsId: number) => (
          context.webContentsId === webContentsId ? windowWorkspaceId : null
        ),
      },
    } as never)
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    setSyncTrustedProductSpaceAccountId(signedInAccountId)
    if (signedInAccountId) {
      setRuntimeActiveProductSpaceAccount(signedInAccountId)
    }
    setRuntimeOfflineReadOnly(false)
    setRuntimeActiveProductSpace(signedInAccountId ? 'organization-a' : null)
    resetExecutionRegistry()
  })

  it('a starting Local App stays registered and active and projects preparing until it runs', async () => {
    setRuntimeActiveProductSpace('organization-a')
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'starting' as const,
    }))
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    await start(context, scope())

    const registered = listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )
    expect(registered).toHaveLength(1)
    // R34-3: 'starting' is a genuine non-terminal startup state — the
    // execution stays active and projects 'preparing' for LIST/PREPARE.
    expect(await registered[0]!.isActive()).toBe(true)
    expect(registered[0]!.getStatus?.()).toBe('preparing')

    // Once the runtime reaches 'running' the projection follows truthfully.
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'running' as const,
    }))
    expect(await registered[0]!.isActive()).toBe(true)
    expect(registered[0]!.getStatus?.()).toBe('running')
  })

  it('a dispatched Local App stop projects stopping until the runtime reaches a terminal state', async () => {
    setRuntimeActiveProductSpace('organization-a')
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'running' as const,
    }))
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    await start(context, scope())

    const registered = listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )
    expect(registered).toHaveLength(1)
    const execution = registered[0]!

    // The stop is dispatched while the runtime still reports 'running'.
    const stopPromise = execution.stop!()
    expect(execution.getStatus?.()).toBe('stopping')
    expect(await execution.isActive()).toBe(true)

    // The runtime reaches its terminal state: the drain can confirm.
    scopedRuntimeStatus.mockImplementation(async item => ({
      appId: item.catalogAppId,
      scope: item,
      status: 'stopped' as const,
    }))
    expect(await stopPromise).toBe('stopped')
    expect(await execution.isActive()).toBe(false)
  })

  it('POO-54: starts a ProductSpace runtime through exact-version generation with capability binding and projection', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const result = await start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    expect(result).toMatchObject({
      appId: 'artifact-instance-a',
      version: '2.3.4',
      runtimeKind: 'python',
      runtimeGeneration: 41,
      scopeGeneration: 7,
      platformApi: { status: 'available' },
    })
    expect(typeof (result as { executionId: string }).executionId).toBe('string')
    // Fresh-Catalog re-verification ran before any runtime call.
    expect(getProductSpaceCatalog).toHaveBeenCalledTimes(1)
    // The exact-version start used the full runtime scope and version.
    expect(scopedStartExact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'catalog',
        accountId: 'account-a',
        organizationId: 'organization-a',
        catalogAppId: 'artifact-instance-a',
      }),
      '2.3.4',
      expect.objectContaining({ processEnvironment: expect.any(Function) }),
    )
    // The capability signed with the trusted caller workspace and the real
    // ProductSpace identity — never renderer-owned billing fields.
    expect(runtimeCoordinator.signCapability).toHaveBeenCalledWith(expect.objectContaining({
      identity: {
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        artifactInstanceId: 'artifact-instance-a',
        versionId: 'version-a',
        version: '2.3.4',
      },
      workspaceId: 'ws-window-a',
      runtimeKind: 'python',
      runtimeGeneration: 41,
      scopeGeneration: 7,
    }))
    expect(runtimeCoordinator.registerActiveRuntime).toHaveBeenCalledTimes(1)
    // The result never exposes the capability token or the gateway URL.
    expect(JSON.stringify(result)).not.toContain('capability-token')
    expect(JSON.stringify(result)).not.toContain('127.0.0.1')
    // The active projection is published through the single center.
    const { getAppRuntimeCenter } = await import('@polo-ai/server-core/runtime')
    const projection = getAppRuntimeCenter().findByIdentity({
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-a',
    })
    expect(projection).toMatchObject({
      workspaceId: 'ws-window-a',
      runtimeGeneration: 41,
      scopeGeneration: 7,
      runtimeKind: 'python',
      status: 'running',
    })
    // The execution registry holds the FULL identity subject.
    const registered = listRegisteredProductSpaceExecutions().find(
      execution => execution.kind === 'local_app',
    )
    expect(registered?.scope.subject).toMatchObject({
      artifactInstanceId: 'artifact-instance-a',
      versionId: 'version-a',
      version: '2.3.4',
    })
  })

  it('POO-54: fails START closed on missing entry, drift, and unavailable availability', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // Missing entry: an unknown artifact instance never resolves.
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: { ...productSpaceAppIdentity(), artifactInstanceId: 'unknown-instance' },
    })).rejects.toMatchObject({ code: 'CATALOG_ENTRY_MISSING' })
    // Revision drift: the fresh Catalog moved on.
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      ...(await defaultProductSpaceCatalog()),
      catalogRevision: 'revision-next',
    }))
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    // Unavailable: the raw availability is not launchable.
    const blockedCatalog = await defaultProductSpaceCatalog()
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      ...blockedCatalog,
      entries: [{
        ...blockedCatalog.entries[0]!,
        availability: 'blocked',
      }],
    }))
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' })
    expect(scopedStartExact).not.toHaveBeenCalled()
    expect(runtimeCoordinator.signCapability).not.toHaveBeenCalled()
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('POO-54: a second start of the same runtime identity replaces the first generation', async () => {
    const existing = {
      identityKey: 'k',
      identity: {
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        artifactInstanceId: 'artifact-instance-a',
        versionId: 'version-a',
        version: '2.3.4',
      },
      executionId: 'exec-old',
      runtimeGeneration: 41,
      scopeGeneration: 2,
      workspaceId: 'ws-window-a',
      runtimeKind: 'python' as const,
      capabilityGeneration: 3,
      controller: new AbortController(),
    }
    activeRuntimesByKey.set(runtimeIdentityKey(existing.identity), existing)
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    await start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    // Workspace-A's old generation is revoked/stopped before B starts.
    expect(runtimeCoordinator.teardownRuntime).toHaveBeenCalledWith(
      existing,
      'cancelled',
      expect.any(Function),
    )
    expect(scopedStopExact).toHaveBeenCalledWith(
      expect.objectContaining({ catalogAppId: 'artifact-instance-a' }),
      41,
    )
  })

  it('POO-54: two concurrent STARTs of one runtime identity serialize inside the switch mutex and the loser tears the winner down', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // Park the FIRST startExact call: START-A holds the switch mutex inside
    // its critical section while START-B queues behind it.
    let releaseFirst!: () => void
    const firstParked = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    scopedStartExact.mockImplementationOnce(async (...args: Parameters<typeof defaultStartExact>) => {
      await firstParked
      return defaultStartExact(...args)
    })
    const request = {
      kind: 'product_space_runtime_start' as const,
      app: productSpaceAppIdentity(),
    }
    const first = start(context, request)
    for (let i = 0; i < 100 && scopedStartExact.mock.calls.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(scopedStartExact.mock.calls.length).toBe(1)
    const second = start(context, request)
    // START-B must still be waiting on the switch mutex, not bypassing the
    // winner's cleanup via a direct manager stop.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(scopedStartExact.mock.calls.length).toBe(1)
    releaseFirst()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ version: '2.3.4' })
    expect(secondResult).toMatchObject({ version: '2.3.4' })
    // The replacement teardown ran exactly once, INSIDE the mutex, between
    // the two exact-version starts — capability/Run/execution/projection
    // cleanup of generation A can never be skipped.
    expect(runtimeCoordinator.teardownRuntime).toHaveBeenCalledTimes(1)
    const startCalls = scopedStartExact.mock.calls.length
    expect(startCalls).toBe(2)
    const teardownOrder = runtimeCoordinator.teardownRuntime.mock.invocationCallOrder.at(-1)!
    expect(teardownOrder).toBeGreaterThan(
      scopedStartExact.mock.invocationCallOrder[0]!,
    )
    expect(teardownOrder).toBeLessThan(
      scopedStartExact.mock.invocationCallOrder[1]!,
    )
  })

  it('POO-54: STOP is generation-CAS gated and tears the exact runtime down', async () => {
    const stop = handlers.get(RPC_CHANNELS.localApps.STOP)!
    // Unknown execution → stale generation, no registry touch.
    await expect(stop(context, {
      kind: 'product_space_runtime_handle',
      executionId: 'unknown',
      expectedRuntimeGeneration: 41,
    })).rejects.toMatchObject({ code: 'STALE_RUNTIME_GENERATION' })
    const runtime = {
      identityKey: 'k',
      identity: {
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        artifactInstanceId: 'artifact-instance-a',
        versionId: 'version-a',
        version: '2.3.4',
      },
      executionId: 'exec-41',
      runtimeGeneration: 41,
      scopeGeneration: 7,
      workspaceId: 'ws-window-a',
      runtimeKind: 'python' as const,
      capabilityGeneration: 11,
      controller: new AbortController(),
    }
    activeRuntimesByExecution.set('exec-41', runtime)
    // A stale generation is refused BEFORE touching the registry.
    await expect(stop(context, {
      kind: 'product_space_runtime_handle',
      executionId: 'exec-41',
      expectedRuntimeGeneration: 40,
    })).rejects.toMatchObject({ code: 'STALE_RUNTIME_GENERATION' })
    expect(scopedStopExact).not.toHaveBeenCalled()
    activeRuntimesByExecution.set('exec-41', runtime)
    // The current generation tears the runtime down with the exact stop.
    const status = await stop(context, {
      kind: 'product_space_runtime_handle',
      executionId: 'exec-41',
      expectedRuntimeGeneration: 41,
    })
    expect(status).toMatchObject({ appId: 'artifact-instance-a', status: 'stopped' })
    expect(runtimeCoordinator.teardownRuntime).toHaveBeenCalledWith(
      runtime,
      'cancelled',
      expect.any(Function),
    )
    expect(scopedStopExact).toHaveBeenCalledWith(
      expect.objectContaining({ catalogAppId: 'artifact-instance-a' }),
      41,
    )
  })

  it('POO-54 R2: registration/fence failure rolls back revoke-first via the coordinator, never stop-before-revoke', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // Park INSIDE the switch-mutex critical section (registry.startExact):
    // flip the committed ProductSpace while the runtime is starting, then
    // release — the post-start fence must roll back through the coordinator
    // (revoke → … → exact stop), never a bare process stop.
    let releaseParkedStart!: () => void
    const parkedStart = new Promise<void>(resolve => {
      releaseParkedStart = resolve
    })
    scopedStartExact.mockImplementationOnce(async (
      ...args: Parameters<typeof defaultStartExact>
    ) => {
      await parkedStart
      return defaultStartExact(...args)
    })
    const pending = start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    for (let i = 0; i < 100 && scopedStartExact.mock.calls.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(scopedStartExact.mock.calls.length).toBe(1)
    setRuntimeActiveProductSpace('organization-b')
    releaseParkedStart()
    await expect(pending).rejects.toMatchObject({ code: 'SWITCH_IN_PROGRESS' })
    // Revoke-first ordering: the coordinator teardown happened BEFORE the
    // exact stop, and the direct legacy stop path was never taken.
    expect(runtimeCoordinator.teardownRuntime).toHaveBeenCalledTimes(1)
    const teardownOrder = runtimeCoordinator.teardownRuntime.mock.invocationCallOrder.at(-1)!
    expect(teardownOrder).toBeLessThan(
      scopedStopExact.mock.invocationCallOrder.at(-1)!,
    )
    expect(scopedStopExact).toHaveBeenCalledWith(
      expect.objectContaining({ catalogAppId: 'artifact-instance-a' }),
      41,
    )
    expect(scopedRegistry.stop).not.toHaveBeenCalled()
    setRuntimeActiveProductSpace('organization-a')
  })

  it('POO-54 R11: a stop failure recorded by the already-active START rollback surfaces as STOP_FAILED with BOTH original and rollback cause', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // Park INSIDE startExact: the runtime registers ACTIVE (generation 41 via
    // processEnvironment) before the fence re-check runs. Flip the committed
    // ProductSpace while parked — after release, the post-registration fence
    // fails and the rollback targets the now-ACTIVE runtime. The rollback's
    // exact stop FAILS; the real coordinator records it (never throws), so
    // the START boundary itself must consume the recorded failure.
    let releaseParkedStart!: () => void
    const parkedStart = new Promise<void>(resolve => {
      releaseParkedStart = resolve
    })
    scopedStartExact.mockImplementationOnce(async (
      ...args: Parameters<typeof defaultStartExact>
    ) => {
      await parkedStart
      return defaultStartExact(...args)
    })
    scopedStopExact.mockImplementation(async () => {
      throw Object.assign(new Error('injected rollback stop failure'), {
        code: 'STOP_FAILED',
      })
    })
    const pending = start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    for (let i = 0; i < 100 && scopedStartExact.mock.calls.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(scopedStartExact.mock.calls.length).toBe(1)
    setRuntimeActiveProductSpace('organization-b')
    releaseParkedStart()
    type SurfacedStartFailure = {
      code?: string
      details?: { cause?: { original?: { code?: string }; rollback?: { message?: string } } }
    }
    let failure: SurfacedStartFailure | null = null
    try {
      await pending
    } catch (error) {
      failure = error as SurfacedStartFailure
    }
    // Exactly ONE surfaced STOP_FAILED — the composed one from the START
    // boundary, never a double wrap.
    expect(failure).toMatchObject({ code: 'STOP_FAILED' })
    // The ORIGINAL fence failure is preserved as cause.original…
    expect(failure?.details?.cause?.original?.code).toBe('SWITCH_IN_PROGRESS')
    // …and the recorded rollback stop failure travels as cause.rollback.
    expect(failure?.details?.cause?.rollback?.message).toBe('injected rollback stop failure')
    // The rollback ran exactly once through the ACTIVE teardown path (the
    // runtime was already registered) and consumed the recorded failure.
    expect(runtimeCoordinator.teardownRuntime).toHaveBeenCalledTimes(1)
    expect(recordedRollbackStopFailures.size).toBe(0)
    expect(scopedStopExact).toHaveBeenCalledTimes(1)
    expect(scopedStopExact).toHaveBeenCalledWith(
      expect.objectContaining({ catalogAppId: 'artifact-instance-a' }),
      41,
    )
    // The legacy artifact-scoped stop was never taken.
    expect(scopedRegistry.stop).not.toHaveBeenCalled()
    // No runtime survives the failed START: the coordinator entry was torn
    // down and the execution was never registered (fence failure).
    expect([...activeRuntimesByExecution.keys()]).toHaveLength(0)
    expect(listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )).toHaveLength(0)
    setRuntimeActiveProductSpace('organization-a')
  })

  it('POO-54 R2: START without a trusted caller Workspace fails closed with zero side effects', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // No window → no workspaceId.
    windowWorkspaceId = null
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    // Window exists but the Workspace record does not.
    windowWorkspaceId = 'ws-window-a'
    workspaceExists = false
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    // Zero gateway, zero capability, zero process, zero Admin calls.
    expect(runtimeCoordinator.ensureGateway).not.toHaveBeenCalled()
    expect(runtimeCoordinator.signCapability).not.toHaveBeenCalled()
    expect(runtimeCoordinator.registerActiveRuntime).not.toHaveBeenCalled()
    expect(scopedStartExact).not.toHaveBeenCalled()
    expect(listProductSpaces).not.toHaveBeenCalled()
    expect(getProductSpaceCatalog).not.toHaveBeenCalled()
  })

  it('POO-54 R3: ProductSpace execution liveness is generation/version-exact while versions coexist', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // The fresh Catalog lists TWO versions of the same artifact instance.
    const baseCatalog = await defaultProductSpaceCatalog()
    getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
      ...baseCatalog,
      entries: [
        ...baseCatalog.entries,
        {
          kind: 'app',
          catalogEntryId: 'catalog-entry-b',
          artifactInstanceId: 'artifact-instance-a',
          version: { versionId: 'version-b', version: '9.9.9', checksum: 'c'.repeat(64) },
          name: 'ProductSpace App v9',
          description: '',
          availability: 'available',
          sources: [{ kind: 'enterprise_import' }],
          permissions: [],
        },
      ],
    }))
    const identityV2 = {
      ...productSpaceAppIdentity(),
      catalogEntryId: 'catalog-entry-b',
      versionId: 'version-b',
      version: '9.9.9',
    }
    const resultV1 = await start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    const resultV2 = await start(context, {
      kind: 'product_space_runtime_start',
      app: identityV2,
    })
    const executions = listRegisteredProductSpaceExecutions()
      .filter(execution => execution.kind === 'local_app')
    expect(executions).toHaveLength(2)
    const subjectVersionId = (execution: { scope: { subject: unknown } }): string =>
      ((execution.scope.subject as { versionId?: string }).versionId ?? '')
    const execV1 = executions.find(
      execution => subjectVersionId(execution) === 'version-a',
    )
    const execV2 = executions.find(
      execution => subjectVersionId(execution) === 'version-b',
    )
    expect(execV1).toBeDefined()
    expect(execV2).toBeDefined()
    // While both coordinator runtimes are active, BOTH executions are live.
    expect(await execV1!.isActive()).toBe(true)
    expect(await execV2!.isActive()).toBe(true)
    // v1's process dies: only v1's execution reports not-live; the artifact-
    // scoped probe would have reported BOTH as not running.
    const runtimeV1 = activeRuntimesByExecution.get(
      (resultV1 as { executionId: string }).executionId,
    )
    await runtimeCoordinator.teardownRuntime(runtimeV1!, 'failed')
    expect(await execV1!.isActive()).toBe(false)
    expect(await execV2!.isActive()).toBe(true)
    // Liveness is generation-exact: a stale generation replay is a no-op.
    await runtimeCoordinator.teardownRuntime(runtimeV1!, 'failed')
    expect(await execV2!.isActive()).toBe(true)
  })

  it('POO-54 R4: STOP aggregates a failed generation-bound stop as STOP_FAILED while cleanup completes', async () => {
    // Seed a live runtime (started through the normal START path).
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    await start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    const stop = handlers.get(RPC_CHANNELS.localApps.STOP)!
    // The exact-generation stop FAILS.
    scopedStopExact.mockImplementation(async () => {
      throw Object.assign(new Error('process survived'), { code: 'STOP_FAILED' })
    })
    await expect(stop(context, {
      kind: 'product_space_runtime_handle',
      executionId: [...activeRuntimesByExecution.keys()][0]!,
      expectedRuntimeGeneration: 41,
    })).rejects.toMatchObject({ code: 'STOP_FAILED' })
    // (Projection/execution cleanup on a failed stop is asserted against the
    // REAL coordinator in the gateway isolated suite.)
  })

  it('POO-54 R4: the legacy lifecycle member travels as a bare scope — wrapper shapes are rejected', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // A bare CatalogLocalAppScope remains the legacy member and works.
    await start(context, scope())
    expect(scopedStart).toHaveBeenCalledTimes(1)
    // A legacy_scope WRAPPER is not part of the union: it reaches the
    // legacy branch as an invalid scope and fails closed.
    await expect(start(context, { kind: 'legacy_scope', scope: scope() }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(scopedStart).toHaveBeenCalledTimes(1)
  })

  it('POO-54 R5: static runtimes register without a capability and STOP/RESTART resolve them', async () => {
    // A static exact start: startExact reports runtimeKind 'static' and the
    // manager never calls the capability hook.
    scopedStartExact.mockImplementation((async (
      _scope: CatalogLocalAppScope,
      version: string,
    ) => ({
      appId: 'artifact-instance-a',
      version,
      url: 'http://127.0.0.1:9876',
      port: 9876,
      runtimeKind: 'static' as const,
      runtimeGeneration: 41,
      scopeGeneration: 9,
    })) as unknown as typeof defaultStartExact)
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const result = await start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    expect(result).toMatchObject({
      runtimeKind: 'static',
      runtimeGeneration: 41,
      platformApi: { status: 'unavailable', reason: 'static_runtime_unsupported' },
    })
    // Generation-exact liveness is TRUE for the static runtime (the exact
    // generation was recorded before coordinator registration).
    const staticExecutions = listRegisteredProductSpaceExecutions()
      .filter(execution => execution.kind === 'local_app')
    expect(await staticExecutions[0]!.isActive()).toBe(true)
    // The coordinator has an active runtime for the static identity (without
    // any capability) — the execution handle resolves through STOP.
    expect(runtimeCoordinator.registerActiveRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeKind: 'static',
        runtimeGeneration: 41,
      }),
    )
    expect(runtimeCoordinator.signCapability).not.toHaveBeenCalled()
    // RESTART resolves the live static handle and re-registers a fresh
    // static generation (provisional + restarted registration calls).
    const restart = handlers.get(RPC_CHANNELS.localApps.RESTART)!
    const restarted = await restart(context, {
      kind: 'product_space_runtime_handle',
      executionId: (result as { executionId: string }).executionId,
      expectedRuntimeGeneration: 41,
    })
    expect(restarted).toMatchObject({
      runtimeKind: 'static',
      runtimeGeneration: 41,
    })
    expect(runtimeCoordinator.registerActiveRuntime).toHaveBeenCalledTimes(2)
    // STOP resolves the restarted generation.
    const stop = handlers.get(RPC_CHANNELS.localApps.STOP)!
    const status = await stop(context, {
      kind: 'product_space_runtime_handle',
      executionId: (restarted as { executionId: string }).executionId,
      expectedRuntimeGeneration: 41,
    })
    expect(status).toMatchObject({ status: 'stopped' })
    scopedStartExact.mockImplementation(defaultStartExact)
  })

  it('POO-54 R5: a failed replacement stop rejects the replacement START with STOP_FAILED', async () => {
    const existing = {
      identityKey: 'k',
      identity: {
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        artifactInstanceId: 'artifact-instance-a',
        versionId: 'version-a',
        version: '2.3.4',
      },
      executionId: 'exec-old',
      runtimeGeneration: 41,
      scopeGeneration: 2,
      workspaceId: 'ws-window-a',
      runtimeKind: 'python' as const,
      capabilityGeneration: 3,
      controller: new AbortController(),
    }
    activeRuntimesByKey.set(runtimeIdentityKey(existing.identity), existing)
    // Registry-side old-generation ownership (the retry/diagnostic fallback):
    // a SUCCESSFUL stopExact removes it — a failing one throws BEFORE any
    // removal, mirroring the real scoped registry's process-id map.
    const registryProcessOwnership = new Map<number, string>([[41, 'exact-process-old']])
    // The exact-generation stop of the OLD generation fails. The mock
    // teardownRuntime mirrors the real coordinator's record-not-throw
    // semantics: the failure is RECORDED and the teardown RESOLVES.
    scopedStopExact.mockImplementation(async (
      _scope: CatalogLocalAppScope,
      expectedRuntimeGeneration: number,
    ) => {
      if (!registryProcessOwnership.has(expectedRuntimeGeneration)) {
        throw Object.assign(new Error('stale'), { code: 'STALE_RUNTIME_GENERATION' })
      }
      throw Object.assign(new Error('process survived'), { code: 'STOP_FAILED' })
    })
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toMatchObject({ code: 'STOP_FAILED' })
    // The recorded failure was consumed exactly at the replacement boundary.
    expect(recordedRollbackStopFailures.size).toBe(0)
    // stopExact ran exactly once for the old generation.
    expect(scopedStopExact).toHaveBeenCalledTimes(1)
    expect(scopedStopExact).toHaveBeenCalledWith(
      expect.objectContaining({ catalogAppId: 'artifact-instance-a' }),
      41,
    )
    // The successor never spawned: zero exact-version starts AND no gateway
    // reopen between the failed teardown and the STOP_FAILED boundary.
    expect(scopedStartExact).not.toHaveBeenCalled()
    expect(runtimeCoordinator.ensureGateway).not.toHaveBeenCalled()
    // The old generation's registry ownership was NOT prematurely cleared —
    // no retry stop, no uninstall, no ownership wipe around the failed
    // replacement: it remains the fallback for the surviving process.
    expect(registryProcessOwnership.get(41)).toBe('exact-process-old')
    expect(scopedRegistry.uninstall).not.toHaveBeenCalled()
    // R12: the outer START catch re-ran the (idempotent) rollback AFTER the
    // replacement boundary already failed — with no capability issued and no
    // successor generation started, that rollback must be a side-effect-free
    // completion: the legacy artifact-scoped namespace is never touched
    // (generation-exact isolation) and no second exact stop runs either.
    expect(scopedRegistry.stop).not.toHaveBeenCalled()
    expect(scopedStopExact).toHaveBeenCalledTimes(1)
  })

  it('POO-54 R12: a pre-spawn START failure rolls back with zero registry calls — no legacy namespace touch, no exact stop', async () => {
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    // Failure mode 1: the exact-version spawn fails BEFORE processEnvironment
    // runs — no capability was signed and no runtime generation started, so
    // the rollback is a side-effect-free completion.
    scopedStartExact.mockImplementationOnce(async () => {
      throw Object.assign(new Error('bundle spawn exploded'), { code: 'RUNTIME_UNAVAILABLE' })
    })
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    // Zero stop calls of ANY namespace: nothing was spawned, nothing to stop.
    expect(scopedStopExact).not.toHaveBeenCalled()
    expect(scopedRegistry.stop).not.toHaveBeenCalled()
    expect(runtimeCoordinator.teardownRuntime).not.toHaveBeenCalled()
    expect(runtimeCoordinator.revokeSignedCapability).not.toHaveBeenCalled()
    // No retryable/diagnostic state leaks from the failed START.
    expect(recordedRollbackStopFailures.size).toBe(0)
    expect([...activeRuntimesByExecution.keys()]).toHaveLength(0)
    expect(listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'local_app',
    )).toHaveLength(0)

    // Failure mode 2: the gateway cannot open (pre-spawn, pre-signing) —
    // same side-effect-free rollback contract.
    runtimeCoordinator.ensureGateway.mockImplementationOnce(async () => {
      throw new Error('gateway listen exploded')
    })
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toThrow('gateway listen exploded')
    expect(scopedStopExact).not.toHaveBeenCalled()
    expect(scopedRegistry.stop).not.toHaveBeenCalled()
    expect(recordedRollbackStopFailures.size).toBe(0)
  })

  it('static START records the exact generation: liveness is true and a registration failure rolls back through the legacy stop', async () => {
    scopedStartExact.mockImplementation((async (
      _scope: CatalogLocalAppScope,
      version: string,
    ) => ({
      appId: 'artifact-instance-a',
      version,
      url: 'http://127.0.0.1:9876',
      port: 9876,
      runtimeKind: 'static' as const,
      runtimeGeneration: 41,
      scopeGeneration: 9,
    })) as unknown as typeof defaultStartExact)
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    const result = await start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    expect(result).toMatchObject({ runtimeKind: 'static', runtimeGeneration: 41 })
    // Generation-exact liveness is TRUE for the static runtime (R5 bug).
    const executions = listRegisteredProductSpaceExecutions()
      .filter(execution => execution.kind === 'local_app')
    expect(executions).toHaveLength(1)
    const staticExecutions = listRegisteredProductSpaceExecutions()
      .filter(execution => execution.kind === 'local_app')
    expect(await staticExecutions[0]!.isActive()).toBe(true)
    expect(scopedRegistry.stop).not.toHaveBeenCalled()

    // A registration failure rolls back generation-aware: the EXACT
    // version-namespaced stop runs (no capability exists to revoke) and the
    // START fails — the legacy artifact-scoped stop is never taken.
    runtimeCoordinator.registerActiveRuntime.mockImplementationOnce(() => {
      throw new Error('coordinator is shutting down')
    })
    await expect(start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })).rejects.toThrow('coordinator is shutting down')
    expect(scopedStopExact).toHaveBeenCalledWith(
      expect.objectContaining({ catalogAppId: 'artifact-instance-a' }),
      41,
    )
    expect(scopedRegistry.stop).not.toHaveBeenCalled()
  })

  it('POO-54 R6: any exact-stop failure normalizes to STOP_FAILED with the original cause (STOP and replacement)', async () => {
    // Seed a live runtime.
    const start = handlers.get(RPC_CHANNELS.localApps.START)!
    await start(context, {
      kind: 'product_space_runtime_start',
      app: productSpaceAppIdentity(),
    })
    const executionId = [...activeRuntimesByExecution.keys()][0]!
    // stopExact throws a STALE_RUNTIME_GENERATION LocalAppRuntimeError —
    // NOT a STOP_FAILED. Both STOP and replacement must normalize it.
    scopedStopExact.mockImplementation(async () => {
      // A STALE_RUNTIME_GENERATION-shaped failure (as the registry throws).
      throw Object.assign(new Error('no longer current'), {
        code: 'STALE_RUNTIME_GENERATION',
      })
    })
    const stop = handlers.get(RPC_CHANNELS.localApps.STOP)!
    let stopFailure: { code?: string; details?: { cause?: { message?: string } } } | null = null
    try {
      await stop(context, {
        kind: 'product_space_runtime_handle',
        executionId,
        expectedRuntimeGeneration: 41,
      })
    } catch (error) {
      stopFailure = error as { code: string; details?: { cause?: { message: string } } }
    }
    expect(stopFailure).toMatchObject({ code: 'STOP_FAILED' })
    expect(stopFailure?.details?.cause?.message).toBe('no longer current')

    // Replacement: the successor never spawns and the normalized
    // STOP_FAILED (with cause) is what the caller sees. Re-seed the live
    // runtime (the STOP above removed it from the coordinator maps).
    const replacementRuntime = {
      identityKey: 'k',
      identity: {
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        artifactInstanceId: 'artifact-instance-a',
        versionId: 'version-a',
        version: '2.3.4',
      },
      executionId,
      runtimeGeneration: 41,
      scopeGeneration: 7,
      workspaceId: 'ws-window-a',
      runtimeKind: 'python' as const,
      capabilityGeneration: 11,
      controller: new AbortController(),
    }
    activeRuntimesByKey.set(runtimeIdentityKey(replacementRuntime.identity), replacementRuntime)
    activeRuntimesByExecution.set(executionId, replacementRuntime)
    scopedStartExact.mockClear()
    let replacement: { code?: string; details?: { cause?: { message?: string } } } | null = null
    try {
      await start(context, {
        kind: 'product_space_runtime_start',
        app: productSpaceAppIdentity(),
      })
    } catch (error) {
      replacement = error as { code: string; details?: { cause?: { message: string } } }
    }
    expect(replacement).toMatchObject({ code: 'STOP_FAILED' })
    expect(replacement?.details?.cause?.message).toBe('no longer current')
  })


  it('static registration failure rolls back via generation-aware stopExact on the version-namespaced id — never legacy stop; stopExact rejection propagates through the aggregator', async () => {
    // FAITHFUL static model: the manager deliberately never calls
    // processEnvironment for static runtimes. Each startExact call records
    // a DISTINCT generation → version-namespaced mapping (41, 42, …).
    let generationCounter = 0
    const exactMappings = new Map<number, string>()
    const stopExactCalls: Array<{ appId: string; generation: number }> = []
    const legacyStopCalls: string[] = []
    let injectedStopFailure: Error | null = null
    const fakeExactRegistry = {
      assertAppAuthorized: () => {},
      install: async () => { throw new Error('not used') },
      cancelInstall: async () => false,
      start: async () => { throw new Error('not used') },
      stop: async (scope: CatalogLocalAppScope) => {
        legacyStopCalls.push('legacy-artifact-scoped-id')
        return { appId: scope.catalogAppId, scope, status: 'stopped' as const }
      },
      restart: async () => { throw new Error('not used') },
      startExact: async (
        scope: CatalogLocalAppScope,
        version: string,
      ) => {
        // STATIC contract: no processEnvironment call. Each call records a
        // distinct generation → version-namespaced mapping.
        generationCounter += 1
        const generation = generationCounter
        exactMappings.set(generation, `exact-process-${generation}`)
        return {
          appId: `exact-process-${generation}`,
          version,
          url: 'http://127.0.0.1:9876',
          port: 9876,
          runtimeKind: 'static' as const,
          runtimeGeneration: generation,
          scopeGeneration: 9,
        }
      },
      stopExact: async (
        scope: CatalogLocalAppScope,
        expectedRuntimeGeneration: number,
      ) => {
        const appId = exactMappings.get(expectedRuntimeGeneration)
        stopExactCalls.push({
          appId: appId ?? '<unknown>',
          generation: expectedRuntimeGeneration,
        })
        if (injectedStopFailure) throw injectedStopFailure
        if (appId === undefined) {
          throw Object.assign(new Error('stale'), { code: 'STALE_RUNTIME_GENERATION' })
        }
        exactMappings.delete(expectedRuntimeGeneration)
        return {
          appId,
          scope,
          status: 'stopped' as const,
          currentVersion: '2.3.4',
        }
      },
      uninstall: async () => {},
      setAvailableRelease: async (scope: CatalogLocalAppScope) => ({
        appId: scope.catalogAppId,
        scope,
        status: 'installed' as const,
      }),
      getInstalledApps: async () => [],
      getRuntimeStatus: async (scope: CatalogLocalAppScope) => ({
        appId: scope.catalogAppId,
        scope,
        status: 'not_installed' as const,
      }),
      getRuntimeStatuses: async (scopes: CatalogLocalAppScope[]) => scopes.map(scope => ({
        appId: scope.catalogAppId,
        scope,
        status: 'not_installed' as const,
      })),
      getLogs: async () => '',
      getFailureRecoveryLogs: async () => '',
      getRetainedManagementLogs: async () => '',
      isInstalledAndReady: async () => true,
    }
    scopedRegistryOverride = fakeExactRegistry
    try {
      const start = handlers.get(RPC_CHANNELS.localApps.START)!

      // ── Phase 1: successful static start of identity A.
      const baseCatalog = await defaultProductSpaceCatalog()
      const twoVersionCatalog = {
        ...baseCatalog,
        entries: [
          ...baseCatalog.entries,
          {
            kind: 'app',
            catalogEntryId: 'catalog-entry-b',
            artifactInstanceId: 'artifact-instance-b',
            version: { versionId: 'version-b', version: '3.0.0', checksum: 'c'.repeat(64) },
            name: 'Static App B',
            description: '',
            availability: 'available',
            sources: [{ kind: 'enterprise_import' }],
            permissions: [],
          },
        ],
      }
      getProductSpaceCatalog.mockImplementation(async (): Promise<any> => twoVersionCatalog)
      const identityA = {
        ...productSpaceAppIdentity(),
        catalogEntryId: 'catalog-entry-a',
      }
      const resultA = await start(context, {
        kind: 'product_space_runtime_start',
        app: identityA,
      })
      expect(resultA).toMatchObject({
        runtimeKind: 'static',
        runtimeGeneration: 1,
      })
      // Generation 1's mapping was recorded as a distinct entry.
      expect(exactMappings.get(1)).toBe('exact-process-1')

      // ── Phase 2: a DIFFERENT identity's static start; its post-start
      // registerActiveRuntime throws → rollback must target generation 2's
      // version-namespaced id.
      const identityB = {
        accountId: 'account-a',
        productSpaceId: 'organization-a',
        catalogEntryId: 'catalog-entry-b',
        artifactInstanceId: 'artifact-instance-b',
        versionId: 'version-b',
        version: '3.0.0',
        catalogRevision: 'revision-a',
        sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
        availability: 'available' as const,
      }
      runtimeCoordinator.registerActiveRuntime.mockImplementationOnce(() => {
        throw new Error('coordinator exploded')
      })
      let failed: { code?: string; message?: string; details?: { cause?: { message?: string } } } | null = null
      try {
        await start(context, {
          kind: 'product_space_runtime_start',
          app: identityB,
        })
      } catch (error) {
        failed = error as { code?: string; message?: string; details?: { cause?: { message?: string } } }
      }
      // The registration failure surfaces to the START boundary.
      expect(failed).toMatchObject({ message: 'coordinator exploded' })
      // The rollback used generation-aware stopExact for generation 2 with
      // its exact id — never the legacy artifact-scoped stop.
      const rollbackCall = stopExactCalls.at(-1)!
      expect(rollbackCall).toEqual({
        appId: 'exact-process-2',
        generation: 2,
      })
      // The failed generation's exact key was removed; the previously
      // successful generation 1 mapping is unaffected.
      expect(exactMappings.has(2)).toBe(false)
      expect(exactMappings.get(1)).toBe('exact-process-1')
      expect(legacyStopCalls).toHaveLength(0)
      // ── Phase 3: injected stopExact rejection propagates through the
      // aggregator to the STOP boundary (STOP_FAILED + original cause).
      injectedStopFailure = new Error('injected stop failure')
      let stopFailure: { code?: string; details?: { cause?: { message?: string } } } | null = null
      try {
        await handlers.get(RPC_CHANNELS.localApps.STOP)!(context, {
          kind: 'product_space_runtime_handle',
          executionId: (resultA as { executionId: string }).executionId,
          expectedRuntimeGeneration: 1,
        })
      } catch (error) {
        stopFailure = error as { code?: string; details?: { cause?: { message?: string } } }
      }
      expect(stopFailure).toMatchObject({ code: 'STOP_FAILED' })
      expect(stopFailure?.details?.cause?.message).toBe('injected stop failure')
    } finally {
      scopedRegistryOverride = null
    }
  })
})
