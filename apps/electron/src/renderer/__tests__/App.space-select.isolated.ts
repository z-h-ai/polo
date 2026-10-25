/** Real App login journey through the space-select gate (POO-124 SCENE-1/2/4/5/6).
 * Electron receipts and the ProductSpace hook boundary are unit fixtures, never
 * native evidence; the device-local space ledger is the real storage module. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, StrictMode, useEffect, useReducer } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID } from '../../shared/tab-browser-types'
import { resetProductSpaceStorageMemoryForTests } from '@/lib/product-space-storage'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

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
  mode: 'light', colorTheme: 'default', font: 'system',
  setMode: () => {}, setColorTheme: () => {}, setFont: () => {},
  activeWorkspaceId: null, workspaceColorTheme: null, setWorkspaceColorTheme: () => {},
  resolvedMode: 'light', systemPreference: 'light', effectiveColorTheme: 'default',
  previewColorTheme: null, setPreviewColorTheme: () => {}, effectiveColorThemeSource: 'app',
  themeLoadError: null, presetTheme: null, resolvedTheme: {}, isDark: false,
  isScenic: false, shikiTheme: 'github-light', shikiConfig: {}, loaded: true,
}
mock.module('@/context/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children?: unknown }) => children ?? null,
  useTheme: () => themeContextStub,
  useOptionalTheme: () => themeContextStub,
}))
mock.module('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: {}, defaultTheme: {}, shikiTheme: 'github-light', shikiConfig: {},
    presetTheme: null, isDark: false, isScenic: false,
  }),
}))

const FIXTURE_ACCOUNT_ID = 'space-select-unit-account'
const PERSONAL_ID = 'personal-unit-space'
const ENTERPRISE_ID = 'enterprise-unit-space'
const SECOND_ENTERPRISE_ID = 'enterprise-unit-space-2'
const RESTRICTED_ENTERPRISE_ID = 'enterprise-unit-space-restricted'

const personalSpace = {
  id: PERSONAL_ID, kind: 'personal', name: '我的空间', accessMode: 'active',
} as unknown as ProductSpaceSummary
const enterpriseSpace = {
  id: ENTERPRISE_ID, kind: 'enterprise', enterpriseId: 'ent-1', name: '星辰传媒',
  role: 'member', accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'ent-1' },
} as unknown as ProductSpaceSummary
const secondEnterpriseSpace = {
  id: SECOND_ENTERPRISE_ID, kind: 'enterprise', enterpriseId: 'ent-2', name: '蓝湖设计',
  role: 'manager', accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'ent-2' },
} as unknown as ProductSpaceSummary
const restrictedEnterpriseSpace = {
  id: RESTRICTED_ENTERPRISE_ID, kind: 'enterprise', enterpriseId: 'ent-3', name: '恒岳法务',
  role: 'member', accessMode: 'read_only', restrictionCode: 'billing_restricted',
  payer: { kind: 'enterprise', enterpriseId: 'ent-3' },
} as unknown as ProductSpaceSummary

/** Mutable fixture the mocked hook snapshots per render. */
const productSpaceState = {
  accountId: FIXTURE_ACCOUNT_ID,
  flowState: 'ready',
  productSpaces: [personalSpace] as ProductSpaceSummary[],
  allProductSpaces: [personalSpace] as ProductSpaceSummary[],
  personalProductSpaceId: PERSONAL_ID,
  activeProductSpace: { id: PERSONAL_ID, kind: 'personal', name: '我的空间' },
  activeProductSpaceId: PERSONAL_ID as string | null,
  productSpaceContextKey: `${FIXTURE_ACCOUNT_ID}|${PERSONAL_ID}`,
  contextVersion: 1,
  pendingSwitch: null as unknown,
  unavailableSpaceIds: new Set<string>(),
  spaceSelectionSource: 'fresh' as 'fresh' | 'memory-invalid' | 'stored',
  error: null,
  bootstrap: mock(async (): Promise<'ready' | 'error' | 'contract-blocked' | null> => 'ready'),
  refreshProductSpaces: async () => {},
  retryBootstrap: mock(async (): Promise<'ready' | 'error' | 'contract-blocked' | null> => 'ready'),
  requestSwitch: mock(async (_targetId: string) => {}),
  confirmStopAndSwitch: mock(async () => {}),
  retryFailedStops: async () => {},
  retryTargetLoad: async () => {},
  cancelSwitch: async () => {},
  stopSwitchExecution: async () => {},
  dismissTargetAccessLost: () => {},
  clearAccount: () => {},
  rollbackToOrigin: async () => false,
  enterContractBlocked: () => {},
}

/** Fixture mutation → hook re-render, mirroring how the real hook's own
 * setState drives the next render after refreshProductSpaces. */
const FIXTURE_STATE_EVENT = 'fixture:product-space-state-updated'

mock.module('@/hooks/useProductSpaceContext', () => ({
  useProductSpaceContextState: () => {
    const [, bump] = useReducer((count: number) => count + 1, 0)
    useEffect(() => {
      const onFixtureChange = () => bump()
      window.addEventListener(FIXTURE_STATE_EVENT, onFixtureChange)
      return () => window.removeEventListener(FIXTURE_STATE_EVENT, onFixtureChange)
    }, [])
    return { ...productSpaceState }
  },
}))

const FIXTURE_USER = {
  id: FIXTURE_ACCOUNT_ID,
  username: 'space-select-unit',
  displayName: '王晓蕴',
}

/** Publish a fixture mutation the way the real hook publishes its own state
 * updates: the mocked hook re-snapshots on the next render this triggers. */
function fixtureStateMutated() {
  window.dispatchEvent(new Event(FIXTURE_STATE_EVENT))
}

const UNSUBSCRIBE = () => {}
let authenticated = false
let reauthListener: ((value: unknown) => void) | undefined

const electronApiExplicit: Record<string, unknown> = {
  isDebugMode: async () => false,
  getWindowWorkspace: async () => 'ws-space-select-unit',
  // Route read added in v0.17.0 (routeThroughProductSpace); the preload
  // fallback shape is `async () => null` — without it the fail-fast proxy
  // turns the route read into space-error before any screen can render.
  getWindowLaunchContext: async () => null,
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
  adminGetAuthConfig: async () => ({ phoneAuthEnabled: false }),
  adminGetPhoneAuthChallengeConfig: async () => ({ success: true }),
  adminAcquirePhoneAuthChallenge: async () => ({ success: true, challengeToken: 'unit-issued-token' }),
  adminSendPhoneAuthCode: mock(async () => ({ success: true, accepted: true, expiresIn: 300, resendAfter: 60 })),
  adminLogin: mock(async () => { authenticated = true; return { success: true, user: FIXTURE_USER } }),
  adminVerifyPhoneAuthCode: mock(async () => { authenticated = true; return { success: true, user: FIXTURE_USER, isNewUser: true } }),
  productSpaceRevokeActiveContext: async () => ({ success: true }),
  // ClientHomeRouter mounts useCircleReturn; its B1 bridge probe reads these
  // properties off window.electronAPI. Declare the slice so the fail-fast
  // proxy does not treat the probe itself as unfixed production access.
  circleReturn: {
    getPending: async () => ({ status: 'none' }) as const,
    ack: async () => ({ status: 'not_found' }) as const,
    cancel: async () => ({ status: 'cancelled' }) as const,
  },
  onCircleReturnCandidate: () => UNSUBSCRIBE,
  adminLogout: async () => { authenticated = false; return { success: true } },
  clearClaudeOAuthState: async () => {},
  onAdminReauthRequired: (listener: (value: unknown) => void) => { reauthListener = listener; return () => { reauthListener = undefined } },
  adminSyncConnections: mock(async () => ({ success: true })),
  getRuntimeEnvironment: () => 'electron',
  getSources: async () => [],
  listStatuses: async () => [],
  listLabels: async () => [],
  listViews: async () => [],
  getSkills: async () => [],
  getUnreadSummary: async () => ({ totalUnreadSessions: 0, byWorkspace: {}, hasUnreadByWorkspace: {} }),
  getTheme: async () => 'light',
  getWorkspaces: async () => [{ id: 'ws-space-select-unit', name: 'Unit workspace', rootPath: '/unit-read-only' }],
  productSpaceGetCatalog: async () => ({
    success: false as const,
    errorCode: 'request_failed',
    message: 'catalog intentionally unavailable in the space-select journey fixture',
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
  listLlmConnectionsWithStatus: mock(async () => []),
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
  // useWorkbenchReady awaits/.catches the receipt — must be promise-shaped.
  reportWorkbenchReady: async () => {},
  createSession: async () => { throw new Error('electronAPI fixture: createSession is not reachable in this space-select journey fixture') },
  createEditPopoverSession: async () => { throw new Error('electronAPI fixture: createEditPopoverSession is not reachable') },
  sendMessage: async () => { throw new Error('electronAPI fixture: sendMessage is not reachable') },
  deleteSession: async () => {},
  showDeleteSessionConfirmation: async () => ({ confirmed: false }),
  storeAttachment: async () => ({ id: 'space-select-unit-attachment' }),
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
  'onMenuKeyboardShortcuts', 'onMenuNewChat', 'onMenuNewWindowFailed', 'onMenuOpenSettings', 'onMenuToggleFocusMode',
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
      throw new Error(`electronAPI.localApps.${String(prop)} is not fixed by the space-select journey fixture`)
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

let rerenderApp: (() => void) | null = null

function renderAppTree() {
  const tree = createElement(StrictMode, null, createElement(I18nextProvider, { i18n }, createElement(App)))
  const { rerender } = render(tree)
  rerenderApp = () => rerender(tree)
}

beforeEach(async () => {
  authenticated = false
  resetProductSpaceStorageMemoryForTests()
  productSpaceState.productSpaces = [personalSpace]
  productSpaceState.allProductSpaces = [personalSpace]
  productSpaceState.activeProductSpaceId = PERSONAL_ID
  productSpaceState.activeProductSpace = { id: PERSONAL_ID, kind: 'personal', name: '我的空间' }
  productSpaceState.pendingSwitch = null
  productSpaceState.spaceSelectionSource = 'fresh'
  productSpaceState.bootstrap.mockReset()
  productSpaceState.bootstrap.mockImplementation(async () => 'ready')
  productSpaceState.requestSwitch.mockReset()
  productSpaceState.requestSwitch.mockImplementation(async () => {})
  productSpaceState.confirmStopAndSwitch.mockReset()
  productSpaceState.confirmStopAndSwitch.mockImplementation(async () => {})
  ;(electronApiExplicit.adminLogin as ReturnType<typeof mock>).mockClear()
  ;(electronApiExplicit.adminSyncConnections as ReturnType<typeof mock>).mockReset()
  ;(electronApiExplicit.adminSyncConnections as ReturnType<typeof mock>).mockImplementation(async () => ({ success: true }))
  ;(electronApiExplicit.listLlmConnectionsWithStatus as ReturnType<typeof mock>).mockReset()
  ;(electronApiExplicit.listLlmConnectionsWithStatus as ReturnType<typeof mock>).mockImplementation(async () => [])
  rerenderApp = null
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: failFastElectronApi() })
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
  await i18n.changeLanguage('zh-Hans')
})

afterEach(() => {
  rerenderApp = null
  cleanup()
  resetProductSpaceStorageMemoryForTests()
})

function assertHome() {
  expect(screen.getByTestId('home-quick-access-section')).toBeTruthy()
  expect(screen.queryByTestId('product-space-select-screen')).toBeNull()
}

async function passwordLogin() {
  await waitFor(() => expect(screen.getByLabelText('手机号或用户名')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('手机号或用户名'), { target: { value: 'unit-user' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'unit-password' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续' })) })
}

function selectItems() {
  return screen.getAllByTestId('product-space-select-item')
}

/** Wire the fixture switch transaction the way the REAL hook behaves with
 * zero active executions: requestSwitch itself runs prepare → (empty) stop →
 * commit and resolves only after the target is committed. The setTimeout gap
 * preserves the real IPC-shaped window between the click and the first
 * pendingSwitch publish — a router that reads committed state too early
 * (the POO-124 review race) fails inside this window. */
function armSwitchTransaction() {
  productSpaceState.requestSwitch.mockImplementation(async (targetId: string) => {
    productSpaceState.pendingSwitch = { targetId, phase: 'target-loading', executions: [], statuses: {}, errorCode: null }
    fixtureStateMutated()
    await new Promise(resolve => setTimeout(resolve, 0))
    productSpaceState.pendingSwitch = null
    productSpaceState.activeProductSpaceId = targetId
    const targetSpace = productSpaceState.productSpaces.find(space => space.id === targetId)
    if (targetSpace) productSpaceState.activeProductSpace = { id: targetSpace.id, kind: targetSpace.kind, name: targetSpace.name }
    fixtureStateMutated()
  })
}

/** Stored-memory fixture: the bootstrap committed the account's last-used
 * space into active and says so ('stored'), replacing the old ledger write. */
function armStoredEnterpriseGate() {
  productSpaceState.spaceSelectionSource = 'stored'
  productSpaceState.productSpaces = [personalSpace, enterpriseSpace]
  productSpaceState.allProductSpaces = [personalSpace, enterpriseSpace]
  productSpaceState.activeProductSpaceId = ENTERPRISE_ID
  productSpaceState.activeProductSpace = { id: ENTERPRISE_ID, kind: 'enterprise', name: '星辰传媒' }
}

/** POO-144: publish the commit event exactly the way the real hook's
 * publishCommittedSelection does after every committed selection. */
function publishSpaceCommitted(productSpaceId: string) {
  window.dispatchEvent(new CustomEvent('polo:product-space-changed', {
    detail: {
      accountId: FIXTURE_ACCOUNT_ID,
      productSpaceId,
      contextKey: `${FIXTURE_ACCOUNT_ID}|${productSpaceId}`,
    },
  }))
}

describe('登录后空间选择（space-select 门禁）× 真实 App', () => {
  it('SCENE-2/4：单空间账号登录直通 Home，不出现选择页', async () => {
    authenticated = true
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
    expect(screen.queryByTestId('product-space-select-screen')).toBeNull()
    expect(productSpaceState.bootstrap).toHaveBeenCalledTimes(1)
  })

  it('SCENE-1：多空间账号登录停在选择页，确认 bootstrap 已提交的空间零切换事务直达 Home', async () => {
    authenticated = true
    armStoredEnterpriseGate()
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
    // 上次空间默认选中且置顶
    const rows = selectItems()
    expect(rows[0]!.getAttribute('data-space-id')).toBe(ENTERPRISE_ID)
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('product-space-select-confirm').textContent).toBe('进入「星辰传媒」')
    // 账号身份与退出登录（M4/S1）
    expect(screen.getByTestId('product-space-select-account').textContent).toContain('王晓蕴')
    expect(screen.getByTestId('product-space-select-logout').textContent).toBe('退出登录')
    await act(async () => { fireEvent.click(screen.getByTestId('product-space-select-confirm')) })
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
    expect(productSpaceState.requestSwitch).not.toHaveBeenCalled()
    expect(productSpaceState.confirmStopAndSwitch).not.toHaveBeenCalled()
  })

  it('SCENE-1：确认不同空间恰走一次切换事务，提交后进入 Home', async () => {
    authenticated = true
    armStoredEnterpriseGate()
    armSwitchTransaction()
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    fireEvent.click(selectItems().find(row => row.getAttribute('data-space-id') === PERSONAL_ID)!)
    expect(screen.getByTestId('product-space-select-confirm').textContent).toBe('进入「我的空间」')
    await act(async () => {
      fireEvent.click(screen.getByTestId('product-space-select-confirm'))
      // requestSwitch 的完成晚于点击（IPC 形状）：完成路由只认 settled 之后
      // 的已提交状态，不得在 pendingSwitch 出现前抢跑清掉目标。
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(productSpaceState.requestSwitch).toHaveBeenCalledTimes(1)
    expect(productSpaceState.requestSwitch).toHaveBeenCalledWith(PERSONAL_ID)
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
  })

  it('活跃 executions 时切换对话框覆盖选择页：对话框内确认后才提交进入 Home', async () => {
    authenticated = true
    productSpaceState.productSpaces = [personalSpace, enterpriseSpace]
    productSpaceState.allProductSpaces = [personalSpace, enterpriseSpace]
    productSpaceState.activeProductSpaceId = PERSONAL_ID
    // 有活跃任务：requestSwitch 停在 confirm 相位，等待对话框内的显式终止确认
    productSpaceState.requestSwitch.mockImplementation(async (targetId: string) => {
      productSpaceState.pendingSwitch = {
        targetId,
        phase: 'confirm',
        executions: [{ executionId: 'exec-1', name: '正在运行的任务', status: 'running' }],
        statuses: { 'exec-1': 'running' },
        errorCode: null,
      }
      fixtureStateMutated()
    })
    productSpaceState.confirmStopAndSwitch.mockImplementation(async () => {
      const target = productSpaceState.pendingSwitch as { targetId: string } | null
      productSpaceState.pendingSwitch = null
      if (target) {
        productSpaceState.activeProductSpaceId = target.targetId
        const targetSpace = productSpaceState.productSpaces.find(space => space.id === target.targetId)
        if (targetSpace) productSpaceState.activeProductSpace = { id: targetSpace.id, kind: targetSpace.kind, name: targetSpace.name }
      }
      fixtureStateMutated()
    })
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    // 首登推荐默认企业：一键确认进入企业空间
    expect(screen.getByTestId('product-space-select-recommended-tag')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('product-space-select-confirm'))
      await Promise.resolve()
    })
    // 对话框渲染在门禁之上（space-select 分支在 ProductSpace provider 内）
    await waitFor(() => expect(screen.getByTestId('product-space-switch-dialog')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '终止全部并切换' }))
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
    expect(productSpaceState.confirmStopAndSwitch).toHaveBeenCalledTimes(1)
  })

  it('SCENE-5：首登无本地记忆时推荐企业置顶、带推荐标记并默认选中，确认走切换事务进入企业空间', async () => {
    authenticated = true
    productSpaceState.productSpaces = [personalSpace, enterpriseSpace]
    productSpaceState.allProductSpaces = [personalSpace, enterpriseSpace]
    productSpaceState.activeProductSpaceId = PERSONAL_ID
    armSwitchTransaction()
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    expect(screen.getByText('欢迎加入 Polo AI！根据企业邀请，为你推荐要进入的空间。')).toBeTruthy()
    const rows = selectItems()
    expect(rows[0]!.getAttribute('data-space-id')).toBe(ENTERPRISE_ID)
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('product-space-select-recommended-tag').textContent).toBe('推荐')
    await act(async () => {
      fireEvent.click(screen.getByTestId('product-space-select-confirm'))
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(productSpaceState.requestSwitch).toHaveBeenCalledTimes(1)
    expect(productSpaceState.requestSwitch).toHaveBeenCalledWith(ENTERPRISE_ID)
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
  })

  it('SCENE-6/S3：受限企业照常入列带「受限」，选中显示受限说明且确认不被 active 校验拦截', async () => {
    authenticated = true
    armStoredEnterpriseGate()
    productSpaceState.productSpaces = [personalSpace, enterpriseSpace, restrictedEnterpriseSpace]
    productSpaceState.allProductSpaces = [personalSpace, enterpriseSpace, restrictedEnterpriseSpace]
    armSwitchTransaction()
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    const restrictedRow = selectItems().find(row => row.getAttribute('data-space-id') === RESTRICTED_ENTERPRISE_ID)
    expect(restrictedRow!.getAttribute('data-restricted')).toBe('true')
    expect(restrictedRow!.textContent).toContain('受限')
    expect(screen.queryByTestId('product-space-select-restricted-note')).toBeNull()
    fireEvent.click(restrictedRow!)
    const note = screen.getByTestId('product-space-select-restricted-note')
    expect(note.textContent).toContain('「恒岳法务」当前受限')
    expect(note.textContent).toContain('不会被自动恢复为默认空间')
    await act(async () => {
      fireEvent.click(screen.getByTestId('product-space-select-confirm'))
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(productSpaceState.requestSwitch).toHaveBeenCalledWith(RESTRICTED_ENTERPRISE_ID)
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
  })

  it('M7/A5：确认瞬间目标已从列表移除时不发起切换事务，停留选择页可重选', async () => {
    authenticated = true
    armStoredEnterpriseGate()
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    fireEvent.click(selectItems().find(row => row.getAttribute('data-space-id') === PERSONAL_ID)!)
    // 目标失权并在选择页停留期间被刷新移除（新列表已提交）
    productSpaceState.productSpaces = [enterpriseSpace]
    productSpaceState.allProductSpaces = [enterpriseSpace]
    await act(async () => { fixtureStateMutated() })
    await waitFor(() => expect(screen.queryAllByTestId('product-space-select-item')
      .some(row => row.getAttribute('data-space-id') === PERSONAL_ID)).toBe(false))
    // 已不在授权列表内的目标不得发起切换事务
    await act(async () => {
      fireEvent.click(screen.getByTestId('product-space-select-confirm'))
      await Promise.resolve()
    })
    expect(productSpaceState.requestSwitch).not.toHaveBeenCalled()
    expect(screen.getByTestId('product-space-select-screen')).toBeTruthy()
    expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
  })

  it('S1：选择页退出登录复用现有登出语义，回到登录页且不进入任何空间', async () => {
    authenticated = true
    armStoredEnterpriseGate()
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('product-space-select-logout')) })
    await waitFor(() => expect(screen.getByLabelText('手机号或用户名')).toBeTruthy())
    expect(authenticated).toBe(false)
    expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
  })

  it('epoch：选择页停留期间会话过期时，后续晚到的空间结果不得落地（回到登录页）', async () => {
    authenticated = true
    armStoredEnterpriseGate()
    armSwitchTransaction()
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('product-space-select-screen')).toBeTruthy())
    fireEvent.click(selectItems().find(row => row.getAttribute('data-space-id') === PERSONAL_ID)!)
    // 事务仍在飞行中（setTimeout 缺口内）会话过期
    await act(async () => {
      fireEvent.click(screen.getByTestId('product-space-select-confirm'))
      await Promise.resolve()
    })
    expect(productSpaceState.requestSwitch).toHaveBeenCalledTimes(1)
    await act(async () => { reauthListener?.({ loggedIn: false, errorCode: 'TOKEN_EXPIRED' }) })
    await waitFor(() => expect(screen.getByLabelText('手机号或用户名')).toBeTruthy())
    // 晚到的事务完成（fixture 提交 active + 清 pending）不得把过期会话送进 Home
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(screen.queryByTestId('home-quick-access-section')).toBeNull()
    expect(screen.queryByTestId('product-space-select-screen')).toBeNull()
  })

  // ---- POO-144：空间提交 → scoped AI 配置同步状态机 ----

  it('POO-144：空间提交事件触发 scoped 同步，成功后显式刷新连接列表（不等广播）', async () => {
    authenticated = true
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
    const sync = electronApiExplicit.adminSyncConnections as ReturnType<typeof mock>
    const refresh = electronApiExplicit.listLlmConnectionsWithStatus as ReturnType<typeof mock>
    sync.mockClear()
    refresh.mockClear()
    await act(async () => { publishSpaceCommitted(ENTERPRISE_ID) })
    expect(sync).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('POO-144：同步失败不刷新不假成功，重试（同一入口）成功后恢复显式刷新', async () => {
    authenticated = true
    const sync = electronApiExplicit.adminSyncConnections as ReturnType<typeof mock>
    const refresh = electronApiExplicit.listLlmConnectionsWithStatus as ReturnType<typeof mock>
    sync.mockImplementation(async () => ({ success: false, errorCode: 'SYNC_FAILED', status: 500 }))
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
    sync.mockClear()
    refresh.mockClear()
    await act(async () => { publishSpaceCommitted(ENTERPRISE_ID) })
    expect(sync).toHaveBeenCalledTimes(1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    // 失败回执不触发连接列表刷新（failed 态等待用户重试）
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByTestId('home-quick-access-section')).toBeTruthy()
    // 用户点击「重试」与提交事件走同一条 runScopedAiConfigSync 路径
    sync.mockImplementation(async () => ({ success: true }))
    await act(async () => { publishSpaceCommitted(ENTERPRISE_ID) })
    expect(sync).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('POO-144：快速切换后旧空间的晚到 auth 失败回执不得把新会话打回登录页', async () => {
    authenticated = true
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
    const sync = electronApiExplicit.adminSyncConnections as ReturnType<typeof mock>
    const refresh = electronApiExplicit.listLlmConnectionsWithStatus as ReturnType<typeof mock>
    sync.mockClear()
    refresh.mockClear()
    let releaseStale: (value: unknown) => void = () => {}
    const staleReceipt = new Promise(resolve => { releaseStale = resolve })
    sync.mockImplementationOnce(() => staleReceipt)
    sync.mockImplementation(async () => ({ success: true }))
    // A 空间同步在飞；B 空间快速提交并完成
    await act(async () => { publishSpaceCommitted(ENTERPRISE_ID) })
    await act(async () => { publishSpaceCommitted(SECOND_ENTERPRISE_ID) })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    // 旧空间 A 的同步以 auth 失败晚到：epoch 已过期，回执必须整包丢弃
    await act(async () => {
      releaseStale({ success: false, loggedIn: false, errorCode: 'TOKEN_EXPIRED' })
      await staleReceipt
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(screen.getByTestId('home-quick-access-section')).toBeTruthy()
    expect(screen.queryByLabelText('手机号或用户名')).toBeNull()
    // 丢弃的回执不得再触发连接列表刷新
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('POO-144：会话失效（登出/换号）后旧同步的晚到成功回执不得再落地刷新', async () => {
    authenticated = true
    renderAppTree()
    await waitFor(() => expect(screen.getByTestId('home-quick-access-section')).toBeTruthy())
    const sync = electronApiExplicit.adminSyncConnections as ReturnType<typeof mock>
    const refresh = electronApiExplicit.listLlmConnectionsWithStatus as ReturnType<typeof mock>
    sync.mockClear()
    refresh.mockClear()
    let releaseStale: (value: unknown) => void = () => {}
    const staleReceipt = new Promise(resolve => { releaseStale = resolve })
    sync.mockImplementationOnce(() => staleReceipt)
    await act(async () => { publishSpaceCommitted(ENTERPRISE_ID) })
    // 同步在飞时会话失效（auth 失败 → resetAccountScopedClientState）
    await act(async () => { reauthListener?.({ loggedIn: false, errorCode: 'TOKEN_EXPIRED' }) })
    await waitFor(() => expect(screen.getByLabelText('手机号或用户名')).toBeTruthy())
    await act(async () => {
      releaseStale({ success: true })
      await staleReceipt
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    // 成功回执属于已结束的会话：不得刷新列表、不得改变登录页状态
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByLabelText('手机号或用户名')).toBeTruthy()
  })
})
