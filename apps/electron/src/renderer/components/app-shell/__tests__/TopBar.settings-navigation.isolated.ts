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
const { ActionRegistryProvider } = await import('@/actions')
const { render, screen, cleanup, waitFor, act } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const appTab = { id: 'app-tab', appId: 'app', type: 'webapp' as const, title: 'Example App', url: 'https://controlled.example' }
function Host() {
  const tab = useTabShell()
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  if (!tab.isReady) return null
  // POO-125: onOpenSettings is a global entry — it opens the shell-level
  // surface instead of routing the Polo tab, so the host mirrors the surface
  // state independently of the active tab (which must not change).
  return createElement(AppShellProvider, { value: { currentAdminUser: { username: 'member' }, onOpenSettings: () => setGlobalSettingsOpen(true) } as any, children: createElement(ActionRegistryProvider, null, createElement('div', {}, createElement(TopBar), createElement('main', { 'data-testid': 'visible-route' }, globalSettingsOpen ? 'global-settings' : tab.activeTab.type))) })
}
beforeEach(async () => {
  localStorage.clear()
  getDefaultStore().set(openTabsAtom, [POLO_TAB])
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getTabBrowserApps: async () => [], onDeepLinkNavigate: () => () => {}, isDebugMode: async () => false } })
  await i18n.changeLanguage('en')
})
afterEach(cleanup)
for (const from of ['home', 'app'] as const) {
  it(`R8/POO-125 Settings from ${from} opens the global surface without switching tabs`, async () => {
    render(createElement(I18nextProvider, { i18n, children: createElement(TabShellProvider, { workspaceId: 'r8-settings', children: createElement(Host) }) }))
    await screen.findByTestId('app-topbar')
    if (from === 'app') await act(async () => { getDefaultStore().set(openTabsAtom, [POLO_TAB, appTab]); getDefaultStore().set(activeTabIdAtom, appTab.id) })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('topbar-account'))
    await user.click(await screen.findByRole('menuitem', { name: i18n.t('menu.settings') }))
    // The global surface is visible (the host mirrors onOpenSettings) and the
    // carrier tab is left untouched — the top-right entry is global, not an
    // assistant entry.
    await waitFor(() => expect(screen.getByTestId('visible-route').textContent).toBe('global-settings'))
    expect(getDefaultStore().get(activeTabIdAtom)).toBe(from === 'app' ? appTab.id : HOME_TAB_ID)
    expect(getDefaultStore().get(activeTabIdAtom)).not.toBe(POLO_TAB_ID)
  })
}
