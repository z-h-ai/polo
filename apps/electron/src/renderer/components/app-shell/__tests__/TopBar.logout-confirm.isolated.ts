import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

// Register only when no window exists yet, and pin a macOS userAgent — same
// shared-process pattern as TopBar.app-menu.isolated.ts (happy-dom defaults to
// a Windows UA, which would flip `isMac`/`isWebUI` in @/lib/platform).
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

// UX danger guard coverage: clicking the account menu's "Log out" leaf must
// NOT revoke/logout/clear state directly — it must surface the shared
// ConfirmDialog first, and only the dialog's explicit confirm may fire
// appShell.onAdminLogout. The REAL WorkbenchAccountMenu is rendered (not
// mocked) so the menu-leaf → dialog → logout chain is covered end to end.

const adminLogoutMock = mock(async () => ({ success: true }))
const openSettingsMock = mock(() => {})
const shellMock = {
  currentAdminUser: { displayName: 'Alice', username: 'alice@example.com' },
  onAdminLogout: adminLogoutMock,
  onOpenSettings: openSettingsMock,
}

mock.module('@/context/AppShellContext', () => ({ useOptionalAppShellContext: () => shellMock }))
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
mock.module('@/context/ProductSpaceContext', () => ({ useOptionalProductSpaceContext: () => undefined }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: {} }))
mock.module('jotai', () => ({ useAtomValue: () => new Map(), atom: () => ({}) }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/TabShellContext', () => ({ useTabShell: () => ({
  activeTab: { type: 'home' }, activeTabId: 'home', openTabs: [], activateHome: () => {},
  activateTab: () => {}, closeTab: () => {}, reorderTabs: () => {},
}) }))
mock.module('@/components/product-space/ProductSpaceSwitcher', () => ({
  ProductSpaceSwitcher: () => createElement('div'),
  CurrentProductSpaceLabel: () => createElement('div'),
}))
mock.module('@/actions', () => ({
  useActionLabel: () => ({ hotkey: undefined }),
  useOptionalActionRegistry: () => undefined,
}))
mock.module('@/lib/new-window-request', () => ({ requestNewMainWindow: mock(async () => ({})) }))
mock.module('sonner', () => ({ toast: { error: mock(() => {}), success: mock(() => {}) } }))

const navigateMock = mock(() => {})
const openGlobalSettingsMock = mock(() => {})
const { routes } = await import('../../../../shared/routes')
mock.module('@/lib/navigate', () => ({
  navigate: navigateMock,
  routes,
  NAVIGATE_EVENT: 'polo-ai-navigate',
  openGlobalSettings: openGlobalSettingsMock,
}))

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: { isDebugMode: async () => false, menuNewWindow: mock(async () => ({ ok: true })) },
})

const { render, screen, cleanup } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { TopBar } = await import('../TopBar')

function tree() {
  return createElement(I18nextProvider, { i18n }, createElement(TopBar))
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  adminLogoutMock.mockClear()
  openSettingsMock.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('TopBar logout confirmation (UX danger guard)', () => {
  it('asking first: clicking the account menu Log out leaf opens the confirm dialog and does NOT log out', async () => {
    render(tree())
    await userEvent.setup().click(screen.getByTestId('topbar-account'))

    // The menu leaf names the account in the dialog title, not the leaf itself.
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Log out' }))

    const dialog = await screen.findByTestId('topbar-logout-confirm')
    expect(screen.getByText('Log out Alice?')).toBeTruthy()
    expect(dialog.textContent).toContain('stops any running executions')
    expect(dialog.textContent).toContain("cloud data won't be affected")
    expect(adminLogoutMock).not.toHaveBeenCalled()
  })

  it('cancel never writes: dismissing the dialog leaves the session untouched', async () => {
    render(tree())
    const user = userEvent.setup()
    await user.click(screen.getByTestId('topbar-account'))
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))
    await screen.findByTestId('topbar-logout-confirm')

    await user.click(screen.getByTestId('confirm-dialog-cancel'))

    expect(adminLogoutMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('topbar-logout-confirm')).toBeNull()
  })

  it('confirm is the only path that signs out', async () => {
    render(tree())
    const user = userEvent.setup()
    await user.click(screen.getByTestId('topbar-account'))
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))
    await screen.findByTestId('topbar-logout-confirm')

    await user.click(screen.getByTestId('confirm-dialog-action'))

    expect(adminLogoutMock).toHaveBeenCalledTimes(1)
  })
})
