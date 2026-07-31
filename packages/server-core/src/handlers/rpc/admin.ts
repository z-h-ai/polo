import {
  AdminClient,
  AdminError,
  getSafeAdminErrorMessage,
  type AdminErrorCode,
  type AdminLlmConnection,
  type AdminLoginResponse,
  type AdminRefreshResponse,
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
  CreateCreatorArtifactRpcInputSchema,
  CreatorArtifactArchiveRpcInputSchema,
  CreatorArtifactIdRpcInputSchema,
  CreatorArtifactListRpcInputSchema,
  CreatorArtifactRevokeRpcInputSchema,
  CreatorArtifactUploadCompleteRpcInputSchema,
  CreatorArtifactUploadGrantRpcInputSchema,
  CreatorArtifactVersionRpcInputSchema,
  CreatorSkillArchiveError,
  CreatorSkillDownloadRpcInputSchema,
  CreatorSkillSafetyRpcInputSchema,
  CreateCreatorArtifactVersionRpcInputSchema,
} from '@polo-ai/shared/creator-skills'
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
  RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT_CAPABILITIES,
  RPC_CHANNELS.admin.LIST_CREATOR_ARTIFACTS,
  RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT,
  RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT,
  RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_DRAFT,
  RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT_VERSION,
  RPC_CHANNELS.admin.CREATE_CREATOR_SKILL_UPLOAD_GRANT,
  RPC_CHANNELS.admin.COMPLETE_CREATOR_SKILL_UPLOAD,
  RPC_CHANNELS.admin.PUBLISH_CREATOR_ARTIFACT_VERSION,
  RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_VERSION_DRAFT,
  RPC_CHANNELS.admin.SET_CREATOR_ARTIFACT_ARCHIVED,
  RPC_CHANNELS.admin.REVOKE_CREATOR_ARTIFACT_VERSION,
  RPC_CHANNELS.admin.GET_CREATOR_SKILL_DOWNLOAD_GRANT,
  RPC_CHANNELS.admin.GET_CREATOR_SKILL_SAFETY_STATUS,
] as const

type StoredAdminTokens = NonNullable<Awaited<ReturnType<CredentialManager['getAdminTokens']>>>
type TokenValidationResult =
  | { tokens: StoredAdminTokens }
  | { tokens: null; authError?: { errorCode: string; message: string; status?: number } }

export function registerAdminHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const callOrganization = async <T extends object>(
    operation: string,
    callback: (
      client: AdminClient,
      accessToken: string,
      userId: string,
    ) => Promise<T>,
  ) => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(adminUrl, manager)
      if (!tokenResult.tokens) {
        invalidateAllCreatorArtifactCaches()
        return {
          success: false as const,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }
      const result = await callback(
        createAdminClient(adminUrl, manager),
        tokenResult.tokens.accessToken,
        tokenResult.tokens.userId,
      )
      return { success: true as const, ...result }
    } catch (error) {
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
      invalidateAllCreatorArtifactCaches()
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
        invalidateAllCreatorArtifactCaches()
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
      const tokenResult = await ensureValidTokens(adminUrl, manager)
      if (!tokenResult.tokens) {
        return {
          success: false,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }

      const result = await createAdminClient(adminUrl, manager)
        .setPassword(tokenResult.tokens.accessToken, input.data)
      return { success: result.success }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] setPassword failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.VALIDATE, async () => {
    const adminUrl = getAdminUrl()
    if (!adminUrl) {
      invalidateAllCreatorArtifactCaches()
      return { loggedIn: false }
    }

    const manager = getCredentialManager()
    const tokenResult = await ensureValidTokens(adminUrl, manager)
    if (!tokenResult.tokens) {
      invalidateAllCreatorArtifactCaches()
      if (tokenResult.authError) {
        return { loggedIn: false, ...tokenResult.authError }
      }
      return { loggedIn: false }
    }

    try {
      const client = createAdminClient(adminUrl, manager)
      const validation = await client.validate(tokenResult.tokens.accessToken)
      if (!validation.valid) {
        invalidateAllCreatorArtifactCaches()
        await manager.deleteAdminTokens()
        return { loggedIn: false }
      }

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
      if (isAuthFailure(error)) {
        invalidateAllCreatorArtifactCaches()
        await manager.deleteAdminTokens()
        return { loggedIn: false, ...toAdminRpcError(error) }
      }
      throw error
    }
  })

  server.handle(RPC_CHANNELS.admin.LOGOUT, async () => {
    invalidateAllCreatorArtifactCaches()
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

    await manager.deleteAdminTokens()
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
      const result = await syncAdminConnections({ adminUrl, manager })
      return { success: true, ...result }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] syncConnections failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATIONS, async () =>
    callOrganization('listOrganizations', async (client, accessToken, userId) => {
      // Organization refresh is also the membership-change boundary. Never
      // reuse catalog pages captured before the refreshed membership snapshot.
      invalidateCreatorArtifactCache(userId)
      const organizations = await client.listOrganizations(accessToken)
      // Also invalidate requests that began while the membership refresh was
      // in flight, before its authoritative response became visible.
      invalidateCreatorArtifactCache(userId)
      return organizations
    }))

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
      return callOrganization('updateOrganizationMember', async (
        client,
        accessToken,
        userId,
      ) => {
        const result = await client.updateOrganizationMember(
          accessToken,
          organizationId.data,
          memberId.data,
          input.data,
        )
        invalidateCreatorArtifactCache(userId, organizationId.data)
        return result
      })
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
      return callOrganization('removeOrganizationMember', async (
        client,
        accessToken,
        userId,
      ) => {
        const result = await client.removeOrganizationMember(
          accessToken,
          organizationId.data,
          memberId.data,
          input.data.reason,
        )
        invalidateCreatorArtifactCache(userId, organizationId.data)
        return result
      })
    },
  )

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT_CAPABILITIES, async () =>
    callOrganization('getCreatorArtifactCapabilities', (client, accessToken) =>
      client.getCreatorArtifactCapabilities(accessToken)))

  server.handle(RPC_CHANNELS.admin.LIST_CREATOR_ARTIFACTS, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactListRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization(
      'listCreatorArtifacts',
      async (client, accessToken, userId) => {
        const key = [
          userId,
          input.data.organizationId,
          input.data.type ?? '',
          input.data.includeDrafts ? 'drafts' : 'published',
          input.data.cursor ?? '',
        ].join('\0')
        const cached = creatorArtifactCatalogCache.get(key)
        if (cached && cached.expiresAt > Date.now()) return cached.value
        const generation = creatorArtifactCacheGeneration(
          userId,
          input.data.organizationId,
        )
        const value = await client.listCreatorArtifacts(accessToken, input.data)
        if (creatorArtifactCacheGenerationMatches(
          userId,
          input.data.organizationId,
          generation,
        )) {
          creatorArtifactCatalogCache.set(key, {
            expiresAt: Date.now() + CREATOR_ARTIFACT_CACHE_TTL_MS,
            value,
          })
        }
        return value
      },
    )
  })

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactIdRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('getCreatorArtifact', (client, accessToken) =>
      client.getCreatorArtifact(
        accessToken,
        input.data.organizationId,
        input.data.artifactId,
        input.data.version,
        input.data.referencePath,
      ))
  })

  server.handle(RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT, async (_ctx, rawInput: unknown) => {
    const input = CreateCreatorArtifactRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createCreatorArtifact', async (client, accessToken, userId) => {
      const result = await client.createCreatorArtifact(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_DRAFT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactVersionRpcInputSchema.omit({ version: true })
      .safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('deleteCreatorArtifactDraft', async (client, accessToken, userId) => {
      const result = await client.deleteCreatorArtifactDraft(
        accessToken,
        input.data.organizationId,
        input.data.artifactId,
        input.data.idempotencyKey,
      )
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT_VERSION, async (_ctx, rawInput: unknown) => {
    const input = CreateCreatorArtifactVersionRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createCreatorArtifactVersion', async (client, accessToken, userId) => {
      const result = await client.createCreatorArtifactVersion(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  // The renderer owns the selected File and PUTs it directly. This RPC only
  // renews a short-lived grant and never receives archive bytes.
  server.handle(RPC_CHANNELS.admin.CREATE_CREATOR_SKILL_UPLOAD_GRANT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactUploadGrantRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createCreatorSkillUploadGrant', async (client, accessToken) => ({
      grant: await client.createCreatorSkillUploadGrant(accessToken, input.data),
    }))
  })

  server.handle(RPC_CHANNELS.admin.COMPLETE_CREATOR_SKILL_UPLOAD, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactUploadCompleteRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('completeCreatorSkillUpload', async (client, accessToken, userId) => {
      const completed = await client.completeCreatorSkillUpload(accessToken, input.data)
      const archiveChecksum = completed.archiveChecksum
      if (!archiveChecksum) {
        throw new AdminError(
          'Admin service did not calculate the uploaded archive checksum',
          'checksum_mismatch',
        )
      }
      const result = await client.triggerCreatorSkillValidation(accessToken, {
        artifactId: input.data.artifactId,
        version: input.data.version,
      })
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return { version: result }
    })
  })

  server.handle(RPC_CHANNELS.admin.PUBLISH_CREATOR_ARTIFACT_VERSION, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactVersionRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('publishCreatorArtifactVersion', async (client, accessToken, userId) => {
      const result = await client.publishCreatorArtifactVersion(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_VERSION_DRAFT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactVersionRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('deleteCreatorArtifactVersionDraft', async (client, accessToken, userId) => {
      const result = await client.deleteCreatorArtifactVersionDraft(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.SET_CREATOR_ARTIFACT_ARCHIVED, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactArchiveRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('setCreatorArtifactArchived', async (client, accessToken, userId) => {
      const result = await client.setCreatorArtifactArchived(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.REVOKE_CREATOR_ARTIFACT_VERSION, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactRevokeRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('revokeCreatorArtifactVersion', async (client, accessToken, userId) => {
      const result = await client.revokeCreatorArtifactVersion(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_SKILL_DOWNLOAD_GRANT, async (_ctx, rawInput: unknown) => {
    const input = CreatorSkillDownloadRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('getCreatorSkillDownloadGrant', (client, accessToken) =>
      client.getCreatorSkillDownloadGrant(accessToken, input.data))
  })

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_SKILL_SAFETY_STATUS, async (_ctx, rawInput: unknown) => {
    const input = CreatorSkillSafetyRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('getCreatorSkillSafetyStatus', (client, accessToken) =>
      client.getCreatorSkillSafetyStatus(accessToken, input.data))
  })
}

const CREATOR_ARTIFACT_CACHE_TTL_MS = 30_000
const creatorArtifactCatalogCache = new Map<string, {
  expiresAt: number
  value: Awaited<ReturnType<AdminClient['listCreatorArtifacts']>>
}>()
let creatorArtifactGlobalGeneration = 0
const creatorArtifactUserGenerations = new Map<string, number>()
const creatorArtifactOrganizationGenerations = new Map<string, number>()

interface CreatorArtifactCacheGeneration {
  global: number
  user: number
  organization: number
}

function creatorArtifactCacheGeneration(
  userId: string,
  organizationId: string,
): CreatorArtifactCacheGeneration {
  return {
    global: creatorArtifactGlobalGeneration,
    user: creatorArtifactUserGenerations.get(userId) ?? 0,
    organization: creatorArtifactOrganizationGenerations
      .get(`${userId}\0${organizationId}`) ?? 0,
  }
}

function creatorArtifactCacheGenerationMatches(
  userId: string,
  organizationId: string,
  generation: CreatorArtifactCacheGeneration,
): boolean {
  const current = creatorArtifactCacheGeneration(userId, organizationId)
  return current.global === generation.global
    && current.user === generation.user
    && current.organization === generation.organization
}

function invalidateAllCreatorArtifactCaches(): void {
  creatorArtifactGlobalGeneration += 1
  creatorArtifactCatalogCache.clear()
  creatorArtifactUserGenerations.clear()
  creatorArtifactOrganizationGenerations.clear()
}

function invalidateCreatorArtifactCache(userId: string, organizationId?: string): void {
  if (organizationId) {
    // Publication and membership changes alter what every member may see.
    // A per-actor eviction leaves a recently cached member catalog showing a
    // stale role view after an owner changes that member's role.
    creatorArtifactGlobalGeneration += 1
    creatorArtifactCatalogCache.clear()
    creatorArtifactOrganizationGenerations.clear()
    return
  } else {
    creatorArtifactUserGenerations.set(
      userId,
      (creatorArtifactUserGenerations.get(userId) ?? 0) + 1,
    )
  }
  const prefix = organizationId ? `${userId}\0${organizationId}\0` : `${userId}\0`
  for (const key of creatorArtifactCatalogCache.keys()) {
    if (key.startsWith(prefix)) creatorArtifactCatalogCache.delete(key)
  }
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

async function ensureValidTokens(adminUrl: string, manager: CredentialManager): Promise<TokenValidationResult> {
  const tokens = await manager.getAdminTokens()
  if (!tokens) return { tokens: null }

  if (!manager.isExpired({
    value: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  })) {
    return { tokens }
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
    }
  } catch (error) {
    await manager.deleteAdminTokens()
    return {
      tokens: null,
      authError: isAuthFailure(error) ? toAdminRpcError(error) : undefined,
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
  })
}

async function syncAdminConnections(args: {
  adminUrl: string
  manager: CredentialManager
  accessToken?: string
}): Promise<{ configVersion: string; connectionCount: number; defaultConnection: string | null }> {
  const tokens = args.accessToken
    ? null
    : await ensureValidTokens(args.adminUrl, args.manager)
  const accessToken = args.accessToken ?? tokens?.tokens?.accessToken
  if (!accessToken) {
    throw new AdminError('Admin session is not logged in', 'UNAUTHORIZED')
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

function isAuthFailure(error: unknown): boolean {
  return error instanceof AdminError && (
    error.errorCode === 'UNAUTHORIZED' ||
    error.errorCode === 'ACCOUNT_DISABLED' ||
    error.errorCode === 'INVALID_TOKEN' ||
    error.errorCode === 'TOKEN_REVOKED' ||
    error.errorCode === 'TOKEN_EXPIRED'
  )
}

function toAdminRpcError(error: unknown): {
  errorCode: string
  message: string
  status?: number
  retryAfter?: number
  validationIssues?: import('@polo-ai/shared/creator-skills').SkillValidationIssue[]
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
  if (error instanceof CreatorSkillArchiveError) {
    return {
      errorCode: error.code,
      message: getSafeAdminErrorMessage(error.code),
      validationIssues: error.issues,
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
