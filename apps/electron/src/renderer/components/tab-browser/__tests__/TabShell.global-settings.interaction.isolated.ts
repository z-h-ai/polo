import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { getDefaultStore } from 'jotai'
import { I18nextProvider } from 'react-i18next'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom, openTabsAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB, POLO_TAB_ID } from '../../../../shared/tab-browser-types'

GlobalRegistrator.register()
setupI18n()
// The home branch (TabContent → ClientHomeRouter) lazily pulls the pdf worker;
// the plain bun runner has no Vite asset pipeline for its `?url` import.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
// Keep the interaction test on TabShell wiring: the details column is stubbed
// (the real pages are covered by their own suites).
mock.module('@/pages/settings/settings-pages', () => ({
  getSettingsPageComponent: () => {
    const Stub = () => createElement('div', { 'data-testid': 'settings-page-stub' })
    return Stub
  },
}))
// Tab content (home branch pulls MemberCatalog + the whole home tree) is not
// under test here — only the shell, the tab atoms and the settings surface.
mock.module('../TabContent', () => ({
  TabContent: ({ renderPolo }: { renderPolo: () => ReactNode }) =>
    createElement('div', { 'data-testid': 'tab-content-stub', children: renderPolo() }),
}))

const { TabShell } = await import('../TabShell')
const { TabShellProvider } = await import('@/context/TabShellContext')
const { AppShellProvider } = await import('@/context/AppShellContext')
const { TooltipProvider } = await import('@polo-ai/ui')
const { openGlobalSettings, GLOBAL_SETTINGS_EVENT, navigate } = await import('@/lib/navigate')
const { render, screen, cleanup, waitFor, act } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default

function Host() {
  return createElement(TooltipProvider, {
    delayDuration: 0,
    children: createElement(AppShellProvider, {
      value: { currentAdminUser: { username: 'member' } } as any,
      children: createElement(TabShellProvider, {
        workspaceId: 'global-settings-surface',
        children: createElement(TabShell, {
          renderPolo: () => createElement('div', { 'data-testid': 'polo-surface', children: 'polo' }),
        }),
      }),
    }),
  })
}

async function openMenuEvent(subpage: unknown) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(GLOBAL_SETTINGS_EVENT, { detail: { subpage } }))
  })
}

beforeEach(async () => {
  localStorage.clear()
  getDefaultStore().set(openTabsAtom, [POLO_TAB])
  getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getTabBrowserApps: async () => [],
      onDeepLinkNavigate: () => () => {},
      isDebugMode: async () => false,
    },
  })
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

it('POO-125: openGlobalSettings shows the shell surface over the active tab without switching tabs', async () => {
  render(createElement(I18nextProvider, { i18n, children: createElement(Host) }))
  await screen.findByTestId('app-topbar')
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)

  await openMenuEvent('app')

  const surface = await screen.findByTestId('global-settings-surface')
  expect(surface).toBeTruthy()
  // Polo scope navigator rows render inside the surface…
  expect(screen.getByTestId('settings-item-app')).toBeTruthy()
  expect(screen.getByTestId('settings-item-shortcuts')).toBeTruthy()
  // …while the assistant assistant shortcut hands off (row present) and the
  // active tab is still Home — the global entry never yanks the user into the
  // assistant tab.
  expect(screen.getByTestId('settings-item-assistant-shortcut')).toBeTruthy()
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)
})

it('POO-125: 返回 closes the surface and the previous surface is unchanged', async () => {
  render(createElement(I18nextProvider, { i18n, children: createElement(Host) }))
  await screen.findByTestId('app-topbar')
  await openMenuEvent('shortcuts')
  await screen.findByTestId('global-settings-surface')

  const user = userEvent.setup()
  await user.click(screen.getByTestId('global-settings-back'))

  await waitFor(() => expect(screen.queryByTestId('global-settings-surface')).toBeNull())
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)
})

it('POO-125: selecting another Polo-scope row switches the subpage inside the surface', async () => {
  render(createElement(I18nextProvider, { i18n, children: createElement(Host) }))
  await screen.findByTestId('app-topbar')
  await openMenuEvent('app')
  await screen.findByTestId('global-settings-surface')

  const user = userEvent.setup()
  await user.click(screen.getByTestId('settings-item-shortcuts'))
  // Re-requesting the open subpage (Cmd+, toggle path) closes the surface…
  await openMenuEvent('shortcuts')
  await waitFor(() => expect(screen.queryByTestId('global-settings-surface')).toBeNull())
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)
})

it('POO-125: a stray Polo-scope settings route still surfaces the global surface (fail-closed)', async () => {
  render(createElement(I18nextProvider, { i18n, children: createElement(Host) }))
  await screen.findByTestId('app-topbar')

  await act(async () => { navigate('settings/appearance') })

  await screen.findByTestId('global-settings-surface')
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)
})

it('POO-125: an assistant-scope settings route keeps surfacing the assistant tab', async () => {
  render(createElement(I18nextProvider, { i18n, children: createElement(Host) }))
  await screen.findByTestId('app-topbar')

  await act(async () => { navigate('settings/preferences') })

  await waitFor(() => expect(getDefaultStore().get(activeTabIdAtom)).toBe(POLO_TAB_ID))
  expect(screen.queryByTestId('global-settings-surface')).toBeNull()
})
