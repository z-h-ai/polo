import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

GlobalRegistrator.register()
setupI18n()

mock.module('@polo-ai/ui', () => ({
  Spinner: () => null,
}))

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { OnboardingWizard } = await import('../OnboardingWizard')
import type { OnboardingState } from '../OnboardingWizard'

afterEach(() => {
  cleanup()
  i18n.changeLanguage('en')
})

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

function baseState(step: OnboardingState['step']): OnboardingState {
  return {
    step,
    loginStatus: 'idle',
    credentialStatus: 'idle',
    completionStatus: 'saving',
    apiSetupMethod: null,
    isExistingUser: false,
  }
}

function renderWizard(step: OnboardingState['step'], handlers?: {
  onAdminRelogin?: () => void
  onContinue?: () => void
}) {
  return renderWithI18n(createElement(OnboardingWizard, {
    state: baseState(step),
    onContinue: handlers?.onContinue ?? mock(() => {}),
    onBack: mock(() => {}),
    onSelectApiSetupMethod: mock(() => {}),
    onSubmitCredential: mock(() => {}),
    onFinish: mock(() => {}),
    onAdminLogin: mock(() => {}),
    onAdminSendPhoneCode: mock(async () => ({ success: false as const, errorCode: 'phone_auth_disabled' })),
    onAdminVerifyPhoneCode: mock(async () => false),
    onAdminRelogin: handlers?.onAdminRelogin,
    onBrowseGitBash: mock(async () => null),
    onUseGitBashPath: mock(() => {}),
    onRecheckGitBash: mock(() => {}),
    onClearError: mock(() => {}),
  }))
}

describe('OnboardingWizard dead-step fallback (never a white screen)', () => {
  // useOnboarding can still SET these steps (e.g. step: 'credentials' in the
  // OAuth start path) while the wizard renders none of them.
  for (const deadStep of ['provider-select', 'local-model', 'credentials'] as const) {
    it(`renders the neutral fallback card (not null) for the dead '${deadStep}' step and can escape via relogin`, () => {
      const onAdminRelogin = mock(() => {})
      const { container } = renderWizard(deadStep, { onAdminRelogin })

      expect(screen.getByTestId('onboarding-wizard')).toBeTruthy()
      expect(screen.getByTestId('onboarding-step-fallback')).toBeTruthy()
      expect(container.textContent).toContain('Polo AI')
      expect(container.textContent).toContain('Continue')

      fireEvent.click(screen.getByTestId('onboarding-step-fallback-continue'))
      expect(onAdminRelogin).toHaveBeenCalledTimes(1)
    })
  }

  it('falls back to onContinue when no relogin handler exists', () => {
    const onContinue = mock(() => {})
    renderWizard('credentials', { onContinue })

    fireEvent.click(screen.getByTestId('onboarding-step-fallback-continue'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('still renders the real login step for admin-login (no fallback)', () => {
    renderWizard('admin-login')
    expect(screen.getByTestId('admin-login-step')).toBeTruthy()
    expect(screen.queryByTestId('onboarding-step-fallback')).toBeNull()
  })

  it('renders the rendered steps untouched (welcome → WelcomeStep, complete → CompletionStep)', () => {
    const welcome = renderWizard('welcome')
    expect(screen.queryByTestId('onboarding-step-fallback')).toBeNull()
    expect(welcome.container.textContent.length).toBeGreaterThan(0)
    cleanup()
    const complete = renderWizard('complete')
    expect(screen.queryByTestId('onboarding-step-fallback')).toBeNull()
    expect(complete.container.textContent.length).toBeGreaterThan(0)
  })

  it('forwards the quiet quit-app escape hatch to the login card', () => {
    const onQuitApp = mock(() => {})
    renderWithI18n(createElement(OnboardingWizard, {
      state: baseState('admin-login'),
      onContinue: mock(() => {}),
      onBack: mock(() => {}),
      onSelectApiSetupMethod: mock(() => {}),
      onSubmitCredential: mock(() => {}),
      onFinish: mock(() => {}),
      onAdminLogin: mock(() => {}),
      onAdminSendPhoneCode: mock(async () => ({ success: false as const, errorCode: 'phone_auth_disabled' })),
      onAdminVerifyPhoneCode: mock(async () => false),
      onBrowseGitBash: mock(async () => null),
      onUseGitBashPath: mock(() => {}),
      onRecheckGitBash: mock(() => {}),
      onClearError: mock(() => {}),
      onQuitApp,
    }))

    fireEvent.click(screen.getByTestId('admin-login-quit-app'))
    expect(onQuitApp).toHaveBeenCalledTimes(1)
  })
})
