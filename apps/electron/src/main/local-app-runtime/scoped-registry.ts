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
import {
  LocalAppRuntimeManager,
  type LocalAppRuntimeLogger,
  type LocalAppRuntimeManagerOptions,
} from './manager'
import { LocalAppRuntimeError } from './runtime-error'

const SCOPE_SCHEMA_VERSION = 1
const MAX_SCOPE_FIELD_LENGTH = 512
const STOP_ACCOUNT_CONCURRENCY = 8
const STATUS_READ_CONCURRENCY = 8
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

function validateScopeField(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_SCOPE_FIELD_LENGTH
    || value.includes('\0')
  ) {
    throw new LocalAppRuntimeError('INVALID_REQUEST', `${field} is invalid`)
  }
  return value
}

export function validateCatalogLocalAppScope(scope: unknown): CatalogLocalAppScope {
  if (!scope || typeof scope !== 'object' || (scope as LocalAppScope).kind !== 'catalog') {
    throw new LocalAppRuntimeError('INVALID_REQUEST', 'Catalog local app scope is required')
  }
  const value = scope as CatalogLocalAppScope
  const catalogAppId = validateScopeField(value.catalogAppId, 'scope.catalogAppId')
  if (catalogAppId.trim().length === 0) {
    throw new LocalAppRuntimeError('INVALID_REQUEST', 'scope.catalogAppId is blank')
  }
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
  private readonly managers = new Map<string, LocalAppRuntimeManager>()
  private readonly managerScopes = new Map<string, CatalogLocalAppScope>()
  private readonly managerPromises = new Map<
    string,
    Promise<LocalAppRuntimeManager | null>
  >()
  private readonly sessionEndingAccounts = new Set<string>()
  private readonly accountOperations = new Map<
    string,
    Map<Promise<unknown>, CatalogLocalAppScope>
  >()
  private readonly stopAccountPromises = new Map<string, Promise<void>>()

  constructor(options: ScopedLocalAppRuntimeRegistryOptions) {
    this.scopesDir = join(resolve(options.rootDir), 'catalog-scopes')
    this.uvPath = options.uvPath
    this.bunPath = options.bunPath
    this.logger = options.logger
    this.managerFactory = options.managerFactory
      ?? (managerOptions => new LocalAppRuntimeManager(managerOptions))
  }

  async install(
    request: ScopedCatalogInstallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalAppInstalledApp> {
    return this.runTrackedScopeOperation(request.scope, async scope => {
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
    })
  }

  async cancelInstall(scope: CatalogLocalAppScope): Promise<boolean> {
    return this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getManager(safeScope)
      this.assertAccountSessionActive(safeScope.accountId)
      return manager.cancelInstall(createCatalogRuntimeAppId(safeScope))
    })
  }

  async start(scope: CatalogLocalAppScope): Promise<LocalAppStartResult> {
    return this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getManager(safeScope)
      this.assertAccountSessionActive(safeScope.accountId)
      return attachScope(
        await manager.start(createCatalogRuntimeAppId(safeScope)),
        safeScope,
      )
    })
  }

  async stop(scope: CatalogLocalAppScope): Promise<LocalAppRuntimeStatus> {
    return this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getManager(safeScope)
      this.assertAccountSessionActive(safeScope.accountId)
      return attachScope(
        await manager.stop(createCatalogRuntimeAppId(safeScope)),
        safeScope,
      )
    })
  }

  async restart(scope: CatalogLocalAppScope): Promise<LocalAppStartResult> {
    return this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getManager(safeScope)
      this.assertAccountSessionActive(safeScope.accountId)
      return attachScope(
        await manager.restart(createCatalogRuntimeAppId(safeScope)),
        safeScope,
      )
    })
  }

  async uninstall(
    scope: CatalogLocalAppScope,
    options?: LocalAppUninstallOptions,
  ): Promise<void> {
    await this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getManager(safeScope)
      this.assertAccountSessionActive(safeScope.accountId)
      await manager.uninstall(createCatalogRuntimeAppId(safeScope), options)
    })
  }

  async setAvailableRelease(
    scope: CatalogLocalAppScope,
    release: LocalAppAvailableRelease | null,
  ): Promise<LocalAppRuntimeStatus> {
    return this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getManager(safeScope)
      this.assertAccountSessionActive(safeScope.accountId)
      return attachScope(
        await manager.setAvailableRelease(
          createCatalogRuntimeAppId(safeScope),
          release,
        ),
        safeScope,
      )
    })
  }

  async getInstalledApps(
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppInstalledApp[]> {
    return this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getExistingManager(safeScope)
      if (!manager) return []
      return (await manager.getInstalledApps())
        .map(app => attachScope(app, safeScope))
    })
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
    return this.runTrackedScopesOperation(scopes, async () => {
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
    })
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
    const scopes = (await this.readPersistedScopes()).filter(scope => (
      scope.accountId === safeAccountId
      && scope.organizationId === safeOrganizationId
    ))
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
    return this.runTrackedScopeOperation(scope, async safeScope => {
      const manager = await this.getManager(safeScope)
      return manager.getLogs(createCatalogRuntimeAppId(safeScope), options)
    })
  }

  async stopAccount(accountId: string): Promise<void> {
    const safeAccountId = validateScopeField(accountId, 'accountId')
    this.sessionEndingAccounts.add(safeAccountId)
    const existingStop = this.stopAccountPromises.get(safeAccountId)
    if (existingStop) return existingStop
    const stopPromise = this.performStopAccount(safeAccountId)
      .finally(() => {
        if (this.stopAccountPromises.get(safeAccountId) === stopPromise) {
          this.stopAccountPromises.delete(safeAccountId)
        }
      })
    this.stopAccountPromises.set(safeAccountId, stopPromise)
    return stopPromise
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
  }

  private async performStopAccount(safeAccountId: string): Promise<void> {
    const trackedOperations = [
      ...(this.accountOperations.get(safeAccountId)?.keys() ?? []),
    ]
    const trackedScopes = [
      ...(this.accountOperations.get(safeAccountId)?.values() ?? []),
    ]
    const failures: string[] = []

    for (const scope of trackedScopes) {
      const key = createCatalogLocalAppScopeKey(scope)
      const pendingManager = this.managerPromises.get(key)
      if (pendingManager) {
        const pendingResult = await Promise.allSettled([pendingManager])
        const rejected = pendingResult[0]
        if (rejected?.status === 'rejected') {
          failures.push(rejected.reason instanceof Error
            ? rejected.reason.message
            : String(rejected.reason))
        }
      }
      this.managers.get(key)?.cancelInstall(createCatalogRuntimeAppId(scope))
    }

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
      ...await this.readPersistedScopes(),
    ]) {
      scopesByKey.set(createCatalogLocalAppScopeKey(scope), scope)
    }
    const scopes = [...scopesByKey.values()]
      .filter(scope => scope.accountId === safeAccountId)
    for (let index = 0; index < scopes.length; index += STOP_ACCOUNT_CONCURRENCY) {
      const results = await Promise.allSettled(
        scopes.slice(index, index + STOP_ACCOUNT_CONCURRENCY)
          .map(async scope => {
            const manager = await this.getExistingManager(scope)
              ?? this.managers.get(createCatalogLocalAppScopeKey(scope))
            if (!manager) return
            manager.cancelInstall(createCatalogRuntimeAppId(scope))
            return manager.stop(createCatalogRuntimeAppId(scope))
          }),
      )
      failures.push(...results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)))
    }
    if (failures.length > 0) {
      throw new LocalAppRuntimeError(
        'STOP_FAILED',
        `Failed to stop ${failures.length} scoped local app(s)`,
        { failures },
      )
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

  private runTrackedScopeOperation<T>(
    rawScope: CatalogLocalAppScope,
    operation: (scope: CatalogLocalAppScope) => Promise<T>,
  ): Promise<T> {
    const scope = validateCatalogLocalAppScope(rawScope)
    this.assertAccountSessionActive(scope.accountId)
    return this.runTrackedScopesOperation([scope], () => operation(scope))
  }

  private runTrackedScopesOperation<T>(
    scopes: CatalogLocalAppScope[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const accounts = new Map<string, CatalogLocalAppScope>()
    for (const scope of scopes) {
      this.assertAccountSessionActive(scope.accountId)
      if (!accounts.has(scope.accountId)) accounts.set(scope.accountId, scope)
    }
    let trackedPromise!: Promise<T>
    trackedPromise = Promise.resolve()
      .then(() => {
        for (const accountId of accounts.keys()) {
          this.assertAccountSessionActive(accountId)
        }
        return operation()
      })
      .finally(() => {
        for (const accountId of accounts.keys()) {
          const operations = this.accountOperations.get(accountId)
          operations?.delete(trackedPromise)
          if (operations?.size === 0) this.accountOperations.delete(accountId)
        }
      })
    for (const [accountId, scope] of accounts) {
      const operations = this.accountOperations.get(accountId)
        ?? new Map<Promise<unknown>, CatalogLocalAppScope>()
      operations.set(trackedPromise, scope)
      this.accountOperations.set(accountId, operations)
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

  private async readPersistedScopes(): Promise<CatalogLocalAppScope[]> {
    let entries
    try {
      entries = await readdir(this.scopesDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const scopes = await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .map(entry => this.readScopeRecord(join(this.scopesDir, entry.name, 'scope.json'))))
    return scopes.filter((scope): scope is CatalogLocalAppScope => scope !== null)
  }

  private async readScopeRecord(path: string): Promise<CatalogLocalAppScope | null> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedScope>
      if (raw.schemaVersion !== SCOPE_SCHEMA_VERSION) return null
      return validateCatalogLocalAppScope(raw.scope)
    } catch {
      return null
    }
  }
}
