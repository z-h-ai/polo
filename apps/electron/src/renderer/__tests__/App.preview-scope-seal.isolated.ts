import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useLayoutEffect } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB_ID } from '../../shared/tab-browser-types'
import { useProductSpaceContext } from '../context/ProductSpaceContext'
import {
  createProductSpaceContextKey,
  resetProductSpaceStorageMemoryForTests,
} from '../lib/product-space-storage'

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

// ─── REAL ProductSpace state hook, driven by fixture IPC ────────────────────
// Review R37 (open observation 471a35caae45abdaebbebf21): the A→B transition
// is driven by the PRODUCTION requestSwitch chain — requestSwitch →
// productSpaceListActiveExecutions → prepareTrustedSwitch →
// stopPreparedSwitchExecutions → target re-verification → target Catalog
// staging gate → commitPreparedSwitch → publishCommittedSelection. The state
// hook is NOT mocked and no unrelated event forces the rerender. The fixture
// below enumerates the exact IPC surface the production chain touches with
// schema-faithful responses (personal origin space + enterprise target
// space, both active).
const FIXTURE_ACCOUNT_ID = 'acct-r35-fixture'
const SPACE_A_ID = 'space-a'
const SPACE_B_ID = 'space-b'
const SPACE_A = {
  id: SPACE_A_ID,
  kind: 'personal' as const,
  name: '我的空间',
  accessMode: 'active' as const,
  payer: { kind: 'account' as const },
}
const SPACE_B = {
  id: SPACE_B_ID,
  kind: 'enterprise' as const,
  enterpriseId: 'ent-r35-fixture',
  name: 'Space B',
  role: 'member' as const,
  accessMode: 'active' as const,
  payer: { kind: 'enterprise' as const, enterpriseId: 'ent-r35-fixture' },
}
// The context key format is produced by the PRODUCTION key builder.
const A_KEY = createProductSpaceContextKey(FIXTURE_ACCOUNT_ID, SPACE_A_ID)
const B_KEY = createProductSpaceContextKey(FIXTURE_ACCOUNT_ID, SPACE_B_ID)

// ─── Fail-fast electronAPI fixture ───────────────────────────────────────────
// Every property the real App graph touches at import/bootstrap/render time
// is enumerated with a deterministic result. ANY unknown property access
// throws immediately (no catch-all undefined), so a production regression
// surfaces as a loud fixture failure.
const FIXTURE_USER = {
  id: FIXTURE_ACCOUNT_ID,
  username: 'r35-fixture',
  displayName: 'R35 Fixture',
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
  // Home surface: real useAppCatalog mounts with an EMPTY but SUCCESSFUL
  // unified Catalog (the same channel the switch staging gate re-validates
  // the target space against before committing).
  // Schema-valid Catalog DTO: notModified + the schema-required built-in
  // Polo assistant entry (the work-App projection stays empty).
  productSpaceGetCatalog: async () => ({
    success: true as const,
    notModified: false,
    entries: [
      {
        kind: 'built_in_app',
        builtInAppId: 'polo_assistant',
        name: 'Polo 助手',
        description: 'Polo 内置助手',
        availability: 'available',
      },
    ] as unknown[],
    withdrawnEntries: [] as unknown[],
    catalogRevision: 'rev-r35-empty',
    accessMode: 'online',
  }),
  getHomeQuickAccess: async () => [],
  setHomeQuickAccess: async (_contextKey: unknown, apps: unknown[]) => apps,
  // ProductSpace bootstrap chain (REAL useProductSpaceContextState):
  productSpaceList: async () => ({
    success: true as const,
    contractVersion: 1,
    personalProductSpaceId: SPACE_A_ID,
    productSpaces: [SPACE_A, SPACE_B],
  }),
  productSpaceGetRestrictionState: async () => ({ success: true, restricted: false }),
  productSpaceCleanupLegacyState: async () => ({
    success: true,
    results: { legacyAuthorizationCache: true, legacyCatalogCache: true },
  }),
  productSpaceListActiveExecutions: async () => ({ success: true, executions: [] }),
  productSpacePrepareSwitch: async () => ({
    success: true as const,
    token: 'r35-switch-token',
    executions: [] as unknown[],
  }),
  productSpaceStopSwitchExecutions: async () => ({ success: true, executions: [] }),
  productSpaceCommitSwitch: async () => ({ success: true }),
  // Device-local preference store backing @/lib/product-space-storage.
  getProductSpaceContextStorage: async () => ({}),
  updateProductSpaceContextStorage: async () => ({}),
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
let narrowViewportActive = false

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

const electronApiInstance = failFastElectronApi() as unknown as Record<string, unknown>
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: electronApiInstance,
})

// Production committed-key recorder: publishCommittedSelection dispatches
// 'polo:product-space-changed' with the authoritative context key after the
// trusted transaction commits. This is the production transition signal.
const committedContextKeys: string[] = []
window.addEventListener('polo:product-space-changed', (event) => {
  const detail = (event as CustomEvent<{ contextKey?: string }>).detail
  if (detail?.contextKey) committedContextKeys.push(detail.contextKey)
})

// Production preview seeding + production switch trigger: TopBar is rendered
// INSIDE AppShellProvider and the ProductSpace provider in the wide
// workbench, so the probe buttons call the REAL AppShellContext.onOpenFile
// and the REAL ProductSpaceContext.requestSwitch — the same production
// entries a user's file-link click and space selection drive.
let openPreviewProbePath: string | null = null
mock.module('@/components/app-shell/TopBar', () => ({
  TopBar: () => {
    const { useAppShellContext } = require('../context/AppShellContext') as typeof import('../context/AppShellContext')
    const { onOpenFile } = useAppShellContext()
    const productSpace = useProductSpaceContext()
    return createElement(
      'div',
      null,
      createElement('button', {
        'data-testid': 'r35-topbar-probe',
        onClick: () => {
          if (openPreviewProbePath) onOpenFile(openPreviewProbePath)
        },
      }),
      createElement('button', {
        'data-testid': 'r35-switch-space-probe',
        onClick: () => {
          // The production space-selection entry (the same context API the
          // switch dialog's user selection drives) → requestSwitch.
          if (productSpace) productSpace.onSelectProductSpace(SPACE_B_ID)
        },
      }),
    )
  },
}))

// Review R35/R37 fix (open observation 471a35caae45abdaebbebf21): stable
// sibling FIRST-COMMIT observer. ProductSpaceSwitchDialog is rendered
// immediately AFTER the ProductSpace-keyed TabShellProvider inside the real
// App tree, so this useLayoutEffect snapshots the WHOLE document after every
// commit but BEFORE any passive effect runs, tagged with the COMMITTED
// ProductSpace context key read from the real context value. Scope B's first
// committed layout is therefore captured before passive closePreview can
// ever execute — the render-time seal is the only mechanism that can keep
// the origin-scope preview out of this snapshot.
const siblingLayoutSnapshots: Array<{ scopeKey: string | null; html: string }> = []
mock.module('@/components/product-space/ProductSpaceSwitchDialog', () => ({
  ProductSpaceSwitchDialog: () => {
    const productSpace = useProductSpaceContext()
    useLayoutEffect(() => {
      siblingLayoutSnapshots.push({
        scopeKey: productSpace?.productSpaceContextKey ?? null,
        html: document.body.innerHTML,
      })
    })
    return null
  },
}))
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
installMatchMedia()

beforeEach(() => {
  // The preview scope-seal regression runs WIDE (the workbench — where file
  // previews are opened — is mounted).
  narrowViewportActive = false
  installMatchMedia()
  resetProductSpaceStorageMemoryForTests()
  committedContextKeys.length = 0
  siblingLayoutSnapshots.length = 0
  openPreviewProbePath = null
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
  return i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
})

const {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')

// App.tsx uses a DEFAULT export.
const { default: App } = await import('../App')

describe('App preview scope-seal across A→B keyed switch (Review R34/R35)', () => {
  it('drives the production ProductSpace switch A→B; the origin-scope preview never mounts in the target scope first committed layout and the scope-neutral boundary is present', async () => {
    render(createElement(I18nextProvider, { i18n }, createElement(App)))

    // Real bootstrap through the production useProductSpaceContextState +
    // App startup route: the trusted transaction publishes scope A.
    await waitFor(() => {
      if (!screen.getByTestId('home-app-hub')) throw new Error('app not ready')
    }, { timeout: 20_000 })
    expect(committedContextKeys).toContain(A_KEY)

    // Seed the origin-scope preview through the production onOpenFile entry
    // (a real user file-link click drives the same handler).
    openPreviewProbePath = '/a/secret.png'
    fireEvent.click(screen.getByTestId('r35-topbar-probe'))

    // Sanity: the origin-scope preview IS mounted under scope A.
    await waitFor(() => {
      if (!screen.getByTestId('file-preview-overlay')) throw new Error('origin preview missing')
    }, { timeout: 10_000 })
    expect(siblingLayoutSnapshots.some(s =>
      s.scopeKey === A_KEY && s.html.includes('file-preview-overlay'),
    )).toBe(true)

    // A→B keyed switch through the PRODUCTION transition: the probe button
    // calls the real ProductSpaceContext.requestSwitch, which runs the
    // trusted prepare → stop → verify → catalog staging → commit chain and
    // publishes the B context key. No state-hook mock and no unrelated
    // rerender event participates.
    fireEvent.click(screen.getByTestId('r35-switch-space-probe'))

    // The transition actually produced the B context key: the production
    // 'polo:product-space-changed' event carries it after the commit.
    await waitFor(() => {
      if (!committedContextKeys.includes(B_KEY)) throw new Error('switch did not publish the space-b context key')
    }, { timeout: 20_000 })

    // TARGET-SCOPE FIRST COMMITTED LAYOUT (core evidence): the stable
    // sibling useLayoutEffect captured scope B's first commit BEFORE passive
    // effects ran. Deleting the render-time seal and keeping only passive
    // closePreview cannot pass here — passive close executes only AFTER this
    // layout committed, so only the synchronous render-time rejection
    // explains a clean first B layout.
    const firstScopeBCommit = siblingLayoutSnapshots.find(s => s.scopeKey === B_KEY)
    expect(firstScopeBCommit).toBeDefined()
    expect(firstScopeBCommit!.html.includes('file-preview-overlay')).toBe(false)
    expect(firstScopeBCommit!.html.includes('secret.png')).toBe(false)
    // The scope-neutral pre-hydration boundary is present in B's first
    // commit: the keyed provider remounts before its shell restores.
    expect(firstScopeBCommit!.html.includes('shell-scope-loading')).toBe(true)

    // After the switch re-render (passive effects flushed): the stale
    // origin-scope preview is gone — no overlay element, no content, no path.
    expect(screen.queryByTestId('file-preview-overlay')).toBeNull()
    expect(document.body.innerHTML.includes('secret.png')).toBe(false)

    // Hydration completes: the normal scope-B surface restores and the stale
    // preview stays gone.
    await waitFor(() => {
      if (!screen.getByTestId('home-app-hub')) throw new Error('scope B surface not restored')
    }, { timeout: 20_000 })
    expect(screen.queryByTestId('file-preview-overlay')).toBeNull()
    expect(document.body.innerHTML.includes('secret.png')).toBe(false)
  }, 60_000)
})
