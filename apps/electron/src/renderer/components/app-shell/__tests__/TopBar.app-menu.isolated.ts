import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

// Register only when no window exists yet, and pin a macOS userAgent — same
// shared-process pattern as TopBar.registry-poller.test.ts: happy-dom defaults
// to a Windows UA, which would flip `isMac`/`isWebUI` in @/lib/platform for
// every test file running after this one in the shared bun process.
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

// Context mocks mirror TopBar.product-space-menu.isolated.ts. ThemeContext is
// mocked before any importer loads: its module body uses Vite's
// import.meta.glob, which does not exist under bun test.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: {} }))
mock.module('jotai', () => ({ useAtomValue: () => new Map(), atom: () => ({}) }))
mock.module('@/context/AppShellContext', () => ({ useOptionalAppShellContext: () => null }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/TabShellContext', () => ({ useTabShell: () => ({
  activeTab: { type: 'home' }, activeTabId: 'home', openTabs: [], activateHome: () => {},
  activateTab: () => {}, closeTab: () => {}, reorderTabs: () => {},
}) }))

// navigate() dispatches a window event; record calls instead. The real routes
// table stays intact so assertions use production route strings.
const navigateMock = mock(() => {})
const { routes } = await import('../../../../shared/routes')
mock.module('@/lib/navigate', () => ({ navigate: navigateMock, routes, NAVIGATE_EVENT: 'polo-ai-navigate' }))

// Capture the props TopBar hands to the avatar menu; WorkbenchAccountMenu has
// its own coverage (menu-schema-driven rendering) and this file only asserts
// the TopBar wiring — POO-117 moved the app menu into this one component.
let accountMenuProps: { onNewChat: () => void; onNewWindow: () => void } | null = null
mock.module('@/components/app-menu/WorkbenchAccountMenu', () => ({
  WorkbenchAccountMenu: (props: { onNewChat: () => void; onNewWindow: () => void }) => {
    accountMenuProps = props
    return createElement('div', { 'data-testid': 'topbar-account-menu' })
  },
}))

const menuNewWindow = mock(async () => ({ ok: true, diagnostics: {
  source: 'renderer', workspaceId: null, workspaceResolved: false, created: false, visible: true,
} }))
Object.defineProperty(window, 'electronAPI', { configurable: true, value: { menuNewWindow } })

const { render, screen, cleanup } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { TopBar } = await import('../TopBar')

function tree() {
  return createElement(I18nextProvider, { i18n }, createElement(TopBar))
}

/** Radix mounts dropdown content on open — the avatar menu needs a click. */
async function openAccountMenu() {
  render(tree())
  await userEvent.setup().click(screen.getByTestId('topbar-account'))
  await screen.findByTestId('topbar-account-menu')
}

afterEach(() => {
  cleanup()
  navigateMock.mockClear()
  menuNewWindow.mockClear()
})

describe('TopBar brand slot and avatar menu (POO-117, POO-191)', () => {
  it('POO-191: from Home the corner is the POO-117 brand mark — view controls need the assistant tab', () => {
    // This file's TabShell mock pins the Home tab as active. Per the POO-191
    // review decision the view controls only render while the assistant tab
    // is active; every other tab falls back to the decorative brand mark.
    render(tree())
    expect(screen.queryByTestId('topbar-brand-mark')).not.toBeNull()
    expect(screen.queryByTestId('topbar-sidebar-toggle')).toBeNull()
    expect(screen.queryByTestId('topbar-focus-toggle')).toBeNull()
    // The dropdown trigger of the former AppMenu stays gone.
    expect(screen.queryByTestId('topbar-app-menu')).toBeNull()
  })

  it('mounts WorkbenchAccountMenu inside the avatar dropdown', async () => {
    await openAccountMenu()
    expect(accountMenuProps).toBeTruthy()
  })

  it('wires newChat to the same global navigate event the assistant tab surfaces on', async () => {
    await openAccountMenu()
    accountMenuProps!.onNewChat()
    expect(navigateMock).toHaveBeenCalledWith(routes.action.newSession())
  })

  it('wires newWindow to the outcome-checked menuNewWindow RPC', async () => {
    await openAccountMenu()
    accountMenuProps!.onNewWindow()
    // The handler is async (fire-and-forget); the RPC call itself is sync.
    expect(menuNewWindow).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(menuNewWindow).toHaveBeenCalledTimes(1)
  })
})
