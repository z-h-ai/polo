import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()
// The styled-dropdown items pull the react-pdf overlay whose pdf worker
// `?url` import only resolves under Vite — stub it for the plain bun runner.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))

// UX danger guard coverage for messaging platforms: the destructive
// "Forget" leaf used to be labeled with the generic "Disconnect" and wiped
// saved credentials (WhatsApp: the pairing itself) on the first click. It
// must now (1) carry its own label, (2) ask before wiping, while the plain
// disconnect stays one-click.

const forgetMock = mock(async (_platform: string) => {})
const disconnectMock = mock(async (_platform: string) => {})
const toastSuccessMock = mock((_message: string) => {})
const toastErrorMock = mock((_message: string) => {})

mock.module('sonner', () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}))
mock.module('@/components/app-shell/PanelHeader', () => ({
  PanelHeader: ({ title }: { title: string }) => createElement('div', null, title),
}))
mock.module('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
mock.module('@/components/settings', () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  SettingsCard: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
mock.module('@/components/messaging/MessagingPlatformIcon', () => ({
  MessagingPlatformIcon: () => createElement('span'),
}))
const dialogStub = () => null
mock.module('@/components/messaging/TelegramConnectDialog', () => ({ TelegramConnectDialog: dialogStub }))
mock.module('@/components/messaging/LarkConnectDialog', () => ({ LarkConnectDialog: dialogStub }))
mock.module('@/components/messaging/TelegramSupergroupPairingDialog', () => ({ TelegramSupergroupPairingDialog: dialogStub }))
mock.module('@/components/messaging/WhatsAppConnectDialog', () => ({ WhatsAppConnectDialog: dialogStub }))
mock.module('@/components/messaging/access', () => ({
  BindingAllowListPopover: () => createElement('span'),
  TelegramAccessSection: () => createElement('div'),
}))
mock.module('@/context/AppShellContext', () => ({
  useActiveWorkspace: () => ({ id: 'workspace-one' }),
}))
mock.module('@/contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigateToSession: mock(() => {}) }),
}))
mock.module('@/utils/session', () => ({
  getSessionTitle: () => 'Session title',
}))
const atoms = { bindings: {}, sessions: {} }
mock.module('@/atoms/messaging', () => ({
  messagingBindingsAtom: atoms.bindings,
  setMessagingBindingsAtom: {},
}))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: atoms.sessions }))
mock.module('jotai', () => ({
  useAtomValue: (atomRef: unknown) => (atomRef === atoms.sessions ? new Map() : []),
  useSetAtom: () => mock((_rows: unknown[]) => {}),
  atom: () => ({}),
}))

const runtime = (platform: string) => ({
  platform,
  configured: true,
  connected: true,
  state: 'connected',
  identity: platform === 'whatsapp' ? '+15550001111' : platform === 'telegram' ? '@bot' : undefined,
  updatedAt: Date.now(),
})

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    getMessagingBindings: async () => [],
    onMessagingBindingChanged: () => () => {},
    onMessagingPlatformStatus: () => () => {},
    getMessagingConfig: async () => ({
      runtime: {
        telegram: runtime('telegram'),
        whatsapp: runtime('whatsapp'),
        lark: runtime('lark'),
      },
    }),
    getMessagingSupergroup: async () => null,
    getMessagingPlatformAccessMode: async () => 'owner-only',
    setMessagingPlatformAccessMode: async () => {},
    disconnectMessagingPlatform: disconnectMock,
    forgetMessagingPlatform: forgetMock,
    unbindMessagingBinding: async () => ({ success: true }),
  },
})

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { default: MessagingSettingsPage } = await import('../MessagingSettingsPage')

/** Rows render in a fixed order: telegram, whatsapp, lark. */
function moreButtonFor(platformRow: number) {
  return screen.getAllByRole('button', { name: 'More' })[platformRow]!
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  forgetMock.mockClear()
  disconnectMock.mockClear()
  toastSuccessMock.mockClear()
  toastErrorMock.mockClear()
})

afterEach(() => {
  cleanup()
})

function renderPage() {
  return render(createElement(I18nextProvider, { i18n }, createElement(MessagingSettingsPage)))
}

describe('MessagingSettingsPage forget confirmation (UX danger guard)', () => {
  it('labels the destructive forget leaf distinctly from plain disconnect', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await waitFor(() => moreButtonFor(1)))
    const menu = await screen.findByRole('menu')
    expect(menu.textContent).toContain('Clear sign-in and disconnect')
    // The generic "Disconnect" label must not be reused by the forget leaf.
    expect(screen.getAllByRole('menuitem', { name: 'Clear sign-in and disconnect' })).toHaveLength(1)
  })

  it('asks before wiping credentials; cancel never forgets', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await waitFor(() => moreButtonFor(1)))
    await user.click(await screen.findByRole('menuitem', { name: 'Clear sign-in and disconnect' }))

    const dialog = await screen.findByTestId('messaging-forget-confirm')
    expect(dialog.textContent).toContain('WhatsApp')
    expect(dialog.textContent).toContain('pairing')

    await user.click(screen.getByTestId('confirm-dialog-cancel'))

    expect(forgetMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('messaging-forget-confirm')).toBeNull()
  })

  it('confirm clears credentials and reports the distinct success', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await waitFor(() => moreButtonFor(1)))
    await user.click(await screen.findByRole('menuitem', { name: 'Clear sign-in and disconnect' }))
    await screen.findByTestId('messaging-forget-confirm')
    await user.click(screen.getByTestId('confirm-dialog-action'))

    await waitFor(() => expect(forgetMock).toHaveBeenCalledWith('whatsapp'))
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1))
    expect(toastSuccessMock).toHaveBeenCalledWith('Cleared WhatsApp sign-in details and disconnected')
  })

  it('plain disconnect stays one-click with no confirmation', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await waitFor(() => moreButtonFor(1)))
    await user.click(await screen.findByRole('menuitem', { name: 'Disable' }))

    await waitFor(() => expect(disconnectMock).toHaveBeenCalledWith('whatsapp'))
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1))
    expect(forgetMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('messaging-forget-confirm')).toBeNull()
  })
})
