import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  LocalAppInstallRequest,
  LocalAppRuntimeStatus,
} from '@polo-ai/shared/protocol'
import { LocalAppRuntimeManager } from '../manager'
import {
  createCatalogLocalAppScopeKey,
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

  it('persists separate account scopes without changing the manifest app id', async () => {
    const registry = new ScopedLocalAppRuntimeRegistry({ rootDir })
    const accountA = scope('account-a')
    const accountB = scope('account-b')

    await expect(registry.getRuntimeStatus(accountA)).resolves.toMatchObject({
      appId: 'demo.catalog-app',
      scope: accountA,
      status: 'not_installed',
    })
    await expect(registry.getRuntimeStatus(accountB)).resolves.toMatchObject({
      appId: 'demo.catalog-app',
      scope: accountB,
      status: 'not_installed',
    })

    const directories = await readdir(join(rootDir, 'catalog-scopes'))
    expect(directories).toHaveLength(2)
    const records = await Promise.all(directories.map(async directory =>
      JSON.parse(await readFile(
        join(rootDir, 'catalog-scopes', directory, 'scope.json'),
        'utf8',
      ))))
    expect(records.map(record => record.scope.accountId).sort()).toEqual([
      'account-a',
      'account-b',
    ])
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
    await registry.getRuntimeStatus(scope('account-a'))
    await registry.getRuntimeStatus(scope('account-b'))

    await registry.stopAccount('account-a')

    expect(stopped).toEqual(['account-a:demo.catalog-app'])
  })

  it('rejects an install whose business app id differs from its scope', async () => {
    const registry = new ScopedLocalAppRuntimeRegistry({ rootDir })
    const request = {
      appId: 'different.app',
      scope: scope('account-a'),
      version: '1.0.0',
      downloadUrl: 'https://example.com/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
      platform: 'darwin',
      arch: 'arm64',
    } satisfies LocalAppInstallRequest

    await expect(registry.install(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})
