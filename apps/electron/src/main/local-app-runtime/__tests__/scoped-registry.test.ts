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
  LocalAppRuntimeStatus,
} from '@polo-ai/shared/protocol'
import { LocalAppRuntimeManager } from '../manager'
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
})
