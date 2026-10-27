import { beforeEach, describe, expect, test } from 'bun:test'
import type { Message } from '@polo-ai/core/types'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { parseError } from '@polo-ai/shared/agent/errors'
import { handleTypedError } from '../../event-processor/handlers/session'
import type { SessionState } from '../../event-processor/types'
import {
  isKnownChatBillingErrorText,
  localizeChatBillingError,
  localizeChatBillingMessage,
} from '../chat-billing-error'

const raw = '402 POLO_INSUFFICIENT_CREDIT: 余额不足，请充值后重试。'
setupI18n()

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

function liveError(): Message {
  const state: SessionState = {
    session: { id: '261027-vital-oak', messages: [], isProcessing: true } as SessionState['session'],
    streaming: null,
  }
  return handleTypedError(state, {
    type: 'typed_error',
    sessionId: state.session.id,
    error: parseError(new Error(raw)),
  }).state.session.messages.at(-1)!
}

describe('Polo insufficient-credit presentation', () => {
  test('recognizes the observed HTTP 402 wrapper as well as the bare sentinel', () => {
    expect(isKnownChatBillingErrorText(raw)).toBe(true)
    expect(isKnownChatBillingErrorText('  POLO_INSUFFICIENT_CREDIT: blocked')).toBe(true)
    expect(localizeChatBillingError(raw)).toEqual({
      content: '余额不足，请充值后重试。',
      errorTitle: '计费错误',
      errorOriginal: raw,
    })
  })

  test('localizes a real typed_error message and removes credential/retry actions', () => {
    const original = liveError()
    expect(original.errorActions?.[0]?.label).toBe('Update credentials')
    const result = localizeChatBillingMessage(original)
    expect(result.content).toBe('余额不足，请充值后重试。')
    expect(result.errorTitle).toBe('计费错误')
    expect(result.errorActions).toEqual([])
    expect(result.errorCanRetry).toBe(false)
    expect(result.errorOriginal).toBe(raw)
    expect(result.id).toBe(original.id)
    expect(original.content).toContain('Your account has a billing issue')
    expect(original.errorActions?.[0]?.label).toBe('Update credentials')
  })

  test('also localizes the persisted message shape without errorActions on reload', () => {
    const { errorActions: _, ...persisted } = JSON.parse(JSON.stringify(liveError())) as Message
    const result = localizeChatBillingMessage(persisted)
    expect(result.content).toBe('余额不足，请充值后重试。')
    expect(result.errorTitle).toBe('计费错误')
    expect(result.errorOriginal).toBe(raw)
    expect(result.errorActions).toEqual([])
  })

  test('uses the current language for the same stored message and is idempotent', async () => {
    const original = liveError()
    const chinese = localizeChatBillingMessage(original)
    expect(localizeChatBillingMessage(chinese)).toEqual(chinese)
    await i18n.changeLanguage('en')
    const english = localizeChatBillingMessage(original)
    expect(english.content).toBe(i18n.t('billing.insufficientCredit'))
    expect(english.content).not.toBe(chinese.content)
    expect(english.errorTitle).toBe(i18n.t('chat.billingError.title'))
    expect(english.errorActions).toEqual([])
  })

  test('handles plain error messages carrying the sentinel without an original field', () => {
    const result = localizeChatBillingMessage({ id: 'plain', role: 'error', content: raw, timestamp: 0 })
    expect(result.content).toBe('余额不足，请充值后重试。')
    expect(result.errorOriginal).toBe(raw)
    expect(result.errorActions).toEqual([])
  })

  test.each([
    '402 Payment required',
    '401 Unauthorized',
    '429 Rate limited',
    'network timeout',
    'POLO_BILLING_UNAVAILABLE',
    'Some provider says insufficient balance',
    'quoted POLO_INSUFFICIENT_CREDIT: blocked',
    '4020 POLO_INSUFFICIENT_CREDIT: blocked',
  ])('leaves unrelated errors untouched: %s', (text) => {
    expect(isKnownChatBillingErrorText(text)).toBe(false)
    const message: Message = { ...liveError(), content: text, errorOriginal: text }
    expect(localizeChatBillingMessage(message)).toBe(message)
  })

  test('does not treat user or assistant text as a billing error', () => {
    for (const role of ['user', 'assistant'] as const) {
      const message: Message = { id: role, role, content: raw, timestamp: 0 }
      expect(localizeChatBillingMessage(message)).toBe(message)
    }
  })
})
