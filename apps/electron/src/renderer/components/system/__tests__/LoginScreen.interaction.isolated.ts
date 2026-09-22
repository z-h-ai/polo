import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement, useState } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { LoginScreen } from '../LoginScreen'
import { useAuthFlow, type AuthFlowAdapter } from '@/hooks/useAuthFlow'

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
)
const userEvent = (await import('@testing-library/user-event')).default
const { HandoffPage } = await import('../HandoffPage')

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

function consentAndFillPhone() {
  fireEvent.change(screen.getByLabelText('Phone number'), {
    target: { value: '138 0013 8000' },
  })
}

/** Drives LoginScreen with an external flow so tests can poke at notices. */
function LoginHarness({ adapter }: { adapter?: AuthFlowAdapter }) {
  const flow = useAuthFlow(adapter ? { adapter } : undefined)
  return createElement(
    'div',
    null,
    createElement(LoginScreen, { flow }),
    createElement(
      'button',
      { type: 'button', onClick: () => flow.cancel(), 'data-testid': 'trigger-cancel' },
      'trigger cancel',
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => flow.markSessionExpired(),
        'data-testid': 'trigger-expire',
      },
      'trigger expire',
    ),
  )
}

afterEach(() => {
  cleanup()
})

describe('LoginScreen rendered interactions', () => {
  it('switches between password and verification-code entries', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(LoginScreen))

    expect(screen.getByText('Password sign-in')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: 'Log in with verification code' }),
    )
    expect(screen.getByText('Verification code sign-in')).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Log in with password' }))
    expect(screen.getByText('Password sign-in')).toBeTruthy()
  })

  it('gates continue on a valid phone, consent, and a non-empty password', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(LoginScreen))

    const continueButton = screen.getByRole('button', {
      name: 'Continue',
    }) as HTMLButtonElement
    expect(continueButton.disabled).toBe(true)

    consentAndFillPhone()
    expect(continueButton.disabled).toBe(true)

    await user.click(screen.getByRole('checkbox'))
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe(
      '13800138000',
    )
    // Consent + valid phone are not enough: the password entry stays gated.
    expect(continueButton.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'hunter2' },
    })
    expect(continueButton.disabled).toBe(false)
  })

  it('moves to the code entry with a live resend countdown', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(LoginHarness, {
      adapter: {
        loginWithPassword: async () => ({ ok: true }),
        sendLoginCode: async () => ({
          resendAfterSeconds: 59,
          expiresInSeconds: 300,
        }),
        verifyLoginCode: async () => ({ ok: true }),
        prepareWorkspace: async () => {},
      },
    }))

    consentAndFillPhone()
    await user.click(screen.getByRole('checkbox'))
    await user.click(
      screen.getByRole('button', { name: 'Log in with verification code' }),
    )
    await user.click(screen.getByRole('button', { name: 'Get verification code' }))

    await waitFor(() => {
      expect(screen.getAllByText('Verification code').length).toBeGreaterThan(0)
    })
    expect(
      screen.getByText('Enter the code sent to +86 138 •••• 8000'),
    ).toBeTruthy()
    expect(
      screen.getByText('Valid for 5 min · resend in 59s'),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Resend' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    await user.click(
      screen.getByRole('button', { name: 'Switch to password login' }),
    )
    expect(screen.getByText('Password sign-in')).toBeTruthy()
  })

  it('renders the cancelled notice inline and keeps the entry retryable', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(LoginHarness))

    await user.click(screen.getByTestId('trigger-cancel'))
    expect(
      screen.getByText('Sign-in cancelled. You can sign in again anytime'),
    ).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
    // Still on the password entry and submittable after consent + password.
    consentAndFillPhone()
    await user.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'hunter2' },
    })
    expect(
      (screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('renders the expired-session notice as an inline alert', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(LoginHarness))

    await user.click(screen.getByTestId('trigger-expire'))
    expect(
      screen.getByText('Your session has expired. Please sign in again'),
    ).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('shows a failed code verification inline without any dialog', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(LoginHarness, {
      adapter: {
        loginWithPassword: async () => ({ ok: true }),
        sendLoginCode: async () => ({
          resendAfterSeconds: 59,
          expiresInSeconds: 300,
        }),
        verifyLoginCode: async () => ({ ok: false }),
        prepareWorkspace: async () => {},
      },
    }))

    consentAndFillPhone()
    await user.click(screen.getByRole('checkbox'))
    await user.click(
      screen.getByRole('button', { name: 'Log in with verification code' }),
    )
    await user.click(screen.getByRole('button', { name: 'Get verification code' }))
    await waitFor(() => {
      expect(screen.getByLabelText('Verification code')).toBeTruthy()
    })

    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '824193' },
    })
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(
        screen.getByText("Sign-in didn't complete. Please try again"),
      ).toBeTruthy()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('surfaces a rejected code send inline and stays on the phone entry', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(LoginHarness, {
      adapter: {
        loginWithPassword: async () => ({ ok: true }),
        sendLoginCode: async () => {
          throw new Error('network down')
        },
        verifyLoginCode: async () => ({ ok: true }),
        prepareWorkspace: async () => {},
      },
    }))

    consentAndFillPhone()
    await user.click(screen.getByRole('checkbox'))
    await user.click(
      screen.getByRole('button', { name: 'Log in with verification code' }),
    )
    await user.click(screen.getByRole('button', { name: 'Get verification code' }))

    await waitFor(() => {
      expect(
        screen.getByText("Sign-in didn't complete. Please try again"),
      ).toBeTruthy()
    })
    // Still on the phone entry — no unhandled transition, no dialog.
    expect(screen.getByText('Verification code sign-in')).toBeTruthy()
    expect(screen.queryByLabelText('Verification code')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders nothing once the flow advances past the login steps', async () => {
    const user = userEvent.setup({ document: window.document })
    let resolvePrepare!: () => void
    renderWithI18n(createElement(LoginHarness, {
      adapter: {
        loginWithPassword: async () => ({ ok: true }),
        sendLoginCode: async () => ({
          resendAfterSeconds: 59,
          expiresInSeconds: 300,
        }),
        verifyLoginCode: async () => ({ ok: true }),
        prepareWorkspace: () => new Promise<void>(resolve => { resolvePrepare = resolve }),
      },
    }))

    consentAndFillPhone()
    await user.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'hunter2' },
    })
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      // The parent surface (SystemStatePage / shell) takes over; the split
      // panel is fully unmounted rather than rendering a half state.
      expect(screen.queryByTestId('login-split')).toBeNull()
    })
    resolvePrepare()
  })
})

describe('invite mismatch handoff copy', () => {
  it('uses the mismatch description, not the circle-invite wording', () => {
    renderWithI18n(
      createElement(HandoffPage, {
        layout: 'facts',
        icon: { kind: 'destructive' },
        eyebrow: i18n.t('login.mismatch.eyebrow'),
        title: i18n.t('login.mismatch.title'),
        description: i18n.t('login.mismatch.description'),
        facts: [
          { label: i18n.t('login.mismatch.fact.currentAccount'), value: '+86 138 •••• 8000' },
          { label: i18n.t('login.mismatch.fact.invitedAccount'), value: 'xiaowang@chenxing.com' },
          {
            label: i18n.t('login.mismatch.fact.workspace'),
            value: i18n.t('login.mismatch.fact.workspaceValue'),
          },
        ],
      }),
    )

    expect(
      screen.getByText(
        'Invitations are tied to a specific account — switch to the invited account',
      ),
    ).toBeTruthy()
    // The circle-invite wording must not leak into the mismatch surface.
    expect(
      screen.queryByText(/Review the circle content/),
    ).toBeNull()
    expect(screen.getByText('Please use the account that received the invitation')).toBeTruthy()
  })
})
