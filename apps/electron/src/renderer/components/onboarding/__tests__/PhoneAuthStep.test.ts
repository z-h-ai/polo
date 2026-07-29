import { describe, expect, it, mock } from 'bun:test'
import {
  canSendPhoneAuthCode,
  canVerifyPhoneAuthCode,
  createExclusiveRunner,
  INITIAL_PHONE_AUTH_FORM_STATE,
  maskMainlandPhone,
  normalizeMainlandPhoneInput,
  normalizeVerificationCode,
  reducePhoneAuthForm,
  resolvePreferredAdminLoginMode,
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

describe('PhoneAuthStep interaction state', () => {
  it('defaults to phone auth only when the complete phone flow is available', () => {
    expect(resolvePreferredAdminLoginMode(true)).toBe('phone')
    expect(resolvePreferredAdminLoginMode(false)).toBe('password')
    expect(resolvePreferredAdminLoginMode(undefined)).toBe('password')
  })

  it('keeps the send action gated until a valid phone and consent are present', () => {
    const withPhone = reducePhoneAuthForm(INITIAL_PHONE_AUTH_FORM_STATE, {
      type: 'phoneChanged',
      value: '+86 138 0013 8000',
    })
    expect(withPhone.phone).toBe('13800138000')
    expect(canSendPhoneAuthCode(withPhone)).toBe(false)

    const consented = reducePhoneAuthForm(withPhone, {
      type: 'consentChanged',
      value: true,
    })
    expect(canSendPhoneAuthCode(consented)).toBe(true)
  })

  it('uses the server resend interval and counts down without going negative', () => {
    const verifying = reducePhoneAuthForm(
      {
        ...INITIAL_PHONE_AUTH_FORM_STATE,
        phone: '13800138000',
        consented: true,
      },
      { type: 'codeSent', resendAfter: 41.2 },
    )

    expect(verifying).toMatchObject({
      mode: 'verify',
      code: '',
      resendSeconds: 42,
    })
    expect(reducePhoneAuthForm(
      { ...verifying, resendSeconds: 0 },
      { type: 'countdownTicked' },
    ).resendSeconds).toBe(0)
  })

  it('accepts only a complete six-digit code for verification', () => {
    const verifying = {
      ...INITIAL_PHONE_AUTH_FORM_STATE,
      mode: 'verify' as const,
      phone: '13800138000',
    }
    const incomplete = reducePhoneAuthForm(verifying, {
      type: 'codeChanged',
      value: '12 3a45',
    })
    expect(incomplete.code).toBe('12345')
    expect(canVerifyPhoneAuthCode(incomplete)).toBe(false)

    const complete = reducePhoneAuthForm(incomplete, {
      type: 'codeChanged',
      value: '12 3a45-6',
    })
    expect(complete.code).toBe('123456')
    expect(canVerifyPhoneAuthCode(complete)).toBe(true)
  })

  it('clears the code and countdown when the phone is edited', () => {
    const edited = reducePhoneAuthForm(
      {
        mode: 'verify',
        phone: '13800138000',
        code: '123456',
        consented: true,
        resendSeconds: 37,
      },
      { type: 'phoneEditRequested' },
    )

    expect(edited).toEqual({
      mode: 'entry',
      phone: '13800138000',
      code: '',
      consented: true,
      resendSeconds: 0,
    })
  })

  it('prevents duplicate asynchronous submissions and unlocks after failure', async () => {
    let rejectFirst!: (error: Error) => void
    const task = mock(() => new Promise<string>((_resolve, reject) => {
      rejectFirst = reject
    }))
    const runner = createExclusiveRunner()

    const first = runner.run(task)
    expect(await runner.run(task)).toBeUndefined()
    expect(task).toHaveBeenCalledTimes(1)

    rejectFirst(new Error('offline'))
    await expect(first).rejects.toThrow('offline')

    const retry = mock(async () => 'accepted')
    expect(await runner.run(retry)).toBe('accepted')
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
