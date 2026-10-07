import { describe, expect, it } from 'bun:test'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import { createLocalAppScopeKey } from '@polo-ai/shared/protocol'
import {
  dedupeCatalogAppsByIdentity,
  getCatalogAppIdentityKey,
} from '@polo-ai/shared/admin/catalog-view'
import {
  BUSY_RUNTIME_STATUS_LIMIT,
  CATALOG_RUNTIME_STATUS_LIMIT,
  compareCatalogVersions,
  createBusyStatusPoller,
  isNewerCatalogVersion,
  selectCreatorCircleRelations,
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

  it('orders numeric identifiers beyond JavaScript safe integers', () => {
    expect(isNewerCatalogVersion(
      '90071992547409931234567890.0.0',
      '9007199254740993123456789.0.0',
    )).toBe(true)
    expect(isNewerCatalogVersion(
      '1.0.0-90071992547409931234567890',
      '1.0.0-9007199254740993123456789',
    )).toBe(true)
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
    expect(compareCatalogVersions(' 2.0.0', '1.0.0')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
    expect(compareCatalogVersions('2.0.0 ', '1.0.0')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
    expect(compareCatalogVersions('V2.0.0', '1.0.0')).toEqual({
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
  it('keeps the complete catalog selection and leaves RPC chunking to the caller', () => {
    for (const count of [
      1_000,
      1_001,
      CATALOG_RUNTIME_STATUS_LIMIT,
      CATALOG_RUNTIME_STATUS_LIMIT + 1,
    ]) {
      const apps = Array.from(
        { length: count },
        (_, index) => bundleApp(`app-${index}`),
      )
      expect(selectRuntimeStatusApps(apps)).toHaveLength(count)
    }
  })

  it('polls only complete busy scope keys and applies the busy ceiling', () => {
    const apps = Array.from(
      { length: BUSY_RUNTIME_STATUS_LIMIT + 10 },
      (_, index) => bundleApp(`app-${index}`),
    )
    const scopeKey = (app: CatalogApp) => createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-1',
      organizationId: app.organizationId,
      catalogAppId: app.id,
    })
    const busyIds = new Set(apps.map(scopeKey))
    const selected = selectRuntimeStatusApps(apps, busyIds, scopeKey)

    expect(selected).toHaveLength(BUSY_RUNTIME_STATUS_LIMIT)
    expect(selected.every(app => busyIds.has(scopeKey(app)))).toBe(true)
    expect(selectRuntimeStatusApps(
      apps,
      new Set([scopeKey(apps[3]!)]),
      scopeKey,
    )).toEqual([
      apps[3],
    ])
  })
})

describe('busy runtime status polling', () => {
  it('keeps one request in flight and prevents an invalidated response from committing', async () => {
    let nextTimerId = 0
    const scheduled = new Map<number, () => void>()
    const timers = {
      set(callback: () => void) {
        const id = ++nextTimerId
        scheduled.set(id, callback)
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clear(timer: ReturnType<typeof setTimeout>) {
        scheduled.delete(timer as unknown as number)
      },
    }
    const runNextTimer = () => {
      const entry = [...scheduled.entries()]
        .sort(([left], [right]) => left - right)[0]
      expect(entry).toBeDefined()
      scheduled.delete(entry![0])
      entry![1]()
    }
    const flushMicrotasks = async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve()
      }
    }
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    const second = new Promise<void>(resolve => {
      resolveSecond = resolve
    })
    let active = 0
    let maxActive = 0
    const requestGenerations: number[] = []
    const committed: string[] = []
    const poller = createBusyStatusPoller(500, timers)

    poller.replace(async request => {
      active += 1
      maxActive = Math.max(maxActive, active)
      requestGenerations.push(request.requestGeneration)
      await first
      if (request.isCurrent()) committed.push('stale')
      active -= 1
    })
    runNextTimer()
    await flushMicrotasks()
    expect(active).toBe(1)

    poller.replace(async request => {
      active += 1
      maxActive = Math.max(maxActive, active)
      requestGenerations.push(request.requestGeneration)
      await second
      if (request.isCurrent()) committed.push('current')
      active -= 1
    })
    runNextTimer()
    await flushMicrotasks()
    expect(requestGenerations).toEqual([1])
    expect(maxActive).toBe(1)

    resolveFirst()
    await flushMicrotasks()
    expect(requestGenerations).toEqual([1, 2])
    expect(committed).toEqual([])
    expect(maxActive).toBe(1)

    resolveSecond()
    await flushMicrotasks()
    expect(committed).toEqual(['current'])
    expect(maxActive).toBe(1)
    poller.stop()
  })
})

describe('creator circle relation projection (POO-70 H1 multi-circle input)', () => {
  const rawEntry = (sources: Array<Record<string, unknown>>) => ({ kind: 'app', sources })

  it('deduplicates one circle repeated across entries by circleId', () => {
    const relations = selectCreatorCircleRelations([
      rawEntry([{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }]),
      rawEntry([
        { kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' },
        { kind: 'creator_circle', circleId: 'circle-2', name: '研发圈' },
      ]),
      rawEntry([{ kind: 'polo', name: 'Polo' }]),
    ])
    expect(relations).toEqual([
      { circleId: 'circle-1', name: '设计圈' },
      { circleId: 'circle-2', name: '研发圈' },
    ])
  })

  it('keys relations by circleId, never by display name', () => {
    const relations = selectCreatorCircleRelations([
      rawEntry([{ kind: 'creator_circle', circleId: 'circle-1', name: '同名圈' }]),
      rawEntry([{ kind: 'creator_circle', circleId: 'circle-2', name: '同名圈' }]),
    ])
    expect(relations).toHaveLength(2)
    expect(relations.map(relation => relation.circleId)).toEqual(['circle-1', 'circle-2'])
  })

  it('ignores entries without sources and non-object source records', () => {
    expect(selectCreatorCircleRelations([
      { kind: 'app' },
      { kind: 'app', sources: 'not-an-array' },
      { kind: 'app', sources: [null, 42, { kind: 'creator_circle' }] },
    ])).toEqual([])
  })
})

describe('stable catalog identity dedup (POO-70 H1 directory projection)', () => {
  const catalog = {
    accountId: 'account-1',
    organizationId: 'space-personal',
  }

  const identityApp = (overrides: Partial<CatalogApp>): CatalogApp => ({
    id: 'entry-1',
    organizationId: 'space-personal',
    name: '应用',
    description: '',
    deliveryMode: 'resolve_launch',
    sortOrder: 0,
    ...overrides,
  })

  it('builds a collision-free identity tuple bound to account, space, entry and artifact', () => {
    const key = (app: CatalogApp) => getCatalogAppIdentityKey(catalog, app)
    expect(key(identityApp({
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-1',
    }))).not.toBe(key(identityApp({
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-2',
    })))
    expect(key(identityApp({
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-1',
    }))).not.toBe(key(identityApp({
      catalogEntryId: 'entry-2',
      artifactInstanceId: 'artifact-1',
    })))
    expect(key(identityApp({
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-1',
    }))).toBe(getCatalogAppIdentityKey(
      { accountId: 'account-1', organizationId: 'space-personal' },
      identityApp({ catalogEntryId: 'entry-1', artifactInstanceId: 'artifact-1' }),
    ))
    expect(getCatalogAppIdentityKey(
      { accountId: 'account-1', organizationId: 'space-personal' },
      identityApp({ catalogEntryId: 'entry-1', artifactInstanceId: 'artifact-1' }),
    )).not.toBe(getCatalogAppIdentityKey(
      { accountId: 'account-2', organizationId: 'space-personal' },
      identityApp({ catalogEntryId: 'entry-1', artifactInstanceId: 'artifact-1' }),
    ))
  })

  it('collapses a version-change tombstone into its live row and keeps Catalog order', () => {
    const live = identityApp({
      id: 'entry-1',
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-1',
      catalogVersion: { versionId: 'version-2', version: '2.0.0' },
      availability: 'available',
    })
    const tombstone = identityApp({
      id: 'entry-1',
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-1',
      catalogVersion: { versionId: 'version-1', version: '1.0.0' },
      availability: 'withdrawn',
    })
    const entry: Pick<AppCatalogCacheEntry, 'accountId' | 'organizationId' | 'apps' | 'withdrawnApps'> = {
      ...catalog,
      apps: [live],
      withdrawnApps: [tombstone],
    }
    const { apps, duplicatesDropped } = dedupeCatalogAppsByIdentity(entry)
    expect(duplicatesDropped).toBe(1)
    expect(apps).toEqual([live])
  })

  it('keeps a reissued artifact under a different catalog entry distinct', () => {
    const live = identityApp({
      id: 'entry-new',
      catalogEntryId: 'entry-new',
      artifactInstanceId: 'artifact-1',
      availability: 'available',
    })
    const tombstone = identityApp({
      id: 'entry-old',
      catalogEntryId: 'entry-old',
      artifactInstanceId: 'artifact-1',
      availability: 'withdrawn',
    })
    const { apps, duplicatesDropped } = dedupeCatalogAppsByIdentity({
      ...catalog,
      apps: [live],
      withdrawnApps: [tombstone],
    })
    expect(duplicatesDropped).toBe(0)
    expect(apps).toEqual([live, tombstone])
  })
})
