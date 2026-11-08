import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { atom } from 'jotai'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

// Shared-process pattern (see TopBar.app-menu.isolated.ts): register happy-dom
// only when no window exists and pin a macOS userAgent so `isMac`/`isWebUI`
// stay stable across files in the shared bun process.
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

// --- Controllable tab shell ---------------------------------------------------

import { POLO_TAB, type TabInstance } from '../../../../shared/tab-browser-types'

const activateTabSpy = mock((_tabId: string) => {})
const activateHomeSpy = mock(() => {})

const webAppTab: TabInstance = {
  id: 'webapp-kb',
  appId: 'organization:org-1:app-1',
  type: 'webapp',
  title: 'Knowledge base',
  isLoading: false,
}

let shellTabs: TabInstance[] = [POLO_TAB, webAppTab]
let shellActiveTabId = POLO_TAB.id

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => ({ resolvedMode: 'light', setMode: () => {} }) }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: atom(new Map()) }))
mock.module('@/context/AppShellContext', () => ({ useOptionalAppShellContext: () => null }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/ProductSpaceContext', () => ({ useOptionalProductSpaceContext: () => null }))
mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    activeTab: shellTabs.find(tab => tab.id === shellActiveTabId)
      ?? { id: 'home', appId: 'home', type: 'home', title: 'Home' },
    activeTabId: shellActiveTabId,
    openTabs: shellTabs,
    activateHome: activateHomeSpy,
    activateTab: activateTabSpy,
    closeTab: mock(() => {}),
    reorderTabs: mock(() => {}),
  }),
}))

const navigateMock = mock(() => {})
const { routes } = await import('../../../../shared/routes')
mock.module('@/lib/navigate', () => ({ navigate: navigateMock, routes, NAVIGATE_EVENT: 'polo-ai-navigate' }))

// The avatar menu (WorkbenchAccountMenu, POO-117) has its own coverage in
// TopBar.app-menu.isolated.ts; stub it so its electronAPI probes stay out of
// this file's scope.
mock.module('@/components/app-menu/WorkbenchAccountMenu', () => ({
  WorkbenchAccountMenu: () => createElement('div', { 'data-testid': 'topbar-account-menu' }),
}))

Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })

const { render, screen, cleanup } = await import('@testing-library/react')
const { ActionRegistryProvider } = await import('@/actions')
const { TopBar } = await import('../TopBar')

function tree() {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ActionRegistryProvider, null, createElement(TopBar)),
  )
}

afterEach(() => {
  cleanup()
  activateTabSpy.mockClear()
  activateHomeSpy.mockClear()
  shellTabs = [POLO_TAB, webAppTab]
  shellActiveTabId = POLO_TAB.id
})

// POO-202: the POO-191 brand-slot view controls (sidebar toggle + focus mode)
// moved into the assistant shell itself — sidebar toggle on the navigator
// header, focus mode next to share/close on the chat header. The decorative
// POO-117 brand mark went with them, so the bar opens with the Home tab.
describe('TopBar corner is the Home tab (POO-202)', () => {
  it('P202-01: with the assistant tab active the brand slot is gone — no mark, no view controls', () => {
    render(tree())
    expect(screen.queryByTestId('topbar-brand-slot')).toBeNull()
    expect(screen.queryByTestId('topbar-brand-mark')).toBeNull()
    expect(screen.queryByTestId('topbar-sidebar-toggle')).toBeNull()
    expect(screen.queryByTestId('topbar-focus-toggle')).toBeNull()
  })

  it('P202-02: from a web app tab and from Home the corner stays the Home tab', () => {
    shellActiveTabId = webAppTab.id
    const { unmount } = render(tree())
    expect(screen.queryByTestId('topbar-brand-mark')).toBeNull()
    expect(screen.getByTestId('topbar-home-tab')).not.toBeNull()
    unmount()

    shellActiveTabId = 'home'
    render(tree())
    expect(screen.queryByTestId('topbar-brand-mark')).toBeNull()
    expect(screen.getByTestId('topbar-home-tab')).not.toBeNull()
  })

  it('P202-03: the tab strip is the bar\'s first child, so Home starts right after the traffic lights', () => {
    render(tree())
    const bar = screen.getByTestId('app-topbar')
    const nav = bar.querySelector('nav')
    expect(nav).not.toBeNull()
    expect(nav!.previousElementSibling).toBeNull()
    expect(nav!.firstElementChild?.getAttribute('data-testid')).toBe('topbar-home-tab')
  })
})
