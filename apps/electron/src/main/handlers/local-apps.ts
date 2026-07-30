import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type {
  LocalAppAvailableRelease,
  LocalAppInstallRequest,
  LocalAppLogsOptions,
  LocalAppReference,
  LocalAppScope,
  LocalAppUninstallOptions,
} from '@polo-ai/shared/protocol'
import { getCachedAppCatalog } from '@polo-ai/shared/admin'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import type { RpcServer } from '@polo-ai/server-core/transport'
import {
  getLocalAppRuntimeManager,
  getScopedLocalAppRuntimeRegistry,
  LocalAppRuntimeError,
  validateCatalogLocalAppScope,
} from '../local-app-runtime'

type CatalogScope = Extract<LocalAppScope, { kind: 'catalog' }>

function catalogScopeFromReference(reference: LocalAppReference): CatalogScope | null {
  if (typeof reference === 'string') return null
  if (reference.kind === 'legacy') return null
  return validateCatalogLocalAppScope(reference)
}

function legacyAppIdFromReference(reference: LocalAppReference): string {
  if (typeof reference === 'string') return reference
  if (reference.kind === 'legacy') return reference.appId
  throw new LocalAppRuntimeError(
    'INVALID_REQUEST',
    'Catalog app reference cannot use the legacy runtime namespace',
  )
}

async function assertScopeAccount(scope: CatalogScope): Promise<void> {
  const tokens = await getCredentialManager().getAdminTokens()
  if (!tokens || tokens.userId !== scope.accountId) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'The local app belongs to a different or signed-out account',
    )
  }
}

async function assertCatalogLifecycleAuthorized(scope: CatalogScope): Promise<void> {
  await assertScopeAccount(scope)
  const catalog = getCachedAppCatalog(scope.accountId, scope.organizationId)
  const app = catalog?.apps.find(candidate => candidate.id === scope.catalogAppId)
  if (
    !catalog
    || catalog.authorizationStatus !== 'authorized'
    || !app
    || app.availability !== 'available'
  ) {
    throw new LocalAppRuntimeError(
      'NOT_AUTHORIZED',
      'This organization app is no longer authorized for installation or launch',
    )
  }
}

async function withReference<T>(
  reference: LocalAppReference,
  options: { requireCatalogAuthorization?: boolean },
  catalogOperation: (scope: CatalogScope) => Promise<T>,
  legacyOperation: (appId: string) => Promise<T> | T,
): Promise<T> {
  const scope = catalogScopeFromReference(reference)
  if (!scope) return legacyOperation(legacyAppIdFromReference(reference))
  if (options.requireCatalogAuthorization) {
    await assertCatalogLifecycleAuthorized(scope)
  } else {
    await assertScopeAccount(scope)
  }
  return catalogOperation(scope)
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
  RPC_CHANNELS.localApps.GET_LOGS,
  RPC_CHANNELS.localApps.STOP_ACCOUNT,
] as const

export function registerLocalAppHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.localApps.GET_HOST_INFO, () => ({
    platform: process.platform,
    arch: process.arch,
  }))
  server.handle(RPC_CHANNELS.localApps.INSTALL, async (ctx, request: LocalAppInstallRequest) => {
    const scope = request.scope ? catalogScopeFromReference(request.scope) : null
    if (
      request.scope?.kind === 'legacy'
      && request.scope.appId !== request.appId
    ) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'Install appId does not match the legacy scope',
      )
    }
    if (!scope) return getLocalAppRuntimeManager().install(request, { signal: ctx.signal })
    await assertCatalogLifecycleAuthorized(scope)
    return getScopedLocalAppRuntimeRegistry().install(request, { signal: ctx.signal })
  })
  server.handle(
    RPC_CHANNELS.localApps.CANCEL_INSTALL,
    (_ctx, reference: LocalAppReference) => withReference(
      reference,
      {},
      scope => getScopedLocalAppRuntimeRegistry().cancelInstall(scope),
      appId => getLocalAppRuntimeManager().cancelInstall(appId),
    ),
  )
  server.handle(RPC_CHANNELS.localApps.START, (_ctx, reference: LocalAppReference) =>
    withReference(
      reference,
      { requireCatalogAuthorization: true },
      scope => getScopedLocalAppRuntimeRegistry().start(scope),
      appId => getLocalAppRuntimeManager().start(appId),
    ))
  server.handle(RPC_CHANNELS.localApps.STOP, (_ctx, reference: LocalAppReference) =>
    withReference(
      reference,
      {},
      scope => getScopedLocalAppRuntimeRegistry().stop(scope),
      appId => getLocalAppRuntimeManager().stop(appId),
    ))
  server.handle(RPC_CHANNELS.localApps.RESTART, (_ctx, reference: LocalAppReference) =>
    withReference(
      reference,
      { requireCatalogAuthorization: true },
      scope => getScopedLocalAppRuntimeRegistry().restart(scope),
      appId => getLocalAppRuntimeManager().restart(appId),
    ))
  server.handle(
    RPC_CHANNELS.localApps.UNINSTALL,
    (_ctx, reference: LocalAppReference, options?: LocalAppUninstallOptions) =>
      withReference(
        reference,
        {},
        scope => getScopedLocalAppRuntimeRegistry().uninstall(scope, options),
        appId => getLocalAppRuntimeManager().uninstall(appId, options),
      ),
  )
  server.handle(
    RPC_CHANNELS.localApps.SET_AVAILABLE_RELEASE,
    (_ctx, reference: LocalAppReference, release: LocalAppAvailableRelease | null) =>
      withReference(
        reference,
        { requireCatalogAuthorization: true },
        scope => getScopedLocalAppRuntimeRegistry().setAvailableRelease(scope, release),
        appId => getLocalAppRuntimeManager().setAvailableRelease(appId, release),
      ),
  )
  server.handle(
    RPC_CHANNELS.localApps.GET_INSTALLED_APPS,
    (_ctx, reference?: LocalAppReference) => reference
      ? withReference(
          reference,
          {},
          scope => getScopedLocalAppRuntimeRegistry().getInstalledApps(scope),
          appId => getLocalAppRuntimeManager().getInstalledApps()
            .then(apps => apps.filter(app => app.appId === appId)),
        )
      : getLocalAppRuntimeManager().getInstalledApps(),
  )
  server.handle(
    RPC_CHANNELS.localApps.GET_RUNTIME_STATUS,
    (_ctx, reference: LocalAppReference) => withReference(
      reference,
      {},
      scope => getScopedLocalAppRuntimeRegistry().getRuntimeStatus(scope),
      appId => getLocalAppRuntimeManager().getRuntimeStatus(appId),
    ),
  )
  server.handle(
    RPC_CHANNELS.localApps.GET_LOGS,
    (_ctx, reference: LocalAppReference, options?: LocalAppLogsOptions) =>
      withReference(
        reference,
        {},
        scope => getScopedLocalAppRuntimeRegistry().getLogs(scope, options),
        appId => getLocalAppRuntimeManager().getLogs(appId, options),
      ),
  )
  server.handle(RPC_CHANNELS.localApps.STOP_ACCOUNT, async (_ctx, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) {
      throw new LocalAppRuntimeError('INVALID_REQUEST', 'accountId is required')
    }
    const tokens = await getCredentialManager().getAdminTokens()
    if (tokens && tokens.userId !== accountId) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'Cannot stop local apps owned by another account',
      )
    }
    await getScopedLocalAppRuntimeRegistry().stopAccount(accountId)
  })
}
