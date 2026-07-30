import {
  getAppCatalogAccessMode,
  getAppCatalogApps,
  getCachedAppCatalog,
  type AppReleaseSummary,
  type CatalogApp,
} from '@polo-ai/shared/admin'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type {
  CatalogLocalAppScope,
  LegacyLocalAppScope,
  LocalAppAvailableRelease,
  LocalAppBatchStatusRequest,
  LocalAppLegacyInstallRequest,
  LocalAppLogsOptions,
  LocalAppReference,
  LocalAppRpcInstallRequest,
  LocalAppRuntimeStatus,
  LocalAppUninstallOptions,
} from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { gt, valid } from 'semver'
import {
  getLocalAppRuntimeManager,
  getScopedLocalAppRuntimeRegistry,
  LocalAppRuntimeError,
  MAX_CATALOG_STATUS_SCOPES,
  validateCatalogLocalAppScope,
} from '../local-app-runtime'

function requireReference(reference: unknown): LocalAppReference {
  if (!reference || typeof reference !== 'object') {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      'An explicit local app scope is required',
    )
  }
  if ((reference as LocalAppReference).kind === 'legacy') {
    const appId = (reference as LegacyLocalAppScope).appId
    if (typeof appId !== 'string' || !appId) {
      throw new LocalAppRuntimeError('INVALID_REQUEST', 'legacy scope.appId is required')
    }
    return { kind: 'legacy', appId }
  }
  return validateCatalogLocalAppScope(reference)
}

async function requireTrustedCatalogAccount(scope: CatalogLocalAppScope): Promise<void> {
  const tokens = await getCredentialManager().getAdminTokens()
  if (!tokens || tokens.userId !== scope.accountId) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'The local app belongs to a different or signed-out account',
    )
  }
}

interface AuthorizedCatalogApp {
  app: CatalogApp
  accessMode: 'online' | 'offline' | 'denied'
}

async function requireAuthorizedCatalogEntry(
  scope: CatalogLocalAppScope,
): Promise<AuthorizedCatalogApp> {
  await requireTrustedCatalogAccount(scope)
  const catalog = getCachedAppCatalog(scope.accountId, scope.organizationId)
  const app = catalog
    ? getAppCatalogApps(catalog).find(candidate => candidate.id === scope.catalogAppId)
    : undefined
  const accessMode = getAppCatalogAccessMode(scope.accountId, scope.organizationId)
  if (
    !catalog
    || catalog.authorizationStatus !== 'authorized'
    || !app
    || app.availability !== 'available'
    || accessMode === 'denied'
  ) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'This organization app is no longer authorized for installation or launch',
    )
  }
  return { app, accessMode }
}

async function requireAuthorizedCatalogApp(
  scope: CatalogLocalAppScope,
): Promise<AuthorizedCatalogApp> {
  const { app, accessMode } = await requireAuthorizedCatalogEntry(scope)
  if (app.deliveryMode !== 'local_bundle') {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      'Remote URL apps cannot use the local bundle runtime',
    )
  }
  return { app, accessMode }
}

async function withReference<T>(
  rawReference: unknown,
  catalogOperation: (scope: CatalogLocalAppScope) => Promise<T>,
  legacyOperation: (appId: string) => Promise<T> | T,
): Promise<T> {
  const reference = requireReference(rawReference)
  if (reference.kind === 'legacy') return legacyOperation(reference.appId)
  await requireTrustedCatalogAccount(reference)
  return catalogOperation(reference)
}

function legacyInstallRequest(request: LocalAppLegacyInstallRequest) {
  if (request.scope.appId !== request.appId) {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      'Install appId does not match the explicit legacy scope',
    )
  }
  const { scope: _scope, ...managerRequest } = request
  return managerRequest
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

function normalizedCatalogVersion(version: string): string | null {
  return valid(version.trim().replace(/^v(?=\d)/i, ''), { loose: false })
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

function deriveCatalogReleaseStatus(
  status: LocalAppRuntimeStatus,
  app: CatalogApp,
  trustedRelease?: AppReleaseSummary,
): LocalAppRuntimeStatus {
  const release = app.currentRelease
  if (!release) return clearCatalogUpdateState(status)

  const availableVersion = normalizedCatalogVersion(release.version)
  if (!availableVersion) {
    const retainedRelease = status.availableRelease ?? trustedRelease
    if (!retainedRelease || !status.currentVersion) {
      return { ...status, versionError: 'invalid_semver' }
    }
    const retainedVersion = normalizedCatalogVersion(retainedRelease.version)
    const installedVersion = normalizedCatalogVersion(status.currentVersion)
    const exposesUpdateAsPrimaryStatus = (
      status.status === 'installed'
      || status.status === 'stopped'
      || status.status === 'update_available'
    )
    return {
      ...status,
      ...(retainedVersion && installedVersion && gt(retainedVersion, installedVersion)
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

  const installedVersion = normalizedCatalogVersion(status.currentVersion)
  if (!installedVersion) {
    return {
      ...status,
      availableRelease: status.availableRelease ?? trustedRelease ?? release,
      versionError: 'invalid_semver',
    }
  }
  if (!gt(availableVersion, installedVersion)) {
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
    async (ctx, rawRequest: LocalAppRpcInstallRequest) => {
      if (!rawRequest || typeof rawRequest !== 'object' || !('scope' in rawRequest)) {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          'An explicit catalog or legacy install scope is required',
        )
      }
      const reference = requireReference(rawRequest.scope)
      if (reference.kind === 'legacy') {
        return getLocalAppRuntimeManager().install(
          legacyInstallRequest(rawRequest as LocalAppLegacyInstallRequest),
          { signal: ctx.signal },
        )
      }

      const { app, accessMode } = await requireAuthorizedCatalogApp(reference)
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
      if (!normalizedCatalogVersion(release.version)) {
        throw new LocalAppRuntimeError(
          'INVALID_REQUEST',
          'The authorized Catalog release has an invalid SemVer version',
        )
      }
      return getScopedLocalAppRuntimeRegistry().install({
        scope: reference,
        version: release.version,
        downloadUrl: release.downloadUrl,
        checksum: release.checksum,
        sizeBytes: release.sizeBytes,
        platform: release.platform ?? hostPlatform(),
        arch: release.arch ?? hostArchitecture(),
      }, { signal: ctx.signal })
    },
  )

  server.handle(
    RPC_CHANNELS.localApps.CANCEL_INSTALL,
    (_ctx, reference: unknown) => withReference(
      reference,
      scope => getScopedLocalAppRuntimeRegistry().cancelInstall(scope),
      appId => getLocalAppRuntimeManager().cancelInstall(appId),
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
    withReference(
      reference,
      startCatalogApp,
      appId => getLocalAppRuntimeManager().start(appId),
    ))

  server.handle(RPC_CHANNELS.localApps.STOP, (_ctx, reference: unknown) =>
    withReference(
      reference,
      scope => getScopedLocalAppRuntimeRegistry().stop(scope),
      appId => getLocalAppRuntimeManager().stop(appId),
    ))

  server.handle(RPC_CHANNELS.localApps.RESTART, (_ctx, reference: unknown) =>
    withReference(
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
      appId => getLocalAppRuntimeManager().restart(appId),
    ))

  server.handle(
    RPC_CHANNELS.localApps.UNINSTALL,
    (_ctx, reference: unknown, options?: LocalAppUninstallOptions) =>
      withReference(
        reference,
        scope => getScopedLocalAppRuntimeRegistry().uninstall(scope, options),
        appId => getLocalAppRuntimeManager().uninstall(appId, options),
      ),
  )

  server.handle(
    RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
    (_ctx, reference: unknown, requestedRelease: LocalAppAvailableRelease | null) =>
      withReference(
        reference,
        async scope => {
          const { app } = await requireAuthorizedCatalogApp(scope)
          const registry = getScopedLocalAppRuntimeRegistry()
          const status = await registry.getRuntimeStatus(scope)
          if (!status.currentVersion) return status
          const availableVersion = app.currentRelease
            ? normalizedCatalogVersion(app.currentRelease.version)
            : null
          const installedVersion = normalizedCatalogVersion(status.currentVersion)
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
            && gt(availableVersion, installedVersion)
            ? app.currentRelease
            : null
          return registry.setAvailableRelease(scope, release)
        },
        appId => getLocalAppRuntimeManager().setAvailableRelease(appId, requestedRelease),
      ),
  )

  server.handle(
    RPC_CHANNELS.localApps.GET_INSTALLED_APPS,
    (_ctx, reference: unknown) => withReference(
      reference,
      scope => getScopedLocalAppRuntimeRegistry().getInstalledApps(scope),
      appId => getLocalAppRuntimeManager().getInstalledApps()
        .then(apps => apps.filter(app => app.appId === appId)),
    ),
  )

  server.handle(
    RPC_CHANNELS.localApps.GET_RUNTIME_STATUS,
    (_ctx, reference: unknown) => withReference(
      reference,
      scope => getScopedLocalAppRuntimeRegistry().getRuntimeStatus(scope),
      appId => getLocalAppRuntimeManager().getRuntimeStatus(appId),
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

      const scopes = rawRequest.scopes.map(validateCatalogLocalAppScope)
      const first = scopes[0]!
      const tokens = await getCredentialManager().getAdminTokens()
      if (!tokens || tokens.userId !== first.accountId) {
        throw new LocalAppRuntimeError('NOT_AUTHORIZED', 'Catalog status account is not signed in')
      }
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
      if (!catalog || catalog.authorizationStatus !== 'authorized') {
        throw new LocalAppRuntimeError('NOT_AUTHORIZED', 'Catalog authorization is unavailable')
      }
      const localApps = new Map(getAppCatalogApps(catalog)
        .filter(app => app.deliveryMode === 'local_bundle')
        .map(app => [app.id, app]))
      if (scopes.some(scope => !localApps.has(scope.catalogAppId))) {
        throw new LocalAppRuntimeError(
          'NOT_AUTHORIZED',
          'A batch status scope is not present in the authorized Catalog',
        )
      }
      const statuses = await getScopedLocalAppRuntimeRegistry()
        .getRuntimeStatuses(scopes)
      return statuses.map((status, index) => deriveCatalogReleaseStatus(
        status,
        localApps.get(scopes[index]!.catalogAppId)!,
        catalog.trustedReleases?.[scopes[index]!.catalogAppId],
      ))
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
      withReference(
        reference,
        scope => getScopedLocalAppRuntimeRegistry().getLogs(scope, options),
        appId => getLocalAppRuntimeManager().getLogs(appId, options),
      ),
  )
}
