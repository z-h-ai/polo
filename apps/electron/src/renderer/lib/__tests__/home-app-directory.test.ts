import { describe, expect, it } from 'bun:test'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import { selectHomeAppDirectory } from '../home-app-directory'

/**
 * Fixtures mirror the shape `mapProductSpaceCatalogToCacheEntry` projects
 * from a trusted ProductSpace Catalog (POO-70 S01): stable identity tuple,
 * RAW sealed sources/availability, resolve-launch delivery.
 */
function catalogApp(
  overrides: Partial<CatalogApp> & Pick<CatalogApp, 'id' | 'name'>,
): CatalogApp {
  return {
    organizationId: 'space-personal',
    description: '',
    deliveryMode: 'resolve_launch',
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

function personalCatalog(
  apps: CatalogApp[],
  overrides: Partial<AppCatalogCacheEntry> = {},
): AppCatalogCacheEntry {
  return {
    accountId: 'account-1',
    organizationId: 'space-personal',
    appConfigVersion: 'catalog-rev-1',
    authorizationStatus: 'authorized',
    syncedAt: 1,
    apps,
    trustedReleases: {},
    warnings: [],
    withdrawnApps: [],
    ...overrides,
  }
}

const memberContext = {
  accountId: 'account-1',
  productSpaceId: 'space-personal',
  spaceKind: 'personal' as const,
}

describe('selectHomeAppDirectory — P70-CATALOG-01 full directory', () => {
  it('returns the complete authorized directory without a frequently-used cap', () => {
    const apps = Array.from({ length: 9 }, (_, index) => catalogApp({
      id: `entry-${index}`,
      catalogEntryId: `entry-${index}`,
      artifactInstanceId: `artifact-${index}`,
      name: `应用 ${index}`,
      catalogSources: [{ kind: 'polo', name: 'Polo' }],
      sortOrder: index,
    }))
    const directory = selectHomeAppDirectory(personalCatalog(apps), memberContext)
    expect(directory.phase).toBe('ready')
    expect(directory.entries).toHaveLength(9)
    expect(directory.stats.catalogRows).toBe(9)
    expect(directory.stats.duplicatesDropped).toBe(0)
    expect(directory.rejections).toEqual([])
  })

  it('keeps authoritative Catalog entry order and flags the index projection', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-b',
        catalogEntryId: 'entry-b',
        artifactInstanceId: 'artifact-b',
        name: '乙',
        catalogSources: [{ kind: 'polo', name: 'Polo' }],
        sortOrder: 1,
      }),
      catalogApp({
        id: 'entry-a',
        catalogEntryId: 'entry-a',
        artifactInstanceId: 'artifact-a',
        name: '甲',
        catalogSources: [{ kind: 'polo', name: 'Polo' }],
        sortOrder: 0,
      }),
    ])
    const directory = selectHomeAppDirectory(catalog, memberContext)
    expect(directory.entries.map(entry => entry.app.id)).toEqual(['entry-b', 'entry-a'])
  })

  it('deduplicates by stable work identity and keeps same-name works separate', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-report-a',
        catalogEntryId: 'entry-report-a',
        artifactInstanceId: 'artifact-report-a',
        name: '周报助手',
        catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }],
      }),
      catalogApp({
        id: 'entry-report-b',
        catalogEntryId: 'entry-report-b',
        artifactInstanceId: 'artifact-report-b',
        name: '周报助手',
        catalogSources: [{ kind: 'creator_circle', circleId: 'circle-2', name: '研发圈' }],
      }),
    ])
    const directory = selectHomeAppDirectory(catalog, memberContext)
    expect(directory.entries).toHaveLength(2)
    const [first, second] = directory.entries
    // Same display name, distinct stable identities — never keyed by name.
    expect(first!.identityKey).not.toEqual(second!.identityKey)
    expect(first!.identityKey).toContain('entry-report-a')
    expect(first!.identityKey).toContain('artifact-report-a')
    expect(first!.identityKey).not.toContain('周报助手')
    expect(second!.identityKey).toContain('entry-report-b')
    // Identity is bound to account + space as well.
    expect(selectHomeAppDirectory(catalog, {
      ...memberContext,
      accountId: 'account-other',
    }).rejections[0]?.reason).toBe('foreign_space_scope')
  })
})

describe('selectHomeAppDirectory — P70-CATALOG-02 sources and availability', () => {
  it('keeps every circle source of one work and stays usable when one circle is lost', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-shared',
        catalogEntryId: 'entry-shared',
        artifactInstanceId: 'artifact-shared',
        name: '同作品',
        catalogSources: [
          { kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' },
          { kind: 'creator_circle', circleId: 'circle-2', name: '研发圈' },
        ],
      }),
    ])
    const intact = selectHomeAppDirectory(catalog, memberContext)
    expect(intact.entries).toHaveLength(1)
    expect(intact.entries[0]!.sources).toHaveLength(2)
    expect(intact.entries[0]!.sources.every(source => source.valid)).toBe(true)
    expect(intact.entries[0]!.launchBlocked).toBe(false)

    // One circle authorization lost: the work remains usable through the other.
    const oneLost = selectHomeAppDirectory(catalog, {
      ...memberContext,
      lostCircleIds: new Set(['circle-1']),
    })
    const entry = oneLost.entries[0]!
    expect(entry.sources.map(source => [source.circleId, source.valid])).toEqual([
      ['circle-1', false],
      ['circle-2', true],
    ])
    expect(entry.sources[0]!.refusal).toBe('circle_authorization_lost')
    expect(entry.availability).toBe('available')
    expect(entry.launchBlocked).toBe(false)
  })

  it('blocks a work only when the LAST valid source fails', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-shared',
        catalogEntryId: 'entry-shared',
        artifactInstanceId: 'artifact-shared',
        name: '同作品',
        catalogSources: [
          { kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' },
          { kind: 'creator_circle', circleId: 'circle-2', name: '研发圈' },
        ],
      }),
    ])
    const allLost = selectHomeAppDirectory(catalog, {
      ...memberContext,
      lostCircleIds: new Set(['circle-1', 'circle-2']),
    })
    const entry = allLost.entries[0]!
    // The row stays visible for explanation but is not launchable.
    expect(allLost.entries).toHaveLength(1)
    expect(entry.sources.every(source => !source.valid)).toBe(true)
    expect(entry.availability).toBe('available')
    expect(entry.launchBlocked).toBe(true)
    expect(allLost.rejections).toEqual([])
  })

  it('never guesses a circle loss without the authoritative member-circle input', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-shared',
        catalogEntryId: 'entry-shared',
        artifactInstanceId: 'artifact-shared',
        name: '同作品',
        catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }],
      }),
    ])
    const directory = selectHomeAppDirectory(catalog, {
      ...memberContext,
      lostCircleIds: new Set(['circle-unrelated']),
    })
    expect(directory.entries[0]!.launchBlocked).toBe(false)
    expect(directory.entries[0]!.sources[0]!.valid).toBe(true)
  })

  it('refuses a creator_circle source without a circleId instead of using the name', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-nocircle',
        catalogEntryId: 'entry-nocircle',
        artifactInstanceId: 'artifact-nocircle',
        name: '设计圈作品',
        catalogSources: [{ kind: 'creator_circle', name: '设计圈' }],
      }),
      catalogApp({
        id: 'entry-provable',
        catalogEntryId: 'entry-provable',
        artifactInstanceId: 'artifact-provable',
        name: '可证明作品',
        catalogSources: [{ kind: 'polo', name: 'Polo' }],
      }),
    ])
    const directory = selectHomeAppDirectory(catalog, memberContext)
    expect(directory.entries.map(entry => entry.app.id)).toEqual(['entry-provable'])
    expect(directory.rejections).toEqual([{
      reason: 'unprovable_sources',
      catalogEntryId: 'entry-nocircle',
      name: '设计圈作品',
    }])
  })

  it('inherits no personal-circle sources into an enterprise directory', () => {
    const enterpriseCatalog = personalCatalog(
      [
        catalogApp({
          id: 'entry-enterprise',
          catalogEntryId: 'entry-enterprise',
          artifactInstanceId: 'artifact-enterprise',
          name: '企业应用',
          catalogSources: [{ kind: 'enterprise_import', name: '企业导入' }],
        }),
        catalogApp({
          id: 'entry-leaked',
          catalogEntryId: 'entry-leaked',
          artifactInstanceId: 'artifact-leaked',
          name: '泄漏的个人圈作品',
          catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }],
        }),
      ],
    )
    const directory = selectHomeAppDirectory(enterpriseCatalog, {
      accountId: 'account-1',
      productSpaceId: 'space-personal',
      spaceKind: 'enterprise',
    })
    expect(directory.entries.map(entry => entry.app.id)).toEqual(['entry-enterprise'])
    expect(directory.rejections).toEqual([{
      reason: 'space_kind_source_mismatch',
      catalogEntryId: 'entry-leaked',
      name: '泄漏的个人圈作品',
    }])
  })

  it('collapses a withdrawn tombstone into its upgraded live row (version change)', () => {
    const catalog = personalCatalog(
      [
        catalogApp({
          id: 'entry-shared',
          catalogEntryId: 'entry-shared',
          artifactInstanceId: 'artifact-shared',
          name: '同作品',
          catalogVersion: { versionId: 'version-2', version: '2.0.0' },
          catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }],
        }),
      ],
      {
        withdrawnApps: [
          catalogApp({
            id: 'entry-shared',
            catalogEntryId: 'entry-shared',
            artifactInstanceId: 'artifact-shared',
            name: '同作品',
            catalogVersion: { versionId: 'version-1', version: '1.0.0' },
            catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }],
            availability: 'withdrawn',
            rawAvailability: 'withdrawn',
          }),
        ],
      },
    )
    const directory = selectHomeAppDirectory(catalog, memberContext)
    expect(directory.entries).toHaveLength(1)
    expect(directory.stats.duplicatesDropped).toBe(1)
    expect(directory.entries[0]!.app.catalogVersion?.versionId).toBe('version-2')
    expect(directory.entries[0]!.availability).toBe('available')
  })

  it('keeps a reissued artifact under a different catalog entry as distinct rows', () => {
    const catalog = personalCatalog(
      [
        catalogApp({
          id: 'entry-new',
          catalogEntryId: 'entry-new',
          artifactInstanceId: 'artifact-shared',
          name: '新条目',
          catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }],
        }),
      ],
      {
        withdrawnApps: [
          catalogApp({
            id: 'entry-old',
            catalogEntryId: 'entry-old',
            artifactInstanceId: 'artifact-shared',
            name: '旧条目',
            catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '设计圈' }],
            availability: 'withdrawn',
            rawAvailability: 'withdrawn',
          }),
        ],
      },
    )
    const directory = selectHomeAppDirectory(catalog, memberContext)
    expect(directory.entries).toHaveLength(2)
    expect(directory.entries.map(entry => entry.availability)).toEqual(['available', 'withdrawn'])
    expect(directory.stats.duplicatesDropped).toBe(0)
  })
})

describe('selectHomeAppDirectory — P70-CATALOG-03 separated states', () => {
  const base = {
    accountId: 'account-1',
    productSpaceId: 'space-personal',
    spaceKind: 'personal' as const,
  }

  it('separates no-space, loading, vacuum, error, denied and offline', () => {
    expect(selectHomeAppDirectory(null, {
      ...base,
      accountId: null,
      productSpaceId: null,
    }).phase).toBe('no-space')
    expect(selectHomeAppDirectory(null, { ...base, loading: true }).phase).toBe('loading')
    // 真空: authorized online catalog with zero rows is its own phase.
    expect(selectHomeAppDirectory(personalCatalog([]), base).phase).toBe('empty')
    expect(selectHomeAppDirectory(null, {
      ...base,
      loading: false,
      errorCode: 'NETWORK_ERROR',
    }).phase).toBe('error')
    expect(selectHomeAppDirectory(personalCatalog([
      catalogApp({ id: 'entry-a', name: '甲', catalogSources: [{ kind: 'polo', name: 'Polo' }] }),
    ]), { ...base, accessMode: 'denied' }).phase).toBe('denied')
    expect(selectHomeAppDirectory(personalCatalog([]), {
      ...base,
      accessMode: 'offline',
    }).phase).toBe('offline')
    // An authoritative gap is never presented as a vacuum.
    expect(selectHomeAppDirectory(null, base).phase).toBe('loading')
  })

  it('reads a first-sync denial (no catalog yet + errorCode) as denied, not error', () => {
    // Production path (useAppCatalog first sync denial): the hook commits
    // accessMode:'denied' + errorCode with catalog:null when no tombstone
    // was retained. The authoritative access decision outranks the failure.
    const firstSyncDenial = selectHomeAppDirectory(null, {
      ...base,
      loading: false,
      errorCode: 'FORBIDDEN',
      accessMode: 'denied',
    })
    expect(firstSyncDenial.phase).toBe('denied')
    expect(firstSyncDenial.entries).toEqual([])
    // Same precedence without a failure code, and offline over error.
    expect(selectHomeAppDirectory(null, {
      ...base,
      accessMode: 'denied',
    }).phase).toBe('denied')
    expect(selectHomeAppDirectory(null, {
      ...base,
      errorCode: 'NETWORK_ERROR',
      accessMode: 'offline',
    }).phase).toBe('offline')
  })

  it('refuses a cross-space stale receipt instead of filling the view with it', () => {
    const otherSpaceCatalog = personalCatalog([
      catalogApp({
        id: 'entry-foreign',
        catalogEntryId: 'entry-foreign',
        artifactInstanceId: 'artifact-foreign',
        name: '另一空间应用',
        catalogSources: [{ kind: 'polo', name: 'Polo' }],
      }),
    ])
    const directory = selectHomeAppDirectory(otherSpaceCatalog, {
      ...base,
      productSpaceId: 'space-enterprise-b',
    })
    expect(directory.entries).toEqual([])
    expect(directory.rejections).toEqual([{
      reason: 'foreign_space_scope',
      catalogEntryId: null,
      name: null,
    }])
    expect(directory.stats.rejectedRows).toBe(1)
    expect(directory.phase).toBe('loading')
  })

  it('keeps cache rows visible offline but never marks them launchable authority', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-a',
        catalogEntryId: 'entry-a',
        artifactInstanceId: 'artifact-a',
        name: '甲',
        catalogSources: [{ kind: 'polo', name: 'Polo' }],
        rawAvailability: 'available',
      }),
    ])
    const directory = selectHomeAppDirectory(catalog, {
      ...base,
      accessMode: 'offline',
    })
    expect(directory.phase).toBe('offline')
    // The projection itself never carries a grant: launch authority remains
    // with the online resolve-launch flow, so the row stays blocked-by-phase
    // and consumers must consult accessMode (launchBlocked covers the
    // per-row availability/source facts).
    expect(directory.entries[0]!.availability).toBe('available')
    expect(directory.entries[0]!.rawAvailability).toBe('available')
  })

  it('reports blocked rows from raw blocked availability (lossy collapse intact)', () => {
    const catalog = personalCatalog([
      catalogApp({
        id: 'entry-blocked',
        catalogEntryId: 'entry-blocked',
        artifactInstanceId: 'artifact-blocked',
        name: '受限作品',
        catalogSources: [{ kind: 'polo', name: 'Polo' }],
        availability: 'unavailable',
        rawAvailability: 'blocked',
        unavailableReason: 'permission_required',
      }),
    ])
    const directory = selectHomeAppDirectory(catalog, base)
    expect(directory.entries[0]!.availability).toBe('unavailable')
    expect(directory.entries[0]!.rawAvailability).toBe('blocked')
    expect(directory.entries[0]!.launchBlocked).toBe(true)
  })
})
