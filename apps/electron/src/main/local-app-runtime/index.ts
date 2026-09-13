import { app } from 'electron'
import { join } from 'path'
import { AdminClient } from '@polo-ai/shared/admin'
import {
  getDefaultLlmConnection,
  getAdminUrl,
  getWorkspaceByNameOrId,
} from '@polo-ai/shared/config'
import { loadWorkspaceConfig } from '@polo-ai/shared/workspaces'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import { createSessionlessHostLlmExecutor } from '@polo-ai/shared/agent/host-llm-executor'
import { mainLog } from '../logger'
import { LocalAppRuntimeManager } from './manager'
import { ScopedLocalAppRuntimeRegistry } from './scoped-registry'
import {
  catalogRuntimeScopeTupleKey,
  LocalAppRuntimeCoordinator,
  type RuntimeCoordinatorAdapters,
} from './runtime-coordinator'

let manager: LocalAppRuntimeManager | null = null
let scopedRegistry: ScopedLocalAppRuntimeRegistry | null = null
let coordinator: LocalAppRuntimeCoordinator | null = null

const runtimeLogger = {
  info: (message: string, details?: unknown) => mainLog.info(message, details),
  warn: (message: string, details?: unknown) => mainLog.warn(message, details),
  error: (message: string, details?: unknown) => mainLog.error(message, details),
}

function localAppsRoot(): string {
  return join(app.getPath('userData'), 'local-apps')
}

export function getLocalAppRuntimeManager(): LocalAppRuntimeManager {
  if (!manager) {
    manager = new LocalAppRuntimeManager({
      rootDir: localAppsRoot(),
      uvPath: process.env.POLO_AI_UV,
      bunPath: process.env.POLO_AI_BUN,
      logger: runtimeLogger,
    })
  }
  return manager
}

export function getScopedLocalAppRuntimeRegistry(): ScopedLocalAppRuntimeRegistry {
  if (!scopedRegistry) {
    scopedRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: localAppsRoot(),
      uvPath: process.env.POLO_AI_UV,
      bunPath: process.env.POLO_AI_BUN,
      logger: runtimeLogger,
      onUnexpectedExit: event => {
        void getLocalAppRuntimeCoordinator().handleUnexpectedExit(event)
          .catch(error => mainLog.error('[local-apps] unexpected exit teardown failed', error))
      },
    })
  }
  return scopedRegistry
}

/**
 * Production runtime coordinator: wires the trusted POL-102 AdminClient
 * boundary, the sessionless Host LLM executor factory and the workspace
 * root/connection resolution into the shared coordinator. The stopRuntime
 * adapter routes teardown process stops through the scoped registry's
 * exact-generation CAS so every stop entry keeps the unified
 * revoke→abort→cleanup→stop→CAS-clear order.
 */
export function getLocalAppRuntimeCoordinator(): LocalAppRuntimeCoordinator {
  if (!coordinator) {
    const adapters: RuntimeCoordinatorAdapters = {
      admin: {
        startAppRun: async (input, options) => {
          const client = await createTrustedAdminClient()
          return client.startAppRun(await trustedAccessToken(), input, options)
        },
        recordAppUsage: async (input, options) => {
          const client = await createTrustedAdminClient()
          return client.recordAppUsage(await trustedAccessToken(), input, options)
        },
        finishAppRun: async (runId, input, options) => {
          const client = await createTrustedAdminClient()
          return client.finishAppRun(await trustedAccessToken(), runId, input, options)
        },
      },
      createExecutor: ({ connectionSlug, model }) => createSessionlessHostLlmExecutor({
        connectionSlug,
        ...(model ? { model } : {}),
      }),
      resolveWorkspaceRoot: workspaceId =>
        getWorkspaceByNameOrId(workspaceId)?.rootPath ?? null,
      loadWorkspaceConfig: rootPath => loadWorkspaceConfig(rootPath),
      getDefaultLlmConnection: () => getDefaultLlmConnection(),
      stopRuntime: async runtime => {
        await getScopedLocalAppRuntimeRegistry().stopExact(
          {
            kind: 'catalog',
            accountId: runtime.identity.accountId,
            organizationId: runtime.identity.productSpaceId,
            catalogAppId: runtime.identity.artifactInstanceId,
          },
          runtime.runtimeGeneration,
        )
      },
    }
    coordinator = new LocalAppRuntimeCoordinator(adapters)
  }
  return coordinator
}

export function hasLocalAppRuntimeCoordinator(): boolean {
  return coordinator !== null
}

const runtimeScopeKey = (accountId: string, productSpaceId: string, artifactInstanceId: string): string =>
  catalogRuntimeScopeTupleKey({ accountId, productSpaceId, artifactInstanceId })

/**
 * Unified coordinator-aware teardown for scope withdrawals: revokes the
 * capability, aborts in-flight work, runs the bounded cleanup lane, stops
 * the exact process generation, clears the projection and releases state —
 * before any registry-level stop runs.
 */
export function teardownCoordinatorRuntimesForCatalogScopes(
  scopes: ReadonlyArray<{
    accountId: string
    organizationId: string
    catalogAppId: string
  }>,
  finalStatus: 'cancelled' | 'failed' | 'unknown' = 'cancelled',
): Promise<void> {
  if (!hasLocalAppRuntimeCoordinator()) return Promise.resolve()
  const keys = new Set(scopes.map(scope =>
    runtimeScopeKey(scope.accountId, scope.organizationId, scope.catalogAppId)))
  return getLocalAppRuntimeCoordinator().teardownRuntimesFor(
    runtime => keys.has(runtimeScopeKey(
      runtime.identity.accountId,
      runtime.identity.productSpaceId,
      runtime.identity.artifactInstanceId,
    )),
    finalStatus,
  )
}

export function teardownCoordinatorRuntimesForOrganization(
  accountId: string,
  organizationId: string,
  finalStatus: 'cancelled' | 'failed' | 'unknown' = 'cancelled',
): Promise<void> {
  if (!hasLocalAppRuntimeCoordinator()) return Promise.resolve()
  return getLocalAppRuntimeCoordinator().teardownRuntimesFor(
    runtime => runtime.identity.accountId === accountId
      && runtime.identity.productSpaceId === organizationId,
    finalStatus,
  )
}

export function teardownCoordinatorRuntimesForAccount(
  accountId: string,
  finalStatus: 'cancelled' | 'failed' | 'unknown' = 'cancelled',
): Promise<void> {
  if (!hasLocalAppRuntimeCoordinator()) return Promise.resolve()
  return getLocalAppRuntimeCoordinator().teardownRuntimesFor(
    runtime => runtime.identity.accountId === accountId,
    finalStatus,
  )
}

async function trustedAccessToken(): Promise<string> {
  const tokens = await getCredentialManager().getAdminTokens()
  if (!tokens) throw new Error('No trusted Admin session for App runtime billing')
  return tokens.accessToken
}

async function createTrustedAdminClient(): Promise<AdminClient> {
  const adminUrl = getAdminUrl()
  if (!adminUrl) throw new Error('Polo Admin is not configured')
  return new AdminClient(adminUrl)
}

export function hasLocalAppRuntimeManager(): boolean {
  return manager !== null || scopedRegistry !== null
}

export async function shutdownLocalAppRuntime(): Promise<void> {
  // Strict order: the coordinator first revokes every capability, aborts
  // App-owned work, runs the bounded cleanup lane and stops the exact
  // process generations; only then do the manager/registry shut down their
  // remaining lifecycle state.
  await coordinator?.shutdown()
  const results = await Promise.allSettled([
    manager?.shutdown(),
    scopedRegistry?.shutdown(),
  ])
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failure) throw failure.reason
}

export { LocalAppRuntimeManager } from './manager'
export { LocalAppRuntimeError } from './runtime-error'
export { validatePoloAppManifest } from './manifest'
export {
  createCatalogLocalAppScopeKey,
  createCatalogRuntimeAppId,
  MAX_CATALOG_STATUS_SCOPES,
  PERSISTED_SCOPE_READ_CONCURRENCY,
  ScopedLocalAppRuntimeRegistry,
  validateCatalogLocalAppScope,
} from './scoped-registry'
export { catalogRuntimeScopeTupleKey } from './runtime-coordinator'
export { LocalAppRuntimeCoordinator } from './runtime-coordinator'
export type { RuntimeCoordinatorAdapters } from './runtime-coordinator'
export { AppApiCapabilityRegistry } from './app-api-capabilities'
export { AppApiRunState } from './app-api-run-state'
export { AppApiGateway } from './app-api-gateway'
