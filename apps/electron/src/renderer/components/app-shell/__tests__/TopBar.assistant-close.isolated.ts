import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
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

const closeTabSpy = mock((_tabId: string) => {})
const activateTabSpy = mock((_tabId: string) => {})
const activateHomeSpy = mock(() => {})
const reorderTabsSpy = mock(() => {})

const webAppTab: TabInstance = {
  id: 'webapp-kb',
  appId: 'organization:org-1:app-1',
  type: 'webapp',
  title: 'Knowledge base',
  isLoading: false,
}

// The shell starts with the assistant active; tests flip the active tab by
// reassigning this object before a fresh render.
let shellTabs: TabInstance[] = [POLO_TAB, webAppTab]
let shellActiveTabId = POLO_TAB.id

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => ({ resolvedMode: 'light', setMode: () => {} }) }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: {} }))
mock.module('jotai', () => ({ useAtomValue: () => new Map() }))
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
    closeTab: closeTabSpy,
    reorderTabs: reorderTabsSpy,
  }),
}))

// navigate() dispatches a window event; record calls instead. The real routes
// table stays intact so assertions use production route strings.
const navigateMock = mock(() => {})
const { routes } = await import('../../../../shared/routes')
mock.module('@/lib/navigate', () => ({ navigate: navigateMock, routes, NAVIGATE_EVENT: 'polo-ai-navigate' }))

// AppMenu has its own coverage (TopBar.app-menu.isolated.ts); stub it so the
// real DesktopAppMenu's electronAPI probes stay out of this file's scope.
mock.module('@/components/AppMenu', () => ({
  AppMenu: () => createElement('div', { 'data-testid': 'topbar-app-menu' }),
}))

Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })

const { render, screen, cleanup, fireEvent } = await import('@testing-library/react')
const { ActionRegistryProvider } = await import('@/actions')
const { TopBar } = await import('../TopBar')

function tree() {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ActionRegistryProvider, null, createElement(TopBar)),
  )
}

function tabContainerFor(title: string): HTMLElement {
  const label = screen.getByText(title)
  return label.parentElement!
}

afterEach(() => {
  cleanup()
  closeTabSpy.mockClear()
  activateTabSpy.mockClear()
  activateHomeSpy.mockClear()
  reorderTabsSpy.mockClear()
  navigateMock.mockClear()
  shellTabs = [POLO_TAB, webAppTab]
  shellActiveTabId = POLO_TAB.id
})

describe('TopBar permanent assistant tab (POO-104)', () => {
  it('P104-01: renders the assistant with NO close control in any activation state', () => {
    for (const active of [POLO_TAB.id, webAppTab.id, 'home']) {
      shellActiveTabId = active
      const { unmount } = render(tree())

      const assistantTab = tabContainerFor(POLO_TAB.title)
      expect(assistantTab.tagName).toBe('DIV')
      // No operable close entry at all — no visible X, no focusable button
      // carrying a "close assistant" accessible name, nothing to mis-click.
      expect(assistantTab.querySelectorAll('button')).toHaveLength(0)

      unmount()
    }
  })

  it('P104-01: keeps the regular app close button wired to closeTab', () => {
    render(tree())

    const appTab = tabContainerFor(webAppTab.title)
    const closeButton = appTab.querySelector('button')
    expect(closeButton).toBeTruthy()

    fireEvent.click(closeButton!)
    expect(closeTabSpy).toHaveBeenCalledTimes(1)
    expect(closeTabSpy).toHaveBeenCalledWith(webAppTab.id)
    // The click must not fall through to tab activation.
    expect(activateTabSpy).not.toHaveBeenCalled()
  })

  it('P104-01: the assistant tab still shows icon, title and activation styling', () => {
    render(tree())

    const assistantTab = tabContainerFor(POLO_TAB.title)
    expect(assistantTab.querySelector('img')).toBeTruthy()
    expect(screen.getByText(POLO_TAB.title)).toBeTruthy()
    // Activation marker lives on the container's own click surface.
    fireEvent.click(assistantTab)
    expect(activateTabSpy).toHaveBeenCalledWith(POLO_TAB.id)
  })
})
