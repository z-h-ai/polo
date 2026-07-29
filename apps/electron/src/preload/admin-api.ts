import type { RpcClient } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS, type ElectronAPI } from '../shared/types'

type AdminPreloadApi = Pick<
  ElectronAPI,
  | 'adminLogin'
  | 'adminGetAuthConfig'
  | 'adminSendPhoneAuthCode'
  | 'adminVerifyPhoneAuthCode'
  | 'adminSetPassword'
  | 'adminValidate'
  | 'adminLogout'
  | 'adminGetStatus'
  | 'adminSyncConnections'
  | 'onAdminReauthRequired'
>

export function buildAdminPreloadApi(
  client: Pick<RpcClient, 'invoke' | 'on'>,
): AdminPreloadApi {
  return {
    adminLogin: (identifier, password) =>
      client.invoke(RPC_CHANNELS.admin.LOGIN, identifier, password),
    adminGetAuthConfig: () =>
      client.invoke(RPC_CHANNELS.admin.GET_AUTH_CONFIG),
    adminSendPhoneAuthCode: (phone, challengeToken) =>
      client.invoke(RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE, phone, challengeToken),
    adminVerifyPhoneAuthCode: (phone, code) =>
      client.invoke(RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE, phone, code),
    adminSetPassword: password =>
      client.invoke(RPC_CHANNELS.admin.SET_PASSWORD, password),
    adminValidate: () =>
      client.invoke(RPC_CHANNELS.admin.VALIDATE),
    adminLogout: () =>
      client.invoke(RPC_CHANNELS.admin.LOGOUT),
    adminGetStatus: () =>
      client.invoke(RPC_CHANNELS.admin.GET_STATUS),
    adminSyncConnections: () =>
      client.invoke(RPC_CHANNELS.admin.SYNC_CONNECTIONS),
    onAdminReauthRequired: callback =>
      client.on('admin:reauthRequired', callback),
  }
}
