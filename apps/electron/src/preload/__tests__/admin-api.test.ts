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
    await api.adminGetPhoneAuthChallengeConfig()
    await api.adminSendPhoneAuthCode('13800138000', 'issuer-signed-opaque-token')
    await api.adminVerifyPhoneAuthCode('13800138000', '123456')
    await api.adminSetPassword('password-123')

    expect(calls).toEqual([
      [RPC_CHANNELS.admin.GET_AUTH_CONFIG],
      [RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG],
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

  it('forwards organization operations without mixing in workspaceId', async () => {
    const calls: unknown[][] = []
    const api = buildAdminPreloadApi({
      invoke: mock(async (...args: unknown[]) => {
        calls.push(args)
        return { success: true }
      }),
      on: mock(() => () => {}),
    })
    const organizationId = '11111111-1111-4111-8111-111111111111'
    const resourceId = '22222222-2222-4222-8222-222222222222'
    const token = 'join-token-12345678901234567890'

    await api.organizationList()
    await api.organizationCreate({
      type: 'creator_space',
      name: 'Studio',
      purpose: 'Publish apps',
      idempotencyKey: 'request-1',
    })
    await api.organizationPreviewJoin(token)
    await api.organizationAcceptJoin(token)
    await api.organizationListMembers(organizationId)
    await api.organizationListInvitations(organizationId)
    await api.organizationCreateInvitation(organizationId, { maxUses: 10 })
    await api.organizationCancelInvitation(organizationId, resourceId)
    await api.organizationCreateJoinLink(organizationId, { maxUses: null })
    await api.organizationRevokeJoinLink(organizationId, resourceId)
    await api.organizationUpdateMember(organizationId, resourceId, { role: 'manager' })
    await api.organizationRemoveMember(organizationId, resourceId, 'Left team')

    expect(calls).toEqual([
      [RPC_CHANNELS.admin.LIST_ORGANIZATIONS],
      [
        RPC_CHANNELS.admin.CREATE_ORGANIZATION,
        {
          type: 'creator_space',
          name: 'Studio',
          purpose: 'Publish apps',
          idempotencyKey: 'request-1',
        },
      ],
      [RPC_CHANNELS.admin.PREVIEW_ORGANIZATION_JOIN, token],
      [RPC_CHANNELS.admin.ACCEPT_ORGANIZATION_JOIN, token],
      [RPC_CHANNELS.admin.LIST_ORGANIZATION_MEMBERS, organizationId],
      [RPC_CHANNELS.admin.LIST_ORGANIZATION_INVITATIONS, organizationId],
      [RPC_CHANNELS.admin.CREATE_ORGANIZATION_INVITATION, organizationId, { maxUses: 10 }],
      [RPC_CHANNELS.admin.CANCEL_ORGANIZATION_INVITATION, organizationId, resourceId],
      [RPC_CHANNELS.admin.CREATE_ORGANIZATION_JOIN_LINK, organizationId, { maxUses: null }],
      [RPC_CHANNELS.admin.REVOKE_ORGANIZATION_JOIN_LINK, organizationId, resourceId],
      [
        RPC_CHANNELS.admin.UPDATE_ORGANIZATION_MEMBER,
        organizationId,
        resourceId,
        { role: 'manager' },
      ],
      [
        RPC_CHANNELS.admin.REMOVE_ORGANIZATION_MEMBER,
        organizationId,
        resourceId,
        'Left team',
      ],
    ])
  })

  it('gets an issuer-signed challenge through the production preload provider', async () => {
    let resolveCallback!: (payload: { query: Record<string, string> }) => void
    const callbackPromise = new Promise<{ query: Record<string, string> }>(resolve => {
      resolveCallback = resolve
    })
    const invoke = mock(async (channel: string) => {
      expect(channel).toBe(RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG)
      return {
        success: true,
        type: 'browser_redirect',
        issuerUrl: 'https://challenge.example.com/issue',
      }
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
