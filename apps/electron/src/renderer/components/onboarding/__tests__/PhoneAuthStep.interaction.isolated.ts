import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

GlobalRegistrator.register()
setupI18n()

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
mock.module('@/components/ui/styled-dropdown', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  StyledDropdownMenuContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  StyledDropdownMenuItem: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))
mock.module('@/components/ui/menu-context', () => ({
  DropdownMenuProvider: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))
mock.module('@/components/ui/separator', () => ({
  Separator: () => createElement('hr'),
}))
mock.module('@/components/settings', () => ({
  SettingsCard: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  SettingsSection: ({
    children,
    title,
  }: {
    children?: ReactNode
    title?: string
  }) => createElement(
    'section',
    null,
    createElement('h2', null, title),
    children,
  ),
}))

type TestAppShellContext = {
  currentAdminUser?: {
    username: string
    displayName: string | null
  } | null
}

let appShellContext: TestAppShellContext | null = {
  currentAdminUser: {
    username: 'phone_user',
    displayName: null,
  },
}

mock.module('@/context/AppShellContext', () => ({
  useOptionalAppShellContext: () => appShellContext,
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { AdminLoginStep } = await import('../AdminLoginStep')
const { PhoneAuthStep } = await import('../PhoneAuthStep')
const { default: AccountSecuritySettingsPage } = await import(
  '../../../pages/settings/AccountSecuritySettingsPage'
)
const { default: SettingsNavigator } = await import(
  '../../../pages/settings/SettingsNavigator'
)
const { getVisibleSettingsItems } = await import('../../../../shared/menu-schema')

afterEach(() => {
  cleanup()
  appShellContext = {
    currentAdminUser: {
      username: 'phone_user',
      displayName: null,
    },
  }
})

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

describe('PhoneAuthStep rendered interactions', () => {
  it('gates sending on consent, preserves input on failure, and blocks duplicates', async () => {
    let resolveSend!: (result: {
      success: false
      errorCode: 'NETWORK_ERROR'
    }) => void
    const onSendCode = mock(() => new Promise<{
      success: false
      errorCode: 'NETWORK_ERROR'
    }>(resolve => {
      resolveSend = resolve
    }))
    const user = userEvent.setup({ document: window.document })

    renderWithI18n(createElement(PhoneAuthStep, {
      isLoading: false,
      onClearError: mock(() => {}),
      onSendCode,
      onVerify: mock(async () => true),
      onUsePassword: mock(() => {}),
    }))

    const phoneInput = screen.getByLabelText('Phone number')
    const sendButton = screen.getByRole('button', { name: 'Send verification code' })
    fireEvent.change(phoneInput, { target: { value: '+86 138 0013 8000' } })
    expect((phoneInput as HTMLInputElement).value).toBe('13800138000')
    expect((sendButton as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByRole('checkbox'))
    expect((sendButton as HTMLButtonElement).disabled).toBe(false)
    await user.click(sendButton)
    await user.click(sendButton)
    expect(onSendCode).toHaveBeenCalledTimes(1)

    resolveSend({ success: false, errorCode: 'NETWORK_ERROR' })
    await waitFor(() =>
      expect((sendButton as HTMLButtonElement).disabled).toBe(false))
    expect((phoneInput as HTMLInputElement).value).toBe('13800138000')
  })

  it('uses the server countdown, normalizes autofill, verifies, and resets on edit', async () => {
    const onSendCode = mock(async () => ({
      success: true as const,
      accepted: true,
      expiresIn: 300,
      resendAfter: 47,
    }))
    const onVerify = mock(async () => true)
    const user = userEvent.setup({ document: window.document })

    renderWithI18n(createElement(PhoneAuthStep, {
      isLoading: false,
      onClearError: mock(() => {}),
      onSendCode,
      onVerify,
      onUsePassword: mock(() => {}),
    }))

    fireEvent.change(screen.getByLabelText('Phone number'), {
      target: { value: '13800138000' },
    })
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Send verification code' }))

    await waitFor(() => {
      const resend = screen.getByRole('button', { name: 'Resend in 47s' })
      expect((resend as HTMLButtonElement).disabled).toBe(true)
    })
    const codeInput = screen.getByLabelText('Verification code')
    expect(codeInput.getAttribute('autocomplete')).toBe('one-time-code')
    fireEvent.change(codeInput, { target: { value: '12 3a45-67' } })
    expect((codeInput as HTMLInputElement).value).toBe('123456')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onVerify).toHaveBeenCalledWith('13800138000', '123456')

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(
      (screen.getByLabelText('Phone number') as HTMLInputElement).value,
    ).toBe('13800138000')
    expect(screen.queryByLabelText('Verification code')).toBeNull()
  })
})

describe('AdminLoginStep rendered modes', () => {
  it('defaults to phone auth when enabled and switches through the shared tabs', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(AdminLoginStep, {
      phoneAuthEnabled: true,
      onClearError: mock(() => {}),
      onSendPhoneCode: mock(async () => ({
        success: false as const,
        errorCode: 'NETWORK_ERROR',
      })),
      onVerifyPhoneCode: mock(async () => false),
      onSubmit: mock(() => {}),
    }))

    expect(screen.getByLabelText('Phone number')).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')

    await user.click(screen.getByRole('tab', { name: 'Password' }))
    expect(screen.getByLabelText('Phone number or username')).toBeTruthy()
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true')
  })

  it('falls back to password-only mode and submits a legacy username as identifier', async () => {
    const onSubmit = mock(() => {})
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(AdminLoginStep, {
      phoneAuthEnabled: false,
      onClearError: mock(() => {}),
      onSendPhoneCode: mock(async () => ({
        success: false as const,
        errorCode: 'phone_auth_disabled',
      })),
      onVerifyPhoneCode: mock(async () => false),
      onSubmit,
    }))

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    await user.type(screen.getByLabelText('Phone number or username'), ' legacy-user ')
    await user.type(screen.getByLabelText('Password'), 'password-123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onSubmit).toHaveBeenCalledWith('legacy-user', 'password-123')
  })
})

describe('AccountSecuritySettingsPage rendered interactions', () => {
  it('hides the entry and form when Admin is unconfigured or logged out', () => {
    for (const unavailableContext of [null, { currentAdminUser: null }]) {
      appShellContext = unavailableContext
      expect(
        getVisibleSettingsItems(Boolean(appShellContext?.currentAdminUser?.username))
          .some(item => item.id === 'account-security'),
      ).toBe(false)

      const navigator = renderWithI18n(createElement(SettingsNavigator, {
        selectedSubpage: null,
        onSelectSubpage: mock(() => {}),
      }))
      expect(screen.queryByTestId('settings-item-account-security')).toBeNull()
      navigator.unmount()

      const page = renderWithI18n(createElement(AccountSecuritySettingsPage))
      expect(screen.getByTestId('account-security-unavailable')).toBeTruthy()
      expect(screen.queryByLabelText('New password')).toBeNull()
      page.unmount()
    }

    appShellContext = {
      currentAdminUser: {
        username: 'phone_user',
        displayName: null,
      },
    }
    expect(
      getVisibleSettingsItems(true)
        .some(item => item.id === 'account-security'),
    ).toBe(true)
    renderWithI18n(createElement(SettingsNavigator, {
      selectedSubpage: null,
      onSelectSubpage: mock(() => {}),
    }))
    expect(screen.getByTestId('settings-item-account-security')).toBeTruthy()
  })

  it('validates locally, blocks duplicate requests, and clears secrets after success', async () => {
    let resolveRequest!: (result: { success: true }) => void
    const adminSetPassword = mock(() => new Promise<{ success: true }>(resolve => {
      resolveRequest = resolve
    }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { adminSetPassword },
    })
    const user = userEvent.setup({ document: window.document })

    renderWithI18n(createElement(AccountSecuritySettingsPage))
    const passwordInput = screen.getByLabelText('New password')
    const confirmationInput = screen.getByLabelText('Confirm password')
    const submit = screen.getByRole('button', { name: 'Set password' })

    await user.type(passwordInput, 'password-123')
    await user.type(confirmationInput, 'password-456')
    await user.click(submit)
    expect(adminSetPassword).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('The passwords do not match.')

    await user.clear(confirmationInput)
    await user.type(confirmationInput, 'password-123')
    await user.click(submit)
    await user.click(submit)
    expect(adminSetPassword).toHaveBeenCalledTimes(1)
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    resolveRequest({ success: true })
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Password updated.')
    })
    expect((passwordInput as HTMLInputElement).value).toBe('')
    expect((confirmationInput as HTMLInputElement).value).toBe('')
  })
})
