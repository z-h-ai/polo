import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  LocalAppAvailableRelease,
  LocalAppArchitecture,
  LocalAppInstallRequest,
  LocalAppInstalledApp,
  LocalAppPlatform,
  LocalAppRuntimeStatus,
  LocalAppScope,
  LocalAppStartResult,
  LocalAppUninstallOptions,
} from '@polo-ai/shared/protocol'
import { AdminEntityIdSchema } from '@polo-ai/shared/admin/schemas'
import { normalizeCatalogSemVer } from '@polo-ai/shared/admin/semver'
import {
  LocalAppRuntimeManager,
  type LocalAppRuntimeLogger,
  type LocalAppRuntimeManagerOptions,
} from './manager'
import { LocalAppRuntimeError } from './runtime-error'

const SCOPE_SCHEMA_VERSION = 1
export const STOP_CLEANUP_CONCURRENCY = 8
const STATUS_READ_CONCURRENCY = 8
export const PERSISTED_SCOPE_READ_CONCURRENCY = 8
export const MAX_CATALOG_STATUS_SCOPES = 10_000

export type CatalogLocalAppScope = Extract<LocalAppScope, { kind: 'catalog' }>

interface PersistedScope {
  schemaVersion: typeof SCOPE_SCHEMA_VERSION
  scope: CatalogLocalAppScope
}

export interface ScopedLocalAppRuntimeRegistryOptions {
  rootDir: string
  uvPath?: string
  bunPath?: string
  logger?: LocalAppRuntimeLogger
  managerFactory?: (options: LocalAppRuntimeManagerOptions) => LocalAppRuntimeManager
  /** Test/embedding seam; production reads UTF-8 scope records from disk. */
  scopeRecordReader?: (path: string) => Promise<string>
}

export interface ScopedCatalogInstallRequest {
  scope: CatalogLocalAppScope
  version: string
  downloadUrl: string
  checksum: string
  sizeBytes: number
  platform: LocalAppPlatform
  arch: LocalAppArchitecture
}

interface ScopeOperationLifecyclePolicy {
  organization: boolean
  app: boolean
}

const ACCOUNT_SCOPED_OPERATION: ScopeOperationLifecyclePolicy = {
  organization: false,
  app: false,
}

const AUTHORIZED_APP_LIFECYCLE_OPERATION: ScopeOperationLifecyclePolicy = {
  organization: true,
  app: true,
}

function validateScopeField(value: unknown, field: string): string {
  const parsed = AdminEntityIdSchema.safeParse(value)
  if (!parsed.success) {
    throw new LocalAppRuntimeError('INVALID_REQUEST', `${field} is invalid`)
  }
  return parsed.data
}

export function validateCatalogLocalAppScope(scope: unknown): CatalogLocalAppScope {
  if (!scope || typeof scope !== 'object' || (scope as LocalAppScope).kind !== 'catalog') {
    throw new LocalAppRuntimeError('INVALID_REQUEST', 'Catalog local app scope is required')
  }
  const value = scope as CatalogLocalAppScope
  const catalogAppId = validateScopeField(value.catalogAppId, 'scope.catalogAppId')
  return {
    kind: 'catalog',
    accountId: validateScopeField(value.accountId, 'scope.accountId'),
    organizationId: validateScopeField(value.organizationId, 'scope.organizationId'),
    catalogAppId,
  }
}

export function createCatalogLocalAppScopeKey(scope: CatalogLocalAppScope): string {
  const safeScope = validateCatalogLocalAppScope(scope)
  const digest = createHash('sha256')
    .update(JSON.stringify([
      safeScope.accountId,
      safeScope.organizationId,
      safeScope.catalogAppId,
    ]))
    .digest('hex')
  return `catalog-${digest}`
}

/** Filesystem/process-safe identity used exclusively inside POO-12. */
export const createCatalogRuntimeAppId = createCatalogLocalAppScopeKey

function scopesEqual(left: CatalogLocalAppScope, right: CatalogLocalAppScope): boolean {
  return left.accountId === right.accountId
    && left.organizationId === right.organizationId
    && left.catalogAppId === right.catalogAppId
}

function createOrganizationLifecycleKey(
  accountId: string,
  organizationId: string,
): string {
  return JSON.stringify([accountId, organizationId])
}

function attachScope<T extends { appId: string }>(
  value: T,
  scope: CatalogLocalAppScope,
): T & { scope: CatalogLocalAppScope } {
  return {
    ...value,
    appId: scope.catalogAppId,
    scope,
  }
}

export class ScopedLocalAppRuntimeRegistry {
  private readonly scopesDir: string
  private readonly uvPath?: string
  private readonly bunPath?: string
  private readonly logger?: LocalAppRuntimeLogger
  private readonly managerFactory: (
    options: LocalAppRuntimeManagerOptions,
  ) => LocalAppRuntimeManager
  private readonly scopeRecordReader: (path: string) => Promise<string>
  private readonly managers = new Map<string, LocalAppRuntimeManager>()
  private readonly managerScopes = new Map<string, CatalogLocalAppScope>()
  private readonly managerPromises = new Map<
    string,
    Promise<LocalAppRuntimeManager | null>
  >()
  private readonly sessionEndingAccounts = new Set<string>()
  private readonly deniedOrganizations = new Set<string>()
  private readonly deniedApps = new Set<string>()
  private readonly accountLifecycleGenerations = new Map<string, number>()
  private readonly organizationLifecycleGenerations = new Map<string, number>()
  private readonly appLifecycleGenerations = new Map<string, number>()
  private readonly accountOperations = new Map<
    string,
    Map<Promise<unknown>, CatalogLocalAppScope>
  >()
  private readonly organizationOperations = new Map<
    string,
    Map<Promise<unknown>, CatalogLocalAppScope>
  >()
  private readonly appOperations = new Map<
    string,
    Map<Promise<unknown>, CatalogLocalAppScope>
  >()
  private readonly stopAccountPromises = new Map<string, Promise<void>>()
  private readonly stopOrganizationPromises = new Map<string, Promise<void>>()
  private readonly stopAppPromises = new Map<string, Promise<void>>()
  private readonly failedAppCleanups = new Set<string>()
  private stopCleanupSlotsInUse = 0
  private readonly stopCleanupSlotWaiters: Array<() => void> = []
  private persistedScopeReadSlotsInUse = 0
  private readonly persistedScopeReadSlotWaiters: Array<() => void> = []

  constructor(options: ScopedLocalAppRuntimeRegistryOptions) {
    this.scopesDir = join(resolve(options.rootDir), 'catalog-scopes')
    this.uvPath = options.uvPath
    this.bunPath = options.bunPath
    this.logger = options.logger
    this.managerFactory = options.managerFactory
      ?? (managerOptions => new LocalAppRuntimeManager(managerOptions))
    this.scopeRecordReader = options.scopeRecordReader
      ?? (path => readFile(path, 'utf8'))
  }

  async install(
    request: ScopedCatalogInstallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalAppInstalledApp> {
    if (!normalizeCatalogSemVer(request.version)) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'Catalog local app version must be strict SemVer',
      )
    }
    return this.runTrackedScopeOperation(
      request.scope,
      AUTHORIZED_APP_LIFECYCLE_OPERATION,
      async scope => {
        const manager = await this.getManager(scope)
        this.assertAccountSessionActive(scope.accountId)
        const runtimeAppId = createCatalogRuntimeAppId(scope)
        const { scope: _scope, ...release } = request
        const managerRequest: LocalAppInstallRequest = {
          ...release,
          appId: runtimeAppId,
          expectedManifestAppId: scope.catalogAppId,
        }
        const installed = await manager.install(
          managerRequest,
          options,
        )
        return attachScope(installed, scope)
      },
    )
  }

  async cancelInstall(scope: CatalogLocalAppScope): Promise<boolean> {
    return this.runTrackedScopeOperation(
      scope,
      ACCOUNT_SCOPED_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        this.assertAccountSessionActive(safeScope.accountId)
        return manager.cancelInstall(createCatalogRuntimeAppId(safeScope))
      },
    )
  }

  async start(scope: CatalogLocalAppScope): Promise<LocalAppStartResult> {
    return this.runTrackedScopeOperation(
      scope,
      AUTHORIZED_APP_LIFECYCLE_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        this.assertAccountSessionActive(safeScope.accountId)
        return attachScope(
          await manager.start(createCatalogRuntimeAppId(safeScope)),
          safeScope,
        )
      },
    )
  }

  async stop(scope: CatalogLocalAppScope): Promise<LocalAppRuntimeStatus> {
    return this.runTrackedScopeOperation(
      scope,
      ACCOUNT_SCOPED_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        this.assertAccountSessionActive(safeScope.accountId)
        return attachScope(
          await manager.stop(createCatalogRuntimeAppId(safeScope)),
          safeScope,
        )
      },
    )
  }

  async restart(scope: CatalogLocalAppScope): Promise<LocalAppStartResult> {
    return this.runTrackedScopeOperation(
      scope,
      AUTHORIZED_APP_LIFECYCLE_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        this.assertAccountSessionActive(safeScope.accountId)
        return attachScope(
          await manager.restart(createCatalogRuntimeAppId(safeScope)),
          safeScope,
        )
      },
    )
  }

  async uninstall(
    scope: CatalogLocalAppScope,
    options?: LocalAppUninstallOptions,
  ): Promise<void> {
    await this.runTrackedScopeOperation(
      scope,
      ACCOUNT_SCOPED_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        this.assertAccountSessionActive(safeScope.accountId)
        await manager.uninstall(createCatalogRuntimeAppId(safeScope), options)
      },
    )
  }

  async setAvailableRelease(
    scope: CatalogLocalAppScope,
    release: LocalAppAvailableRelease | null,
  ): Promise<LocalAppRuntimeStatus> {
    return this.runTrackedScopeOperation(
      scope,
      ACCOUNT_SCOPED_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        this.assertAccountSessionActive(safeScope.accountId)
        return attachScope(
          await manager.setAvailableRelease(
            createCatalogRuntimeAppId(safeScope),
            release,
          ),
          safeScope,
        )
      },
    )
  }

  async getInstalledApps(
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppInstalledApp[]> {
    return this.runTrackedScopeOperation(
      scope,
      ACCOUNT_SCOPED_OPERATION,
      async safeScope => {
        const manager = await this.getExistingManager(safeScope)
        if (!manager) return []
        return (await manager.getInstalledApps())
          .map(app => attachScope(app, safeScope))
      },
    )
  }

  async getRuntimeStatus(
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeStatus> {
    return (await this.getRuntimeStatuses([scope]))[0]!
  }

  async getRuntimeStatuses(
    rawScopes: CatalogLocalAppScope[],
  ): Promise<LocalAppRuntimeStatus[]> {
    if (!Array.isArray(rawScopes) || rawScopes.length > MAX_CATALOG_STATUS_SCOPES) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        `At most ${MAX_CATALOG_STATUS_SCOPES} catalog app scopes may be queried`,
      )
    }
    const scopes = rawScopes.map(validateCatalogLocalAppScope)
    return this.runTrackedScopesOperation(
      scopes,
      ACCOUNT_SCOPED_OPERATION,
      async () => {
        const statuses = new Array<LocalAppRuntimeStatus>(scopes.length)
        let nextIndex = 0
        const workers = Array.from(
          { length: Math.min(STATUS_READ_CONCURRENCY, scopes.length) },
          async () => {
            while (nextIndex < scopes.length) {
              const index = nextIndex++
              const scope = scopes[index]!
              const manager = await this.getExistingManager(scope)
              statuses[index] = manager
                ? attachScope(
                    await manager.getRuntimeStatus(createCatalogRuntimeAppId(scope)),
                    scope,
                  )
                : {
                    appId: scope.catalogAppId,
                    scope,
                    status: 'not_installed',
                  }
            }
          },
        )
        await Promise.all(workers)
        return statuses
      },
    )
  }

  async isInstalledAndReady(scope: CatalogLocalAppScope): Promise<boolean> {
    const status = await this.getRuntimeStatus(scope)
    return Boolean(
      status.currentVersion
      && status.status !== 'not_installed'
      && status.status !== 'downloading'
      && status.status !== 'installing'
      && status.status !== 'broken',
    )
  }

  async getRetainedCatalogAppIds(
    accountId: string,
    organizationId: string,
  ): Promise<ReadonlySet<string>> {
    const safeAccountId = validateScopeField(accountId, 'accountId')
    const safeOrganizationId = validateScopeField(
      organizationId,
      'organizationId',
    )
    const scopes = await this.readPersistedScopes({
      accountId: safeAccountId,
      organizationId: safeOrganizationId,
    })
    const retained = new Set<string>()
    for (
      let offset = 0;
      offset < scopes.length;
      offset += MAX_CATALOG_STATUS_SCOPES
    ) {
      const batch = scopes.slice(offset, offset + MAX_CATALOG_STATUS_SCOPES)
      const statuses = await this.getRuntimeStatuses(batch)
      statuses.forEach((status, index) => {
        if (status.status !== 'not_installed') {
          retained.add(batch[index]!.catalogAppId)
        }
      })
    }
    return retained
  }

  private async getExistingManager(
    rawScope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeManager | null> {
    const scope = validateCatalogLocalAppScope(rawScope)
    const key = createCatalogLocalAppScopeKey(scope)
    const existing = this.managers.get(key)
    if (existing) return existing
    const pending = this.managerPromises.get(key)
    if (pending) return pending

    const managerPromise = this.loadExistingManager(key, scope)
      .finally(() => {
        if (this.managerPromises.get(key) === managerPromise) {
          this.managerPromises.delete(key)
        }
      })
    this.managerPromises.set(key, managerPromise)
    return managerPromise
  }

  private async loadExistingManager(
    key: string,
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeManager | null> {
    const rootDir = join(this.scopesDir, key)
    const persisted = await this.readScopeRecord(join(rootDir, 'scope.json'))
    if (!persisted) return null
    if (!scopesEqual(persisted, scope)) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'Local app scope key does not match its persisted identity',
      )
    }
    try {
      await readFile(
        join(rootDir, 'apps', createCatalogRuntimeAppId(scope), 'metadata.json'),
        'utf8',
      )
    } catch {
      // A prior cancelled/failed install may have written scope.json. A status
      // read must not instantiate a manager for that non-installation.
      return null
    }
    const manager = this.managerFactory({
      rootDir,
      uvPath: this.uvPath,
      bunPath: this.bunPath,
      logger: this.logger,
    })
    this.managers.set(key, manager)
    this.managerScopes.set(key, scope)
    return manager
  }

  async getLogs(
    scope: CatalogLocalAppScope,
    options?: { tail?: number },
  ): Promise<string> {
    return this.runTrackedScopeOperation(
      scope,
      ACCOUNT_SCOPED_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        return manager.getLogs(createCatalogRuntimeAppId(safeScope), options)
      },
    )
  }

  async getFailureRecoveryLogs(
    scope: CatalogLocalAppScope,
    options?: { tail?: number },
  ): Promise<string> {
    return this.runTrackedScopeOperation(
      scope,
      ACCOUNT_SCOPED_OPERATION,
      async safeScope => {
        const manager = await this.getManager(safeScope)
        return manager.getFailureRecoveryLogs(
          createCatalogRuntimeAppId(safeScope),
          options,
        )
      },
    )
  }

  async stopAccount(accountId: string): Promise<void> {
    const safeAccountId = validateScopeField(accountId, 'accountId')
    this.sessionEndingAccounts.add(safeAccountId)
    const existingStop = this.stopAccountPromises.get(safeAccountId)
    if (existingStop) return existingStop
    this.accountLifecycleGenerations.set(
      safeAccountId,
      this.getAccountLifecycleGeneration(safeAccountId) + 1,
    )
    const stopPromise = this.performStopScopes(safeAccountId)
      .finally(() => {
        if (this.stopAccountPromises.get(safeAccountId) === stopPromise) {
          this.stopAccountPromises.delete(safeAccountId)
        }
      })
    this.stopAccountPromises.set(safeAccountId, stopPromise)
    return stopPromise
  }

  async stopOrganization(
    accountId: string,
    organizationId: string,
  ): Promise<void> {
    const safeAccountId = validateScopeField(accountId, 'accountId')
    const safeOrganizationId = validateScopeField(
      organizationId,
      'organizationId',
    )
    const organizationKey = createOrganizationLifecycleKey(
      safeAccountId,
      safeOrganizationId,
    )
    // Establish the organization fence and advance its non-reusable
    // generation before any manager, filesystem, or operation await.
    this.deniedOrganizations.add(organizationKey)
    const existingStop = this.stopOrganizationPromises.get(organizationKey)
    if (existingStop) return existingStop
    this.organizationLifecycleGenerations.set(
      organizationKey,
      this.getOrganizationLifecycleGeneration(organizationKey) + 1,
    )
    const stopPromise = this.performStopScopes(
      safeAccountId,
      safeOrganizationId,
    ).finally(() => {
      if (this.stopOrganizationPromises.get(organizationKey) === stopPromise) {
        this.stopOrganizationPromises.delete(organizationKey)
        // Catalog access remains denied in the main-process authorization
        // gate. Once cleanup is quiescent, a later fresh authorized sync may
        // safely enter with the already-advanced organization generation.
        this.deniedOrganizations.delete(organizationKey)
      }
    })
    this.stopOrganizationPromises.set(organizationKey, stopPromise)
    return stopPromise
  }

  stopApps(scopes: CatalogLocalAppScope[]): Promise<void> {
    const scopesByKey = new Map<string, CatalogLocalAppScope>()
    for (const rawScope of scopes) {
      const scope = validateCatalogLocalAppScope(rawScope)
      scopesByKey.set(createCatalogLocalAppScopeKey(scope), scope)
    }

    const pendingCleanups = new Set<Promise<void>>()
    const newScopes: CatalogLocalAppScope[] = []
    // Bulk withdrawal invariant: every exact App gate and generation advances
    // in this synchronous loop. No scan, manager lookup, cancellation, or stop
    // may yield until the full withdrawn set is fenced.
    for (const [appKey, scope] of scopesByKey) {
      this.deniedApps.add(appKey)
      this.appLifecycleGenerations.set(
        appKey,
        this.getAppLifecycleGeneration(appKey) + 1,
      )
      const existing = this.stopAppPromises.get(appKey)
      if (existing) {
        pendingCleanups.add(existing)
      } else {
        newScopes.push(scope)
      }
    }

    if (newScopes.length === 0) {
      return Promise.all(pendingCleanups).then(() => {})
    }

    const cleanupControls = new Map<string, {
      scope: CatalogLocalAppScope
      resolve: () => void
      reject: (error: unknown) => void
    }>()
    for (const scope of newScopes) {
      const appKey = createCatalogLocalAppScopeKey(scope)
      let resolveCleanup!: () => void
      let rejectCleanup!: (error: unknown) => void
      const cleanup = new Promise<void>((resolve, reject) => {
        resolveCleanup = resolve
        rejectCleanup = reject
      })
      cleanupControls.set(appKey, {
        scope,
        resolve: resolveCleanup,
        reject: rejectCleanup,
      })
      this.stopAppPromises.set(appKey, cleanup)
      pendingCleanups.add(cleanup)
      void cleanup.then(() => {
        this.failedAppCleanups.delete(appKey)
        if (this.stopAppPromises.get(appKey) === cleanup) {
          this.stopAppPromises.delete(appKey)
        }
      }, () => {
        this.failedAppCleanups.add(appKey)
        if (this.stopAppPromises.get(appKey) === cleanup) {
          this.stopAppPromises.delete(appKey)
        }
      })
    }

    void this.performStopAppScopes(newScopes).then(failuresByApp => {
      for (const [appKey, control] of cleanupControls) {
        const failures = failuresByApp.get(appKey) ?? []
        if (failures.length === 0) {
          control.resolve()
        } else {
          control.reject(new LocalAppRuntimeError(
            'STOP_FAILED',
            `Failed to stop scoped local app ${control.scope.catalogAppId}`,
            { failures },
          ))
        }
      }
    }, error => {
      for (const control of cleanupControls.values()) {
        control.reject(error)
      }
    })

    return Promise.allSettled([...pendingCleanups]).then(results => {
      const failures = results.flatMap(result => (
        result.status === 'rejected' ? [result.reason] : []
      ))
      if (failures.length > 0) {
        throw new LocalAppRuntimeError(
          'STOP_FAILED',
          `Failed to stop ${failures.length} scoped local app(s)`,
          { failures },
        )
      }
    })
  }

  authorizeApps(scopes: CatalogLocalAppScope[]): void {
    const safeScopes = scopes.map(validateCatalogLocalAppScope)
    for (const scope of safeScopes) {
      const appKey = createCatalogLocalAppScopeKey(scope)
      const lifecycleGeneration = this.getAppLifecycleGeneration(appKey)
      const cleanup = this.stopAppPromises.get(appKey)
      if (!cleanup) {
        if (!this.failedAppCleanups.has(appKey)) {
          this.deniedApps.delete(appKey)
        }
        continue
      }
      void cleanup.then(() => {
        // A cache commit may re-authorize an App while its prior withdrawal
        // cleanup is still running. Release only after that cleanup succeeds,
        // and only if no later withdrawal advanced the App lifecycle again.
        if (
          this.getAppLifecycleGeneration(appKey) === lifecycleGeneration
          && !this.stopAppPromises.has(appKey)
        ) {
          this.deniedApps.delete(appKey)
        }
      }, () => {
        // Failed cleanup retains the deny gate. A later successful Catalog
        // sync may retry authorization after cleanup recovery.
      })
    }
  }

  assertAppAuthorized(rawScope: CatalogLocalAppScope): void {
    this.assertAppSessionActive(validateCatalogLocalAppScope(rawScope))
  }

  resumeAccount(accountId: string): void {
    const safeAccountId = validateScopeField(accountId, 'accountId')
    if (this.stopAccountPromises.has(safeAccountId)) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'Cannot resume a local app account while session cleanup is active',
      )
    }
    this.sessionEndingAccounts.delete(safeAccountId)
    this.accountLifecycleGenerations.set(
      safeAccountId,
      this.getAccountLifecycleGeneration(safeAccountId) + 1,
    )
  }

  private async performStopScopes(
    safeAccountId: string,
    safeOrganizationId?: string,
    safeCatalogAppId?: string,
  ): Promise<void> {
    const appKey = safeOrganizationId === undefined || safeCatalogAppId === undefined
      ? null
      : createCatalogLocalAppScopeKey({
          kind: 'catalog',
          accountId: safeAccountId,
          organizationId: safeOrganizationId,
          catalogAppId: safeCatalogAppId,
        })
    const organizationKey = safeOrganizationId === undefined
      ? null
      : createOrganizationLifecycleKey(safeAccountId, safeOrganizationId)
    const tracked = appKey
      ? this.appOperations.get(appKey)
      : organizationKey
        ? this.organizationOperations.get(organizationKey)
        : this.accountOperations.get(safeAccountId)
    const trackedOperations = [...(tracked?.keys() ?? [])]
    const trackedScopes = [...(tracked?.values() ?? [])]
    const failures: string[] = []

    await this.runStopCleanupWorkers(
      trackedScopes,
      async scope => {
        const key = createCatalogLocalAppScopeKey(scope)
        const pendingManager = this.managerPromises.get(key)
        if (pendingManager) await pendingManager
        this.managers.get(key)?.cancelInstall(createCatalogRuntimeAppId(scope))
      },
      failures,
    )

    const operationResults = await Promise.allSettled(trackedOperations)
    failures.push(...operationResults.flatMap(result => {
      if (result.status !== 'rejected') return []
      const reason = result.reason
      if (
        reason instanceof LocalAppRuntimeError
        && (reason.code === 'INSTALL_CANCELLED' || reason.code === 'NOT_AUTHORIZED')
      ) {
        return []
      }
      return [reason instanceof Error ? reason.message : String(reason)]
    }))

    const scopesByKey = new Map<string, CatalogLocalAppScope>()
    for (const scope of [
      ...this.managerScopes.values(),
      ...await this.readPersistedScopes({
        accountId: safeAccountId,
        organizationId: safeOrganizationId,
        catalogAppId: safeCatalogAppId,
      }),
    ]) {
      scopesByKey.set(createCatalogLocalAppScopeKey(scope), scope)
    }
    const scopes = [...scopesByKey.values()]
      .filter(scope => (
        scope.accountId === safeAccountId
        && (
          safeOrganizationId === undefined
          || scope.organizationId === safeOrganizationId
        )
        && (
          safeCatalogAppId === undefined
          || scope.catalogAppId === safeCatalogAppId
        )
      ))
    await this.runStopCleanupWorkers(
      scopes,
      async scope => {
        const manager = await this.getExistingManager(scope)
          ?? this.managers.get(createCatalogLocalAppScopeKey(scope))
        if (!manager) return
        manager.cancelInstall(createCatalogRuntimeAppId(scope))
        await manager.stop(createCatalogRuntimeAppId(scope))
      },
      failures,
    )
    if (failures.length > 0) {
      throw new LocalAppRuntimeError(
        'STOP_FAILED',
        `Failed to stop ${failures.length} scoped local app(s)`,
        { failures },
      )
    }
  }

  private async performStopAppScopes(
    scopes: CatalogLocalAppScope[],
  ): Promise<Map<string, string[]>> {
    const targets = new Map(
      scopes.map(scope => [createCatalogLocalAppScopeKey(scope), scope]),
    )
    const failuresByApp = new Map(
      [...targets.keys()].map(appKey => [appKey, [] as string[]]),
    )
    const addFailure = (appKey: string, error: unknown) => {
      const failures = failuresByApp.get(appKey)
      if (!failures) return
      failures.push(error instanceof Error ? error.message : String(error))
    }
    const trackedOperations = new Map<Promise<unknown>, Set<string>>()
    const cancellationScopes = new Map<string, CatalogLocalAppScope>()
    for (const [appKey, scope] of targets) {
      cancellationScopes.set(appKey, scope)
      for (const [operation, trackedScope] of (
        this.appOperations.get(appKey) ?? []
      )) {
        const operationAppKeys = trackedOperations.get(operation) ?? new Set()
        operationAppKeys.add(appKey)
        trackedOperations.set(operation, operationAppKeys)
        cancellationScopes.set(
          createCatalogLocalAppScopeKey(trackedScope),
          trackedScope,
        )
      }
    }

    await this.runStopCleanupWorkersByScope(
      [...cancellationScopes.values()],
      async scope => {
        const appKey = createCatalogLocalAppScopeKey(scope)
        const pendingManager = this.managerPromises.get(appKey)
        if (pendingManager) await pendingManager
        this.managers.get(appKey)?.cancelInstall(
          createCatalogRuntimeAppId(scope),
        )
      },
      (scope, error) => addFailure(createCatalogLocalAppScopeKey(scope), error),
    )

    const trackedEntries = [...trackedOperations]
    const operationResults = await Promise.allSettled(
      trackedEntries.map(([operation]) => operation),
    )
    operationResults.forEach((result, index) => {
      if (result.status !== 'rejected') return
      const reason = result.reason
      if (
        reason instanceof LocalAppRuntimeError
        && (reason.code === 'INSTALL_CANCELLED' || reason.code === 'NOT_AUTHORIZED')
      ) {
        return
      }
      for (const appKey of trackedEntries[index]![1]) {
        addFailure(appKey, reason)
      }
    })

    const organizationGroups = new Map<string, {
      accountId: string
      organizationId: string
      appKeys: Set<string>
    }>()
    for (const [appKey, scope] of targets) {
      const organizationKey = createOrganizationLifecycleKey(
        scope.accountId,
        scope.organizationId,
      )
      const group = organizationGroups.get(organizationKey)
      if (group) {
        group.appKeys.add(appKey)
      } else {
        organizationGroups.set(organizationKey, {
          accountId: scope.accountId,
          organizationId: scope.organizationId,
          appKeys: new Set([appKey]),
        })
      }
    }
    // Each account/organization is scanned exactly once for the entire bulk
    // withdrawal. Per-App scans would multiply a 10k Catalog update into 10k
    // full directory traversals.
    const persistedGroups = [...organizationGroups.values()]
    const persistedResults = await Promise.allSettled(
      persistedGroups.map(group => (
        this.readPersistedScopes({
          accountId: group.accountId,
          organizationId: group.organizationId,
        })
      )),
    )
    const cleanupScopes = new Map<string, CatalogLocalAppScope>()
    for (const scope of this.managerScopes.values()) {
      const appKey = createCatalogLocalAppScopeKey(scope)
      if (targets.has(appKey)) cleanupScopes.set(appKey, scope)
    }
    persistedResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        for (const appKey of persistedGroups[index]!.appKeys) {
          addFailure(appKey, result.reason)
        }
        return
      }
      for (const scope of result.value) {
        const appKey = createCatalogLocalAppScopeKey(scope)
        if (targets.has(appKey)) cleanupScopes.set(appKey, scope)
      }
    })

    await this.runStopCleanupWorkersByScope(
      [...cleanupScopes.values()],
      async scope => {
        const appKey = createCatalogLocalAppScopeKey(scope)
        const manager = await this.getExistingManager(scope)
          ?? this.managers.get(appKey)
        if (!manager) return
        manager.cancelInstall(createCatalogRuntimeAppId(scope))
        await manager.stop(createCatalogRuntimeAppId(scope))
      },
      (scope, error) => addFailure(createCatalogLocalAppScopeKey(scope), error),
    )
    return failuresByApp
  }

  private async runStopCleanupWorkers(
    scopes: CatalogLocalAppScope[],
    operation: (scope: CatalogLocalAppScope) => Promise<void>,
    failures: string[],
  ): Promise<void> {
    let nextIndex = 0
    const workers = Array.from(
      {
        length: Math.min(STOP_CLEANUP_CONCURRENCY, scopes.length),
      },
      async () => {
        while (nextIndex < scopes.length) {
          const scope = scopes[nextIndex++]!
          try {
            await this.withStopCleanupSlot(() => operation(scope))
          } catch (error) {
            failures.push(error instanceof Error
              ? error.message
              : String(error))
          }
        }
      },
    )
    await Promise.all(workers)
  }

  private async runStopCleanupWorkersByScope(
    scopes: CatalogLocalAppScope[],
    operation: (scope: CatalogLocalAppScope) => Promise<void>,
    onFailure: (scope: CatalogLocalAppScope, error: unknown) => void,
  ): Promise<void> {
    let nextIndex = 0
    const workers = Array.from(
      {
        length: Math.min(STOP_CLEANUP_CONCURRENCY, scopes.length),
      },
      async () => {
        while (nextIndex < scopes.length) {
          const scope = scopes[nextIndex++]!
          try {
            await this.withStopCleanupSlot(() => operation(scope))
          } catch (error) {
            onFailure(scope, error)
          }
        }
      },
    )
    await Promise.all(workers)
  }

  private async withStopCleanupSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopCleanupSlotsInUse < STOP_CLEANUP_CONCURRENCY) {
      this.stopCleanupSlotsInUse += 1
    } else {
      // Slot ownership is handed directly from the releasing operation to this
      // waiter, so concurrent cleanup batches cannot race between a decrement
      // and a later increment and exceed the registry-wide limit.
      await new Promise<void>(resolve => {
        this.stopCleanupSlotWaiters.push(resolve)
      })
    }
    try {
      return await operation()
    } finally {
      const next = this.stopCleanupSlotWaiters.shift()
      if (next) {
        next()
      } else {
        this.stopCleanupSlotsInUse -= 1
      }
    }
  }

  private async withPersistedScopeReadSlot<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.persistedScopeReadSlotsInUse < PERSISTED_SCOPE_READ_CONCURRENCY) {
      this.persistedScopeReadSlotsInUse += 1
    } else {
      // All concurrent account, organization, and App cleanup scans share this
      // slot queue; per-scan worker limits alone do not bound aggregate I/O.
      await new Promise<void>(resolve => {
        this.persistedScopeReadSlotWaiters.push(resolve)
      })
    }
    try {
      return await operation()
    } finally {
      const next = this.persistedScopeReadSlotWaiters.shift()
      if (next) {
        next()
      } else {
        this.persistedScopeReadSlotsInUse -= 1
      }
    }
  }

  private assertAccountSessionActive(accountId: string): void {
    if (this.sessionEndingAccounts.has(accountId)) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'The Admin session for this local app account is ending',
      )
    }
  }

  private assertOrganizationSessionActive(
    accountId: string,
    organizationId: string,
  ): void {
    if (
      this.deniedOrganizations.has(
        createOrganizationLifecycleKey(accountId, organizationId),
      )
    ) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'The organization authorization for this local app is ending',
      )
    }
  }

  private assertAppSessionActive(scope: CatalogLocalAppScope): void {
    if (this.deniedApps.has(createCatalogLocalAppScopeKey(scope))) {
      throw new LocalAppRuntimeError(
        'NOT_AUTHORIZED',
        'The Catalog app authorization is ending',
      )
    }
  }

  private getAccountLifecycleGeneration(accountId: string): number {
    return this.accountLifecycleGenerations.get(accountId) ?? 0
  }

  private getOrganizationLifecycleGeneration(organizationKey: string): number {
    return this.organizationLifecycleGenerations.get(organizationKey) ?? 0
  }

  private getAppLifecycleGeneration(appKey: string): number {
    return this.appLifecycleGenerations.get(appKey) ?? 0
  }

  private runTrackedScopeOperation<T>(
    rawScope: CatalogLocalAppScope,
    lifecyclePolicy: ScopeOperationLifecyclePolicy,
    operation: (scope: CatalogLocalAppScope) => Promise<T>,
  ): Promise<T> {
    const scope = validateCatalogLocalAppScope(rawScope)
    this.assertAccountSessionActive(scope.accountId)
    if (lifecyclePolicy.organization) {
      this.assertOrganizationSessionActive(
        scope.accountId,
        scope.organizationId,
      )
    }
    if (lifecyclePolicy.app) this.assertAppSessionActive(scope)
    return this.runTrackedScopesOperation(
      [scope],
      lifecyclePolicy,
      () => operation(scope),
    )
  }

  private runTrackedScopesOperation<T>(
    scopes: CatalogLocalAppScope[],
    lifecyclePolicy: ScopeOperationLifecyclePolicy,
    operation: () => Promise<T>,
  ): Promise<T> {
    const accounts = new Map<string, CatalogLocalAppScope>()
    const accountLifecycleGenerations = new Map<string, number>()
    const organizations = new Map<string, CatalogLocalAppScope>()
    const organizationLifecycleGenerations = new Map<string, number>()
    const apps = new Map<string, CatalogLocalAppScope>()
    const appLifecycleGenerations = new Map<string, number>()
    for (const scope of scopes) {
      this.assertAccountSessionActive(scope.accountId)
      if (lifecyclePolicy.organization) {
        this.assertOrganizationSessionActive(
          scope.accountId,
          scope.organizationId,
        )
      }
      if (lifecyclePolicy.app) this.assertAppSessionActive(scope)
      if (!accounts.has(scope.accountId)) accounts.set(scope.accountId, scope)
      accountLifecycleGenerations.set(
        scope.accountId,
        this.getAccountLifecycleGeneration(scope.accountId),
      )
      if (lifecyclePolicy.organization) {
        const organizationKey = createOrganizationLifecycleKey(
          scope.accountId,
          scope.organizationId,
        )
        if (!organizations.has(organizationKey)) {
          organizations.set(organizationKey, scope)
        }
        organizationLifecycleGenerations.set(
          organizationKey,
          this.getOrganizationLifecycleGeneration(organizationKey),
        )
      }
      if (lifecyclePolicy.app) {
        const appKey = createCatalogLocalAppScopeKey(scope)
        if (!apps.has(appKey)) apps.set(appKey, scope)
        appLifecycleGenerations.set(
          appKey,
          this.getAppLifecycleGeneration(appKey),
        )
      }
    }
    const assertCapturedLifecycleIsCurrent = () => {
      for (const accountId of accounts.keys()) {
        this.assertAccountSessionActive(accountId)
        if (
          this.getAccountLifecycleGeneration(accountId)
          !== accountLifecycleGenerations.get(accountId)
        ) {
          throw new LocalAppRuntimeError(
            'NOT_AUTHORIZED',
            'The Admin session changed during the local app operation',
          )
        }
      }
      for (const [organizationKey, scope] of organizations) {
        this.assertOrganizationSessionActive(
          scope.accountId,
          scope.organizationId,
        )
        if (
          this.getOrganizationLifecycleGeneration(organizationKey)
          !== organizationLifecycleGenerations.get(organizationKey)
        ) {
          throw new LocalAppRuntimeError(
            'NOT_AUTHORIZED',
            'The organization authorization changed during the local app operation',
          )
        }
      }
      for (const [appKey, scope] of apps) {
        this.assertAppSessionActive(scope)
        if (
          this.getAppLifecycleGeneration(appKey)
          !== appLifecycleGenerations.get(appKey)
        ) {
          throw new LocalAppRuntimeError(
            'NOT_AUTHORIZED',
            'The Catalog app authorization changed during the local app operation',
          )
        }
      }
    }
    let trackedPromise!: Promise<T>
    trackedPromise = Promise.resolve()
      .then(() => {
        assertCapturedLifecycleIsCurrent()
        return operation()
      })
      .then(result => {
        // Install/start/restart capture every authorization fence because their
        // late success can create executable state. Data-management operations
        // deliberately capture only the account fence so withdrawn/denied
        // installs remain inspectable, stoppable, and removable.
        assertCapturedLifecycleIsCurrent()
        return result
      }, error => {
        // Cancellation caused by a newly established authorization fence is
        // exposed uniformly as NOT_AUTHORIZED, not as an install/runtime
        // implementation detail.
        assertCapturedLifecycleIsCurrent()
        throw error
      })
      .finally(() => {
        for (const accountId of accounts.keys()) {
          const operations = this.accountOperations.get(accountId)
          operations?.delete(trackedPromise)
          if (operations?.size === 0) this.accountOperations.delete(accountId)
        }
        for (const organizationKey of organizations.keys()) {
          const operations = this.organizationOperations.get(organizationKey)
          operations?.delete(trackedPromise)
          if (operations?.size === 0) {
            this.organizationOperations.delete(organizationKey)
          }
        }
        for (const appKey of apps.keys()) {
          const operations = this.appOperations.get(appKey)
          operations?.delete(trackedPromise)
          if (operations?.size === 0) this.appOperations.delete(appKey)
        }
      })
    for (const [accountId, scope] of accounts) {
      const operations = this.accountOperations.get(accountId)
        ?? new Map<Promise<unknown>, CatalogLocalAppScope>()
      operations.set(trackedPromise, scope)
      this.accountOperations.set(accountId, operations)
    }
    for (const [organizationKey, scope] of organizations) {
      const operations = this.organizationOperations.get(organizationKey)
        ?? new Map<Promise<unknown>, CatalogLocalAppScope>()
      operations.set(trackedPromise, scope)
      this.organizationOperations.set(organizationKey, operations)
    }
    for (const [appKey, scope] of apps) {
      const operations = this.appOperations.get(appKey)
        ?? new Map<Promise<unknown>, CatalogLocalAppScope>()
      operations.set(trackedPromise, scope)
      this.appOperations.set(appKey, operations)
    }
    return trackedPromise
  }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.managers.values()].map(manager => manager.shutdown()),
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failure) throw failure.reason
  }

  private async getManager(
    rawScope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeManager> {
    const scope = validateCatalogLocalAppScope(rawScope)
    const key = createCatalogLocalAppScopeKey(scope)
    const existing = this.managers.get(key)
    if (existing) return existing
    const pending = this.managerPromises.get(key)
    if (pending) {
      const pendingManager = await pending
      if (pendingManager) return pendingManager
    }
    const existingAfterPending = this.managers.get(key)
    if (existingAfterPending) return existingAfterPending

    const managerPromise = this.createManager(key, scope)
      .finally(() => {
        if (this.managerPromises.get(key) === managerPromise) {
          this.managerPromises.delete(key)
        }
      })
    this.managerPromises.set(key, managerPromise)
    return managerPromise
  }

  private async createManager(
    key: string,
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeManager> {
    const rootDir = join(this.scopesDir, key)
    await mkdir(rootDir, { recursive: true })
    await this.ensureScopeRecord(rootDir, scope)
    const manager = this.managerFactory({
      rootDir,
      uvPath: this.uvPath,
      bunPath: this.bunPath,
      logger: this.logger,
    })
    this.managers.set(key, manager)
    this.managerScopes.set(key, scope)
    return manager
  }

  private async ensureScopeRecord(
    rootDir: string,
    scope: CatalogLocalAppScope,
  ): Promise<void> {
    const path = join(rootDir, 'scope.json')
    const record: PersistedScope = {
      schemaVersion: SCOPE_SCHEMA_VERSION,
      scope,
    }
    try {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const existing = await this.readScopeRecord(path)
    if (!existing || !scopesEqual(existing, scope)) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'Local app scope key does not match its persisted identity',
      )
    }
  }

  private async readPersistedScopes(filter: {
    accountId?: string
    organizationId?: string
    catalogAppId?: string
  } = {}): Promise<CatalogLocalAppScope[]> {
    let entries
    try {
      entries = await readdir(this.scopesDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const directories = entries.filter(entry => entry.isDirectory())
    const scopes = new Array<CatalogLocalAppScope | null>(directories.length)
    let nextIndex = 0
    // Scope directories are tuple hashes, so scope.json is the earliest place
    // account/organization identity can be filtered. Bound those reads before
    // any matching scope is allowed to trigger metadata or manager I/O.
    const workers = Array.from({
      length: Math.min(PERSISTED_SCOPE_READ_CONCURRENCY, directories.length),
    }, async () => {
      while (nextIndex < directories.length) {
        const index = nextIndex++
        const scope = await this.readScopeRecord(join(
          this.scopesDir,
          directories[index]!.name,
          'scope.json',
        ))
        scopes[index] = scope
          && (filter.accountId === undefined || scope.accountId === filter.accountId)
          && (
            filter.organizationId === undefined
            || scope.organizationId === filter.organizationId
          )
          && (
            filter.catalogAppId === undefined
            || scope.catalogAppId === filter.catalogAppId
          )
          ? scope
          : null
      }
    })
    await Promise.all(workers)
    return scopes.filter((scope): scope is CatalogLocalAppScope => scope !== null)
  }

  private async readScopeRecord(path: string): Promise<CatalogLocalAppScope | null> {
    try {
      const serialized = await this.withPersistedScopeReadSlot(
        () => this.scopeRecordReader(path),
      )
      const raw = JSON.parse(serialized) as Partial<PersistedScope>
      if (raw.schemaVersion !== SCOPE_SCHEMA_VERSION) return null
      return validateCatalogLocalAppScope(raw.scope)
    } catch {
      return null
    }
  }
}
