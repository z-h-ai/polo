import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  LocalAppInstallRequest,
  LocalAppInstalledApp,
  LocalAppRuntimeStatus,
  LocalAppStartResult,
} from '@polo-ai/shared/protocol'
import { LocalAppRuntimeManager } from '../manager'
import { LocalAppRuntimeError } from '../runtime-error'
import {
  createCatalogLocalAppScopeKey,
  createCatalogRuntimeAppId,
  ScopedLocalAppRuntimeRegistry,
  type CatalogLocalAppScope,
} from '../scoped-registry'

let rootDir = ''

function scope(
  accountId: string,
  organizationId = 'organization-1',
): CatalogLocalAppScope {
  return {
    kind: 'catalog',
    accountId,
    organizationId,
    catalogAppId: 'demo.catalog-app',
  }
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'polo-scoped-local-apps-'))
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

describe('scoped local app runtime registry', () => {
  it('creates stable filesystem-safe keys for the full catalog tuple', () => {
    const first = createCatalogLocalAppScopeKey(scope('account-a'))
    expect(first).toBe(createCatalogLocalAppScopeKey(scope('account-a')))
    expect(first).not.toBe(createCatalogLocalAppScopeKey(scope('account-b')))
    expect(first).not.toBe(createCatalogLocalAppScopeKey(
      scope('account-a', 'organization-2'),
    ))
    expect(first).toMatch(/^catalog-[a-f0-9]{64}$/)
  })

  it('accepts uppercase, Unicode, and 512-character business ids', () => {
    for (const catalogAppId of ['App.ID', '应用-甲', 'x'.repeat(512)]) {
      const value = { ...scope('account-a'), catalogAppId }
      expect(createCatalogRuntimeAppId(value)).toMatch(/^catalog-[a-f0-9]{64}$/)
    }
  })

  it('does not materialize managers or directories for uninstalled status reads', async () => {
    let managerCount = 0
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => {
        managerCount += 1
        return new LocalAppRuntimeManager(options)
      },
    })
    const accountA = scope('account-a')
    const accountB = scope('account-b')

    await expect(registry.getRuntimeStatuses([accountA, accountB])).resolves.toEqual([
      { appId: 'demo.catalog-app', scope: accountA, status: 'not_installed' },
      { appId: 'demo.catalog-app', scope: accountB, status: 'not_installed' },
    ])
    expect(managerCount).toBe(0)
    await expect(readdir(join(rootDir, 'catalog-scopes'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('does not materialize a manager for a scope left by a failed install', async () => {
    let managerCount = 0
    const catalogScope = scope('account-a')
    const scopeDir = join(
      rootDir,
      'catalog-scopes',
      createCatalogLocalAppScopeKey(catalogScope),
    )
    await mkdir(scopeDir, { recursive: true })
    await writeFile(join(scopeDir, 'scope.json'), JSON.stringify({
      schemaVersion: 1,
      scope: catalogScope,
    }))
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => {
        managerCount += 1
        return new LocalAppRuntimeManager(options)
      },
    })

    await expect(registry.getRuntimeStatus(catalogScope)).resolves.toEqual({
      appId: catalogScope.catalogAppId,
      scope: catalogScope,
      status: 'not_installed',
    })
    expect(managerCount).toBe(0)
  })

  it('reports only retained Catalog ids with actual local installation data', async () => {
    const installedScope = {
      ...scope('account-a'),
      catalogAppId: 'installed-app',
    }
    const failedScope = {
      ...scope('account-a'),
      catalogAppId: 'failed-app',
    }
    for (const catalogScope of [installedScope, failedScope]) {
      const scopeDir = join(
        rootDir,
        'catalog-scopes',
        createCatalogLocalAppScopeKey(catalogScope),
      )
      await mkdir(scopeDir, { recursive: true })
      await writeFile(join(scopeDir, 'scope.json'), JSON.stringify({
        schemaVersion: 1,
        scope: catalogScope,
      }))
      if (catalogScope === installedScope) {
        const appDir = join(
          scopeDir,
          'apps',
          createCatalogRuntimeAppId(catalogScope),
        )
        await mkdir(appDir, { recursive: true })
        await writeFile(join(appDir, 'metadata.json'), '{}')
      }
    }
    class TrackingManager extends LocalAppRuntimeManager {
      override async getRuntimeStatus(appId: string): Promise<LocalAppRuntimeStatus> {
        return { appId, status: 'running', currentVersion: '1.0.0' }
      }
    }
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => new TrackingManager(options),
    })

    await expect(registry.getRetainedCatalogAppIds(
      'account-a',
      'organization-1',
    )).resolves.toEqual(new Set(['installed-app']))
  })

  it('loads one existing manager for duplicate scopes in a concurrent batch', async () => {
    let managerCount = 0
    const catalogScope = scope('account-a')
    const scopeDir = join(
      rootDir,
      'catalog-scopes',
      createCatalogLocalAppScopeKey(catalogScope),
    )
    await mkdir(join(
      scopeDir,
      'apps',
      createCatalogRuntimeAppId(catalogScope),
    ), { recursive: true })
    await Promise.all([
      writeFile(join(scopeDir, 'scope.json'), JSON.stringify({
        schemaVersion: 1,
        scope: catalogScope,
      })),
      writeFile(join(
        scopeDir,
        'apps',
        createCatalogRuntimeAppId(catalogScope),
        'metadata.json',
      ), '{}'),
    ])
    class TrackingManager extends LocalAppRuntimeManager {
      override async getRuntimeStatus(appId: string): Promise<LocalAppRuntimeStatus> {
        return { appId, status: 'installed', currentVersion: '1.0.0' }
      }
    }
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => {
        managerCount += 1
        return new TrackingManager(options)
      },
    })

    const statuses = await registry.getRuntimeStatuses(
      Array.from({ length: 16 }, () => catalogScope),
    )
    expect(statuses).toHaveLength(16)
    expect(managerCount).toBe(1)
  })

  it('returns every requested status through the 10,000 item contract', async () => {
    const registry = new ScopedLocalAppRuntimeRegistry({ rootDir })
    for (const count of [1_000, 1_001, 10_000]) {
      const scopes = Array.from({ length: count }, (_, index) => ({
        ...scope('account-a'),
        catalogAppId: `app-${index}`,
      }))
      const statuses = await registry.getRuntimeStatuses(scopes)
      expect(statuses).toHaveLength(count)
      expect(statuses.at(-1)?.appId).toBe(`app-${count - 1}`)
    }
  })

  it('stops only managers belonging to the requested account', async () => {
    const stopped: string[] = []
    class TrackingManager extends LocalAppRuntimeManager {
      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        stopped.push(`${thisAccount}:${appId}`)
        return { appId, status: 'stopped' }
      }
    }
    let thisAccount = ''
    const managerAccounts: string[] = []
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => {
        const account = managerAccounts.shift()!
        return new class extends TrackingManager {
          override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
            thisAccount = account
            return super.stop(appId)
          }
        }(options)
      },
    })
    managerAccounts.push('account-a', 'account-b')
    await registry.stop(scope('account-a'))
    await registry.stop(scope('account-b'))
    stopped.length = 0

    await registry.stopAccount('account-a')

    expect(stopped).toEqual([
      `account-a:${createCatalogRuntimeAppId(scope('account-a'))}`,
    ])
  })

  it('gates new scopes and waits for a cancelled install to become quiescent', async () => {
    let rejectInstall!: (reason: unknown) => void
    let installStarted!: () => void
    const started = new Promise<void>(resolve => {
      installStarted = resolve
    })
    let cancelCalls = 0
    class TrackingManager extends LocalAppRuntimeManager {
      override install(): Promise<LocalAppInstalledApp> {
        installStarted()
        return new Promise((_resolve, reject) => {
          rejectInstall = reject
        })
      }

      override cancelInstall(): boolean {
        cancelCalls += 1
        return true
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        return { appId, status: 'stopped' }
      }
    }
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => new TrackingManager(options),
    })
    const accountScope = scope('account-a')
    const install = registry.install({
      scope: accountScope,
      version: '1.0.0',
      downloadUrl: 'https://example.com/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
      platform: 'darwin',
      arch: 'arm64',
    })
    await started

    let cleanupFinished = false
    const cleanup = registry.stopAccount('account-a').then(() => {
      cleanupFinished = true
    })
    await Promise.resolve()
    expect(cancelCalls).toBe(1)
    expect(cleanupFinished).toBe(false)
    await expect(registry.start({
      ...accountScope,
      catalogAppId: 'new-scope',
    })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    rejectInstall(new LocalAppRuntimeError(
      'INSTALL_CANCELLED',
      'controlled cancellation cleanup complete',
    ))
    await expect(install).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await cleanup
    expect(cleanupFinished).toBe(true)
  })

  it('fences one organization before its in-flight start can commit', async () => {
    const organizationScope = scope('account-a')
    let resolveStart!: (value: LocalAppStartResult) => void
    let startEntered!: () => void
    const started = new Promise<void>(resolve => {
      startEntered = resolve
    })
    const calls: string[] = []
    class TrackingManager extends LocalAppRuntimeManager {
      override start(appId: string): Promise<LocalAppStartResult> {
        calls.push('start')
        startEntered()
        return new Promise(resolve => {
          resolveStart = resolve
        })
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        return { appId, status: 'stopped' }
      }
    }
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => new TrackingManager(options),
    })
    const pendingStart = registry.start(organizationScope)
    await started

    const cleanup = registry.stopOrganization(
      organizationScope.accountId,
      organizationScope.organizationId,
    )
    await expect(registry.start({
      ...organizationScope,
      catalogAppId: 'new-app',
    })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    resolveStart({
      appId: createCatalogRuntimeAppId(organizationScope),
      version: '1.0.0',
      url: 'http://127.0.0.1:3457',
      port: 3457,
    })
    await expect(pendingStart).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
    await cleanup
    expect(calls).toEqual(['start', 'stop'])
  })

  it('rejects an in-flight start after logout and deduplicates account cleanup', async () => {
    let resolveStart!: (value: LocalAppStartResult) => void
    let startEntered!: () => void
    const started = new Promise<void>(resolve => {
      startEntered = resolve
    })
    const calls: string[] = []
    class TrackingManager extends LocalAppRuntimeManager {
      override start(appId: string): Promise<LocalAppStartResult> {
        calls.push('start')
        startEntered()
        return new Promise(resolve => {
          resolveStart = resolve
        })
      }

      override async stop(appId: string): Promise<LocalAppRuntimeStatus> {
        calls.push('stop')
        return { appId, status: 'stopped' }
      }
    }
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => new TrackingManager(options),
    })
    const accountScope = scope('account-a')
    const start = registry.start(accountScope)
    await started
    const cleanup = registry.stopAccount('account-a')
    const duplicateCleanup = registry.stopAccount('account-a')
    await Promise.resolve()
    expect(calls).toEqual(['start'])

    resolveStart({
      appId: createCatalogRuntimeAppId(accountScope),
      version: '1.0.0',
      url: 'http://127.0.0.1:3456',
      port: 3456,
    })
    await expect(start).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await Promise.all([cleanup, duplicateCleanup])
    expect(calls).toEqual(['start', 'stop'])
  })

  it('keeps a failed session cleanup gated until a trusted login resumes it', async () => {
    class FailingManager extends LocalAppRuntimeManager {
      override async stop(): Promise<LocalAppRuntimeStatus> {
        throw new LocalAppRuntimeError('STOP_FAILED', 'controlled stop failure')
      }
    }
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => new FailingManager(options),
    })
    const accountScope = scope('account-a')
    await expect(registry.stop(accountScope)).rejects.toMatchObject({
      code: 'STOP_FAILED',
    })

    await expect(registry.stopAccount('account-a')).rejects.toMatchObject({
      code: 'STOP_FAILED',
    })
    await expect(registry.getRuntimeStatus(accountScope)).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })

    registry.resumeAccount('account-a')
    await expect(registry.getRuntimeStatus(accountScope)).resolves.toMatchObject({
      appId: accountScope.catalogAppId,
    })
  })

  it('keeps the business manifest id separate from the internal runtime id', async () => {
    let managerRequest: LocalAppInstallRequest | null = null
    class TrackingManager extends LocalAppRuntimeManager {
      override async install(request: LocalAppInstallRequest) {
        managerRequest = request
        return {
          appId: request.appId,
          currentVersion: request.version,
          versions: [request.version],
          runtime: 'static' as const,
          status: 'installed' as const,
          installedAt: 1,
        }
      }
    }
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => new TrackingManager(options),
    })
    const catalogScope = {
      ...scope('account-a'),
      catalogAppId: '应用.App-ID',
    }
    const installed = await registry.install({
      scope: catalogScope,
      version: '1.0.0',
      downloadUrl: 'https://example.com/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(managerRequest).toMatchObject({
      appId: createCatalogRuntimeAppId(catalogScope),
      expectedManifestAppId: '应用.App-ID',
    })
    expect(installed).toMatchObject({
      appId: '应用.App-ID',
      scope: catalogScope,
    })
  })

  it('rejects padded and uppercase-V Catalog versions before creating a runtime manager', async () => {
    let managerCount = 0
    const registry = new ScopedLocalAppRuntimeRegistry({
      rootDir,
      managerFactory: options => {
        managerCount += 1
        return new LocalAppRuntimeManager(options)
      },
    })

    for (const version of [' 1.0.0', '1.0.0 ', 'V1.0.0']) {
      await expect(registry.install({
        scope: scope('account-a'),
        version,
        downloadUrl: 'https://example.com/app.zip',
        checksum: 'a'.repeat(64),
        sizeBytes: 1,
        platform: 'darwin',
        arch: 'arm64',
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }

    expect(managerCount).toBe(0)
  })
})
