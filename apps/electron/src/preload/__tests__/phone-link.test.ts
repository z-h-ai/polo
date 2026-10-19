import { describe, expect, it, mock } from 'bun:test'
import { buildPhoneLinkPreloadApi } from '../phone-link'
import { RPC_CHANNELS } from '../../shared/types'

describe('phone link preload RPC chain', () => {
  it('forwards pairing/list/revoke/hostInfo onto the LOCAL_ONLY admin channels', async () => {
    const calls: unknown[][] = []
    const api = buildPhoneLinkPreloadApi({
      invoke: mock(async (...args: unknown[]) => {
        calls.push(args)
        return { success: true }
      }),
      on: mock(() => () => {}),
    })

    await api.phoneDeviceCreatePairingCode()
    await api.phoneDeviceList()
    await api.phoneDeviceRevoke('device-1')
    await api.phoneLinkGetHostInfo()

    expect(calls).toEqual([
      [RPC_CHANNELS.admin.CREATE_PAIRING_CODE],
      [RPC_CHANNELS.admin.LIST_DEVICES],
      [RPC_CHANNELS.admin.REVOKE_DEVICE, 'device-1'],
      [RPC_CHANNELS.phoneLink.HOST_INFO],
    ])
  })

  it('requires a deviceId string for revoke (owner-scoped on admin side)', async () => {
    const calls: unknown[][] = []
    const api = buildPhoneLinkPreloadApi({
      invoke: mock(async (...args: unknown[]) => {
        calls.push(args)
        return { revokedCount: 1, devices: [] }
      }),
      on: mock(() => () => {}),
    })

    await api.phoneDeviceRevoke('11111111-1111-4111-8111-111111111111')

    expect(calls).toEqual([
      [RPC_CHANNELS.admin.REVOKE_DEVICE, '11111111-1111-4111-8111-111111111111'],
    ])
  })

  it('subscribes relay link status broadcasts on the POL-237 channel', () => {
    const on = mock((_channel: string, _callback: (...args: unknown[]) => void) => () => {})
    const api = buildPhoneLinkPreloadApi({
      invoke: mock(async () => ({})),
      on,
    })
    const listener = () => {}

    const off = api.phoneLinkOnRelayStatus(listener)

    expect(on).toHaveBeenCalledWith(RPC_CHANNELS.relay.STATUS_CHANGED, listener)
    expect(typeof off).toBe('function')
  })
})
