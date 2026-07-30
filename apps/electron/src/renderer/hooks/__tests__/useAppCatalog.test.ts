import { describe, expect, it } from 'bun:test'
import type { CatalogApp } from '@polo-ai/shared/admin'
import {
  BUSY_RUNTIME_STATUS_LIMIT,
  CATALOG_RUNTIME_STATUS_LIMIT,
  compareCatalogVersions,
  isNewerCatalogVersion,
  selectRuntimeStatusApps,
} from '../useAppCatalog'

describe('organization app catalog version comparison', () => {
  it('only marks higher semantic versions as updates', () => {
    expect(isNewerCatalogVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerCatalogVersion('1.10.0', '1.9.9')).toBe(true)
    expect(isNewerCatalogVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerCatalogVersion('1.0.0', '2.0.0')).toBe(false)
  })

  it('supports a leading v and does not guess for opaque versions', () => {
    expect(isNewerCatalogVersion('v2.0.0', '1.0.0')).toBe(true)
    expect(isNewerCatalogVersion('release-b', 'release-a')).toBe(false)
    expect(isNewerCatalogVersion('release-a', 'release-a')).toBe(false)
  })

  it('uses SemVer prerelease precedence', () => {
    expect(isNewerCatalogVersion('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewerCatalogVersion('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true)
    expect(isNewerCatalogVersion('1.0.0-beta.1', '1.0.0')).toBe(false)
  })

  it('returns an explicit invalid fallback for fourth segments and invalid versions', () => {
    expect(compareCatalogVersions('1.2.3.4', '1.2.3')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
    expect(compareCatalogVersions('release-b', 'release-a')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
  })
})

function bundleApp(id: string): CatalogApp {
  return {
    id,
    organizationId: 'organization-1',
    name: id,
    description: '',
    deliveryMode: 'local_bundle',
    currentRelease: {
      version: '1.0.0',
      runtime: 'static',
      downloadUrl: 'https://example.com/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
    },
    sortOrder: 0,
  }
}

describe('organization app runtime status selection', () => {
  it('caps initial catalog status loading at the documented directory limit', () => {
    const apps = Array.from(
      { length: CATALOG_RUNTIME_STATUS_LIMIT + 10 },
      (_, index) => bundleApp(`app-${index}`),
    )
    expect(selectRuntimeStatusApps(apps)).toHaveLength(
      CATALOG_RUNTIME_STATUS_LIMIT,
    )
  })

  it('polls only busy app ids and applies the busy concurrency ceiling', () => {
    const apps = Array.from(
      { length: BUSY_RUNTIME_STATUS_LIMIT + 10 },
      (_, index) => bundleApp(`app-${index}`),
    )
    const busyIds = new Set(apps.map(app => app.id))
    const selected = selectRuntimeStatusApps(apps, busyIds)

    expect(selected).toHaveLength(BUSY_RUNTIME_STATUS_LIMIT)
    expect(selected.every(app => busyIds.has(app.id))).toBe(true)
    expect(selectRuntimeStatusApps(apps, new Set(['app-3']))).toEqual([
      apps[3],
    ])
  })
})
