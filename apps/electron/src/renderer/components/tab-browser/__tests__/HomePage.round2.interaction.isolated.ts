import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
  DeniedAppCatalogSnapshot,
} from '@polo-ai/shared/admin'
import { createLocalAppScopeKey } from '@polo-ai/shared/protocol'
import {
  BUILTIN_APP_DEFINITIONS,
  POLO_APP_DEFINITION,
} from '../../../../shared/tab-browser-types'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'

GlobalRegistrator.register()
setupI18n()

const openApp = jest.fn()
let appCatalogHook: any
let installedApps = [...BUILTIN_APP_DEFINITIONS]
const quickAccessByContext = new Map<string, any[]>()
const getHomeQuickAccess = jest.fn(async (contextKey: string) =>
  quickAccessByContext.get(contextKey) ?? [])
const setHomeQuickAccess = jest.fn(async (contextKey: string, apps: any[]) => {
  quickAccessByContext.set(contextKey, apps)
  return apps
})

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function signedOutCatalogHook() {
  return {
    productSpace: null,
    state: {
      catalog: null,
      loading: false,
      refreshing: false,
      warningCode: null,
      errorCode: null,
      statusErrorCode: null,
      statusErrorScopeKeys: {},
      statusLoadingScopeKeys: {},
      accessMode: null,
      statuses: {},
      creatorCircles: [],
      host: null,
    },
    sync: async () => {},
    install: async () => {},
    start: async () => ({
      appId: 'unused',
      version: '1.0.0',
      url: 'http://127.0.0.1:1',
      port: 1,
    }),
    stop: async () => {},
    uninstall: async () => {},
    cancelInstall: async () => {},
    getLogs: async () => '',
    resolveLaunch: async () => {
      throw new Error('resolveLaunch behavior not configured')
    },
    resolveRemoteUrl: async () => 'https://trusted.example.com',
    getStatus: () => undefined,
    scopeKeyForApp: () => 'unused',
    refreshRuntimeStatuses: async () => {},
  }
}

appCatalogHook = signedOutCatalogHook()

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps,
    openApp,
    removeApp: async () => {},
  }),
}))

mock.module('@/hooks/useAppCatalog', () => ({
  useAppCatalog: () => appCatalogHook,
}))

const {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} = await import('@testing-library/react')
const { formatBytes, HomePage } = await import('../HomePage')
const {
  catalogStateMessage,
  homeAppOperationErrorText,
} = await import('@/lib/home-app-errors')

beforeEach(async () => {
  localStorage.clear()
  openApp.mockClear()
  appCatalogHook = signedOutCatalogHook()
  installedApps = [...BUILTIN_APP_DEFINITIONS]
  quickAccessByContext.clear()
  getHomeQuickAccess.mockClear()
  setHomeQuickAccess.mockClear()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getHomeQuickAccess,
      setHomeQuickAccess,
    },
  })
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

function renderHome() {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(HomePage),
  ))
}

async function renderAllApps() {
  const view = renderHome()
  fireEvent.click(screen.getByTestId('home-all-apps-open'))
  await waitFor(() => {
    expect(screen.getByTestId('all-apps-view')).toBeTruthy()
  })
  return view
}

function enterpriseCatalogWith(
  apps: CatalogApp[],
  overrides: Partial<AppCatalogCacheEntry> = {},
): AppCatalogCacheEntry {
  return {
    accountId: 'account-a',
    organizationId: 'organization-a',
    appConfigVersion: 'v1',
    authorizationStatus: 'authorized',
    apps,
    syncedAt: 1,
    ...overrides,
  }
}

function resolvedLaunch(app: CatalogApp, url = 'https://fresh.example.com') {
  return {
    contractVersion: 1,
    productSpaceId: app.organizationId,
    catalogEntryId: app.catalogEntryId ?? app.id,
    resolvedAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:10:00.000Z',
    subject: {
      kind: 'artifact_instance' as const,
      artifactType: 'app' as const,
      artifactInstanceId: app.artifactInstanceId ?? `artifact-${app.id}`,
      versionId: app.catalogVersion?.versionId ?? 'version-1',
      version: app.catalogVersion?.version ?? '1.0.0',
    },
    payer: { kind: 'personal' as const, accountId: 'account-a' },
    delivery: { kind: 'web_url' as const, url, launchToken: 'launch-token-value' },
  }
}

function hookWithCatalog(
  catalog: AppCatalogCacheEntry | DeniedAppCatalogSnapshot,
  hookOverrides: Record<string, unknown> = {},
  stateOverrides: Record<string, unknown> = {},
) {
  const scopeKeyForApp = (target: CatalogApp) => createLocalAppScopeKey({
    kind: 'catalog',
    accountId: catalog.accountId,
    organizationId: catalog.organizationId,
    catalogAppId: target.id,
  })
  return {
    ...signedOutCatalogHook(),
    productSpace: {
      accountId: catalog.accountId,
      activeProductSpaceId: catalog.organizationId,
      productSpaceContextKey: createProductSpaceContextKey(
        catalog.accountId,
        catalog.organizationId,
      ),
      activeProductSpace: {
        id: catalog.organizationId,
        kind: 'enterprise',
        name: 'Organization A',
      },
    },
    state: {
      ...signedOutCatalogHook().state,
      catalog,
      accessMode: 'online',
      ...stateOverrides,
    },
    scopeKeyForApp,
    ...hookOverrides,
  }
}

describe('HomePage quick access (POO-43)', () => {
  it('always shows the fixed Polo assistant and opens the Polo tab', () => {
    renderHome()

    const poloEntry = screen.getByTestId('home-quick-entry-polo')
    expect(within(poloEntry).getByText('Polo 助手')).toBeTruthy()
    fireEvent.click(poloEntry)
    expect(openApp).toHaveBeenCalledWith(POLO_APP_DEFINITION)
  })

  it('hides space management entries when no ProductSpace context exists', () => {
    renderHome()

    expect(screen.queryByTestId('home-all-apps-open')).toBeNull()
    expect(screen.queryByTestId('home-manage-quick-access')).toBeNull()
    expect(screen.queryByTestId('add-external-app')).toBeNull()
  })

  it('renders persisted quick-access entries from the active space Catalog', async () => {
    const appA: CatalogApp = {
      id: 'quick-app-a',
      organizationId: 'organization-a',
      name: 'Quick App A',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    quickAccessByContext.set(contextKey, [{
      id: appCatalogHook.scopeKeyForApp(appA),
      addedAt: 1,
    }])

    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry')).toBeTruthy()
    })
    expect(screen.getByText('Quick App A')).toBeTruthy()
  })

  it('prunes stale quick-access ids and persists the pruned list', async () => {
    const appA: CatalogApp = {
      id: 'prune-app-a',
      organizationId: 'organization-a',
      name: 'Prune App A',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    quickAccessByContext.set(contextKey, [
      { id: appCatalogHook.scopeKeyForApp(appA), addedAt: 1 },
      // Another space's scope key and a legacy local id must both vanish.
      { id: '["catalog","account-b","organization-z","ghost"]', addedAt: 2 },
      { id: 'legacy-local-app', addedAt: 3 },
    ])

    renderHome()

    await waitFor(() => {
      expect(setHomeQuickAccess).toHaveBeenCalledTimes(1)
    })
    const [savedContext, savedApps] = setHomeQuickAccess.mock.calls[0]!
    expect(savedContext).toBe(contextKey)
    expect(savedApps).toEqual([{
      id: appCatalogHook.scopeKeyForApp(appA),
      addedAt: 1,
    }])
    expect(screen.getByText('Prune App A')).toBeTruthy()
    expect(screen.queryByText('ghost')).toBeNull()
  })

  it('opens quick-access Apps through the authorized catalog flow', async () => {
    const appA: CatalogApp = {
      id: 'open-app-a',
      organizationId: 'organization-a',
      name: 'Open App A',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]), {
      resolveLaunch: jest.fn(async () => resolvedLaunch(appA)),
    })
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    quickAccessByContext.set(contextKey, [{
      id: appCatalogHook.scopeKeyForApp(appA),
      addedAt: 1,
    }])

    renderHome()
    fireEvent.click(await screen.findByText('Open App A'))

    await waitFor(() => {
      expect(openApp).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Open App A',
        url: 'https://fresh.example.com',
      }))
    })
  })

  it('adds a shortcut through the manage dialog without installing', async () => {
    const appA: CatalogApp = {
      id: 'manage-app-a',
      organizationId: 'organization-a',
      name: 'Manage App A',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'available',
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`

    renderHome()
    fireEvent.click(screen.getByTestId('home-manage-quick-access'))
    await waitFor(() => {
      expect(screen.getByTestId('manage-home-apps-dialog')).toBeTruthy()
    })

    const item = screen.getByTestId('manage-home-apps-item')
    expect(item.getAttribute('data-app-id')).toBe('manage-app-a')
    fireEvent.click(item)
    fireEvent.click(screen.getByTestId('manage-home-apps-done'))
    await waitFor(() => {
      expect(setHomeQuickAccess).toHaveBeenCalledWith(contextKey, [{
        id: appCatalogHook.scopeKeyForApp(appA),
        addedAt: expect.any(Number),
      }])
    })
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry')).toBeTruthy()
    })
    expect(screen.getByText('Manage App A')).toBeTruthy()
  })

  it('shows the add-shortcut tile only with free slots and a Catalog', () => {
    const appA: CatalogApp = {
      id: 'tile-app-a',
      organizationId: 'organization-a',
      name: 'Tile App A',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const view = renderHome()
    expect(screen.getByTestId('home-quick-access-add')).toBeTruthy()
    view.unmount()

    // No ProductSpace context → no add tile.
    appCatalogHook = signedOutCatalogHook()
    const signedOut = renderHome()
    expect(signedOut.queryByTestId('home-quick-access-add')).toBeNull()
  })
})

describe('HomePage all-Apps view (POO-43)', () => {
  it('resolves the exact Catalog launch through main before opening a WebView', async () => {
    const remoteApp: CatalogApp = {
      id: 'remote-app',
      organizationId: 'organization-a',
      name: 'Remote App',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://stale.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    const resolveLaunch = jest.fn(async () => {
      throw new Error('NOT_AUTHORIZED')
    })
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([remoteApp]),
      { resolveLaunch },
    )

    await renderAllApps()
    fireEvent.click(screen.getByTestId('all-apps-action-remote-app'))

    await waitFor(() => {
      expect(resolveLaunch).toHaveBeenCalledWith(remoteApp)
    })
    expect(openApp).not.toHaveBeenCalled()
  })

  it('shows a retry action when a runtime-status batch cannot be read', async () => {
    const localApp: CatalogApp = {
      id: 'unknown-status-app',
      organizationId: 'organization-a',
      name: 'Unknown Status App',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'available',
    }
    const catalog = enterpriseCatalogWith([localApp])
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: localApp.id,
    })
    const refreshRuntimeStatuses = jest.fn(async () => {})
    appCatalogHook = hookWithCatalog(
      catalog,
      { refreshRuntimeStatuses },
      {
        statusErrorCode: 'status_read_failed',
        statusErrorScopeKeys: { [scopeKey]: true },
      },
    )

    await renderAllApps()

    expect(screen.getByText('Some app statuses could not be refreshed.')).toBeTruthy()
    expect(screen.getByText('Status unavailable')).toBeTruthy()
    expect(screen.getByTestId('all-apps-action-unknown-status-app')
      .hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText('Try again'))
    expect(refreshRuntimeStatuses).toHaveBeenCalledTimes(1)
  })

  it('disables install while the initial runtime status is loading', async () => {
    const localApp: CatalogApp = {
      id: 'loading-status-app',
      organizationId: 'organization-a',
      name: 'Loading Status App',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'available',
    }
    const catalog = enterpriseCatalogWith([localApp])
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: localApp.id,
    })
    appCatalogHook = hookWithCatalog(
      catalog,
      {},
      { statusLoadingScopeKeys: { [scopeKey]: true } },
    )

    await renderAllApps()

    expect(screen.getAllByText('Loading status…')).toHaveLength(2)
    expect(screen.getByTestId('all-apps-action-loading-status-app')
      .hasAttribute('disabled')).toBe(true)
  })

  it('keeps a retained withdrawn app manageable when its first status batch fails', async () => {
    const withdrawnApp: CatalogApp = {
      id: 'retained-withdrawn',
      organizationId: 'organization-a',
      name: 'Retained Withdrawn',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'withdrawn',
    }
    const catalog = enterpriseCatalogWith([], {
      appConfigVersion: 'v1',
      withdrawnApps: [withdrawnApp],
    })
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: withdrawnApp.id,
    })
    appCatalogHook = hookWithCatalog(
      catalog,
      {},
      {
        statusErrorCode: 'status_read_failed',
        statusErrorScopeKeys: { [scopeKey]: true },
      },
    )

    await renderAllApps()

    expect(screen.getByTestId('all-apps-row')).toBeTruthy()
    expect(screen.getByText('Retained Withdrawn')).toBeTruthy()
    expect(screen.getByText('Status unavailable')).toBeTruthy()
    expect(screen.getByTestId('all-apps-action-retained-withdrawn')
      .hasAttribute('disabled')).toBe(true)
    const management = screen.getByLabelText(
      'More actions for Retained Withdrawn',
    )
    expect(management).toBeTruthy()
    fireEvent.pointerDown(management, { button: 0, ctrlKey: false })
    await waitFor(() => {
      expect(screen.getByText('Uninstall')).toBeTruthy()
      expect(screen.getByText('Stop')).toBeTruthy()
      expect(screen.queryByText('View logs')).toBeNull()
    })
  })

  it('keeps an installed app manageable from a denied NETWORK_ERROR cold snapshot', async () => {
    const deniedApp = {
      id: 'denied-installed',
      organizationId: 'organization-a',
      name: 'Denied Installed',
      description: '',
      deliveryMode: 'local_bundle' as const,
      sortOrder: 0,
      availability: 'unavailable' as const,
    }
    const catalog: DeniedAppCatalogSnapshot = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'denied',
      authorizationStatus: 'denied',
      apps: [deniedApp],
      syncedAt: 1,
    }
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: deniedApp.id,
    })
    const status = {
      appId: deniedApp.id,
      scope: {
        kind: 'catalog' as const,
        accountId: catalog.accountId,
        organizationId: catalog.organizationId,
        catalogAppId: deniedApp.id,
      },
      status: 'running' as const,
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
    }
    const stop = jest.fn(async () => {})
    const getLogs = jest.fn(async () => 'retained log output')
    appCatalogHook = hookWithCatalog(
      catalog,
      { stop, getLogs, getStatus: () => status },
      {
        accessMode: 'denied',
        errorCode: 'NETWORK_ERROR',
        statuses: { [scopeKey]: status },
      },
    )

    await renderAllApps()

    expect(screen.getByText('Denied Installed')).toBeTruthy()
    expect(screen.getByText('Access removed by your organization')).toBeTruthy()
    expect(screen.getByTestId('all-apps-action-denied-installed')
      .hasAttribute('disabled')).toBe(true)

    const management = screen.getByLabelText('More actions for Denied Installed')
    fireEvent.pointerDown(management, { button: 0, ctrlKey: false })
    await waitFor(() => {
      expect(screen.getByText('Stop')).toBeTruthy()
      expect(screen.getByText('Uninstall')).toBeTruthy()
      expect(screen.getByText('View logs')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('View logs'))
    await waitFor(() => {
      expect(screen.getByText('retained log output')).toBeTruthy()
    })
    expect(getLogs).toHaveBeenCalledWith(deniedApp)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.pointerDown(management, { button: 0, ctrlKey: false })
    await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy())
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => {
      expect(stop).toHaveBeenCalledWith(deniedApp)
    })
  })

  it('segments a maximum catalog and excludes withdrawn apps without local data', async () => {
    const visibleApps: CatalogApp[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        id: `visible-${index}`,
        organizationId: 'organization-a',
        name: `Visible ${index}`,
        description: '',
        deliveryMode: 'remote_url' as const,
        remoteUrl: `https://example.com/${index}`,
        sortOrder: index,
        availability: 'available' as const,
      }),
    )
    const withdrawnApps: CatalogApp[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        id: `withdrawn-${index}`,
        organizationId: 'organization-a',
        name: `Withdrawn ${index}`,
        description: '',
        deliveryMode: 'local_bundle' as const,
        sortOrder: index + 20_000,
        availability: 'withdrawn' as const,
      }),
    )
    withdrawnApps[9_999] = {
      ...withdrawnApps[9_999]!,
      name: 'Installed Withdrawn',
      sortOrder: -1,
    }
    const catalog = enterpriseCatalogWith(visibleApps, {
      appConfigVersion: 'maximum',
      withdrawnApps,
    })
    const installedWithdrawn = withdrawnApps[9_999]!
    const installedScopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: installedWithdrawn.id,
    })
    const statuses = {
      [installedScopeKey]: {
        appId: installedWithdrawn.id,
        scope: {
          kind: 'catalog' as const,
          accountId: 'account-a',
          organizationId: 'organization-a',
          catalogAppId: installedWithdrawn.id,
        },
        status: 'installed' as const,
        currentVersion: '1.0.0',
      },
    }
    appCatalogHook = hookWithCatalog(
      catalog,
      {
        getStatus: (target: CatalogApp) => {
          const scopeKey = appCatalogHook.scopeKeyForApp(target)
          return statuses[scopeKey]
        },
      },
      { statuses },
    )

    await renderAllApps()

    expect(document.querySelectorAll(
      '[data-testid="all-apps-row"]',
    )).toHaveLength(60)
    expect(screen.getByText('Installed Withdrawn')).toBeTruthy()
    expect(screen.queryByText('Withdrawn 0')).toBeNull()

    fireEvent.click(screen.getByText('Load more'))
    expect(document.querySelectorAll(
      '[data-testid="all-apps-row"]',
    )).toHaveLength(120)
  })

  it('keeps deferred log results isolated by full App scope and request generation', async () => {
    const appA: CatalogApp = {
      id: 'broken-app-a',
      organizationId: 'organization-a',
      name: 'Broken App A',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'available',
    }
    const appB: CatalogApp = {
      ...appA,
      id: 'broken-app-b',
      name: 'Broken App B',
      sortOrder: 1,
    }
    const catalog = enterpriseCatalogWith([appA, appB], {
      appConfigVersion: 'logs-race',
    })
    const scopeKeyForApp = (app: CatalogApp) => createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: app.id,
    })
    const statuses = Object.fromEntries([appA, appB].map(app => [
      scopeKeyForApp(app),
      {
        appId: app.id,
        scope: {
          kind: 'catalog' as const,
          accountId: catalog.accountId,
          organizationId: catalog.organizationId,
          catalogAppId: app.id,
        },
        status: 'broken' as const,
        currentVersion: '1.0.0',
        error: {
          code: 'START_FAILED',
          message: 'health check failed',
        },
      },
    ]))
    const appALogs = createDeferred<string>()
    const appBLogs = createDeferred<string>()
    const getLogs = jest.fn((app: CatalogApp) => (
      app.id === appA.id ? appALogs.promise : appBLogs.promise
    ))
    appCatalogHook = hookWithCatalog(
      catalog,
      { getLogs },
      { statuses },
    )
    appCatalogHook.getStatus = (app: CatalogApp) => statuses[scopeKeyForApp(app)]

    await renderAllApps()

    fireEvent.pointerDown(
      screen.getByLabelText('More actions for Broken App A'),
      { button: 0, ctrlKey: false },
    )
    await waitFor(() => expect(screen.getByText('View logs')).toBeTruthy())
    fireEvent.click(screen.getByText('View logs'))
    expect(screen.getByText('Broken App A logs')).toBeTruthy()
    expect(screen.getByText('Loading logs…')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.queryByText('Broken App A logs')).toBeNull()
    })
    fireEvent.pointerDown(
      screen.getByLabelText('More actions for Broken App B'),
      { button: 0, ctrlKey: false },
    )
    await waitFor(() => expect(screen.getByText('View logs')).toBeTruthy())
    fireEvent.click(screen.getByText('View logs'))
    expect(screen.getByText('Broken App B logs')).toBeTruthy()
    expect(screen.getByText('Loading logs…')).toBeTruthy()

    await act(async () => {
      appALogs.resolve('stale App A logs')
      await appALogs.promise
    })
    expect(screen.queryByText('stale App A logs')).toBeNull()
    expect(screen.getByText('Loading logs…')).toBeTruthy()

    await act(async () => {
      appBLogs.resolve('current App B logs')
      await appBLogs.promise
    })
    await waitFor(() => {
      expect(screen.getByText('current App B logs')).toBeTruthy()
    })
    expect(screen.queryByText('stale App A logs')).toBeNull()
    expect(getLogs).toHaveBeenNthCalledWith(1, appA)
    expect(getLogs).toHaveBeenNthCalledWith(2, appB)
  })

  it('closes deferred logs when switching between legacy-colliding contexts', async () => {
    const accountA = 'account:west'
    const organizationAId = '组织'
    const accountB = 'account'
    const organizationBId = 'west:组织'
    expect(`${accountA}:${organizationAId}`)
      .toBe(`${accountB}:${organizationBId}`)

    const pendingLogs = createDeferred<string>()
    const brokenApp = (
      accountId: string,
      organizationId: string,
    ): {
      app: CatalogApp
      hook: any
    } => {
      const app: CatalogApp = {
        id: 'shared-broken-app',
        organizationId,
        name: `Broken ${accountId}`,
        description: '',
        deliveryMode: 'local_bundle',
        sortOrder: 0,
        availability: 'available',
      }
      const catalog = enterpriseCatalogWith([app], {
        accountId,
        organizationId,
        appConfigVersion: `catalog-${accountId}`,
      })
      const scopeKey = createLocalAppScopeKey({
        kind: 'catalog',
        accountId,
        organizationId,
        catalogAppId: app.id,
      })
      const status = {
        appId: app.id,
        scope: {
          kind: 'catalog' as const,
          accountId,
          organizationId,
          catalogAppId: app.id,
        },
        status: 'broken' as const,
        currentVersion: '1.0.0',
        error: {
          code: 'START_FAILED',
          message: 'health check failed',
        },
      }
      return {
        app,
        hook: {
          ...signedOutCatalogHook(),
          productSpace: {
            accountId,
            activeProductSpaceId: organizationId,
            productSpaceContextKey: createProductSpaceContextKey(
              accountId,
              organizationId,
            ),
            activeProductSpace: {
              id: organizationId,
              kind: 'enterprise',
              name: organizationId,
            },
          },
          state: {
            ...signedOutCatalogHook().state,
            catalog,
            accessMode: 'online',
            statuses: { [scopeKey]: status },
          },
          getStatus: () => status,
          scopeKeyForApp: () => scopeKey,
          getLogs: () => pendingLogs.promise,
        },
      }
    }
    const contextA = brokenApp(accountA, organizationAId)
    const contextB = brokenApp(accountB, organizationBId)
    expect(contextA.hook.productSpace.productSpaceContextKey)
      .not.toBe(contextB.hook.productSpace.productSpaceContextKey)

    appCatalogHook = contextA.hook
    const view = renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.pointerDown(
      screen.getByLabelText(`More actions for ${contextA.app.name}`),
      { button: 0, ctrlKey: false },
    )
    await waitFor(() => expect(screen.getByText('View logs')).toBeTruthy())
    fireEvent.click(screen.getByText('View logs'))
    expect(screen.getByText(`${contextA.app.name} logs`)).toBeTruthy()

    appCatalogHook = contextB.hook
    view.rerender(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage),
    ))
    await waitFor(() => {
      expect(screen.queryByText(`${contextA.app.name} logs`)).toBeNull()
    })
    // Fail-closed space transition: the in-place all-Apps view resets home
    // and the deferred log dialog never publishes across contexts.
    expect(screen.queryByTestId('all-apps-view')).toBeNull()

    await act(async () => {
      pendingLogs.resolve('stale account A logs')
      await pendingLogs.promise
    })
    expect(screen.queryByText('stale account A logs')).toBeNull()

    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    expect(screen.getByText(contextB.app.name)).toBeTruthy()
  })
})

describe('HomePage copy and formatting', () => {
  it('maps operation and catalog codes through the active non-English locale', async () => {
    await i18n.changeLanguage('zh-Hans')
    const secret = 'backend stack detail must stay hidden'

    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'START_FAILED', message: secret },
      'open',
    )).toBe('无法打开应用。')
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'UNINSTALL_FAILED', message: secret },
      'uninstall',
    )).toBe('无法卸载应用。')
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'RELEASE_CHANGED', message: secret },
      'install',
    )).toBe('应用发布版本已变更，请确认更新后的版本再安装。')
    expect(catalogStateMessage(
      i18n.t.bind(i18n),
      'NETWORK_ERROR',
      'warning',
    )).toContain('离线')
    expect(catalogStateMessage(
      i18n.t.bind(i18n),
      'INVALID_SEMVER',
      'warning',
    )).not.toContain(secret)
  })

  it('formats install sizes through locale unit keys', async () => {
    await i18n.changeLanguage('en')
    expect(formatBytes(i18n.t.bind(i18n), 512)).toBe('512 B')
    expect(formatBytes(i18n.t.bind(i18n), 1024 ** 3)).toBe('1.0 GB')

    await i18n.changeLanguage('zh-Hans')
    expect(formatBytes(i18n.t.bind(i18n), 512)).toBe('512 字节')
    expect(formatBytes(i18n.t.bind(i18n), 1024 ** 2)).toBe('1.0 MB')

    await i18n.changeLanguage('de')
    expect(formatBytes(i18n.t.bind(i18n), 1)).toBe('1 Byte')
  })
})
