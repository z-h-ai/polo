import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { StrictMode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import {
  activeTabIdAtom,
  openAppTabAtom,
  openTabsAtom,
} from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB, type AppDefinition } from '../../shared/tab-browser-types'
import { useTabShell } from '@/context/TabShellContext'
import type { ProductSpaceContextValue } from '@/context/ProductSpaceContext'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'

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
// Side-effect instrumentation (Review R34 issue 2, completed per Review R35):
// pre-hydration must not register the deep-link subscription or keydown
// listeners; hydration registers exactly once; keyed remount and final
// unmount clean up exactly once. The reduced probe tree has exactly ONE
// producer of each side effect — TabShell — so the production deep-link API
// subscription and every window add/removeEventListener('keydown') are both
// counted with LIVE state (a stale closure or premature registration is
// observable per commit, not just in aggregate totals).
let deepLinkRegistrations = 0
let deepLinkUnsubscribed = 0
let keydownRegistrations = 0
let keydownUnsubscribed = 0
const deepLinkCallbacks: Array<unknown> = []
const liveKeydownListeners = new Set<EventListenerOrEventListenerObject>()

// Recognizable production keydown instrumentation: this reduced tree has
// exactly one window keydown registrant (TabShell's shortcut handler), so
// counting every window keydown add/remove and tracking the live listener
// set identifies TabShell's own listener without depending on its private
// closure internals.
const nativeAddEventListener = window.addEventListener.bind(window)
const nativeRemoveEventListener = window.removeEventListener.bind(window)
window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  if (type === 'keydown') {
    keydownRegistrations += 1
    liveKeydownListeners.add(listener)
  }
  return nativeAddEventListener(type, listener, options)
}) as typeof window.addEventListener
window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
  if (type === 'keydown' && liveKeydownListeners.delete(listener)) {
    keydownUnsubscribed += 1
  }
  return nativeRemoveEventListener(type, listener, options)
}) as typeof window.removeEventListener

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

// Distinct REAL provider scopes for the A→B keyed remount.
const SCOPE_A = { key: 'scope-a', accountId: 'acct-r37-fixture', productSpaceId: 'organization-a' }
const SCOPE_B = { key: 'scope-b', accountId: 'acct-r37-fixture', productSpaceId: 'organization-b' }
type ProviderScope = typeof SCOPE_A

const contextValueForScope = (scope: ProviderScope) => ({
  // Shape mirrors the production ProductSpaceContextValue consumers read;
  // asserted to the production contract type below (branded IDs are compile-
  // time projections of the string fixtures). A and B use DISTINCT real
  // ProductSpace scopes — different productSpaceId AND different
  // account-scoped context key in the production format — so the keyed
  // remount is bound to an actual scope change, not just a React key.
  accountId: scope.accountId,
  activeProductSpaceId: scope.productSpaceId,
  activeProductSpace: {
    id: scope.productSpaceId,
    kind: 'enterprise',
    name: scope.productSpaceId === SCOPE_A.productSpaceId ? 'Organization A' : 'Organization B',
  },
  productSpaces: [],
  allProductSpaces: [],
  personalProductSpaceId: SCOPE_A.productSpaceId,
  productSpaceContextKey: createProductSpaceContextKey(scope.accountId, scope.productSpaceId),
  contextVersion: scope.productSpaceId === SCOPE_A.productSpaceId ? 3 : 4,
  pendingSwitch: null,
  onSelectProductSpace: () => {},
  onRefreshProductSpaces: () => {},
  onConfirmStopAndSwitch: () => {},
  onRetryFailedStops: () => {},
  onRetryTargetLoad: () => {},
  onCancelSwitch: () => {},
  onDismissTargetAccessLost: () => {},
  onStopSwitchExecution: () => {},
})

let layoutSnapshots: string[] = []

// Per-provider-key record of every committed layout of the keyed shell, so
// scope A's and scope B's PRE-HYDRATION first committed layouts can each be
// asserted (Review R35: the scope-B remount boundary must be proven, not
// only the initial scope).
interface LayoutObservation {
  providerKey: string
  html: string
}
const layoutObservations: LayoutObservation[] = []

/**
 * Records every committed layout of everything rendered inside it, tagged by
 * the enclosing provider key. useLayoutEffect runs synchronously after the
 * DOM commit but before paint, so the snapshot is exactly what would have
 * been displayed at the boundary between a keyed scope switch and hydration
 * completion.
 */
function LayoutSnapshot({ providerKey, children }: { providerKey: string, children: ReactNode }) {
  useLayoutEffect(() => {
    const host = document.querySelector('[data-testid="r33-snapshot-host"]')
    if (host) {
      layoutSnapshots.push(host.innerHTML)
      layoutObservations.push({ providerKey, html: host.innerHTML })
    }
  })
  return createElement('div', { 'data-testid': 'r33-snapshot-host' }, children)
}

// Passive-effect probe rendered as a SIBLING AFTER TabShell: its passive
// effect runs after TabShell's passive effects but BEFORE the provider's
// hydration effect, so it observes exactly the pre-hydration side-effect
// window (Review R34 issue 2). Each observation is tagged with the provider
// key AND the provider's own hydration phase read from the REAL tab-shell
// context (useTabShell().isReady) — Review R37 requires the readiness field
// to be an independent record, so pre-hydration records are selected by
// `isReady === false`, never by the marker they are asserted against.
interface SideEffectObservation {
  providerKey: string
  isReady: boolean
  marker: string | undefined
  deepLinkLive: number
  keydownLive: number
}
const sideEffectObservations: SideEffectObservation[] = []

function SideEffectProbe({ providerKey }: { providerKey: string }): ReactNode {
  const { isReady } = useTabShell()
  useEffect(() => {
    sideEffectObservations.push({
      providerKey,
      isReady,
      marker: document.documentElement.dataset.activeTab,
      deepLinkLive: deepLinkRegistrations - deepLinkUnsubscribed,
      keydownLive: liveKeydownListeners.size,
    })
  })
  return null
}

function WorkbenchProbe(): ReactNode {
  return createElement('div', { 'data-testid': 'polo-app-root' })
}

function buildShellTree(scope: ProviderScope): ReactNode {
  const { ProductSpaceProvider } =
    require('@/context/ProductSpaceContext') as typeof import('@/context/ProductSpaceContext')
  const { TabShellProvider } =
    require('../context/TabShellContext') as typeof import('../context/TabShellContext')
  const inner = createElement(LayoutSnapshot, {
    providerKey: scope.key,
    children: [
      createElement(TabShell, { key: 'tab-shell', renderPolo: WorkbenchProbe }),
      createElement(SideEffectProbe, { key: 'side-effect-probe', providerKey: scope.key }),
    ],
  })
  const shell = createElement(
    TabShellProvider,
    {
      key: scope.key,
      workspaceId: 'ws-r34',
      // Distinct REAL scope: the storage partition + hydration scope differ
      // between A and B, so the keyed remount is bound to an actual
      // ProductSpace scope change.
      productSpaceScope: {
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
      },
      children: inner,
    },
  )
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ProductSpaceProvider, {
      value: contextValueForScope(scope) as unknown as ProductSpaceContextValue,
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

// The WindowWidthGuard module is NOT mocked (Review R34/R35 requirement):
// the real useNarrowViewport hook and the real WindowWidthGuard component
// execute their true boundary paths, driven by the controllable matchMedia
// fixture above (dynamic `matches` getter on `narrowViewportActive`).

beforeEach(() => {
  narrowViewportActive = false
  installMatchMedia()
  layoutSnapshots = []
  layoutObservations.length = 0
  deepLinkRegistrations = 0
  deepLinkUnsubscribed = 0
  keydownRegistrations = 0
  keydownUnsubscribed = 0
  liveKeydownListeners.clear()
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
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')

const { TabShell } =
  await import('../components/tab-browser/TabShell') as typeof import('../components/tab-browser/TabShell')

describe('TabShell keyed-scope pre-hydration isolation (Review R33 security)', () => {
  it('wide: first committed layout after a keyed scope switch shows NO stale tab title/URL/webview/active route, then the shell restores', async () => {
    seedStalePreviousScope()

    render(buildShellTree({ key: 'scope-new', accountId: 'acct-r37-fixture', productSpaceId: 'organization-a' }))

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

  it('narrow: first committed layout shows the scope-neutral boundary, then hydration fails closed to the frozen guard for the Home route too', async () => {
    narrowViewportActive = true
    installMatchMedia()
    seedStalePreviousScope()

    render(buildShellTree({ key: 'scope-new-narrow', accountId: 'acct-r37-fixture', productSpaceId: 'organization-a' }))

    // PRE-HYDRATION first committed layout is unchanged (Review R33/R34
    // boundary preserved): the scope-neutral shell — no stale surfaces —
    // regardless of viewport width.
    expect(layoutSnapshots).toHaveLength(1)
    expect(layoutSnapshots[0]!.includes('旧空间 App')).toBe(false)
    expect(layoutSnapshots[0]!.includes('old-scope.example.com')).toBe(false)
    expect(layoutSnapshots[0]!.includes('<webview')).toBe(false)
    expect(layoutSnapshots[0]!.includes('polo-app-root')).toBe(false)
    expect(layoutSnapshots[0]!.includes('shell-scope-loading')).toBe(true)

    // After hydration the frozen narrow-window boundary covers EVERY route
    // (Review R38 restores the POO-41 contract): the REAL WindowWidthGuard
    // replaces the shell — the Home launcher, TabBar, workbench and webview
    // layers stay unmounted at ≤640px.
    await waitFor(() => {
      if (!screen.getByTestId('window-width-guard')) throw new Error('frozen guard missing after hydration at narrow width')
    })
    expect(screen.getByTestId('window-width-guard')).toBeTruthy()
    expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
    expect(screen.queryByTestId('home-quick-entry-polo')).toBeNull()
    expect(screen.queryByTestId('polo-app-root')).toBeNull()
    expect(screen.queryByTestId('app-topbar')).toBeNull()
    expect(document.querySelector('webview')).toBeNull()
  }, 30_000)

  it('pre-hydration side effects stay scope-neutral for scope A AND scope B: no stale route marker, no live deep-link/keydown listener until ready; keyed remount and final unmount clean up exactly', async () => {
    seedStalePreviousScope()

    const { rerender } = render(buildShellTree(SCOPE_A))

    // Scope-A first committed LAYOUT boundary (provider-key tagged): the
    // fail-closed scope-neutral shell — the stale previous-scope surfaces are
    // never mounted or displayed.
    const scopeALayouts = layoutObservations.filter(l => l.providerKey === 'scope-a')
    expect(scopeALayouts.length).toBeGreaterThan(0)
    expect(scopeALayouts[0]!.html.includes('shell-scope-loading')).toBe(true)
    expect(scopeALayouts[0]!.html.includes('旧空间 App')).toBe(false)
    expect(scopeALayouts[0]!.html.includes('old-scope.example.com')).toBe(false)
    expect(scopeALayouts[0]!.html.includes('<webview')).toBe(false)
    expect(scopeALayouts[0]!.html.includes('polo-app-root')).toBe(false)

    // Hydration: marker publishes the CURRENT route and the CURRENT scope
    // holds EXACTLY ONE live deep-link subscription and ONE live keydown
    // listener (registration may churn during bootstrap — liveness is what
    // must be exactly one, none may exist before ready).
    await waitFor(() => {
      if (document.documentElement.dataset.activeTab !== 'home') throw new Error('marker not published')
    })
    expect(deepLinkRegistrations).toBeGreaterThanOrEqual(1)
    expect(deepLinkRegistrations - deepLinkUnsubscribed).toBe(1)
    expect(keydownRegistrations).toBeGreaterThanOrEqual(1)
    expect(liveKeydownListeners.size).toBe(1)

    // Scope-A PRE-HYDRATION effect boundary: EVERY isReady=false observation
    // of scope A — recorded after TabShell's own passive effects but before
    // the provider's hydration effect — shows zero live listeners on both
    // channels and no route marker. The selection predicate is the recorded
    // readiness field, NEVER the marker, so a non-neutral pre-hydration
    // record fails here instead of being filtered away.
    const scopeAPreHydration = sideEffectObservations.filter(o => o.providerKey === SCOPE_A.key && o.isReady === false)
    expect(scopeAPreHydration.length).toBeGreaterThan(0)
    for (const observation of scopeAPreHydration) {
      expect(observation.marker).toBeUndefined()
      expect(observation.deepLinkLive).toBe(0)
      expect(observation.keydownLive).toBe(0)
    }
    expect(sideEffectObservations[0]).toEqual({
      providerKey: SCOPE_A.key,
      isReady: false,
      marker: undefined,
      deepLinkLive: 0,
      keydownLive: 0,
    })

    // Keyed scope switch A→B: A's cleanup runs, B mounts pre-hydrated.
    act(() => {
      rerender(buildShellTree(SCOPE_B))
    })

    // Scope-B first committed LAYOUT boundary: the SAME scope-neutral shell —
    // no stale previous-scope surfaces, nothing inherited from scope A.
    const scopeBLayouts = layoutObservations.filter(l => l.providerKey === 'scope-b')
    expect(scopeBLayouts.length).toBeGreaterThan(0)
    expect(scopeBLayouts[0]!.html.includes('shell-scope-loading')).toBe(true)
    expect(scopeBLayouts[0]!.html.includes('旧空间 App')).toBe(false)
    expect(scopeBLayouts[0]!.html.includes('old-scope.example.com')).toBe(false)
    expect(scopeBLayouts[0]!.html.includes('<webview')).toBe(false)
    expect(scopeBLayouts[0]!.html.includes('polo-app-root')).toBe(false)

    // Scope-B PRE-HYDRATION effect boundary: scope A's listeners were already
    // cleaned up and scope B has not registered anything — zero live on both
    // channels, no stale route marker (a transient stale keydown closure or
    // a premature B-remount registration cannot escape this). Selection is
    // by the recorded readiness field, never by the marker.
    const scopeBPreHydration = sideEffectObservations.filter(o => o.providerKey === SCOPE_B.key && o.isReady === false)
    expect(scopeBPreHydration.length).toBeGreaterThan(0)
    for (const observation of scopeBPreHydration) {
      expect(observation.marker).toBeUndefined()
      expect(observation.deepLinkLive).toBe(0)
      expect(observation.keydownLive).toBe(0)
    }
    // Both scopes transitioned through the hydration phase boundary in the
    // recorded evidence.
    for (const key of [SCOPE_A.key, SCOPE_B.key]) {
      expect(sideEffectObservations.some(o => o.providerKey === key && o.isReady === true)).toBe(true)
    }
    // No observation may ever publish the STALE route marker ('polo' active
    // while pre-hydration is the R33 regression signature).
    for (const observation of sideEffectObservations) {
      expect(observation.marker).not.toBe('polo')
    }

    // Scope-B hydrated: again EXACTLY ONE live listener per channel.
    await waitFor(() => {
      if (document.documentElement.dataset.activeTab !== 'home') throw new Error('marker not published for scope-b')
    })
    expect(deepLinkRegistrations - deepLinkUnsubscribed).toBe(1)
    expect(liveKeydownListeners.size).toBe(1)

    // Final unmount: cleanup accounting balances EXACTLY — every deep-link
    // registration and every keydown registration was cleaned up exactly
    // once, nothing stays live, and the route marker returns to neutral.
    // (No hydrated-marker wait after unmount — the shell is gone.)
    act(() => {
      rerender(null as unknown as ReactNode)
    })
    expect(deepLinkUnsubscribed).toBe(deepLinkRegistrations)
    expect(keydownUnsubscribed).toBe(keydownRegistrations)
    expect(liveKeydownListeners.size).toBe(0)
    expect(document.documentElement.dataset.activeTab).toBeUndefined()
  }, 30_000)

  it('StrictMode: pre-hydration neutrality, exactly one live listener per ready scope, and exact cleanup across keyed remount and unmount', async () => {
    seedStalePreviousScope()

    const { rerender } = render(
      createElement(StrictMode, null, buildShellTree(SCOPE_A)),
    )

    // Scope-A ready under StrictMode's double effect invocation: the LIVE
    // counts are still exactly one per channel.
    await waitFor(() => {
      if (document.documentElement.dataset.activeTab !== 'home') throw new Error('marker not published')
    })
    expect(deepLinkRegistrations - deepLinkUnsubscribed).toBe(1)
    expect(liveKeydownListeners.size).toBe(1)

    // Every StrictMode pre-hydration record of scope A stays fully neutral.
    // StrictMode double-invokes the mount-time effects, so the neutral
    // pre-hydration window is recorded AT LEAST TWICE — the doubled records
    // prove the StrictMode variant is actually active (not a silent
    // duplicate of the non-StrictMode test).
    const scopeAPreHydration = sideEffectObservations.filter(o => o.providerKey === SCOPE_A.key && o.isReady === false)
    expect(scopeAPreHydration.length).toBeGreaterThanOrEqual(2)
    for (const observation of scopeAPreHydration) {
      expect(observation.marker).toBeUndefined()
      expect(observation.deepLinkLive).toBe(0)
      expect(observation.keydownLive).toBe(0)
    }

    // Keyed remount A→B under StrictMode.
    act(() => {
      rerender(createElement(StrictMode, null, buildShellTree(SCOPE_B)))
    })
    await waitFor(() => {
      if (document.documentElement.dataset.activeTab !== 'home') throw new Error('marker not published for scope-b')
    })
    expect(deepLinkRegistrations - deepLinkUnsubscribed).toBe(1)
    expect(liveKeydownListeners.size).toBe(1)

    const scopeBPreHydration = sideEffectObservations.filter(o => o.providerKey === SCOPE_B.key && o.isReady === false)
    expect(scopeBPreHydration.length).toBeGreaterThan(0)
    for (const observation of scopeBPreHydration) {
      expect(observation.marker).toBeUndefined()
      expect(observation.deepLinkLive).toBe(0)
      expect(observation.keydownLive).toBe(0)
    }

    // Final unmount: StrictMode's simulated remounts are included in the
    // balance — every registration was cleaned up exactly once.
    act(() => {
      rerender(null as unknown as ReactNode)
    })
    expect(deepLinkUnsubscribed).toBe(deepLinkRegistrations)
    expect(keydownUnsubscribed).toBe(keydownRegistrations)
    expect(liveKeydownListeners.size).toBe(0)
    expect(document.documentElement.dataset.activeTab).toBeUndefined()
  }, 30_000)
})
