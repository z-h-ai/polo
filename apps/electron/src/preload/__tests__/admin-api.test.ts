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
})
