import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import { getDefaultStore } from 'jotai'
import { I18nextProvider } from 'react-i18next'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom, openTabsAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB, POLO_TAB_ID } from '../../../../shared/tab-browser-types'
GlobalRegistrator.register()
setupI18n()
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
const { TopBar } = await import('../TopBar')
const { TabShellProvider, useTabShell } = await import('@/context/TabShellContext')
const { AppShellProvider } = await import('@/context/AppShellContext')
const { render, screen, cleanup, waitFor, act } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const appTab = { id: 'app-tab', appId: 'app', type: 'webapp' as const, title: 'Example App', url: 'https://controlled.example' }
function Host() {
  const tab = useTabShell()
  const [route, setRoute] = useState('sessions')
  if (!tab.isReady) return null
  return createElement(AppShellProvider, { value: { currentAdminUser: { username: 'member' }, onOpenSettings: () => setRoute('settings'), onOpenStoredUserPreferences: () => setRoute('settings/preferences') } as any, children: createElement('div', {}, createElement(TopBar), createElement('main', { 'data-testid': 'visible-route' }, tab.activeTab.type === 'polo' ? route : tab.activeTab.type)) })
}
beforeEach(async () => {
  localStorage.clear()
  getDefaultStore().set(openTabsAtom, [POLO_TAB])
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getTabBrowserApps: async () => [], onDeepLinkNavigate: () => () => {} } })
  await i18n.changeLanguage('en')
})
afterEach(cleanup)
for (const from of ['home', 'app'] as const) {
  for (const [label, route] of [['Settings', 'settings'], ['Preferences', 'settings/preferences']] as const) {
    it(`R8 ${label} from ${from} activates its carrier and preserves the requested route`, async () => {
      render(createElement(I18nextProvider, { i18n, children: createElement(TabShellProvider, { workspaceId: 'r8-settings', children: createElement(Host) }) }))
      await screen.findByTestId('app-topbar')
      if (from === 'app') await act(async () => { getDefaultStore().set(openTabsAtom, [POLO_TAB, appTab]); getDefaultStore().set(activeTabIdAtom, appTab.id) })
      const user = userEvent.setup()
      await user.click(screen.getByTestId('topbar-account'))
      await user.click(await screen.findByRole('menuitem', { name: i18n.t(label === 'Settings' ? 'menu.settings' : 'topbar.account.preferences'), exact: true }))
      await waitFor(() => expect(screen.getByTestId('visible-route').textContent).toBe(route))
      expect(getDefaultStore().get(activeTabIdAtom)).toBe(POLO_TAB_ID)
    })
  }
}
