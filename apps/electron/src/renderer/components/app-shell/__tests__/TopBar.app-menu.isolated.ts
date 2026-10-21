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

// Context mocks mirror TopBar.product-space-menu.isolated.ts.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => ({ resolvedMode: 'light', setMode: () => {} }) }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: {} }))
mock.module('jotai', () => ({ useAtomValue: () => new Map() }))
mock.module('@/context/AppShellContext', () => ({ useOptionalAppShellContext: () => null }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/TabShellContext', () => ({ useTabShell: () => ({
  activeTab: { type: 'home' }, activeTabId: 'home', openTabs: [], activateHome: () => {},
  activateTab: () => {}, closeTab: () => {}, reorderTabs: () => {},
}) }))

// Capture the props TopBar hands to AppMenu; the component itself has its own
// coverage via the playground and this test only asserts the TopBar wiring.
let appMenuProps: import('@/components/AppMenu').AppMenuProps | null = null
mock.module('@/components/AppMenu', () => ({
  AppMenu: (props: import('@/components/AppMenu').AppMenuProps) => {
    appMenuProps = props
    return createElement('div', { 'data-testid': 'topbar-app-menu' })
  },
}))

// navigate() dispatches a window event; record calls instead. The real routes
// table stays intact so assertions use production route strings.
const navigateMock = mock(() => {})
const { routes } = await import('../../../../shared/routes')
mock.module('@/lib/navigate', () => ({ navigate: navigateMock, routes, NAVIGATE_EVENT: 'polo-ai-navigate' }))

const menuNewWindow = mock(async () => {})
Object.defineProperty(window, 'electronAPI', { configurable: true, value: { menuNewWindow } })

const { render, screen, cleanup } = await import('@testing-library/react')
const { ActionRegistryProvider, useAction } = await import('@/actions')
const { TopBar } = await import('../TopBar')

const toggleSidebarSpy = mock(() => {})
const toggleFocusModeSpy = mock(() => {})

/** Registers action handlers the way AppShell does in production. */
function ActionProbe() {
  useAction('view.toggleSidebar', toggleSidebarSpy)
  useAction('view.toggleFocusMode', toggleFocusModeSpy)
  return null
}

function tree() {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ActionRegistryProvider, null,
      createElement(ActionProbe),
      createElement(TopBar),
    ),
  )
}

afterEach(() => {
  cleanup()
  navigateMock.mockClear()
  menuNewWindow.mockClear()
  toggleSidebarSpy.mockClear()
  toggleFocusModeSpy.mockClear()
})

describe('TopBar mounts the AppMenu (cross-platform application menu)', () => {
  it('renders AppMenu in the left brand slot', () => {
    render(tree())
    expect(screen.getByTestId('topbar-app-menu')).toBeTruthy()
  })

  it('wires menu handlers to the same routes the macOS native-menu broadcasts use', () => {
    render(tree())
    expect(appMenuProps).toBeTruthy()

    // App.tsx onMenuNewChat -> AppShell handleNewChat -> navigate(newSession).
    appMenuProps!.onNewChat!()
    expect(navigateMock).toHaveBeenCalledWith(routes.action.newSession())

    // App.tsx handleOpenSettings → Polo-scope settings, app category.
    appMenuProps!.onOpenSettings!()
    expect(navigateMock).toHaveBeenCalledWith(routes.view.settings('app'))

    // App.tsx onMenuKeyboardShortcuts.
    appMenuProps!.onOpenKeyboardShortcuts!()
    expect(navigateMock).toHaveBeenCalledWith(routes.view.settings('shortcuts'))

    // Settings submenu items navigate to their subpage.
    appMenuProps!.onOpenSettingsSubpage!('appearance')
    expect(navigateMock).toHaveBeenCalledWith(routes.view.settings('appearance'))
  })

  it('wires newWindow to the menuNewWindow RPC (AppShell app.newWindow parity)', () => {
    render(tree())
    appMenuProps!.onNewWindow!()
    expect(menuNewWindow).toHaveBeenCalledTimes(1)
  })

  it('wires view toggles through the action registry handlers AppShell registers', () => {
    render(tree())
    appMenuProps!.onToggleSidebar!()
    expect(toggleSidebarSpy).toHaveBeenCalledTimes(1)
    appMenuProps!.onToggleFocusMode!()
    expect(toggleFocusModeSpy).toHaveBeenCalledTimes(1)
    // Toggle dispatches the action, not a navigation.
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
