import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../shared/types'
import {
  acquirePhoneAuthChallenge,
  MAX_PHONE_AUTH_ISSUER_URL_LENGTH,
  resolvePhoneAuthChallengeIssuerUrl,
} from '../phone-auth-challenge'

describe('phone auth challenge provider', () => {
  it('uses only the discovered challenge issuer', () => {
    expect(resolvePhoneAuthChallengeIssuerUrl(
      'https://challenge.example.com/phone-auth',
    ).toString()).toBe('https://challenge.example.com/phone-auth')
  })

  it('requires HTTPS in production even for loopback issuers', () => {
    expect(() => resolvePhoneAuthChallengeIssuerUrl(
      'http://127.0.0.1:9090/challenge',
    )).toThrow('must use HTTPS')
    expect(() => resolvePhoneAuthChallengeIssuerUrl(
      'http://[::1]:9090/challenge',
    )).toThrow('must use HTTPS')
  })

  it('fails closed on loopback HTTP without the trusted test capability', async () => {
    const createCallback = mock(async () => {
      throw new Error('must not start')
    })
    const openExternal = mock(async () => {})
    const result = await acquirePhoneAuthChallenge(
      {
        invoke: mock(async () => ({
          success: true,
          type: 'browser_redirect',
          issuerUrl: 'http://127.0.0.1:39053/challenge',
        })),
      },
      { createCallback, openExternal },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
    })
    expect(createCallback).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('allows loopback HTTP only through the trusted local test capability', () => {
    expect(resolvePhoneAuthChallengeIssuerUrl(
      'http://127.0.0.1:9090/challenge',
      true,
    ).toString()).toBe('http://127.0.0.1:9090/challenge')

    expect(() => resolvePhoneAuthChallengeIssuerUrl(
      'http://challenge.example.com/issue',
      true,
    )).toThrow('must use HTTPS')
  })

  it('fails closed on an oversized issuer before opening a callback or browser', async () => {
    const createCallback = mock(async () => {
      throw new Error('must not start')
    })
    const openExternal = mock(async () => {})
    const result = await acquirePhoneAuthChallenge(
      {
        invoke: mock(async () => ({
          success: true,
          type: 'browser_redirect',
          issuerUrl: `https://challenge.example.com/${'a'.repeat(
            MAX_PHONE_AUTH_ISSUER_URL_LENGTH,
          )}`,
        })),
      },
      { createCallback, openExternal },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
    })
    expect(createCallback).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('uses the explicit E2E capability for a loopback discovery issuer', async () => {
    let resolveCallback!: (payload: { query: Record<string, string> }) => void
    const callbackPromise = new Promise<{ query: Record<string, string> }>(resolve => {
      resolveCallback = resolve
    })
    const openExternal = mock(async (value: string) => {
      const url = new URL(value)
      resolveCallback({
        query: {
          code: 'loopback-issued-token',
          state: url.searchParams.get('state')!,
        },
      })
    })
    const result = await acquirePhoneAuthChallenge(
      {
        invoke: mock(async () => ({
          success: true,
          type: 'browser_redirect',
          issuerUrl: 'http://127.0.0.1:39053/challenge',
        })),
      },
      {
        allowInsecureLoopbackIssuer: true,
        createCallback: async () => ({
          promise: callbackPromise,
          url: 'http://localhost:6477',
          close: mock(() => {}),
        }),
        openExternal,
      },
    )

    expect(result).toEqual({
      success: true,
      challengeToken: 'loopback-issued-token',
    })
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
