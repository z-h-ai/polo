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

// UX danger guard coverage: the source page title menu's "Delete" used to
// wipe the source on the first click. Now the click must surface the shared
// ConfirmDialog naming the source and the broken-connections consequence;
// only the dialog's explicit confirm may call deleteSource.

const deleteSourceMock = mock(async (_workspaceId: string, _slug: string) => {})
const navigateToSourceMock = mock(() => {})
const toastSuccessMock = mock((_message: string) => {})
const toastErrorMock = mock((_message: string) => {})

mock.module('@/components/info', () => {
  const Page = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  Page.Header = ({ title, titleMenu }: { title: string; titleMenu?: ReactNode }) =>
    createElement('header', null, title, titleMenu)
  Page.Content = ({ children }: { children?: ReactNode }) =>
    createElement('main', null, children)
  Page.Hero = ({ title, tagline }: { title: string; tagline?: string }) =>
    createElement('section', null, title, tagline)
  const Section = ({ children }: { children?: ReactNode }) =>
    createElement('section', null, children)
  const Alert = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  Alert.Title = ({ children }: { children?: ReactNode }) => createElement('strong', null, children)
  Alert.Description = ({ children }: { children?: ReactNode }) => createElement('p', null, children)
  const Table = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  Table.Row = ({ label, value, children }: {
    label: string
    value?: ReactNode
    children?: ReactNode
  }) => createElement('div', null, label, value, children)
  return {
    Info_Page: Page,
    Info_Section: Section,
    Info_Table: Table,
    Info_Alert: Alert,
    Info_Markdown: ({ children }: { children?: ReactNode }) => createElement('pre', null, children),
    PermissionsDataTable: () => createElement('div'),
    ToolsDataTable: () => createElement('div'),
  }
})
mock.module('@/components/app-shell/SourceMenu', () => ({
  SourceMenu: ({ onDelete }: { onDelete?: () => void }) => (
    createElement('button', { type: 'button', onClick: onDelete }, 'Delete Source')
  ),
}))
mock.module('@/components/ui/source-avatar', () => ({
  SourceAvatar: () => createElement('span'),
}))
mock.module('@/components/ui/EditPopover', () => ({
  EditPopover: ({ trigger }: { trigger?: ReactNode }) => createElement('span', null, trigger),
  EditButton: () => createElement('button', { type: 'button' }, 'Edit'),
  getEditConfig: () => ({}),
}))
mock.module('@/contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigateToSource: navigateToSourceMock }),
}))
mock.module('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}))

const source = {
  config: {
    slug: 'test-source',
    name: 'Test Source',
    tagline: 'A source under test.',
    type: 'api' as const,
    api: { baseUrl: 'https://api.example.test' },
  },
  folderPath: '/workspace-one/sources/test-source',
}

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { default: SourceInfoPage } = await import('../SourceInfoPage')

beforeEach(async () => {
  await i18n.changeLanguage('en')
  deleteSourceMock.mockClear()
  navigateToSourceMock.mockClear()
  toastSuccessMock.mockClear()
  toastErrorMock.mockClear()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getSources: async () => [source],
      getSourcePermissionsConfig: async () => ({}),
      getWorkspaceSettings: async () => ({ localMcpEnabled: true }),
      deleteSource: deleteSourceMock,
    },
  })
})

afterEach(() => {
  cleanup()
})

function renderPage() {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(SourceInfoPage, {
      sourceSlug: 'test-source',
      workspaceId: 'workspace-one',
    }),
  ))
}

describe('SourceInfoPage delete confirmation (UX danger guard)', () => {
  it('asks first: Delete opens a dialog naming the source and its impact, without deleting', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Source' }))

    const dialog = await screen.findByTestId('source-delete-confirm')
    expect(screen.getByText('Delete Test Source?')).toBeTruthy()
    expect(dialog.textContent).toContain('stop working')
    expect(deleteSourceMock).not.toHaveBeenCalled()
  })

  it('cancel never writes: dismissing the dialog keeps the source', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Source' }))
    await screen.findByTestId('source-delete-confirm')

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))

    expect(deleteSourceMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('source-delete-confirm')).toBeNull()
  })

  it('confirm deletes the source and reports success', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Source' }))
    await screen.findByTestId('source-delete-confirm')

    fireEvent.click(screen.getByTestId('confirm-dialog-action'))

    await waitFor(() => expect(deleteSourceMock).toHaveBeenCalledTimes(1))
    expect(deleteSourceMock).toHaveBeenCalledWith('workspace-one', 'test-source')
    expect(toastSuccessMock).toHaveBeenCalledWith('Deleted source: Test Source')
    expect(navigateToSourceMock).toHaveBeenCalledTimes(1)
  })
})
