import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  LocalAppAvailableRelease,
  LocalAppInstallRequest,
  LocalAppInstalledApp,
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
  if (
    catalogAppId.length > 128
    || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(catalogAppId)
    || catalogAppId === '.'
    || catalogAppId === '..'
  ) {
    throw new LocalAppRuntimeError(
      'INVALID_REQUEST',
      'scope.catalogAppId contains unsupported characters',
    )
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
  private readonly managerPromises = new Map<string, Promise<LocalAppRuntimeManager>>()

  constructor(options: ScopedLocalAppRuntimeRegistryOptions) {
    this.scopesDir = join(resolve(options.rootDir), 'catalog-scopes')
    this.uvPath = options.uvPath
    this.bunPath = options.bunPath
    this.logger = options.logger
    this.managerFactory = options.managerFactory
      ?? (managerOptions => new LocalAppRuntimeManager(managerOptions))
  }

  async install(
    request: LocalAppInstallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalAppInstalledApp> {
    const scope = validateCatalogLocalAppScope(request.scope)
    if (request.appId !== scope.catalogAppId) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        'Install appId does not match scope.catalogAppId',
      )
    }
    const manager = await this.getManager(scope)
    const { scope: _scope, ...legacyRequest } = request
    const installed = await manager.install(
      {
        ...legacyRequest,
        appId: scope.catalogAppId,
      },
      options,
    )
    return attachScope(installed, scope)
  }

  async cancelInstall(scope: CatalogLocalAppScope): Promise<boolean> {
    const manager = await this.getManager(scope)
    return manager.cancelInstall(scope.catalogAppId)
  }

  async start(scope: CatalogLocalAppScope): Promise<LocalAppStartResult> {
    const manager = await this.getManager(scope)
    return attachScope(await manager.start(scope.catalogAppId), scope)
  }

  async stop(scope: CatalogLocalAppScope): Promise<LocalAppRuntimeStatus> {
    const manager = await this.getManager(scope)
    return attachScope(await manager.stop(scope.catalogAppId), scope)
  }

  async restart(scope: CatalogLocalAppScope): Promise<LocalAppStartResult> {
    const manager = await this.getManager(scope)
    return attachScope(await manager.restart(scope.catalogAppId), scope)
  }

  async uninstall(
    scope: CatalogLocalAppScope,
    options?: LocalAppUninstallOptions,
  ): Promise<void> {
    const manager = await this.getManager(scope)
    await manager.uninstall(scope.catalogAppId, options)
  }

  async setAvailableRelease(
    scope: CatalogLocalAppScope,
    release: LocalAppAvailableRelease | null,
  ): Promise<LocalAppRuntimeStatus> {
    const manager = await this.getManager(scope)
    return attachScope(
      await manager.setAvailableRelease(scope.catalogAppId, release),
      scope,
    )
  }

  async getInstalledApps(
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppInstalledApp[]> {
    const manager = await this.getManager(scope)
    return (await manager.getInstalledApps()).map(app => attachScope(app, scope))
  }

  async getRuntimeStatus(
    scope: CatalogLocalAppScope,
  ): Promise<LocalAppRuntimeStatus> {
    const manager = await this.getManager(scope)
    return attachScope(
      await manager.getRuntimeStatus(scope.catalogAppId),
      scope,
    )
  }

  async getLogs(
    scope: CatalogLocalAppScope,
    options?: { tail?: number },
  ): Promise<string> {
    const manager = await this.getManager(scope)
    return manager.getLogs(scope.catalogAppId, options)
  }

  async stopAccount(accountId: string): Promise<void> {
    const safeAccountId = validateScopeField(accountId, 'accountId')
    const scopesByKey = new Map<string, CatalogLocalAppScope>()
    for (const scope of [
      ...this.managerScopes.values(),
      ...await this.readPersistedScopes(),
    ]) {
      scopesByKey.set(createCatalogLocalAppScopeKey(scope), scope)
    }
    const scopes = [...scopesByKey.values()]
      .filter(scope => scope.accountId === safeAccountId)
    const failures: string[] = []
    for (let index = 0; index < scopes.length; index += STOP_ACCOUNT_CONCURRENCY) {
      const results = await Promise.allSettled(
        scopes.slice(index, index + STOP_ACCOUNT_CONCURRENCY)
          .map(scope => this.stop(scope)),
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
    if (pending) return pending

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
