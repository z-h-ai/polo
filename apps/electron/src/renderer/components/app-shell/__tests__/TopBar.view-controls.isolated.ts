import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { atom, getDefaultStore } from 'jotai'
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

// Unlike the other TopBar files, this one keeps REAL jotai: the view controls
// read the workbench-view atoms, so the mock needs a live atom, not a bare Map.
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

const { render, screen, cleanup, fireEvent, act } = await import('@testing-library/react')
const { ActionRegistryProvider, useAction } = await import('@/actions')
const { TopBar } = await import('../TopBar')
const { workbenchFocusModeAtom, workbenchSidebarVisibleAtom } = await import('@/atoms/workbench-view')

// Stands in for the AppShellContent registration (useAssistantViewActions):
// real shell handlers wrap "activate the assistant tab, then toggle" — the
// wrapping itself is covered in useAssistantViewActions.isolated.ts. Here we
// only need the TopBar side to reach exactly these two registry actions.
const sidebarSpy = mock(() => {})
const focusSpy = mock(() => {})

function HandlerHarness() {
  useAction('view.toggleSidebar', sidebarSpy)
  useAction('view.toggleFocusMode', focusSpy)
  return null
}

function tree() {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      ActionRegistryProvider,
      null,
      createElement(HandlerHarness),
      createElement(TopBar),
    ),
  )
}

function resetAtoms() {
  const store = getDefaultStore()
  store.set(workbenchSidebarVisibleAtom, null)
  store.set(workbenchFocusModeAtom, null)
}

afterEach(() => {
  cleanup()
  sidebarSpy.mockClear()
  focusSpy.mockClear()
  activateTabSpy.mockClear()
  activateHomeSpy.mockClear()
  resetAtoms()
  shellTabs = [POLO_TAB, webAppTab]
  shellActiveTabId = POLO_TAB.id
})

describe('TopBar brand-slot view controls (POO-191)', () => {
  it('P191-01: with the assistant tab active the corner is operable — no brand mark', () => {
    render(tree())
    expect(screen.queryByTestId('topbar-brand-mark')).toBeNull()
    expect(screen.getByTestId('topbar-sidebar-toggle')).not.toBeNull()
    expect(screen.getByTestId('topbar-focus-toggle')).not.toBeNull()
  })

  it('P191-06: from a web app tab the corner falls back to the decorative brand mark', () => {
    // Review decision: a visible corner control that hijacks the user into
    // the assistant tab reads as surprising, so the view controls only exist
    // while the shell they drive is on screen.
    shellActiveTabId = webAppTab.id
    render(tree())
    expect(screen.queryByTestId('topbar-brand-mark')).not.toBeNull()
    expect(screen.queryByTestId('topbar-sidebar-toggle')).toBeNull()
    expect(screen.queryByTestId('topbar-focus-toggle')).toBeNull()
  })

  it('P191-07: from Home the corner falls back to the decorative brand mark too', () => {
    shellActiveTabId = 'home'
    render(tree())
    expect(screen.queryByTestId('topbar-brand-mark')).not.toBeNull()
    expect(screen.queryByTestId('topbar-sidebar-toggle')).toBeNull()
  })

  it('P191-08: the brand slot keeps one fixed width, so switching tabs never shifts the bar', () => {
    // The tabs row is flex-1 right after the slot: if the corner changed
    // width between the controls (66px) and the brand mark (~20px), every
    // tab switch would visibly shove the tabs sideways. The slot is pinned
    // to the controls' width in both states.
    shellActiveTabId = POLO_TAB.id
    const { unmount } = render(tree())
    expect(screen.getByTestId('topbar-brand-slot').className).toContain('w-[68px]')
    unmount()

    shellActiveTabId = webAppTab.id
    render(tree())
    expect(screen.getByTestId('topbar-brand-slot').className).toContain('w-[68px]')
    expect(screen.queryByTestId('topbar-brand-mark')).not.toBeNull()
  })

  it('P191-02: the sidebar control executes the registered view.toggleSidebar handler', () => {
    render(tree())
    expect(sidebarSpy).toHaveBeenCalledTimes(0)
    fireEvent.click(screen.getByTestId('topbar-sidebar-toggle'))
    expect(sidebarSpy).toHaveBeenCalledTimes(1)
    expect(focusSpy).toHaveBeenCalledTimes(0)
  })

  it('P191-03: the focus control executes the registered view.toggleFocusMode handler', () => {
    render(tree())
    fireEvent.click(screen.getByTestId('topbar-focus-toggle'))
    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(sidebarSpy).toHaveBeenCalledTimes(0)
  })

  it('P191-04: labels come from the shared menu vocabulary, buttons carry accessible names', () => {
    render(tree())
    expect(screen.getByTestId('topbar-sidebar-toggle').getAttribute('aria-label')).toBe(i18n.t('menu.toggleSidebar'))
    expect(screen.getByTestId('topbar-focus-toggle').getAttribute('aria-label')).toBe(i18n.t('menu.toggleFocusMode'))
  })

  it('P191-05: pressed state mirrors the shell atoms — focus mode owns the sidebar control', () => {
    render(tree())
    // Shell not mounted yet (atoms null): both controls render neutral/off.
    expect(screen.getByTestId('topbar-sidebar-toggle').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('topbar-focus-toggle').getAttribute('aria-pressed')).toBe('false')

    const store = getDefaultStore()
    act(() => {
      store.set(workbenchSidebarVisibleAtom, true)
    })
    expect(screen.getByTestId('topbar-sidebar-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('topbar-focus-toggle').getAttribute('aria-pressed')).toBe('false')

    act(() => {
      store.set(workbenchFocusModeAtom, true)
    })
    // Focus mode hides the sidebar too, so the sidebar control reads off.
    expect(screen.getByTestId('topbar-sidebar-toggle').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('topbar-focus-toggle').getAttribute('aria-pressed')).toBe('true')
  })
})
