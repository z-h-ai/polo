import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()
// The styled-dropdown re-export pulls the react-pdf overlay whose pdf worker
// `?url` import only resolves under Vite — stub it for the plain bun runner.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))

// UX danger guard coverage for the TopBar browser-instance badge strip:
// 1. "Terminate" must ask first (the shared ConfirmDialog) — it kills the web
//    sessions living in that window; cancel/ESC never destroys.
// 2. Menu actions must not fail silently — focus/terminate failures toast.

const removeInstanceMock = mock((_id: string) => {})
const setInstancesMock = mock((_items: unknown[]) => {})
const updateInstanceMock = mock((_info: unknown) => {})
const setActiveInstanceIdMock = mock((_next: unknown) => {})
const destroyMock = mock(async (_id: string) => {})
const focusMock = mock(async (_id: string) => {})
const toastSuccessMock = mock((_message: string) => {})
const toastErrorMock = mock((_message: string) => {})

const instance = {
  id: 'inst-1',
  title: 'Example',
  url: 'https://example.test/page',
  isLoading: false,
  boundSessionId: 'sess-1',
  ownerSessionId: 'sess-1',
  agentControlActive: false,
}

// BrowserTabStrip reads live instances through jotai atoms. The atom objects
// below are shared between the jotai mock and the browser-pane mock so each
// hook dispatches to its own test double by identity.
const atoms = {
  browserInstances: {},
  activeInstanceId: {},
  setInstances: {},
  updateInstance: {},
  removeInstance: {},
}

mock.module('jotai', () => ({
  useAtomValue: (atomRef: unknown) => (atomRef === atoms.browserInstances ? [instance] : null),
  useSetAtom: (atomRef: unknown) => (
    atomRef === atoms.setInstances ? setInstancesMock
      : atomRef === atoms.updateInstance ? updateInstanceMock
        : atomRef === atoms.removeInstance ? removeInstanceMock
          : undefined
  ),
  useAtom: (atomRef: unknown) => (
    atomRef === atoms.activeInstanceId ? [null, setActiveInstanceIdMock] : [null, () => {}]
  ),
  atom: () => ({}),
}))
mock.module('@/atoms/browser-pane', () => ({
  browserInstancesAtom: atoms.browserInstances,
  activeBrowserInstanceIdAtom: atoms.activeInstanceId,
  setBrowserInstancesAtom: atoms.setInstances,
  updateBrowserInstanceAtom: atoms.updateInstance,
  removeBrowserInstanceAtom: atoms.removeInstance,
  filterInstancesForWorkspace: (items: unknown[]) => items,
}))
mock.module('@/context/AppShellContext', () => ({
  useAppShellContext: () => ({ activeWorkspaceId: 'workspace-one', workspaces: [] }),
}))
mock.module('sonner', () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}))
const navigateMock = mock(() => {})
const { routes } = await import('../../../../shared/routes')
mock.module('@/lib/navigate', () => ({
  navigate: navigateMock,
  routes,
  NAVIGATE_EVENT: 'polo-ai-navigate',
}))

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default

function setApiBehavior(overrides: { destroy?: () => Promise<void>; focus?: () => Promise<void> } = {}) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      isChannelAvailable: () => true,
      browserPane: {
        list: async () => [instance],
        focus: overrides.focus ?? focusMock,
        destroy: overrides.destroy ?? destroyMock,
        onStateChanged: () => () => {},
        onRemoved: () => () => {},
        onInteracted: () => () => {},
      },
    },
  })
}

// Imported after the mocks so the strip binds the mocked atoms/API.
async function mountStrip() {
  const { BrowserTabStrip } = await import('../BrowserTabStrip')
  render(createElement(I18nextProvider, { i18n }, createElement(BrowserTabStrip)))
}

async function openMenuAndClickTerminate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button'))
  await user.click(await screen.findByRole('menuitem', { name: 'Terminate Browser' }))
  await screen.findByTestId('browser-terminate-confirm')
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  destroyMock.mockClear()
  focusMock.mockClear()
  removeInstanceMock.mockClear()
  setInstancesMock.mockClear()
  updateInstanceMock.mockClear()
  setActiveInstanceIdMock.mockClear()
  toastSuccessMock.mockClear()
  toastErrorMock.mockClear()
  setApiBehavior()
})

afterEach(() => {
  cleanup()
})

describe('BrowserTabStrip terminate confirmation and failure toasts (UX danger guard)', () => {
  it('asks first: Terminate opens a confirm dialog naming the consequence, without destroying', async () => {
    await mountStrip()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))
    await user.click(await screen.findByRole('menuitem', { name: 'Terminate Browser' }))

    const dialog = await screen.findByTestId('browser-terminate-confirm')
    expect(screen.getByText('Terminate this browser?')).toBeTruthy()
    expect(dialog.textContent).toContain('will be closed')
    expect(destroyMock).not.toHaveBeenCalled()
    expect(removeInstanceMock).not.toHaveBeenCalled()
  })

  it('cancel never writes: dismissing the dialog keeps the window alive', async () => {
    await mountStrip()
    const user = userEvent.setup()
    await openMenuAndClickTerminate(user)

    await user.click(screen.getByTestId('confirm-dialog-cancel'))

    expect(destroyMock).not.toHaveBeenCalled()
    expect(removeInstanceMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('browser-terminate-confirm')).toBeNull()
  })

  it('confirm destroys the window instance', async () => {
    await mountStrip()
    const user = userEvent.setup()
    await openMenuAndClickTerminate(user)

    await user.click(screen.getByTestId('confirm-dialog-action'))

    await waitFor(() => expect(destroyMock).toHaveBeenCalledWith('inst-1'))
    expect(removeInstanceMock).toHaveBeenCalledWith('inst-1')
  })

  it('focus failure is surfaced with a toast instead of a silent no-op', async () => {
    setApiBehavior({ focus: async () => { throw new Error('focus failed') } })
    await mountStrip()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))
    await user.click(await screen.findByRole('menuitem', { name: 'Show Browser Window' }))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1))
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't show the browser window")
  })

  it('terminate failure is surfaced with a toast', async () => {
    setApiBehavior({ destroy: async () => { throw new Error('destroy failed') } })
    await mountStrip()
    const user = userEvent.setup()
    await openMenuAndClickTerminate(user)

    await user.click(screen.getByTestId('confirm-dialog-action'))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1))
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't terminate the browser window")
  })
})
