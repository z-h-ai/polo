import type { RpcClient } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS, type ElectronAPI } from '../shared/types'
import {
  acquirePhoneAuthChallenge,
  type PhoneAuthChallengeDependencies,
} from './phone-auth-challenge'

type AdminPreloadApi = Pick<
  ElectronAPI,
  | 'adminLogin'
  | 'adminGetAuthConfig'
  | 'adminGetPhoneAuthChallengeConfig'
  | 'adminAcquirePhoneAuthChallenge'
  | 'adminSendPhoneAuthCode'
  | 'adminVerifyPhoneAuthCode'
  | 'adminSetPassword'
  | 'adminValidate'
  | 'adminLogout'
  | 'adminGetStatus'
  | 'adminSyncConnections'
  | 'onAdminReauthRequired'
  | 'organizationList'
  | 'organizationCreate'
  | 'organizationPreviewJoin'
  | 'organizationAcceptJoin'
  | 'organizationListMembers'
  | 'organizationListInvitations'
  | 'organizationCreateInvitation'
  | 'organizationCancelInvitation'
  | 'organizationCreateJoinLink'
  | 'organizationRevokeJoinLink'
  | 'organizationUpdateMember'
  | 'organizationRemoveMember'
>

export function buildAdminPreloadApi(
  client: Pick<RpcClient, 'invoke' | 'on'>,
  challengeDependencies?: PhoneAuthChallengeDependencies,
): AdminPreloadApi {
  return {
    adminLogin: (identifier, password) =>
      client.invoke(RPC_CHANNELS.admin.LOGIN, identifier, password),
    adminGetAuthConfig: () =>
      client.invoke(RPC_CHANNELS.admin.GET_AUTH_CONFIG),
    adminGetPhoneAuthChallengeConfig: () =>
      client.invoke(RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG),
    adminAcquirePhoneAuthChallenge: () => challengeDependencies
      ? acquirePhoneAuthChallenge(client, challengeDependencies)
      : Promise.resolve({
          success: false as const,
          errorCode: 'phone_auth_configuration_error' as const,
        }),
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
    organizationList: () =>
      client.invoke(RPC_CHANNELS.admin.LIST_ORGANIZATIONS),
    organizationCreate: input =>
      client.invoke(RPC_CHANNELS.admin.CREATE_ORGANIZATION, input),
    organizationPreviewJoin: token =>
      client.invoke(RPC_CHANNELS.admin.PREVIEW_ORGANIZATION_JOIN, token),
    organizationAcceptJoin: token =>
      client.invoke(RPC_CHANNELS.admin.ACCEPT_ORGANIZATION_JOIN, token),
    organizationListMembers: organizationId =>
      client.invoke(RPC_CHANNELS.admin.LIST_ORGANIZATION_MEMBERS, organizationId),
    organizationListInvitations: organizationId =>
      client.invoke(RPC_CHANNELS.admin.LIST_ORGANIZATION_INVITATIONS, organizationId),
    organizationCreateInvitation: (organizationId, input) =>
      client.invoke(RPC_CHANNELS.admin.CREATE_ORGANIZATION_INVITATION, organizationId, input),
    organizationCancelInvitation: (organizationId, invitationId) =>
      client.invoke(RPC_CHANNELS.admin.CANCEL_ORGANIZATION_INVITATION, organizationId, invitationId),
    organizationCreateJoinLink: (organizationId, input) =>
      client.invoke(RPC_CHANNELS.admin.CREATE_ORGANIZATION_JOIN_LINK, organizationId, input),
    organizationRevokeJoinLink: (organizationId, joinLinkId) =>
      client.invoke(RPC_CHANNELS.admin.REVOKE_ORGANIZATION_JOIN_LINK, organizationId, joinLinkId),
    organizationUpdateMember: (organizationId, memberId, input) =>
      client.invoke(RPC_CHANNELS.admin.UPDATE_ORGANIZATION_MEMBER, organizationId, memberId, input),
    organizationRemoveMember: (organizationId, memberId, reason) =>
      client.invoke(RPC_CHANNELS.admin.REMOVE_ORGANIZATION_MEMBER, organizationId, memberId, reason),
  }
}
