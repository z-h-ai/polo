import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import { BUILTIN_APP_DEFINITIONS } from '../../../../shared/tab-browser-types'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'

// Register only when no window exists yet (shared bun test process).
if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()

/**
 * POO-70 H3 (P70-HOME-01/02/03) — the complete-directory projection contract
 * on top of the H1 `selectHomeAppDirectory` projection: pure search/filter/
 * sort over fields that actually exist, the per-context usage records, and
 * the N1 circles navigation handoff.
 */

const openApp = jest.fn()
const storePublish = jest.fn((_live: unknown, _lease: number, accountId: string, launch: unknown) => ({
  handoffId: 'test-handoff',
  context: { accountId, launch },
}))

let appCatalogHook: any

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
    start: async () => ({ appId: 'unused', version: '1.0.0', url: 'http://127.0.0.1:1', port: 1 }),
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
    installedApps: [...BUILTIN_APP_DEFINITIONS],
    openApp,
    removeApp: async () => {},
  }),
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
    error: () => {},
    success: () => {},
  },
}))

const {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')
const {
  HomePage,
  collectHomeAppSourceOptions,
  homeAppMatchesQuery,
  homeAppMatchesSource,
  sortHomeAppDirectory,
} = await import('../HomePage')
const {
  loadHomeAppUsage,
  recordHomeAppUsage,
  __resetHomeAppUsageForTests,
} = await import('@/lib/home-app-usage')
const {
  hideHomeApp,
  loadHomeHiddenApps,
  restoreHomeApp,
  __resetHomeHiddenAppsForTests,
} = await import('@/lib/home-app-hidden')
const { MemberCatalogProvider } = await import('@/context/MemberCatalogContext')
const {
  ClientPageProvider,
  HOME_CLIENT_PAGE_ROUTE,
  clientPageScopeKey,
  useOptionalClientPage,
} = await import('@/context/ClientPageContext')

// The usage context key derives from the ProductSpaceContext's
// productSpaceContextKey (the harness provider value's format), NOT the
// storage-tuple key produced by createProductSpaceContextKey.
const contextKeyA = 'v1:account-a|organization-a'

/**
 * Mutable RPC stub payload for the page-level tests: the MemberCatalogProvider
 * runs its OWN instance of the REAL useAppCatalog hook (the H3 mount
 * contract), so the directory rows are driven through the real catalog RPC
 * boundary instead of a mocked hook.
 */
let stubCatalogEntries: unknown[] = []

function directoryEntry(
  id: string,
  name: string,
  index: number,
  overrides: Partial<CatalogApp> = {},
) {
  const app: CatalogApp = {
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
    catalogSources: [{ kind: 'creator_circle', name: `${name} Circle` }],
    ...overrides,
  }
  return {
    identityKey: JSON.stringify([
      'product-space-ui',
      'account-a',
      'organization-a',
      id,
      `artifact-${id}`,
    ]),
    catalogEntryId: id,
    artifactInstanceId: `artifact-${id}`,
    app,
    sources: [{
      kind: 'creator_circle' as const,
      circleId: null,
      name: `${name} Circle`,
      valid: true,
      refusal: null,
    }],
    availability: 'available' as const,
    rawAvailability: 'available' as const,
    launchBlocked: false,
  }
}

beforeEach(async () => {
  localStorage.clear()
  openApp.mockClear()
  storePublish.mockClear()
  appCatalogHook = signedOutCatalogHook()
  __resetHomeAppUsageForTests()
  __resetHomeHiddenAppsForTests()
  stubCatalogEntries = []
  // Minimal real-hook surface: the catalog hook touches localApps and the
  // catalog RPC on mount even in the page-level tests below.
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      adminGetStatus: async () => ({ loggedIn: false }),
      openUrl: async () => {},
      productSpaceGetCatalog: async () => ({
        success: true as const,
        notModified: false as const,
        catalogRevision: 'rev-complete-directory',
        productSpaceId: 'organization-a',
        accessMode: 'online' as const,
        entries: stubCatalogEntries,
        withdrawnEntries: [],
      }),
      productSpaceResolveLaunch: async (
        productSpaceId: string,
        catalogEntryId: string,
      ) => {
        // Seal the launch to the CURRENT stub entry identity — the real hook
        // re-verifies subject/catalogVersion/artifactInstance against the
        // hydrated catalog, exactly as production does.
        const entry = (stubCatalogEntries as Array<Record<string, unknown>>).find(
          candidate => candidate.catalogEntryId === catalogEntryId,
        )
        const version = (entry?.version ?? {}) as { versionId?: string; version?: string }
        const artifactInstanceId = (entry?.artifactInstanceId as string)
          ?? `artifact-${catalogEntryId}`
        return {
          success: true as const,
          launch: {
            contractVersion: 1,
            productSpaceId,
            catalogEntryId,
            resolvedAt: '2099-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:10:00.000Z',
            subject: {
              kind: 'artifact_instance' as const,
              artifactType: 'app' as const,
              artifactInstanceId,
              versionId: version.versionId ?? `version-${catalogEntryId}`,
              version: version.version ?? '1.0.0',
            },
            payer: { kind: 'personal' as const, accountId: 'account-a' },
            delivery: {
              kind: 'web_url' as const,
              url: 'https://launched.example.com',
              launchToken: 'launch-token-value',
            },
          },
        }
      },
      localApps: {
        getHostInfo: async () => ({ platform: 'darwin' as const, arch: 'arm64' as const }),
        getRuntimeStatuses: async () => [],
        getRuntimeStatus: async (scope: { catalogAppId: string }) => ({
          appId: scope.catalogAppId,
          scope,
          status: 'not_installed' as const,
        }),
        getProductSpaceInstallStates: async (apps: unknown[]) => apps,
        getProductSpaceWithdrawnInstallStates: async (apps: unknown[]) => apps,
      },
    },
  })
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

// ─── Pure sort / filter contract ─────────────────────────────────────────────

describe('sortHomeAppDirectory (P70-HOME-01, real fields only)', () => {
  const entries = [
    directoryEntry('e1', 'Charlie', 0),
    directoryEntry('e2', 'alpha', 1),
    directoryEntry('e3', 'Bravo', 2),
  ]

  it('uses stable name order when no usage records exist', () => {
    expect(sortHomeAppDirectory(entries, 'recent', new Map()).map(entry => entry.app.name))
      .toEqual(['alpha', 'Bravo', 'Charlie'])
    expect(sortHomeAppDirectory(entries, 'frequent', new Map()).map(entry => entry.app.name))
      .toEqual(['alpha', 'Bravo', 'Charlie'])
  })

  it('recent ranks REAL opens newest-first and sorts unused works by name', () => {
    const usage = new Map([
      [entries[2]!.identityKey, { lastUsedAt: 100, openCount: 1 }],
      [entries[0]!.identityKey, { lastUsedAt: 200, openCount: 1 }],
    ])
    expect(sortHomeAppDirectory(entries, 'recent', usage).map(entry => entry.app.name))
      .toEqual(['Charlie', 'Bravo', 'alpha'])
  })

  it('frequent ranks by open count, ties resolve by name', () => {
    const usage = new Map([
      [entries[1]!.identityKey, { lastUsedAt: 300, openCount: 5 }],
      [entries[2]!.identityKey, { lastUsedAt: 100, openCount: 5 }],
    ])
    expect(sortHomeAppDirectory(entries, 'frequent', usage).map(entry => entry.app.name))
      .toEqual(['alpha', 'Bravo', 'Charlie'])
  })

  it('uses name fallback for unused works and tied real usage ranks', () => {
    const onlyBravo = new Map([[entries[2]!.identityKey, { lastUsedAt: 100, openCount: 1 }]])
    for (const mode of ['recent', 'frequent'] as const) {
      expect(sortHomeAppDirectory(entries, mode, onlyBravo).map(entry => entry.app.name))
        .toEqual(['Bravo', 'alpha', 'Charlie'])
      const tied = new Map(entries.map(entry => [entry.identityKey, { lastUsedAt: 100, openCount: 2 }]))
      expect(sortHomeAppDirectory(entries, mode, tied).map(entry => entry.app.name))
        .toEqual(['alpha', 'Bravo', 'Charlie'])
    }
  })

  it('name sorts locale-wise and stays stable for equal names', () => {
    expect(sortHomeAppDirectory(entries, 'name', new Map()).map(entry => entry.app.name))
      .toEqual(['alpha', 'Bravo', 'Charlie'])
    const sameName = [directoryEntry('x1', 'Same', 0), directoryEntry('x2', 'Same', 1)]
    expect(sortHomeAppDirectory(sameName, 'name', new Map()).map(entry => entry.app.id))
      .toEqual(['x1', 'x2'])
  })
})

describe('search and source filter (P70-HOME-01)', () => {
  const entry = directoryEntry('e1', 'Report Builder', 0, {
    creatorName: 'Studio L',
    sourceNames: ['Report Circle'],
  })

  it('matches name, description, creator and sources case-insensitively', () => {
    expect(homeAppMatchesQuery(entry, 'report')).toBe(true)
    // Each field is matched on its own: a query spanning two fields (name
    // "Report Builder" + description text) must not match either field.
    expect(homeAppMatchesQuery(entry, 'report zzz')).toBe(false)
    expect(homeAppMatchesQuery(entry, 'zzz builder')).toBe(false)
    expect(homeAppMatchesQuery(entry, 'studio l')).toBe(true)
    expect(homeAppMatchesQuery(entry, 'circle')).toBe(true)
    expect(homeAppMatchesQuery(entry, 'zzz')).toBe(false)
    expect(homeAppMatchesQuery(entry, '')).toBe(true)
  })

  it('filters by the entry catalog sources and derives options from the directory', () => {
    expect(homeAppMatchesSource(entry, 'all')).toBe(true)
    expect(homeAppMatchesSource(entry, 'Report Builder Circle')).toBe(true)
    expect(homeAppMatchesSource(entry, 'Other Circle')).toBe(false)

    const options = collectHomeAppSourceOptions([
      entry,
      directoryEntry('e2', 'Other', 1, {
        catalogSources: [
          { kind: 'enterprise_import', name: 'Report Builder Circle' },
          { kind: 'enterprise_import', name: 'Org A' },
        ],
      }),
      directoryEntry('e3', 'NoSource', 2, { catalogSources: undefined, sourceNames: undefined }),
    ])
    expect(options).toEqual([
      { key: 'Report Builder Circle', label: 'Report Builder Circle' },
      { key: 'Org A', label: 'Org A' },
    ])
  })
})

describe('per-context hidden apps (P70-HOME-01 本机隐藏恢复)', () => {
  it('hide/restore toggle one identity, scoped to the ProductSpace context', () => {
    hideHomeApp(contextKeyA, 'key-1')
    hideHomeApp(contextKeyA, 'key-2')
    expect(loadHomeHiddenApps(contextKeyA).has('key-1')).toBe(true)
    expect(loadHomeHiddenApps(contextKeyA).size).toBe(2)
    // Another context owns NO hidden record of context A.
    expect(loadHomeHiddenApps('v1:account-a|organization-b').size).toBe(0)

    restoreHomeApp(contextKeyA, 'key-1')
    expect(loadHomeHiddenApps(contextKeyA).has('key-1')).toBe(false)
    expect(loadHomeHiddenApps(contextKeyA).has('key-2')).toBe(true)
    // Restoring an absent identity is a no-op.
    restoreHomeApp(contextKeyA, 'key-1')
    expect(loadHomeHiddenApps(contextKeyA).size).toBe(1)
  })

  it('persists for the next session and fails OPEN (empty set) on a corrupted store', () => {
    hideHomeApp(contextKeyA, 'persisted-key')
    const raw = window.localStorage.getItem(`poo70.h3:home-hidden-apps:${contextKeyA}`)
    expect(raw).toBeTruthy()

    __resetHomeHiddenAppsForTests()
    expect(loadHomeHiddenApps(contextKeyA).has('persisted-key')).toBe(true)

    // Corrupted / malformed payloads never hide a row.
    window.localStorage.setItem(`poo70.h3:home-hidden-apps:${contextKeyA}`, '{not json')
    __resetHomeHiddenAppsForTests()
    expect(loadHomeHiddenApps(contextKeyA).size).toBe(0)
    window.localStorage.setItem(
      `poo70.h3:home-hidden-apps:${contextKeyA}`,
      JSON.stringify(['good', 42, null, '']),
    )
    __resetHomeHiddenAppsForTests()
    const mixed = loadHomeHiddenApps(contextKeyA)
    expect(mixed.size).toBe(1)
    expect(mixed.has('good')).toBe(true)
  })

  it('bounds the hidden set (FIFO eviction beyond the cap)', () => {
    for (let index = 0; index < 505; index++) {
      hideHomeApp(contextKeyA, `key-${index}`)
    }
    __resetHomeHiddenAppsForTests()
    const hidden = loadHomeHiddenApps(contextKeyA)
    expect(hidden.size).toBeLessThanOrEqual(500)
    expect(hidden.has('key-0')).toBe(false)
    expect(hidden.has('key-504')).toBe(true)
  })
})

describe('per-context usage records (P70-HOME-01 recent/frequent sort source)', () => {
  it('records one open action per call, bound to the ProductSpace context key', () => {
    recordHomeAppUsage(contextKeyA, 'key-1')
    recordHomeAppUsage(contextKeyA, 'key-1')
    recordHomeAppUsage(contextKeyA, 'key-2', 50)

    const records = loadHomeAppUsage(contextKeyA)
    expect(records.get('key-1')?.openCount).toBe(2)
    expect(records.get('key-1')!.lastUsedAt).toBeGreaterThanOrEqual(records.get('key-2')!.lastUsedAt)
    // Another context owns NO record of context A.
    expect(loadHomeAppUsage('v1:account-a|organization-b').size).toBe(0)
  })

  it('persists records for the next session and fails closed on a corrupted store', () => {
    recordHomeAppUsage(contextKeyA, 'persisted-key', 123)

    // The persisted payload is bound to the context key...
    const raw = window.localStorage.getItem(`poo70.h3:home-app-usage:${contextKeyA}`)
    expect(raw).toBeTruthy()
    // ...and a fresh cache re-reads it (drop the in-memory layer).
    __resetHomeAppUsageForTests()
    expect(loadHomeAppUsage(contextKeyA).get('persisted-key')).toEqual({
      lastUsedAt: 123,
      openCount: 1,
    })

    // A corrupted store never blocks the directory: records degrade to empty.
    window.localStorage.setItem(`poo70.h3:home-app-usage:${contextKeyA}`, '{not json')
    __resetHomeAppUsageForTests()
    expect(loadHomeAppUsage(contextKeyA).size).toBe(0)
    // Malformed record shapes are dropped, valid ones kept.
    window.localStorage.setItem(
      `poo70.h3:home-app-usage:${contextKeyA}`,
      JSON.stringify({ bad: { lastUsedAt: 'x' }, good: { lastUsedAt: 5, openCount: 2 } }),
    )
    __resetHomeAppUsageForTests()
    const mixed = loadHomeAppUsage(contextKeyA)
    expect(mixed.size).toBe(1)
    expect(mixed.get('good')).toEqual({ lastUsedAt: 5, openCount: 2 })
  })

  it('bounds the record set by evicting the oldest last-use first', () => {
    for (let index = 0; index < 205; index++) {
      recordHomeAppUsage(contextKeyA, `key-${index}`, 1_000 + index)
    }
    __resetHomeAppUsageForTests()
    const records = loadHomeAppUsage(contextKeyA)
    expect(records.size).toBeLessThanOrEqual(200)
    // The oldest record was evicted, the newest retained.
    expect(records.has('key-0')).toBe(false)
    expect(records.has('key-204')).toBe(true)
  })
})

// ─── Page-level contract ─────────────────────────────────────────────────────

function enterpriseCatalogWith(apps: CatalogApp[]): AppCatalogCacheEntry {
  return {
    accountId: 'account-a',
    organizationId: 'organization-a',
    appConfigVersion: 'v1',
    authorizationStatus: 'authorized',
    apps,
    syncedAt: 1,
  }
}

function hookWithCatalog(catalog: AppCatalogCacheEntry, overrides: Record<string, unknown> = {}) {
  return {
    ...signedOutCatalogHook(),
    productSpace: {
      accountId: catalog.accountId,
      activeProductSpaceId: catalog.organizationId,
      productSpaceContextKey: createProductSpaceContextKey(
        catalog.accountId,
        catalog.organizationId,
      ),
      contextVersion: 7,
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
    },
    scopeKeyForApp: () => 'unused',
    uiIdentityKeyForApp: (app: CatalogApp) => JSON.stringify([
      'product-space-ui',
      catalog.accountId,
      catalog.organizationId,
      app.catalogEntryId ?? app.id,
      app.artifactInstanceId ?? null,
    ]),
    ...overrides,
  }
}

describe('HomePage circles navigation (P70-HOME-02 × N1)', () => {
  // Renders INSIDE the provider tree: the probe observes the same published
  // route value the page navigates.
  let observedRoute: unknown = null
  function RouteProbe() {
    const clientPage = useOptionalClientPage()
    observedRoute = clientPage?.route ?? null
    return null
  }

  function personalHomeTree() {
    const providerValue = {
      accountId: 'account-a',
      activeProductSpaceId: 'organization-a',
      activeProductSpace: { id: 'organization-a', kind: 'personal', name: 'My Space' },
      productSpaces: [],
      allProductSpaces: [],
      personalProductSpaceId: 'organization-a',
      productSpaceContextKey: 'account-a|organization-a',
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
    const scope = {
      accountId: 'account-a',
      productSpaceId: 'organization-a',
      epoch: 1,
    }
    return createElement(
      ProductSpaceProvider,
      {
        value: providerValue as never,
        children: createElement(
          I18nextProvider,
          { i18n },
          createElement(
            MemberCatalogProvider,
            null,
            createElement(
              ClientPageProvider,
              {
                key: clientPageScopeKey(scope),
                scope,
                children: [
                  createElement(HomePage),
                  createElement(RouteProbe),
                ],
              },
            ),
          ),
        ),
      },
    )
  }

  it('the personal circles entry navigates the client-page route stack to {kind:"circles"}', async () => {
    const view = render(personalHomeTree())
    await waitFor(() => {
      expect(screen.getByTestId('home-circles-link')).toBeTruthy()
    })
    expect(observedRoute).toEqual(HOME_CLIENT_PAGE_ROUTE)
    fireEvent.click(screen.getByTestId('home-circles-link'))

    // The N1 published route flips to the typed circles route: a navigation
    // CANDIDATE — the real circles page mount belongs to POO-100.
    await waitFor(() => {
      expect(observedRoute).toEqual({ kind: 'circles' })
    })
    view.unmount()
  })

  it('usage recorded on the page survives a REAL remount and keeps sorting', async () => {
    stubCatalogEntries = [{
      kind: 'app' as const,
      catalogEntryId: 'usage-app',
      artifactInstanceId: 'artifact-usage-app',
      version: { versionId: 'version-usage', version: '1.0.0' },
      name: 'Usage App',
      description: '',
      availability: 'available' as const,
      deliveryMode: 'remote_url' as const,
      remoteUrl: 'https://usage.example.com',
      sources: [{ kind: 'enterprise_import' as const, name: 'Organization A' }],
    }]
    stubCatalogEntries.push({
      ...stubCatalogEntries[0] as Record<string, unknown>,
      catalogEntryId: 'alpha-app',
      artifactInstanceId: 'artifact-alpha-app',
      name: 'Alpha App',
      version: { versionId: 'version-alpha', version: '1.0.0' },
    })
    const providerValue = {
      accountId: 'account-a',
      activeProductSpaceId: 'organization-a',
      activeProductSpace: { id: 'organization-a', kind: 'enterprise', name: 'Organization A' },
      productSpaces: [],
      allProductSpaces: [],
      personalProductSpaceId: 'organization-a',
      productSpaceContextKey: 'account-a|organization-a',
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
    const tree = createElement(
      ProductSpaceProvider,
      {
        value: providerValue as never,
        children: createElement(
          I18nextProvider,
          { i18n },
          createElement(MemberCatalogProvider, null, createElement(HomePage)),
        ),
      },
    )
    const view = render(tree)
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('home-directory-app').map(card => card.querySelector('h3')?.textContent))
      .toEqual(['Alpha App', 'Usage App'])
    fireEvent.click(screen.getAllByTestId('home-directory-app')[1]!)
    await waitFor(() => {
      expect(storePublish).toHaveBeenCalled()
    })
    // Recompute the directory during this visit without moving the opened
    // card. The successful usage becomes visible only on the next visit.
    fireEvent.change(screen.getByTestId('home-directory-source'), { target: { value: 'Organization A' } })
    expect(screen.getAllByTestId('home-directory-app').map(card => card.querySelector('h3')?.textContent))
      .toEqual(['Alpha App', 'Usage App'])
    view.unmount()

    // REAL remount: the record was persisted, the cache re-reads it.
    __resetHomeAppUsageForTests()
    const records = loadHomeAppUsage(contextKeyA)
    expect(records.size).toBe(1)
    const [record] = [...records.values()]
    expect(record?.openCount).toBe(1)
    render(tree)
    await waitFor(() => {
      expect(screen.getAllByTestId('home-directory-app').map(card => card.querySelector('h3')?.textContent))
        .toEqual(['Usage App', 'Alpha App'])
    })
  })
})
