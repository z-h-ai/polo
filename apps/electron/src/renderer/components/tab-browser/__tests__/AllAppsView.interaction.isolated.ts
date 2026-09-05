import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'

GlobalRegistrator.register()
setupI18n()

let compactViewport = false
mock.module('@/lib/use-compact-viewport', () => ({
  useCompactViewport: () => compactViewport,
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
)
const { AllAppsView, groupAllAppsForDisplay } = await import('../AllAppsView')

const scopeKeys = new Map<string, string>()

function app(
  id: string,
  overrides: Partial<CatalogApp> = {},
): CatalogApp {
  return {
    id,
    organizationId: 'space-a',
    name: `App ${id}`,
    description: `${id} description`,
    deliveryMode: 'remote_url',
    remoteUrl: `https://${id}.example.com`,
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

function scopeKeyForApp(target: CatalogApp): string {
  if (!scopeKeys.has(target.id)) {
    scopeKeys.set(target.id, `["catalog","account-a","space-a","${target.id}"]`)
  }
  return scopeKeys.get(target.id)!
}

interface HarnessOverrides {
  status?: LocalAppRuntimeStatus
  statusError?: boolean
}

function renderView(
  apps: CatalogApp[],
  options: {
    spaceKind?: 'personal' | 'enterprise' | null
    spaceName?: string
    overrides?: HarnessOverrides
  } = {},
) {
  const handlers = {
    onRefresh: jest.fn(),
    onRetryStatuses: jest.fn(),
    onPrimaryAction: jest.fn(),
    onStop: jest.fn(),
    onUninstall: jest.fn(),
    onViewLogs: jest.fn(),
    onBack: jest.fn(),
  }
  const view = render(createElement(
    I18nextProvider,
    { i18n },
    createElement(AllAppsView, {
      spaceName: options.spaceName ?? '我的空间',
      spaceKind: options.spaceKind ?? 'personal',
      apps,
      loading: false,
      refreshing: false,
      warningCode: null,
      errorCode: null,
      offline: false,
      statusErrorCode: options.overrides?.statusError ? 'status_read_failed' : null,
      statusLoadingScopeKeys: {},
      statusErrorScopeKeys: options.overrides?.statusError
        ? { [scopeKeyForApp(apps[0]!)]: true as const }
        : {},
      scopeKeyForApp,
      getStatus: () => options.overrides?.status,
      compatibleWithHost: () => true,
      ...handlers,
    }),
  ))
  return { view, handlers }
}

beforeEach(async () => {
  compactViewport = false
  scopeKeys.clear()
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

describe('groupAllAppsForDisplay', () => {
  it('groups personal-space Apps by source without merging same-named entries', () => {
    const apps = [
      app('a', { name: '同名著产', creatorName: '圈子一', sortOrder: 0 }),
      app('b', { name: '同名著产', creatorName: '圈子二', sortOrder: 1 }),
      app('c', { name: 'Other', creatorName: '圈子一', sortOrder: 2 }),
      app('d', { name: 'No Source', sortOrder: 3 }),
    ]
    const groups = groupAllAppsForDisplay(apps, 'personal')
    expect(groups.map(group => group.label)).toEqual(['圈子一', '圈子二', ''])
    expect(groups[0]!.apps.map(entry => entry.id)).toEqual(['a', 'c'])
    expect(groups[1]!.apps.map(entry => entry.id)).toEqual(['b'])
    expect(groups[2]!.apps.map(entry => entry.id)).toEqual(['d'])
  })

  it('renders enterprise spaces as one flat group', () => {
    const apps = [
      app('a', { creatorName: 'Circle A' }),
      app('b', { creatorName: 'Circle B' }),
    ]
    const groups = groupAllAppsForDisplay(apps, 'enterprise')
    expect(groups).toEqual([{ key: 'all', label: '', apps }])
    expect(groupAllAppsForDisplay(apps, null)).toEqual([
      { key: 'all', label: '', apps },
    ])
  })
})

describe('AllAppsView list rows', () => {
  it('shows one row per artifact instance with its source label', () => {
    const apps = [
      app('a', { name: 'Same Name', creatorName: 'Circle One' }),
      app('b', { name: 'Same Name', creatorName: 'Circle Two' }),
    ]
    renderView(apps, { spaceKind: 'personal' })

    const rows = screen.getAllByTestId('all-apps-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-app-id')).toBe('a')
    expect(rows[1]!.getAttribute('data-app-id')).toBe('b')
    const sources = screen.getAllByTestId('all-apps-row-source')
    expect(sources[0]!.textContent).toBe('Circle One')
    expect(sources[1]!.textContent).toBe('Circle Two')
    // Group headers render for personal spaces.
    expect(screen.getAllByTestId('all-apps-group-label').map(
      node => node.textContent,
    )).toEqual(['Circle One', 'Circle Two'])
  })

  it('omits group headers for enterprise spaces', () => {
    renderView([app('a'), app('b')], { spaceKind: 'enterprise' })
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(2)
    expect(screen.queryByTestId('all-apps-group-label')).toBeNull()
  })

  it('opens an App through its primary action with catalog identity', async () => {
    const target = app('remote-a')
    const { handlers } = renderView([target])
    fireEvent.click(screen.getByTestId(`all-apps-action-${target.id}`))
    expect(handlers.onPrimaryAction).toHaveBeenCalledWith(target, 'open')
  })

  it('falls back to an unknown-source label instead of hiding provenance', () => {
    renderView([app('no-source', { creatorName: undefined })])
    expect(screen.getByTestId('all-apps-row-source').textContent)
      .toBe('Unknown source')
  })

  it('searches the complete Catalog by App name or authoritative source', () => {
    renderView([
      app('alpha', { name: 'Alpha', sourceNames: ['Circle North'] }),
      app('beta', { name: 'Beta', sourceNames: ['Circle South'] }),
    ])

    fireEvent.change(screen.getByTestId('all-apps-search'), {
      target: { value: 'south' },
    })
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(1)
    expect(screen.getByTestId('all-apps-row').getAttribute('data-app-id')).toBe('beta')
    expect(screen.getByTestId('all-apps-count').textContent).toContain('1')

    fireEvent.change(screen.getByTestId('all-apps-search'), {
      target: { value: 'missing' },
    })
    expect(screen.getByTestId('all-apps-no-results')).toBeTruthy()
  })
})

describe('AllAppsView inspector', () => {
  it('opens a desktop side inspector with source, version, and actions', async () => {
    const target = app('inspect-a', {
      creatorName: 'Circle Inspect',
      deliveryMode: 'local_bundle',
      currentRelease: {
        version: '2.0.0',
        runtime: 'static' as const,
        checksum: 'a'.repeat(64),
        sizeBytes: 1,
      },
      permissions: ['Network access'],
    })
    const status: LocalAppRuntimeStatus = {
      appId: target.id,
      scope: {
        kind: 'catalog',
        accountId: 'account-a',
        organizationId: 'space-a',
        catalogAppId: target.id,
      },
      status: 'running',
      currentVersion: '1.0.0',
    }
    const { handlers } = renderView([target], { overrides: { status } })

    fireEvent.click(screen.getByTestId('all-apps-row').querySelector('button')!)
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-inspector')).toBeTruthy()
    })
    expect(screen.getByTestId('all-apps-inspector-source').textContent)
      .toBe('Circle Inspect')
    expect(screen.getByTestId('all-apps-inspector-source-value').textContent)
      .toBe('Circle Inspect')
    expect(screen.getByText('1.0.0')).toBeTruthy()
    expect(screen.getByText('Network access')).toBeTruthy()

    fireEvent.click(screen.getByTestId('all-apps-inspector-stop'))
    expect(handlers.onStop).toHaveBeenCalledWith(target)
    fireEvent.click(screen.getByTestId('all-apps-inspector-uninstall'))
    expect(handlers.onUninstall).toHaveBeenCalledWith(target)
    // Healthy authorized Apps never expose runtime logs (frozen rule).
    expect(screen.queryByTestId('all-apps-inspector-logs')).toBeNull()
  })

  it('renders the inspector inline as a mobile expanded row on compact viewports', async () => {
    compactViewport = true
    const target = app('compact-a')
    renderView([target])

    expect(screen.queryByTestId('all-apps-inspector')).toBeNull()
    fireEvent.click(screen.getByTestId('all-apps-row').querySelector('button')!)
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-row-detail')).toBeTruthy()
    })
    expect(screen.getByTestId('all-apps-inspector-body')).toBeTruthy()
    // The expanded row lives inside the selected row element.
    const row = screen.getByTestId('all-apps-row')
    expect(row.getAttribute('data-app-id')).toBe('compact-a')
    expect(row.querySelector('[data-testid="all-apps-row-detail"]')).toBeTruthy()
  })

  it('closes the inspector when the selected entry leaves the view', async () => {
    const target = app('closing-a')
    const { view } = renderView([target])
    fireEvent.click(screen.getByTestId('all-apps-row').querySelector('button')!)
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-inspector')).toBeTruthy()
    })

    view.rerender(createElement(
      I18nextProvider,
      { i18n },
      createElement(AllAppsView, {
        spaceName: '我的空间',
        spaceKind: 'personal',
        apps: [],
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        offline: false,
        statusErrorCode: null,
        statusLoadingScopeKeys: {},
        statusErrorScopeKeys: {},
        scopeKeyForApp,
        getStatus: () => undefined,
        compatibleWithHost: () => true,
        onRefresh: () => {},
        onRetryStatuses: () => {},
        onPrimaryAction: () => {},
        onStop: () => {},
        onUninstall: () => {},
        onViewLogs: () => {},
        onBack: () => {},
      }),
    ))
    await waitFor(() => {
      expect(screen.queryByTestId('all-apps-inspector')).toBeNull()
    })
  })
})

describe('AllAppsView states', () => {
  it('shows loading, failure, and empty states with retry and back', async () => {
    const handlers = {
      onRefresh: jest.fn(),
      onRetryStatuses: jest.fn(),
      onPrimaryAction: jest.fn(),
      onStop: jest.fn(),
      onUninstall: jest.fn(),
      onViewLogs: jest.fn(),
      onBack: jest.fn(),
    }
    const props = {
      spaceName: 'Organization A',
      spaceKind: 'enterprise' as const,
      apps: [] as CatalogApp[],
      loading: true,
      refreshing: false,
      warningCode: null,
      errorCode: null,
      offline: false,
      statusErrorCode: null,
      statusLoadingScopeKeys: {},
      statusErrorScopeKeys: {},
      scopeKeyForApp,
      getStatus: () => undefined,
      compatibleWithHost: () => true,
      ...handlers,
    }
    const view = render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AllAppsView, props),
    ))

    expect(screen.getByTestId('all-apps-loading')).toBeTruthy()

    view.rerender(createElement(
      I18nextProvider,
      { i18n },
      createElement(AllAppsView, {
        ...props,
        loading: false,
        errorCode: 'NETWORK_ERROR',
      }),
    ))
    expect(screen.getByText('Could not load the Apps of this space')).toBeTruthy()
    fireEvent.click(screen.getByText('Try again'))
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1)

    view.rerender(createElement(
      I18nextProvider,
      { i18n },
      createElement(AllAppsView, {
        ...props,
        loading: false,
        errorCode: null,
      }),
    ))
    expect(screen.getByText('No accessible Apps in this space yet')).toBeTruthy()
    expect(screen.getByText(
      'Apps distributed to members by your enterprise will appear here.',
    )).toBeTruthy()

    fireEvent.click(screen.getByTestId('all-apps-back'))
    expect(handlers.onBack).toHaveBeenCalledTimes(1)
  })
})
