import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
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

// Minimal safe stub for the WindowWidthGuard module: the pre-hydration
// boundary under test must render the scope-neutral shell, and no scenario
// here drives a width that would need the real guard.
mock.module('@/components/product-space/WindowWidthGuard', () => ({
  useNarrowViewport: () => false,
  WindowWidthGuard: ({ children }: { children?: unknown }) => children ?? null,
}))

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
    onDeepLinkNavigate: (_callback: unknown) => () => {},
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
    expect(screen.queryByText('旧空间 App')).toBeNull()
    expect(document.querySelector('webview')).toBeNull()
  }, 30_000)
})

// TabShell import is used inside buildShellTree via require for the keyed
// remount; keep a direct binding reference for the module graph.
void TabShell
