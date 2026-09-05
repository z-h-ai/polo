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
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'

GlobalRegistrator.register()
setupI18n()

const openApp = jest.fn()
const storePublish = jest.fn((_live: unknown, accountId: string, launch: unknown) => ({
  handoffId: 'test-handoff',
  context: { accountId, launch },
}))
const adminGetStatus = jest.fn()
const openUrl = jest.fn()
let appCatalogHook: any
let installedApps = [...BUILTIN_APP_DEFINITIONS]
const quickAccessByContext = new Map<string, any[]>()
const getHomeQuickAccess = jest.fn(async (contextKey: string) =>
  quickAccessByContext.get(contextKey) ?? [])
async function defaultSetHomeQuickAccess(contextKey: string, apps: any[]) {
  quickAccessByContext.set(contextKey, apps)
  return apps
}
const setHomeQuickAccess = jest.fn(defaultSetHomeQuickAccess)

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
      installStates: {},
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
    getInstallState: () => undefined,
    installProductSpaceBundle: async () => {},
    uninstallProductSpaceBundle: async () => {},
    scopeKeyForApp: () => 'unused',
    refreshRuntimeStatuses: async () => {},
    refreshProductSpaceInstallStates: async () => {},
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

mock.module('@/lib/product-space-app-launch-handoff', () => ({
  createProductSpaceLaunchHandoffStore: () => ({
    publish: storePublish,
    take: jest.fn(() => null),
    onLaunch: () => () => {},
    commitContext: jest.fn(),
    dispose: jest.fn(),
  }),
}))

const {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} = await import('@testing-library/react')
const { formatBytes, HomePage, selectAllAppsForDisplay } = await import('../HomePage')
const {
  catalogStateMessage,
  homeAppOperationErrorText,
} = await import('@/lib/home-app-errors')

beforeEach(async () => {
  localStorage.clear()
  openApp.mockClear()
  storePublish.mockClear()
  adminGetStatus.mockReset()
  openUrl.mockReset()
  appCatalogHook = signedOutCatalogHook()
  installedApps = [...BUILTIN_APP_DEFINITIONS]
  quickAccessByContext.clear()
  getHomeQuickAccess.mockClear()
  setHomeQuickAccess.mockClear()
  setHomeQuickAccess.mockImplementation(defaultSetHomeQuickAccess)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getHomeQuickAccess,
      setHomeQuickAccess,
      adminGetStatus,
      openUrl,
    },
  })
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

function homeTree() {
  // HomePage publishes through the Provider-owned handoff store; the
  // provider value mirrors the mocked catalog hook's committed context.
  const ps = appCatalogHook.productSpace
  const value = {
    accountId: ps?.accountId ?? 'account-a',
    activeProductSpaceId: ps?.activeProductSpaceId ?? 'organization-a',
    activeProductSpace: ps?.activeProductSpace
      ?? { id: 'organization-a', kind: 'enterprise', name: 'Organization A' },
    productSpaces: [],
    allProductSpaces: [],
    personalProductSpaceId: ps?.activeProductSpaceId ?? 'organization-a',
    productSpaceContextKey: ps?.productSpaceContextKey ?? 'account-a|organization-a',
    contextVersion: 0,
    pendingSwitch: null,
    onSelectProductSpace: () => {},
    onRefreshProductSpaces: () => {},
    onConfirmStopAndSwitch: () => {},
    onRetryFailedStops: () => {},
    onRetryTargetLoad: () => {},
    onCancelSwitch: () => {},
    onDismissTargetAccessLost: () => {},
    onStopSwitchExecution: () => {},
  }
  return createElement(ProductSpaceProvider, {
    value: value as never,
    children: createElement(I18nextProvider, { i18n }, createElement(HomePage)),
  })
}

function renderHome() {
  return render(homeTree())
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

function resolvedBundleLaunch(app: CatalogApp) {
  const base = resolvedLaunch(app)
  return {
    ...base,
    delivery: {
      kind: 'bundle' as const,
      downloadUrl: 'https://fresh.example.com/app.zip',
      expiresAt: base.expiresAt,
      checksum: 'a'.repeat(64),
      sizeBytes: 1_024,
    },
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

  it('never writes a pending space-A quick-access save into space B after a switch', async () => {
    const appA: CatalogApp = {
      id: 'race-app-a',
      organizationId: 'organization-a',
      name: 'Race App A',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    const appB: CatalogApp = {
      id: 'race-app-b',
      organizationId: 'organization-b',
      name: 'Race App B',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://b.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    const contextKeyA = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const contextKeyB = `v1:${
      createProductSpaceContextKey('account-a', 'organization-b')
    }`
    quickAccessByContext.set(contextKeyA, [{
      id: 'key:race-app-a',
      addedAt: 1,
    }])
    quickAccessByContext.set(contextKeyB, [{
      id: 'key:race-app-b',
      addedAt: 1,
    }])
    appCatalogHook = {
      ...hookWithCatalog(enterpriseCatalogWith([appA])),
      scopeKeyForApp: (target: CatalogApp) => `key:${target.id}`,
    }
    const view = renderHome()
    await waitFor(() => {
      expect(screen.getByText('Race App A')).toBeTruthy()
    })

    // Gate the space-A write-back so it is still in flight across the
    // context switch — the exact race window from the review finding.
    let releaseSpaceASave!: (saved: unknown) => void
    const gatedSpaceASave = new Promise(resolve => {
      releaseSpaceASave = resolve
    })
    setHomeQuickAccess.mockImplementation(async (contextKey: string, apps: any[]) => {
      if (contextKey === contextKeyA) {
        quickAccessByContext.set(contextKeyA, apps)
        return (await gatedSpaceASave) as any[]
      }
      quickAccessByContext.set(contextKey, apps)
      return apps
    })

    // Remove the A shortcut: a save to context A is now pending.
    fireEvent.click(screen.getByTestId('home-manage-quick-access'))
    await waitFor(() => {
      expect(screen.getByTestId('manage-home-apps-dialog')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('manage-home-apps-item'))
    await waitFor(() => {
      expect(setHomeQuickAccess).toHaveBeenCalledWith(contextKeyA, [])
    })

    // Switch the committed ProductSpace to B while the A save is pending.
    appCatalogHook = {
      ...hookWithCatalog(enterpriseCatalogWith([appB], {
        organizationId: 'organization-b',
      })),
      scopeKeyForApp: (target: CatalogApp) => `key:${target.id}`,
    }
    view.rerender(homeTree())
    await waitFor(() => {
      expect(screen.getByText('Race App B')).toBeTruthy()
    })

    // The stale A save resolves now: it must NOT enter space B's view and
    // must NOT trigger the B-side prune to persist an emptied B config.
    releaseSpaceASave([])
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByText('Race App B')).toBeTruthy()
    const savedContexts = setHomeQuickAccess.mock.calls.map(call => call[0])
    expect(savedContexts).not.toContain(contextKeyB)
    expect(quickAccessByContext.get(contextKeyB)).toEqual([{
      id: 'key:race-app-b',
      addedAt: 1,
    }])
    view.unmount()
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
      expect(storePublish).toHaveBeenCalledWith(
        { accountId: 'account-a', productSpaceId: 'organization-a' },
        'account-a',
        resolvedLaunch(appA),
      )
    })
    expect(openApp).not.toHaveBeenCalled()
  })

  it('keeps Polo visible while the current Catalog is loading or failed', () => {
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([]),
      {},
      { catalog: null, loading: true },
    )
    const loading = renderHome()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(screen.getByTestId('home-quick-access-loading')).toBeTruthy()
    loading.unmount()

    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([]),
      {},
      { catalog: null, loading: false, errorCode: 'NETWORK_ERROR' },
    )
    renderHome()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(screen.getByText('Could not load the App catalog')).toBeTruthy()
  })

  it('opens enterprise workflows with the committed enterprise context', async () => {
    const catalog = enterpriseCatalogWith([])
    appCatalogHook = hookWithCatalog(catalog)
    appCatalogHook.productSpace.activeProductSpace = {
      id: 'organization-a',
      enterpriseId: 'enterprise-a',
      kind: 'enterprise',
      name: 'Enterprise A',
      role: 'manager',
      accessMode: 'active',
    }
    adminGetStatus.mockResolvedValue({
      loggedIn: true,
      userId: 'account-a',
      adminUrl: 'https://admin.example.com/base',
    })

    renderHome()
    fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(
        'https://admin.example.com/enterprise/enterprise-a/members',
      )
    })
    fireEvent.click(screen.getByTestId('enterprise-creator-publishing-link'))
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(
        'https://admin.example.com/organization-apps?organizationId=enterprise-a',
      )
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

  it('installs a resolved bundle and publishes a sealed POO-47 handoff without opening a Tab', async () => {
    const bundleApp: CatalogApp = {
      id: 'bundle-entry',
      catalogEntryId: 'bundle-entry',
      artifactInstanceId: 'bundle-artifact',
      catalogVersion: { versionId: 'bundle-version-id', version: '3.0.0' },
      organizationId: 'organization-a',
      name: 'Bundle App',
      description: '',
      deliveryMode: 'resolve_launch',
      sortOrder: 0,
      availability: 'available',
    }
    const launch = resolvedBundleLaunch(bundleApp)
    const resolveLaunch = jest.fn(async () => launch)
    const installProductSpaceBundle = jest.fn(async () => {})
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([bundleApp]),
      { resolveLaunch, installProductSpaceBundle },
    )

    await renderAllApps()
    fireEvent.click(screen.getByTestId('all-apps-action-bundle-entry'))
    await waitFor(() => expect(screen.getByText('Install Bundle App')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(installProductSpaceBundle).toHaveBeenCalledWith(bundleApp)
      expect(resolveLaunch).toHaveBeenCalledTimes(2)
      expect(storePublish).toHaveBeenCalledWith(
        { accountId: 'account-a', productSpaceId: 'organization-a' },
        'account-a',
        launch,
      )
    })
    expect(openApp).not.toHaveBeenCalled()
  })

  it('keeps withdrawn tombstones visible and non-launchable in a maximum Catalog', async () => {
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
      catalogEntryId: 'withdrawn-9999',
      artifactInstanceId: 'artifact-withdrawn-9999',
      catalogVersion: { versionId: 'version-withdrawn-9999', version: '1.0.0' },
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
        getInstallState: (target: CatalogApp) => target.id === installedWithdrawn.id
          ? {
              app: {
                accountId: 'account-a',
                productSpaceId: 'organization-a',
                catalogEntryId: installedWithdrawn.catalogEntryId!,
                artifactInstanceId: installedWithdrawn.artifactInstanceId!,
                versionId: installedWithdrawn.catalogVersion!.versionId,
                version: installedWithdrawn.catalogVersion!.version,
              },
              state: 'installed' as const,
              currentVersion: '1.0.0',
            }
          : undefined,
      },
      { statuses },
    )

    await renderAllApps()

    // Tombstones stay visible with their retained explanation: the installed
    // one sorts first via its retained row, pagination still applies.
    expect(screen.getByText('Installed Withdrawn')).toBeTruthy()
    expect(screen.getAllByTestId('all-apps-row')).toHaveLength(60)
    expect(screen.getByTestId('all-apps-count').textContent).toContain('20000')
    expect(screen.getByText('Removed by your organization')).toBeTruthy()

    // The withdrawn tombstone is NEVER launchable, even when installed.
    const tombstoneAction = screen.getByTestId(
      'all-apps-action-withdrawn-9999',
    ) as HTMLButtonElement
    expect(tombstoneAction.disabled).toBe(true)
    // A live App on the same page stays launchable.
    expect((screen.getByTestId('all-apps-action-visible-0') as HTMLButtonElement).disabled)
      .toBe(false)

    // The retained installation keeps its uninstall entry in the inspector.
    fireEvent.click(screen.getAllByTestId('all-apps-row')[0]!.querySelector('button')!)
    expect(screen.getByTestId('all-apps-inspector-uninstall')).toBeTruthy()
  })

  it('merges withdrawn tombstones into all-Apps with identity dedup and live preference', () => {
    const live: CatalogApp = {
      id: 'entry-dup',
      catalogEntryId: 'entry-dup',
      artifactInstanceId: 'artifact-dup',
      catalogVersion: { versionId: 'version-2', version: '2.0.0' },
      organizationId: 'organization-a',
      name: 'Dup App',
      description: '',
      deliveryMode: 'resolve_launch',
      sortOrder: 3,
      availability: 'available',
    }
    const tombstoneOfSameArtifact: CatalogApp = {
      ...live,
      name: 'Dup App (old)',
      // The stale version of the SAME artifact instance: dedup must be
      // version-agnostic so an upgrade never pairs live v2 + withdrawn v1.
      catalogVersion: { versionId: 'version-1', version: '1.0.0' },
      availability: 'withdrawn',
      sortOrder: 1,
    }
    const plainTombstone: CatalogApp = {
      id: 'entry-gone',
      catalogEntryId: 'entry-gone',
      artifactInstanceId: 'artifact-gone',
      catalogVersion: { versionId: 'version-1', version: '1.0.0' },
      organizationId: 'organization-a',
      name: 'Gone App',
      description: '',
      deliveryMode: 'resolve_launch',
      sortOrder: 2,
      availability: 'withdrawn',
    }
    const merged = selectAllAppsForDisplay(enterpriseCatalogWith(
      [live],
      { withdrawnApps: [tombstoneOfSameArtifact, plainTombstone] },
    ))

    // Same artifact identity collapses to the LIVE entry; the pure tombstone
    // is retained; Catalog order is preserved.
    expect(merged.map(app => app.id)).toEqual(['entry-gone', 'entry-dup'])
    expect(merged.find(app => app.id === 'entry-dup')?.availability).toBe('available')
    expect(merged.find(app => app.id === 'entry-gone')?.availability).toBe('withdrawn')
    expect(selectAllAppsForDisplay(null)).toEqual([])
  })

  it('opens the uninstall dialog for an installed withdrawn tombstone', async () => {
    const installedTombstone: CatalogApp = {
      id: 'gone-installed',
      catalogEntryId: 'gone-installed',
      artifactInstanceId: 'artifact-gone-installed',
      catalogVersion: { versionId: 'version-gone', version: '1.5.0' },
      organizationId: 'organization-a',
      name: 'Gone Installed',
      description: '',
      deliveryMode: 'resolve_launch',
      sortOrder: 5,
      availability: 'withdrawn',
    }
    const uninstallProductSpaceBundle = jest.fn(async () => {})
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([], { withdrawnApps: [installedTombstone] }),
      {
        uninstallProductSpaceBundle,
        getInstallState: (target: CatalogApp) => target.id === 'gone-installed'
          ? {
              app: {
                accountId: 'account-a',
                productSpaceId: 'organization-a',
                catalogEntryId: installedTombstone.catalogEntryId!,
                artifactInstanceId: installedTombstone.artifactInstanceId!,
                versionId: installedTombstone.catalogVersion!.versionId,
                version: installedTombstone.catalogVersion!.version,
              },
              state: 'installed' as const,
              currentVersion: '1.5.0',
            }
          : undefined,
      },
    )

    await renderAllApps()
    expect(screen.getByText('Gone Installed')).toBeTruthy()
    expect((screen.getByTestId('all-apps-action-gone-installed') as HTMLButtonElement).disabled)
      .toBe(true)

    fireEvent.click(screen.getByTestId('all-apps-row').querySelector('button')!)
    fireEvent.click(screen.getByTestId('all-apps-inspector-uninstall'))
    await waitFor(() => {
      expect(screen.getByText('Uninstall Gone Installed?')).toBeTruthy()
    })
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }))
    await waitFor(() => {
      expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(
        installedTombstone,
        true,
      )
    })
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
    )).toBe('无法打开 App。')
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'UNINSTALL_FAILED', message: secret },
      'uninstall',
    )).toBe('无法卸载 App。')
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'RELEASE_CHANGED', message: secret },
      'install',
    )).toBe('App 发布版本已变更，请确认更新后的版本再安装。')
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
    // Space-aware failure copy: personal spaces never read as "organization".
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'NOT_AUTHORIZED', message: secret },
      'open',
      'personal',
    )).toBe('此 App 的授权已结束')
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'NOT_AUTHORIZED', message: secret },
      'open',
      'enterprise',
    )).toBe('你的组织已不再提供此 App。')
    expect(catalogStateMessage(
      i18n.t.bind(i18n),
      'NETWORK_ERROR',
      'error',
      'personal',
    )).toBe('Polo 无法连接服务器，暂时无法加载当前空间的 App。')
    expect(catalogStateMessage(
      i18n.t.bind(i18n),
      'NETWORK_ERROR',
      'error',
      'enterprise',
    )).toBe('Polo 无法连接服务器，暂时无法加载组织 App。')
    expect(catalogStateMessage(
      i18n.t.bind(i18n),
      'MEMBERSHIP_REMOVED',
      'error',
      'personal',
    )).toBe('你已无法访问此空间的 App')
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
