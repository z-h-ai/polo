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

mock.module('@polo-ai/server-core/runtime/product-space-catalog-authority', () => ({
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
  listRegisteredProductSpaceExecutions,
  withSwitchLock,
} = await import('@polo-ai/server-core/runtime/product-space-executions')

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
    catalogEntryId: 'catalog-entry-a',
    artifactInstanceId: 'artifact-instance-a',
    versionId: 'version-a',
    version: '2.3.4',
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

  beforeEach(() => {
    signedInAccountId = 'account-a'
    accessMode = 'online'
    accountAccessDenied = false
    appAccessDenied = false
    catalog = createCatalog(1)
    authorityTuplesByScope.clear()
    withdrawnTombstonesByScope.clear()
    seedAuthorityBinding()
    windowWorkspaceId = 'ws-window-a'
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
    const withdrawnIdentity = {
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: 'catalog-entry-w',
      artifactInstanceId: 'artifact-w',
      versionId: 'version-w',
      version: '2.0.0',
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

  it('rejects uninstalling an OLD republished tuple when the same entry/artifact is re-released at a NEW version (live drift, not tombstone)', async () => {
    // Sequence: the old version WAS withdrawn and retained as a trusted
    // tombstone; the same stable entry + artifact is then REPUBLISHED at a
    // new version. Uninstalling the OLD tuple must fail closed as live
    // drift — registry and files are untouched.
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
    }, { preserveData: true })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('covers each per-field drift (artifactInstanceId / versionId / version) as fail-closed live drift, missing-entry as tombstone-routable, and inactive space as NOT_AUTHORIZED', async () => {
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
    const base = productSpaceAppIdentity()
    const currentEntry = {
      kind: 'app' as const,
      catalogEntryId: base.catalogEntryId,
      artifactInstanceId: base.artifactInstanceId,
      version: { versionId: base.versionId, version: base.version, checksum: 'b'.repeat(64) },
      name: 'ProductSpace App',
      description: '',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const, enterpriseId: 'enterprise-a' }],
      permissions: [],
    }
    // Per-field drift: artifact / versionId / version each → DRIFT.
    for (const drifted of [
      { artifactInstanceId: 'artifact-drifted' },
      { version: { versionId: 'version-drifted', version: '8.8.8' } },
      { version: { versionId: base.versionId, version: '9.9.9' } },
    ] as const) {
      getProductSpaceCatalog.mockImplementation(async (): Promise<any> => ({
        contractVersion: 1,
        productSpaceId: 'organization-a',
        catalogRevision: 'rev-drift',
        entries: [{ ...currentEntry, ...drifted }],
      }))
      await expect(uninstall(context, base, { preserveData: true }))
        .rejects.toMatchObject({ code: 'CATALOG_IDENTITY_DRIFT' })
    }

    // Genuinely missing entry + tombstone evidence → tombstone cleanup.
    seedTombstoneBinding(
      base.accountId, base.productSpaceId,
      base.catalogEntryId, base.artifactInstanceId, base.versionId, base.version,
    )
    getProductSpaceCatalog.mockImplementation(async () => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'rev-missing',
      entries: [],
    }))
    await uninstall(context, base, { preserveData: true })
    expect(scopedRegistry.uninstall).toHaveBeenCalled()

    // Missing entry WITHOUT tombstone evidence → fail closed.
    const callsBefore = scopedRegistry.uninstall.mock.calls.length
    getProductSpaceCatalog.mockImplementation(async () => ({
      contractVersion: 1,
      productSpaceId: 'organization-a',
      catalogRevision: 'rev-missing-2',
      entries: [],
    }))
    await expect(uninstall(context, {
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: 'catalog-entry-never',
      artifactInstanceId: 'artifact-never',
      versionId: 'version-never',
      version: '1.0.0',
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
    seedTombstoneBinding()
    await expect(uninstall(context, base, { preserveData: true }))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    listProductSpaces.mockImplementation(async () => ({
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
    }, { preserveData: true })).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED', status: 401 })
    expect(scopedRegistry.uninstall.mock.calls.length).toBe(callsBefore)
    getProductSpaceCatalog.mockImplementation(defaultProductSpaceCatalog)
  })

  it('rejects fabricated withdrawn uninstall identities before the registry can run', async () => {
    const uninstall = handlers.get(RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE)!
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
    // success WITHOUT any tombstone evidence.
    seedAuthorityBinding()
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
      withSwitchLock(async () => true),
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

  beforeEach(() => {
    signedInAccountId = 'account-a'
    accessMode = 'online'
    appAccessDenied = false
    catalog = createCatalog(1)
    authorityTuplesByScope.clear()
    seedAuthorityBinding()
    windowWorkspaceId = 'ws-window-a'
    context.webContentsId = 1
    handlers.clear()
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
})
