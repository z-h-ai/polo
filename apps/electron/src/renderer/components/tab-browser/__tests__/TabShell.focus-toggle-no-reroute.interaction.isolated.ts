/** POO-209 regression: the sidebar/focus view actions must never re-route the
 * active tab. The production chain is real end-to-end here — TabShellProvider
 * (tab atoms + POO-205 C4 enterprise guard), the real TabShell/TopBar host,
 * the real action registry, the real useAssistantViewActions hook and a
 * button that executes `view.toggleFocusMode` exactly like the chat-header
 * control (ChatPage) and the account menu do. Only the AppShell body is
 * stood-in by the host, since the defect lives one level above it. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
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

const PROJECT_TAB: TabInstance = {
  id: projectTabId('poo209-proj'),
  appId: projectTabId('poo209-proj'),
  type: 'project',
  title: 'Alpha',
  project: {
    projectId: 'poo209-proj',
    name: 'Alpha',
    organizationEnterpriseId: 'ent-1',
    organizationProductSpaceId: 'space-a',
    myRole: 'owner',
  },
}

/** Mutable observation the host writes through; each assertion reads it. */
const observations = { sidebar: 0, focus: 0 }

const { ActionRegistryProvider, useActionRegistry } = await import('@/actions')
const { useAssistantViewActions } = await import('@/hooks/useAssistantViewActions')
const { AppShellProvider } = await import('@/context/AppShellContext')
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { TabShellProvider } = await import('@/context/TabShellContext')
const { TabShell } = await import('../TabShell')
const { TooltipProvider } = await import('@polo-ai/ui')
const { render, screen, cleanup, act } = await import('@testing-library/react')

/** The stand-in assistant surface: the REAL hook, the REAL registry action,
 * and the same execute call the chat-header button makes. */
function AssistantSurfaceHost() {
  const { execute } = useActionRegistry()
  useAssistantViewActions(
    () => { observations.sidebar += 1 },
    () => { observations.focus += 1 },
  )
  return createElement('div', { 'data-testid': 'assistant-surface' },
    createElement('button', {
      'data-testid': 'host-focus-toggle',
      onClick: () => execute('view.toggleFocusMode'),
    }),
    createElement('button', {
      'data-testid': 'host-sidebar-toggle',
      onClick: () => execute('view.toggleSidebar'),
    }),
  )
}

function spaceValue(kind: 'personal' | 'enterprise') {
  return {
    accountId: 'account-a',
    activeProductSpaceId: 'space-a',
    activeProductSpace: { id: 'space-a', kind, ...(kind === 'enterprise' ? { enterpriseId: 'ent-1' } : {}), name: 'Space A' },
    productSpaces: [],
    allProductSpaces: [],
    personalProductSpaceId: 'space-personal',
    productSpaceContextKey: 'account-a|space-a',
    contextVersion: 0,
    pendingSwitch: null,
    unavailableSpaceIds: new Set<string>(),
    spaceSelectionSource: 'fresh',
    error: null,
    bootstrap: async () => 'ready',
    refreshProductSpaces: async () => {},
    retryBootstrap: async () => 'ready',
    requestSwitch: async () => {},
    confirmStopAndSwitch: async () => {},
    retryFailedStops: async () => {},
    retryTargetLoad: async () => {},
    cancelSwitch: async () => {},
    stopSwitchExecution: async () => {},
    dismissTargetAccessLost: () => {},
    clearAccount: () => {},
    rollbackToOrigin: async () => false,
    enterContractBlocked: () => {},
  } as unknown as Parameters<typeof ProductSpaceProvider>[0]['value']
}

function Host({ kind }: { kind: 'personal' | 'enterprise' }) {
  return createElement(ActionRegistryProvider, {
    children: createElement(TooltipProvider, {
      delayDuration: 0,
      children: createElement(AppShellProvider, {
        value: { currentAdminUser: { username: 'member' } } as never,
        children: createElement(ProductSpaceProvider, {
          value: spaceValue(kind),
          children: createElement(TabShellProvider, {
            workspaceId: 'poo209-scope',
            children: createElement(TabShell, {
              renderPolo: () => createElement(AssistantSurfaceHost),
            }),
          }),
        }),
      }),
    }),
  })
}

let spaceKind: 'personal' | 'enterprise' = 'enterprise'

beforeEach(async () => {
  spaceKind = 'enterprise'
  observations.sidebar = 0
  observations.focus = 0
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
      onMenuToggleSidebar: () => () => {},
      onMenuToggleFocusMode: () => () => {},
    },
  })
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

/** Mount the real shell, wait for hydration (it RESETS the tab atoms from the
 * persistence store), then install the strip under test and activate the
 * requested tab. */
async function mountShellWithActiveTab(tabId: string) {
  render(createElement(I18nextProvider, { i18n, children: createElement(Host, { kind: spaceKind }) }))
  await screen.findByTestId('app-topbar')
  await act(async () => {
    getDefaultStore().set(openTabsAtom, tabId === PROJECT_TAB.id ? [POLO_TAB, PROJECT_TAB] : [POLO_TAB])
    getDefaultStore().set(activeTabIdAtom, tabId)
  })
}

async function clickToggle(testId: string) {
  await act(async () => {
    screen.getByTestId(testId).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('POO-209: view actions never re-route the active tab', () => {
  it('focus toggle from an ACTIVE PROJECT tab stays on the project (no Home re-route)', async () => {
    await mountShellWithActiveTab(PROJECT_TAB.id)

    await clickToggle('host-focus-toggle')

    expect(getDefaultStore().get(activeTabIdAtom)).toBe(PROJECT_TAB.id)
    expect(observations.focus).toBe(1)
  })

  it('sidebar toggle from an ACTIVE PROJECT tab stays on the project', async () => {
    await mountShellWithActiveTab(PROJECT_TAB.id)

    await clickToggle('host-sidebar-toggle')

    expect(getDefaultStore().get(activeTabIdAtom)).toBe(PROJECT_TAB.id)
    expect(observations.sidebar).toBe(1)
  })

  it('focus toggle from an enterprise Home does not activate the hidden Polo tab', async () => {
    await mountShellWithActiveTab(HOME_TAB_ID)

    await clickToggle('host-focus-toggle')

    expect(getDefaultStore().get(activeTabIdAtom)).toBe(HOME_TAB_ID)
    expect(getDefaultStore().get(openTabsAtom)).toEqual([POLO_TAB])
    expect(observations.focus).toBe(1)
  })

  it('legacy contract holds: from a personal Home the assistant surfaces before the toggle', async () => {
    spaceKind = 'personal'
    await mountShellWithActiveTab(HOME_TAB_ID)

    await clickToggle('host-focus-toggle')

    expect(getDefaultStore().get(activeTabIdAtom)).toBe(POLO_TAB_ID)
    expect(observations.focus).toBe(1)
  })

  it('legacy contract holds: an already-active assistant surface is untouched', async () => {
    spaceKind = 'personal'
    await mountShellWithActiveTab(POLO_TAB_ID)

    await clickToggle('host-focus-toggle')

    expect(getDefaultStore().get(activeTabIdAtom)).toBe(POLO_TAB_ID)
    expect(observations.focus).toBe(1)
  })
})
