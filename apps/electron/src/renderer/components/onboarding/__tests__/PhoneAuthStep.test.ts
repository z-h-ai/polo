import { describe, expect, it } from 'bun:test'
import {
  maskMainlandPhone,
  normalizeMainlandPhoneInput,
  normalizeVerificationCode,
} from '../phone-auth-utils'

describe('PhoneAuthStep input helpers', () => {
  it('normalizes pasted phone numbers and removes spaces', () => {
    expect(normalizeMainlandPhoneInput(' 138 0013 8000 ')).toBe('13800138000')
    expect(normalizeMainlandPhoneInput('+86 138-0013-8000')).toBe('13800138000')
  })

  it('accepts only six code digits', () => {
    expect(normalizeVerificationCode('12 3a45-678')).toBe('123456')
  })

  it('masks the middle phone digits for display', () => {
    expect(maskMainlandPhone('13800138000')).toBe('+86 138 •••• 8000')
  })
})
