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

    // POO-151: a delivered-but-invalid callback is a failed challenge, not a
    // configuration problem — the retryable copy, not "temporarily unavailable".
    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_challenge_failed',
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

describe('phone auth challenge in-app window (POO-151)', () => {
  const httpsDiscovery = {
    success: true,
    type: 'browser_redirect',
    issuerUrl: 'https://challenge.example.com/issue',
  }

  function createDeferredCallback() {
    let resolveCallback!: (payload: { query: Record<string, string> }) => void
    const promise = new Promise<{ query: Record<string, string> }>(resolve => {
      resolveCallback = resolve
    })
    return { promise, resolveCallback }
  }

  function createController(openImpl?: (url: string) => Promise<void>) {
    let closedListener: (() => void) | null = null
    return {
      open: mock(async (url: string) => {
        await openImpl?.(url)
      }),
      close: mock(async () => {}),
      onClosed: mock((listener: () => void) => {
        closedListener = listener
        return () => {
          closedListener = null
        }
      }),
      emitClosed: () => closedListener?.(),
    }
  }

  function createDiscoveryClient() {
    return {
      invoke: mock(async () => ({ ...httpsDiscovery })),
    }
  }

  it('hosts the issuer in-app, resolves the token and closes the window', async () => {
    const { promise, resolveCallback } = createDeferredCallback()
    const closeCallback = mock(() => {})
    // The provider completes the challenge in the hidden window and the
    // loopback callback server receives the state-bound code.
    const controller = createController(async url => {
      const parsed = new URL(url)
      expect(parsed.origin + parsed.pathname).toBe('https://challenge.example.com/issue')
      expect(parsed.searchParams.get('redirect_uri')).toStartWith('http://localhost:')
      expect(parsed.searchParams.get('client_id')).toBe('polo-electron')
      resolveCallback({
        query: { code: 'in-app-issued-token', state: parsed.searchParams.get('state')! },
      })
    })
    const result = await acquirePhoneAuthChallenge(
      createDiscoveryClient(),
      {
        createCallback: async () => ({ promise, url: 'http://localhost:6477', close: closeCallback }),
        openExternal: mock(async () => {
          throw new Error('system browser must not be used when hosting in-app')
        }),
        challengeWindow: controller,
      },
    )

    expect(result).toEqual({ success: true, challengeToken: 'in-app-issued-token' })
    expect(controller.open).toHaveBeenCalledTimes(1)
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(closeCallback).toHaveBeenCalledTimes(1)
  })

  it('cancels at once when the user closes the challenge window', async () => {
    const { promise } = createDeferredCallback()
    const controller = createController(async () => {
      controller.emitClosed()
    })
    const result = await acquirePhoneAuthChallenge(
      createDiscoveryClient(),
      {
        createCallback: async () => ({ promise, url: 'http://localhost:6477', close: mock(() => {}) }),
        openExternal: mock(async () => {}),
        challengeWindow: controller,
      },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_challenge_cancelled',
    })
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('grades an in-app challenge timeout as a failed challenge', async () => {
    const { promise } = createDeferredCallback()
    const controller = createController()
    const result = await acquirePhoneAuthChallenge(
      createDiscoveryClient(),
      {
        createCallback: async () => ({ promise, url: 'http://localhost:6477', close: mock(() => {}) }),
        openExternal: mock(async () => {}),
        challengeWindow: controller,
        timeoutMs: 20,
      },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_challenge_failed',
    })
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('keeps configuration grading when the in-app window cannot open', async () => {
    const { promise } = createDeferredCallback()
    const controller = createController(async () => {
      throw new Error('ipc channel unavailable')
    })
    const result = await acquirePhoneAuthChallenge(
      createDiscoveryClient(),
      {
        createCallback: async () => ({ promise, url: 'http://localhost:6477', close: mock(() => {}) }),
        openExternal: mock(async () => {}),
        challengeWindow: controller,
      },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
    })
  })

  it('does not open a window when discovery fails closed', async () => {
    const controller = createController()
    const result = await acquirePhoneAuthChallenge(
      { invoke: mock(async () => ({ success: false })) },
      {
        openExternal: mock(async () => {}),
        challengeWindow: controller,
      },
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
    })
    expect(controller.open).not.toHaveBeenCalled()
  })
})
