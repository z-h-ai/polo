import {
  AdminClient,
  getAppCatalogAccessMode,
  getAppCatalogApps,
  getCachedAppCatalog,
  isAppCatalogAccessDeniedForAccount,
  type AppReleaseSummary,
  type CatalogApp,
} from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import {
  compareCatalogSemVer,
  normalizeCatalogSemVer,
} from '@polo-ai/shared/admin/semver'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import {
  normalizeLocalAppPermissions,
  projectLocalAppStatusForCatalogAccess,
  RPC_CHANNELS,
} from '@polo-ai/shared/protocol'
import type {
  CatalogLocalAppScope,
  LocalAppAvailableRelease,
  LocalAppBatchStatusRequest,
  LocalAppCatalogInstallRequest,
  LocalAppLogsOptions,
  LocalAppRuntimeStatus,
  LocalAppUninstallOptions,
  ProductSpaceAppIdentity,
  ProductSpaceAppInstallState,
  ProductSpaceBundleInstallRequest,
} from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import {
  getScopedLocalAppRuntimeRegistry,
  LocalAppRuntimeError,
  MAX_CATALOG_STATUS_SCOPES,
  validateCatalogLocalAppScope,
} from '../local-app-runtime'
import {
  getRuntimeActiveProductSpace,
  isSwitchInProgress,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
  isRuntimeProductSpaceRestricted,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  unregisterProductSpaceExecution,
  withSwitchLock,
  type RegisteredProductSpaceExecution,
} from '@polo-ai/server-core/runtime/product-space-executions'
import {
  PRODUCT_SPACE_CONTRACT_VERSION,
  AccountIdSchema,
  ArtifactInstanceIdSchema,
  ArtifactVersionIdSchema,
  CatalogEntryIdSchema,
  ProductSpaceIdSchema,
  ProductSpaceExecutionScopeSchema,
} from '@polo-ai/shared/product-spaces'
import {
  loadProductSpaceCatalogAuthorityTupleSet,
  loadProductSpaceWithdrawnTombstoneTupleSet,
  productSpaceCatalogAuthorityTupleKey,
} from '@polo-ai/server-core/runtime/product-space-catalog-authority'
import { setLegacyLocalAppCleaner } from '@polo-ai/server-core/runtime/legacy-state-cleaners'
import { captureTrustedStartGate, isTrustedStartGateCurrent } from '@polo-ai/server-core/runtime/trusted-start-gate'
import type { HandlerDeps } from './handler-deps'

/**
 * Trusted active ProductSpace gate for every renderer-reachable Local App
 * business RPC: the scope's space must equal the Main runtime's committed
 * active fence. Only the controlled legacy cleanup path may touch other
 * spaces, and it never goes through this gate.
 */
function assertScopeInsideActiveProductSpace(scope: CatalogLocalAppScope): void {
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || isRuntimeOfflineReadOnly()) {
    throw new LocalAppRuntimeError(
      'PRODUCT_SPACE_CONTEXT_REQUIRED',
      'No committed ProductSpace is active on this device',
    )
  }
  if (scope.organizationId !== activeProductSpaceId) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'Local App requests cannot target another ProductSpace',
    )
  }
}

function requireRendererCatalogScope(reference: unknown): CatalogLocalAppScope {
  if (
    reference
    && typeof reference === 'object'
    && (reference as { kind?: unknown }).kind === 'legacy'
  ) {
    // The renderer has no trusted capability for the POO-12 compatibility
    // namespace. Reject it before session/cache checks so forged legacy calls
    // stay closed while signed out, denied, or in restricted offline mode.
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'Renderer local app RPC only permits authorized Catalog scopes',
    )
  }
  const scope = validateCatalogLocalAppScope(reference)
  assertScopeInsideActiveProductSpace(scope)
  return scope
}

async function requireTrustedCatalogAccount(scope: CatalogLocalAppScope): Promise<void> {
  const tokens = await getCredentialManager().getAdminTokens()
  if (
    !tokens
    || tokens.userId !== scope.accountId
    || isAppCatalogAccessDeniedForAccount(scope.accountId)
  ) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'The local app belongs to a different or signed-out account',
    )
  }
}

interface CatalogAppReference {
  app: CatalogApp
  appConfigVersion: string
  accessMode: 'online' | 'offline' | 'denied'
  canAccessDeliveryMetadata: boolean
}

function isCatalogAppLifecycleAuthorized(
  scope: CatalogLocalAppScope,
): boolean {
  try {
    // Withdrawal establishes this in-memory fence before cache persistence or
    // slow runtime cleanup, so a stale authorized cache cannot leak a Release.
    getScopedLocalAppRuntimeRegistry().assertAppAuthorized(scope)
    return true
  } catch {
    return false
  }
}

function canAccessCatalogDeliveryMetadata(
  scope: CatalogLocalAppScope,
): boolean {
  const catalog = getCachedAppCatalog(scope.accountId, scope.organizationId)
  const app = catalog
    ? getAppCatalogApps(catalog).find(candidate => candidate.id === scope.catalogAppId)
    : undefined
  return Boolean(
    catalog?.authorizationStatus === 'authorized'
    && getAppCatalogAccessMode(scope.accountId, scope.organizationId) !== 'denied'
    && app?.availability === 'available'
    && isCatalogAppLifecycleAuthorized(scope),
  )
}

async function requireCatalogAppReference(
  scope: CatalogLocalAppScope,
): Promise<CatalogAppReference> {
  await requireTrustedCatalogAccount(scope)
  const catalog = getCachedAppCatalog(scope.accountId, scope.organizationId)
  const app = catalog
    ? getAppCatalogApps(catalog).find(candidate => candidate.id === scope.catalogAppId)
    : undefined
  const accessMode = getAppCatalogAccessMode(scope.accountId, scope.organizationId)
  if (!catalog || !app) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'This organization app is not present in the current account cache',
    )
  }
  return {
    app,
    appConfigVersion: catalog.appConfigVersion,
    accessMode,
    canAccessDeliveryMetadata: canAccessCatalogDeliveryMetadata(scope),
  }
}

async function requireCatalogDataAccess(
  scope: CatalogLocalAppScope,
): Promise<CatalogAppReference> {
  const reference = await requireCatalogAppReference(scope)
  const catalog = getCachedAppCatalog(scope.accountId, scope.organizationId)
  if (
    catalog?.authorizationStatus !== 'authorized'
    || reference.accessMode === 'denied'
  ) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'This organization app session is no longer authorized',
    )
  }
  return reference
}

async function requireAuthorizedCatalogEntry(
  scope: CatalogLocalAppScope,
): Promise<CatalogAppReference> {
  const authorized = await requireCatalogDataAccess(scope)
  if (authorized.app.availability !== 'available') {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'This organization app is no longer authorized for installation or launch',
    )
  }
  // The cache can still contain the previous Catalog when its replacement
  // fails to persist. The process-local scope fence is the newer authorization
  // truth for both Bundle and remote URL launch paths.
  getScopedLocalAppRuntimeRegistry().assertAppAuthorized(scope)
  return authorized
}

async function requireAuthorizedCatalogApp(
  scope: CatalogLocalAppScope,
): Promise<CatalogAppReference> {
  const {
    app,
    appConfigVersion,
    accessMode,
    canAccessDeliveryMetadata,
  } = await requireAuthorizedCatalogEntry(scope)
  if (app.deliveryMode !== 'local_bundle') {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      'Remote URL apps cannot use the local bundle runtime',
    )
  }
  return { app, appConfigVersion, accessMode, canAccessDeliveryMetadata }
}

async function withCatalogScope<T>(
  rawReference: unknown,
  catalogOperation: (scope: CatalogLocalAppScope) => Promise<T>,
): Promise<T> {
  const reference = requireRendererCatalogScope(rawReference)
  await requireCatalogDataAccess(reference)
  return catalogOperation(reference)
}

async function withCatalogManagementScope<T>(
  rawReference: unknown,
  catalogOperation: (
    scope: CatalogLocalAppScope,
    reference: CatalogAppReference,
  ) => Promise<T>,
): Promise<T> {
  const reference = requireRendererCatalogScope(rawReference)
  const catalogReference = await requireCatalogAppReference(reference)
  if (catalogReference.app.deliveryMode !== 'local_bundle') {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      'Remote URL apps do not have local runtime data',
    )
  }
  return catalogOperation(reference, catalogReference)
}

function hostPlatform(): 'darwin' | 'win32' | 'linux' {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return process.platform
  }
  return 'linux'
}

function hostArchitecture(): 'arm64' | 'x64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

function validateProductSpaceAppIdentity(value: unknown): ProductSpaceAppIdentity {
  if (!value || typeof value !== 'object') {
    throw new LocalAppRuntimeError('INVALID_REQUEST', 'ProductSpace App identity is required')
  }
  const input = value as Partial<ProductSpaceAppIdentity>
  const accountId = AccountIdSchema.safeParse(input.accountId)
  const productSpaceId = ProductSpaceIdSchema.safeParse(input.productSpaceId)
  const catalogEntryId = CatalogEntryIdSchema.safeParse(input.catalogEntryId)
  const artifactInstanceId = ArtifactInstanceIdSchema.safeParse(input.artifactInstanceId)
  const versionId = ArtifactVersionIdSchema.safeParse(input.versionId)
  if (
    !accountId.success
    || !productSpaceId.success
    || !catalogEntryId.success
    || !artifactInstanceId.success
    || !versionId.success
    || typeof input.version !== 'string'
    || input.version.trim().length === 0
    || input.version.length > 512
  ) {
    throw new LocalAppRuntimeError('INVALID_REQUEST', 'ProductSpace App identity is invalid')
  }
  return {
    accountId: accountId.data,
    productSpaceId: productSpaceId.data,
    catalogEntryId: catalogEntryId.data,
    artifactInstanceId: artifactInstanceId.data,
    versionId: versionId.data,
    version: input.version,
  }
}

function productSpaceBundleScope(app: ProductSpaceAppIdentity): CatalogLocalAppScope {
  return {
    kind: 'catalog',
    accountId: app.accountId,
    organizationId: app.productSpaceId,
    catalogAppId: app.artifactInstanceId,
  }
}

/**
 * One-pass restricted withdrawn-management validation for an entire batch:
 * every identity's FULL tuple (catalogEntryId + artifactInstanceId +
 * versionId + version) must exist in the Main-owned persisted Catalog
 * authority, and duplicate identities are rejected. O(authority + requests):
 * the authority tuple set is read exactly once, never per item.
 */
/**
 * Collision-free JSON tuple over the FULL ProductSpace App identity
 * (accountId + productSpaceId + catalogEntryId + artifactInstanceId +
 * versionId + version). Shared by the withdrawn-authority and fresh-Catalog
 * duplicate-detection passes so both paths can never drift on the identity
 * contract.
 */
function productSpaceAppIdentityKey(app: ProductSpaceAppIdentity): string {
  return JSON.stringify([
    app.accountId,
    app.productSpaceId,
    app.catalogEntryId,
    app.artifactInstanceId,
    app.versionId,
    app.version,
  ])
}

/**
 * Shared shape/scope validation for EVERY ProductSpace App identity batch:
 * bounded length, syntactic identity validation, one account + one
 * ProductSpace per batch, and duplicate-identity rejection (full identity
 * tuple). Authorization differs per channel and stays with the callers:
 * fresh-Catalog tuple validation for the authoritative channel, persisted
 * authority tuples for the restricted withdrawn channel.
 */
function parseProductSpaceAppIdentityBatch(
  rawApps: unknown,
  errorPrefix: string,
): ProductSpaceAppIdentity[] {
  if (
    !Array.isArray(rawApps)
    || rawApps.length === 0
    || rawApps.length > MAX_CATALOG_STATUS_SCOPES
  ) {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      `${errorPrefix}: between 1 and ${MAX_CATALOG_STATUS_SCOPES} ProductSpace App identities are required`,
    )
  }
  const apps = rawApps.map(validateProductSpaceAppIdentity)
  const first = apps[0]!
  if (apps.some(app => (
    app.accountId !== first.accountId
    || app.productSpaceId !== first.productSpaceId
  ))) {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      `${errorPrefix}: a batch must target one account and ProductSpace`,
    )
  }
  const seenIdentityKeys = new Set<string>()
  for (const app of apps) {
    const identityKey = productSpaceAppIdentityKey(app)
    if (seenIdentityKeys.has(identityKey)) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        `${errorPrefix}: duplicate ProductSpace App identities are not allowed`,
      )
    }
    seenIdentityKeys.add(identityKey)
  }
  return apps
}

/**
 * RESTRICTED withdrawn-management gate: every identity's FULL tuple
 * (catalogEntryId + artifactInstanceId + versionId + version) must come from
 * the Main-owned persisted Catalog authority. A renderer cannot declare an
 * identity withdrawn — fabricated catalog/version tuples or unknown artifact
 * instances are rejected before any registry read.
 */
/**
 * RETAINED-TOMBSTONE gate for no-fresh-Catalog cleanup: every identity's
 * FULL tuple must be a WITHDRAWN TOMBSTONE of the process-trusted authority
 * record — deliberately NOT the live∪tombstone union. A live (or stale-
 * version live) App can never pass this gate; the live path must go through
 * the fresh-Catalog revalidation instead.
 */
function assertRetainedTombstoneProductSpaceAppAuthority(apps: ProductSpaceAppIdentity[]): void {
  const first = apps[0]!
  const tombstoneTuples = loadProductSpaceWithdrawnTombstoneTupleSet(
    first.accountId,
    first.productSpaceId,
  )
  for (const app of apps) {
    const tupleKey = productSpaceCatalogAuthorityTupleKey(
      app.catalogEntryId,
      app.artifactInstanceId,
      app.versionId,
      app.version,
    )
    if (!tombstoneTuples.has(tupleKey)) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'Retained cleanup requires a withdrawn tombstone identity from the trusted Catalog authority',
      )
    }
  }
}

function assertWithdrawnProductSpaceAppAuthority(apps: ProductSpaceAppIdentity[]): void {
  const first = apps[0]!
  const authorityTuples = loadProductSpaceCatalogAuthorityTupleSet(
    first.accountId,
    first.productSpaceId,
  )
  for (const app of apps) {
    const tupleKey = productSpaceCatalogAuthorityTupleKey(
      app.catalogEntryId,
      app.artifactInstanceId,
      app.versionId,
      app.version,
    )
    if (!authorityTuples.has(tupleKey)) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'Withdrawn ProductSpace App identity is not in the trusted Catalog authority',
      )
    }
  }
}

/**
 * Shared installation projection for the authoritative (fresh-Catalog
 * validated) and the restricted withdrawn-management channel: scope echo is
 * verified per identity, and only non-secret install state is projected.
 */
function projectProductSpaceInstallStates(
  apps: ProductSpaceAppIdentity[],
  statuses: LocalAppRuntimeStatus[],
): ProductSpaceAppInstallState[] {
  return statuses.map((status, index) => {
    const app = apps[index]!
    const expectedScope = productSpaceBundleScope(app)
    if (
      status.scope?.kind !== 'catalog'
      || status.scope.accountId !== expectedScope.accountId
      || status.scope.organizationId !== expectedScope.organizationId
      || status.scope.catalogAppId !== expectedScope.catalogAppId
    ) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'ProductSpace installation state belongs to another App',
      )
    }
    const installing = status.status === 'downloading'
      || status.status === 'installing'
      || status.installationStatus !== undefined
    return {
      app,
      state: installing
        ? 'installing'
        : status.currentVersion
        ? 'installed'
        : 'not_installed',
      ...(status.currentVersion ? { currentVersion: status.currentVersion } : {}),
      ...(typeof status.progress?.percent === 'number'
        ? { progressPercent: status.progress.percent }
        : {}),
    }
  })
}

function assertProductSpaceAppOperationCurrent(app: ProductSpaceAppIdentity): void {
  assertScopeInsideActiveProductSpace(productSpaceBundleScope(app))
  if (
    !isRuntimeFenceBoundToAccount(app.accountId)
    || isRuntimeProductSpaceRestricted(app.productSpaceId)
    || isSwitchInProgress()
  ) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'ProductSpace App management requires the current unrestricted ProductSpace',
    )
  }
}

async function assertProductSpaceAccountCurrent(app: ProductSpaceAppIdentity): Promise<{
  accessToken: string
}> {
  assertProductSpaceAppOperationCurrent(app)
  const tokens = await getCredentialManager().getAdminTokens()
  if (!tokens || tokens.userId !== app.accountId) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'ProductSpace App management belongs to another or signed-out account',
    )
  }
  return { accessToken: tokens.accessToken }
}

async function loadAuthoritativeProductSpaceApps(
  rawApps: unknown,
  options: {
    /**
     * Error code for a live-drift mismatch (entry EXISTS but its
     * artifact/version differs from the request). Defaults to the legacy
     * `RELEASE_CHANGED`; the uninstall IPC uses the granular
     * `CATALOG_IDENTITY_DRIFT` so live drift can never be confused with an
     * authoritative missing-entry verdict.
     */
    driftCode?: 'RELEASE_CHANGED' | 'CATALOG_IDENTITY_DRIFT'
  } = {},
): Promise<{
  apps: ProductSpaceAppIdentity[]
  accessToken: string
  client: AdminClient
  context: Awaited<ReturnType<AdminClient['listProductSpaces']>>['productSpaces'][number]
  catalog: Exclude<Awaited<ReturnType<AdminClient['getProductSpaceCatalog']>>, { notModified: true }>
}> {
  const apps = parseProductSpaceAppIdentityBatch(
    rawApps,
    'ProductSpace App identities',
  )
  const first = apps[0]!
  const { accessToken } = await assertProductSpaceAccountCurrent(first)
  const adminUrl = getAdminUrl()
  if (!adminUrl) {
    throw new LocalAppRuntimeError('NOT_AUTHORIZED', 'Polo Admin is not configured')
  }
  const client = new AdminClient(adminUrl)
  const list = await client.listProductSpaces(accessToken)
  const context = list.productSpaces.find(space => space.id === first.productSpaceId)
  if (!context || context.accessMode !== 'active') {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'The requested ProductSpace is not active',
    )
  }
  const catalog = await client.getProductSpaceCatalog(accessToken, context)
  if ('notModified' in catalog) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'A fresh ProductSpace Catalog is required',
    )
  }
  // One index for the entire batch: the Catalog may hold up to 10,000
  // entries and the request up to 10,000 identities, so per-request
  // `entries.find` scans would cost O(catalog × request) on the Main thread.
  const entriesById = new Map<string, (typeof catalog.entries)[number]>(
    catalog.entries.map(entry => [entry.catalogEntryId as string, entry] as const),
  )
  const seenIdentityKeys = new Set<string>()
  for (const app of apps) {
    const identityKey = productSpaceAppIdentityKey(app)
    if (seenIdentityKeys.has(identityKey)) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'Duplicate ProductSpace App identities are not allowed',
      )
    }
    seenIdentityKeys.add(identityKey)
    const entry = entriesById.get(app.catalogEntryId)
    if (!entry) {
      // Authoritative absence: the CURRENT distribution genuinely has no
      // such entry. This is the ONLY verdict that may route an uninstall to
      // the retained-tombstone cleanup gate.
      throw new LocalAppRuntimeError(
        'CATALOG_ENTRY_MISSING',
        'The ProductSpace Catalog no longer lists this entry',
      )
    }
    if (entry.kind !== 'app') {
      // KIND DRIFT: the entry ID exists but is no longer an App (skill /
      // built-in row took the stable ID). This is a LIVE identity drift —
      // it must never fall through to retained-tombstone cleanup.
      throw new LocalAppRuntimeError(
        options.driftCode ?? 'RELEASE_CHANGED',
        'The ProductSpace Catalog entry kind changed (live drift)',
      )
    }
    if (
      entry.artifactInstanceId !== app.artifactInstanceId
      || entry.version.versionId !== app.versionId
      || entry.version.version !== app.version
    ) {
      // Live drift: the entry STILL EXISTS but its artifact/version differs
      // from the request. This is a LIVE App mismatch — never a tombstone
      // cleanup candidate.
      throw new LocalAppRuntimeError(
        options.driftCode ?? 'RELEASE_CHANGED',
        'The ProductSpace Catalog App identity changed (live drift)',
      )
    }
  }
  await assertProductSpaceAccountCurrent(first)
  return { apps, accessToken, client, context, catalog }
}

function matchesConfirmedRelease(
  request: LocalAppCatalogInstallRequest,
  app: CatalogApp,
  appConfigVersion: string,
  release: AppReleaseSummary,
): boolean {
  const confirmed = request.release
  if (
    !Array.isArray(request.permissions)
    || request.permissions.some(permission => typeof permission !== 'string')
  ) {
    return false
  }
  const confirmedPermissions = normalizeLocalAppPermissions(request.permissions)
  const currentPermissions = normalizeLocalAppPermissions(app.permissions)
  return Boolean(
    confirmed
    && request.appConfigVersion === appConfigVersion
    && confirmedPermissions.length === currentPermissions.length
    && confirmedPermissions.every(
      (permission, index) => permission === currentPermissions[index],
    )
    && confirmed.version === release.version
    && confirmed.runtime === release.runtime
    && confirmed.checksum === release.checksum
    && confirmed.sizeBytes === release.sizeBytes
    && confirmed.platform === (release.platform ?? null)
    && confirmed.arch === (release.arch ?? null),
  )
}

async function resolveCatalogDownload(
  scope: CatalogLocalAppScope,
  release: AppReleaseSummary,
): Promise<{
  downloadUrl: string
  checksum: string
  sizeBytes: number
  platform?: 'darwin' | 'win32' | 'linux'
  arch?: 'arm64' | 'x64'
}> {
  if (!release.id) {
    if (release.downloadUrl) {
      return {
        downloadUrl: release.downloadUrl,
        checksum: release.checksum,
        sizeBytes: release.sizeBytes,
        platform: release.platform,
        arch: release.arch,
      }
    }
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      'The authorized Catalog release has no download identity',
    )
  }

  const tokensBefore = await getCredentialManager().getAdminTokens()
  const adminUrl = getAdminUrl()
  if (!tokensBefore || tokensBefore.userId !== scope.accountId || !adminUrl) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'The Catalog download session is unavailable',
    )
  }
  const download = await new AdminClient(adminUrl).getAppReleaseDownload(
    tokensBefore.accessToken,
    scope.organizationId,
    scope.catalogAppId,
    release.id,
  )

  const tokensAfter = await getCredentialManager().getAdminTokens()
  const current = await requireAuthorizedCatalogApp(scope)
  const currentRelease = current.app.currentRelease
  if (
    !tokensAfter
    || tokensAfter.userId !== tokensBefore.userId
    || tokensAfter.accessToken !== tokensBefore.accessToken
    || !currentRelease
    || currentRelease.id !== release.id
    || currentRelease.version !== release.version
    || currentRelease.runtime !== release.runtime
    || currentRelease.checksum !== release.checksum
    || currentRelease.sizeBytes !== release.sizeBytes
    || currentRelease.platform !== release.platform
    || currentRelease.arch !== release.arch
    || download.releaseId !== release.id
    || download.runtime !== release.runtime
    || download.checksum !== release.checksum
    || download.sizeBytes !== release.sizeBytes
    || download.platform !== release.platform
    || download.arch !== release.arch
  ) {
    throw new LocalAppRuntimeError(
      'RELEASE_CHANGED',
      'The authorized Catalog release changed while requesting a download',
    )
  }
  return download
}

function clearCatalogUpdateState(
  status: LocalAppRuntimeStatus,
): LocalAppRuntimeStatus {
  const {
    availableRelease: _availableRelease,
    versionError: _versionError,
    ...cleared
  } = status
  if (cleared.status === 'update_available') {
    return {
      ...cleared,
      status: cleared.currentVersion ? 'installed' : 'not_installed',
    }
  }
  return cleared
}

function getOwnBusinessIdValue<T>(
  dictionary: Readonly<Record<string, T>> | undefined,
  businessId: string,
): T | undefined {
  if (
    !dictionary
    || !Object.prototype.hasOwnProperty.call(dictionary, businessId)
  ) {
    return undefined
  }
  return dictionary[businessId]
}

function deriveCatalogReleaseStatus(
  status: LocalAppRuntimeStatus,
  app: CatalogApp,
  trustedRelease?: AppReleaseSummary,
): LocalAppRuntimeStatus {
  const release = app.currentRelease
  if (!release) return clearCatalogUpdateState(status)

  const availableVersion = normalizeCatalogSemVer(release.version)
  if (!availableVersion) {
    // Invalid server metadata stays visible without erasing the last trusted
    // update. Installed-like states may expose that retained update as the
    // primary status; running/busy/broken states keep their lifecycle status.
    const retainedRelease = status.availableRelease ?? trustedRelease
    if (!retainedRelease || !status.currentVersion) {
      return { ...status, versionError: 'invalid_semver' }
    }
    const retainedVersion = normalizeCatalogSemVer(retainedRelease.version)
    const installedVersion = normalizeCatalogSemVer(status.currentVersion)
    const exposesUpdateAsPrimaryStatus = (
      status.status === 'installed'
      || status.status === 'stopped'
      || status.status === 'update_available'
    )
    return {
      ...status,
      ...(retainedVersion
        && installedVersion
        && compareCatalogSemVer(retainedVersion, installedVersion) === 1
        ? {
            status: exposesUpdateAsPrimaryStatus
              ? 'update_available' as const
              : status.status,
            availableRelease: retainedRelease,
          }
        : status.availableRelease
          ? { availableRelease: status.availableRelease }
          : {}),
      versionError: 'invalid_semver',
    }
  }
  if (!status.currentVersion) return clearCatalogUpdateState(status)

  const installedVersion = normalizeCatalogSemVer(status.currentVersion)
  if (!installedVersion) {
    return {
      ...status,
      availableRelease: status.availableRelease ?? trustedRelease ?? release,
      versionError: 'invalid_semver',
    }
  }
  if (compareCatalogSemVer(availableVersion, installedVersion) !== 1) {
    return clearCatalogUpdateState(status)
  }

  const { versionError: _versionError, ...current } = status
  const exposesUpdateAsPrimaryStatus = (
    current.status === 'installed'
    || current.status === 'stopped'
    || current.status === 'update_available'
  )
  return {
    ...current,
    status: exposesUpdateAsPrimaryStatus ? 'update_available' : current.status,
    availableRelease: release,
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.localApps.GET_HOST_INFO,
  RPC_CHANNELS.localApps.INSTALL,
  RPC_CHANNELS.localApps.INSTALL_PRODUCT_SPACE_BUNDLE,
  RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_INSTALL_STATES,
  RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_WITHDRAWN_INSTALL_STATES,
  RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE,
  RPC_CHANNELS.localApps.CANCEL_INSTALL,
  RPC_CHANNELS.localApps.START,
  RPC_CHANNELS.localApps.STOP,
  RPC_CHANNELS.localApps.RESTART,
  RPC_CHANNELS.localApps.UNINSTALL,
  RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
  RPC_CHANNELS.localApps.GET_INSTALLED_APPS,
  RPC_CHANNELS.localApps.GET_RUNTIME_STATUS,
  RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES,
  RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
  RPC_CHANNELS.localApps.GET_LOGS,
] as const

export function registerLocalAppHandlers(server: RpcServer, deps?: { windowManager?: HandlerDeps['windowManager'] }): void {
  void server
  // The calling window's Workspace is resolved from the trusted Main-side
  // window registry — never from renderer arguments.
  const callerWorkspaceId = (ctx: { webContentsId?: number | null }): string | null => {
    if (ctx.webContentsId == null) return null
    return deps?.windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? null
  }
  setLegacyLocalAppCleaner(async () => {
    const registry = getScopedLocalAppRuntimeRegistry()
    const failedRefs: string[] = []
    // Enumerate EVERY persisted scope on this device — not only executions in
    // the current registry — so stale Organization-era installation/runtime
    // state cannot survive the direct switch.
    let persistedScopes: CatalogLocalAppScope[] = []
    try {
      persistedScopes = await registry.listAllCatalogScopes()
    } catch {
      failedRefs.push('persisted-scope-enumeration')
    }
    for (const scope of persistedScopes) {
      try {
        await registry.stop(scope)
        // Invalidate installation/runtime state while preserving user data.
        await registry.uninstall(scope, { preserveData: true })
      } catch {
        failedRefs.push(`${scope.organizationId}:${scope.catalogAppId}`)
      }
    }
    for (const execution of listRegisteredProductSpaceExecutions()) {
      if (execution.kind !== 'local_app') continue
      unregisterProductSpaceExecution(execution.scope.executionId)
    }
    return { ok: failedRefs.length === 0, failedRefs }
  })
  server.handle(RPC_CHANNELS.localApps.GET_HOST_INFO, () => ({
    platform: hostPlatform(),
    arch: hostArchitecture(),
  }))

  server.handle(
    RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_INSTALL_STATES,
    async (_ctx, rawApps: unknown): Promise<ProductSpaceAppInstallState[]> => {
      const { apps } = await loadAuthoritativeProductSpaceApps(rawApps)
      const scopes = apps.map(productSpaceBundleScope)
      const statuses = await getScopedLocalAppRuntimeRegistry().getRuntimeStatuses(scopes)
      await assertProductSpaceAccountCurrent(apps[0]!)
      if (statuses.length !== scopes.length) {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'ProductSpace installation state response is incomplete',
        )
      }
      return projectProductSpaceInstallStates(apps, statuses)
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.GET_PRODUCT_SPACE_WITHDRAWN_INSTALL_STATES,
    async (_ctx, rawApps: unknown): Promise<ProductSpaceAppInstallState[]> => {
      const apps = parseProductSpaceAppIdentityBatch(
        rawApps,
        'Withdrawn ProductSpace App identities',
      )
      const first = apps[0]!
      // RESTRICTED withdrawn-management gate: every identity's FULL tuple
      // (catalogEntryId + artifactInstanceId + versionId + version) must
      // come from the Main-owned persisted Catalog authority. A renderer
      // cannot declare an identity withdrawn — fabricated catalog/version
      // tuples or unknown artifact instances are rejected before any
      // registry read, so arbitrary local Apps can be neither probed nor
      // targeted. The fresh Catalog stays the only authority for
      // install/start/open.
      assertWithdrawnProductSpaceAppAuthority(apps)
      await assertProductSpaceAccountCurrent(first)
      const scopes = apps.map(productSpaceBundleScope)
      const statuses = await getScopedLocalAppRuntimeRegistry().getRuntimeStatuses(scopes)
      // Post-await fence (same shape as the fresh state channel): the
      // account/space gates are re-verified AFTER the registry await, so a
      // switch or sign-out during the pending read fails the response closed.
      await assertProductSpaceAccountCurrent(first)
      if (statuses.length !== scopes.length) {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'Withdrawn ProductSpace installation state response is incomplete',
        )
      }
      return projectProductSpaceInstallStates(apps, statuses)
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.INSTALL_PRODUCT_SPACE_BUNDLE,
    async (ctx, rawRequest: ProductSpaceBundleInstallRequest) => {
      const rawApp = rawRequest && typeof rawRequest === 'object'
        ? (rawRequest as Partial<ProductSpaceBundleInstallRequest>).app
        : null
      const loaded = await loadAuthoritativeProductSpaceApps([rawApp])
      const app = loaded.apps[0]!
      const entry = loaded.catalog.entries.find(
        candidate => candidate.catalogEntryId === app.catalogEntryId,
      )!
      if (entry.availability !== 'available') {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'This ProductSpace App is not available for installation',
        )
      }
      const launch = await loaded.client.resolveProductSpaceLaunch(
        loaded.accessToken,
        loaded.context,
        loaded.catalog,
        entry.catalogEntryId,
        { platform: hostPlatform(), arch: hostArchitecture() },
      )
      await assertProductSpaceAccountCurrent(app)
      if (
        launch.subject.kind !== 'artifact_instance'
        || launch.subject.artifactType !== 'app'
        || launch.subject.artifactInstanceId !== app.artifactInstanceId
        || launch.subject.versionId !== app.versionId
        || launch.subject.version !== app.version
        || launch.productSpaceId !== app.productSpaceId
        || launch.catalogEntryId !== app.catalogEntryId
        || Date.parse(launch.expiresAt) <= Date.now()
      ) {
        throw new LocalAppRuntimeError(
          'RELEASE_CHANGED',
          'The resolved ProductSpace App launch identity changed',
        )
      }
      if (launch.delivery.kind !== 'bundle') {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          'This ProductSpace App does not use bundle installation',
        )
      }
      return getScopedLocalAppRuntimeRegistry().install({
        scope: productSpaceBundleScope(app),
        version: launch.subject.version,
        downloadUrl: launch.delivery.downloadUrl,
        checksum: launch.delivery.checksum,
        sizeBytes: launch.delivery.sizeBytes,
        platform: hostPlatform(),
        arch: hostArchitecture(),
      }, { signal: ctx.signal })
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.UNINSTALL_PRODUCT_SPACE_BUNDLE,
    async (_ctx, rawApp: unknown, options?: LocalAppUninstallOptions) => {
      // Withdrawn-inclusive uninstall: a withdrawn App is no longer listed in
      // the fresh Catalog, so the authoritative-tuple revalidation cannot
      // apply. Instead the FULL identity tuple (catalogEntryId +
      // artifactInstanceId + versionId + version) MUST come from the
      // Main-owned persisted Catalog authority — a renderer cannot
      // self-declare withdrawn, and fabricated or forged-version identities
      // are rejected BEFORE the registry can touch any installation
      // directory. This path is limited to stop/uninstall/local-data
      // cleanup; it never accepts renderer download or launch data, and
      // install/start/open stay behind the fresh-Catalog availability
      // checks.
      const app = validateProductSpaceAppIdentity(rawApp)
      await assertProductSpaceAccountCurrent(app)
      // LIVE uninstall: the current Catalog is fetched FRESH and
      // schema-validated and the FULL identity
      // (accountId/productSpaceId/catalogEntryId/artifactInstanceId/versionId/
      // version) must match exactly — any drift, missing entry, stale
      // version, 403/401/network or schema failure fails closed BEFORE the
      // registry or any file is touched.
      let liveUninstall = false
      try {
        await loadAuthoritativeProductSpaceApps([rawApp], {
          driftCode: 'CATALOG_IDENTITY_DRIFT',
        })
        liveUninstall = true
      } catch (error) {
        // The ONLY authoritative verdict that may fall back to the
        // no-fresh-Catalog cleanup gate is CATALOG_ENTRY_MISSING — the fresh
        // Catalog itself proved the entry is GONE from the current
        // distribution. A live row that merely DRIFTED
        // (artifactInstanceId/versionId/version/kind mismatch) is a LIVE App
        // mismatch (CATALOG_IDENTITY_DRIFT) and stays fail-closed — it must
        // never fall through to retained-tombstone cleanup. Auth/network/
        // schema/space-state failures also stay fail-closed; a renderer can
        // never self-declare its way onto this path.
        const authoritativeMissing = error instanceof LocalAppRuntimeError
          && error.code === 'CATALOG_ENTRY_MISSING'
        if (!authoritativeMissing) throw error
        assertRetainedTombstoneProductSpaceAppAuthority([app])
      }
      void liveUninstall
      const scope = productSpaceBundleScope(app)
      await getScopedLocalAppRuntimeRegistry().uninstall(scope, options)
      unregisterLocalAppExecutions(scope)
      await assertProductSpaceAccountCurrent(app)
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.INSTALL,
    async (ctx, rawRequest: LocalAppCatalogInstallRequest) => {
      if (!rawRequest || typeof rawRequest !== 'object' || !('scope' in rawRequest)) {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          'An explicit Catalog install scope is required',
        )
      }
      const reference = requireRendererCatalogScope(rawRequest.scope)

      const {
        app,
        appConfigVersion,
        accessMode,
      } = await requireAuthorizedCatalogApp(reference)
      if (accessMode !== 'online') {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'Installing or updating organization apps is unavailable while offline',
        )
      }
      if (!app.currentRelease) {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'The authorized Catalog app has no installable release',
        )
      }
      const release = app.currentRelease
      if (!matchesConfirmedRelease(
        rawRequest,
        app,
        appConfigVersion,
        release,
      )) {
        throw new LocalAppRuntimeError(
          'RELEASE_CHANGED',
          'The authorized Catalog release changed after confirmation',
        )
      }
      if (!normalizeCatalogSemVer(release.version)) {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          'The authorized Catalog release has an invalid SemVer version',
        )
      }
      const download = await resolveCatalogDownload(reference, release)
      return getScopedLocalAppRuntimeRegistry().install({
        scope: reference,
        version: release.version,
        downloadUrl: download.downloadUrl,
        checksum: download.checksum,
        sizeBytes: download.sizeBytes,
        platform: download.platform ?? hostPlatform(),
        arch: download.arch ?? hostArchitecture(),
      }, { signal: ctx.signal })
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.CANCEL_INSTALL,
    (_ctx, reference: unknown) => withCatalogManagementScope(
      reference,
      scope => getScopedLocalAppRuntimeRegistry().cancelInstall(scope),
    ),
  )

  let localAppStartSequence = 0

  const registryStopQuietly = async (scope: CatalogLocalAppScope): Promise<void> => {
    try {
      await getScopedLocalAppRuntimeRegistry().stop(scope)
    } catch {
      // Best-effort rollback of a superseded start.
    }
  }

  const unregisterLocalAppExecutions = (
    scope: CatalogLocalAppScope,
    options?: { workspaceId?: string | null },
  ): void => {
    for (const execution of listRegisteredProductSpaceExecutions()) {
      if (execution.kind !== 'local_app') continue
      if (execution.scope.productSpaceId !== scope.organizationId) continue
      // A workspace-scoped management operation may only unregister the
      // calling workspace's execution; UNINSTALL removes the whole
      // installation and therefore every workspace's execution record.
      if (
        options?.workspaceId
        && execution.scope.workspaceId !== options.workspaceId
      ) continue
      if (
        execution.scope.subject.kind === 'artifact_instance'
        && execution.scope.subject.artifactInstanceId === scope.catalogAppId
      ) {
        unregisterProductSpaceExecution(execution.scope.executionId)
      }
    }
  }

  const registerLocalAppExecution = async (
    scope: CatalogLocalAppScope,
    name: string,
    workspaceId: string | null,
    trustedAccountId: string,
  ): Promise<string> => {
    const accountId = trustedAccountId
    if (!accountId) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'A trusted Admin session is required to start a ProductSpace app',
      )
    }
    if (!workspaceId) {
      // The shared contract requires an immutable accountId+ProductSpace+
      // Workspace scope: an app start without a resolvable caller Workspace
      // can never be attributed, so it is refused instead of placeholder-bound.
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'The calling window has no Workspace context for this app start',
      )
    }
    const registry = getScopedLocalAppRuntimeRegistry()
    // Every start is a distinct execution with its own immutable scope.
    const executionId = `local-app:${scope.organizationId}:${scope.catalogAppId}:${Date.now()}-${++localAppStartSequence}`
    // R33-3/R34-3: real owner-scoped status projection. The runtime status
    // is probed asynchronously (isActive), so the last observed lifecycle is
    // cached for the synchronous getStatus provider; a dispatched stop
    // projects 'stopping' until the terminal outcome. The Local App runtime
    // has no waiting_for_network state — its pre-running startup state is
    // 'starting', which projects as 'preparing'.
    let lastObservedStatus: 'preparing' | 'running' = 'running'
    let stopDispatched = false
    // R34 minor: the scope is validated through the shared runtime schema —
    // no double assertions, no malformed identifiers can reach the registry.
    const executionScope = ProductSpaceExecutionScopeSchema.parse({
      contractVersion: PRODUCT_SPACE_CONTRACT_VERSION,
      executionId,
      accountId,
      productSpaceId: scope.organizationId,
      workspaceId,
      subject: {
        kind: 'artifact_instance',
        artifactType: 'app',
        artifactInstanceId: scope.catalogAppId,
        versionId: scope.catalogAppId,
        version: name,
      },
    })
    const execution: RegisteredProductSpaceExecution = {
      scope: executionScope,
      kind: 'local_app',
      name,
      ref: executionId,
      generation: 0,
      isActive: async () => {
        try {
          const status = await registry.getRuntimeStatus(scope)
          // R34-3: 'starting' is a genuine non-terminal startup state — a
          // preparing App must stay registered, visible to LIST/PREPARE and
          // blocking switches exactly like a running one. Only a terminal
          // runtime status (stopped/broken/not_installed/...) ends the
          // execution; the probe failure branch below stays fail-closed.
          lastObservedStatus = status.status === 'running' ? 'running' : 'preparing'
          return status.status === 'running' || status.status === 'starting'
        } catch {
          // Liveness probe failure fails closed: treat as still active.
          return true
        }
      },
      getStatus: () => (stopDispatched ? 'stopping' : lastObservedStatus),
      stop: async () => {
        stopDispatched = true
        try {
          await registry.stop(scope)
          return 'stopped'
        } catch {
          return 'failed'
        }
      },
    }
    try {
      registerProductSpaceExecution(execution)
    } catch (error) {
      // Registration failure must not leave an unregistered running runtime.
      await registry.stop(scope).catch(() => {})
      throw error
    }
    return executionId
  }

  // Every entry that can reach running/preparing shares this atomic
  // start-and-register path.
  const startAndRegisterLocalApp = async (
    scope: CatalogLocalAppScope,
    startRuntime: () => Promise<{ version: string }>,
    workspaceId: string | null,
  ) => {
    // GLOBAL LOCK ORDER: capture the trusted-start gate (resolves the
    // trusted Admin account) BEFORE the switch lock — the Admin session
    // lock must never be acquired while holding the switch lock, because
    // account replacement holds the Admin lock while revoking the fence
    // through the switch lock.
    const gate = await captureTrustedStartGate()
    if (!gate) {
      throw new LocalAppRuntimeError(
        'PRODUCT_SPACE_CONTEXT_REQUIRED',
        'The committed ProductSpace belongs to a different account',
      )
    }
    // Runs under the same mutex as PREPARE_SWITCH/COMMIT_SWITCH: a switch
    // transaction cannot interleave with a starting app, and the app cannot
    // slip past a switch that begins while its runtime boots. The critical
    // section is all in-memory: the shared trusted-start gate (mirror
    // account, account generation, transition epoch, account-bound fence)
    // and fence checks never acquire the Admin session lock.
    return withSwitchLock(async () => {
      const activeProductSpaceId = getRuntimeActiveProductSpace()
      if (!activeProductSpaceId || isRuntimeOfflineReadOnly()) {
        throw new LocalAppRuntimeError(
          'PRODUCT_SPACE_CONTEXT_REQUIRED',
          'No committed ProductSpace is active on this device',
        )
      }
      // R32-3: a read_only-restricted space starts no Local App work.
      if (isRuntimeProductSpaceRestricted(activeProductSpaceId)) {
        throw new LocalAppRuntimeError(
          'PRODUCT_SPACE_CONTEXT_REQUIRED',
          'The ProductSpace is restricted to read-only access',
        )
      }
      // A fence committed for another (replaced) account is never startable,
      // and a concurrent account transition fails the start closed.
      if (!isTrustedStartGateCurrent(gate)) {
        throw new LocalAppRuntimeError(
          'PRODUCT_SPACE_CONTEXT_REQUIRED',
          'The committed ProductSpace belongs to a different account',
        )
      }
      if (isSwitchInProgress()) {
        throw new LocalAppRuntimeError(
          'SWITCH_IN_PROGRESS',
          'Apps cannot start while a ProductSpace switch is being committed',
        )
      }
      assertScopeInsideActiveProductSpace(scope)
      const result = await startRuntime()

      // Re-verify under the lock after the runtime booted: if a switch or an
      // account replacement began while the start was in flight, the runtime
      // is stopped again and never registered — no orphan execution of the
      // origin space or the replaced account survives.
      if (
        isSwitchInProgress()
        || getRuntimeActiveProductSpace() !== scope.organizationId
        || !isTrustedStartGateCurrent(gate)
      ) {
        await registryStopQuietly(scope)
        throw new LocalAppRuntimeError(
          'SWITCH_IN_PROGRESS',
          'A ProductSpace switch superseded this start',
        )
      }
      await registerLocalAppExecution(scope, result.version, workspaceId, gate.accountId)
      return result
    })
  }

  const startCatalogApp = (ctx: { webContentsId?: number | null }, scope: CatalogLocalAppScope) => {
    return (async () => {
      const { accessMode } = await requireAuthorizedCatalogApp(scope)
      const registry = getScopedLocalAppRuntimeRegistry()
      if (accessMode === 'offline' && !await registry.isInstalledAndReady(scope)) {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'Only installed and prepared organization apps can start while offline',
        )
      }
      return startAndRegisterLocalApp(scope, () => registry.start(scope), callerWorkspaceId(ctx))
    })()
  }

  server.handle(RPC_CHANNELS.localApps.START, (ctx, reference: unknown) =>
    withCatalogScope(
      reference,
      scope => startCatalogApp(ctx, scope),
    ))

  server.handle(RPC_CHANNELS.localApps.STOP, (ctx, reference: unknown) =>
    withCatalogManagementScope(
      reference,
      async (scope, catalogReference) => {
        const status = await getScopedLocalAppRuntimeRegistry().stop(scope)
        // Only the calling workspace's execution record dies with this stop.
        unregisterLocalAppExecutions(scope, { workspaceId: callerWorkspaceId(ctx) })
        return projectLocalAppStatusForCatalogAccess(
          status,
          catalogReference.canAccessDeliveryMetadata
            && canAccessCatalogDeliveryMetadata(scope),
        )
      },
    ))

  server.handle(RPC_CHANNELS.localApps.RESTART, (ctx, reference: unknown) =>
    withCatalogScope(
      reference,
      async scope => {
        const { accessMode } = await requireAuthorizedCatalogApp(scope)
        const registry = getScopedLocalAppRuntimeRegistry()
        if (accessMode === 'offline' && !await registry.isInstalledAndReady(scope)) {
          throw new LocalAppRuntimeError(
            'NOT_AUTHORIZED',
            'Only installed and prepared organization apps can restart while offline',
          )
        }
        unregisterLocalAppExecutions(scope, { workspaceId: callerWorkspaceId(ctx) })
        return startAndRegisterLocalApp(scope, () => registry.restart(scope), callerWorkspaceId(ctx))
      },
    ))

  server.handle(
    RPC_CHANNELS.localApps.UNINSTALL,
    (_ctx, reference: unknown, options?: LocalAppUninstallOptions) =>
      withCatalogManagementScope(
        reference,
        async scope => {
          const result = await getScopedLocalAppRuntimeRegistry()
            .uninstall(scope, options)
          unregisterLocalAppExecutions(scope)
          return result
        },
      ),
  )

  server.handle(
    RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
    (_ctx, reference: unknown, _requestedRelease: LocalAppAvailableRelease | null) =>
      withCatalogScope(
        reference,
        async scope => {
          const { app } = await requireAuthorizedCatalogApp(scope)
          const registry = getScopedLocalAppRuntimeRegistry()
          const status = await registry.getRuntimeStatus(scope)
          if (!status.currentVersion) return status
          const availableVersion = app.currentRelease
            ? normalizeCatalogSemVer(app.currentRelease.version)
            : null
          const installedVersion = normalizeCatalogSemVer(status.currentVersion)
          if (
            (app.currentRelease && !availableVersion)
            || !installedVersion
          ) {
            // Keep the last trusted update metadata instead of accepting a
            // renderer-requested clear when either side is invalid.
            return { ...status, versionError: 'invalid_semver' }
          }
          const release = app.currentRelease
            && availableVersion
            && compareCatalogSemVer(availableVersion, installedVersion) === 1
            ? app.currentRelease
            : null
          return registry.setAvailableRelease(scope, release)
        },
      ),
  )

  server.handle(
    RPC_CHANNELS.localApps.GET_INSTALLED_APPS,
    (_ctx, reference: unknown) => withCatalogManagementScope(
      reference,
      async (scope, catalogReference) => {
        const statuses = await getScopedLocalAppRuntimeRegistry()
          .getInstalledApps(scope)
        const canAccessDeliveryMetadata = (
          catalogReference.canAccessDeliveryMetadata
          && canAccessCatalogDeliveryMetadata(scope)
        )
        return statuses.map(status => projectLocalAppStatusForCatalogAccess(
          status,
          canAccessDeliveryMetadata,
        ))
      },
    ),
  )

  server.handle(
    RPC_CHANNELS.localApps.GET_RUNTIME_STATUS,
    (_ctx, reference: unknown) => withCatalogManagementScope(
      reference,
      async (scope, catalogReference) =>
        projectLocalAppStatusForCatalogAccess(
          await getScopedLocalAppRuntimeRegistry().getRuntimeStatus(scope),
          catalogReference.canAccessDeliveryMetadata
            && canAccessCatalogDeliveryMetadata(scope),
        ),
    ),
  )

  server.handle(
    RPC_CHANNELS.localApps.GET_RUNTIME_STATUSES,
    async (_ctx, rawRequest: LocalAppBatchStatusRequest) => {
      if (
        !rawRequest
        || typeof rawRequest !== 'object'
        || !Array.isArray(rawRequest.scopes)
        || rawRequest.scopes.length > MAX_CATALOG_STATUS_SCOPES
      ) {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          `At most ${MAX_CATALOG_STATUS_SCOPES} catalog app scopes may be queried`,
        )
      }
      if (rawRequest.scopes.length === 0) return []

      const scopes = rawRequest.scopes.map(requireRendererCatalogScope)
      const first = scopes[0]!
      await requireTrustedCatalogAccount(first)
      if (scopes.some(scope => (
        scope.accountId !== first.accountId
        || scope.organizationId !== first.organizationId
      ))) {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          'A batch status request must target one account and organization',
        )
      }

      // Deliberately one cache read for the entire 10,000-item batch.
      const catalog = getCachedAppCatalog(first.accountId, first.organizationId)
      if (!catalog) {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'Catalog data is unavailable for this account and organization',
        )
      }
      const localApps = new Map(getAppCatalogApps(catalog)
        .filter(app => app.deliveryMode === 'local_bundle')
        .map(app => [app.id, app]))
      if (scopes.some(scope => !localApps.has(scope.catalogAppId))) {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'A batch status scope is not present in the account Catalog cache',
        )
      }
      const statuses = await getScopedLocalAppRuntimeRegistry()
        .getRuntimeStatuses(scopes)
      const catalogCanAccessDeliveryMetadata = (
        catalog.authorizationStatus === 'authorized'
        && getAppCatalogAccessMode(first.accountId, first.organizationId) !== 'denied'
      )
      return statuses.map((status, index) => {
        const app = localApps.get(scopes[index]!.catalogAppId)!
        const canAccessDeliveryMetadata = (
          catalogCanAccessDeliveryMetadata
          && app.availability === 'available'
          && isCatalogAppLifecycleAuthorized(scopes[index]!)
        )
        const derived = canAccessDeliveryMetadata
          ? deriveCatalogReleaseStatus(
              status,
              app,
              getOwnBusinessIdValue(
                catalog.trustedReleases,
                scopes[index]!.catalogAppId,
              ),
            )
          : status
        return projectLocalAppStatusForCatalogAccess(
          derived,
          canAccessDeliveryMetadata,
        )
      })
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.RESOLVE_REMOTE_URL,
    async (_ctx, rawScope: unknown) => {
      // Same trusted active-ProductSpace gate as every other renderer
      // business scope: null fence, offline read-only, and cross-space
      // scopes are all rejected before any authorization entry is read.
      const scope = requireRendererCatalogScope(rawScope)
      const { app } = await requireAuthorizedCatalogEntry(scope)
      if (app.deliveryMode !== 'remote_url' || !app.remoteUrl) {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          'The authorized Catalog app is not a remote URL app',
        )
      }
      return {
        appId: app.id,
        scope,
        url: app.remoteUrl,
      }
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.GET_LOGS,
    (_ctx, reference: unknown, options?: LocalAppLogsOptions) =>
      withCatalogManagementScope(
        reference,
        async (scope, catalogReference) => {
          const registry = getScopedLocalAppRuntimeRegistry()
          if (catalogReference.canAccessDeliveryMetadata) {
            return registry.getFailureRecoveryLogs(scope, options)
          }
          const logs = await registry.getRetainedManagementLogs(scope, options)
          // Retained access is a capability of the denied/withdrawn snapshot,
          // not a reusable read token. Re-check synchronously after the
          // bounded tail completes so re-authorization cannot publish healthy
          // runtime logs from a request admitted under the older snapshot.
          if (canAccessCatalogDeliveryMetadata(scope)) {
            throw new LocalAppRuntimeError(
              'NOT_AUTHORIZED',
              'Organization app log authorization changed during the request',
            )
          }
          return logs
        },
      ),
  )
}
