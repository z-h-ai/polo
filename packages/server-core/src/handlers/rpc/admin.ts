import {
  AdminClient,
  AdminError,
  denyAppCatalogAccessForAccount,
  denyCachedAppCatalogAuthorization,
  denyCachedAppCatalogAuthorizationForAccount,
  getCachedAppCatalog,
  getSafeAdminErrorMessage,
  saveAppCatalog,
  setAppCatalogAccessMode,
  type AppCatalogSyncResult,
  type AdminErrorCode,
  type AdminLlmConnection,
  type AdminLoginResponse,
  type AdminRefreshResponse,
  type AdminUser,
} from '@polo-ai/shared/admin'
import {
  AdminLoginRpcInputSchema,
  CreateOrganizationInvitationRpcInputSchema,
  CreateOrganizationJoinLinkRpcInputSchema,
  CreateOrganizationRpcInputSchema,
  OrganizationIdRpcInputSchema,
  OrganizationJoinTokenRpcInputSchema,
  RemoveOrganizationMemberRpcInputSchema,
  SendPhoneAuthCodeRpcInputSchema,
  SetAdminPasswordRpcInputSchema,
  UpdateOrganizationMemberRpcInputSchema,
  VerifyPhoneAuthCodeRpcInputSchema,
} from '@polo-ai/shared/admin/schemas'
import {
  addLlmConnection,
  deleteLlmConnection,
  getAdminConfigVersion,
  getAdminUrl,
  getLlmConnections,
  setAdminConfigVersion,
  setDefaultLlmConnection,
  updateLlmConnection,
  type LlmConnection,
} from '@polo-ai/shared/config'
import { getCredentialManager, type CredentialManager } from '@polo-ai/shared/credentials'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { decryptTransitApiKey, deriveTransitKey } from '../../lib/admin-transit-decrypt'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.admin.LOGIN,
  RPC_CHANNELS.admin.GET_AUTH_CONFIG,
  RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG,
  RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE,
  RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE,
  RPC_CHANNELS.admin.SET_PASSWORD,
  RPC_CHANNELS.admin.VALIDATE,
  RPC_CHANNELS.admin.LOGOUT,
  RPC_CHANNELS.admin.GET_STATUS,
  RPC_CHANNELS.admin.SYNC_CONNECTIONS,
  RPC_CHANNELS.admin.SYNC_APP_CATALOG,
  RPC_CHANNELS.admin.LIST_ORGANIZATIONS,
  RPC_CHANNELS.admin.CREATE_ORGANIZATION,
  RPC_CHANNELS.admin.PREVIEW_ORGANIZATION_JOIN,
  RPC_CHANNELS.admin.ACCEPT_ORGANIZATION_JOIN,
  RPC_CHANNELS.admin.LIST_ORGANIZATION_MEMBERS,
  RPC_CHANNELS.admin.LIST_ORGANIZATION_INVITATIONS,
  RPC_CHANNELS.admin.CREATE_ORGANIZATION_INVITATION,
  RPC_CHANNELS.admin.CANCEL_ORGANIZATION_INVITATION,
  RPC_CHANNELS.admin.CREATE_ORGANIZATION_JOIN_LINK,
  RPC_CHANNELS.admin.REVOKE_ORGANIZATION_JOIN_LINK,
  RPC_CHANNELS.admin.UPDATE_ORGANIZATION_MEMBER,
  RPC_CHANNELS.admin.REMOVE_ORGANIZATION_MEMBER,
] as const

type StoredAdminTokens = NonNullable<Awaited<ReturnType<CredentialManager['getAdminTokens']>>>
type TokenValidationResult =
  | { tokens: StoredAdminTokens; accessMode: 'online' | 'offline'; warning?: string }
  | { tokens: null; authError?: { errorCode: string; message: string; status?: number } }

export function registerAdminHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const callOrganization = async <T extends object>(
    operation: string,
    callback: (client: AdminClient, accessToken: string) => Promise<T>,
  ) => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(adminUrl, manager, deps)
      if (!tokenResult.tokens) {
        return {
          success: false as const,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }
      if (tokenResult.accessMode === 'offline') {
        return {
          success: false as const,
          errorCode: 'NETWORK_ERROR',
          message: tokenResult.warning ?? 'Failed to reach admin server',
        }
      }
      const result = await callback(
        createAdminClient(adminUrl, manager),
        tokenResult.tokens.accessToken,
      )
      return { success: true as const, ...result }
    } catch (error) {
      if (isSessionEndingAuthFailure(error)) {
        await endAdminSession(getCredentialManager(), deps)
      }
      const adminError = toAdminRpcError(error)
      log?.warn(`[Admin] ${operation} failed:`, adminError.message)
      return { success: false as const, ...adminError }
    }
  }

  server.handle(RPC_CHANNELS.admin.LOGIN, async (_ctx, identifier: unknown, password: unknown) => {
    const input = AdminLoginRpcInputSchema.safeParse({ identifier, password })
    if (!input.success) {
      return adminInputError('INVALID_CREDENTIALS')
    }

    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const client = createAdminClient(adminUrl, manager)
      const login = await client.login(input.data.identifier, input.data.password)
      await completeAdminLogin({
        adminUrl,
        manager,
        login,
        onSyncFailure: error => logPostLoginSyncFailure(log, error),
      })

      return { success: true, user: login.user }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] login failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.GET_AUTH_CONFIG, async () => {
    try {
      return await createAdminClient(requireAdminUrl(), getCredentialManager()).getAuthConfig()
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] getAuthConfig failed:', adminError.message)
      return { phoneAuthEnabled: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG, async () => {
    try {
      const result = await createAdminClient(
        requireAdminUrl(),
        getCredentialManager(),
      ).getPhoneAuthChallengeConfig()
      return { success: true, ...result }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] getPhoneAuthChallengeConfig failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(
    RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE,
    async (_ctx, phone: unknown, challengeToken: unknown) => {
      const input = SendPhoneAuthCodeRpcInputSchema.safeParse({ phone, challengeToken })
      if (!input.success) {
        return adminInputError(hasValidationIssue(input.error.issues, 'phone')
          ? 'invalid_phone'
          : 'phone_auth_configuration_error')
      }

      try {
        const result = await createAdminClient(requireAdminUrl(), getCredentialManager())
          .sendPhoneAuthCode(input.data)
        return { success: true, ...result }
      } catch (error) {
        const adminError = toAdminRpcError(error)
        log?.warn('[Admin] sendPhoneAuthCode failed:', adminError.message)
        return { success: false, ...adminError }
      }
    },
  )

  server.handle(
    RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE,
    async (_ctx, phone: unknown, code: unknown) => {
      const input = VerifyPhoneAuthCodeRpcInputSchema.safeParse({ phone, code })
      if (!input.success) {
        return adminInputError(hasValidationIssue(input.error.issues, 'phone')
          ? 'invalid_phone'
          : 'verification_code_invalid')
      }

      try {
        const adminUrl = requireAdminUrl()
        const manager = getCredentialManager()
        const login = await createAdminClient(adminUrl, manager)
          .verifyPhoneAuthCode(input.data)
        await completeAdminLogin({
          adminUrl,
          manager,
          login,
          onSyncFailure: error => logPostLoginSyncFailure(log, error),
        })
        return {
          success: true,
          user: login.user,
          isNewUser: login.isNewUser,
        }
      } catch (error) {
        const adminError = toAdminRpcError(error)
        log?.warn('[Admin] verifyPhoneAuthCode failed:', adminError.message)
        return { success: false, ...adminError }
      }
    },
  )

  server.handle(RPC_CHANNELS.admin.SET_PASSWORD, async (_ctx, password: unknown) => {
    const input = SetAdminPasswordRpcInputSchema.safeParse({ password })
    if (!input.success) {
      return adminInputError('VALIDATION_ERROR')
    }

    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(adminUrl, manager, deps)
      if (!tokenResult.tokens) {
        return {
          success: false,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }
      if (tokenResult.accessMode === 'offline') {
        return {
          success: false,
          errorCode: 'NETWORK_ERROR',
          message: tokenResult.warning ?? 'Failed to reach admin server',
        }
      }

      const result = await createAdminClient(adminUrl, manager)
        .setPassword(tokenResult.tokens.accessToken, input.data)
      return { success: result.success }
    } catch (error) {
      if (isSessionEndingAuthFailure(error)) {
        await endAdminSession(getCredentialManager(), deps)
      }
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] setPassword failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.VALIDATE, async () => {
    const adminUrl = getAdminUrl()
    if (!adminUrl) {
      return { loggedIn: false }
    }

    const manager = getCredentialManager()
    const tokenResult = await ensureValidTokens(adminUrl, manager, deps)
    if (!tokenResult.tokens) {
      if (tokenResult.authError) {
        return { loggedIn: false, ...tokenResult.authError }
      }
      return { loggedIn: false }
    }
    if (tokenResult.accessMode === 'offline') {
      return {
        loggedIn: true,
        user: adminUserFromStoredTokens(tokenResult.tokens),
        configVersion: getAdminConfigVersion() ?? 'offline',
        offline: true,
      }
    }

    try {
      const client = createAdminClient(adminUrl, manager)
      const validation = await client.validate(tokenResult.tokens.accessToken)
      if (!validation.valid) {
        await endAdminSession(manager, deps)
        return { loggedIn: false }
      }
      await persistVerifiedAdminUser(manager, tokenResult.tokens, validation.user)

      if (getAdminConfigVersion() !== validation.configVersion) {
        await syncAdminConnections({
          adminUrl,
          manager,
          accessToken: tokenResult.tokens.accessToken,
        })
      }

      return {
        loggedIn: true,
        user: validation.user,
        configVersion: validation.configVersion,
      }
    } catch (error) {
      if (isSessionEndingAuthFailure(error)) {
        await endAdminSession(manager, deps)
        return { loggedIn: false, ...toAdminRpcError(error) }
      }
      if (isTemporaryAdminFailure(error)) {
        return {
          loggedIn: true,
          user: adminUserFromStoredTokens(tokenResult.tokens),
          configVersion: getAdminConfigVersion() ?? 'offline',
          offline: true,
        }
      }
      throw error
    }
  })

  server.handle(RPC_CHANNELS.admin.LOGOUT, async () => {
    const adminUrl = getAdminUrl()
    const manager = getCredentialManager()
    const tokens = await manager.getAdminTokens()

    if (adminUrl && tokens?.accessToken) {
      try {
        await createAdminClient(adminUrl, manager).logout(tokens.accessToken)
      } catch (error) {
        log?.warn('[Admin] remote logout failed; clearing local state:', error instanceof Error ? error.message : String(error))
      }
    }

    await endAdminSession(manager, deps)
    await deleteAdminManagedConnections(manager)
    setAdminConfigVersion(undefined)

    return { success: true }
  })

  server.handle(RPC_CHANNELS.admin.GET_STATUS, async () => {
    const manager = getCredentialManager()
    const tokens = await manager.getAdminTokens()

    return {
      adminUrl: getAdminUrl(),
      loggedIn: !!tokens,
      userId: tokens?.userId ?? null,
      username: tokens?.username ?? null,
      displayName: tokens?.displayName ?? tokens?.username ?? null,
    }
  })

  server.handle(RPC_CHANNELS.admin.SYNC_CONNECTIONS, async () => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const result = await syncAdminConnections({ adminUrl, manager, deps })
      return { success: true, ...result }
    } catch (error) {
      if (isSessionEndingAuthFailure(error)) {
        await endAdminSession(getCredentialManager(), deps)
      }
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] syncConnections failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(
    RPC_CHANNELS.admin.SYNC_APP_CATALOG,
    async (
      _ctx,
      rawOrganizationId: unknown,
      rawOptions?: unknown,
    ): Promise<AppCatalogSyncResult> => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      if (!organizationId.success) {
        return {
          success: false,
          errorCode: 'VALIDATION_ERROR',
          message: 'Organization id is invalid',
        }
      }
      const force = Boolean(
        rawOptions
        && typeof rawOptions === 'object'
        && (rawOptions as Record<string, unknown>).force === true,
      )

      const adminUrl = getAdminUrl()
      if (!adminUrl) {
        return {
          success: false,
          errorCode: 'VALIDATION_ERROR',
          message: 'Admin URL is not configured',
        }
      }
      const manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(adminUrl, manager, deps)
      if (!tokenResult.tokens) {
        return {
          success: false,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }

      const accountId = tokenResult.tokens.userId
      const cached = getCachedAppCatalog(accountId, organizationId.data)
      if (tokenResult.accessMode === 'offline') {
        setAppCatalogAccessMode(accountId, organizationId.data, 'offline')
        if (cached?.authorizationStatus === 'authorized') {
          return {
            success: true,
            catalog: cached,
            source: 'cache',
            refreshed: false,
            accessMode: 'offline',
            warning: tokenResult.warning ?? 'Failed to reach admin server',
          }
        }
        return {
          success: false,
          errorCode: 'NETWORK_ERROR',
          message: tokenResult.warning ?? 'Failed to reach admin server',
        }
      }
      try {
        const client = createAdminClient(adminUrl, manager)
        let result = await client.getAppCatalog(
          tokenResult.tokens.accessToken,
          organizationId.data,
          force || cached?.authorizationStatus === 'denied'
            ? undefined
            : cached?.appConfigVersion,
        )
        if (result.notModified && !cached) {
          result = await client.getAppCatalog(
            tokenResult.tokens.accessToken,
            organizationId.data,
          )
        }
        if (result.notModified) {
          if (!cached) {
            throw new AdminError(
              'Admin returned not modified without a local app catalog',
              'SERVER_ERROR',
            )
          }
          setAppCatalogAccessMode(accountId, organizationId.data, 'online')
          return {
            success: true,
            catalog: cached,
            source: 'cache',
            refreshed: false,
            accessMode: 'online',
          }
        }
        if (result.apps.some(app => app.organizationId !== organizationId.data)) {
          throw new AdminError(
            'Admin app catalog contains an app from another organization',
            'SERVER_ERROR',
          )
        }
        const savedCatalog = saveAppCatalog(
          accountId,
          organizationId.data,
          result,
        )
        setAppCatalogAccessMode(accountId, organizationId.data, 'online')
        return {
          success: true,
          catalog: savedCatalog,
          source: 'network',
          refreshed: true,
          accessMode: 'online',
        }
      } catch (error) {
        const adminError = toAdminRpcError(error)
        if (cached && isCatalogAuthorizationFailure(error)) {
          const deniedCatalog = denyCachedAppCatalogAuthorization(
            accountId,
            organizationId.data,
          )
          setAppCatalogAccessMode(accountId, organizationId.data, 'denied')
          if (deniedCatalog) {
            if (isSessionEndingAuthFailure(error)) {
              await endAdminSession(manager, deps)
            }
            log?.warn('[Admin] app catalog authorization denied:', adminError.message)
            return {
              success: true,
              catalog: deniedCatalog,
              source: 'cache',
              refreshed: false,
              accessMode: 'denied',
              warning: adminError.message,
            }
          }
        }
        if (isSessionEndingAuthFailure(error)) {
          setAppCatalogAccessMode(accountId, organizationId.data, 'denied')
          await endAdminSession(manager, deps)
        } else if (cached && isTemporaryAdminFailure(error)) {
          setAppCatalogAccessMode(accountId, organizationId.data, 'offline')
          log?.warn('[Admin] app catalog refresh failed; using cache:', adminError.message)
          return {
            success: true,
            catalog: cached,
            source: 'cache',
            refreshed: false,
            accessMode: 'offline',
            warning: adminError.message,
          }
        }
        log?.warn('[Admin] app catalog sync failed:', adminError.message)
        return { success: false, ...adminError }
      }
    },
  )

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATIONS, async () =>
    callOrganization('listOrganizations', (client, accessToken) =>
      client.listOrganizations(accessToken)))

  server.handle(RPC_CHANNELS.admin.CREATE_ORGANIZATION, async (_ctx, rawInput: unknown) => {
    const input = CreateOrganizationRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createOrganization', (client, accessToken) =>
      client.createOrganization(accessToken, input.data))
  })

  server.handle(RPC_CHANNELS.admin.PREVIEW_ORGANIZATION_JOIN, async (_ctx, rawToken: unknown) => {
    const token = OrganizationJoinTokenRpcInputSchema.safeParse(rawToken)
    if (!token.success) return adminInputError('VALIDATION_ERROR')
    try {
      const result = await createAdminClient(requireAdminUrl(), getCredentialManager())
        .previewOrganizationJoin(token.data)
      return { success: true, ...result }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] previewOrganizationJoin failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.ACCEPT_ORGANIZATION_JOIN, async (_ctx, rawToken: unknown) => {
    const token = OrganizationJoinTokenRpcInputSchema.safeParse(rawToken)
    if (!token.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('acceptOrganizationJoin', (client, accessToken) =>
      client.acceptOrganizationJoin(accessToken, token.data))
  })

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATION_MEMBERS, async (_ctx, rawOrganizationId: unknown) => {
    const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
    if (!organizationId.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('listOrganizationMembers', (client, accessToken) =>
      client.listOrganizationMembers(accessToken, organizationId.data))
  })

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATION_INVITATIONS, async (_ctx, rawOrganizationId: unknown) => {
    const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
    if (!organizationId.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('listOrganizationInvitations', (client, accessToken) =>
      client.listOrganizationInvitations(accessToken, organizationId.data))
  })

  server.handle(
    RPC_CHANNELS.admin.CREATE_ORGANIZATION_INVITATION,
    async (_ctx, rawOrganizationId: unknown, rawInput: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const input = CreateOrganizationInvitationRpcInputSchema.safeParse(rawInput)
      if (!organizationId.success || !input.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('createOrganizationInvitation', (client, accessToken) =>
        client.createOrganizationInvitation(accessToken, organizationId.data, input.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.CANCEL_ORGANIZATION_INVITATION,
    async (_ctx, rawOrganizationId: unknown, rawInvitationId: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const invitationId = OrganizationIdRpcInputSchema.safeParse(rawInvitationId)
      if (!organizationId.success || !invitationId.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('cancelOrganizationInvitation', (client, accessToken) =>
        client.cancelOrganizationInvitation(accessToken, organizationId.data, invitationId.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.CREATE_ORGANIZATION_JOIN_LINK,
    async (_ctx, rawOrganizationId: unknown, rawInput: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const input = CreateOrganizationJoinLinkRpcInputSchema.safeParse(rawInput)
      if (!organizationId.success || !input.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('createOrganizationJoinLink', (client, accessToken) =>
        client.createOrganizationJoinLink(accessToken, organizationId.data, input.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.REVOKE_ORGANIZATION_JOIN_LINK,
    async (_ctx, rawOrganizationId: unknown, rawJoinLinkId: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const joinLinkId = OrganizationIdRpcInputSchema.safeParse(rawJoinLinkId)
      if (!organizationId.success || !joinLinkId.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('revokeOrganizationJoinLink', (client, accessToken) =>
        client.revokeOrganizationJoinLink(accessToken, organizationId.data, joinLinkId.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.UPDATE_ORGANIZATION_MEMBER,
    async (
      _ctx,
      rawOrganizationId: unknown,
      rawMemberId: unknown,
      rawInput: unknown,
    ) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const memberId = OrganizationIdRpcInputSchema.safeParse(rawMemberId)
      const input = UpdateOrganizationMemberRpcInputSchema.safeParse(rawInput)
      if (!organizationId.success || !memberId.success || !input.success) {
        return adminInputError('VALIDATION_ERROR')
      }
      return callOrganization('updateOrganizationMember', (client, accessToken) =>
        client.updateOrganizationMember(
          accessToken,
          organizationId.data,
          memberId.data,
          input.data,
        ))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.REMOVE_ORGANIZATION_MEMBER,
    async (
      _ctx,
      rawOrganizationId: unknown,
      rawMemberId: unknown,
      rawReason: unknown,
    ) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const memberId = OrganizationIdRpcInputSchema.safeParse(rawMemberId)
      const input = RemoveOrganizationMemberRpcInputSchema.safeParse(
        rawReason === undefined ? {} : { reason: rawReason },
      )
      if (!organizationId.success || !memberId.success || !input.success) {
        return adminInputError('VALIDATION_ERROR')
      }
      return callOrganization('removeOrganizationMember', (client, accessToken) =>
        client.removeOrganizationMember(
          accessToken,
          organizationId.data,
          memberId.data,
          input.data.reason,
        ))
    },
  )
}

function requireAdminUrl(): string {
  const adminUrl = getAdminUrl()
  if (!adminUrl) {
    throw new AdminError('Admin URL is not configured', 'VALIDATION_ERROR')
  }
  return adminUrl
}

function createAdminClient(adminUrl: string, manager: CredentialManager): AdminClient {
  return new AdminClient(adminUrl, {
    tokenStore: {
      async getRefreshToken() {
        return (await manager.getAdminTokens())?.refreshToken ?? null
      },
      async onTokensRefreshed(tokens) {
        await persistRefreshedTokens(manager, tokens)
      },
    },
  })
}

function adminUserFromStoredTokens(tokens: StoredAdminTokens): AdminUser {
  return {
    id: tokens.userId,
    username: tokens.username,
    displayName: tokens.displayName ?? null,
    role: tokens.role ?? 'member',
    groupIds: tokens.groupIds ?? [],
  }
}

async function persistVerifiedAdminUser(
  manager: CredentialManager,
  tokens: StoredAdminTokens,
  user: AdminUser,
): Promise<void> {
  await manager.setAdminTokens({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    userId: user.id,
    username: user.username,
    displayName: user.displayName ?? undefined,
    role: user.role,
    groupIds: user.groupIds,
  })
}

async function endAdminSession(
  manager: CredentialManager,
  deps?: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'>,
): Promise<void> {
  const tokens = await manager.getAdminTokens()
  if (tokens) {
    try {
      await deps?.onAdminSessionEnding?.(tokens.userId)
    } catch (error) {
      deps?.platform.logger?.warn(
        '[Admin] failed to stop account local apps before clearing credentials:',
        error instanceof Error ? error.message : String(error),
      )
    }
    denyAppCatalogAccessForAccount(tokens.userId)
    denyCachedAppCatalogAuthorizationForAccount(tokens.userId)
  }
  await manager.deleteAdminTokens()
}

async function completeAdminLogin(args: {
  adminUrl: string
  manager: CredentialManager
  login: AdminLoginResponse
  onSyncFailure: (error: unknown) => void
}): Promise<void> {
  await args.manager.setAdminTokens({
    accessToken: args.login.accessToken,
    refreshToken: args.login.refreshToken,
    expiresAt: expiresAtFromNow(args.login.expiresIn),
    userId: args.login.user.id,
    username: args.login.user.username,
    displayName: args.login.user.displayName ?? undefined,
    role: args.login.user.role,
    groupIds: args.login.user.groupIds,
  })

  const previousAdminConnectionSlugs = getAdminManagedConnectionSlugs()
  setAdminConfigVersion(undefined)

  try {
    await deleteAdminManagedConnections(args.manager, previousAdminConnectionSlugs)
    await syncAdminConnections({
      adminUrl: args.adminUrl,
      manager: args.manager,
      accessToken: args.login.accessToken,
    })
  } catch (error) {
    // Authentication has already succeeded and the one-time code may already
    // be consumed. Keep the persisted session, but fail closed for model
    // authorization so a previous account's managed connections cannot be used.
    setAdminConfigVersion(undefined)
    try {
      await deleteAdminManagedConnections(
        args.manager,
        previousAdminConnectionSlugs,
      )
    } catch (cleanupError) {
      args.onSyncFailure(cleanupError)
    }
    args.onSyncFailure(error)
  }
}

function logPostLoginSyncFailure(
  log: HandlerDeps['platform']['logger'],
  error: unknown,
): void {
  log?.warn(
    '[Admin] post-login connection sync failed; session remains authenticated:',
    error instanceof Error ? error.message : String(error),
  )
}

async function ensureValidTokens(
  adminUrl: string,
  manager: CredentialManager,
  deps?: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'>,
): Promise<TokenValidationResult> {
  const tokens = await manager.getAdminTokens()
  if (!tokens) return { tokens: null }

  if (!manager.isExpired({
    value: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  })) {
    return { tokens, accessMode: 'online' }
  }

  try {
    const refreshed = await createAdminClient(adminUrl, manager).refresh(tokens.refreshToken)
    await persistRefreshedTokens(manager, refreshed)
    return {
      tokens: {
        ...tokens,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: expiresAtFromNow(refreshed.expiresIn),
      },
      accessMode: 'online',
    }
  } catch (error) {
    if (isSessionEndingAuthFailure(error)) {
      await endAdminSession(manager, deps)
      return {
        tokens: null,
        authError: toAdminRpcError(error),
      }
    }
    if (isTemporaryAdminFailure(error)) {
      return {
        tokens,
        accessMode: 'offline',
        warning: toAdminRpcError(error).message,
      }
    }
    return {
      tokens,
      accessMode: 'offline',
      warning: toAdminRpcError(error).message,
    }
  }
}

async function persistRefreshedTokens(manager: CredentialManager, refreshed: AdminRefreshResponse): Promise<void> {
  const existing = await manager.getAdminTokens()
  if (!existing) return

  await manager.setAdminTokens({
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: expiresAtFromNow(refreshed.expiresIn),
    userId: existing.userId,
    username: existing.username,
    displayName: existing.displayName,
    role: existing.role,
    groupIds: existing.groupIds,
  })
}

async function syncAdminConnections(args: {
  adminUrl: string
  manager: CredentialManager
  accessToken?: string
  deps?: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'>
}): Promise<{ configVersion: string; connectionCount: number; defaultConnection: string | null }> {
  const tokens = args.accessToken
    ? null
    : await ensureValidTokens(args.adminUrl, args.manager, args.deps)
  const accessToken = args.accessToken ?? tokens?.tokens?.accessToken
  if (!accessToken) {
    throw new AdminError('Admin session is not logged in', 'UNAUTHORIZED')
  }
  if (tokens && 'accessMode' in tokens && tokens.accessMode === 'offline') {
    throw new AdminError('Failed to reach admin server', 'NETWORK_ERROR')
  }

  const connectionSlugsToRevoke = new Set(getAdminManagedConnectionSlugs())
  try {
    const client = createAdminClient(args.adminUrl, args.manager)
    const response = await client.getLlmConnections(accessToken)
    const incomingSlugs = new Set(response.connections.map(connection => connection.slug))
    for (const slug of incomingSlugs) {
      connectionSlugsToRevoke.add(slug)
    }

    for (const existing of getLlmConnections()) {
      if (existing.managedBy === 'admin' && !incomingSlugs.has(existing.slug)) {
        await deleteConnectionAndCredentials(args.manager, existing.slug)
      }
    }

    for (const connection of response.connections) {
      await upsertAdminConnection(args.manager, connection, response.configVersion, accessToken)
    }

    if (response.defaultConnection && getLlmConnections().some(connection => connection.slug === response.defaultConnection)) {
      setDefaultLlmConnection(response.defaultConnection)
    }

    setAdminConfigVersion(response.configVersion)

    return {
      configVersion: response.configVersion,
      connectionCount: response.connections.length,
      defaultConnection: response.defaultConnection,
    }
  } catch (error) {
    setAdminConfigVersion(undefined)
    await deleteAdminManagedConnections(args.manager, connectionSlugsToRevoke)
    throw error
  }
}

async function upsertAdminConnection(
  manager: CredentialManager,
  connection: AdminLlmConnection,
  configVersion: string,
  accessToken: string,
): Promise<void> {
  const apiKey = readApiKey(connection, accessToken)
  const { apiKey: _apiKey, key: _key, credentials: _credentials, endpoint, ...configConnection } = connection
  const adminConnection: LlmConnection = {
    ...configConnection,
    baseUrl: endpoint ?? configConnection.baseUrl,
    createdAt: configConnection.createdAt ?? Date.now(),
    managedBy: 'admin',
    adminConfigVersion: configVersion,
  }
  const piAuthProvider = deriveAdminPiAuthProvider(adminConnection)
  if (piAuthProvider && !adminConnection.piAuthProvider) {
    adminConnection.piAuthProvider = piAuthProvider
  }

  const existing = getLlmConnections().find(item => item.slug === adminConnection.slug)
  if (existing) {
    scrubCredentialFields(existing)
    const { slug: _slug, ...updates } = adminConnection
    updateLlmConnection(adminConnection.slug, updates)
  } else {
    addLlmConnection(adminConnection)
  }

  if (apiKey) {
    await manager.setLlmApiKey(adminConnection.slug, apiKey)
  }
}

function deriveAdminPiAuthProvider(connection: LlmConnection): string | undefined {
  if (
    connection.providerType !== 'pi_compat' ||
    !connection.baseUrl?.trim() ||
    !connection.customEndpoint?.api
  ) {
    return undefined
  }

  return connection.customEndpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai'
}

export function readApiKey(connection: AdminLlmConnection, accessToken: string): string | null {
  const value =
    connection.apiKey ??
    connection.key ??
    connection.credentials?.apiKey ??
    connection.credentials?.key
  if (isTransitEncryptedApiKey(value)) {
    return decryptTransitApiKey(value, deriveTransitKey(accessToken))
  }
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isTransitEncryptedApiKey(value: unknown): value is { alg: string; iv: string; ciphertext: string; tag: string } {
  if (!value || typeof value !== 'object') return false
  const encrypted = value as { alg?: unknown; iv?: unknown; ciphertext?: unknown; tag?: unknown }
  return encrypted.alg === 'A256GCM' &&
    typeof encrypted.iv === 'string' &&
    typeof encrypted.ciphertext === 'string' &&
    typeof encrypted.tag === 'string'
}

function scrubCredentialFields(connection: LlmConnection): void {
  const mutable = connection as LlmConnection & {
    apiKey?: unknown
    key?: unknown
    credentials?: unknown
  }
  delete mutable.apiKey
  delete mutable.key
  delete mutable.credentials
}

function getAdminManagedConnectionSlugs(): string[] {
  return getLlmConnections()
    .filter(connection => connection.managedBy === 'admin')
    .map(connection => connection.slug)
}

async function deleteAdminManagedConnections(
  manager: CredentialManager,
  additionalSlugs: Iterable<string> = [],
): Promise<void> {
  const slugs = new Set([
    ...additionalSlugs,
    ...getAdminManagedConnectionSlugs(),
  ])

  // Remove every connection from active configuration before awaiting keychain
  // cleanup. Even if credential deletion fails, model dispatch can no longer
  // resolve a previous account's Admin-managed connection.
  for (const slug of slugs) {
    deleteLlmConnection(slug)
  }

  await Promise.all(
    [...slugs].map(slug => manager.deleteLlmCredentials(slug)),
  )
}

async function deleteConnectionAndCredentials(manager: CredentialManager, slug: string): Promise<void> {
  deleteLlmConnection(slug)
  await manager.deleteLlmCredentials(slug)
}

function expiresAtFromNow(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000
}

function isSessionEndingAuthFailure(error: unknown): boolean {
  return error instanceof AdminError && (
    error.errorCode === 'UNAUTHORIZED' ||
    error.errorCode === 'ACCOUNT_DISABLED' ||
    error.errorCode === 'INVALID_TOKEN' ||
    error.errorCode === 'TOKEN_REVOKED' ||
    error.errorCode === 'TOKEN_EXPIRED' ||
    error.errorCode === 'FORBIDDEN' ||
    error.status === 401 ||
    error.status === 403
  )
}

function isTemporaryAdminFailure(error: unknown): boolean {
  return error instanceof AdminError && (
    error.errorCode === 'NETWORK_ERROR'
    || error.errorCode === 'SERVER_ERROR'
    || (typeof error.status === 'number' && error.status >= 500)
  )
}

function isCatalogAuthorizationFailure(error: unknown): boolean {
  return error instanceof AdminError && (
    error.errorCode === 'FORBIDDEN'
    || error.errorCode === 'ACCOUNT_DISABLED'
    || error.errorCode === 'NOT_FOUND'
    || error.status === 403
  )
}

function toAdminRpcError(error: unknown): {
  errorCode: string
  message: string
  status?: number
  retryAfter?: number
} {
  if (error instanceof AdminError) {
    return {
      errorCode: error.errorCode,
      message: getSafeAdminErrorMessage(error.errorCode, error.status),
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(typeof error.details?.retryAfter === 'number'
        && Number.isFinite(error.details.retryAfter)
        && error.details.retryAfter > 0
        && error.details.retryAfter <= 86_400
        ? { retryAfter: error.details.retryAfter }
        : {}),
    }
  }
  if (error instanceof Error) {
    return { errorCode: 'UNKNOWN_ERROR', message: 'Admin request failed' }
  }
  return { errorCode: 'UNKNOWN_ERROR', message: 'Admin request failed' }
}

function adminInputError(errorCode: AdminErrorCode): {
  success: false
  errorCode: AdminErrorCode
  message: string
} {
  return {
    success: false,
    errorCode,
    message: getSafeAdminErrorMessage(errorCode),
  }
}

function hasValidationIssue(
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
  field: string,
): boolean {
  return issues.some(issue => issue.path[0] === field)
}
