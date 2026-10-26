import { describe, expect, test } from 'bun:test'
import { getErrorText, isQuotaExhaustedError, readErrorField } from '../quota-error'

describe('isQuotaExhaustedError', () => {
  test('recognizes gateway dialect quota_exhausted/budget_exhausted regardless of case', () => {
    expect(isQuotaExhaustedError({ errorCode: 'quota_exhausted' })).toBe(true)
    expect(isQuotaExhaustedError({ errorCode: 'budget_exhausted' })).toBe(true)
    expect(isQuotaExhaustedError({ code: 'QUOTA_EXHAUSTED' })).toBe(true)
    expect(isQuotaExhaustedError({ code: 'BUDGET_EXHAUSTED' })).toBe(true)
  })

  test('keeps the legacy spellings and 429 fallback', () => {
    expect(isQuotaExhaustedError({ errorCode: 'insufficient_quota' })).toBe(true)
    expect(isQuotaExhaustedError({ status: 429 })).toBe(true)
    expect(isQuotaExhaustedError(new Error('本月额度已用完'))).toBe(true)
  })

  test('insufficient_credit stays out of the chat-path code table (broker/admin layers own it)', () => {
    expect(isQuotaExhaustedError({ errorCode: 'insufficient_credit' })).toBe(false)
  })

  test('does not misclassify unrelated errors', () => {
    expect(isQuotaExhaustedError({ errorCode: 'kb_service_unavailable', message: 'knowledge base unavailable' })).toBe(false)
    expect(isQuotaExhaustedError(new Error('network timeout'))).toBe(false)
    expect(isQuotaExhaustedError(undefined)).toBe(false)
  })
})

describe('error field helpers', () => {
  test('readErrorField reads only plain-object fields', () => {
    expect(readErrorField({ errorCode: 'x' }, 'errorCode')).toBe('x')
    expect(readErrorField(new Error('m'), 'errorCode')).toBeUndefined()
  })

  test('getErrorText prefers Error.message then message field then serialization', () => {
    expect(getErrorText(new Error('boom'))).toBe('boom')
    expect(getErrorText({ message: 'field' })).toBe('field')
    expect(getErrorText('raw')).toBe('raw')
    expect(getErrorText({ a: 1 })).toBe('{"a":1}')
  })
})
