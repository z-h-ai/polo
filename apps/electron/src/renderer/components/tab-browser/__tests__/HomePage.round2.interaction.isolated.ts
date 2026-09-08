import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createContext, createElement, useContext, type ReactElement } from 'react'
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

const toastErrorSpy = jest.fn()
const toastSuccessSpy = jest.fn()
const openApp = jest.fn()
const storePublish = jest.fn((_live: unknown, _lease: number, accountId: string, launch: unknown) => ({
  handoffId: 'test-handoff',
  context: { accountId, launch },
}))
const adminGetStatus = jest.fn()
const openUrl = jest.fn()
let appCatalogHook: any
let installedApps = [...BUILTIN_APP_DEFINITIONS]
const quickAccessByContext = new Map<string, any[]>()
function defaultGetHomeQuickAccess(contextKey: string) {
  return Promise.resolve(quickAccessByContext.get(contextKey) ?? [])
}
const getHomeQuickAccess = jest.fn(defaultGetHomeQuickAccess)
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

// Per-tree hook override: lets one test mount HomePages on DIFFERENT
// contexts simultaneously without the module-global leaking between them.
const hookOverrideContext = createContext<any>(null)
mock.module('@/hooks/useAppCatalog', () => ({
  useAppCatalog: () => useContext(hookOverrideContext) ?? appCatalogHook,
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

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorSpy(...args),
    success: (...args: unknown[]) => toastSuccessSpy(...args),
  },
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
const { formatBytes, HomePage, selectAllAppsForDisplay, __resetHomeQuickWritersForTests, __homeQuickWritersCountForTests, __homeQuickWriterStatsForTests, __homeQuickWriterSettledForTests } = await import('../HomePage')
const { markAppCatalogAccessDenied } = await import('@polo-ai/shared/admin/authorization-failure')
const {
  catalogStateMessage,
  homeAppOperationErrorText,
} = await import('@/lib/home-app-errors')

beforeEach(async () => {
  localStorage.clear()
  toastErrorSpy.mockClear()
  toastSuccessSpy.mockClear()
  openApp.mockClear()
  storePublish.mockClear()
  adminGetStatus.mockReset()
  openUrl.mockReset()
  appCatalogHook = signedOutCatalogHook()
  installedApps = [...BUILTIN_APP_DEFINITIONS]
  quickAccessByContext.clear()
  __resetHomeQuickWritersForTests()
  getHomeQuickAccess.mockClear()
  getHomeQuickAccess.mockImplementation(defaultGetHomeQuickAccess)
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

function homeTree(hookOverride?: any) {
  // HomePage publishes through the Provider-owned handoff store; the
  // provider value mirrors the mocked catalog hook's committed context. A
  // per-tree hook override binds THAT tree to a different context even when
  // another mount keeps using the module-global hook.
  const hookInstance = hookOverride ?? appCatalogHook
  const ps = hookInstance.productSpace
  const value = {
    accountId: ps?.accountId ?? 'account-a',
    activeProductSpaceId: ps?.activeProductSpaceId ?? 'organization-a',
    activeProductSpace: ps?.activeProductSpace
      ?? { id: 'organization-a', kind: 'enterprise', name: 'Organization A' },
    productSpaces: [],
    allProductSpaces: [],
    personalProductSpaceId: ps?.activeProductSpaceId ?? 'organization-a',
    productSpaceContextKey: ps?.productSpaceContextKey ?? 'account-a|organization-a',
    contextVersion: 7,
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
  const tree = createElement(ProductSpaceProvider, {
    value: value as never,
    children: createElement(I18nextProvider, { i18n }, createElement(HomePage)),
  })
  if (!hookOverride) return tree
  return createElement(hookOverrideContext.Provider, { value: hookOverride }, tree)
}

let homeRerender: (tree: ReactElement) => void = () => {}
function renderHome() {
  const view = render(homeTree())
  homeRerender = tree => view.rerender(tree)
  return view
}
function viewRerender() {
  homeRerender(homeTree())
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

const uiKeyFor = (app: CatalogApp) => JSON.stringify([
  'product-space-ui',
  app.organizationId ? 'account-a' : 'account-a',
  app.organizationId ?? 'organization-a',
  app.catalogEntryId ?? app.id,
  app.artifactInstanceId ?? null,
])

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
  // Mirrors the production uiIdentityKeyForApp format.
  const uiIdentityKeyForApp = (target: CatalogApp) => JSON.stringify([
    'product-space-ui',
    catalog.accountId,
    catalog.organizationId,
    target.catalogEntryId ?? target.id,
    target.artifactInstanceId ?? null,
  ])
  return {
    ...signedOutCatalogHook(),
    productSpace: {
      accountId: catalog.accountId,
      activeProductSpaceId: catalog.organizationId,
      productSpaceContextKey: createProductSpaceContextKey(
        catalog.accountId,
        catalog.organizationId,
      ),
      // Monotonic lease used by the enterprise-workflow re-verification;
      // defaults to a stable value, tests override to simulate transitions.
      contextVersion: 0,
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
    uiIdentityKeyForApp,
    ...hookOverrides,
  }
}

describe('HomePage quick access (POO-43)', () => {
  it('always shows the fixed Polo assistant and opens the Polo tab', async () => {
    renderHome()
    // Flush mount-triggered hydration settlements inside act.
    await act(async () => {})

    const poloEntry = screen.getByTestId('home-quick-entry-polo')
    expect(within(poloEntry).getByText('Polo Assistant')).toBeTruthy()
    fireEvent.click(poloEntry)
    expect(openApp).toHaveBeenCalledWith(POLO_APP_DEFINITION)
  })

  it('R31: an assistant-only Catalog keeps the fixed Polo on Home and shows the frozen empty work-App state in All Apps', async () => {
    // A schema-valid Catalog always contains exactly one built-in Polo
    // assistant. With ZERO work Apps the All Apps view must project the
    // assistant out and render the frozen empty state — never the assistant
    // as a work App row — while Home keeps its fixed Polo quick entry.
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    quickAccessByContext.set(contextKey, [])
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    renderHome()
    await act(async () => {})

    // Home keeps the fixed Polo assistant entry.
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()

    // All Apps projects zero work Apps and shows the frozen empty state.
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-empty')).toBeTruthy()
    })
    expect(screen.getByTestId('all-apps-count').textContent).toContain('0 / 0')
    expect(screen.queryByTestId('all-apps-row')).toBeNull()
  })

  it('home-app-hub owns viewport-bounded vertical scrolling: max-five work Apps and full Catalog rows stay reachable (R39 review)', async () => {
    // MAXIMUM five work Apps pinned — the frozen launcher grid then holds the
    // fixed Polo assistant plus five cards that overflow any realistic
    // viewport, so the hub itself must own the vertical scroll (R39 review:
    // html/body/#root are overflow-hidden and no ancestor may swallow it).
    const apps: CatalogApp[] = ['Work App A', 'Work App B', 'Work App C', 'Work App D', 'Work App E'].map((name, index) => ({
      id: `scroll-app-${index}`,
      organizationId: 'organization-a',
      name,
      description: `${name} description`,
      deliveryMode: 'remote_url',
      remoteUrl: `https://scroll-${index}.example.com`,
      sortOrder: index,
      availability: 'available',
      catalogEntryId: `cat-scroll-${index}`,
      artifactInstanceId: `arti-scroll-${index}`,
      catalogSources: [{ kind: 'creator_circle', name: `Scroll Circle ${index}` }],
    }))
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith(apps))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    quickAccessByContext.set(contextKey, apps.map((app, index) => ({
      id: appCatalogHook.uiIdentityKeyForApp(app),
      addedAt: 1 + index,
    })))

    renderHome()
    await waitFor(() => {
      expect(screen.getAllByTestId('home-quick-entry')).toHaveLength(5)
    })

    // The hub is the scroll owner: viewport-bounded, internally scrollable.
    const hub = screen.getByTestId('home-app-hub')
    expect(hub.className).toContain('h-full')
    expect(hub.className).toContain('min-h-0')
    expect(hub.className).toContain('overflow-y-auto')

    // Every allowed entry renders inside the hub — including the LAST row.
    expect(screen.getByText('Work App E')).toBeTruthy()
    expect(within(hub).getAllByText(/Scroll Circle 4/).length).toBeGreaterThan(0)

    // Full Catalog: every row renders in the same scroll owner.
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    const rows = screen.getAllByTestId('all-apps-row')
    expect(rows).toHaveLength(5)
    expect(rows[rows.length - 1]!.textContent).toContain('Work App E')
  })

  it('A→B ProductSpace transition: the first committed target Home layout exposes no prior-scope Apps, sources, or Skill metadata (R39 review)', async () => {
    const appA: CatalogApp = {
      id: 'ctx-a-app',
      organizationId: 'organization-a',
      name: 'Scope A App',
      description: 'Scope A description',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
      catalogSources: [{ kind: 'creator_circle', name: 'Scope A Circle' }],
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const keyA = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    quickAccessByContext.set(keyA, [{ id: appCatalogHook.uiIdentityKeyForApp(appA), addedAt: 1 }])
    const view = renderHome()
    await waitFor(() => expect(screen.getByText('Scope A App')).toBeTruthy())
    // Context A commits the certified-creator presentation for its own source.
    expect(screen.getByTestId('home-app-hub').textContent).toContain('Scope A Circle')

    // A→B: the committed ProductSpace context transitions to a different
    // account + ProductSpace (a different owner epoch).
    const appB: CatalogApp = {
      id: 'ctx-b-app',
      organizationId: 'organization-b',
      name: 'Scope B App',
      description: 'Scope B description',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://b.example.com',
      sortOrder: 0,
      availability: 'available',
      catalogSources: [{ kind: 'creator_circle', name: 'Scope B Circle' }],
    }
    const catalogB = {
      ...enterpriseCatalogWith([appB]),
      accountId: 'account-b',
      organizationId: 'organization-b',
    }
    const hookB = hookWithCatalog(catalogB)
    const keyB = `v1:${
      createProductSpaceContextKey('account-b', 'organization-b')
    }`
    quickAccessByContext.set(keyB, [{ id: hookB.uiIdentityKeyForApp(appB), addedAt: 1 }])
    act(() => {
      appCatalogHook = hookB
      homeRerender(homeTree(hookB))
    })

    // FIRST committed target Home layout: no prior-scope App identity,
    // sources, or Skill metadata may appear — the assistant card renders the
    // frozen neutral source label (the dynamic Skill count is deliberately
    // omitted: no scope-keyed Skill source exists at Home).
    const hub = screen.getByTestId('home-app-hub')
    const firstCommitText = hub.textContent ?? ''
    expect(firstCommitText).not.toContain('Scope A App')
    expect(firstCommitText).not.toContain('Scope A Circle')
    expect(firstCommitText).not.toContain('Skill 已启用')
    expect(firstCommitText).not.toContain('skills enabled')
    expect(firstCommitText).toContain('Built into Polo')

    // Context B's own data lands afterwards.
    await waitFor(() => expect(screen.getByText('Scope B App')).toBeTruthy())
    expect(screen.getByTestId('home-app-hub').textContent).toContain('Scope B Circle')
    view.unmount()
  })

  it('hides space management entries when no ProductSpace context exists', async () => {
    renderHome()
    await act(async () => {})

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
      id: appCatalogHook.uiIdentityKeyForApp(appA),
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
      { id: appCatalogHook.uiIdentityKeyForApp(appA), addedAt: 1 },
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
      id: appCatalogHook.uiIdentityKeyForApp(appA),
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
      id: 'ui:race-app-a',
      addedAt: 1,
    }])
    quickAccessByContext.set(contextKeyB, [{
      id: 'ui:race-app-b',
      addedAt: 1,
    }])
    appCatalogHook = {
      ...hookWithCatalog(enterpriseCatalogWith([appA])),
      scopeKeyForApp: (target: CatalogApp) => `key:${target.id}`,
      uiIdentityKeyForApp: (target: CatalogApp) => `ui:${target.id}`,
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
      uiIdentityKeyForApp: (target: CatalogApp) => `ui:${target.id}`,
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
      id: 'ui:race-app-b',
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
      id: appCatalogHook.uiIdentityKeyForApp(appA),
      addedAt: 1,
    }])

    renderHome()
    fireEvent.click(await screen.findByText('Open App A'))

    await waitFor(() => {
      expect(storePublish).toHaveBeenCalledWith(
        { accountId: 'account-a', productSpaceId: 'organization-a' },
        7,
        'account-a',
        resolvedLaunch(appA),
      )
    })
    expect(openApp).not.toHaveBeenCalled()
  })

  it('keeps Polo visible while the current Catalog is loading or failed', async () => {
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([]),
      {},
      { catalog: null, loading: true },
    )
    const loading = renderHome()
    await act(async () => {})
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(screen.getByTestId('home-quick-access-loading')).toBeTruthy()
    loading.unmount()

    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([]),
      {},
      { catalog: null, loading: false, errorCode: 'NETWORK_ERROR' },
    )
    renderHome()
    await act(async () => {})
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

  it('fail-closed drops a quick entry whose artifact instance was replaced (never re-binds)', async () => {
    // entry-1 was previously pinned with artifact-old; the fresh Catalog
    // re-issues entry-1 for artifact-new. The persisted quick id binds the
    // OLD artifact instance, so it must be pruned — never silently re-bound
    // to the new instance.
    const replacedApp: CatalogApp = {
      id: 'entry-1',
      catalogEntryId: 'entry-1',
      artifactInstanceId: 'artifact-new',
      catalogVersion: { versionId: 'version-new', version: '2.0.0' },
      organizationId: 'organization-a',
      name: 'Replaced App',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://new.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([replacedApp]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    quickAccessByContext.set(contextKey, [{
      id: JSON.stringify([
        'product-space-ui',
        'account-a',
        'organization-a',
        'entry-1',
        'artifact-old',
      ]),
      addedAt: 1,
    }])

    renderHome()
    await waitFor(() => {
      expect(setHomeQuickAccess).toHaveBeenCalledWith(contextKey, [])
    })
    // The replaced app is NOT silently re-pinned by the stale binding.
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()
    expect(quickAccessByContext.get(contextKey)).toEqual([])
  })

  it('fails closed when the committed enterprise switches while adminGetStatus is pending (members + publishing)', async () => {
    // Enterprise A (members) at click time...
    const enterpriseA = enterpriseCatalogWith([])
    appCatalogHook = hookWithCatalog(enterpriseA)
    appCatalogHook.productSpace.activeProductSpace = {
      id: 'enterprise-a',
      enterpriseId: 'enterprise-a',
      kind: 'enterprise',
      name: 'Enterprise A',
      role: 'manager',
      accessMode: 'active',
    }

    // ...with a pending adminGetStatus that the test controls.
    let releaseStatusA!: (value: any) => void
    adminGetStatus.mockImplementationOnce(() => {
      return new Promise(resolve => {
        releaseStatusA = resolve
      })
    })

    renderHome()
    fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
    await waitFor(() => expect(releaseStatusA).toBeDefined())

    // The committed context switches to enterprise B while the status IPC
    // for A is still pending.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([], {
      organizationId: 'organization-b',
    }))
    appCatalogHook.productSpace.activeProductSpace = {
      id: 'enterprise-b',
      enterpriseId: 'enterprise-b',
      kind: 'enterprise',
      name: 'Enterprise B',
      role: 'manager',
      accessMode: 'active',
    }
    viewRerender()

    // Release A's status: the stale continuation must fail closed.
    releaseStatusA!({ loggedIn: true, userId: 'account-a', adminUrl: 'https://admin.example.com' })
    await waitFor(() => {
      expect(openUrl).not.toHaveBeenCalled()
    })
    expect(openUrl).not.toHaveBeenCalledWith(
      'https://admin.example.com/enterprise/enterprise-a/members',
    )
    expect(screen.getByTestId('enterprise-member-management-link')).toBeTruthy()

    // The fresh B closures still open B's own workflow (members)...
    adminGetStatus.mockResolvedValueOnce({
      loggedIn: true,
      userId: 'account-a',
      adminUrl: 'https://admin.example.com',
    })
    fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(
        'https://admin.example.com/enterprise/enterprise-b/members',
      )
    })

    // ...and the publishing entry re-verifies the same way after a switch.
    let releaseStatusB2!: (value: any) => void
    adminGetStatus.mockImplementationOnce(() => {
      return new Promise(resolve => {
        releaseStatusB2 = resolve
      })
    })
    fireEvent.click(screen.getByTestId('enterprise-creator-publishing-link'))
    await waitFor(() => expect(releaseStatusB2).toBeDefined())
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([], {
      organizationId: 'organization-c',
    }))
    appCatalogHook.productSpace.activeProductSpace = {
      id: 'enterprise-c',
      enterpriseId: 'enterprise-c',
      kind: 'enterprise',
      name: 'Enterprise C',
      role: 'manager',
      accessMode: 'active',
    }
    viewRerender()
    releaseStatusB2!({ loggedIn: true, userId: 'account-a', adminUrl: 'https://admin.example.com' })
    await waitFor(() => {
      expect(openUrl).not.toHaveBeenCalledWith(
        'https://admin.example.com/organization-apps?organizationId=enterprise-b',
      )
    })
    expect(openUrl).not.toHaveBeenCalledWith(
      'https://admin.example.com/organization-apps?organizationId=enterprise-c',
    )
  })

  it('fails closed after an A→B→A round-trip while adminGetStatus was pending — members entry (observation bfd4af50…)', async () => {
    // The monotonic contextVersion is the lease: an A→B→A round-trip
    // restores account/enterprise/contextKey but NEVER the lease, so the
    // stale continuation cannot re-pass the committed-lease verification.
    const makeHook = (spaceId: string, lease: number) => {
      const hook = hookWithCatalog(enterpriseCatalogWith([]))
      hook.productSpace.activeProductSpace = {
        id: spaceId,
        enterpriseId: spaceId,
        kind: 'enterprise' as const,
        name: `Enterprise ${spaceId}`,
        role: 'manager' as const,
        accessMode: 'active' as const,
      } as never
      hook.productSpace.contextVersion = lease
      return hook
    }

    appCatalogHook = makeHook('enterprise-a', 1)

    let releaseStatusA!: (value: any) => void
    adminGetStatus.mockImplementationOnce(() => {
      return new Promise(resolve => {
        releaseStatusA = resolve
      })
    })

    renderHome()
    // MEMBERS entry: click under enterprise A (lease 1); status IPC held
    // pending across the round-trip.
    fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
    await waitFor(() => expect(releaseStatusA).toBeDefined())

    // A→B→A: identities return to A but the lease advances 1 → 2 → 3. The
    // layout-effect sync re-binds the committed live lease at each step.
    appCatalogHook = makeHook('enterprise-b', 2)
    viewRerender()
    appCatalogHook = makeHook('enterprise-a', 3)
    viewRerender()

    // Release A's pending status: the stale continuation must fail closed —
    // ZERO openUrl calls.
    releaseStatusA!({ loggedIn: true, userId: 'account-a', adminUrl: 'https://admin.example.com' })
    await waitFor(() => {
      expect(openUrl).not.toHaveBeenCalledWith(
        'https://admin.example.com/enterprise/enterprise-a/members',
      )
    })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('fails closed after an A→B→A round-trip while adminGetStatus was pending — publishing entry (observation bfd4af50…)', async () => {
    // PUBLISHING entry: same interleaving repeated independently.
    const makeHook = (spaceId: string, lease: number) => {
      const hook = hookWithCatalog(enterpriseCatalogWith([]))
      hook.productSpace.activeProductSpace = {
        id: spaceId,
        enterpriseId: spaceId,
        kind: 'enterprise' as const,
        name: `Enterprise ${spaceId}`,
        role: 'manager' as const,
        accessMode: 'active' as const,
      } as never
      hook.productSpace.contextVersion = lease
      return hook
    }

    appCatalogHook = makeHook('enterprise-a', 10)

    let releaseStatusA!: (value: any) => void
    adminGetStatus.mockImplementationOnce(() => {
      return new Promise(resolve => {
        releaseStatusA = resolve
      })
    })

    renderHome()
    fireEvent.click(screen.getByTestId('enterprise-creator-publishing-link'))
    await waitFor(() => expect(releaseStatusA).toBeDefined())

    appCatalogHook = makeHook('enterprise-b', 11)
    viewRerender()
    appCatalogHook = makeHook('enterprise-a', 12)
    viewRerender()

    releaseStatusA!({ loggedIn: true, userId: 'account-a', adminUrl: 'https://admin.example.com' })
    await waitFor(() => {
      expect(openUrl).not.toHaveBeenCalledWith(
        'https://admin.example.com/organization-apps?organizationId=enterprise-a',
      )
    })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('opens members and publishing for a FRESH committed lease after the round-trips (no false rejection)', async () => {
    const makeHook = (spaceId: string, lease: number) => {
      const hook = hookWithCatalog(enterpriseCatalogWith([]))
      hook.productSpace.activeProductSpace = {
        id: spaceId,
        enterpriseId: spaceId,
        kind: 'enterprise' as const,
        name: `Enterprise ${spaceId}`,
        role: 'manager' as const,
        accessMode: 'active' as const,
      } as never
      hook.productSpace.contextVersion = lease
      return hook
    }

    appCatalogHook = makeHook('enterprise-fresh', 20)
    adminGetStatus.mockResolvedValue({
      loggedIn: true,
      userId: 'account-a',
      adminUrl: 'https://admin.example.com',
    })

    renderHome()
    fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(
        'https://admin.example.com/enterprise/enterprise-fresh/members',
      )
    })
    fireEvent.click(screen.getByTestId('enterprise-creator-publishing-link'))
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(
        'https://admin.example.com/organization-apps?organizationId=enterprise-fresh',
      )
    })
    expect(openUrl).toHaveBeenCalledTimes(2)
  })

  it('opens members and publishing while the Catalog snapshot is still LOADING (accountId from committed context)', async () => {
    // Observation eb19670d…: during initial Catalog load (no snapshot) the
    // workflow lease account derives from the committed ProductSpaceContext
    // authority — clicking must NOT be falsely rejected as stale.
    const enterpriseHook = hookWithCatalog(enterpriseCatalogWith([]))
    enterpriseHook.productSpace.activeProductSpace = {
      id: 'enterprise-a',
      enterpriseId: 'enterprise-a',
      kind: 'enterprise',
      name: 'Enterprise A',
      role: 'manager',
      accessMode: 'active',
    } as never
    appCatalogHook = {
      ...enterpriseHook,
      state: {
        ...enterpriseHook.state,
        catalog: null,
        loading: true,
      },
    }
    const pendingStatuses: Array<() => void> = []
    adminGetStatus.mockImplementation(() => {
      return new Promise(resolve => {
        pendingStatuses.push(() => resolve({
          loggedIn: true,
          userId: 'account-a',
          adminUrl: 'https://admin.example.com',
        }))
      })
    })

    renderHome()
    fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
    fireEvent.click(screen.getByTestId('enterprise-creator-publishing-link'))
    await waitFor(() => expect(pendingStatuses.length).toBe(2))

    pendingStatuses.forEach(release => release())
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(
        'https://admin.example.com/enterprise/enterprise-a/members',
      )
      expect(openUrl).toHaveBeenCalledWith(
        'https://admin.example.com/organization-apps?organizationId=enterprise-a',
      )
    })
  })

  it('opens members and publishing after a NETWORK_ERROR leaves the Catalog snapshot empty (accountId from committed context)', async () => {
    // Observation eb19670d…: NETWORK_ERROR with catalog=null — the
    // committed ProductSpaceContext authority still supplies the account, so
    // both entries must open (the old fail-open fix no longer applies).
    const enterpriseHook = hookWithCatalog(enterpriseCatalogWith([]))
    enterpriseHook.productSpace.activeProductSpace = {
      id: 'enterprise-a',
      enterpriseId: 'enterprise-a',
      kind: 'enterprise',
      name: 'Enterprise A',
      role: 'manager',
      accessMode: 'active',
    } as never
    appCatalogHook = {
      ...enterpriseHook,
      state: {
        ...enterpriseHook.state,
        catalog: null,
        loading: false,
        errorCode: 'NETWORK_ERROR',
      },
    }
    adminGetStatus.mockResolvedValue({
      loggedIn: true,
      userId: 'account-a',
      adminUrl: 'https://admin.example.com',
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

  it('preserves persisted quick access until an authoritative Catalog commits, then prunes once (observation dd293484…)', async () => {
    const appA: CatalogApp = {
      id: 'delayed-app-a',
      organizationId: 'organization-a',
      name: 'Delayed App A',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const persistedId = JSON.stringify([
      'product-space-ui',
      'account-a',
      'organization-a',
      'delayed-app-a',
      null,
    ])
    quickAccessByContext.set(contextKey, [{ id: persistedId, addedAt: 1 }])

    // Cold load: no Catalog snapshot yet (loading) — the stored entry must
    // be preserved untouched (no prune, no persistence).
    const loadingHook = hookWithCatalog(enterpriseCatalogWith([]))
    appCatalogHook = {
      ...loadingHook,
      state: {
        ...loadingHook.state,
        catalog: null,
        loading: true,
      },
    }
    renderHome()
    // Event-driven lifecycle barrier: the writer's hydration gate and
    // persistence queue settled (no elapsed-time wait).
    await act(async () => {
      expect(await __homeQuickWriterSettledForTests(contextKey)).toBe(true)
    })
    // The loading placeholder hides the quick grid — the persisted entry is
    // NOT rendered and NOT pruned.
    expect(screen.queryByText('Delayed App A')).toBeNull()
    expect(setHomeQuickAccess).not.toHaveBeenCalled()
    expect(quickAccessByContext.get(contextKey)).toEqual([
      { id: persistedId, addedAt: 1 },
    ])

    // NETWORK_ERROR failure (catalog=null): still preserved.
    appCatalogHook = {
      ...loadingHook,
      state: {
        ...loadingHook.state,
        catalog: null,
        loading: false,
        errorCode: 'NETWORK_ERROR',
      },
    }
    act(() => { viewRerender() })
    await act(async () => {
      expect(await __homeQuickWriterSettledForTests(contextKey)).toBe(true)
    })
    expect(setHomeQuickAccess).not.toHaveBeenCalled()
    expect(quickAccessByContext.get(contextKey)).toEqual([
      { id: persistedId, addedAt: 1 },
    ])

    // AUTHORITATIVE Catalog commits: the entry resolves and stays.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    act(() => { viewRerender() })
    await act(async () => {
      expect(await __homeQuickWriterSettledForTests(contextKey)).toBe(true)
    })
    expect(setHomeQuickAccess).not.toHaveBeenCalled()
    expect(quickAccessByContext.get(contextKey)).toEqual([
      { id: persistedId, addedAt: 1 },
    ])

    // The authoritative Catalog then stops listing the App: exactly ONE
    // prune+persist against the committed snapshot.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    act(() => { viewRerender() })
    await waitFor(() => {
      expect(setHomeQuickAccess).toHaveBeenCalledTimes(1)
    })
    expect(setHomeQuickAccess).toHaveBeenCalledWith(contextKey, [])
    expect(quickAccessByContext.get(contextKey)).toEqual([])
    // Flush the durable-ack state update inside act (no unwrapped warnings).
    await act(async () => {})
  })

  it('renders denied rows with retained identity and no install/open capability (observation 391939f5…)', async () => {
    // Enterprise A loads successfully (authorized snapshot with identity)…
    const appA: CatalogApp = {
      id: 'denied-app-a',
      catalogEntryId: 'denied-entry-a',
      artifactInstanceId: 'denied-artifact-a',
      organizationId: 'organization-a',
      name: 'Denied App A',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://a.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    expect(screen.getByText('Denied App A')).toBeTruthy()

    // …then a 403 denies the scope: the committed projection strips every
    // delivery capability but RETAINS the stable UI identity, so the frozen
    // restricted rows keep rendering (no crash) while exposing no
    // open/install capability.
    const deniedSnapshot = markAppCatalogAccessDenied(enterpriseCatalogWith([appA]))
    expect(deniedSnapshot.apps[0]).toMatchObject({
      catalogEntryId: 'denied-entry-a',
      artifactInstanceId: 'denied-artifact-a',
      availability: 'unavailable',
    })
    // Delivery capabilities stay stripped.
    expect(deniedSnapshot.apps[0]).not.toHaveProperty('remoteUrl')
    expect(deniedSnapshot.apps[0]).not.toHaveProperty('currentRelease')

    appCatalogHook = {
      ...hookWithCatalog(deniedSnapshot as unknown as AppCatalogCacheEntry),
      state: {
        ...signedOutCatalogHook().state,
        catalog: deniedSnapshot as unknown as AppCatalogCacheEntry,
        accessMode: 'denied' as const,
        errorCode: 'FORBIDDEN',
      },
    }
    viewRerender()

    // The row keeps rendering with its frozen restricted state...
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-restricted-banner')).toBeTruthy()
    })
    expect(screen.getByText('Denied App A')).toBeTruthy()
    // ...and the row can be neither opened nor installed.
    const deniedAction = screen.getByTestId(
      `all-apps-action-${JSON.stringify(['product-space-ui', 'account-a', 'organization-a', 'denied-entry-a', 'denied-artifact-a'])}`,
    ) as HTMLButtonElement
    expect(deniedAction.disabled).toBe(true)
    fireEvent.click(deniedAction)
    expect(openApp).not.toHaveBeenCalled()
    expect(storePublish).not.toHaveBeenCalled()
    expect(screen.queryByTestId('all-apps-inspector-uninstall')).toBeNull()
  })

  const pinnedApp = (id: string, entryId: string, artifactId: string, name: string): CatalogApp => ({
    id,
    catalogEntryId: entryId,
    artifactInstanceId: artifactId,
    organizationId: 'organization-a',
    name,
    description: '',
    deliveryMode: 'remote_url',
    remoteUrl: `https://${id}.example.com`,
    sortOrder: 0,
    availability: 'available',
  })

  /** Number of load-scope calls recorded so far (pseudo-wait guard). */
  const loadCallCount = () => getHomeQuickAccess.mock.calls.length
  /** Waits for the NEXT load-scope call after `before`, asserting its key. */
  async function waitForNextScopeLoad(before: number, contextKey: string) {
    await waitFor(() => {
      if (getHomeQuickAccess.mock.calls.length <= before) {
        throw new Error('scope load pending')
      }
    })
    expect(getHomeQuickAccess.mock.calls[getHomeQuickAccess.mock.calls.length - 1]?.[0]).toBe(contextKey)
  }
  function apiSaveCallKeys(index: number): string[] {
    const call = setHomeQuickAccess.mock.calls[index] as
      | [string, Array<{ id: string }>]
      | undefined
    return (call?.[1] ?? []).map(entry => entry.id)
  }
  /** Waits until the persisted save queue has settled to `count` calls. */
  async function waitForSaveCalls(count: number) {
    await waitFor(() => {
      if (setHomeQuickAccess.mock.calls.length < count) {
        throw new Error('save pending')
      }
    })
  }

  /**
   * Deferred save model: each queued save call is a pending write. Resolving
   * a task COMMITS it to the persisted Map (durability); rejecting it fails
   * the write. Returns the pending tasks in call order.
   */
  function installDeferredSave() {
    const tasks: Array<{
      key: string
      apps: unknown[]
      resolve: () => void
      reject: (error: unknown) => void
    }> = []
    setHomeQuickAccess.mockImplementation(async (key: string, apps: unknown[]) => {
      return await new Promise<unknown[]>((resolve, reject) => {
        tasks.push({
          key,
          apps,
          resolve: () => {
            void defaultSetHomeQuickAccess(key, apps)
            resolve(apps)
          },
          reject,
        })
      })
    })
    return tasks
  }

  async function openAllAppsAndPin(app: CatalogApp, contextKey: string) {
    const renderResult = renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(
      `all-apps-pin-${appCatalogHook.uiIdentityKeyForApp(app)}`,
    ))
    await waitForSaveCalls(1)
    expect(setHomeQuickAccess.mock.calls[0]?.[0]).toBe(contextKey)
    expect(setHomeQuickAccess.mock.calls[0]?.[1]).toEqual([
      { id: appCatalogHook.uiIdentityKeyForApp(app), addedAt: expect.any(Number) },
    ])
    return renderResult
  }

  it('pins a catalog App from All Apps: exact persisted payload, home test-id after back, remount persistence', async () => {
    const appA = pinnedApp('pin-app-a', 'pin-entry-a', 'pin-artifact-a', 'Pin App A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`

    const view = await openAllAppsAndPin(appA, contextKey)

    // 'Pin App A' already exists as an All Apps row name: verifying the pin
    // through getByText would match that row. Return to the home and verify
    // through the HOME-ONLY quick-entry test-id and its persisted identity.
    fireEvent.click(screen.getByTestId('all-apps-back'))
    await waitFor(() => {
      expect(screen.queryByTestId('all-apps-view')).toBeNull()
    })
    const card = screen.getByTestId('home-quick-entry')
    expect(card.getAttribute('data-identity-key')).toBe(
      appCatalogHook.uiIdentityKeyForApp(appA),
    )

    // REAL remount: the persisted Map now holds the entry; a fresh mount
    // must load it back into the home quick access.
    view.unmount()
    // The idle final-owner unmount swept the writer: the remount re-derives
    // the baseline with a REAL load (event-driven, not a fixed sleep).
    const loadsBefore = loadCallCount()
    renderHome()
    await waitForNextScopeLoad(loadsBefore, contextKey)
    await waitFor(() => {
      expect(screen.queryByTestId('all-apps-view')).toBeNull()
    })
    expect(screen.getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(
      appCatalogHook.uiIdentityKeyForApp(appA),
    )
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
  })

  it('a rejected pin save rolls back: card never shows and the Map stays empty', async () => {
    const appA = pinnedApp('reject-app-a', 'reject-entry-a', 'reject-artifact-a', 'Reject App A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    setHomeQuickAccess.mockImplementation(async () => {
      throw new Error('persistence rejected')
    })

    await openAllAppsAndPin(appA, contextKey)

    fireEvent.click(screen.getByTestId('all-apps-back'))
    await waitFor(() => {
      expect(screen.queryByTestId('all-apps-view')).toBeNull()
    })
    // No persisted acknowledgement: the home keeps its empty confirmed
    // snapshot — the pinned card never appears and nothing was stored.
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(quickAccessByContext.get(contextKey)).toBeUndefined()
  })

  it('an explicitly empty quick-access collection stays empty across real remount and A→B→A', async () => {
    const appA = pinnedApp('empty-app-a', 'empty-entry-a', 'empty-artifact-a', 'Empty Fallback A')
    const appB = pinnedApp('empty-app-b', 'empty-entry-b', 'empty-artifact-b', 'Empty Fallback B')
    // Two available apps, NOTHING persisted: no default curation may fill
    // the home.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    const contextKeyA = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const view = renderHome()
    await waitForNextScopeLoad(0, contextKeyA)
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()

    // REAL remount: the idle final-owner unmount swept the writer, so the
    // remount re-derives the (still empty) baseline with a REAL load —
    // event-driven, nothing is invented.
    view.unmount()
    const loadsBeforeRemount = loadCallCount()
    renderHome()
    await waitForNextScopeLoad(loadsBeforeRemount, contextKeyA)
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()

    // A→B→A: switch to another context and back — nothing is invented.
    const catalogB = enterpriseCatalogWith(
      [pinnedApp('b-app', 'b-entry', 'b-artifact', 'Space B App')],
      { organizationId: 'organization-b' },
    )
    const contextKeyB = `v1:${
      createProductSpaceContextKey('account-a', 'organization-b')
    }`
    appCatalogHook = hookWithCatalog(catalogB)
    viewRerender()
    await waitForNextScopeLoad(1, contextKeyB)
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()

    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    viewRerender()
    // Returning to A reuses A's shared writer (no reload) — still empty.
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    })
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()
  })

  it('pins same-artifact different-entry and same-entry different-artifact identities as distinct slots', async () => {
    const sharedArtifactA = pinnedApp('sa-app-a', 'sa-entry-a', 'sa-artifact-shared', 'Shared Artifact A')
    const sharedArtifactB = pinnedApp('sa-app-b', 'sa-entry-b', 'sa-artifact-shared', 'Shared Artifact B')
    const sameEntryOld = pinnedApp('se-app', 'se-entry', 'se-artifact-old', 'Same Entry Old')
    const sameEntryNew = pinnedApp('se-app-2', 'se-entry', 'se-artifact-new', 'Same Entry New')
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([sharedArtifactA, sharedArtifactB, sameEntryOld, sameEntryNew]),
    )
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const view = renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })

    for (const target of [sharedArtifactA, sharedArtifactB, sameEntryOld, sameEntryNew]) {
      fireEvent.click(screen.getByTestId(
        `all-apps-pin-${appCatalogHook.uiIdentityKeyForApp(target)}`,
      ))
    }
    // The single-writer queue serializes the four pins: payloads accumulate
    // in click order and the LAST write carries all four identities.
    await waitForSaveCalls(4)
    expect(setHomeQuickAccess.mock.calls[3]?.[0]).toBe(contextKey)
    expect(setHomeQuickAccess.mock.calls[3]?.[1]).toEqual([
      { id: appCatalogHook.uiIdentityKeyForApp(sharedArtifactA), addedAt: expect.any(Number) },
      { id: appCatalogHook.uiIdentityKeyForApp(sharedArtifactB), addedAt: expect.any(Number) },
      { id: appCatalogHook.uiIdentityKeyForApp(sameEntryOld), addedAt: expect.any(Number) },
      { id: appCatalogHook.uiIdentityKeyForApp(sameEntryNew), addedAt: expect.any(Number) },
    ])

    // All four identities resolve into DISTINCT home cards.
    fireEvent.click(screen.getByTestId('all-apps-back'))
    await waitFor(() => {
      expect(screen.getAllByTestId('home-quick-entry')).toHaveLength(4)
    })
    const identities = screen.getAllByTestId('home-quick-entry')
      .map(card => card.getAttribute('data-identity-key'))
    expect(new Set(identities).size).toBe(4)
    view.unmount()
  })

  it('S1 success then S2 failure keeps S1 on disk and rolls the UI back to the S1 ack', async () => {
    const appA = pinnedApp('s1-app', 's1-entry', 's1-artifact', 'Serial App A')
    const appB = pinnedApp('s2-app', 's2-entry', 's2-artifact', 'Serial App B')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const keyB = appCatalogHook.uiIdentityKeyForApp(appB)
    const tasks = installDeferredSave()

    renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyB}`))
    // Single writer: S2 is QUEUED, not started while S1 is in flight.
    expect(tasks).toHaveLength(1)

    // S1 commits; only then does S2 start (on S1's acked base) and FAIL.
    tasks[0]!.resolve()
    await waitForSaveCalls(2)
    tasks[1]!.reject(new Error('S2 persistence rejected'))
    // Back on the home: exactly the S1 card survives the S2 rollback.
    fireEvent.click(screen.getByTestId('all-apps-back'))
    await waitFor(() => {
      const cards = screen.getAllByTestId('home-quick-entry')
      if (cards.length !== 1) throw new Error('rollback pending')
      expect(cards[0]?.getAttribute('data-identity-key')).toBe(keyA)
    })
    // Disk keeps exactly S1's committed payload — S2's rejected suffix is gone.
    expect(quickAccessByContext.get(contextKey)?.map(entry => entry.id)).toEqual([keyA])
  })

  it('two out-of-order-duration successes still write the disk strictly in click order', async () => {
    const appA = pinnedApp('oo-app-a', 'oo-entry-a', 'oo-artifact-a', 'Order App A')
    const appB = pinnedApp('oo-app-b', 'oo-entry-b', 'oo-artifact-b', 'Order App B')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const keyB = appCatalogHook.uiIdentityKeyForApp(appB)
    const tasks = installDeferredSave()

    renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyB}`))
    // S2 must NOT have started while S1 is in flight (single writer).
    expect(tasks).toHaveLength(1)

    // S1 resolves LATE — only then does S2 start, building on S1's result.
    tasks[0]!.resolve()
    await waitForSaveCalls(2)
    expect(tasks[1]?.key).toBe(contextKey)
    expect((tasks[1]?.apps as Array<{ id: string }> | undefined)?.map(entry => entry.id))
      .toEqual([keyA, keyB])
    tasks[1]!.resolve()
    await waitFor(() => {
      if (!(quickAccessByContext.get(contextKey)?.length === 2)) {
        throw new Error('condition pending')
      }
    })
    // Disk order: [A] then [A,B] — never [A,B] overwritten by a late [A].
    expect((quickAccessByContext.get(contextKey) as Array<{ id: string }> | undefined)
      ?.map(entry => entry.id))
      .toEqual([keyA, keyB])
  })

  it('a pin clicked before hydration builds on the stored collection instead of wiping it', async () => {
    const storedApp = pinnedApp('hyd-app-a', 'hyd-entry-a', 'hyd-artifact-a', 'Stored App A')
    const clickApp = pinnedApp('hyd-app-b', 'hyd-entry-b', 'hyd-artifact-b', 'Clicked App B')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([storedApp, clickApp]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyStored = appCatalogHook.uiIdentityKeyForApp(storedApp)
    const keyClicked = appCatalogHook.uiIdentityKeyForApp(clickApp)
    quickAccessByContext.set(contextKey, [{ id: keyStored, addedAt: 1 }])

    // Defer the LOAD: the click happens before hydration completes.
    let releaseLoad: ((entries: unknown[]) => void) | undefined
    getHomeQuickAccess.mockImplementation(async (_key: string) => {
      const entries = await new Promise<unknown[]>(resolve => { releaseLoad = resolve })
      return entries
    })

    renderHome()
    await waitFor(() => {
      if (!(releaseLoad)) {
        throw new Error('condition pending')
      }
    })
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyClicked}`))

    // Hydration completes AFTER the click: the queued pin must persist the
    // MERGED collection, never [B] alone.
    releaseLoad?.([{ id: keyStored, addedAt: 1 }])
    await waitForSaveCalls(1)
    expect(setHomeQuickAccess.mock.calls[0]?.[0]).toBe(contextKey)
    expect(setHomeQuickAccess.mock.calls[0]?.[1]).toEqual([
      { id: keyStored, addedAt: 1 },
      { id: keyClicked, addedAt: expect.any(Number) },
    ])
  })

  it('a rejected load retries once on a STABLE gate: mutations queued before the reject from BOTH mounts land in order', async () => {
    const appA = pinnedApp('hl-app-a', 'hl-entry-a', 'hl-artifact-a', 'Hydration Lost A')
    const appB = pinnedApp('hl-app-b', 'hl-entry-b', 'hl-artifact-b', 'Hydration Lost B')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')}`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const keyB = appCatalogHook.uiIdentityKeyForApp(appB)

    // Attempt 1 is an in-flight DEFERRED rejection; attempt 2 (the bounded
    // retry) succeeds through a deferred release.
    let rejectFirst: ((error: unknown) => void) | undefined
    let releaseRetry: ((entries: unknown[]) => void) | undefined
    getHomeQuickAccess.mockImplementationOnce(async (_key: string): Promise<any[]> => {
      await new Promise<any[]>((_, reject) => { rejectFirst = reject })
      return []
    }).mockImplementation(async (_key: string) => {
      const entries = await new Promise<unknown[]>(resolve => { releaseRetry = resolve })
      return entries
    })

    // BOTH mounts join the SAME in-flight activation (attempt 1).
    const firstMount = renderHome()
    await waitFor(() => { if (!rejectFirst) throw new Error('first load pending') })
    const survivor = render(homeTree())
    const loadsAfterJoin = loadCallCount()

    // Queue mutations from BOTH mounts BEFORE attempt 1 rejects.
    fireEvent.click(within(firstMount.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(firstMount.container).getByTestId(`all-apps-pin-${keyA}`))

    // Attempt 1 rejects; the bounded retry starts on the SAME gate.
    rejectFirst!(new Error('hydration load rejected (injected)'))
    await waitFor(() => { if (!releaseRetry) throw new Error('retry load pending') })
    fireEvent.click(within(survivor.container).getByTestId('home-all-apps-open'))
    fireEvent.click(within(survivor.container).getByTestId(`all-apps-pin-${keyB}`))

    // Loads: attempt 1 + attempt 2 = EXACTLY 2 (single shared activation).
    expect(loadCallCount()).toBe(loadsAfterJoin + 1)

    // Retry succeeds: queued mutations from BOTH mounts persist in order.
    releaseRetry?.([
      { id: keyA, addedAt: 1 },
    ])
    await waitFor(() => { if (setHomeQuickAccess.mock.calls.length < 2) throw new Error('saves pending') })
    expect(apiSaveCallKeys(0)).toEqual([keyA])
    expect(apiSaveCallKeys(1)).toEqual([keyA, keyB])
    // Both mounts converge on the acked baseline (navigate A back home):
    // each displays BOTH acked cards.
    fireEvent.click(within(firstMount.container).getByTestId('all-apps-back'))
    const assertBothCards = async (container: HTMLElement): Promise<void> => {
      // NOTE: the file-local waitFor rejects on a thrown predicate — poll
      // with an undefined-return predicate until the cards settle.
      await waitFor(() => {
        const cards = within(container).queryAllByTestId('home-quick-entry')
        if (cards.length !== 2) return undefined
        const identities = cards.map(card => card.getAttribute('data-identity-key'))
        return new Set(identities).size === 2 ? true : undefined
      })
    }
    await assertBothCards(firstMount.container)
    await assertBothCards(survivor.container)
    firstMount.unmount()
    survivor.unmount()
  })

  it('an exhausted load (exactly 2 attempts) fails queued mutations VISIBLY with a toast on both mounts', async () => {
    const appA = pinnedApp('ex-app-a', 'ex-entry-a', 'ex-artifact-a', 'Exhausted A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)

    // Attempt 1: in-flight DEFERRED rejection; attempt 2: immediate reject
    // (bounded retry exhausted).
    let rejectFirst: ((error: unknown) => void) | undefined
    getHomeQuickAccess.mockImplementationOnce(async (_key: string): Promise<any[]> => {
      await new Promise<any[]>((_, reject) => { rejectFirst = reject })
      return []
    }).mockImplementation(async () => {
      throw new Error('hydration load rejected (injected)')
    })

    // Mount A starts attempt 1; mount B JOINS the same in-flight activation.
    const firstMount = renderHome()
    await waitFor(() => { if (!rejectFirst) throw new Error('first load pending') })
    const survivor = render(homeTree())

    // Queue the mutation BEFORE exhaustion.
    fireEvent.click(within(firstMount.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(firstMount.container).getByTestId(`all-apps-pin-${keyA}`))

    // Attempt 1 rejects → retry (attempt 2) rejects immediately → terminal.
    rejectFirst!(new Error('hydration load rejected (injected)'))
    await waitFor(() => { if (toastErrorSpy.mock.calls.length === 0) throw new Error('toast pending') })
    expect(toastErrorSpy).toHaveBeenCalled()

    // Visible failure: NO persisted save, both mounts converge with no
    // quick entries, and the load count is EXACTLY 2 (initial + 1 retry).
    expect(setHomeQuickAccess.mock.calls.length).toBe(0)
    expect(loadCallCount()).toBe(2)
    expect(within(firstMount.container).queryAllByTestId('home-quick-entry')).toHaveLength(0)
    expect(within(survivor.container).queryAllByTestId('home-quick-entry')).toHaveLength(0)
    firstMount.unmount()
    survivor.unmount()
  })

  it('an optimistic ack is visible on BOTH mounts before a later reject rolls BOTH back (two unmount orders)', async () => {
    const appA = pinnedApp('os-app-a', 'os-entry-a', 'os-artifact-a', 'Optimistic A')
    const appB = pinnedApp('os-app-b', 'os-entry-b', 'os-artifact-b', 'Optimistic B')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')}`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const keyB = appCatalogHook.uiIdentityKeyForApp(appB)
    const tasks = installDeferredSave()

    // Two live mounts on the same context.
    const firstMount = renderHome()
    const survivor = render(homeTree())
    await waitFor(() => {
      expect(within(survivor.container).getByTestId('home-quick-entry-polo')).toBeTruthy()
    })

    fireEvent.click(within(firstMount.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('all-apps-view')).toBeTruthy()
    })

    // (a) successful pin from the SURVIVOR: optimistic ack visible on BOTH.
    fireEvent.click(within(firstMount.container).getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)
    tasks[0]!.resolve()
    await waitFor(() => {
      expect(within(survivor.container).getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    })
    fireEvent.click(within(firstMount.container).getByTestId('all-apps-back'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    })

    // (b) rejected pin from the FIRST mount: rollback broadcast reverts BOTH.
    fireEvent.click(within(firstMount.container).getByTestId('home-all-apps-open'))
    fireEvent.click(within(firstMount.container).getByTestId(`all-apps-pin-${keyB}`))
    await waitForSaveCalls(2)
    tasks[1]!.reject(new Error('save rejected (injected)'))
    // Navigate the first mount home, then assert the rollback broadcast
    // converged BOTH mounts on the same confirmed snapshot.
    fireEvent.click(within(firstMount.container).getByTestId('all-apps-back'))
    await waitFor(() => {
      if (within(survivor.container).queryAllByTestId('home-quick-entry').length !== 1) {
        throw new Error('survivor rollback pending')
      }
    })
    await waitFor(() => {
      if (within(firstMount.container).queryAllByTestId('home-quick-entry').length !== 1) {
        throw new Error('first mount rollback pending')
      }
    })
    expect(quickAccessByContext.get(contextKey)?.map((entry: { id: string }) => entry.id))
      .toEqual([keyA])

    // (c) owner-order unmount variants: unmount the survivor FIRST — the
    // first mount still works; then settle-remount path.
    survivor.unmount()
    fireEvent.click(within(firstMount.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(firstMount.container).getByTestId(`all-apps-pin-${keyB}`))
    await waitForSaveCalls(3)
    tasks[2]!.resolve()
    await waitFor(() => {
      if (quickAccessByContext.get(contextKey)?.length !== 2) throw new Error('write pending')
    })
    fireEvent.click(within(firstMount.container).getByTestId('all-apps-back'))
    await waitFor(() => {
      const cards = within(firstMount.container).getAllByTestId('home-quick-entry')
      if (cards.length !== 2) throw new Error('remount display pending')
    })
    firstMount.unmount()
  })

  it('a THIRD owner joining between attempt-1 reject and retry rides the SAME activation: loads stay 2, queued mutations settle, no sweep', async () => {
    const storedApp = pinnedApp('it3-app-a', 'it3-entry-a', 'it3-artifact-a', 'Interleave A')
    const appB = pinnedApp('it3-app-b', 'it3-entry-b', 'it3-artifact-b', 'Interleave B')
    const appC = pinnedApp('it3-app-c', 'it3-entry-c', 'it3-artifact-c', 'Interleave C')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([storedApp, appB, appC]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')}`
    const keyA = appCatalogHook.uiIdentityKeyForApp(storedApp)
    const keyB = appCatalogHook.uiIdentityKeyForApp(appB)
    const keyC = appCatalogHook.uiIdentityKeyForApp(appC)
    quickAccessByContext.set(contextKey, [{ id: keyA, addedAt: 1 }])

    // Attempt 1: in-flight DEFERRED; attempt 2 (bounded retry): in-flight
    // DEFERRED — full control over the interleave window.
    let rejectFirst: ((error: unknown) => void) | undefined
    let releaseRetry: ((entries: unknown[]) => void) | undefined
    getHomeQuickAccess.mockImplementationOnce(async (_key: string): Promise<any[]> => {
      await new Promise<never>((_, reject) => { rejectFirst = reject })
      return []
    }).mockImplementation(async (_key: string): Promise<any[]> => {
      const entries = await new Promise<any[]>(resolve => { releaseRetry = resolve })
      return entries
    })

    // Mounts A and B join attempt 1 (single load).
    const mountA = renderHome()
    await waitFor(() => { if (!rejectFirst) throw new Error('attempt1 pending') })
    const mountB = render(homeTree())
    expect(loadCallCount()).toBe(1)

    // Queue mutations from A and B while attempt 1 is unresolved. The pins
    // target entries OUTSIDE the stored baseline (B, C) so the queued
    // mutations are observable additions.
    fireEvent.click(within(mountA.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(mountA.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(mountA.container).getByTestId(`all-apps-pin-${keyB}`))
    fireEvent.click(within(mountB.container).getByTestId('home-all-apps-open'))
    fireEvent.click(within(mountB.container).getByTestId(`all-apps-pin-${keyC}`))

    // Attempt 1 rejects; the SAME-gate retry starts (attempt 2).
    rejectFirst!(new Error('attempt 1 rejected (injected)'))
    await waitFor(() => { if (!releaseRetry) throw new Error('retry pending') })

    // The decisive interleave: a THIRD owner mounts in the retry window.
    // It must ride the SAME activation (no third load, no gate replacement,
    // no writer sweep).
    const mountC = render(homeTree())
    expect(loadCallCount()).toBe(2)

    // The retry resolves: queued mutations from A and B settle in order —
    // B first (queued first), then C.
    releaseRetry?.([
      { id: keyA, addedAt: 1 },
    ])
    await waitForSaveCalls(2)
    expect(apiSaveCallKeys(0)).toEqual([keyA, keyB])
    expect(apiSaveCallKeys(1)).toEqual([keyA, keyB, keyC])

    // All live mounts converge on the full acked baseline.
    const assertConverged = async (container: HTMLElement): Promise<void> => {
      await waitFor(() => {
        const cards = within(container).queryAllByTestId('home-quick-entry')
        if (cards.length !== 3) return undefined
        const identities = cards.map(card => card.getAttribute('data-identity-key'))
        return new Set(identities).size === 3 ? true : undefined
      })
    }
    await assertConverged(mountA.container)
    await assertConverged(mountB.container)
    await assertConverged(mountC.container)

    // Final unmounts drain the registry.
    mountA.unmount()
    mountB.unmount()
    mountC.unmount()
    await waitFor(() => { if (__homeQuickWritersCountForTests() !== 0) throw new Error('registry drain pending') })
  })

  it('removing the last persisted entry persists an explicitly empty collection', async () => {
    const appA = pinnedApp('last-app-a', 'last-entry-a', 'last-artifact-a', 'Last App A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    quickAccessByContext.set(contextKey, [{ id: keyA, addedAt: 1 }])

    const view = renderHome()
    await waitForNextScopeLoad(0, contextKey)
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry')).toBeTruthy()
    })

    // Remove the last entry through the manage dialog.
    fireEvent.click(screen.getByTestId('home-manage-quick-access'))
    await waitFor(() => {
      expect(screen.getByTestId('manage-home-apps-dialog')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('manage-home-apps-item'))
    fireEvent.click(screen.getByTestId('manage-home-apps-done'))
    await waitForSaveCalls(1)
    expect(setHomeQuickAccess.mock.calls[0]?.[0]).toBe(contextKey)
    expect(setHomeQuickAccess.mock.calls[0]?.[1]).toEqual([])
    expect(quickAccessByContext.get(contextKey)).toEqual([])

    // REAL remount: the explicitly empty collection stays empty.
    view.unmount()
    renderHome()
    await waitForNextScopeLoad(1, contextKey)
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
  })

  it('a rejected prune keeps the confirmed entries in UI and Map', async () => {
    const keptApp = pinnedApp('prune-app-kept', 'prune-entry-kept', 'prune-artifact-kept', 'Prune Kept')
    const vanishingApp = pinnedApp('prune-app-gone', 'prune-entry-gone', 'prune-artifact-gone', 'Prune Gone')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([keptApp, vanishingApp]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyKept = appCatalogHook.uiIdentityKeyForApp(keptApp)
    const keyGone = appCatalogHook.uiIdentityKeyForApp(vanishingApp)
    quickAccessByContext.set(contextKey, [
      { id: keyKept, addedAt: 1 },
      { id: keyGone, addedAt: 2 },
    ])

    renderHome()
    await waitForNextScopeLoad(0, contextKey)
    await waitFor(() => {
      expect(screen.getAllByTestId('home-quick-entry')).toHaveLength(2)
    })

    // The Catalog drops the second App: the prune runs but EVERY persistence
    // attempt rejects (durable failure). Each rejected suffix rolls back to
    // the last acknowledgement — nothing may ever commit.
    setHomeQuickAccess.mockImplementation(async () => {
      throw new Error('prune persistence rejected')
    })
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([keptApp]))
    viewRerender()
    // The prune's save rejects and rolls back to the acknowledgement.
    await waitForSaveCalls(1)
    // The persisted collection keeps BOTH entries — nothing committed.
    expect(quickAccessByContext.get(contextKey)?.map(entry => entry.id)).toEqual([keyKept, keyGone])

    // And the entries are still held in state: restoring the Catalog brings
    // BOTH cards back (a committed prune would have deleted the entry).
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([keptApp, vanishingApp]))
    viewRerender()
    await waitFor(() => {
      const cards = screen.getAllByTestId('home-quick-entry')
      if (cards.length !== 2) throw new Error('entries not restored')
      const identities = cards.map(card => card.getAttribute('data-identity-key'))
      expect(new Set(identities)).toEqual(new Set([keyKept, keyGone]))
    })
  })

  it('a queued write from context A lands in order after a switch and never pollutes B; remount shows it', async () => {
    const appA = pinnedApp('switch-app-a', 'switch-entry-a', 'switch-artifact-a', 'Switch App A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKeyA = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const tasks = installDeferredSave()

    renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)

    // Switch to space B while A's save is still in flight.
    const contextKeyB = `v1:${
      createProductSpaceContextKey('account-a', 'organization-b')
    }`
    const loadsBefore = loadCallCount()
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([], { organizationId: 'organization-b' }),
    )
    viewRerender()
    await waitForNextScopeLoad(loadsBefore, contextKeyB)
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()

    // A's save commits LATE: it lands in A's slot only; B shows nothing.
    tasks[0]!.resolve()
    await waitFor(() => {
      if (!(quickAccessByContext.get(contextKeyA)?.length === 1)) {
        throw new Error('condition pending')
      }
    })
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()

    // Return to A: the SHARED writer already advanced its baseline with the
    // late ack — A's pin shows without any re-read.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    viewRerender()
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    })
  })

  it('an unmounted component still lands queued writes in order; a remount reads them back', async () => {
    const appA = pinnedApp('unmount-app-a', 'unmount-entry-a', 'unmount-artifact-a', 'Unmount App A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const tasks = installDeferredSave()

    const view = renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)

    // Unmount BEFORE the save resolves: the in-order write must still land.
    view.unmount()
    tasks[0]!.resolve()
    await waitFor(() => {
      if (!(quickAccessByContext.get(contextKey)?.length === 1)) {
        throw new Error('condition pending')
      }
    })
    expect(quickAccessByContext.get(contextKey)?.map(entry => entry.id)).toEqual([keyA])

    // REAL remount rejoins the SHARED writer (its baseline advanced with the
    // late ack even though the component was unmounted) — the pin shows.
    renderHome()
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    })
  })

  it('A/S1+A/S2 across A→B→A with B completing independently (per-context writers)', async () => {
    const appA1 = pinnedApp('pc-app-a1', 'pc-entry-a1', 'pc-artifact-a1', 'PerContext A1')
    const appA2 = pinnedApp('pc-app-a2', 'pc-entry-a2', 'pc-artifact-a2', 'PerContext A2')
    const appB = pinnedApp('pc-app-b', 'pc-entry-b', 'pc-artifact-b', 'PerContext B')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA1, appA2]))
    const contextKeyA = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA1 = appCatalogHook.uiIdentityKeyForApp(appA1)
    const keyA2 = appCatalogHook.uiIdentityKeyForApp(appA2)
    const tasks = installDeferredSave()

    renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    // A/S1 fires; A/S2 queues behind it on A's OWN writer.
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyA1}`))
    await waitForSaveCalls(1)
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyA2}`))
    expect(tasks).toHaveLength(1)

    // Switch to B while both A writes are outstanding.
    const contextKeyB = `v1:${
      createProductSpaceContextKey('account-a', 'organization-b')
    }`
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith(
      [pinnedApp('pc-app-b', 'pc-entry-b', 'pc-artifact-b', 'PerContext B')],
      { organizationId: 'organization-b' },
    ))
    viewRerender()
    await waitForNextScopeLoad(0, contextKeyB)
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()

    const keyB = appCatalogHook.uiIdentityKeyForApp(appB)
    // B pins and COMPLETES while A/S1 is still hung: B is never blocked by A.
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(
      `all-apps-pin-${appCatalogHook.uiIdentityKeyForApp(appB)}`,
    ))
    await waitForSaveCalls(2)
    expect(tasks[1]?.key).toBe(contextKeyB)
    tasks[1]!.resolve()
    // Back on B's home: the acked B pin displays.
    fireEvent.click(screen.getByTestId('all-apps-back'))
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyB)
    })

    // A/S1 acks while B is DISPLAYED: A's durable baseline advances, B's
    // view is untouched.
    tasks[0]!.resolve()
    await waitFor(() => (quickAccessByContext.get(contextKeyA)?.length === 1 ? true : undefined))
    expect(screen.getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(
      appCatalogHook.uiIdentityKeyForApp(appB),
    )

    // A/S2 starts from S1's ACKED base (never B's intent) and its payload
    // targets A's slot only.
    await waitForSaveCalls(3)
    expect(tasks[2]?.key).toBe(contextKeyA)
    expect((tasks[2]?.apps as Array<{ id: string }>).map(entry => entry.id)).toEqual([keyA1, keyA2])
    tasks[2]!.resolve()
    await waitFor(() => (quickAccessByContext.get(contextKeyA)?.length === 2 ? true : undefined))

    // A→B→A: the shared writer's advanced baseline displays both A pins.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA1, appA2]))
    viewRerender()
    await waitFor(() => {
      const cards = screen.getAllByTestId('home-quick-entry')
      if (cards.length !== 2) throw new Error('A cards pending')
      const identities = cards.map(card => card.getAttribute('data-identity-key'))
      expect(new Set(identities)).toEqual(new Set([keyA1, keyA2]))
    })
    expect(quickAccessByContext.get(contextKeyA)?.map((entry: { id: string }) => entry.id))
      .toEqual([keyA1, keyA2])
    expect(quickAccessByContext.get(contextKeyB)?.map((entry: { id: string }) => entry.id))
      .toEqual([keyB])
  })

  it('two mounts of the SAME context share one writer and BOTH display acks from either mount', async () => {
    const appA = pinnedApp('mm-app-a', 'mm-entry-a', 'mm-artifact-a', 'MultiMount A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)

    const firstMount = renderHome()
    await waitForNextScopeLoad(0, contextKey)
    const loadsBeforeSecondMount = loadCallCount()
    const survivor = render(homeTree())
    // The second mount JOINS the same context writer: no second racing load
    // (the shared baseline is displayed directly).
    await waitFor(() => {
      expect(within(survivor.container).getByTestId('home-quick-entry-polo')).toBeTruthy()
    })
    expect(loadCallCount()).toBe(loadsBeforeSecondMount)

    // Mutate from the FIRST mount: the persisted ack must appear in BOTH
    // mounts (subscriber broadcast).
    fireEvent.click(within(firstMount.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(firstMount.container).getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)
    expect(setHomeQuickAccess.mock.calls[0]?.[0]).toBe(contextKey)
    // The SURVIVOR mount (idle on the home view) displays the ack through
    // the subscriber broadcast — without any mutation of its own.
    await waitFor(() => {
      expect(within(survivor.container).getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    })

    // The initiating mount returns home and displays the same ack.
    fireEvent.click(within(firstMount.container).getByTestId('all-apps-back'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    })

    // Unmount the initiating mount: the survivor still works off the shared
    // writer.
    firstMount.unmount()
    expect(within(survivor.container).getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    survivor.unmount()
  })

  it('two mounts on DIFFERENT contexts own separate writers; unmounting either lets the survivor pin/prune its own context', async () => {
    const appA = pinnedApp('mm2-app-a', 'mm2-entry-a', 'mm2-artifact-a', 'MultiMount2 A')
    const appB = pinnedApp('mm2-app-b', 'mm2-entry-b', 'mm2-artifact-b', 'MultiMount2 B')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKeyA = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)

    // Mount 1 on context A.
    const ownerMountA = renderHome()
    await waitForNextScopeLoad(0, contextKeyA)

    // Mount 2 on context B (fresh hook — the provider value follows it).
    const contextKeyB = `v1:${
      createProductSpaceContextKey('account-a', 'organization-b')
    }`
    const hookB = hookWithCatalog(
      enterpriseCatalogWith([appB], { organizationId: 'organization-b' }),
    )
    const mountB = render(homeTree(hookB))
    await waitFor(() => {
      if (getHomeQuickAccess.mock.calls.length < 2) throw new Error('B load pending')
    })
    expect(getHomeQuickAccess.mock.calls[getHomeQuickAccess.mock.calls.length - 1]?.[0]).toBe(contextKeyB)

    // Unmount mount 2 (context B): mount 1's context-A writer must survive.
    mountB.unmount()
    await waitFor(() => {
      if (!within(ownerMountA.container).getByTestId('home-quick-entry-polo')) {
        throw new Error('A home pending')
      }
    })
    fireEvent.click(within(ownerMountA.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(ownerMountA.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(ownerMountA.container).getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)
    expect(setHomeQuickAccess.mock.calls[0]?.[0]).toBe(contextKeyA)
    expect(setHomeQuickAccess.mock.calls[0]?.[1]).toEqual([
      { id: keyA, addedAt: expect.any(Number) },
    ])
    expect(quickAccessByContext.get(contextKeyA)?.map((entry: { id: string }) => entry.id))
      .toEqual([keyA])
    fireEvent.click(within(ownerMountA.container).getByTestId('all-apps-back'))
    await waitFor(() => {
      expect(within(ownerMountA.container).getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
    })

    // Unmount the OTHER order too: a fresh mount 1' on B, unmount mount 1
    // (context A) — the B survivor still pins into B's own slot.
    ownerMountA.unmount()
    const survivorB = render(homeTree(hookB))
    await waitFor(() => {
      if (getHomeQuickAccess.mock.calls.length < 3) throw new Error('reload pending')
    })
    expect(getHomeQuickAccess.mock.calls[getHomeQuickAccess.mock.calls.length - 1]?.[0]).toBe(contextKeyB)
    fireEvent.click(within(survivorB.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(survivorB.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(survivorB.container).getByTestId(
      `all-apps-pin-${hookB.uiIdentityKeyForApp(appB)}`,
    ))
    await waitForSaveCalls(2)
    expect(setHomeQuickAccess.mock.calls[1]?.[0]).toBe(contextKeyB)
    survivorB.unmount()
  })

  it('a rejected save rolls BOTH same-context mounts back identically (rollback broadcast)', async () => {
    const appA = pinnedApp('rb-app-a', 'rb-entry-a', 'rb-artifact-a', 'Rollback A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')}`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const tasks = installDeferredSave()

    const firstMount = renderHome()
    const survivor = render(homeTree())
    await waitFor(() => {
      expect(within(survivor.container).getByTestId('home-quick-entry-polo')).toBeTruthy()
    })
    fireEvent.click(within(firstMount.container).getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(within(firstMount.container).getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(within(firstMount.container).getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)
    tasks[0]!.reject(new Error('save rejected (injected)'))

    // The rollback broadcast converges BOTH mounts: no persisted entry
    // anywhere and no quick-entry card on either mount.
    await waitFor(() => {
      if (within(firstMount.container).queryAllByTestId('home-quick-entry').length !== 0) {
        throw new Error('first mount rollback pending')
      }
    })
    await waitFor(() => {
      if (within(survivor.container).queryAllByTestId('home-quick-entry').length !== 0) {
        throw new Error('survivor rollback pending')
      }
    })
    expect(quickAccessByContext.get(contextKey)).toBeUndefined()
    firstMount.unmount()
    survivor.unmount()
  })

  it('the final owner unmounts during a pending save: settle sweeps the registry to zero and the write lands', async () => {
    const appA = pinnedApp('final-app-a', 'final-entry-a', 'final-artifact-a', 'Final Owner A')
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const keyA = appCatalogHook.uiIdentityKeyForApp(appA)
    const tasks = installDeferredSave()

    const view = renderHome()
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      expect(screen.getByTestId('all-apps-view')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId(`all-apps-pin-${keyA}`))
    await waitForSaveCalls(1)

    // The final owner unmounts while the save is still in flight: the
    // writer must be RETAINED (busy > 0) — no data loss.
    view.unmount()
    expect(__homeQuickWritersCountForTests()).toBe(1)

    // The save settles: the durable write lands and the busy→0 transition
    // sweeps the registry to zero retained writers.
    tasks[0]!.resolve()
    await waitFor(() => (quickAccessByContext.get(contextKey)?.length === 1 ? true : undefined))
    await waitFor(() => {
      if (__homeQuickWritersCountForTests() !== 0) throw new Error('sweep pending')
    })
    expect(quickAccessByContext.get(contextKey)?.map((entry: { id: string }) => entry.id))
      .toEqual([keyA])
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
        id: appCatalogHook.uiIdentityKeyForApp(appA),
        addedAt: expect.any(Number),
      }])
    })
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry')).toBeTruthy()
    })
    expect(screen.getByText('Manage App A')).toBeTruthy()
  })

  it('shows the add-shortcut tile only with free slots and a Catalog', async () => {
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
    await act(async () => {})
    expect(screen.getByTestId('home-manage-quick-access')).toBeTruthy()
    view.unmount()

    // No ProductSpace context → no add tile.
    appCatalogHook = signedOutCatalogHook()
    const signedOut = renderHome()
    await act(async () => {})
    expect(signedOut.queryByTestId('home-manage-quick-access')).toBeNull()
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
    fireEvent.click(screen.getByTestId(`all-apps-action-${uiKeyFor(remoteApp)}`))

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
    fireEvent.click(screen.getByTestId(`all-apps-action-${appCatalogHook.uiIdentityKeyForApp({
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      catalogEntryId: 'bundle-entry',
      artifactInstanceId: 'bundle-artifact',
    })}`))
    await waitFor(() => expect(screen.getByText('Install Bundle App')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(installProductSpaceBundle).toHaveBeenCalledWith(bundleApp)
      expect(resolveLaunch).toHaveBeenCalledTimes(2)
      expect(storePublish).toHaveBeenCalledWith(
        { accountId: 'account-a', productSpaceId: 'organization-a' },
        7,
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
                catalogRevision: 'rev-1',
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
      `all-apps-action-${appCatalogHook.uiIdentityKeyForApp(installedWithdrawn)}`,
    ) as HTMLButtonElement
    expect(tombstoneAction.disabled).toBe(true)
    // A live App on the same page stays launchable.
    expect((screen.getByTestId(
      `all-apps-action-${JSON.stringify(['product-space-ui', 'account-a', 'organization-a', 'visible-0', null])}`,
    ) as HTMLButtonElement).disabled).toBe(false)

    // The retained installation keeps its row-level uninstall entry.
    expect(screen.getByTestId(
      `all-apps-uninstall-${appCatalogHook.uiIdentityKeyForApp(installedWithdrawn)}`,
    )).toBeTruthy()
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
                catalogRevision: 'rev-1',
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
    expect((screen.getByTestId(
      `all-apps-action-${appCatalogHook.uiIdentityKeyForApp(installedTombstone)}`,
    ) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId(
      `all-apps-uninstall-${appCatalogHook.uiIdentityKeyForApp(installedTombstone)}`,
    ))
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
