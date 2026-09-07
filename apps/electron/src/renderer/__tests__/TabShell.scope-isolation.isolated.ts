import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import {
  activeTabIdAtom,
  openAppTabAtom,
  openTabsAtom,
} from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB, type AppDefinition } from '../../shared/tab-browser-types'
import type { ProductSpaceContextValue } from '@/context/ProductSpaceContext'

// Register only when no window exists yet, and pin a macOS userAgent —
// shared-process pattern from TopBar.registry-poller.test.ts. This file runs
// in its OWN bun process (scripts/run-isolated-tests.sh).
if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()

// NOTE: the REAL WindowWidthGuard module (real useNarrowViewport +
// WindowWidthGuard) is intentionally NOT mocked — Review R34 requires the
// narrow/wide cases to execute their true boundary paths. The controllable
// matchMedia fixture below drives the real hook.

// Fail-fast electronAPI for the reduced TabShell tree: subscriptions and the
// localApps members the restored Home surface touches are enumerated; any
// other access is a fixture gap and must throw.
const localAppsStub: Record<string, unknown> = {
  getHostInfo: async () => ({ platform: 'darwin', arch: 'arm64' }),
  getRuntimeStatus: async (scope: { catalogAppId: string }) => ({
    appId: scope.catalogAppId,
    scope,
    status: 'not_installed',
  }),
  getRuntimeStatuses: async (request: { scopes: Array<{ catalogAppId: string }> }) =>
    request.scopes.map(scope => ({
      appId: scope.catalogAppId,
      scope,
      status: 'not_installed',
    })),
  getProductSpaceInstallStates: async (apps: Array<Record<string, unknown>>) =>
    apps.map(app => ({ app, state: 'not_installed' })),
  getProductSpaceWithdrawnInstallStates: async (apps: Array<Record<string, unknown>>) =>
    apps.map(app => ({ app, state: 'not_installed' })),
  getInstalledApps: async () => [],
  getLogs: async () => '',
  resolveRemoteUrl: async (scope: { catalogAppId: string }) => ({
    appId: scope.catalogAppId,
    scope,
    url: 'https://fixture.r34.example',
  }),
  setAvailableRelease: async () => ({ status: 'not_installed' }),
  install: async () => ({}),
  installProductSpaceBundle: async () => ({}),
  cancelInstall: async () => false,
  start: async () => ({}),
  stop: async () => ({ status: 'stopped' }),
  restart: async () => ({}),
  uninstall: async () => {},
  uninstallProductSpaceBundle: async () => {},
}
// Side-effect instrumentation (Review R34 issue 2): pre-hydration must not
// register the deep-link subscription or keydown listeners; hydration
// registers exactly once; keyed remount cleans up exactly once.
let deepLinkRegistrations = 0
let deepLinkUnsubscribed = 0
const deepLinkCallbacks: Array<unknown> = []

const localAppsProxy = new Proxy(localAppsStub, {
  get(_target, prop: string | symbol) {
    if (typeof prop === 'symbol') throw new Error(`localApps fixture: symbol access ${String(prop)}`)
    if (prop in localAppsStub) return localAppsStub[prop]
    throw new Error(`localApps fixture: unknown property "${prop}"`)
  },
})
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    onDeepLinkNavigate: (callback: unknown) => {
      deepLinkRegistrations += 1
      deepLinkCallbacks.push(callback)
      return () => {
        deepLinkUnsubscribed += 1
      }
    },
    productSpaceGetCatalog: async () => ({
      success: false as const,
      errorCode: 'request_failed',
      message: 'catalog intentionally unavailable in the R34 scope-isolation probe',
    }),
    getHomeQuickAccess: async () => [],
    setHomeQuickAccess: async (_contextKey: unknown, apps: unknown[]) => apps,
    productSpaceResolveLaunch: async () => { throw new Error('not reachable in the R34 probe') },
    localApps: localAppsProxy,
  },
})

// ─── Stale previous-scope state (the R33 defect precondition) ────────────────
const STALE_WEBAPP: AppDefinition = {
  id: 'web-old-scope',
  name: '旧空间 App',
  url: 'https://old-scope.example.com/app',
  type: 'webapp',
  createdAt: 1,
  order: 9,
}

function seedStalePreviousScope(): string {
  const store = getDefaultStore()
  // Production write path: TabShellContext.openApp → openAppTabAtom. This
  // simulates the PREVIOUS keyed scope having opened a web App and made it
  // the active route; the atoms are process-global, so a freshly mounted
  // keyed provider observes them until its hydration establishes the new
  // scope.
  store.set(openAppTabAtom, STALE_WEBAPP)
  const openTabs = store.get(openTabsAtom)
  const staleTab = openTabs.find(tab => tab.appId === STALE_WEBAPP.id)!
  store.set(activeTabIdAtom, staleTab.id)
  return staleTab.id
}

const contextValue = {
  // Shape mirrors the production ProductSpaceContextValue consumers read;
  // asserted to the production contract type below (branded IDs are compile-
  // time projections of the string fixtures).
  accountId: 'acct-r34-fixture',
  activeProductSpaceId: 'organization-a',
  activeProductSpace: { id: 'organization-a', kind: 'enterprise', name: 'Organization A' },
  productSpaces: [],
  allProductSpaces: [],
  personalProductSpaceId: 'organization-a',
  productSpaceContextKey: 'acct-r34-fixture|organization-a',
  contextVersion: 3,
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

let layoutSnapshots: string[] = []

/**
 * Records the FIRST committed layout of everything rendered inside it.
 * useLayoutEffect runs synchronously after the DOM commit but before paint,
 * so the snapshot is exactly what would have been displayed at the boundary
 * between a keyed scope switch and hydration completion.
 */
function LayoutSnapshot({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const host = document.querySelector('[data-testid="r33-snapshot-host"]')
    if (host) layoutSnapshots.push(host.innerHTML)
  })
  return createElement('div', { 'data-testid': 'r33-snapshot-host' }, children)
}

// Passive-effect probe rendered as a SIBLING AFTER TabShell: its passive
// effect runs after TabShell's passive effects but BEFORE the provider's
// hydration effect, so it observes exactly the pre-hydration side-effect
// window (Review R34 issue 2).
interface SideEffectObservation {
  marker: string | undefined
  deepLinkRegistrations: number
}
const sideEffectObservations: SideEffectObservation[] = []

function SideEffectProbe(): ReactNode {
  useEffect(() => {
    sideEffectObservations.push({
      marker: document.documentElement.dataset.activeTab,
      deepLinkRegistrations,
    })
  })
  return null
}

function WorkbenchProbe(): ReactNode {
  return createElement('div', { 'data-testid': 'polo-app-root' })
}

function buildShellTree(providerKey: string): ReactNode {
  const { ProductSpaceProvider } =
    require('@/context/ProductSpaceContext') as typeof import('@/context/ProductSpaceContext')
  const { TabShellProvider } =
    require('../context/TabShellContext') as typeof import('../context/TabShellContext')
  const { TabShell } =
    require('../components/tab-browser/TabShell') as typeof import('../components/tab-browser/TabShell')
  const inner = createElement(
    LayoutSnapshot,
    null,
    createElement(TabShell, { renderPolo: WorkbenchProbe }),
    createElement(SideEffectProbe),
  )
  const shell = createElement(
    TabShellProvider,
    {
      key: providerKey,
      workspaceId: 'ws-r34',
      productSpaceScope: {
        accountId: 'acct-r34-fixture',
        productSpaceId: 'organization-a',
      },
      children: inner,
    },
  )
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ProductSpaceProvider, {
      value: contextValue as unknown as ProductSpaceContextValue,
      children: shell,
    }),
  )
}

let narrowViewportActive = false

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return narrowViewportActive && query.includes('max-width: 640')
    },
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  narrowViewportActive = false
  installMatchMedia()
  layoutSnapshots = []
  deepLinkRegistrations = 0
  deepLinkUnsubscribed = 0
  deepLinkCallbacks.length = 0
  sideEffectObservations.length = 0
})

afterEach(() => {
  const { cleanup } = require('@testing-library/react') as { cleanup: () => void }
  cleanup()
  const store = getDefaultStore()
  store.set(openTabsAtom, [POLO_TAB])
  store.set(activeTabIdAtom, HOME_TAB_ID)
  layoutSnapshots = []
})

const {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')

const { TabShell } =
  await import('../components/tab-browser/TabShell') as typeof import('../components/tab-browser/TabShell')

describe('TabShell keyed-scope pre-hydration isolation (Review R33 security)', () => {
  it('wide: first committed layout after a keyed scope switch shows NO stale tab title/URL/webview/active route, then the shell restores', async () => {
    seedStalePreviousScope()

    render(buildShellTree('scope-new'))

    // FIRST committed layout: fail-closed scope-neutral boundary — the stale
    // previous-scope surfaces are never mounted or displayed on any width.
    expect(layoutSnapshots).toHaveLength(1)
    expect(layoutSnapshots[0]!.includes('旧空间 App')).toBe(false)
    expect(layoutSnapshots[0]!.includes('old-scope.example.com')).toBe(false)
    expect(layoutSnapshots[0]!.includes('<webview')).toBe(false)
    expect(layoutSnapshots[0]!.includes('polo-app-root')).toBe(false)
    expect(layoutSnapshots[0]!.includes('shell-scope-loading')).toBe(true)

    // Hydration completes: the normal shell restores for the NEW scope
    // (TabBar/content back, Home route active) and the stale previous-scope
    // web App is gone from the tab strip and the DOM.
    await waitFor(() => {
      if (!screen.getByTestId('app-topbar')) throw new Error('shell not restored')
    })
    expect(screen.queryByText('旧空间 App')).toBeNull()
    expect(document.querySelector('webview')).toBeNull()
  }, 30_000)

  it('narrow: first committed layout after a keyed scope switch shows NO stale surfaces, then the shell restores', async () => {
    narrowViewportActive = true
    installMatchMedia()
    seedStalePreviousScope()

    render(buildShellTree('scope-new-narrow'))

    expect(layoutSnapshots).toHaveLength(1)
    expect(layoutSnapshots[0]!.includes('旧空间 App')).toBe(false)
    expect(layoutSnapshots[0]!.includes('old-scope.example.com')).toBe(false)
    expect(layoutSnapshots[0]!.includes('<webview')).toBe(false)
    expect(layoutSnapshots[0]!.includes('polo-app-root')).toBe(false)
    expect(layoutSnapshots[0]!.includes('shell-scope-loading')).toBe(true)

    await waitFor(() => {
      if (!screen.getByTestId('app-topbar')) throw new Error('shell not restored')
    })
    // Hydrated narrow Home restored (real narrow boundary path).
    expect(screen.getByTestId('home-quick-access-section')).toBeTruthy()
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()

    // Hydrated narrow non-Home route: activating the Polo workbench tab via
    // the production TabBar click fails closed to the REAL WindowWidthGuard
    // (the guarded route's production escape is the window resize).
    fireEvent.click(screen.getByLabelText('Close Polo 助手').closest('div')!)
    await waitFor(() => {
      if (!screen.getByTestId('window-width-guard')) throw new Error('guard missing for narrow non-Home route')
    })
    expect(screen.getByTestId('window-width-guard')).toBeTruthy()
    expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
  }, 30_000)

  it('pre-hydration side effects stay scope-neutral: no stale route marker, no listener registrations until ready; keyed remount cleans up exactly once', async () => {
    seedStalePreviousScope()

    const { rerender } = render(buildShellTree('scope-a'))

    // Hydration completes (synchronously for a ProductSpace-keyed window):
    // marker publishes the CURRENT route, listeners register (bootstrap may
    // re-subscribe on dependency churn — the LIVE count must be exactly one
    // per channel, and none may exist before ready).
    await waitFor(() => {
      if (document.documentElement.dataset.activeTab !== 'home') throw new Error('marker not published')
    })
    expect(deepLinkRegistrations).toBeGreaterThanOrEqual(1)
    expect(deepLinkRegistrations - deepLinkUnsubscribed).toBe(1)

    // Keyed scope switch: the provider remounts under a NEW key — the old
    // subscription/listener cleanup runs and the new scope registers; the
    // live count returns to exactly one after B's hydration.
    act(() => {
      rerender(buildShellTree('scope-b'))
    })
    await waitFor(() => {
      if (document.documentElement.dataset.activeTab !== 'home') throw new Error('marker not published for scope-b')
    })
    expect(deepLinkRegistrations - deepLinkUnsubscribed).toBe(1)


    // Unmount: cleanup accounting balances exactly — every registration was
    // cleaned up exactly once.
    act(() => {
      rerender(null as unknown as ReactNode)
    })
    expect(deepLinkUnsubscribed).toBe(deepLinkRegistrations)

    // PRE-HYDRATION observations (recorded by the passive-effect probe that
    // runs after TabShell's own passive effects but before the provider's
    // hydration): the very first observation must be scope-NEUTRAL — no
    // stale route marker published, no listener registered.
    expect(sideEffectObservations.length).toBeGreaterThan(0)
    expect(sideEffectObservations[0]).toEqual({
      marker: undefined,
      deepLinkRegistrations: 0,
    })
    // No observation may ever show the STALE route marker ('polo' active
    // while pre-hydration). Post-switch pre-hydration observations
    // legitimately show monotonically growing counters (the global atoms
    // accumulate across keyed remounts); only the very first observation
    // pins the full neutral state.
    for (const observation of sideEffectObservations) {
      if (observation.marker === 'polo') {
        throw new Error('stale route marker published pre-hydration')
      }
    }
  }, 30_000)
})

// TabShell import is used inside buildShellTree via require for the keyed
// remount; keep a direct binding reference for the module graph.
void TabShell
