import { describe, expect, it } from 'bun:test'
import {
  isValidMainlandChinaPhone,
  MainlandChinaPhoneSchema,
  SendPhoneAuthCodeRpcInputSchema,
  VerifyPhoneAuthCodeRpcInputSchema,
} from '../schemas'

describe('mainland China phone validation parity', () => {
  it('accepts only the shared 13-19 mobile prefix and eleven-digit length', () => {
    for (const phone of ['13000000000', '13800138000', '19999999999']) {
      expect(isValidMainlandChinaPhone(phone)).toBe(true)
      expect(MainlandChinaPhoneSchema.safeParse(phone).success).toBe(true)
      expect(SendPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        challengeToken: 'signed-challenge',
      }).success).toBe(true)
      expect(VerifyPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        code: '123456',
      }).success).toBe(true)
    }
  })

  it('rejects 12-prefix, short, overlong, and non-digit-prefix values everywhere', () => {
    for (const phone of [
      '12000000000',
      '1380013800',
      '138001380000',
      'a3800138000',
    ]) {
      expect(isValidMainlandChinaPhone(phone)).toBe(false)
      expect(MainlandChinaPhoneSchema.safeParse(phone).success).toBe(false)
      expect(SendPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        challengeToken: 'signed-challenge',
      }).success).toBe(false)
      expect(VerifyPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        code: '123456',
      }).success).toBe(false)
    }
  })
})
