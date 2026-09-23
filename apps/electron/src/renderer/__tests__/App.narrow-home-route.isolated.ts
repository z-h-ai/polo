import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom, openAppTabAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB_ID } from '../../shared/tab-browser-types'

// Register only when no window exists yet, and pin a macOS userAgent —
// shared-process pattern from TopBar.registry-poller.test.ts: happy-dom
// defaults to a Windows UA, which would flip isWindows/PATH_SEP in
// @/lib/platform. This file runs in its OWN bun process (scripts/
// run-isolated-tests.sh), so no other test file shares these globals.
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

// ─── Runner-environment polyfills (bun runner lacks these browser globals) ──
class DOMMatrixStub {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
  multiply = () => this
  static fromMatrix = () => new DOMMatrixStub()
}
;(globalThis as unknown as Record<string, unknown>).DOMMatrix = DOMMatrixStub
;(globalThis as unknown as Record<string, unknown>).Path2D = class Path2DStub {
  moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {}
  arcTo() {} rect() {} ellipse() {} closePath() {} addPath() {}
}
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))

// Vite-hosted theme singleton (`import.meta.glob` — unavailable under the
// plain bun runner). App only consumes the resolved light theme.
const themeContextStub = {
  mode: 'light',
  colorTheme: 'default',
  font: 'system',
  setMode: () => {},
  setColorTheme: () => {},
  setFont: () => {},
  activeWorkspaceId: null,
  workspaceColorTheme: null,
  setWorkspaceColorTheme: () => {},
  resolvedMode: 'light',
  systemPreference: 'light',
  effectiveColorTheme: 'default',
  previewColorTheme: null,
  setPreviewColorTheme: () => {},
  effectiveColorThemeSource: 'app',
  themeResolvedFrom: 'fallback',
  themeLoadError: null,
  presetTheme: null,
  resolvedTheme: {},
  isDark: false,
  isScenic: false,
  shikiTheme: 'github-light',
  shikiConfig: {},
  loaded: true,
}
mock.module('@/context/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children?: unknown }) => children ?? null,
  useTheme: () => themeContextStub,
}))
mock.module('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: {},
    defaultTheme: {},
    shikiTheme: 'github-light',
    shikiConfig: {},
    presetTheme: null,
    isDark: false,
    isScenic: false,
  }),
}))

// ─── Logged-in ProductSpace bootstrap state (authoritative boundary value) ──
// ONLY the ProductSpace bootstrap STATE hook is replaced so
// `MaybeProductSpaceProvider` receives a complete authoritative context.
// HomePage, TabShell, TabBar, the active-tab atom, `useNarrowViewport`, and
// App's guard decision all stay production-real.
const FIXTURE_ACCOUNT_ID = 'acct-r33-fixture'
const FIXTURE_SPACE_ID = 'organization-a'
const productSpaceState = {
  accountId: FIXTURE_ACCOUNT_ID,
  flowState: 'ready',
  productSpaces: [{
    id: FIXTURE_SPACE_ID,
    kind: 'personal',
    name: '我的空间',
    role: 'member',
    accessMode: 'active',
  }],
  allProductSpaces: [{
    id: FIXTURE_SPACE_ID,
    kind: 'personal',
    name: '我的空间',
    role: 'member',
    accessMode: 'active',
  }],
  personalProductSpaceId: FIXTURE_SPACE_ID,
  activeProductSpace: {
    id: FIXTURE_SPACE_ID,
    kind: 'personal',
    name: '我的空间',
  },
  activeProductSpaceId: FIXTURE_SPACE_ID,
  productSpaceContextKey: `${FIXTURE_ACCOUNT_ID}|${FIXTURE_SPACE_ID}`,
  contextVersion: 1,
  pendingSwitch: null,
  unavailableSpaceIds: new Set<string>(),
  error: null,
  bootstrap: async () => 'ready' as const,
  refreshProductSpaces: async () => {},
  retryBootstrap: async () => 'ready' as const,
  requestSwitch: async () => {},
  confirmStopAndSwitch: async () => {},
  retryFailedStops: async () => {},
  retryTargetLoad: async () => {},
  cancelSwitch: async () => {},
  stopSwitchExecution: async () => {},
  dismissTargetAccessLost: () => {},
  clearAccount: () => {},
  rollbackToOrigin: async () => false,
  enterContractBlocked: () => {},
}
mock.module('@/hooks/useProductSpaceContext', () => ({
  useProductSpaceContextState: () => productSpaceState,
}))

// ─── Fail-fast electronAPI fixture ───────────────────────────────────────────
// Every property the real App graph touches at import/bootstrap/render time
// under the narrow-Home route is enumerated with a deterministic result. ANY
// unknown property access throws immediately (no catch-all undefined), so a
// production regression surfaces as a loud fixture failure.
const FIXTURE_USER = {
  id: FIXTURE_ACCOUNT_ID,
  username: 'r33-fixture',
  displayName: 'R33 Fixture',
}

const UNSUBSCRIBE = () => {}

const electronApiExplicit: Record<string, unknown> = {
  // Startup / lifecycle
  isDebugMode: async () => false,
  getWindowWorkspace: async () => 'ws-r33-fixture',
  getSetupNeeds: async () => ({
    isFullyConfigured: true,
    needsAdminLogin: false,
    needsProvider: false,
    hasProvider: true,
    missingRequirements: [],
  }),
  adminGetStatus: async () => ({
    adminUrl: 'https://fixture.r33.example',
    loggedIn: true,
    userId: FIXTURE_USER.id,
    username: FIXTURE_USER.username,
    displayName: FIXTURE_USER.displayName,
  }),
  adminValidate: async () => ({ loggedIn: true, user: FIXTURE_USER }),
  adminSyncConnections: async () => ({ success: true }),
  // Runtime info used at import time by workbench modules.
  getRuntimeEnvironment: () => 'electron',
  getSources: async () => [],
  getSkills: async () => [],
  getUnreadSummary: async () => ({ totalUnreadSessions: 0, byWorkspace: {}, hasUnreadByWorkspace: {} }),
  // Theme
  getTheme: async () => 'light',
  // Workspaces
  getWorkspaces: async () => [],
  // Home surface: real useAppCatalog mounts; the fail-closed catalog response
  // keeps the launcher section (error tile beside the fixed Polo card)
  // without fixture coupling — the narrow-Home route/layout is the target.
  productSpaceGetCatalog: async () => ({
    success: false as const,
    errorCode: 'request_failed',
    message: 'catalog intentionally unavailable in the R33 route probe',
  }),
  getHomeQuickAccess: async () => [],
  setHomeQuickAccess: async (_contextKey: unknown, apps: unknown[]) => apps,
  // Sessions / LLM / drafts / notifications — loaded when app becomes ready.
  listSessions: async () => [],
  getSessions: async () => [],
  getSessionMessages: async () => [],
  getSessionPermissionModeState: async () => ({ mode: 'default' }),
  getSystemWarnings: async () => [],
  getTransportConnectionState: async () => ({ state: 'connected' }),
  getEditPopoverPendingQuestion: async () => null,
  getNotificationsEnabled: async () => true,
  listLlmConnectionsWithStatus: async () => [],
  getWorkspaceSettings: async () => ({}),
  getAllDrafts: async () => ({}),
  setDraft: async () => {},
  getAppTheme: async () => null,
  // Update check: no update available.
  getUpdateInfo: async () => ({ available: false, latestVersion: null }),
  getDismissedUpdateVersion: async () => null,
  // Onboarding surface: darwin needs no git-bash onboarding step.
  checkGitBash: async () => ({ platform: 'darwin', found: true, installed: true }),
  // GUI notification channel probe (useNotifications, render-time).
  isChannelAvailable: () => true,
  // Window focus probe (notification suppression, render-time).
  getWindowFocusState: async () => ({ focused: true }),
  // Dock/taskbar badge refresh (render-time registration path).
  refreshBadge: () => {},
  // Session/file operations that must never run in this probe — invoked only
  // by explicit user actions that cannot happen here; fail fast if reached.
  createSession: async () => { throw new Error('electronAPI fixture: createSession is not reachable under the narrow-Home route') },
  createEditPopoverSession: async () => { throw new Error('electronAPI fixture: createEditPopoverSession is not reachable') },
  sendMessage: async () => { throw new Error('electronAPI fixture: sendMessage is not reachable') },
  deleteSession: async () => {},
  showDeleteSessionConfirmation: async () => ({ confirmed: false }),
  storeAttachment: async () => ({ id: 'r33-fixture-attachment' }),
  readUserAttachment: async () => ({}),
  readFile: async () => '',
  readFileBinary: async () => new Uint8Array(),
  readFileDataUrl: async () => 'data:,',
  openFile: async () => {},
  openUrl: async () => {},
  openWorkspace: async () => {},
  showInFolder: async () => {},
  setTrafficLightsVisible: () => {},
  switchWorkspace: async () => {},
  reconnectTransport: async () => {},
  respondToPermission: async () => {},
  respondToCredential: async () => {},
  respondToQuestion: async () => {},
  adminLogout: async () => {},
  adminAcquirePhoneAuthChallenge: async () => ({}),
  debugLog: () => {},
  unwatchSessionFiles: async () => {},
}

// Known event subscriptions: each returns its unsubscribe function.
const KNOWN_ON = new Set([
  'onAdminReauthRequired', 'onAppThemeChange', 'onAutomationsChanged', 'onBadgeDraw',
  'onBadgeDrawWindows', 'onCloseRequested', 'onCopilotDeviceCode', 'onCreatorSkillProgress',
  'onDeepLinkNavigate', 'onDefaultPermissionsChanged', 'onLabelsChanged', 'onLlmConnectionsChanged',
  'onMenuKeyboardShortcuts', 'onMenuNewChat', 'onMenuOpenSettings', 'onMenuToggleFocusMode',
  'onMenuToggleSidebar', 'onMessagingBindingChanged', 'onMessagingPendingChanged',
  'onMessagingPlatformStatus', 'onNotificationNavigate', 'onReconnected', 'onSessionEvent',
  'onSessionFilesChanged', 'onSkillsChanged', 'onSourcesChanged', 'onStatusesChanged',
  'onSystemThemeChange', 'onThemePreferencesChange', 'onTransferProgress',
  'onTransportConnectionStateChanged', 'onUnreadSummaryChanged', 'onUpdateAvailable',
  'onUpdateDownloadProgress', 'onWhatsAppEvent', 'onWindowFocusChange', 'onWorkspaceThemeChange',
])

function failFastElectronApi(): unknown {
  const localApps = new Proxy({}, {
    get(_target, prop: string | symbol) {
      if (prop === 'getHostInfo') {
        return async () => ({ platform: 'darwin', arch: 'arm64' })
      }
      throw new Error(`electronAPI.localApps.${String(prop)} is not fixed by the R33 isolated fixture`)
    },
  })
  const base: Record<string, unknown> = { ...electronApiExplicit, localApps }
  return new Proxy(base, {
    get(target, prop: string | symbol) {
      if (typeof prop === 'symbol') {
        throw new Error(`electronAPI fixture: symbol access ${String(prop)} is not fixed`)
      }
      if (prop in target) return target[prop]
      if (KNOWN_ON.has(prop)) return () => UNSUBSCRIBE
      throw new Error(`electronAPI fixture: unknown property "${prop}" — add it with a deterministic result or fix the production access`)
    },
    has(_target, prop: string | symbol) {
      return typeof prop === 'string' && (prop in electronApiExplicit || KNOWN_ON.has(prop))
    },
  })
}

// Controllable narrow-viewport matchMedia: the production transition out of
// the guarded route is the window resize (the frozen guard's own escape).
type MediaQueryListener = (event: { matches: boolean }) => void
const narrowQueryListeners = new Set<MediaQueryListener>()
let narrowViewportActive = true

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => {
    const mql = {
      // Dynamic getter: `useNarrowViewport` re-reads `matches` when the
      // resize listener fires, so the value must track the CURRENT viewport.
      get matches() {
        return narrowViewportActive && query.includes('max-width: 640')
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, listener: MediaQueryListener) => { narrowQueryListeners.add(listener) },
      removeEventListener: (_: string, listener: MediaQueryListener) => { narrowQueryListeners.delete(listener) },
      addListener: (listener: MediaQueryListener) => { narrowQueryListeners.add(listener) },
      removeListener: (listener: MediaQueryListener) => { narrowQueryListeners.delete(listener) },
      dispatchEvent: () => false,
    }
    return mql
  }) as unknown as typeof window.matchMedia
}

/** Production transition: the OS-level window resize across the 640px line. */
function resizeViewport(width: number): void {
  narrowViewportActive = width <= 640
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  for (const listener of narrowQueryListeners) {
    listener({ matches: narrowViewportActive })
  }
}

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: failFastElectronApi(),
})
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
installMatchMedia()

beforeEach(() => {
  // Start EVERY scenario from the stale non-Home tab route: the fixture must
  // prove production initialization reaches narrow Home from here WITHOUT a
  // test-side reset back to Home.
  getDefaultStore().set(activeTabIdAtom, POLO_TAB_ID)
  narrowViewportActive = true
  installMatchMedia()
  return i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
})

const {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')

// App.tsx uses a DEFAULT export.
const { default: App } = await import('../App')

function renderApp(): void {
  render(createElement(I18nextProvider, { i18n }, createElement(App)))
}

function assertGuardMounted(): void {
  expect(screen.getByTestId('window-width-guard')).toBeTruthy()
  // The guard REPLACES every work surface at 390x844 (the frozen POO-41
  // authoritative mobile result): the Home launcher, the workbench, and any
  // webview layer are unmounted — absent, not merely CSS-hidden.
  expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
  expect(screen.queryByTestId('home-quick-entry-polo')).toBeNull()
  expect(screen.queryByTestId('home-app-hub')).toBeNull()
  expect(screen.queryByTestId('polo-app-root')).toBeNull()
  expect(document.querySelector('webview')).toBeNull()
  expect(screen.queryByTestId('file-preview-overlay')).toBeNull()
}

function assertHomeRestored(): void {
  expect(screen.getByTestId('home-quick-access-section')).toBeTruthy()
  expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
  expect(screen.queryByTestId('window-width-guard')).toBeNull()
}

describe('App × frozen narrow-window guard at 390x844 (Review R38 restores the POO-41 contract)', () => {
  it('renders the frozen WindowWidthGuard for EVERY route at 390x844 while the stale non-Home tab route hydrates behind it', async () => {
    // The ambient atom STARTS at POLO_TAB_ID (stale). Production hydration
    // (TabShellProvider re-activates Home) still runs — behind the guard —
    // but NO work surface may mount at the frozen mobile width.
    renderApp()
    await waitFor(
      () => {
        if (!screen.getByTestId('window-width-guard')) throw new Error('frozen guard missing at 390x844')
      },
      { timeout: 20_000 },
    )
    assertGuardMounted()
  }, 60_000)

  it('restores the production Home surface when the window widens past 640px, and re-narrowing fails closed to the guard again', async () => {
    renderApp()
    await waitFor(
      () => {
        if (!screen.getByTestId('window-width-guard')) throw new Error('frozen guard missing at 390x844')
      },
      { timeout: 20_000 },
    )
    assertGuardMounted()

    // The frozen guard's own escape is the OS-level window resize across the
    // 640px line: at 641px+ the production Home surface comes back through
    // the real matchMedia resize path (hydration already re-activated Home).
    await act(async () => {
      resizeViewport(1000)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('home-quick-access-section')) throw new Error('Home surface missing after widening')
      },
      { timeout: 10_000 },
    )
    assertHomeRestored()

    // ROUTE: Catalog — entered through the production All Apps control.
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(
      () => {
        if (!screen.getByTestId('all-apps-view')) throw new Error('Catalog surface missing after widening')
      },
      { timeout: 10_000 },
    )
    // The narrow fixture's Catalog fails closed into its error tile —
    // the route itself (the All Apps view) is the assertion target here.
    await act(async () => {
      resizeViewport(390)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('window-width-guard')) throw new Error('guard missing over Catalog after re-narrowing')
      },
      { timeout: 10_000 },
    )
    assertGuardMounted()

    // Back to 641px+: the production Home surface returns. The launcher VIEW
    // state itself resets on the guarded remount (the Home component
    // unmounted under the guard), which is the production remount behavior —
    // the ROUTE coverage above (Catalog visible at 641px+) is what the route
    // matrix pins.
    await act(async () => {
      resizeViewport(1000)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('home-quick-access-section')) throw new Error('Home surface missing after re-widening')
      },
      { timeout: 10_000 },
    )
    expect(screen.queryByTestId('window-width-guard')).toBeNull()

    // ROUTE: Polo workbench — entered through the production tab write path
    // (TabShellContext.openApp → openAppTabAtom, the same production write
    // the R33 review accepted).
    await act(async () => {
      getDefaultStore().set(activeTabIdAtom, POLO_TAB_ID)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('polo-app-root')) throw new Error('workbench missing for Polo route')
      },
      { timeout: 10_000 },
    )
    await act(async () => {
      resizeViewport(390)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('window-width-guard')) throw new Error('guard missing over Polo route after re-narrowing')
      },
      { timeout: 10_000 },
    )
    assertGuardMounted()

    // Back to 641px+: the Polo workbench hydrates again.
    await act(async () => {
      resizeViewport(1000)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('polo-app-root')) throw new Error('workbench missing after re-widening')
      },
      { timeout: 10_000 },
    )

    // ROUTE: webapp — entered through the production openApp write path.
    await act(async () => {
      getDefaultStore().set(openAppTabAtom, {
        id: 'webapp-route-fixture',
        name: 'Route WebApp',
        url: 'https://webapp-route.example.com',
        type: 'webapp' as const,
        createdAt: 1,
        order: 99,
      })
    })
    await waitFor(
      () => {
        if (document.documentElement.dataset.activeTab !== 'webapp') throw new Error('webapp route not active')
      },
      { timeout: 10_000 },
    )
    await act(async () => {
      resizeViewport(390)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('window-width-guard')) throw new Error('guard missing over webapp route after re-narrowing')
      },
      { timeout: 10_000 },
    )
    assertGuardMounted()
  }, 60_000)
})
