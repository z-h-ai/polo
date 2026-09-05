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

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
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

const scopeKeyForApp = (target: CatalogApp) => `space-a:${target.artifactInstanceId}`

function renderView(apps: CatalogApp[], options: {
  spaceKind?: 'personal' | 'enterprise'
  installedId?: string
  loading?: boolean
  errorCode?: string | null
  retainedInstalledIds?: string[]
} = {}) {
  const handlers = {
    onRefresh: jest.fn(),
    onOpen: jest.fn(),
    onUninstall: jest.fn(),
    onBack: jest.fn(),
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
      offline: false,
      scopeKeyForApp,
      getInstallState: (target: CatalogApp) => target.id === options.installedId
        || options.retainedInstalledIds?.includes(target.id) ? {
        app: {
          accountId: 'account-a',
          productSpaceId: 'space-a',
          catalogEntryId: target.id,
          artifactInstanceId: target.artifactInstanceId!,
          versionId: target.catalogVersion!.versionId,
          version: target.catalogVersion!.version,
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

describe('AllAppsView ProductSpace Catalog boundary', () => {
  it('opens any accessible row and exposes uninstall only for an installed bundle', () => {
    const apps = [app('a'), app('b')]
    const handlers = renderView(apps, { installedId: 'a' })
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(2)

    fireEvent.click(screen.getByTestId('all-apps-action-b'))
    expect(handlers.onOpen).toHaveBeenCalledWith(apps[1])

    fireEvent.click(screen.getAllByTestId('all-apps-row')[0]!.querySelector('button')!)
    fireEvent.click(screen.getByTestId('all-apps-inspector-uninstall'))
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

  it('keeps the stable mobile expanded-row anchor', () => {
    compactViewport = true
    renderView([app('a')])
    fireEvent.click(screen.getByTestId('all-apps-row').querySelector('button')!)
    expect(screen.getByTestId('all-apps-row-detail')).toBeTruthy()
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
      const goneInstalledAction = screen.getByTestId('all-apps-action-gone-installed') as HTMLButtonElement
      const gonePlainAction = screen.getByTestId('all-apps-action-gone-plain') as HTMLButtonElement
      expect(goneInstalledAction.disabled).toBe(true)
      expect(gonePlainAction.disabled).toBe(true)
      expect((screen.getByTestId('all-apps-action-live-a') as HTMLButtonElement).disabled).toBe(false)

      // The retained installation keeps its uninstall entry; the plain
      // tombstone does not.
      fireEvent.click(screen.getAllByTestId('all-apps-row')[1]!.querySelector('button')!)
      expect(screen.getByTestId('all-apps-inspector-uninstall')).toBeTruthy()
      fireEvent.click(screen.getByTestId('all-apps-inspector-uninstall'))
      expect(handlers.onUninstall).toHaveBeenCalledWith(expect.objectContaining({ id: 'gone-installed' }))
      cleanup()
    }
  })

  it('hides the uninstall entry for tombstones without a retained installation', () => {
    renderView([
      app('gone-plain', { name: 'Gone Plain', availability: 'withdrawn', sortOrder: 5 }),
    ], { spaceKind: 'enterprise' })
    fireEvent.click(screen.getByTestId('all-apps-row').querySelector('button')!)
    expect(screen.getByTestId('all-apps-inspector-primary')).toBeTruthy()
    expect(screen.queryByTestId('all-apps-inspector-uninstall')).toBeNull()
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
        getInstallState: () => undefined,
        scopeKeyForApp,
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
