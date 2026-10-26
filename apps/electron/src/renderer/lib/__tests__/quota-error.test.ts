import { describe, expect, test } from 'bun:test'
import {
  getErrorText,
  isInsufficientCreditError,
  isPeriodQuotaError,
  isQuotaExhaustedError,
  readErrorCode,
  readErrorField,
  readQuotaResetAt,
} from '../quota-error'

describe('insufficient-credit classification (journey #1)', () => {
  test('recognizes the shared code table spellings regardless of case', () => {
    expect(isInsufficientCreditError({ errorCode: 'insufficient_credit' })).toBe(true)
    expect(isInsufficientCreditError({ errorCode: 'INSUFFICIENT_BALANCE' })).toBe(true)
    expect(isInsufficientCreditError({ errorCode: 'quota_exhausted' })).toBe(true)
    expect(isInsufficientCreditError({ errorCode: 'budget_exhausted' })).toBe(true)
    expect(isInsufficientCreditError({ code: 'QUOTA_EXHAUSTED' })).toBe(true)
    expect(isInsufficientCreditError({ code: 'BUDGET_EXCEEDED' })).toBe(true)
  })

  test('HTTP 402 classifies as insufficient credit even without a code', () => {
    expect(isInsufficientCreditError({ status: 402 })).toBe(true)
    expect(isInsufficientCreditError({ status: 402, code: 'something_else' })).toBe(true)
  })

  test('period quota is the 429 lane, separate from insufficient credit', () => {
    expect(isPeriodQuotaError({ status: 429 })).toBe(true)
    expect(isInsufficientCreditError({ status: 429 })).toBe(false)
    expect(isPeriodQuotaError({ errorCode: 'insufficient_credit' })).toBe(false)
  })

  test('a 429 WITH a server-provided reset fact exposes it; a plain 429 never does', () => {
    expect(readQuotaResetAt({ status: 429, quotaResetAt: 1735689600000 })).toBe(1735689600000)
    expect(readQuotaResetAt({ status: 429, resetAt: 1735689600000 })).toBe(1735689600000)
    expect(readQuotaResetAt({ status: 429, rateLimitResetAt: '1735689600000' })).toBe(1735689600000)
    // Plain 429 / junk facts stay promise-free.
    expect(readQuotaResetAt({ status: 429 })).toBeUndefined()
    expect(readQuotaResetAt({ status: 429, resetAt: 0 })).toBeUndefined()
    expect(readQuotaResetAt({ status: 429, resetAt: 'next month' })).toBeUndefined()
    expect(readQuotaResetAt({ errorCode: 'insufficient_credit' })).toBeUndefined()
  })

  test('unknown error classes are never guessed from message text', () => {
    // The old /quota|额度|exhausted/ regex fallback is deliberately gone:
    // only trusted structured fields (code/status) may classify.
    expect(isQuotaExhaustedError(new Error('monthly quota exhausted'))).toBe(false)
    expect(isQuotaExhaustedError({ message: '本月额度已用完' })).toBe(false)
    expect(isQuotaExhaustedError({ errorCode: 'kb_service_unavailable', message: 'knowledge base unavailable' })).toBe(false)
    expect(isQuotaExhaustedError(new Error('network timeout'))).toBe(false)
    expect(isQuotaExhaustedError(undefined)).toBe(false)
    expect(isInsufficientCreditError(new Error('insufficient balance, please top up'))).toBe(false)
  })

  test('blocking gate covers both billing classes only', () => {
    expect(isQuotaExhaustedError({ errorCode: 'insufficient_credit' })).toBe(true)
    expect(isQuotaExhaustedError({ status: 402 })).toBe(true)
    expect(isQuotaExhaustedError({ status: 429 })).toBe(true)
    expect(isQuotaExhaustedError({ status: 500 })).toBe(false)
  })
})

describe('error field helpers', () => {
  test('readErrorField reads only plain-object fields', () => {
    expect(readErrorField({ errorCode: 'x' }, 'errorCode')).toBe('x')
    expect(readErrorField(new Error('m'), 'errorCode')).toBeUndefined()
  })

  test('readErrorCode preserves the wire spelling and defaults to empty', () => {
    expect(readErrorCode({ errorCode: 'Insufficient_Credit' })).toBe('Insufficient_Credit')
    expect(readErrorCode({ code: 'QUOTA_EXHAUSTED' })).toBe('QUOTA_EXHAUSTED')
    expect(readErrorCode(new Error('m'))).toBe('')
    expect(readErrorCode({ code: 42 })).toBe('')
  })

  test('getErrorText prefers Error.message then message field then serialization', () => {
    expect(getErrorText(new Error('boom'))).toBe('boom')
    expect(getErrorText({ message: 'field' })).toBe('field')
    expect(getErrorText('raw')).toBe('raw')
    expect(getErrorText({ a: 1 })).toBe('{"a":1}')
  })
})
