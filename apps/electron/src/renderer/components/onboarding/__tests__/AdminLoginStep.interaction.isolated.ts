import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement, useState } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))


GlobalRegistrator.register()
setupI18n()

mock.module('@polo-ai/ui', () => ({
  Spinner: () => null,
}))

const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { AdminLoginStep } = await import('../AdminLoginStep')
const { AdminLoginMethodSwitch } = await import('../AdminLoginMethodSwitch')
const { LoginTrustRow } = await import('../LoginTrustRow')

const IDENTIFIER_LABEL = 'Phone number or username'
const PASSWORD_LABEL = 'Password'
const CONTINUE_LABEL = 'Continue'

afterEach(() => {
  cleanup()
  i18n.changeLanguage('en')
})

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

function snapshotStorages(): string {
  const dump = (store: Storage) => {
    const entries: string[][] = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key !== null) entries.push([key, store.getItem(key) ?? ''])
    }
    return entries
  }
  return JSON.stringify([dump(window.localStorage), dump(window.sessionStorage)])
}

type HarnessControls = {
  setBusy: (busy: boolean) => void
  setError: (message?: string) => void
}

/**
 * Mirrors the OnboardingWizard contract: the step is a controlled surface —
 * the parent owns `isLoading` and `errorMessage`, the component owns inputs.
 */
function renderLoginHarness(options: {
  phoneAuthEnabled?: boolean | undefined
  isLoading?: boolean
  errorMessage?: string
  onClearError?: () => void
  onSendPhoneCode?: (phone: string) => Promise<
    | { success: true; accepted: true; expiresIn: number; resendAfter: number }
    | { success: false; errorCode: string }
  >
  onVerifyPhoneCode?: (phone: string, code: string) => Promise<boolean>
  onSubmit?: (identifier: string, password: string) => void
}) {
  const controls = {} as HarnessControls

  function Harness() {
    const [isLoading, setIsLoading] = useState(options.isLoading ?? false)
    const [errorMessage, setErrorMessage] = useState<string | undefined>(options.errorMessage)
    controls.setBusy = setIsLoading
    controls.setError = setErrorMessage

    return createElement(AdminLoginStep, {
      errorMessage,
      isLoading,
      phoneAuthEnabled: options.phoneAuthEnabled,
      onClearError: options.onClearError ?? (() => {}),
      onSendPhoneCode:
        options.onSendPhoneCode
        ?? (async () => ({ success: false as const, errorCode: 'phone_auth_disabled' })),
      onVerifyPhoneCode: options.onVerifyPhoneCode ?? (async () => false),
      onSubmit: options.onSubmit ?? (() => {}),
    })
  }

  renderWithI18n(createElement(Harness))
  return controls
}

describe('AdminLoginStep password form interactions', () => {
  it('gates submit on fields and consent, submits trimmed identifier via Enter, and blocks duplicates while busy', async () => {
    const onSubmit = mock(() => {})
    const user = userEvent.setup({ document: window.document })
    renderLoginHarness({ phoneAuthEnabled: false, onSubmit })

    const continueButton = screen.getByRole('button', { name: CONTINUE_LABEL })
    expect((continueButton as HTMLButtonElement).disabled).toBe(true)

    const identifierInput = screen.getByLabelText(IDENTIFIER_LABEL)
    const passwordInput = screen.getByLabelText(PASSWORD_LABEL)
    await user.type(identifierInput, 'legacy-user')
    expect((continueButton as HTMLButtonElement).disabled).toBe(true)

    await user.type(passwordInput, 'password-123')
    expect((continueButton as HTMLButtonElement).disabled).toBe(false)

    // Agreement unchecked must block submission.
    const consent = screen.getByRole('checkbox') as HTMLInputElement
    expect(consent.checked).toBe(true)
    await user.click(consent)
    expect(consent.checked).toBe(false)
    expect((continueButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByTestId('admin-password-login-form'))
    expect(onSubmit).not.toHaveBeenCalled()

    await user.click(consent)
    expect(consent.checked).toBe(true)

    // Keyboard path: implicit form submission from the focused field.
    await user.type(passwordInput, '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('trims the identifier, blocks duplicate submits while busy, and stays on the login entry after failure for retry', async () => {
    const onSubmit = mock((_identifier: string, _password: string) => {})
    const onClearError = mock(() => {})
    const user = userEvent.setup({ document: window.document })
    const controls = renderLoginHarness({
      phoneAuthEnabled: false,
      onClearError,
      onSubmit,
    })

    await user.type(screen.getByLabelText(IDENTIFIER_LABEL), '  legacy-user  ')
    await user.type(screen.getByLabelText(PASSWORD_LABEL), 'password-123')

    const continueButton = screen.getByRole('button', { name: CONTINUE_LABEL })
    await user.click(continueButton)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('legacy-user', 'password-123')

    // Parent flips to the waiting state; repeats are blocked.
    act(() => controls.setBusy(true))
    expect(
      ((await screen.findByRole('button', { name: 'Signing in...' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await user.click(continueButton)
    fireEvent.submit(screen.getByTestId('admin-password-login-form'))
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // Parent reports a failed attempt and leaves the user on the login entry.
    act(() => {
      controls.setBusy(false)
      controls.setError('Invalid credentials. Please try again.')
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Invalid credentials. Please try again.')
    expect(screen.getByTestId('admin-password-login-form')).toBeTruthy()
    expect((screen.getByLabelText(IDENTIFIER_LABEL) as HTMLInputElement).value).toBe(
      '  legacy-user  ',
    )
    expect((screen.getByLabelText(PASSWORD_LABEL) as HTMLInputElement).value).toBe('password-123')

    // Retry works without retyping, and editing clears the error.
    expect(
      (screen.getByRole('button', { name: CONTINUE_LABEL }) as HTMLButtonElement).disabled,
    ).toBe(false)
    await user.click(screen.getByRole('button', { name: CONTINUE_LABEL }))
    expect(onSubmit).toHaveBeenCalledTimes(2)

    fireEvent.change(screen.getByLabelText(IDENTIFIER_LABEL), {
      target: { value: 'legacy-user-2' },
    })
    expect(onClearError).toHaveBeenCalled()
  })

  it('toggles show-password and never persists sensitive input', async () => {
    const onSubmit = mock(() => {})
    const user = userEvent.setup({ document: window.document })
    renderLoginHarness({ phoneAuthEnabled: false, onSubmit })

    const passwordInput = screen.getByLabelText(PASSWORD_LABEL) as HTMLInputElement
    expect(passwordInput.type).toBe('password')

    const storagesBefore = snapshotStorages()

    const toggle = screen.getByRole('button', { name: 'Show password' })
    await user.click(toggle)
    expect(passwordInput.type).toBe('text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeTruthy()

    await user.type(screen.getByLabelText(IDENTIFIER_LABEL), '13800138000')
    await user.type(passwordInput, 'password-123')
    await user.click(screen.getByRole('button', { name: CONTINUE_LABEL }))

    expect(onSubmit).toHaveBeenCalledWith('13800138000', 'password-123')
    expect(snapshotStorages()).toBe(storagesBefore)
  })

  it('switches to the verification-code method, consumes the existing callbacks, and clears the error on switch', async () => {
    const onSendPhoneCode = mock(async () => ({
      success: true as const,
      accepted: true as const,
      expiresIn: 300,
      resendAfter: 47,
    }))
    const onVerifyPhoneCode = mock(async () => true)
    const onClearError = mock(() => {})
    const user = userEvent.setup({ document: window.document })
    renderLoginHarness({
      phoneAuthEnabled: true,
      errorMessage: 'Invalid credentials. Please try again.',
      onClearError,
      onSendPhoneCode,
      onVerifyPhoneCode,
      onSubmit: mock(() => {}),
    })

    // Phone auth enabled defaults to the verification-code scene.
    expect(screen.getByLabelText('Phone number')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Invalid credentials.')

    // Switch to password: clears the stale error, shows the password form.
    await user.click(screen.getByTestId('admin-login-method-password'))
    expect(onClearError).toHaveBeenCalled()
    expect(screen.getByLabelText(IDENTIFIER_LABEL)).toBeTruthy()

    // Switch back to code login and drive the existing callbacks end to end.
    await user.click(screen.getByTestId('admin-login-method-phone'))
    expect(screen.getByLabelText('Phone number')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Phone number'), {
      target: { value: '13800138000' },
    })
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByTestId('phone-auth-send-code'))
    expect(onSendPhoneCode).toHaveBeenCalledWith('13800138000')

    const codeInput = await screen.findByLabelText('Verification code')
    fireEvent.change(codeInput, { target: { value: '123456' } })
    await user.click(screen.getByTestId('phone-auth-continue'))
    expect(onVerifyPhoneCode).toHaveBeenCalledWith('13800138000', '123456')

    // From the code-entry scene the quiet switch returns to the password form.
    await user.click(screen.getByTestId('admin-login-method-password'))
    expect(screen.getByTestId('admin-password-login-form')).toBeTruthy()
    expect(screen.queryByTestId('admin-login-method-password')).toBeNull()
    expect(screen.getByTestId('admin-login-method-phone')).toBeTruthy()
  })

  it('renders the confirmed zh-Hans copy for the password scene', () => {
    i18n.changeLanguage('zh-Hans')
    renderLoginHarness({ phoneAuthEnabled: false })

    expect(screen.getByLabelText('Admin 登录')).toBeTruthy()
    expect(screen.getByLabelText('手机号或用户名')).toBeTruthy()
    expect(screen.getByLabelText('密码')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '显示密码' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: '继续' })).toBeTruthy()
    expect(screen.getByText('同意协议与隐私政策')).toBeTruthy()

    // Password-only fallback: no method switch renders.
    expect(screen.queryByTestId('admin-login-method-phone')).toBeNull()

    cleanup()
    renderLoginHarness({ phoneAuthEnabled: true })
    expect(screen.getByRole('heading', { name: '验证码登录' })).toBeTruthy()
    expect(screen.getByTestId('admin-login-method-password').textContent).toBe('密码登录')
  })
})

describe('AdminLoginStep shared rows', () => {
  it('keeps the trust row interactive and reflects the checked state', async () => {
    const user = userEvent.setup({ document: window.document })
    let checked = true
    function TrustHarness() {
      const [value, setValue] = useState(checked)
      checked = value
      return createElement(
        LoginTrustRow,
        {
          checked: value,
          onCheckedChange: setValue,
          children: 'Agree to the Terms of Service and Privacy Policy',
        },
      )
    }
    renderWithI18n(createElement(TrustHarness))

    const consent = screen.getByTestId('login-trust-consent') as HTMLInputElement
    expect(consent.checked).toBe(true)
    await user.click(consent)
    expect(checked).toBe(false)
  })

  it('renders one quiet switch per target mode', () => {
    renderWithI18n(createElement(AdminLoginMethodSwitch, {
      target: 'phone',
      onSwitch: () => {},
    }))
    expect(screen.getByTestId('admin-login-method-phone')).toBeTruthy()
    expect(screen.getByTestId('admin-login-method-phone').textContent).toBe('Verification code')
  })
})
