/**
 * Phone Link preload — 手机连接面板的 RPC 暴露面。
 *
 * 与 buildAdminPreloadApi（admin-api.ts）同模式：把 renderer 调用映射到
 * LOCAL_ONLY RPC 通道（处理器在 Electron 主进程，见 main/handlers/phone-link.ts）。
 * 独立于 admin-api.ts 是为了不改 ElectronAPI（apps/electron/src/shared/types.ts，
 * POL-12 并行避让）；bootstrap.ts 用 Object.assign 并入 electronAPI。
 */

import type { RpcClient } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS } from '../shared/types'
import { PHONE_LINK_CHANNELS, type PhoneLinkPreloadApi } from '../shared/phone-link'

export function buildPhoneLinkPreloadApi(
  client: Pick<RpcClient, 'invoke' | 'on'>,
): PhoneLinkPreloadApi {
  return {
    phoneDeviceCreatePairingCode: () =>
      client.invoke(PHONE_LINK_CHANNELS.CREATE_PAIRING_CODE),
    phoneDeviceList: () =>
      client.invoke(PHONE_LINK_CHANNELS.LIST_DEVICES),
    phoneDeviceRevoke: deviceId =>
      client.invoke(PHONE_LINK_CHANNELS.REVOKE_DEVICE, deviceId),
    phoneLinkGetHostInfo: () =>
      client.invoke(PHONE_LINK_CHANNELS.HOST_INFO),
    phoneLinkOnRelayStatus: callback =>
      client.on(RPC_CHANNELS.relay.STATUS_CHANGED, callback as (...args: unknown[]) => void),
  }
}
