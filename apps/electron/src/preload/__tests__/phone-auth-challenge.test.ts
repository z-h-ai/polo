import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../shared/types'
import {
  acquirePhoneAuthChallenge,
  resolvePhoneAuthChallengeIssuerUrl,
} from '../phone-auth-challenge'

describe('phone auth challenge provider', () => {
  it('uses only the discovered challenge issuer', () => {
    expect(resolvePhoneAuthChallengeIssuerUrl(
      'https://challenge.example.com/phone-auth',
    ).toString()).toBe('https://challenge.example.com/phone-auth')
  })

  it('allows HTTP only for a loopback mock provider', () => {
    expect(resolvePhoneAuthChallengeIssuerUrl(
      'http://127.0.0.1:9090/challenge',
    ).toString()).toBe('http://127.0.0.1:9090/challenge')

    expect(() => resolvePhoneAuthChallengeIssuerUrl(
      'http://challenge.example.com/issue',
    )).toThrow('must use HTTPS')
  })

  it('rejects a callback token when the state does not match', async () => {
    const close = mock(() => {})
    const result = await acquirePhoneAuthChallenge(
      {
        invoke: mock(async (channel: string) => {
          expect(channel).toBe(RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG)
          return {
            success: true,
            type: 'browser_redirect',
            issuerUrl: 'https://challenge.example.com/issue',
          }
        }),
      },
      {
        createCallback: async () => ({
          promise: Promise.resolve({
            query: {
              code: 'attacker-controlled-token',
              state: 'wrong-state',
            },
          }),
          url: 'http://localhost:6477',
          close,
        }),
        openExternal: mock(async () => {}),
      },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('fails closed instead of guessing an issuer when discovery is unavailable', async () => {
    const openExternal = mock(async () => {})
    const result = await acquirePhoneAuthChallenge(
      {
        invoke: mock(async () => ({
          success: false,
          errorCode: 'phone_auth_configuration_error',
        })),
      },
      { openExternal },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
    })
    expect(openExternal).not.toHaveBeenCalled()
  })
})
