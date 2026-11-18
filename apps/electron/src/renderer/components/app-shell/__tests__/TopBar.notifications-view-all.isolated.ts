/**
 * TopBar notification center — the overflow "view all sessions" entry.
 *
 * The bell list is capped at MAX_NOTIFICATION_ITEMS; when unread sessions
 * exceed the cap a footer entry routes to the sessions navigator (existing
 * allSessions route). With everything already visible there is nothing to
 * "see more" and the entry hides. Shared-process isolated pattern (see
 * TopBar.app-menu.isolated.ts).
 *
 * Run per-file: `bun test apps/electron/src/renderer/components/app-shell/__tests__/TopBar.notifications-view-all.isolated.ts`
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

// Shared-process pattern: register happy-dom only when no window exists and
// pin a macOS userAgent so `isMac`/`isWebUI` stay stable across files.
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

import { POLO_TAB, type TabInstance } from '../../../../shared/tab-browser-types'

interface UnreadMeta {
  id: string
  name: string
  hasUnread: boolean
  lastMessageAt: number
}

// Tests reassign before a fresh render.
let unreadMetas: UnreadMeta[] = []
const sessionMetaMap = () => new Map(unreadMetas.map(meta => [meta.id, meta]))

const activateTabSpy = mock((_tabId: string) => {})

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => ({ resolvedMode: 'light', setMode: () => {} }) }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: {} }))
mock.module('jotai', () => ({ useAtomValue: () => sessionMetaMap(), atom: () => ({}) }))
mock.module('@/context/AppShellContext', () => ({ useOptionalAppShellContext: () => null }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/ProductSpaceContext', () => ({ useOptionalProductSpaceContext: () => null }))
mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    activeTab: POLO_TAB,
    activeTabId: POLO_TAB.id,
    openTabs: [POLO_TAB] as TabInstance[],
    activateHome: () => {},
    activateTab: activateTabSpy,
    closeTab: () => {},
    reorderTabs: () => {},
  }),
}))

// navigate() dispatches a window event; record calls instead. The real routes
// table stays intact so assertions use production route strings.
const navigateMock = mock((_route: string) => {})
const { routes } = await import('../../../../shared/routes')
mock.module('@/lib/navigate', () => ({ navigate: navigateMock, routes, NAVIGATE_EVENT: 'polo-ai-navigate' }))

// The avatar menu has its own coverage in TopBar.app-menu.isolated.ts; stub it
// so its electronAPI probes stay out of this file's scope.
mock.module('@/components/app-menu/WorkbenchAccountMenu', () => ({
  WorkbenchAccountMenu: () => createElement('div', { 'data-testid': 'topbar-account-menu' }),
}))

Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })

const { render, screen, cleanup, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ActionRegistryProvider } = await import('@/actions')
const { TopBar } = await import('../TopBar')

const MAX_NOTIFICATION_ITEMS = 6

function makeUnread(count: number): UnreadMeta[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `sess-${index}`,
    name: `Unread session ${index}`,
    hasUnread: true,
    lastMessageAt: index,
  }))
}

function tree() {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ActionRegistryProvider, null, createElement(TopBar)),
  )
}

async function openNotificationCenter() {
  const user = userEvent.setup()
  await user.click(screen.getByTestId('topbar-notifications'))
  await waitFor(() => screen.getByTestId('topbar-notifications-view-all'))
  return user
}

afterEach(() => {
  cleanup()
  unreadMetas = []
  activateTabSpy.mockClear()
  navigateMock.mockClear()
})

describe('TopBar notification center view-all entry', () => {
  it('offers "view all sessions" when unread sessions overflow the cap, routed through the existing allSessions route', async () => {
    unreadMetas = makeUnread(MAX_NOTIFICATION_ITEMS + 2)
    render(tree())

    const user = await openNotificationCenter()

    await user.click(screen.getByTestId('topbar-notifications-view-all'))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(routes.view.allSessions()))
    // The sessions navigator lives in the Polo tab — brought forward when open.
    expect(activateTabSpy).toHaveBeenCalledWith(POLO_TAB.id)
  })

  it('hides the entry when every unread session already fits the cap (boundary: exactly 6)', async () => {
    unreadMetas = makeUnread(MAX_NOTIFICATION_ITEMS)
    render(tree())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('topbar-notifications'))
    expect(screen.getByText('Unread session 0')).toBeTruthy()
    expect(screen.queryByTestId('topbar-notifications-view-all')).toBeNull()
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('shows plain sessions without the entry when nothing overflows', async () => {
    unreadMetas = makeUnread(2)
    render(tree())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('topbar-notifications'))
    expect(screen.getByText('Unread session 1')).toBeTruthy()
    expect(screen.queryByTestId('topbar-notifications-view-all')).toBeNull()
  })
})
