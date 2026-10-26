/** POO-144 fix r1: ChatPage owns the issue→banner mapping for the two space
 * AI-config sync states (r1 review: the mapping had no runtime evidence) and
 * the `isChatInputDisabled = !!inputStatusBanner` input-blocking rule. The
 * ChatDisplay subtree is replaced by a shim that forwards statusBanner and
 * disabled into the REAL ChatInputZone, so the retry click is the real
 * button→onAction→onRetryAiConfigSync link (distinct from the
 * polo:product-space-changed event path the App-level tests drive). All other
 * heavy dependencies are stubbed at the module edge. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, forwardRef, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { atom } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { Session } from '../../shared/types'

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
mock.module('@/components/app-shell/input/InputContainer', () => ({
  InputContainer: (props: Record<string, unknown>) =>
    createElement('div', { 'data-testid': 'input-container-stub', 'data-disabled': String(props.disabled ?? 'false') }),
}))
mock.module('@/components/app-shell/ActiveOptionBadges', () => ({
  ActiveOptionBadges: () => createElement('div', { 'data-testid': 'active-option-badges-stub' }),
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))
// ThemeContext reads import.meta.glob (Vite-only) at module scope — stub it
// the same way the App-level journeys do.
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
mock.module('@/lib/perf', () => ({
  rendererPerf: { startSessionSwitch: () => {}, markSessionSwitch: () => {}, endSessionSwitch: () => {} },
}))
// ChatPage resolves this atom write on mount; the real write hits the session
// loader — not under test here. Everything else stays REAL (ChatInputZone now
// also imports the per-session goal atoms and AppShellContext's
// sessionAtomFamily, so a partial mock would break unrelated consumers).
const realSessionAtoms = await import('@/atoms/sessions')
mock.module('@/atoms/sessions', () => ({
  ...realSessionAtoms,
  loadedSessionsAtom: atom(new Set<string>()),
  sessionMetaMapAtom: atom(new Map()),
  ensureSessionMessagesLoadedAtom: atom(null, async (_get: unknown, _set: unknown, sessionId: string) => ({ id: sessionId })),
  forceSessionMessagesReloadAtom: atom(null, async (_get: unknown, _set: unknown, sessionId: string) => ({ id: sessionId })),
}))
mock.module('@/components/app-shell/PanelHeader', () => ({
  PanelHeader: ({ title }: { title?: string }) => createElement('div', { 'data-testid': 'panel-header-stub' }, title),
}))
mock.module('@/components/app-shell/SessionMenu', () => ({ SessionMenu: () => null }))
mock.module('@/components/app-shell/CompactSessionMenu', () => ({ CompactSessionMenu: () => null }))
mock.module('@/components/app-shell/SessionInfoPopover', () => ({ SessionInfoPopover: () => null }))
mock.module('@/components/ui/rename-dialog', () => ({ RenameDialog: () => null }))
mock.module('@/components/ui/PanelHeaderCenterButton', () => ({
  PanelHeaderCenterButton: () => createElement('div', { 'data-testid': 'panel-header-center-button-stub' }),
}))
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
mock.module('@/components/ui/styled-dropdown', () => ({
  StyledDropdownMenuContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyledDropdownMenuItem: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyledDropdownMenuSeparator: () => createElement('div', null),
}))

// Real ChatInputZone — loaded before the ChatDisplay shim so the shim's
// factory can forward into it at ChatPage's import time.
const { ChatInputZone } = await import('../components/app-shell/input/ChatInputZone')
type ChatInputStatusBanner = import('../components/app-shell/input/ChatInputZone').ChatInputStatusBanner

mock.module('@/components/app-shell/ChatDisplay', () => ({
  ChatDisplay: forwardRef(function ChatDisplayShim(props: Record<string, unknown>) {
    return createElement(ChatInputZone, {
      sessionId: String((props.session as { id: string }).id),
      showOptionBadges: false,
      statusBanner: (props.inputStatusBanner ?? null) as ChatInputStatusBanner | null,
      inputProps: {
        placeholder: '',
        disabled: props.disabled === true,
        currentModel: String(props.currentModel ?? ''),
        onSubmit: () => {},
        onInputChange: () => {},
      },
    })
  }),
}))

/** Mutable fixtures — each test pins the issue and retry spy before render. */
const SESSION_FIXTURE = {
  id: 'sync-banner-chatpage-session',
  workspaceId: 'ws-sync-banner-unit',
  name: '同步横幅单元会话',
  messages: [],
  messageCount: 0,
  sessionStatus: 'todo',
} as unknown as Session

let chatAccessIssue: string | null = null
let onRetryAiConfigSync: () => void = () => {}

// Every callback is a module-level stable reference: ChatPage wires several of
// them into effect deps, and per-render inline closures re-trigger those
// effects (Maximum update depth exceeded).
const noop = () => {}
const BASE_CONTEXT = {
  activeWorkspaceId: 'ws-sync-banner-unit',
  llmConnections: [] as unknown[],
  workspaceDefaultLlmConnection: undefined,
  chatAccessStatus: null,
  onRetryAiConfigSync: () => onRetryAiConfigSync(),
  onSendMessage: noop,
  onOpenFile: noop,
  onOpenUrl: noop,
  workspaces: [] as unknown[],
  onRespondToPermission: noop,
  onRespondToCredential: noop,
  onRespondToQuestion: noop,
  onMarkSessionRead: noop,
  onMarkSessionUnread: noop,
  onSetActiveViewingSession: noop,
  getDraft: () => '',
  hydrateDraftAttachments: async () => [],
  onInputChange: noop,
  onAttachmentsChange: noop,
  enabledSources: [] as unknown[],
  skills: [] as unknown[],
  labels: [] as unknown[],
  onSessionLabelsChange: noop,
  enabledModes: [] as unknown[],
  sessionStatuses: [] as unknown[],
  onSessionSourcesChange: noop,
  onRenameSession: noop,
  onFlagSession: noop,
  onUnflagSession: noop,
  onArchiveSession: noop,
  onUnarchiveSession: noop,
  onSessionStatusChange: noop,
  onDeleteSession: noop,
  rightSidebarButton: null,
  leadingAction: null,
  isCompactMode: false,
  sessionListSearchQuery: '',
  isSearchModeActive: false,
  chatDisplayRef: null,
  onChatMatchInfoChange: noop,
  isFocusedPanel: true,
}

mock.module('@/context/AppShellContext', () => ({
  AppShellProvider: ({ children }: { children?: unknown }) => children ?? null,
  useAppShellContext: () => ({
    ...BASE_CONTEXT,
    chatAccessStatus: chatAccessIssue === null ? null : { issue: chatAccessIssue },
  }),
  useSession: () => SESSION_FIXTURE,
  useSessionOptionsFor: () => ({
    options: { permissionMode: 'ask' },
    setOption: noop,
    setOptions: noop,
    setPermissionMode: noop,
    isSafeModeActive: () => false,
  }),
  usePendingPermission: () => undefined,
  usePendingCredential: () => undefined,
  usePendingQuestion: () => undefined,
}))

window.electronAPI = {
  getWindowFocusState: async () => true,
  onWindowFocusChange: () => () => {},
} as unknown as typeof window.electronAPI

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { default: ChatPage } = await import('../pages/ChatPage')

beforeEach(async () => {
  cleanup()
  chatAccessIssue = null
  onRetryAiConfigSync = () => {}
  await i18n.changeLanguage('zh-Hans')
})

afterEach(() => {
  cleanup()
})

function renderChatPage() {
  render(createElement(I18nextProvider, { i18n }, createElement(ChatPage, { sessionId: SESSION_FIXTURE.id })))
}

describe('ChatPage issue→横幅映射 × 空间 AI 配置同步（POO-144）', () => {
  it('ai-config-syncing 映射 info 横幅（同步文案），且输入容器经 isChatInputDisabled 阻断', () => {
    chatAccessIssue = 'ai-config-syncing'
    renderChatPage()
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('正在同步空间 AI 配置…')
    expect(banner.className).toContain('text-info')
    expect(screen.queryByTestId('chat-status-banner-action')).toBeNull()
    expect(screen.getByTestId('input-container-stub').getAttribute('data-disabled')).toBe('true')
  })

  it('ai-config-sync-failed 映射 destructive 横幅（失败文案）并带重试按钮，输入容器同样阻断', () => {
    chatAccessIssue = 'ai-config-sync-failed'
    renderChatPage()
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('AI 配置同步失败')
    expect(banner.className).toContain('text-destructive')
    expect(screen.getByTestId('chat-status-banner-action').textContent).toBe('重试')
    expect(screen.getByTestId('input-container-stub').getAttribute('data-disabled')).toBe('true')
  })

  it('重试按钮真实链路：ChatInputZone 按钮 click → ChatPage onAction → onRetryAiConfigSync', () => {
    chatAccessIssue = 'ai-config-sync-failed'
    const retry = mock(() => {})
    onRetryAiConfigSync = retry
    renderChatPage()
    fireEvent.click(screen.getByTestId('chat-status-banner-action'))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('无门禁 issue 时不渲染横幅，输入容器保持可用（isChatInputDisabled = false）', () => {
    renderChatPage()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByTestId('input-container-stub').getAttribute('data-disabled')).toBe('false')
  })

  it('既有映射不回归：no-ai-service 仍渲染其专属文案', () => {
    chatAccessIssue = 'no-ai-service'
    renderChatPage()
    expect(screen.getByRole('status').textContent).toContain('管理员尚未为你配置 AI 服务，暂时无法发送消息')
  })
})
