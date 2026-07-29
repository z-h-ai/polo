import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../shared/types'
import {
  acquirePhoneAuthChallenge,
  resolvePhoneAuthChallengeIssuerUrl,
} from '../phone-auth-challenge'

describe('phone auth challenge provider', () => {
  it('derives the deployed challenge page from the configured admin origin', () => {
    expect(resolvePhoneAuthChallengeIssuerUrl(
      'https://polo-admin.example.com/base/',
    ).toString()).toBe('https://polo-admin.example.com/auth/phone-challenge')
  })

  it('allows HTTP only for a loopback mock provider', () => {
    expect(resolvePhoneAuthChallengeIssuerUrl(
      'https://admin.example.com',
      'http://127.0.0.1:9090/challenge',
    ).toString()).toBe('http://127.0.0.1:9090/challenge')

    expect(() => resolvePhoneAuthChallengeIssuerUrl(
      'https://admin.example.com',
      'http://challenge.example.com/issue',
    )).toThrow('must use HTTPS')
  })

  it('rejects a callback token when the state does not match', async () => {
    const close = mock(() => {})
    const result = await acquirePhoneAuthChallenge(
      {
        invoke: mock(async (channel: string) => {
          expect(channel).toBe(RPC_CHANNELS.admin.GET_STATUS)
          return { adminUrl: 'https://admin.example.com' }
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

  it('fails closed instead of manufacturing a token when no admin is configured', async () => {
    const openExternal = mock(async () => {})
    const result = await acquirePhoneAuthChallenge(
      {
        invoke: mock(async () => ({ adminUrl: undefined })),
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
