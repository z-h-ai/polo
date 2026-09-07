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
// key so scope A's AND scope B's pre-hydration boundaries are asserted
// independently (Review R35).
interface SideEffectObservation {
  providerKey: string
  marker: string | undefined
  deepLinkLive: number
  keydownLive: number
}
const sideEffectObservations: SideEffectObservation[] = []

function SideEffectProbe({ providerKey }: { providerKey: string }): ReactNode {
  useEffect(() => {
    sideEffectObservations.push({
      providerKey,
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

function buildShellTree(providerKey: string): ReactNode {
  const { ProductSpaceProvider } =
    require('@/context/ProductSpaceContext') as typeof import('@/context/ProductSpaceContext')
  const { TabShellProvider } =
    require('../context/TabShellContext') as typeof import('../context/TabShellContext')
  const { TabShell } =
    require('../components/tab-browser/TabShell') as typeof import('../components/tab-browser/TabShell')
  const inner = createElement(LayoutSnapshot, {
    providerKey,
    children: [
      createElement(TabShell, { key: 'tab-shell', renderPolo: WorkbenchProbe }),
      createElement(SideEffectProbe, { key: 'side-effect-probe', providerKey }),
    ],
  })
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

  it('pre-hydration side effects stay scope-neutral for scope A AND scope B: no stale route marker, no live deep-link/keydown listener until ready; keyed remount and final unmount clean up exactly', async () => {
    seedStalePreviousScope()

    const { rerender } = render(buildShellTree('scope-a'))

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

    // Scope-A PRE-HYDRATION effect boundary: EVERY marker-neutral observation
    // of scope A — recorded after TabShell's own passive effects but before
    // the provider's hydration effect — shows zero live listeners on both
    // channels, and the very first observation of the tree is scope A's
    // fully neutral boundary.
    const scopeAPreHydration = sideEffectObservations.filter(o => o.providerKey === 'scope-a' && o.marker === undefined)
    expect(scopeAPreHydration.length).toBeGreaterThan(0)
    for (const observation of scopeAPreHydration) {
      expect(observation.deepLinkLive).toBe(0)
      expect(observation.keydownLive).toBe(0)
    }
    expect(sideEffectObservations[0]).toEqual({
      providerKey: 'scope-a',
      marker: undefined,
      deepLinkLive: 0,
      keydownLive: 0,
    })

    // Keyed scope switch A→B: A's cleanup runs, B mounts pre-hydrated.
    act(() => {
      rerender(buildShellTree('scope-b'))
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
    // a premature B-remount registration cannot escape this).
    const scopeBPreHydration = sideEffectObservations.filter(o => o.providerKey === 'scope-b' && o.marker === undefined)
    expect(scopeBPreHydration.length).toBeGreaterThan(0)
    for (const observation of scopeBPreHydration) {
      expect(observation.deepLinkLive).toBe(0)
      expect(observation.keydownLive).toBe(0)
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
})

// TabShell import is used inside buildShellTree via require for the keyed
// remount; keep a direct binding reference for the module graph.
void TabShell
