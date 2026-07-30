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
      { ...remoteApp('app-b'), availability: 'withdrawn' },
    ])
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
    )).schemaVersion).toBe(1)
  })
})
