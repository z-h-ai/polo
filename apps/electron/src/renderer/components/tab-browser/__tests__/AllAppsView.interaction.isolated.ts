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
const { AllAppsView, groupAllAppsForDisplay } = await import('../AllAppsView')

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
      getInstallState: (target: CatalogApp) => target.id === options.installedId ? {
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
