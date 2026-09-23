import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { CatalogApp } from '@polo-ai/shared/admin'

GlobalRegistrator.register()
setupI18n()

let compactViewport = false
mock.module('@/lib/use-compact-viewport', () => ({
  useCompactViewport: () => compactViewport,
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const {
  AllAppsView,
  catalogAppBlockedStatusKey,
  catalogAppWithdrawnStatusKey,
  groupAllAppsForDisplay,
} = await import('../AllAppsView')

function app(id: string, overrides: Partial<CatalogApp> = {}): CatalogApp {
  return {
    id,
    catalogEntryId: id,
    artifactInstanceId: `artifact-${id}`,
    catalogVersion: { versionId: `version-${id}`, version: '1.0.0' },
    organizationId: 'space-a',
    name: `App ${id}`,
    description: `${id} description`,
    deliveryMode: 'resolve_launch',
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

// Production-consistent full UI identity tuple: account + productSpace +
// catalogEntryId + artifactInstanceId (mirrors useAppCatalog's
// uiIdentityKeyForApp — the renderView default binds space-a/account-a).
const identityKeyForApp = (
  target: CatalogApp,
  accountId = 'account-a',
  productSpaceId = 'space-a',
) => JSON.stringify([
  'product-space-ui',
  accountId,
  productSpaceId,
  target.catalogEntryId ?? target.id,
  target.artifactInstanceId ?? target.id,
])
const actionTestIdFor = (target: CatalogApp) => `all-apps-action-${identityKeyForApp(target)}`
const uninstallTestIdFor = (target: CatalogApp) => `all-apps-uninstall-${identityKeyForApp(target)}`

function renderView(apps: CatalogApp[], options: {
  spaceKind?: 'personal' | 'enterprise'
  installedId?: string
  loading?: boolean
  errorCode?: string | null
  retainedInstalledIds?: string[]
  offline?: boolean
  restricted?: boolean
  pinnedIds?: string[]
} = {}) {
  const handlers = {
    onRefresh: jest.fn(),
    onOpen: jest.fn(),
    onUninstall: jest.fn(),
    onBack: jest.fn(),
    onPin: jest.fn(),
  }
  render(createElement(
    I18nextProvider,
    { i18n },
    createElement(AllAppsView, {
      spaceName: 'Current space',
      spaceKind: options.spaceKind ?? 'personal',
      apps,
      loading: options.loading ?? false,
      refreshing: false,
      warningCode: null,
      errorCode: options.errorCode ?? null,
      offline: options.offline ?? false,
      restricted: options.restricted ?? false,
      circleCount: 3,
      pinnedIds: new Set(options.pinnedIds ?? []),
      identityKeyForApp,
      getInstallState: (target: CatalogApp) => target.id === options.installedId
        || options.retainedInstalledIds?.includes(target.id) ? {
        app: {
          accountId: 'account-a',
          productSpaceId: 'space-a',
          catalogRevision: 'rev-1',
          catalogEntryId: target.id,
          artifactInstanceId: target.artifactInstanceId!,
          versionId: target.catalogVersion!.versionId,
          version: target.catalogVersion!.version,
          sources: [{ kind: 'enterprise_import', name: 'Organization A', circleId: null }],
          availability: 'available' as const,
        },
        state: 'installed' as const,
        currentVersion: '1.0.0',
      } : undefined,
      ...handlers,
    }),
  ))
  return handlers
}

beforeEach(async () => {
  compactViewport = false
  await i18n.changeLanguage('en')
})

afterEach(cleanup)

describe('groupAllAppsForDisplay', () => {
  it('groups personal Apps by source without merging same-named artifacts', () => {
    const apps = [
      app('a', { name: 'Same', creatorName: 'Circle A' }),
      app('b', { name: 'Same', creatorName: 'Circle B' }),
      app('c', { creatorName: 'Circle A' }),
    ]
    const groups = groupAllAppsForDisplay(apps, 'personal')
    expect(groups.map(group => group.label)).toEqual(['Circle A', 'Circle B'])
    expect(groups[0]!.apps.map(entry => entry.id)).toEqual(['a', 'c'])
    expect(groups[1]!.apps.map(entry => entry.id)).toEqual(['b'])
  })

  it('keeps enterprise Catalog flat', () => {
    const apps = [app('a'), app('b')]
    expect(groupAllAppsForDisplay(apps, 'enterprise')).toEqual([
      { key: 'all', label: '', apps },
    ])
  })
})

describe('All Apps visible-count label (R42: paginated mounted rows)', () => {
  it('counts MOUNTED rows initially (60) and every row after Load more (70)', async () => {
    const apps = Array.from({ length: 70 }, (_, index) => app(`bulk-${index}`))
    renderView(apps)

    const count = screen.getByTestId('all-apps-count')
    // Initial page: exactly ALL_APPS_PAGE_SIZE (60) rows are mounted, so the
    // label must claim 60 — not the 70 filtered entries.
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(60)
    expect(count.textContent).toBe('60 / 70 Apps')

    // After Load more: every filtered row is mounted and the label claims 70.
    fireEvent.click(screen.getByTestId('all-apps-load-more'))
    await waitFor(() => {
      expect(screen.getAllByTestId('all-apps-row')).toHaveLength(70)
    })
    expect(count.textContent).toBe('70 / 70 Apps')
  })
})

describe('AllAppsView ProductSpace Catalog boundary', () => {
  it('opens any accessible row and exposes uninstall only for an installed bundle', () => {
    const apps = [app('a'), app('b')]
    const handlers = renderView(apps, { installedId: 'a' })
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(2)

    fireEvent.click(screen.getByTestId(actionTestIdFor(apps[1]!)))
    expect(handlers.onOpen).toHaveBeenCalledWith(apps[1])

    fireEvent.click(screen.getByTestId(uninstallTestIdFor(apps[0]!)))
    expect(handlers.onUninstall).toHaveBeenCalledWith(apps[0])
  })

  it('contains no runtime stop, logs, running, or starting controls', () => {
    renderView([app('a')], { installedId: 'a' })
    expect(screen.queryByText('Stop')).toBeNull()
    expect(screen.queryByText('View logs')).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.queryByText('Starting')).toBeNull()
  })

  it('searches name, description, and authoritative source', () => {
    renderView([
      app('a', { name: 'Writer', sourceNames: ['Circle North'] }),
      app('b', { name: 'Planner', description: 'Finance helper' }),
    ])
    fireEvent.input(screen.getByTestId('all-apps-search'), { target: { value: 'north' } })
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(1)
    expect(screen.getByText('Writer')).toBeTruthy()
  })

  it('keeps stable rows in the compact mobile grid', () => {
    compactViewport = true
    renderView([app('a'), app('b')])
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(2)
    expect(screen.getByTestId(actionTestIdFor(app('a')))).toBeTruthy()
  })

  it('maps every unavailableReason to its own frozen blocked status', () => {
    // Personal circles must never be told their "organization" removed
    // access; enterprise keeps the organization phrasing.
    const cases: Array<{
      reason: 'authorization_ended' | 'space_restricted' | 'version_unavailable' | 'version_blocked'
      copy: Record<'personal' | 'enterprise', string>
    }> = [
      {
        reason: 'authorization_ended',
        copy: {
          personal: 'Access to this App has ended',
          enterprise: 'Access removed by your organization',
        },
      },
      {
        reason: 'space_restricted',
        copy: { personal: 'Restricted for this space', enterprise: 'Restricted for this space' },
      },
      {
        reason: 'version_unavailable',
        copy: { personal: 'Version unavailable', enterprise: 'Version unavailable' },
      },
      {
        reason: 'version_blocked',
        copy: { personal: 'Version blocked', enterprise: 'Version blocked' },
      },
    ]
    for (const spaceKind of ['personal', 'enterprise'] as const) {
      for (const { reason, copy } of cases) {
        renderView(
          [app('blocked-a', { availability: 'unavailable', unavailableReason: reason })],
          { spaceKind },
        )
        expect(screen.getByText(copy[spaceKind])).toBeTruthy()
        cleanup()
      }
      renderView(
        [app('blocked-a', { availability: 'unavailable' })],
        { spaceKind },
      )
      // A blocked entry without a reason stays neutral — it must never be
      // misreported as an organization revocation.
      expect(screen.getByText('Currently unavailable')).toBeTruthy()
      expect(screen.queryByText('Access removed by your organization')).toBeNull()
      cleanup()
    }
  })

  it('keys blocked status copy by the authoritative reason and space kind', () => {
    expect(catalogAppBlockedStatusKey({
      availability: 'unavailable',
      unavailableReason: 'version_blocked',
    })).toBe('homeApps.status.versionBlocked')
    expect(catalogAppBlockedStatusKey({
      availability: 'unavailable',
      unavailableReason: 'space_restricted',
    })).toBe('homeApps.status.spaceRestricted')
    expect(catalogAppBlockedStatusKey({
      availability: 'unavailable',
    })).toBe('homeApps.status.unavailableGeneric')
    expect(catalogAppBlockedStatusKey({
      availability: 'unavailable',
      unavailableReason: 'authorization_ended',
    }, 'personal')).toBe('homeApps.status.unauthorizedPersonal')
    expect(catalogAppBlockedStatusKey({
      availability: 'unavailable',
      unavailableReason: 'authorization_ended',
    }, 'enterprise')).toBe('homeApps.status.unauthorized')
    expect(catalogAppWithdrawnStatusKey('personal')).toBe('homeApps.status.withdrawnPersonal')
    expect(catalogAppWithdrawnStatusKey('enterprise')).toBe('homeApps.status.withdrawn')
  })

  it('keeps withdrawn tombstones visible, non-launchable, and uninstallable when installed', () => {
    for (const spaceKind of ['personal', 'enterprise'] as const) {
      const handlers = renderView([
        app('live-a'),
        app('gone-installed', {
          name: 'Gone Installed',
          availability: 'withdrawn',
          sortOrder: 5,
        }),
        app('gone-plain', {
          name: 'Gone Plain',
          availability: 'withdrawn',
          sortOrder: 6,
        }),
      ], {
        spaceKind,
        retainedInstalledIds: ['gone-installed'],
      })

      expect(screen.getAllByTestId('all-apps-row')).toHaveLength(3)
      expect(screen.getByText('Gone Installed')).toBeTruthy()
      expect(screen.getByText('Gone Plain')).toBeTruthy()
      // Frozen withdrawn copy per space kind, on every tombstone row.
      expect(screen.getAllByText(spaceKind === 'personal'
        ? 'This App is no longer distributed'
        : 'Removed by your organization')).toHaveLength(2)

      // Open stays disabled for every tombstone, live app stays openable.
      const goneInstalledAction = screen.getByTestId(actionTestIdFor(app('gone-installed', { sortOrder: 5 }))) as HTMLButtonElement
      const gonePlainAction = screen.getByTestId(actionTestIdFor(app('gone-plain', { sortOrder: 6 }))) as HTMLButtonElement
      expect(goneInstalledAction.disabled).toBe(true)
      expect(gonePlainAction.disabled).toBe(true)
      expect((screen.getByTestId(actionTestIdFor(app('live-a'))) as HTMLButtonElement).disabled).toBe(false)

      // The retained installation keeps its row-level uninstall entry; the
      // plain tombstone does not.
      expect(screen.getByTestId(uninstallTestIdFor(app('gone-installed', { sortOrder: 5 })))).toBeTruthy()
      fireEvent.click(screen.getByTestId(uninstallTestIdFor(app('gone-installed', { sortOrder: 5 }))))
      expect(handlers.onUninstall).toHaveBeenCalledWith(expect.objectContaining({ id: 'gone-installed' }))
      cleanup()
    }
  })

  it('hides the uninstall entry for tombstones without a retained installation', () => {
    renderView([
      app('gone-plain', { name: 'Gone Plain', availability: 'withdrawn', sortOrder: 5 }),
    ], { spaceKind: 'enterprise' })
    expect((screen.getByTestId(actionTestIdFor(app('gone-plain', { sortOrder: 5 }))) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId(uninstallTestIdFor(app('gone-plain', { sortOrder: 5 })))).toBeNull()
  })

  it('keeps offline copy consistent with the frozen contract: viewable, never openable', () => {
    for (const spaceKind of ['personal', 'enterprise'] as const) {
      renderView([app('a'), app('b')], { spaceKind, offline: true })
      // The warning only promises the cached catalog view — never offline
      // opens (row status labels also mention offline; pick the banner).
      const warning = screen.getAllByText(/offline/i)
        .find(element => element.textContent?.includes('cached catalog'))
      expect(warning).toBeTruthy()
      expect(warning!.textContent).toMatch(/can't open/i)
      // Every open button is disabled while offline (personal + enterprise).
      for (const action of screen.getAllByTestId(/^all-apps-action-/)) {
        expect((action as HTMLButtonElement).disabled).toBe(true)
      }
      cleanup()
    }
  })

  it('keeps same-catalogEntryId live and withdrawn rows independently addressable and uninstallable', () => {
    // entry-1 was re-issued for artifact-new while artifact-old stays as a
    // withdrawn tombstone: the rows must not collide (distinct React keys,
    // independent open/uninstall targets).
    const live = app('entry-1', {
      name: 'Reissued',
      artifactInstanceId: 'artifact-new',
      catalogVersion: { versionId: 'version-new', version: '2.0.0' },
    })
    const tombstone = app('entry-1', {
      name: 'Reissued (old)',
      artifactInstanceId: 'artifact-old',
      catalogVersion: { versionId: 'version-old', version: '1.0.0' },
      availability: 'withdrawn',
      sortOrder: 1,
    })
    const handlers = renderView([live, tombstone], {
      installedId: 'entry-1',
      retainedInstalledIds: ['entry-1'],
    })

    // Distinct rows (no duplicate React key collapse).
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(2)
    expect(screen.getByText('Reissued')).toBeTruthy()
    expect(screen.getByText('Reissued (old)')).toBeTruthy()

    // The withdrawn row can be neither opened nor installed...
    const withdrawnAction = screen.getByTestId(actionTestIdFor(tombstone)) as HTMLButtonElement
    expect(withdrawnAction.disabled).toBe(true)
    // ...but the retained installation keeps its row-level uninstall entry.
    expect(screen.getByTestId(uninstallTestIdFor(tombstone))).toBeTruthy()
    fireEvent.click(screen.getByTestId(uninstallTestIdFor(tombstone)))
    expect(handlers.onUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ artifactInstanceId: 'artifact-old' }),
    )

    // The live row opens independently.
    const liveAction = screen.getByTestId(actionTestIdFor(live)) as HTMLButtonElement
    expect(liveAction.disabled).toBe(false)
  })

  it('surfaces cached-catalog refresh failures and restricted views without relaxing fail-closed gates', () => {
    // Cached rows + refresh failure: stale-catalog banner, rows stay
    // visible, opens stay DISABLED (offline-cached rows are not launchable).
    renderView([app('a')], { errorCode: 'NETWORK_ERROR', offline: true })
    const staleBanner = screen.getByTestId('all-apps-stale-catalog-banner')
    // The banner only promises the last verified catalog view — never
    // offline opens.
    expect(staleBanner.textContent).toContain('last verified catalog')
    expect((screen.getByTestId(actionTestIdFor(app('a'))) as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    // Cached rows + generic refresh failure (online): stale banner shows,
    // opens stay available (the cached rows are still authorized).
    renderView([app('a')], { errorCode: 'request_failed' })
    expect(screen.getByTestId('all-apps-stale-catalog-banner').textContent).toContain(
      'last verified catalog',
    )
    expect((screen.getByTestId(actionTestIdFor(app('a'))) as HTMLButtonElement).disabled).toBe(false)
    cleanup()

    // Denied snapshot: space-aware restricted banner; opens stay disabled.
    for (const spaceKind of ['personal', 'enterprise'] as const) {
      renderView([app('a', { availability: 'unavailable' })], {
        spaceKind,
        restricted: true,
        errorCode: 'FORBIDDEN',
      })
      const banner = screen.getByTestId('all-apps-restricted-banner')
      expect(banner.textContent.toLowerCase()).toContain('access')
      expect((screen.getByTestId(actionTestIdFor(app('a'))) as HTMLButtonElement).disabled).toBe(true)
      cleanup()
    }
  })

  it('renders loading and failure states without inventing runtime state', () => {
    const { unmount } = render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AllAppsView, {
        spaceName: 'Current space',
        spaceKind: 'personal',
        apps: [],
        loading: true,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        offline: false,
        restricted: false,
        circleCount: 3,
        pinnedIds: new Set<string>(),
        onPin: () => {},
        getInstallState: () => undefined,
        identityKeyForApp,
        onRefresh: () => {},
        onOpen: () => {},
        onUninstall: () => {},
        onBack: () => {},
      }),
    ))
    expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    unmount()
    const handlers = renderView([], { errorCode: 'request_failed' })
    fireEvent.click(screen.getByText('Try again'))
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('AllAppsView blocked projection, pin gating, and space copy', () => {
  it('reaches the blocked state through the real version_blocked projection: badge, reason reveal, no pin', () => {
    // Production mapper shape: availability 'unavailable' + unavailableReason
    // 'version_blocked' (a literal availability 'blocked' is never produced).
    const blockedRow = app('blk', {
      availability: 'unavailable',
      unavailableReason: 'version_blocked',
    })
    const live = app('live')
    renderView([blockedRow, live])

    // Blocked badge + status copy are reachable.
    expect(screen.getByText('Blocked')).toBeTruthy()
    expect(screen.getByText('Version blocked')).toBeTruthy()

    // The reason control is a REAL explanation interaction: toggling reveals
    // the version-block explanation with the correct aria wiring.
    const reasonControl = screen.getByTestId(`all-apps-reason-${identityKeyForApp(blockedRow)}`)
    expect((reasonControl as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId(`all-apps-reason-text-${identityKeyForApp(blockedRow)}`)).toBeNull()
    fireEvent.click(reasonControl)
    const reasonText = screen.getByTestId(`all-apps-reason-text-${identityKeyForApp(blockedRow)}`)
    expect(reasonText.textContent).toContain('Version blocked')
    expect((reasonControl as HTMLElement).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(reasonControl)
    expect(screen.queryByTestId(`all-apps-reason-text-${identityKeyForApp(blockedRow)}`)).toBeNull()

    // A version-blocked row can never be pinned...
    expect(screen.queryByTestId(`all-apps-pin-${identityKeyForApp(blockedRow)}`)).toBeNull()
    // ...while an available row keeps its pin action.
    expect(screen.getByTestId(`all-apps-pin-${identityKeyForApp(live)}`)).toBeTruthy()
  })

  it('forbids pinning every non-available row: withdrawn, otherwise unavailable, offline', () => {
    const withdrawn = app('wd', { availability: 'withdrawn' })
    const unavailable = app('un', {
      availability: 'unavailable',
      unavailableReason: 'space_restricted',
    })
    const live = app('live')
    renderView([withdrawn, unavailable, live])

    expect(screen.queryByTestId(`all-apps-pin-${identityKeyForApp(withdrawn)}`)).toBeNull()
    expect(screen.queryByTestId(`all-apps-pin-${identityKeyForApp(unavailable)}`)).toBeNull()
    expect(screen.getByTestId(`all-apps-pin-${identityKeyForApp(live)}`)).toBeTruthy()

    // Offline: even a Catalog-available row is not pinnable while the
    // session cannot persist authoritative state.
    cleanup()
    renderView([live], { offline: true })
    expect(screen.queryByTestId(`all-apps-pin-${identityKeyForApp(live)}`)).toBeNull()
  })

  it('keys rows with the full production UI identity tuple across both collision directions and accounts/spaces', () => {
    // Direction 1: same artifact instance, different catalog entries.
    const entryA = app('entry-a', { artifactInstanceId: 'artifact-shared' })
    const entryB = app('entry-b', { artifactInstanceId: 'artifact-shared' })
    // Direction 2: same catalog entry, different artifact instances.
    const artifactOld = app('entry-c', { artifactInstanceId: 'artifact-old' })
    const artifactNew = app('entry-c', { artifactInstanceId: 'artifact-new' })
    renderView([entryA, entryB, artifactOld, artifactNew])

    const keys = [
      identityKeyForApp(entryA),
      identityKeyForApp(entryB),
      identityKeyForApp(artifactOld),
      identityKeyForApp(artifactNew),
    ]
    expect(new Set(keys).size).toBe(4)
    for (const key of keys) {
      expect(screen.getByTestId(`all-apps-pin-${key}`)).toBeTruthy()
    }
    // Cross-account and cross-space projections never collide either.
    expect(identityKeyForApp(entryA, 'account-b')).not.toBe(identityKeyForApp(entryA))
    expect(identityKeyForApp(entryA, 'account-a', 'space-b')).not.toBe(identityKeyForApp(entryA))
  })

  it('never shows the personal circles description for enterprise All Apps (empty and with data)', () => {
    // Enterprise + data: no circles sentence...
    renderView([app('a')], { spaceKind: 'enterprise' })
    expect(screen.queryByText('Works from 3 circles are shown separately, always labelled with their source circle.')).toBeNull()

    // ...enterprise + empty: still no circles sentence.
    cleanup()
    renderView([], { spaceKind: 'enterprise' })
    expect(screen.getByTestId('all-apps-empty')).toBeTruthy()
    expect(screen.queryByText('Works from 3 circles are shown separately, always labelled with their source circle.')).toBeNull()

    // Personal keeps the circles description for parity.
    cleanup()
    renderView([app('a')], { spaceKind: 'personal' })
    expect(screen.getByText('Works from 3 circles are shown separately, always labelled with their source circle.')).toBeTruthy()
  })
})
