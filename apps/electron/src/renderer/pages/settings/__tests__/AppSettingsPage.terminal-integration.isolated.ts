import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

GlobalRegistrator.register()
setupI18n()
await i18n.changeLanguage('en')

mock.module('@polo-ai/ui', () => ({
  Spinner: () => null,
}))
mock.module('@/components/app-shell/PanelHeader', () => ({
  PanelHeader: ({ title }: { title?: string }) => createElement('header', null, title),
}))
mock.module('@/components/ui/HeaderMenu', () => ({
  HeaderMenu: () => null,
}))
mock.module('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))
mock.module('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', { type: 'button', ...props }, children),
}))
mock.module('@/lib/navigate', () => ({
  routes: { view: { settings: () => '/settings/app' } },
}))
mock.module('@/hooks/useUpdateChecker', () => ({
  useUpdateChecker: () => ({
    checkForUpdates: async () => {},
    downloadProgress: 0,
    isDownloading: false,
    updateInfo: null,
  }),
}))
mock.module('@/components/settings', () => ({
  SettingsCard: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  SettingsCardFooter: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  SettingsInput: () => null,
  SettingsRow: ({
    children,
    description,
    label,
  }: {
    children?: ReactNode
    description?: ReactNode
    label?: ReactNode
  }) => createElement(
    'div',
    null,
    createElement('div', null, label),
    createElement('div', null, description),
    children,
  ),
  SettingsSection: ({
    children,
    description,
    title,
  }: {
    children?: ReactNode
    description?: ReactNode
    title?: ReactNode
  }) => createElement(
    'section',
    null,
    createElement('h2', null, title),
    createElement('p', null, description),
    children,
  ),
  SettingsToggle: () => null,
}))

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { default: AppSettingsPage } = await import('../AppSettingsPage')

type StatusResult = Awaited<
  ReturnType<typeof window.electronAPI.getTerminalIntegrationStatus>
>

let getStatus: () => Promise<StatusResult>

function setElectronApi(): void {
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    getBrowserToolEnabled: async () => true,
    getKeepAwakeWhileRunning: async () => false,
    getNetworkProxySettings: async () => ({
      enabled: false,
    }),
    getNotificationsEnabled: async () => true,
    getRuntimeEnvironment: () => 'electron',
    getTerminalIntegrationStatus: () => getStatus(),
    installTerminalIntegration: async () => {
      throw new Error('unexpected install')
    },
    setBrowserToolEnabled: async () => {},
    setKeepAwakeWhileRunning: async () => {},
    setNetworkProxySettings: async () => {},
    setNotificationsEnabled: async () => {},
    uninstallTerminalIntegration: async () => {
      throw new Error('unexpected uninstall')
    },
  }
}

function renderPage(): ReturnType<typeof render> {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(AppSettingsPage) as ReactElement,
    ),
  )
}

beforeEach(() => {
  getStatus = async () => ({
    success: false,
    errorCode: 'status_failed',
    errorParams: { operation: 'status' },
  })
  setElectronApi()
})

afterEach(() => {
  cleanup()
})

describe('App settings terminal integration status failures', () => {
  it('renders a structured initial status failure with a localized retry', async () => {
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Polo terminal features')).toBeTruthy()
      expect(screen.getByText('Terminal feature status unavailable')).toBeTruthy()
      expect(screen.getByText(
        'Polo could not check terminal feature status. Try again.',
      )).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    })
  })

  it('renders a transport rejection through the localized IPC error', async () => {
    getStatus = async () => {
      throw new Error('sensitive transport diagnostic')
    }
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(
        'Polo could not communicate with terminal setup. Try again.',
      )).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    })
    expect(document.body.textContent).not.toContain('sensitive transport diagnostic')
  })

  it('retries a failed status check and replaces the error with ready state', async () => {
    let reads = 0
    getStatus = async () => {
      reads++
      if (reads === 1) {
        return {
          success: false,
          errorCode: 'status_failed',
          errorParams: { operation: 'status' },
        }
      }
      return {
        success: true,
        status: {
          supported: true,
          installed: true,
          pathReady: true,
          needsRepair: false,
          statusCode: 'ready',
          launcherPath: '/Users/test/.local/bin/polo',
        },
      }
    }
    const user = userEvent.setup({ document: window.document })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(screen.getByText('Terminal features installed')).toBeTruthy()
      expect(screen.getByText('Polo terminal features are ready.')).toBeTruthy()
    })
    expect(reads).toBe(2)
    expect(screen.queryByText(
      'Polo could not check terminal feature status. Try again.',
    )).toBeNull()
  })
})
