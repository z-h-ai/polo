import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactElement } from 'react'
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
const { markAppCatalogAccessDenied } = await import('@polo-ai/shared/admin/authorization-failure')
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
  return createElement(ProductSpaceProvider, {
    value: value as never,
    children: createElement(I18nextProvider, { i18n }, createElement(HomePage)),
  })
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
  it('always shows the fixed Polo assistant and opens the Polo tab', () => {
    renderHome()

    const poloEntry = screen.getByTestId('home-quick-entry-polo')
    expect(within(poloEntry).getByText('Polo Assistant')).toBeTruthy()
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
    await new Promise(resolve => setTimeout(resolve, 20))
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
    viewRerender()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(setHomeQuickAccess).not.toHaveBeenCalled()
    expect(quickAccessByContext.get(contextKey)).toEqual([
      { id: persistedId, addedAt: 1 },
    ])

    // AUTHORITATIVE Catalog commits: the entry resolves and stays.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    viewRerender()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(setHomeQuickAccess).not.toHaveBeenCalled()
    expect(quickAccessByContext.get(contextKey)).toEqual([
      { id: persistedId, addedAt: 1 },
    ])

    // The authoritative Catalog then stops listing the App: exactly ONE
    // prune+persist against the committed snapshot.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    viewRerender()
    await waitFor(() => {
      expect(setHomeQuickAccess).toHaveBeenCalledTimes(1)
    })
    expect(setHomeQuickAccess).toHaveBeenCalledWith(contextKey, [])
    expect(quickAccessByContext.get(contextKey)).toEqual([])
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

    // REAL remount: still empty.
    view.unmount()
    renderHome()
    await waitForNextScopeLoad(1, contextKeyA)
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
    await waitForNextScopeLoad(2, contextKeyB)
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()

    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    viewRerender()
    await waitForNextScopeLoad(3, contextKeyA)
    expect(screen.queryByTestId('home-quick-entry')).toBeNull()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
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
    await new Promise(resolve => setTimeout(resolve, 80))

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

    // REAL remount on A: the persisted pin appears.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const loadsBeforeA = loadCallCount()
    viewRerender()
    await waitForNextScopeLoad(loadsBeforeA, contextKeyA)
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

    // REAL remount reads the persisted pin back.
    const loadsBeforeRemount = loadCallCount()
    renderHome()
    await waitForNextScopeLoad(loadsBeforeRemount, contextKey)
    await waitFor(() => {
      expect(screen.getByTestId('home-quick-entry').getAttribute('data-identity-key')).toBe(keyA)
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
        id: appCatalogHook.uiIdentityKeyForApp(appA),
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
