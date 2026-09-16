import { describe, expect, it, mock } from 'bun:test'
import {
  canSendPhoneAuthCode,
  canVerifyPhoneAuthCode,
  createPhoneAuthResendDeadline,
  createExclusiveRunner,
  getRemainingPhoneAuthResendSeconds,
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

  it('uses the same mainland phone rule as the LOCAL_ONLY RPC boundary', () => {
    for (const input of [
      '12000000000',
      '1380013800',
      '138001380000',
      'a3800138000',
    ]) {
      const withPhone = reducePhoneAuthForm(
        { ...INITIAL_PHONE_AUTH_FORM_STATE, consented: true },
        { type: 'phoneChanged', value: input },
      )
      expect(canSendPhoneAuthCode(withPhone)).toBe(false)
    }

    for (const input of ['13000000000', '19999999999']) {
      const withPhone = reducePhoneAuthForm(
        { ...INITIAL_PHONE_AUTH_FORM_STATE, consented: true },
        { type: 'phoneChanged', value: input },
      )
      expect(canSendPhoneAuthCode(withPhone)).toBe(true)
    }
  })

  it('derives the server resend interval from an absolute deadline', () => {
    const deadline = createPhoneAuthResendDeadline(41.2, 1_000)
    expect(deadline).toBe(43_000)
    expect(getRemainingPhoneAuthResendSeconds(deadline, 1_000)).toBe(42)
    expect(getRemainingPhoneAuthResendSeconds(deadline, 2_001)).toBe(41)
    expect(getRemainingPhoneAuthResendSeconds(deadline, 43_001)).toBe(0)

    const verifying = reducePhoneAuthForm(
      {
        ...INITIAL_PHONE_AUTH_FORM_STATE,
        phone: '13800138000',
        consented: true,
      },
      { type: 'codeSent' },
    )

    expect(verifying).toMatchObject({
      mode: 'verify',
      code: '',
    })
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

  it('clears the code without owning or discarding the parent resend deadline', () => {
    const edited = reducePhoneAuthForm(
      {
        mode: 'verify',
        phone: '13800138000',
        code: '123456',
        consented: true,
      },
      { type: 'phoneEditRequested' },
    )

    expect(edited).toEqual({
      mode: 'entry',
      phone: '13800138000',
      code: '',
      consented: true,
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
