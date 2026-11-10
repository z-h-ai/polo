import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { getDefaultStore } from 'jotai'
import { I18nextProvider } from 'react-i18next'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom, committedSpaceKindAtom, openTabsAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB, POLO_TAB_ID, projectTabId, type TabInstance } from '../../../../shared/tab-browser-types'

GlobalRegistrator.register()
setupI18n()
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
mock.module('@/pages/settings/settings-pages', () => ({
  getSettingsPageComponent: () => {
    const Stub = () => createElement('div', { 'data-testid': 'settings-page-stub' })
    return Stub
  },
}))
mock.module('../TabContent', () => ({
  TabContent: ({ renderPolo }: { renderPolo: () => ReactNode }) =>
    createElement('div', { 'data-testid': 'tab-content-stub', children: renderPolo() }),
}))

const { TabShell } = await import('../TabShell')
const { TabShellProvider } = await import('@/context/TabShellContext')
const { AppShellProvider } = await import('@/context/AppShellContext')
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { TooltipProvider } = await import('@polo-ai/ui')
const { openGlobalSettings } = await import('@/lib/navigate')
const { render, screen, cleanup, waitFor, act } = await import('@testing-library/react')

const PROJECT_TAB: TabInstance = {
  id: projectTabId('proj-1'),
  appId: projectTabId('proj-1'),
  type: 'project',
  title: 'Alpha',
  project: {
    projectId: 'proj-1',
    name: 'Alpha',
    organizationEnterpriseId: 'ent-1',
    organizationProductSpaceId: 'space-a',
    myRole: 'owner',
  },
}

/** Enterprise committed-space context (POO-205 C4): kind 'enterprise'. */
const ENTERPRISE_VALUE = {
  accountId: 'account-a',
  activeProductSpaceId: 'space-a',
  activeProductSpace: { id: 'space-a', kind: 'enterprise', enterpriseId: 'ent-1', name: 'Ent space' },
  productSpaces: [],
  allProductSpaces: [],
  personalProductSpaceId: 'space-personal',
  productSpaceContextKey: 'account-a|space-a',
  contextVersion: 0,
  pendingSwitch: null,
  onSelectProductSpace: () => {},
  onRefreshProductSpaces: () => {},
  onConfirmStopAndSwitch: () => {},
  onRetryFailedStops: () => {},
  onRetryTargetLoad: () => {},
  onCancelSwitch: () => {},
  onDismissTargetAccessLost: () => {},
  onStopSwitchExecution: () => {},
} as unknown as Parameters<typeof ProductSpaceProvider>[0]['value']

function Host() {
  return createElement(TooltipProvider, {
    delayDuration: 0,
    children: createElement(AppShellProvider, {
      value: { currentAdminUser: { username: 'member' } } as any,
      children: createElement(ProductSpaceProvider, {
        value: ENTERPRISE_VALUE,
        children: createElement(TabShellProvider, {
          workspaceId: 'enterprise-scope-shell',
          children: createElement(TabShell, {
            renderPolo: () => createElement('div', { 'data-testid': 'polo-surface', children: 'polo' }),
          }),
        }),
      }),
    }),
  })
}

beforeEach(async () => {
  localStorage.clear()
  getDefaultStore().set(committedSpaceKindAtom, null)
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

/** Mount, wait for the shell hydration to finish (it RESETS the tab atoms
 * from the persistence store — anything preset before mount is wiped), THEN
 * install the tab strip under test. */
async function mountShell() {
  render(createElement(I18nextProvider, { i18n, children: createElement(Host) }))
  await screen.findByTestId('app-topbar')
  await act(async () => {
    getDefaultStore().set(openTabsAtom, [POLO_TAB, PROJECT_TAB])
  })
}

async function pressDigit(digit: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: digit, metaKey: true, bubbles: true }))
  })
}

it('C4: the enterprise Polo guard snaps a stray Polo activation back to Home', async () => {
  await mountShell()

  await act(async () => { getDefaultStore().set(activeTabIdAtom, POLO_TAB_ID) })
  await waitFor(() => expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID))
})

it('C4 (R6): ⌘2 walks the VISIBLE strip — the hidden Polo tab can never be hit', async () => {
  await mountShell()
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)

  await pressDigit('2')
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(PROJECT_TAB.id)

  await pressDigit('1')
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)

  // ⌘3 is past the (single) visible tab — a no-op, NOT the Polo ghost.
  await pressDigit('3')
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)
})

it('C4 (X1): switching tabs closes the shell global settings surface', async () => {
  await mountShell()

  await act(async () => { openGlobalSettings('app') })
  await screen.findByTestId('global-settings-surface')

  await act(async () => { getDefaultStore().set(activeTabIdAtom, PROJECT_TAB.id) })

  await waitFor(() => expect(screen.queryByTestId('global-settings-surface')).toBeNull(), { timeout: 5000 })
  expect(getDefaultStore().get(activeTabIdAtom)).toBe(PROJECT_TAB.id)
})
