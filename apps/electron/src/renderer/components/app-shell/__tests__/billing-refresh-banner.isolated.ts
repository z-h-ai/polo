/**
 * POO-177 QUOTA-01/02 — the real banner surface of the manual billing
 * refresh.
 *
 * Runs the REAL ChatInputZone banner over REAL decideChatAccessBanner
 * decisions: the Owner variant carries the recharge handoff PLUS the refresh
 * as its second action, the Member variant carries ONLY the refresh, the
 * in-flight read disables the button with aria-busy and the short "checking"
 * label (no second button, no permanent explainer), a disabled button cannot
 * be double-clicked into a second operation, and the parked draft of a
 * blocked send survives banner interactions.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { Provider as JotaiProvider, createStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()
await i18n.changeLanguage('zh-Hans')

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))
mock.module('@/components/app-shell/input/InputContainer', () => ({
  InputContainer: () => createElement('div', { 'data-testid': 'input-container-stub' }),
}))
mock.module('@/components/app-shell/ActiveOptionBadges', () => ({
  ActiveOptionBadges: () => createElement('div', { 'data-testid': 'active-option-badges-stub' }),
}))
mock.module('@/context/AppShellContext', () => ({
  useOptionalAppShellContext: () => ({}),
  useAppShellContext: () => {
    throw new Error('not used in this test')
  },
}))

const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ChatInputZone } = await import('../input/ChatInputZone')
const { decideChatAccessBanner } = await import('@/lib/chat-access-banner')
const { sendFailureAtomFamily } = await import('@/atoms/sessions')

const SESSION = 'session-banner-1'

function bannerFromDecision(
  issue: string,
  scope: { canOpenPayment: boolean },
  overrides: { pending?: boolean; onSecondaryAction?: () => void; onAction?: () => void } = {},
) {
  const decision = decideChatAccessBanner(
    { issue: issue as never, refreshable: true },
    scope,
  )!
  const { t } = i18n
  return {
    variant: decision.variant,
    message: t(decision.messageKey),
    ...(decision.action === 'recharge'
      ? { actionLabel: t('chat.statusBanner.recharge'), onAction: overrides.onAction ?? (() => {}) }
      : {}),
    ...(decision.secondaryAction === 'recheck-billing'
      ? {
          secondaryActionLabel: t('billingRecheck.action'),
          onSecondaryAction: overrides.onSecondaryAction ?? (() => {}),
          secondaryActionDisabled: overrides.pending ?? false,
          secondaryActionBusy: overrides.pending ?? false,
        }
      : {}),
  }
}

function mount(statusBanner: unknown) {
  const store = createStore()
  // The parked draft of a blocked send — it must survive banner interactions.
  store.set(sendFailureAtomFamily(SESSION), {
    title: i18n.t('chat.sendFailed.title'),
    detail: 'insufficient credit',
    draft: '帮我总结这份周报',
    billingBlocked: true,
  })
  render(createElement(I18nextProvider, {
    i18n,
    children: createElement(JotaiProvider, {
      store,
      children: createElement(ChatInputZone, {
        sessionId: SESSION,
        statusBanner: statusBanner as never,
        inputProps: {
          placeholder: '',
          disabled: true,
          currentModel: '',
          onSubmit: () => {},
          onInputChange: () => {},
        },
      }),
    }),
  }))
  return store
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('billing refresh banner (POO-177 QUOTA-01/02)', () => {
  it('owner variant: recharge handoff plus the refresh second action', () => {
    mount(bannerFromDecision('insufficient-credit', { canOpenPayment: true }))
    expect(screen.getByTestId('chat-status-banner-action')).toBeTruthy()
    expect(screen.getByTestId('chat-status-banner-secondary-action')).toBeTruthy()
  })

  it('member variant: the refresh is the ONLY action — no recharge button', () => {
    mount(bannerFromDecision('insufficient-credit', { canOpenPayment: false }))
    expect(screen.queryByTestId('chat-status-banner-action')).toBeNull()
    expect(screen.getByTestId('chat-status-banner-secondary-action')).toBeTruthy()
  })

  it('canonical budget class: refresh only, honest copy, no recharge for either role', () => {
    for (const canOpenPayment of [true, false]) {
      mount(bannerFromDecision('billing-budget-exhausted', { canOpenPayment }))
      expect(screen.queryByTestId('chat-status-banner-action')).toBeNull()
      expect(screen.getByTestId('chat-status-banner-secondary-action')).toBeTruthy()
      cleanup()
    }
  })

  it('in-flight refresh: disabled, aria-busy, short checking label, no double-fire', () => {
    let clicks = 0
    mount(bannerFromDecision('insufficient-credit', { canOpenPayment: false }, {
      pending: true,
      onSecondaryAction: () => {
        clicks += 1
      },
    }))
    const button = screen.getByTestId('chat-status-banner-secondary-action') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent).toBe(i18n.t('common.checking'))
    // A disabled button cannot start a second operation.
    fireEvent.click(button)
    expect(clicks).toBe(0)
  })

  it('idle refresh: enabled, refresh label, click fires exactly the wired callback', () => {
    let clicks = 0
    mount(bannerFromDecision('insufficient-credit', { canOpenPayment: false }, {
      onSecondaryAction: () => {
        clicks += 1
      },
    }))
    const button = screen.getByTestId('chat-status-banner-secondary-action') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(button.textContent).toBe(i18n.t('billingRecheck.action'))
    act(() => {
      fireEvent.click(button)
    })
    expect(clicks).toBe(1)
  })

  it('the parked draft of the blocked send survives banner interactions', () => {
    let clicks = 0
    const store = mount(bannerFromDecision('insufficient-credit', { canOpenPayment: false }, {
      onSecondaryAction: () => {
        clicks += 1
      },
    }))
    act(() => {
      fireEvent.click(screen.getByTestId('chat-status-banner-secondary-action'))
    })
    const parked = store.get(sendFailureAtomFamily(SESSION))
    expect(clicks).toBe(1)
    expect(parked?.draft).toBe('帮我总结这份周报')
    expect(parked?.billingBlocked).toBe(true)
  })
})
