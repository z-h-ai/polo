import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../shared/types'
import { buildAdminPreloadApi } from '../admin-api'

describe('admin preload RPC chain', () => {
  it('forwards the minimal typed arguments for every phone auth operation', async () => {
    const calls: unknown[][] = []
    const api = buildAdminPreloadApi({
      invoke: mock(async (...args: unknown[]) => {
        calls.push(args)
        return { success: true }
      }),
      on: mock(() => () => {}),
    })

    await api.adminGetAuthConfig()
    await api.adminSendPhoneAuthCode('13800138000', 'issuer-signed-opaque-token')
    await api.adminVerifyPhoneAuthCode('13800138000', '123456')
    await api.adminSetPassword('password-123')

    expect(calls).toEqual([
      [RPC_CHANNELS.admin.GET_AUTH_CONFIG],
      [
        RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE,
        '13800138000',
        'issuer-signed-opaque-token',
      ],
      [RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE, '13800138000', '123456'],
      [RPC_CHANNELS.admin.SET_PASSWORD, 'password-123'],
    ])
  })

  it('keeps username password login and reauth events on the existing channels', async () => {
    const invoke = mock(async () => ({ success: true }))
    const on = mock(() => () => {})
    const api = buildAdminPreloadApi({ invoke, on })
    const listener = mock(() => {})

    await api.adminLogin('legacy-username', 'password-123')
    api.onAdminReauthRequired(listener)

    expect(invoke).toHaveBeenCalledWith(
      RPC_CHANNELS.admin.LOGIN,
      'legacy-username',
      'password-123',
    )
    expect(on).toHaveBeenCalledWith('admin:reauthRequired', listener)
  })

  it('gets an issuer-signed challenge through the production preload provider', async () => {
    let resolveCallback!: (payload: { query: Record<string, string> }) => void
    const callbackPromise = new Promise<{ query: Record<string, string> }>(resolve => {
      resolveCallback = resolve
    })
    const invoke = mock(async (channel: string) => {
      expect(channel).toBe(RPC_CHANNELS.admin.GET_STATUS)
      return { adminUrl: 'https://admin.example.com/' }
    })
    const openExternal = mock(async (value: string) => {
      const url = new URL(value)
      expect(url.origin + url.pathname).toBe('https://challenge.example.com/issue')
      expect(url.searchParams.get('redirect_uri')).toStartWith(
        'http://localhost:',
      )
      expect(url.searchParams.get('client_id')).toBe('polo-electron')
      resolveCallback({
        query: {
          code: 'issuer-signed-opaque-token',
          state: url.searchParams.get('state')!,
        },
      })
    })
    const api = buildAdminPreloadApi(
      { invoke, on: mock(() => () => {}) },
      {
        configuredIssuerUrl: 'https://challenge.example.com/issue',
        createCallback: async () => ({
          promise: callbackPromise,
          url: 'http://localhost:6477',
          close: mock(() => {}),
        }),
        openExternal,
      },
    )

    await expect(api.adminAcquirePhoneAuthChallenge()).resolves.toEqual({
      success: true,
      challengeToken: 'issuer-signed-opaque-token',
    })
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
