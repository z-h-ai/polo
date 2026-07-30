import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  denyCachedAppCatalogAuthorization,
  denyCachedAppCatalogAuthorizationForAccount,
  getAppCatalogApps,
  getCachedAppCatalog,
  saveAppCatalog,
} from '../app-catalog-cache.ts'
import type { CatalogApp } from '../types.ts'

let configDir = ''
let previousConfigDir: string | undefined

function remoteApp(id: string): CatalogApp {
  return {
    id,
    organizationId: 'organization-1',
    name: id,
    description: `${id} description`,
    deliveryMode: 'remote_url',
    remoteUrl: `https://${id}.example.com`,
    sortOrder: 1,
  }
}

function bundleApp(id: string, version: string): CatalogApp {
  return {
    id,
    organizationId: 'organization-1',
    name: id,
    description: `${id} description`,
    deliveryMode: 'local_bundle',
    currentRelease: {
      version,
      runtime: 'static',
      downloadUrl: `https://example.com/${id}.zip`,
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
    },
    sortOrder: 1,
  }
}

beforeEach(() => {
  previousConfigDir = process.env.POLO_AI_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'polo-app-catalog-'))
  process.env.POLO_AI_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
  else process.env.POLO_AI_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('app catalog cache', () => {
  it('scopes entries by account and organization', () => {
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v1',
      apps: [remoteApp('app-a')],
    }, 100)

    expect(getCachedAppCatalog('account-a', 'organization-1')).toMatchObject({
      accountId: 'account-a',
      organizationId: 'organization-1',
      authorizationStatus: 'authorized',
      appConfigVersion: 'v1',
      syncedAt: 100,
    })
    expect(getCachedAppCatalog('account-b', 'organization-1')).toBeNull()
  })

  it('retains withdrawn metadata without keeping it launchable', () => {
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v1',
      apps: [remoteApp('app-a'), remoteApp('app-b')],
    }, 100)
    const refreshed = saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v2',
      apps: [remoteApp('app-a')],
    }, 200)

    expect(refreshed.apps).toEqual([
      { ...remoteApp('app-a'), availability: 'available' },
    ])
    expect(refreshed.withdrawnApps).toEqual([
      { ...remoteApp('app-b'), availability: 'withdrawn' },
    ])
    expect(getAppCatalogApps(refreshed)).toEqual([
      { ...remoteApp('app-a'), availability: 'available' },
      { ...remoteApp('app-b'), availability: 'withdrawn' },
    ])
  })

  it('keeps the last trusted release when a later catalog version is invalid', () => {
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v1',
      apps: [bundleApp('app-a', '1.2.0')],
    }, 100)
    const refreshed = saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v2',
      apps: [bundleApp('app-a', '1.2.0.1')],
    }, 200)

    expect(refreshed.apps[0]?.currentRelease?.version).toBe('1.2.0.1')
    expect(refreshed.trustedReleases?.['app-a']?.version).toBe('1.2.0')
    expect(refreshed.warnings).toEqual([{
      code: 'invalid_semver',
      catalogAppId: 'app-a',
    }])
    expect(getCachedAppCatalog('account-a', 'organization-1'))
      .toMatchObject({
        trustedReleases: { 'app-a': { version: '1.2.0' } },
        warnings: [{ code: 'invalid_semver', catalogAppId: 'app-a' }],
      })
  })

  it('trusts strict SemVer releases with numeric identifiers beyond safe integers', () => {
    const version = '90071992547409931234567890.0.0'
    const saved = saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'large-version',
      apps: [bundleApp('app-a', version)],
    }, 100)

    expect(saved.trustedReleases?.['app-a']?.version).toBe(version)
    expect(saved.warnings).toEqual([])
  })

  it('migrates a valid v1 release into trusted release metadata', () => {
    writeFileSync(join(configDir, 'admin-app-catalog.json'), JSON.stringify({
      schemaVersion: 1,
      entries: {
        'account-a:organization-1': {
          accountId: 'account-a',
          organizationId: 'organization-1',
          authorizationStatus: 'authorized',
          appConfigVersion: 'v1',
          syncedAt: 100,
          apps: [{
            ...bundleApp('app-a', 'v2.0.0'),
            availability: 'available',
          }],
        },
      },
    }), 'utf8')

    expect(getCachedAppCatalog('account-a', 'organization-1')
      ?.trustedReleases?.['app-a']?.version)
      .toBe('v2.0.0')
  })

  it('bounds visible and withdrawn metadata at 10,000 entries', () => {
    const initial = Array.from({ length: 10_000 }, (_, index) =>
      remoteApp(`app-${index}`))
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v1',
      apps: initial,
    })

    const replacement = [
      ...initial.slice(1),
      remoteApp('app-10000'),
    ]
    const replaced = saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v2',
      apps: replacement,
    })
    expect(replaced.apps).toHaveLength(10_000)
    expect(replaced.apps.some(app => app.id === 'app-0')).toBe(false)
    expect(replaced.withdrawnApps).toEqual([
      { ...remoteApp('app-0'), availability: 'withdrawn' },
    ])

    const withdrawn = saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v3',
      apps: replacement.slice(1),
    })
    expect(withdrawn.apps).toHaveLength(9_999)
    expect(withdrawn.withdrawnApps).toHaveLength(2)
    expect(withdrawn.withdrawnApps).toContainEqual(expect.objectContaining({
      id: 'app-1',
      availability: 'withdrawn',
    }))
    expect(getCachedAppCatalog('account-a', 'organization-1')?.apps)
      .toHaveLength(9_999)
    expect(getAppCatalogApps(withdrawn)).toHaveLength(10_001)

    const denied = denyCachedAppCatalogAuthorization(
      'account-a',
      'organization-1',
    )
    expect(denied?.apps).toHaveLength(9_999)
    expect(denied?.withdrawnApps).toHaveLength(2)
    expect(getAppCatalogApps(denied!)).toHaveLength(10_001)
    expect(getCachedAppCatalog('account-a', 'organization-1'))
      .toMatchObject({ authorizationStatus: 'denied' })
  })

  it('prioritizes an installed tombstone when a full cache gains a newly withdrawn app', () => {
    const initial = Array.from({ length: 10_000 }, (_, index) =>
      bundleApp(`app-${index}`, '1.0.0'))
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v1',
      apps: initial,
    })
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v2',
      apps: [],
    })
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v3',
      apps: [bundleApp('newly-withdrawn', '1.0.0')],
    })

    const refreshed = saveAppCatalog(
      'account-a',
      'organization-1',
      {
        appConfigVersion: 'v4',
        apps: [],
      },
      400,
      new Set(['app-9999']),
    )

    expect(refreshed.withdrawnApps).toHaveLength(10_000)
    expect(refreshed.withdrawnApps![0]).toMatchObject({ id: 'app-9999' })
    expect(refreshed.withdrawnApps!.some(app => app.id === 'newly-withdrawn'))
      .toBe(true)
  })

  it('fails closed after explicit authorization loss and recovers only after a successful sync', () => {
    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v1',
      apps: [remoteApp('app-a')],
    }, 100)

    expect(denyCachedAppCatalogAuthorization('account-a', 'organization-1'))
      .toMatchObject({
        authorizationStatus: 'denied',
        apps: [{ id: 'app-a', availability: 'unavailable' }],
      })
    expect(getCachedAppCatalog('account-a', 'organization-1'))
      .toMatchObject({
        authorizationStatus: 'denied',
        apps: [{ id: 'app-a', availability: 'unavailable' }],
      })

    expect(saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v2',
      apps: [remoteApp('app-a')],
    }, 200)).toMatchObject({
      authorizationStatus: 'authorized',
      apps: [{ id: 'app-a', availability: 'available' }],
    })
  })

  it('denies every cached organization for a session-ending account only', () => {
    for (const [accountId, organizationId] of [
      ['account-a', 'organization-1'],
      ['account-a', 'organization-2'],
      ['account-b', 'organization-1'],
    ] as const) {
      saveAppCatalog(accountId, organizationId, {
        appConfigVersion: 'v1',
        apps: [{
          ...remoteApp(`${accountId}-${organizationId}`),
          organizationId,
        }],
      }, 100)
    }

    expect(denyCachedAppCatalogAuthorizationForAccount('account-a')).toHaveLength(2)
    expect(getCachedAppCatalog('account-a', 'organization-1'))
      .toMatchObject({ authorizationStatus: 'denied' })
    expect(getCachedAppCatalog('account-a', 'organization-2'))
      .toMatchObject({ authorizationStatus: 'denied' })
    expect(getCachedAppCatalog('account-b', 'organization-1'))
      .toMatchObject({ authorizationStatus: 'authorized' })
  })

  it('ignores a damaged cache and safely starts over', () => {
    writeFileSync(join(configDir, 'admin-app-catalog.json'), '{broken', 'utf8')
    expect(getCachedAppCatalog('account-a', 'organization-1')).toBeNull()

    saveAppCatalog('account-a', 'organization-1', {
      appConfigVersion: 'v1',
      apps: [remoteApp('app-a')],
    })
    expect(JSON.parse(readFileSync(
      join(configDir, 'admin-app-catalog.json'),
      'utf8',
    )).schemaVersion).toBe(3)
  })
})
