import { describe, expect, it } from 'bun:test'
import {
  INITIAL_AUTH_FLOW_STATE,
  reduceAuthFlow,
  type AuthFlowState,
} from '../useAuthFlow'

const NOW = 1_700_000_000_000

function at(step: AuthFlowState['step'], overrides: Partial<AuthFlowState> = {}): AuthFlowState {
  return { ...INITIAL_AUTH_FLOW_STATE, step, ...overrides }
}

describe('reduceAuthFlow legal transitions', () => {
  it('starts from idle into the password entry', () => {
    expect(reduceAuthFlow(at('idle'), { type: 'started' })).toMatchObject({
      step: 'password',
    })
  })

  it('switches between password and phone entries', () => {
    const phone = reduceAuthFlow(at('password'), {
      type: 'modeSwitched',
      mode: 'phone',
    })
    expect(phone.step).toBe('phone')
    expect(
      reduceAuthFlow(phone, { type: 'modeSwitched', mode: 'password' }).step,
    ).toBe('password')
  })

  it('normalizes the phone while typing and keeps digits-only codes for the code step', () => {
    const typing = reduceAuthFlow(at('phone'), {
      type: 'phoneChanged',
      value: '+86 138-0013 8000',
    })
    expect(typing.phone).toBe('13800138000')
    expect(
      reduceAuthFlow(at('code'), { type: 'codeChanged', value: '82a41' }).code,
    ).toBe('8241')
  })

  it('moves phone → code and arms the resend deadline and expiry', () => {
    const codeState = reduceAuthFlow(at('phone', { phone: '13800138000' }), {
      type: 'codeSent',
      resendAfterSeconds: 59,
      expiresInSeconds: 300,
      now: NOW,
    })
    expect(codeState).toMatchObject({
      step: 'code',
      code: '',
      notice: null,
      codeResendAt: NOW + 59_000,
      codeExpiresAt: NOW + 300_000,
    })
  })

  it('moves any login step → prepping → ready / prepFailed and retries the prep', () => {
    const prepping = reduceAuthFlow(at('password'), { type: 'loginSucceeded' })
    expect(prepping.step).toBe('prepping')
    expect(reduceAuthFlow(prepping, { type: 'prepSucceeded' }).step).toBe(
      'ready',
    )
    const failed = reduceAuthFlow(prepping, { type: 'prepFailed' })
    expect(failed.step).toBe('prepFailed')
    expect(reduceAuthFlow(failed, { type: 'prepRetried' }).step).toBe(
      'prepping',
    )
    expect(reduceAuthFlow(failed, { type: 'reloginRequested' })).toMatchObject({
      step: 'password',
      notice: null,
      codeResendAt: undefined,
    })
  })

  it('records a submit failure inline without leaving the login step', () => {
    const failed = reduceAuthFlow(at('code'), { type: 'submitFailed' })
    expect(failed.step).toBe('code')
    expect(failed.error).toBe(true)
  })

  it('lands cancellations back on the password entry with the retryable notice', () => {
    expect(
      reduceAuthFlow(at('code', { notice: 'expired' as const }), {
        type: 'cancelled',
      }),
    ).toMatchObject({ step: 'password', notice: 'cancelled', error: false })
  })

  it('routes expired sessions to the password entry from any step', () => {
    expect(
      reduceAuthFlow(at('prepping'), { type: 'sessionExpired' }),
    ).toMatchObject({ step: 'password', notice: 'expired' })
    expect(
      reduceAuthFlow(at('idle'), { type: 'sessionExpired' }),
    ).toMatchObject({ step: 'password', notice: 'expired' })
  })

  it('resets to the initial state', () => {
    expect(
      reduceAuthFlow(at('ready', { phone: '13800138000' }), { type: 'reset' }),
    ).toEqual(INITIAL_AUTH_FLOW_STATE)
  })
})

describe('reduceAuthFlow rejects illegal transitions', () => {
  const cases: Array<[AuthFlowState['step'], Parameters<typeof reduceAuthFlow>[1]]> = [
    ['password', { type: 'started' }],
    ['password', { type: 'codeSent', resendAfterSeconds: 59, expiresInSeconds: 300 }],
    ['code', { type: 'codeSent', resendAfterSeconds: 59, expiresInSeconds: 300 }],
    ['idle', { type: 'loginSucceeded' }],
    ['prepping', { type: 'loginSucceeded' }],
    ['ready', { type: 'loginSucceeded' }],
    ['password', { type: 'prepSucceeded' }],
    ['password', { type: 'prepFailed' }],
    ['idle', { type: 'prepRetried' }],
    ['ready', { type: 'prepRetried' }],
    ['password', { type: 'reloginRequested' }],
    ['prepping', { type: 'cancelled' }],
    ['ready', { type: 'cancelled' }],
    ['ready', { type: 'submitFailed' }],
    ['password', { type: 'codeChanged', value: '123456' }],
    ['password', { type: 'modeSwitched', mode: 'code' as 'password' }],
  ]

  for (const [step, action] of cases) {
    it(`keeps ${step} untouched on ${action.type}`, () => {
      const before = at(step, { phone: '13800138000' })
      expect(reduceAuthFlow(before, action)).toBe(before)
    })
  }

  it('keeps the state when switching to the mode already shown', () => {
    const before = at('password')
    expect(
      reduceAuthFlow(before, { type: 'modeSwitched', mode: 'password' }),
    ).toBe(before)
  })
})
