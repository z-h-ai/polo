import { describe, expect, test } from 'bun:test'
import { INSUFFICIENT_CREDIT_ERROR_CODES, isInsufficientCreditCode } from '../insufficient-credit-codes'

describe('isInsufficientCreditCode', () => {
  test('classifies every admin/gateway blocked-balance dialect', () => {
    for (const code of INSUFFICIENT_CREDIT_ERROR_CODES) expect(isInsufficientCreditCode(code)).toBe(true)
    expect(isInsufficientCreditCode('quota_exhausted')).toBe(true)
    expect(isInsufficientCreditCode('budget_exhausted')).toBe(true)
  })

  test('does not absorb unrelated billing failures', () => {
    for (const code of [undefined, null, '', 'kb_service_unavailable', 'rate_limited', 'server_error']) {
      expect(isInsufficientCreditCode(code as never)).toBe(false)
    }
  })
})
