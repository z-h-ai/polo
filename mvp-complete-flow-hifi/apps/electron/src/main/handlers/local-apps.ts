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
} from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import {
  getScopedLocalAppRuntimeRegistry,
  LocalAppRuntimeError,
  MAX_CATALOG_STATUS_SCOPES,
  validateCatalogLocalAppScope,
} from '../local-app-runtime'

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
  return validateCatalogLocalAppScope(reference)
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

export function registerLocalAppHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.localApps.GET_HOST_INFO, () => ({
    platform: hostPlatform(),
    arch: hostArchitecture(),
  }))

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

  const startCatalogApp = async (scope: CatalogLocalAppScope) => {
    const { accessMode } = await requireAuthorizedCatalogApp(scope)
    const registry = getScopedLocalAppRuntimeRegistry()
    if (accessMode === 'offline' && !await registry.isInstalledAndReady(scope)) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'Only installed and prepared organization apps can start while offline',
      )
    }
    return registry.start(scope)
  }

  server.handle(RPC_CHANNELS.localApps.START, (_ctx, reference: unknown) =>
    withCatalogScope(
      reference,
      startCatalogApp,
    ))

  server.handle(RPC_CHANNELS.localApps.STOP, (_ctx, reference: unknown) =>
    withCatalogManagementScope(
      reference,
      async (scope, catalogReference) =>
        projectLocalAppStatusForCatalogAccess(
          await getScopedLocalAppRuntimeRegistry().stop(scope),
          catalogReference.canAccessDeliveryMetadata
            && canAccessCatalogDeliveryMetadata(scope),
        ),
    ))

  server.handle(RPC_CHANNELS.localApps.RESTART, (_ctx, reference: unknown) =>
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
        return registry.restart(scope)
      },
    ))

  server.handle(
    RPC_CHANNELS.localApps.UNINSTALL,
    (_ctx, reference: unknown, options?: LocalAppUninstallOptions) =>
      withCatalogManagementScope(
        reference,
        scope => getScopedLocalAppRuntimeRegistry().uninstall(scope, options),
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
      const scope = validateCatalogLocalAppScope(rawScope)
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
