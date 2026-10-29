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

describe('App settings keep external terminal setup out of the normal user flow', () => {
  for (const runtime of ['electron', 'web']) {
    it(`does not query or expose terminal setup in ${runtime}`, async () => {
      let statusReads = 0
      getStatus = async () => {
        statusReads++
        throw new Error('terminal checks must be on demand')
      }
      window.electronAPI.getRuntimeEnvironment = () => runtime as 'electron' | 'web'
      renderPage()
      await waitFor(() => {
        expect(screen.getByText('Network')).toBeTruthy()
        expect(screen.getByText('About')).toBeTruthy()
      })
      expect(statusReads).toBe(0)
      expect(screen.queryByText('Polo terminal features')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Enable command' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Disable command' })).toBeNull()
    })
  }
})
