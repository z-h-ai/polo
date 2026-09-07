import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB_ID } from '../../shared/tab-browser-types'

// Register only when no window exists yet, and pin a macOS userAgent —
// shared-process pattern from TopBar.registry-poller.test.ts: happy-dom
// defaults to a Windows UA, which would flip isWindows/PATH_SEP in
// @/lib/platform for every test file running after this one in the shared
// bun process.
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

// ─── Runner-environment polyfills ────────────────────────────────────────────
// The packaged `@polo-ai/ui` barrel pulls in the pdf.js viewer stack, which
// needs browser globals happy-dom does not provide (DOMMatrix at module
// scope, plus the Vite `?url` worker import). Both are only USED when a PDF
// preview actually opens — far outside the Home route under test.
class DOMMatrixStub {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
  multiply = () => this
  translate = () => this
  scale = () => this
  rotate = () => this
  inverse = () => this
  transformPoint = () => ({ x: 0, y: 0, z: 0, w: 1 })
  flipX = () => this
  flipY = () => this
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

// Vite-hosted theme singleton (`import.meta.glob` over packaged theme JSON —
// unavailable under the plain bun runner). App only consumes the resolved
// light theme, so the context and its hook are stubbed to those defaults.
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

// ─── Logged-in ProductSpace bootstrap fixture ────────────────────────────────
// The App bootstrap must pass through the signed-in admin branch so
// `MaybeProductSpaceProvider` receives a COMPLETE authoritative context and
// the real Home tree (which consumes `useProductSpaceAppLaunchHandoff`) can
// mount. Only the ProductSpace bootstrap STATE hook is replaced: HomePage,
// TabShell, the active-tab atom, `useNarrowViewport`, and App's guard
// decision all stay production-real.
const FIXTURE_ACCOUNT_ID = 'acct-r32-fixture'
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

/**
 * Benign catch-all electronAPI: the bootstrap-critical members return
 * deterministic shapes; every other member resolves to undefined (and
 * `on*` subscriptions return an unsubscribe function) so the untouched
 * workbench surface stays inert without being mocked away.
 */
function buildElectronApi(): unknown {
  const explicit: Record<string, unknown> = {
    isDebugMode: async () => false,
    getWindowWorkspace: async () => 'ws-r32-mobile',
    // Signed-in admin session: the bootstrap commits the admin user and
    // routes through the (mocked) ProductSpace state into 'ready'.
    adminGetStatus: async () => ({
      adminUrl: 'https://fixture.r32.example',
      loggedIn: true,
      userId: FIXTURE_ACCOUNT_ID,
      username: 'r32-fixture',
      displayName: 'R32 Fixture',
    }),
    adminValidate: async () => ({
      loggedIn: true,
      user: {
        id: FIXTURE_ACCOUNT_ID,
        username: 'r32-fixture',
        displayName: 'R32 Fixture',
      },
    }),
    adminSyncConnections: async () => ({ success: true }),
    getSetupNeeds: async () => ({
      isFullyConfigured: true,
      needsAdminLogin: false,
      needsProvider: false,
      hasProvider: true,
      missingRequirements: [],
    }),
    getTheme: async () => 'light',
    getWorkspaces: async () => [],
    // The real useAppCatalog hook mounts on Home; a fail-closed catalog
    // response keeps the launcher section (error tile beside the fixed Polo
    // card) without any fixture coupling — the launcher route and layout are
    // the surface under test.
    productSpaceGetCatalog: async () => ({
      success: false as const,
      errorCode: 'request_failed',
      message: 'catalog intentionally unavailable in this route probe',
    }),
    getHomeQuickAccess: async () => [],
    setHomeQuickAccess: async (_contextKey: unknown, apps: unknown[]) => apps,
    listLlmConnectionsWithStatus: async () => [],
    getWorkspaceSettings: async () => ({}),
    getAllDrafts: async () => ({}),
    setDraft: async () => {},
    getAppTheme: async () => null,
    listSessions: async () => [],
    getSessions: async () => [],
    getSessionMessages: async () => [],
    getSessionPermissionModeState: async () => ({ mode: 'default' }),
    getSystemWarnings: async () => [],
    getTransportConnectionState: async () => ({ state: 'connected' }),
    getEditPopoverPendingQuestion: async () => null,
    createSession: async () => { throw new Error('not under test') },
    createEditPopoverSession: async () => { throw new Error('not under test') },
    sendMessage: async () => { throw new Error('not under test') },
    sessionCommand: async () => ({}),
    deleteSession: async () => {},
    showDeleteSessionConfirmation: async () => ({ confirmed: false }),
    storeAttachment: async () => ({ id: 'r32-fixture-attachment' }),
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
    // Update check: no update available.
    getUpdateInfo: async () => ({ available: false, latestVersion: null }),
    getDismissedUpdateVersion: async () => null,
    // Onboarding surface: darwin needs no git-bash onboarding step.
    checkGitBash: async () => ({ platform: 'darwin', found: true, installed: true }),
  }
  // Nested API namespaces (localApps, browserPane, ...) get the same
  // catch-all treatment so no member is ever a bare undefined.
  const namespaces: Record<string, unknown> = {
    localApps: new Proxy({ getHostInfo: async () => ({ platform: 'darwin', arch: 'arm64' }) }, catchAll),
    browserPane: new Proxy({}, catchAll),
  }
  return new Proxy({ ...explicit, ...namespaces }, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && (prop.startsWith('on') || prop.startsWith('once'))) {
        return () => () => {}
      }
      return () => Promise.resolve(undefined)
    },
  })
}

const catchAll = {
  get(_target: unknown, prop: string) {
    if (typeof prop === 'string' && (prop.startsWith('on') || prop.startsWith('once'))) {
      return () => () => {}
    }
    return () => Promise.resolve(undefined)
  },
}

// The stub must exist BEFORE the App import graph evaluates: several
// workbench modules read `window.electronAPI` at module scope.
installMatchMedia()
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: buildElectronApi(),
})

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    matches: narrowViewportActive && query.includes('max-width: 640'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

let narrowViewportActive = true

beforeEach(() => {
  narrowViewportActive = true
  installMatchMedia()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: buildElectronApi(),
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
  return i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
})

const {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')

const psHook = await import('@/hooks/useProductSpaceContext')

// App.tsx uses a DEFAULT export.
const { default: App } = await import('../App')

function renderApp(): void {
  render(createElement(I18nextProvider, { i18n }, createElement(App)))
}

describe('App × production Home route at 390x844 (Review R31/R32)', () => {
  it('renders the POO-43 Home through the real App route at 390x844 instead of the narrow-window guard', async () => {
    renderApp()

    // The production route reaches the Home surface: the launcher section
    // and the fixed Polo card are present — the route-scoped guard did NOT
    // replace the product shell on the Home tab at 390x844.
    await waitFor(
      () => {
        if (!screen.getByTestId('home-quick-access-section')) throw new Error('launcher section missing')
      },
      { timeout: 15_000 },
    )
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
    expect(screen.queryByTestId('window-width-guard')).toBeNull()
  }, 60_000)

  it('keeps the frozen narrow-window guard for the non-Home workbench route at 390x844', async () => {
    renderApp()
    await waitFor(
      () => {
        if (!screen.getByTestId('home-quick-access-section')) throw new Error('launcher section missing')
      },
      { timeout: 15_000 },
    )

    // Activate the POLO workbench tab exactly like the production tab strip
    // does (ambient Jotai store): the guarded route must fail closed to the
    // frozen fullscreen guard at 390x844.
    act(() => {
      getDefaultStore().set(activeTabIdAtom, POLO_TAB_ID)
    })
    await waitFor(
      () => {
        if (!screen.getByTestId('window-width-guard')) throw new Error('guard missing for workbench route')
      },
      { timeout: 10_000 },
    )

    // Returning to the Home tab restores the required mobile Home surface.
    act(() => {
      getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
    })
    await waitFor(
      () => {
        if (!screen.queryByTestId('window-width-guard')) return undefined
        throw new Error('guard still present on Home')
      },
      { timeout: 10_000 },
    )
    expect(screen.getByTestId('home-quick-entry-polo')).toBeTruthy()
  }, 60_000)
})
