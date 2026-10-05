/** Real App, useOnboarding and post-auth read transaction; Electron receipts and
 * ProductSpace bootstrap boundary are unit fixtures, never native evidence. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, StrictMode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID } from '../../shared/tab-browser-types'

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
  useOptionalTheme: () => themeContextStub,
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

const FIXTURE_ACCOUNT_ID = 'auth-journey-unit-account'
const FIXTURE_SPACE_ID = 'personal-unit-space'
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
  bootstrap: mock(async (_accountId: string): Promise<'ready' | 'error' | 'contract-blocked' | null> => 'ready'),
  refreshProductSpaces: async () => {},
  retryBootstrap: mock(async (): Promise<'ready' | 'error' | 'contract-blocked' | null> => 'ready'),
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

const FIXTURE_USER = {
  id: FIXTURE_ACCOUNT_ID,
  username: 'auth-unit',
  displayName: 'Authentication unit fixture',
}

const UNSUBSCRIBE = () => {}
let authenticated = false
let phoneEnabled = false
let reauthListener: ((value: unknown) => void) | undefined

const electronApiExplicit: Record<string, unknown> = {
  isDebugMode: async () => false,
  getWindowWorkspace: async () => 'ws-auth-unit',
  getSetupNeeds: async () => ({
    isFullyConfigured: authenticated, needsAdminLogin: !authenticated,
    needsCredentials: false, needsBillingConfig: false,
  }),
  adminGetStatus: async () => ({
    adminUrl: 'https://unit.example', loggedIn: authenticated,
    userId: authenticated ? FIXTURE_ACCOUNT_ID : undefined,
  }),
  adminValidate: async () => authenticated
    ? { loggedIn: true, user: FIXTURE_USER }
    : { loggedIn: false },
  adminGetAuthConfig: async () => ({ phoneAuthEnabled: phoneEnabled }),
  adminGetPhoneAuthChallengeConfig: async () => ({ success: true }),
  adminAcquirePhoneAuthChallenge: async () => ({ success: true, challengeToken: 'unit-issued-token' }),
  adminSendPhoneAuthCode: mock(async () => ({ success: true, accepted: true, expiresIn: 300, resendAfter: 60 })),
  adminLogin: mock(async () => { authenticated = true; return { success: true, user: FIXTURE_USER } }),
  adminVerifyPhoneAuthCode: mock(async () => { authenticated = true; return { success: true, user: FIXTURE_USER, isNewUser: true } }),
  productSpaceRevokeActiveContext: async () => ({ success: true }),
  adminLogout: async () => { authenticated = false; return { success: true } },
  clearClaudeOAuthState: async () => {},
  onAdminReauthRequired: (listener: (value: unknown) => void) => { reauthListener = listener; return () => { reauthListener = undefined } },
  adminSyncConnections: async () => ({ success: true }),
  getRuntimeEnvironment: () => 'electron',
  getSources: async () => [],
  listStatuses: async () => [],
  listLabels: async () => [],
  listViews: async () => [],
  getSkills: async () => [],
  getUnreadSummary: async () => ({ totalUnreadSessions: 0, byWorkspace: {}, hasUnreadByWorkspace: {} }),
  getTheme: async () => 'light',
  getWorkspaces: async () => [{ id: 'ws-auth-unit', name: 'Unit workspace', rootPath: '/unit-read-only' }],
  productSpaceGetCatalog: async () => ({
    success: false as const,
    errorCode: 'request_failed',
    message: 'catalog intentionally unavailable in the authentication journey fixture',
  }),
  getHomeQuickAccess: async () => [],
  setHomeQuickAccess: async (_contextKey: unknown, apps: unknown[]) => apps,
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
  getUpdateInfo: async () => ({ available: false, latestVersion: null }),
  getDismissedUpdateVersion: async () => null,
  checkGitBash: async () => ({ platform: 'darwin', found: true, installed: true }),
  isChannelAvailable: () => true,
  getWindowFocusState: async () => ({ focused: true }),
  refreshBadge: () => {},
  createSession: async () => { throw new Error('electronAPI fixture: createSession is not reachable in this authentication journey fixture') },
  createEditPopoverSession: async () => { throw new Error('electronAPI fixture: createEditPopoverSession is not reachable') },
  sendMessage: async () => { throw new Error('electronAPI fixture: sendMessage is not reachable') },
  deleteSession: async () => {},
  showDeleteSessionConfirmation: async () => ({ confirmed: false }),
  storeAttachment: async () => ({ id: 'auth-unit-attachment' }),
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
  debugLog: () => {},
  unwatchSessionFiles: async () => {},

  memberCircles: {
    list: async () => ({ success: true, circles: [] }),
    listMemberships: async () => ({ success: true, memberships: [] }),
    previewRenewal: async () => ({ success: false, errorCode: 'not_found', message: 'fixture' }),
    leave: async () => ({ success: false, errorCode: 'not_found', message: 'fixture' }),
    getOrder: async () => ({ success: false, errorCode: 'not_found', message: 'fixture' }),
    getCheckoutResult: async () => ({ success: false, errorCode: 'not_found', message: 'fixture' }),
    getUpdates: async () => ({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } }),
    getProfile: async () => ({ success: true, profile: { availability: 'upstream_pending', contractGap: 'G3' } }),
    getSupport: async () => ({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } }),
  },
}

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
      throw new Error(`electronAPI.localApps.${String(prop)} is not fixed by the authentication journey fixture`)
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

Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
})) as typeof window.matchMedia
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { default: App } = await import('../App')
const defaultStatus = electronApiExplicit.adminGetStatus
const defaultWorkspaces = electronApiExplicit.getWorkspaces
beforeEach(async () => {
  authenticated = false
  phoneEnabled = false
  electronApiExplicit.adminGetStatus = defaultStatus
  electronApiExplicit.getWorkspaces = defaultWorkspaces
  productSpaceState.bootstrap.mockReset()
  productSpaceState.bootstrap.mockImplementation(async () => 'ready')
  productSpaceState.retryBootstrap.mockReset()
  productSpaceState.retryBootstrap.mockImplementation(async () => 'ready')
  ;(electronApiExplicit.adminLogin as ReturnType<typeof mock>).mockClear()
  ;(electronApiExplicit.adminVerifyPhoneAuthCode as ReturnType<typeof mock>).mockClear()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
  await i18n.changeLanguage('en')
})
afterEach(() => cleanup())
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function renderApp() {
  render(createElement(StrictMode, null, createElement(I18nextProvider, { i18n }, createElement(App))))
}
async function passwordLogin() {
  await waitFor(() => expect(screen.getByLabelText('Phone number or username')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('Phone number or username'), { target: { value: 'unit-user' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'unit-password' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })) })
}
function assertNotReady() {
  expect(screen.queryByTestId('onboarding-complete-finish')).toBeNull()
  expect(screen.queryByText(i18n.t('onboarding.completion.allSet'))).toBeNull()
  expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
}
async function assertHome() {
  await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
  expect(screen.queryByTestId('onboarding-complete-finish')).toBeNull()
}

describe('authenticated onboarding × real App initialization', () => {
  it('password success immediately shows pending through status and space reads, then Home without a finish click', async () => {
    const status = deferred<{ loggedIn: boolean; userId: string }>()
    electronApiExplicit.adminGetStatus = () => authenticated ? status.promise : (defaultStatus as () => Promise<unknown>)()
    const space = deferred<'ready'>()
    productSpaceState.bootstrap.mockImplementation(() => space.promise)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
    renderApp()
    await passwordLogin()
    expect(screen.getByTestId('product-space-preparation-screen')).toBeTruthy()
    assertNotReady()
    expect(productSpaceState.bootstrap).not.toHaveBeenCalled()
    await act(async () => { status.resolve({ loggedIn: true, userId: FIXTURE_ACCOUNT_ID }); await status.promise })
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('product-space-preparation-screen')).toBeTruthy()
    assertNotReady()
    await act(async () => { space.resolve('ready'); await space.promise })
    await assertHome()
    expect(electronApiExplicit.adminLogin).toHaveBeenCalledTimes(1)
  })

  it('new-phone success automatically reaches a real read failure and explicit space retry without repeating verification', async () => {
    phoneEnabled = true
    productSpaceState.bootstrap.mockImplementation(async () => 'error')
    renderApp()
    await waitFor(() => expect(screen.getByTestId('phone-auth-entry')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(i18n.t('onboarding.adminLogin.phonePlaceholder')), { target: { value: '13800138000' } })
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(screen.getByTestId('phone-auth-send-code')) })
    await waitFor(() => expect(screen.getByTestId('phone-auth-verify')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(i18n.t('onboarding.adminLogin.codePlaceholder')), { target: { value: '123456' } })
    await act(async () => { fireEvent.click(screen.getByTestId('phone-auth-continue')) })
    await waitFor(() => expect(screen.getByTestId('product-space-error-screen')).toBeTruthy())
    assertNotReady()
    await act(async () => { fireEvent.click(screen.getByTestId('product-space-error-retry')) })
    await assertHome()
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(1)
    expect(productSpaceState.retryBootstrap).toHaveBeenCalledTimes(1)
    expect(electronApiExplicit.adminVerifyPhoneAuthCode).toHaveBeenCalledTimes(1)
    expect(electronApiExplicit.adminSendPhoneAuthCode).toHaveBeenCalledTimes(1)
  })

  it('contract denial stays on the upgrade gate instead of claiming ready', async () => {
    productSpaceState.bootstrap.mockImplementation(async () => 'contract-blocked')
    renderApp()
    await passwordLogin()
    await waitFor(() => expect(screen.getByTestId('product-space-contract-gate')).toBeTruthy())
    assertNotReady()
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(1)
  })

  it('status-read failure stays recoverable and retries reads without another login', async () => {
    let fail = true
    electronApiExplicit.adminGetStatus = async () => {
      if (authenticated && fail) throw new Error('unit status read unavailable')
      return (defaultStatus as () => Promise<unknown>)()
    }
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
    renderApp()
    await passwordLogin()
    await waitFor(() => expect(screen.getByTestId('product-space-error-screen')).toBeTruthy())
    assertNotReady()
    expect(productSpaceState.bootstrap).not.toHaveBeenCalled()
    fail = false
    await act(async () => { fireEvent.click(screen.getByTestId('product-space-error-retry')); fireEvent.click(screen.getByTestId('product-space-error-retry')) })
    await assertHome()
    expect(electronApiExplicit.adminLogin).toHaveBeenCalledTimes(1)
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(1)
  })

  for (const status of [{ loggedIn: false }, { loggedIn: true, userId: 'different-account' }]) {
    it(`unverified session ${JSON.stringify(status)} fails closed to login, never a local workspace`, async () => {
      electronApiExplicit.adminGetStatus = async () => authenticated
        ? status
        : (defaultStatus as () => Promise<unknown>)()
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
      renderApp()
      await passwordLogin()
      await waitFor(() => expect(screen.getByLabelText('Phone number or username')).toBeTruthy())
      assertNotReady()
      expect(productSpaceState.bootstrap).not.toHaveBeenCalled()
    })
  }

  it('workspace-read failure cannot be treated as an empty workspace or ready; retry keeps the verified login', async () => {
    let fail = true
    electronApiExplicit.getWorkspaces = async () => {
      if (fail) throw new Error('unit workspace read unavailable')
      return (defaultWorkspaces as () => Promise<unknown>)()
    }
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
    renderApp()
    await passwordLogin()
    await waitFor(() => expect(screen.getByTestId('product-space-error-screen')).toBeTruthy())
    assertNotReady()
    expect(productSpaceState.bootstrap).not.toHaveBeenCalled()
    fail = false
    await act(async () => { fireEvent.click(screen.getByTestId('product-space-error-retry')) })
    await assertHome()
    expect(electronApiExplicit.adminLogin).toHaveBeenCalledTimes(1)
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(1)
  })

  it('a cancelled space bootstrap cannot replace newer same-account Home with its late contract failure', async () => {
    const staleSpace = deferred<'contract-blocked'>()
    productSpaceState.bootstrap.mockImplementationOnce(() => staleSpace.promise)
    renderApp()
    await passwordLogin()
    expect(screen.getByTestId('product-space-preparation-screen')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    await passwordLogin()
    await assertHome()
    await act(async () => { staleSpace.resolve('contract-blocked'); await staleSpace.promise })
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('product-space-contract-gate')).toBeNull()
    await assertHome()
  })


  it('session expiry while workspace reads wait cancels the completion before any space route', async () => {
    const workspaces = deferred<unknown[]>()
    electronApiExplicit.getWorkspaces = () => workspaces.promise
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
    renderApp()
    await passwordLogin()
    expect(screen.getByTestId('product-space-preparation-screen')).toBeTruthy()
    await act(async () => { reauthListener?.({ loggedIn: false, errorCode: 'TOKEN_EXPIRED' }) })
    await waitFor(() => expect(screen.getByLabelText('Phone number or username')).toBeTruthy())
    await act(async () => { workspaces.resolve([{ id: 'stale-workspace' }]); await workspaces.promise })
    expect(productSpaceState.bootstrap).not.toHaveBeenCalled()
    assertNotReady()
  })

  it('cancelling pending preparation rejects late same-account receipts after a new login (ABA)', async () => {
    const oldStatus = deferred<{ loggedIn: boolean; userId: string }>()
    let firstRead = true
    electronApiExplicit.adminGetStatus = async () => {
      if (authenticated && firstRead) { firstRead = false; return oldStatus.promise }
      return (defaultStatus as () => Promise<unknown>)()
    }
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
    renderApp()
    await passwordLogin()
    expect(screen.getByTestId('product-space-preparation-screen')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    await passwordLogin()
    await assertHome()
    await act(async () => { oldStatus.resolve({ loggedIn: true, userId: FIXTURE_ACCOUNT_ID }); await oldStatus.promise })
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(1)
    expect(electronApiExplicit.adminLogin).toHaveBeenCalledTimes(2)
    await assertHome()
  })
})
