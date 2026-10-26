import { describe, expect, test } from 'bun:test'
import { setupI18n } from '@polo-ai/shared/i18n'
import { decideChatAccessBanner } from '../chat-access-banner'
import { formatQuotaResetTime } from '../quota-reset-time'
import { isKnownChatBillingErrorText, localizeChatBillingError } from '../chat-billing-error'

// The localization path resolves real keys — initialize the bundled resources
// (synchronous init) exactly like the renderer startup does.
setupI18n()

describe('decideChatAccessBanner (journey #1 classification matrix)', () => {
  test('insufficient credit: owner/personal gets the recharge handoff action', () => {
    const decision = decideChatAccessBanner({ issue: 'insufficient-credit' }, { canOpenPayment: true })
    expect(decision).toMatchObject({
      variant: 'destructive',
      messageKey: 'chat.statusBanner.insufficientCredit',
      action: 'recharge',
    })
    expect(decision?.quotaResetAt).toBeUndefined()
  })

  test('insufficient credit: non-owner member gets contact-an-admin copy and NO action', () => {
    const decision = decideChatAccessBanner({ issue: 'insufficient-credit' }, { canOpenPayment: false })
    expect(decision).toMatchObject({
      variant: 'destructive',
      messageKey: 'chat.statusBanner.insufficientCreditMember',
    })
    expect(decision?.action).toBeUndefined()
  })

  test('insufficient credit never carries a reset promise', () => {
    expect(decideChatAccessBanner({ issue: 'insufficient-credit', quotaResetAt: 123 }, { canOpenPayment: true })?.quotaResetAt).toBeUndefined()
  })

  test('period quota WITH a server-provided reset fact shows the conditional reset copy', () => {
    const decision = decideChatAccessBanner({ issue: 'quota-exhausted', quotaResetAt: 1735689600000 }, { canOpenPayment: true })
    expect(decision).toMatchObject({
      variant: 'destructive',
      messageKey: 'chat.statusBanner.quotaExhaustedWithReset',
      quotaResetAt: 1735689600000,
    })
    expect(decision?.action).toBeUndefined()
  })

  test('plain 429 (no reset fact) stays promise-free', () => {
    const decision = decideChatAccessBanner({ issue: 'quota-exhausted' }, { canOpenPayment: true })
    expect(decision).toMatchObject({
      variant: 'destructive',
      messageKey: 'chat.statusBanner.quotaExhaustedNoReset',
    })
    expect(decision?.quotaResetAt).toBeUndefined()
  })

  test('non-billing issues keep their existing semantics', () => {
    expect(decideChatAccessBanner({ issue: 'no-ai-service' }, { canOpenPayment: true }))
      .toMatchObject({ variant: 'info', messageKey: 'chat.statusBanner.noAiService' })
    expect(decideChatAccessBanner({ issue: 'account-disabled' }, { canOpenPayment: true }))
      .toMatchObject({ variant: 'destructive', messageKey: 'chat.statusBanner.accountDisabled' })
    expect(decideChatAccessBanner({ issue: 'ai-config-syncing' }, { canOpenPayment: false }))
      .toMatchObject({ variant: 'info', messageKey: 'chat.statusBanner.aiConfigSyncing' })
    expect(decideChatAccessBanner({ issue: 'ai-config-sync-failed' }, { canOpenPayment: false }))
      .toMatchObject({ variant: 'destructive', messageKey: 'chat.statusBanner.aiConfigSyncFailed', action: 'retry-ai-config-sync' })
  })

  test('no status renders no banner', () => {
    expect(decideChatAccessBanner(null, { canOpenPayment: true })).toBeNull()
    expect(decideChatAccessBanner(undefined, { canOpenPayment: false })).toBeNull()
  })
})

describe('chat billing error localization (journey #1)', () => {
  test('the POLO_INSUFFICIENT_CREDIT sentinel is a known billing error', () => {
    expect(isKnownChatBillingErrorText('POLO_INSUFFICIENT_CREDIT: Insufficient balance. Recharge to continue.')).toBe(true)
    expect(isKnownChatBillingErrorText('  POLO_INSUFFICIENT_CREDIT: leading space')).toBe(true)
  })

  test('known billing errors localize the bubble and move the raw text to details', () => {
    const raw = 'POLO_INSUFFICIENT_CREDIT: Insufficient balance. Recharge to continue.'
    const localized = localizeChatBillingError(raw)
    // The sentinel must not BE the visible bubble anymore (it rides the
    // collapsible details instead). The exact localized copy is i18n's job.
    const content = typeof localized.content === 'string' ? localized.content : String(localized.content)
    expect(content).not.toContain('POLO_INSUFFICIENT_CREDIT')
    expect(content).not.toBe(raw)
    expect(localized.errorOriginal).toBe(raw)
    expect(localized.errorTitle).toBeDefined()
  })

  test('unknown error text is returned untouched', () => {
    const raw = 'network timeout after 30000ms'
    expect(localizeChatBillingError(raw)).toEqual({ content: raw })
    // Billing-unavailable is a DIFFERENT channel state — never rebranded as
    // insufficient credit here.
    expect(isKnownChatBillingErrorText('POLO_BILLING_UNAVAILABLE')).toBe(false)
  })
})

describe('formatQuotaResetTime', () => {
  test('formats a real epoch without throwing and preserves the point in time', () => {
    const text = formatQuotaResetTime(1735689600000, 'en')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toBe('1735689600000')
  })

  test('falls back to the raw value for junk input', () => {
    expect(formatQuotaResetTime(Number.NaN, 'en')).toBe('NaN')
  })
})
