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

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))


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
    // The REAL useAppCatalog returns the circles surface at the TOP level
    // (mirroring state.creatorCircles); HomeSpaceContext consumes it from
    // there.
    creatorCircles: [],
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
const { formatBytes, HomePage } = await import('../HomePage')
const { loadHomeAppUsage, __resetHomeAppUsageForTests } = await import('@/lib/home-app-usage')
const { loadHomeHiddenApps, __resetHomeHiddenAppsForTests } = await import('@/lib/home-app-hidden')
const { MemberCatalogProvider } = await import('@/context/MemberCatalogContext')
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
  __resetHomeAppUsageForTests()
  __resetHomeHiddenAppsForTests()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
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
  // H3 mount contract: the App-level MemberCatalogProvider owns the single
  // catalog instance and HomePage consumes it through useMemberCatalog. The
  // provider here runs its OWN-instance branch over the SAME mocked
  // useAppCatalog hook, so the page consumes the catalog exactly the way
  // production does.
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
    children: createElement(
      I18nextProvider,
      { i18n },
      createElement(MemberCatalogProvider, null, createElement(HomePage)),
    ),
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
  'account-a',
  app.organizationId ?? 'organization-a',
  app.catalogEntryId ?? app.id,
  app.artifactInstanceId ?? null,
])

/**
 * The DIRECTORY row identity comes from the H1 projection
 * (`getCatalogAppIdentityKey`), NOT the mock hook's uiIdentityKeyForApp —
 * the two tuples are intentionally distinct layers.
 */
const dirKeyFor = (app: CatalogApp) => JSON.stringify([
  'catalog-app-identity',
  'account-a',
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

function workApp(
  id: string,
  name: string,
  index: number,
  overrides: Partial<CatalogApp> = {},
): CatalogApp {
  return {
    id,
    catalogEntryId: id,
    artifactInstanceId: `artifact-${id}`,
    organizationId: 'organization-a',
    name,
    description: `${name} description`,
    deliveryMode: 'remote_url',
    remoteUrl: `https://${id}.example.com`,
    sortOrder: index,
    availability: 'available',
    catalogSources: [{ kind: 'enterprise_import', name: `${name} Source` }],
    ...overrides,
  }
}

/**
 * One directory card by its stable UI identity. The shared MemberAppCard
 * renders data-testid="home-directory-app" plus data-identity-key — the
 * identity tuple is never folded into the test id.
 */
function directoryCard(identityKey: string): HTMLElement {
  const card = screen.getAllByTestId('home-directory-app')
    .find(candidate => candidate.getAttribute('data-identity-key') === identityKey)
  if (!card) {
    throw new Error(`directory card not found for identity: ${identityKey}`)
  }
  return card
}

/** The row-level uninstall entry of one directory card (page-level UI). */
function directoryUninstallButton(identityKey: string): HTMLElement {
  const wrapper = directoryCard(identityKey).parentElement
  const button = wrapper?.querySelector('[data-testid^="home-directory-uninstall-"]')
  if (!button) {
    throw new Error(`directory uninstall entry not found for identity: ${identityKey}`)
  }
  return button as HTMLElement
}

describe('HomePage complete directory (POO-70 H3)', () => {
  it('always shows the fixed Polo assistant and opens the Polo tab', async () => {
    renderHome()
    await act(async () => {})

    const poloEntry = screen.getByTestId('home-quick-entry-polo')
    expect(within(poloEntry).getByText('Polo Assistant')).toBeTruthy()
    fireEvent.click(poloEntry)
    expect(openApp).toHaveBeenCalledWith(POLO_APP_DEFINITION)
  })

  it('P70-HOME-01: renders the COMPLETE authorized directory with no pinning — more than five work Apps and same-named works all get their own card', async () => {
    // No persisted home configuration exists anywhere anymore: every
    // authorized App of the space is displayed, beyond the old five-slot cap,
    // and two works sharing a NAME stay distinct rows (identity, not name).
    const apps = [
      workApp('dir-1', 'Alpha App', 0),
      workApp('dir-2', 'Alpha App', 1, { artifactInstanceId: 'artifact-other' }),
      workApp('dir-3', 'Beta App', 2),
      workApp('dir-4', 'Gamma App', 3),
      workApp('dir-5', 'Delta App', 4),
      workApp('dir-6', 'Epsilon App', 5),
      workApp('dir-7', 'Zeta App', 6),
    ]
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith(apps))

    renderHome()
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(7)
    })

    // Same name, two identities: both render.
    expect(screen.getAllByText('Alpha App')).toHaveLength(2)
    // Names order unused works; equal names retain their distinct identities.
    const identities = screen.getAllByTestId('home-directory-app')
      .map(card => card.getAttribute('data-identity-key'))
    expect(identities).toEqual([0, 1, 2, 4, 5, 3, 6].map(index => dirKeyFor(apps[index]!)))
    // The retired quick-access surface is gone from the page.
    expect(screen.queryByTestId('home-all-apps-open')).toBeNull()
    expect(screen.queryByTestId('home-manage-quick-access')).toBeNull()
  })

  it('P70-HOME-01: search narrows the directory and the explicit clear restores it', async () => {
    const apps = [
      workApp('search-1', 'Report Builder', 0),
      workApp('search-2', 'Contract Review', 1),
    ]
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith(apps))
    renderHome()
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(2)
    })

    fireEvent.change(screen.getByTestId('home-directory-search'), {
      target: { value: 'contract' },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(1)
    })
    expect(screen.getByText('Contract Review')).toBeTruthy()
    expect(screen.queryByText('Report Builder')).toBeNull()

    // The filter vacuum is its own state with the explicit clear action.
    fireEvent.change(screen.getByTestId('home-directory-search'), {
      target: { value: 'zzz-nothing' },
    })
    await waitFor(() => {
      expect(screen.getByTestId('home-directory-no-match')).toBeTruthy()
    })
    expect(screen.queryAllByTestId('home-directory-app')).toHaveLength(0)
    fireEvent.click(within(screen.getByTestId('home-directory-no-match')).getByText('Clear filters'))
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(2)
    })
    expect((screen.getByTestId('home-directory-search') as HTMLInputElement).value).toBe('')
  })

  it('P70-HOME-01: source filter offers exactly the directory sources and narrows by them', async () => {
    const apps = [
      workApp('src-1', 'Growth App', 0),
      workApp('src-2', 'Design App', 1, {
        catalogSources: [{ kind: 'enterprise_import', name: 'Design Circle' }],
      }),
      workApp('src-3', 'Studio App', 2, {
        catalogSources: [{ kind: 'enterprise_import', name: 'Organization A' }],
      }),
    ]
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith(apps))
    renderHome()
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(3)
    })

    const sourceSelect = screen.getByTestId('home-directory-source') as HTMLSelectElement
    const options = Array.from(sourceSelect.options).map(option => option.value)
    // Options derive from the directory's ACTUAL sources — no fixed list.
    expect(options).toEqual(['all', 'Growth App Source', 'Design Circle', 'Organization A'])

    fireEvent.change(sourceSelect, { target: { value: 'Design Circle' } })
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(1)
    })
    expect(screen.getByText('Design App')).toBeTruthy()
  })

  it('P70-HOME-01: recent sort refreshes on return and unused works sort by name', async () => {
    const apps = [
      workApp('sort-a', 'Charlie App', 0),
      workApp('sort-b', 'alpha App', 1),
      workApp('sort-c', 'Bravo App', 2),
    ]
    const resolveLaunch = jest.fn(async () => resolvedLaunch(apps[2]!))
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith(apps), { resolveLaunch })
    const visit = renderHome()
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(3)
    })

    // Default (recent) WITHOUT any history: stable name fallback.
    expect(screen.getAllByTestId('home-directory-app').map(card => card.textContent))
      .toEqual([
        expect.stringContaining('alpha App'),
        expect.stringContaining('Bravo App'),
        expect.stringContaining('Charlie App'),
      ])

    // A successful open records use but keeps cards still during this visit.
    fireEvent.click(directoryCard(dirKeyFor(apps[2]!)))
    await waitFor(() => {
      expect(storePublish).toHaveBeenCalled()
    })
    expect(screen.getAllByTestId('home-directory-app')[0]?.textContent).toContain('alpha App')
    visit.unmount()
    renderHome()
    await waitFor(() => {
      const cards = screen.getAllByTestId('home-directory-app')
      if (!cards[0]?.textContent?.includes('Bravo App')) {
        throw new Error('recent re-rank pending')
      }
    })

    // Name sort is locale-ordered regardless of usage or Catalog order.
    fireEvent.change(screen.getByTestId('home-directory-sort'), {
      target: { value: 'name' },
    })
    await waitFor(() => {
      const cards = screen.getAllByTestId('home-directory-app')
      if (!cards[0]?.textContent?.includes('alpha App')) throw new Error('name sort pending')
    })
    expect(screen.getAllByTestId('home-directory-app').map(card => card.textContent))
      .toEqual([
        expect.stringContaining('alpha App'),
        expect.stringContaining('Bravo App'),
        expect.stringContaining('Charlie App'),
      ])

    // The usage record is bound to the ProductSpace context key and
    // persisted for the NEXT session's sort.
    // The usage key derives from the MOCK hook's productSpaceContextKey —
    // the same tuple format createHomeQuickAccessContextKey wraps.
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    const records = loadHomeAppUsage(contextKey)
    expect(records.get(dirKeyFor(apps[2]!))?.openCount).toBe(1)
  })

  it('P70-HOME-02: the personal home shows the circles entry and the enterprise home never mixes it in', async () => {
    // Enterprise (default harness space kind): no circles entry.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    const enterpriseView = renderHome()
    await act(async () => {})
    expect(screen.queryByTestId('home-circles-link')).toBeNull()
    enterpriseView.unmount()

    // Personal: the circles entry renders and navigates the client-page
    // route (asserted with a probe provider in complete-directory tests —
    // here without the provider it falls back to the local circles card
    // instead of a silent no-op).
    const personalHook = hookWithCatalog(enterpriseCatalogWith([]))
    personalHook.productSpace.activeProductSpace = {
      id: 'organization-a',
      kind: 'personal',
      name: 'My Space',
    }
    appCatalogHook = personalHook
    renderHome()
    await act(async () => {})
    const circles = screen.getByTestId('home-circles-link')
    fireEvent.click(circles)
    await waitFor(() => {
      expect(screen.getByTestId('home-space-context')).toBeTruthy()
    })
  })

  it('P70-HOME-03: keeps Polo visible while the current Catalog is loading or failed, retry stays explicit', async () => {
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([]),
      {},
      { catalog: null, loading: true },
    )
    const loading = renderHome()
    await act(async () => {})
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(screen.getByTestId('home-directory-loading')).toBeTruthy()
    loading.unmount()

    const sync = jest.fn(async () => {})
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([]),
      { sync },
      { catalog: null, loading: false, errorCode: 'NETWORK_ERROR' },
    )
    renderHome()
    await act(async () => {})
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(screen.getByTestId('home-directory-load-failed')).toBeTruthy()
    expect(screen.getByText('Could not load the Apps of this space')).toBeTruthy()

    // The retry is a click, never an auto-execution.
    expect(sync).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByTestId('home-directory-load-failed')).getByText('Try again'))
    expect(sync).toHaveBeenCalledWith(true)
  })

  it('P70-HOME-03: an honest personal vacuum and an explicit enterprise no-distribution vacuum', async () => {
    const personalHook = hookWithCatalog(enterpriseCatalogWith([]))
    personalHook.productSpace.activeProductSpace = {
      id: 'organization-a',
      kind: 'personal',
      name: 'My Space',
    }
    appCatalogHook = personalHook
    const personalView = renderHome()
    await act(async () => {})
    expect(screen.getByTestId('home-directory-empty-personal')).toBeTruthy()
    expect(screen.queryByTestId('home-directory-empty-enterprise')).toBeNull()
    personalView.unmount()

    // Enterprise vacuum: "not distributed yet" — never the personal copy.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    renderHome()
    await act(async () => {})
    expect(screen.getByTestId('home-directory-empty-enterprise')).toBeTruthy()
    expect(screen.queryByTestId('home-directory-empty-personal')).toBeNull()
  })

  it('P70-HOME-03: a fully-rejected directory is NOT a vacuum — the rejection feedback shows with an explicit retry', async () => {
    // All rows refused consumer-side: a PERSONAL space whose only entry
    // carries an enterprise_import source (space-kind mismatch) is refused
    // wholesale — the entries stay empty while the rejection is recorded.
    const refusedApp = workApp('rej-1', 'Refused App', 0, {
      catalogSources: [{ kind: 'enterprise_import', name: 'Foreign Org' }],
    })
    const personalHook = hookWithCatalog(enterpriseCatalogWith([refusedApp]))
    personalHook.productSpace.activeProductSpace = {
      id: 'organization-a',
      kind: 'personal',
      name: 'My Space',
    }
    appCatalogHook = personalHook
    renderHome()
    await act(async () => {})
    expect(screen.getByTestId('home-directory-rejected')).toBeTruthy()
    expect(screen.queryByTestId('home-directory-empty-personal')).toBeNull()
    expect(screen.queryByTestId('home-directory-empty-enterprise')).toBeNull()
    expect(screen.queryByText('Refused App')).toBeNull()
  })

  it('P70-HOME-03: offline keeps the cached rows visible but NOTHING launchable, with the offline banner', async () => {
    const app = workApp('offline-1', 'Offline App', 0)
    const resolveLaunch = jest.fn(async () => resolvedLaunch(app))
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([app]),
      { resolveLaunch },
      { accessMode: 'offline' },
    )
    renderHome()
    await waitFor(() => {
      expect(screen.getByTestId('home-directory-offline-banner')).toBeTruthy()
    })
    // The cached row stays visible (facts preserved)...
    expect(screen.getByText('Offline App')).toBeTruthy()
    // ...but opening it fails closed BEFORE any launch authority is asked.
    fireEvent.click(directoryCard(dirKeyFor(app)))
    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalled()
    })
    expect(resolveLaunch).not.toHaveBeenCalled()
    expect(storePublish).not.toHaveBeenCalled()
    expect(openApp).not.toHaveBeenCalled()
  })

  it('P70-HOME-03: a failed REFRESH keeps the cached directory visible under an explicit stale banner, with opens fail-closed and explicit retry', async () => {
    // Regression guard (review P1-1): a NON-denied refresh failure keeps
    // state.catalog and sets errorCode — phase 'error' OVER a retained
    // cache. The directory must never silently blank: the cached rows stay
    // visible (never launchable), the stale banner explains the state, and
    // the retry is an explicit click.
    const app = workApp('stale-1', 'Stale App', 0)
    const resolveLaunch = jest.fn(async () => resolvedLaunch(app))
    const sync = jest.fn(async () => {})
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([app]),
      { resolveLaunch, sync },
      { errorCode: 'NETWORK_ERROR' },
    )
    renderHome()
    await waitFor(() => {
      expect(screen.getByTestId('home-directory-stale-banner')).toBeTruthy()
    })
    // The cached directory is STILL rendered...
    expect(screen.getByText('Stale App')).toBeTruthy()
    expect(screen.getAllByTestId('home-directory-app')).toHaveLength(1)
    // ...but opening a cached row fails closed BEFORE any launch authority.
    fireEvent.click(directoryCard(dirKeyFor(app)))
    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalled()
    })
    expect(resolveLaunch).not.toHaveBeenCalled()
    expect(storePublish).not.toHaveBeenCalled()
    expect(openApp).not.toHaveBeenCalled()
    // The retry is a click, never an auto-execution.
    expect(sync).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('home-directory-stale-retry'))
    expect(sync).toHaveBeenCalledWith(true)
  })

  it('R39/R41: the dedicated wrapper owns viewport-bounded scrolling and rows below the fold stay reachable in the full directory', async () => {
    // More than a viewport of directory rows: every row renders inside the
    // home-app-hub, the dedicated PARENT wrapper is the viewport-bounded
    // scroll owner (h-full min-h-0 overflow-y-auto), and the hub region
    // itself stays content-sized.
    const apps = [
      workApp('scroll-1', 'Scroll App A', 0),
      workApp('scroll-2', 'Scroll App B', 1),
      workApp('scroll-3', 'Scroll App C', 2),
      workApp('scroll-4', 'Scroll App D', 3),
      workApp('scroll-5', 'Scroll App E', 4),
      workApp('scroll-6', 'Scroll App F', 5),
      workApp('scroll-7', 'Scroll App G', 6),
    ]
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith(apps))
    renderHome()
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(7)
    })

    const hub = screen.getByTestId('home-app-hub')
    const scrollOwner = hub.parentElement
    if (!scrollOwner) {
      throw new Error('dedicated scroll-owner wrapper is missing: home-app-hub has no parent element in the committed tree')
    }
    expect(scrollOwner.className).toContain('h-full')
    expect(scrollOwner.className).toContain('min-h-0')
    expect(scrollOwner.className).toContain('overflow-y-auto')
    expect(hub.className).not.toContain('h-full')

    // Every row — including the LAST, below any realistic fold — renders
    // inside the hub.
    expect(screen.getByText('Scroll App G')).toBeTruthy()
    expect(within(hub).getAllByText(/Scroll App G Source/).length).toBeGreaterThan(0)
  })

  it('P70-HOME-01 保留本机隐藏恢复: hide moves a work to the hidden section, restore brings it back, and the preference is device-local per context', async () => {
    const appA = workApp('hide-a', 'Hideable App A', 0)
    const appB = workApp('hide-b', 'Hideable App B', 1)
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA, appB]))
    renderHome()
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(2)
    })
    expect(screen.queryByTestId('home-directory-hidden-section')).toBeNull()

    // Hide App A: it leaves the grid and appears in the hidden section with
    // an explicit restore action.
    fireEvent.click(screen.getByTestId(`home-directory-hide-${dirKeyFor(appA)}`))
    await waitFor(() => {
      expect(screen.getByTestId('home-directory-hidden-section')).toBeTruthy()
    })
    expect(screen.queryAllByTestId('home-directory-app')).toHaveLength(1)
    expect(screen.getByText('Hideable App B')).toBeTruthy()
    // The hidden section lists A by name (with its restore action); A has no
    // grid card anymore (the grid holds exactly B, asserted above).
    const item = screen.getByTestId(`home-directory-hidden-item-${dirKeyFor(appA)}`)
    expect(within(item).getByText('Hideable App A')).toBeTruthy()

    // Restore: back into the grid, section gone.
    fireEvent.click(screen.getByTestId(`home-directory-hidden-restore-${dirKeyFor(appA)}`))
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(2)
    })
    expect(screen.queryByTestId('home-directory-hidden-section')).toBeNull()

    // The preference is device-local, bounded to the SAME account+space
    // context — after a REAL remount it still holds (persisted), and the
    // restored state is clean again.
    fireEvent.click(screen.getByTestId(`home-directory-hide-${dirKeyFor(appA)}`))
    await waitFor(() => {
      expect(screen.getByTestId('home-directory-hidden-section')).toBeTruthy()
    })
    const contextKey = `v1:${
      createProductSpaceContextKey('account-a', 'organization-a')
    }`
    expect(loadHomeHiddenApps(contextKey).size).toBe(1)
    viewRerender()
    expect(screen.getAllByTestId('home-directory-app')).toHaveLength(1)
  })

  it('P70-HOME-03: a denied snapshot hides its refused rows behind the restricted banner with no open/install capability', async () => {
    const app = workApp('denied-1', 'Denied App', 0)
    const deniedSnapshot = markAppCatalogAccessDenied(enterpriseCatalogWith([app]))
    expect(deniedSnapshot.apps[0]).toMatchObject({
      catalogEntryId: 'denied-1',
      availability: 'unavailable',
    })
    const resolveLaunch = jest.fn(async () => resolvedLaunch(app))
    appCatalogHook = {
      ...hookWithCatalog(deniedSnapshot as unknown as AppCatalogCacheEntry),
      state: {
        ...signedOutCatalogHook().state,
        catalog: deniedSnapshot as unknown as AppCatalogCacheEntry,
        accessMode: 'denied' as const,
        errorCode: 'FORBIDDEN',
      },
      resolveLaunch,
    }
    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('home-restricted-banner')).toBeTruthy()
    })
    // H1 projection semantics: the denied tombstone STRIPS catalogSources,
    // so the consumer-side projection refuses those rows fail-closed — the
    // restricted banner explains the state and NO cached row renders as a
    // pseudo-launchable card.
    expect(screen.queryByText('Denied App')).toBeNull()
    expect(screen.queryAllByTestId('home-directory-app')).toHaveLength(0)
    expect(resolveLaunch).not.toHaveBeenCalled()
    expect(storePublish).not.toHaveBeenCalled()
    expect(openApp).not.toHaveBeenCalled()
    expect(screen.queryByTestId(/^home-directory-uninstall-/)).toBeNull()
  })

  it('opens directory Apps through the authorized catalog flow and publishes the resolved launch', async () => {
    const app = workApp('open-1', 'Open App', 0)
    const resolveLaunch = jest.fn(async () => resolvedLaunch(app))
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([app]), { resolveLaunch })

    renderHome()
    fireEvent.click(directoryCard(dirKeyFor(app)))

    await waitFor(() => {
      expect(resolveLaunch).toHaveBeenCalledWith(app)
      expect(storePublish).toHaveBeenCalledWith(
        { accountId: 'account-a', productSpaceId: 'organization-a' },
        7,
        'account-a',
        resolvedLaunch(app),
      )
    })
    expect(openApp).not.toHaveBeenCalled()
  })

  it('prepares a resolved bundle through the install dialog and publishes the re-resolved launch', async () => {
    const app = workApp('bundle-1', 'Bundle App', 0, { deliveryMode: 'resolve_launch' })
    delete (app as Partial<CatalogApp>).remoteUrl
    const launch = resolvedBundleLaunch(app)
    const resolveLaunch = jest.fn(async () => launch)
    const installProductSpaceBundle = jest.fn(async () => {})
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([app]),
      { resolveLaunch, installProductSpaceBundle },
    )

    renderHome()
    fireEvent.click(directoryCard(dirKeyFor(app)))
    await waitFor(() => expect(screen.getByText('Install Bundle App')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(installProductSpaceBundle).toHaveBeenCalledWith(app)
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

  it('keeps a withdrawn tombstone visible and non-launchable, with the uninstall entry while installed locally', async () => {
    const live = workApp('tomb-live', 'Live App', 1)
    const installedTombstone = workApp('tomb-gone', 'Removed App', 0, {
      availability: 'withdrawn',
    })
    const uninstallProductSpaceBundle = jest.fn(async () => {})
    const resolveLaunch = jest.fn(async () => resolvedLaunch(live))
    appCatalogHook = hookWithCatalog(
      enterpriseCatalogWith([live, installedTombstone]),
      {
        resolveLaunch,
        uninstallProductSpaceBundle,
        getInstallState: (target: CatalogApp) => target.id === 'tomb-gone'
          ? {
              app: {
                accountId: 'account-a',
                productSpaceId: 'organization-a',
                catalogRevision: 'rev-1',
                catalogEntryId: installedTombstone.catalogEntryId!,
                artifactInstanceId: installedTombstone.artifactInstanceId!,
                versionId: installedTombstone.catalogVersion?.versionId ?? 'version-1',
                version: installedTombstone.catalogVersion?.version ?? '1.0.0',
              },
              state: 'installed' as const,
              currentVersion: '1.0.0',
            }
          : undefined,
      },
    )

    renderHome()
    await waitFor(() => {
      expect(screen.getByText('Removed App')).toBeTruthy()
    })
    expect(screen.getByText('Live App')).toBeTruthy()

    // The tombstone is NOT launchable: the open gate refuses per-row facts.
    fireEvent.click(directoryCard(dirKeyFor(installedTombstone)))
    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalled()
    })
    expect(resolveLaunch).not.toHaveBeenCalled()

    // The retained local installation keeps its uninstall entry, through the
    // SAME uninstall dialog as before.
    fireEvent.click(directoryUninstallButton(dirKeyFor(installedTombstone)))
    await waitFor(() => {
      expect(screen.getByText('Uninstall Removed App?')).toBeTruthy()
    })
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }))
    await waitFor(() => {
      expect(uninstallProductSpaceBundle).toHaveBeenCalledWith(installedTombstone, true)
    })
  })

  it('hides the toolbar, circles entry and workspace entries when no ProductSpace context exists', async () => {
    renderHome()
    await act(async () => {})

    expect(screen.queryByTestId('home-directory-toolbar')).toBeNull()
    expect(screen.queryByTestId('home-circles-link')).toBeNull()
    expect(screen.queryByTestId('home-all-apps-open')).toBeNull()
    expect(screen.queryByTestId('home-manage-quick-access')).toBeNull()
  })
})

describe('HomePage A→B ProductSpace isolation (R39)', () => {
  it('A→B ProductSpace transition: the first committed target Home layout exposes no prior-scope Apps, sources, or Skill metadata', async () => {
    const appA = workApp('ctx-a-app', 'Scope A App', 0)
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    const view = renderHome()
    await waitFor(() => expect(screen.getByText('Scope A App')).toBeTruthy())
    expect(screen.getByTestId('home-app-hub').textContent).toContain('Scope A App Source')

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
      catalogSources: [{ kind: 'enterprise_import', name: 'Scope B Source' }],
    }
    const catalogB = {
      ...enterpriseCatalogWith([appB]),
      accountId: 'account-b',
      organizationId: 'organization-b',
    }
    const hookB = hookWithCatalog(catalogB)
    act(() => {
      // Stable root: mutate ONLY the hook value; the rendered root shape is
      // untouched, so React updates the SAME mounted tree instead of
      // remounting.
      appCatalogHook = hookB
      viewRerender()
    })

    // FIRST committed target Home layout: no prior-scope App identity,
    // sources, or Skill metadata may appear.
    const hub = screen.getByTestId('home-app-hub')
    const firstCommitText = hub.textContent ?? ''
    expect(firstCommitText).not.toContain('Scope A App')
    expect(firstCommitText).not.toContain('Scope A Source')
    expect(firstCommitText).not.toContain('Skill 已启用')
    expect(firstCommitText).not.toContain('skills enabled')
    expect(firstCommitText).toContain('Built into Polo')

    // Context B's own data lands afterwards: the hydrated B state carries B
    // identity only.
    await waitFor(() => expect(screen.getByText('Scope B App')).toBeTruthy())
    const hydratedText = screen.getByTestId('home-app-hub').textContent ?? ''
    expect(hydratedText).toContain('Scope B Source')
    expect(hydratedText).not.toContain('Scope A App')
    expect(hydratedText).not.toContain('Scope A Source')
    view.unmount()
  })

  it('usage records never cross the ProductSpace context: A usage is invisible to B and back', async () => {
    const appA = workApp('usage-a', 'Usage A App', 0)
    const appB: CatalogApp = {
      ...workApp('usage-b', 'Usage B App', 0),
      organizationId: 'organization-b',
    }
    const resolveLaunch = jest.fn(async () => resolvedLaunch(appA))
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]), { resolveLaunch })
    const view = renderHome()
    await waitFor(() => expect(screen.getByText('Usage A App')).toBeTruthy())

    // Open A's app: the record lands in A's context store only.
    fireEvent.click(directoryCard(dirKeyFor(appA)))
    await waitFor(() => expect(storePublish).toHaveBeenCalled())

    const keyA = `v1:${createProductSpaceContextKey('account-a', 'organization-a')}`
    expect(loadHomeAppUsage(keyA).size).toBe(1)

    // Switch to B (different organization): no A record may leak into B.
    const catalogB = {
      ...enterpriseCatalogWith([appB]),
      organizationId: 'organization-b',
    }
    appCatalogHook = hookWithCatalog(catalogB)
    act(() => { viewRerender() })
    await waitFor(() => expect(screen.getByText('Usage B App')).toBeTruthy())

    const keyB = `v1:${createProductSpaceContextKey('account-a', 'organization-b')}`
    expect(loadHomeAppUsage(keyB).size).toBe(0)

    // Back to A: A's record is still A's only.
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([appA]))
    act(() => { viewRerender() })
    await waitFor(() => expect(screen.getByText('Usage A App')).toBeTruthy())
    expect(loadHomeAppUsage(keyB).size).toBe(0)
    expect(loadHomeAppUsage(keyA).size).toBe(1)
    view.unmount()
  })
})

describe('HomePage enterprise workflows (committed-lease fail-closed)', () => {
  for (const language of ['zh-Hans', 'en']) {
    it(`localizes capability rejection and permits explicit same-context workflow retry in ${language}`, async () => {
      await i18n.changeLanguage(language)
      appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
      appCatalogHook.productSpace.activeProductSpace = {
        id: 'organization-a', enterpriseId: 'enterprise-a', kind: 'enterprise',
        name: 'Enterprise A', role: 'manager', accessMode: 'active',
      }
      adminGetStatus.mockResolvedValue({ loggedIn: true, userId: 'account-a', adminUrl: 'https://admin.example.com' })
      openUrl.mockRejectedValueOnce(new Error('Failed to open URL: Cannot open URL on client: capability unavailable'))
      renderHome()
      fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
      await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledWith(i18n.t('homeSpace.workflows.openFailed')))
      expect(JSON.stringify(toastErrorSpy.mock.calls)).not.toContain('Cannot open URL')
      expect(openUrl).toHaveBeenCalledTimes(1)
      openUrl.mockResolvedValue(undefined)
      fireEvent.click(screen.getByTestId('enterprise-member-management-link'))
      await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2))
      expect(openUrl).toHaveBeenLastCalledWith('https://admin.example.com/enterprise/enterprise-a/members')
      fireEvent.click(screen.getByTestId('enterprise-creator-publishing-link'))
      await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(3))
      expect(openUrl).toHaveBeenLastCalledWith('https://admin.example.com/organization-apps?organizationId=enterprise-a')
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
    })
  }

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
      expect(toastErrorSpy).toHaveBeenCalledWith(i18n.t('homeSpace.workflows.openFailed'), {
        description: i18n.t('homeApps.errors.staleContext'),
      })
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
