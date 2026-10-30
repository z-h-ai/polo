import { describe, it, expect, beforeAll, afterEach, mock, setDefaultTimeout } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// The panel's search flow drives user-event interactions against happy-dom.
setDefaultTimeout(30_000)

if (typeof window === 'undefined') GlobalRegistrator.register()

// SessionFilesSection (on the import graph) calls this at module load.
;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  getRuntimeEnvironment: () => 'desktop',
}

import { createElement } from 'react'

// ListPanel reads workspaces/activeWorkspaceId from the shell context; the
// search wiring under test does not touch any of its other members. The mock
// keeps every exported name — siblings on the import graph pull the optional
// variant and the session helpers.
const shellStub = { workspaces: [], activeWorkspaceId: 'ws-fixture' }
mock.module('@/context/AppShellContext', () => ({
  AppShellProvider: ({ children }: { children?: unknown }) => children,
  useAppShellContext: () => shellStub,
  useOptionalAppShellContext: () => shellStub,
  useSession: () => null,
  useActiveWorkspace: () => null,
  usePendingPermission: () => undefined,
  usePendingCredential: () => undefined,
  usePendingQuestion: () => undefined,
  useSessionOptionsFor: () => ({ sessionOptions: null, onSessionOptionsChange: () => {} }),
}))
// ThemeContext's module body uses Vite-only import.meta.glob (theme JSONs);
// keep every exported name — siblings pull the optional variant.
const themeStub = { isDark: false }
mock.module('@/context/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children?: unknown }) => children,
  useTheme: () => themeStub,
  useOptionalTheme: () => themeStub,
}))

// Edge stubs (shared-process pattern): the import graph pulls Vite-only
// pdfjs `?url` and Sentry transitively; neither participates in the search
// contract under test.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))

const { render, cleanup, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { I18nextProvider } = await import('react-i18next')
const { setupI18n, i18n } = await import('@polo-ai/shared/i18n')
const { TooltipProvider } = await import('@polo-ai/ui')
const { AutomationsListPanel } = await import('../AutomationsListPanel')
import type { AutomationListItem } from '../types'

const L = (key: string) => i18n.t(key)

// Stored automation records: `event`/`name` are protocol/user data and must
// survive search filtering untouched in any language.
const items: AutomationListItem[] = [
  { id: 'acc-auto-a', event: 'SchedulerTick', matcherIndex: 0, name: '定时备份', summary: 'nightly backup', enabled: true, actions: [] },
  { id: 'acc-auto-b', event: 'LabelAdd', matcherIndex: 0, name: 'Label watcher', summary: 'watches labels', enabled: false, actions: [] },
]

const storedSnapshot = JSON.stringify(items)

function mountPanel() {
  let clickedId: string | null = null
  render(
    createElement(I18nextProvider, { i18n }, createElement(TooltipProvider, null,
      createElement(AutomationsListPanel, {
        automations: items,
        onAutomationClick: (id: string) => { clickedId = id },
      })),
    ),
  )
  return () => clickedId
}

beforeAll(async () => {
  await setupI18n()
})

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('en')
})

describe('AutomationsListPanel localized display-name search (POO-179 F-I18N-AUTOMATION-NAMES)', () => {
  it('opens the search header from the panel trigger and hits rows by zh-Hans display name', async () => {
    void i18n.changeLanguage('zh-Hans')
    const user = userEvent.setup()
    const getClicked = mountPanel()

    // Both rows render; the localized event display name is visible on rows.
    expect(screen.getByText('定时备份')).toBeTruthy()
    expect(screen.getByText('Label watcher')).toBeTruthy()
    expect(screen.getByText(L('automations.event.SchedulerTick'))).toBeTruthy()

    // Reachability: the panel-local trigger opens the search header...
    await user.click(screen.getByRole('button', { name: L('sidebar.search') }))
    const input = await waitFor(() =>
      screen.getByPlaceholderText(L('automations.searchPlaceholder')) as HTMLInputElement)

    // ...and searching the localized event display name narrows to its row.
    await user.type(input, L('automations.event.SchedulerTick'))
    expect(screen.getByText('定时备份')).toBeTruthy()
    expect(screen.queryByText('Label watcher')).toBeNull()
    await user.click(screen.getByText('定时备份'))
    expect(getClicked()).toBe('acc-auto-a')

    // Stored records are untouched by filtering — display/values decoupled.
    expect(JSON.stringify(items)).toBe(storedSnapshot)
  })

  it('matches localized names in en and keeps stored names searchable verbatim', async () => {
    void i18n.changeLanguage('en')
    const user = userEvent.setup()
    mountPanel()

    await user.click(screen.getByRole('button', { name: L('sidebar.search') }))
    const input = await waitFor(() =>
      screen.getByPlaceholderText(L('automations.searchPlaceholder')) as HTMLInputElement)

    // en display name of SchedulerTick matches the same row.
    await user.type(input, L('automations.event.SchedulerTick'))
    expect(screen.getByText('定时备份')).toBeTruthy()
    expect(screen.queryByText('Label watcher')).toBeNull()

    // A stored user-set name is searchable as-is in any language.
    await user.clear(input)
    await user.type(input, '定时备份')
    expect(screen.getByText('定时备份')).toBeTruthy()
    expect(screen.queryByText('Label watcher')).toBeNull()

    expect(JSON.stringify(items)).toBe(storedSnapshot)
  })

  it('restores the full list after closing search', async () => {
    void i18n.changeLanguage('zh-Hans')
    const user = userEvent.setup()
    mountPanel()

    await user.click(screen.getByRole('button', { name: L('sidebar.search') }))
    const input = await waitFor(() =>
      screen.getByPlaceholderText(L('automations.searchPlaceholder')) as HTMLInputElement)
    await user.type(input, L('automations.event.SchedulerTick'))
    expect(screen.queryByText('Label watcher')).toBeNull()

    await user.click(screen.getByRole('button', { name: L('session.closeSearch') }))
    expect(screen.getByText('定时备份')).toBeTruthy()
    expect(screen.getByText('Label watcher')).toBeTruthy()
    expect(screen.queryByPlaceholderText(L('automations.searchPlaceholder'))).toBeNull()
    expect(JSON.stringify(items)).toBe(storedSnapshot)
  })
})
