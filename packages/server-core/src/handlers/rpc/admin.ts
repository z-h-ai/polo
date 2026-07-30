import {
  AdminClient,
  AdminError,
  denyAppCatalogAccessForAccount,
  denyCachedAppCatalogAuthorization,
  denyCachedAppCatalogAuthorizationForAccount,
  getAppCatalogAccessMode,
  getCachedAppCatalog,
  getSafeAdminErrorMessage,
  listCachedAppCatalogs,
  resumeAppCatalogAccessForAccount,
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
interface AdminSessionSnapshot {
  generation: number
  tokens: StoredAdminTokens
}

interface AdminSessionEndingTransition {
  session: AdminSessionSnapshot
  cleanup: Promise<void>
}

interface AdminRequestContext {
  session: AdminSessionSnapshot
}

type TokenValidationResult =
  | {
      tokens: StoredAdminTokens
      session: AdminSessionSnapshot
      accessMode: 'online' | 'offline'
      warning?: string
    }
  | {
      tokens: null
      stale?: boolean
      authError?: { errorCode: string; message: string; status?: number }
    }

interface AdminSessionMutationResult<T> {
  applied: boolean
  value?: T
}

export type AdminSessionEndResult = 'ended' | 'no_session' | 'session_changed'

export interface AdminSessionControl {
  endCurrentSession(
    beforeDelete?: (manager: CredentialManager) => void | Promise<void>,
  ): Promise<AdminSessionEndResult>
}

class AdminSessionChangedError extends Error {
  constructor() {
    super('Admin session changed while the request was in flight')
    this.name = 'AdminSessionChangedError'
  }
}

/**
 * Serializes trusted Admin session transitions. The session generation, login
 * attempt, and ending snapshot are advanced only by code running under
 * `runExclusive`; an ending generation therefore closes every older commit
 * before the lock is released. Host cleanup is started while that transition
 * is locked, but its slow promise stays outside the mutation tail so a new
 * login is not blocked. Cleanup is single-flight per account until settlement,
 * and the recorded generation keeps an older finalizer from deleting a newer
 * cleanup entry.
 */
class AdminSessionCoordinator {
  private generation = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private loginAttempt = 0
  private endingSession: AdminSessionSnapshot | null = null
  private readonly accountCleanups = new Map<string, {
    generation: number
    promise: Promise<void>
  }>()

  constructor(
    private readonly closeCatalogAuthorization: (accountId: string) => void,
  ) {}

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async beginLoginAttempt(): Promise<number> {
    return this.runExclusive(async () => {
      this.loginAttempt += 1
      return this.loginAttempt
    })
  }

  isLatestLoginAttempt(attempt: number): boolean {
    return attempt === this.loginAttempt
  }

  advanceGeneration(): number {
    this.generation += 1
    return this.generation
  }

  closeAuthorizationForEnding(accountId: string): void {
    this.closeCatalogAuthorization(accountId)
  }

  getOrStartAccountCleanup(
    accountId: string,
    cleanupGeneration: number,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    const existing = this.accountCleanups.get(accountId)
    if (existing) return existing.promise

    let operationResult: Promise<void>
    try {
      operationResult = Promise.resolve(operation())
    } catch (error) {
      operationResult = Promise.reject(error)
    }
    let trackedPromise!: Promise<void>
    trackedPromise = operationResult.finally(() => {
      const current = this.accountCleanups.get(accountId)
      if (
        current?.generation === cleanupGeneration
        && current.promise === trackedPromise
      ) {
        this.accountCleanups.delete(accountId)
      }
    })
    this.accountCleanups.set(accountId, {
      generation: cleanupGeneration,
      promise: trackedPromise,
    })
    return trackedPromise
  }

  createSnapshot(tokens: StoredAdminTokens): AdminSessionSnapshot {
    return {
      generation: this.generation,
      tokens: { ...tokens },
    }
  }

  async capture(
    manager: CredentialManager,
  ): Promise<AdminSessionSnapshot | null> {
    return this.runExclusive(async () => {
      const tokens = await manager.getAdminTokens()
      return tokens && !this.isCurrentSessionEnding(tokens)
        ? this.createSnapshot(tokens)
        : null
    })
  }

  async isCurrent(
    manager: CredentialManager,
    expected: AdminSessionSnapshot,
  ): Promise<boolean> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      return this.matches(current, expected)
    })
  }

  async mutateIfCurrent<T>(
    manager: CredentialManager,
    expected: AdminSessionSnapshot,
    operation: (current: StoredAdminTokens) => Promise<T>,
  ): Promise<AdminSessionMutationResult<T>> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      if (!this.matches(current, expected)) return { applied: false }
      return { applied: true, value: await operation(current!) }
    })
  }

  async beginEnding(
    manager: CredentialManager,
    expected: AdminSessionSnapshot,
    beginAccountCleanup: (accountId: string) => void | Promise<void>,
  ): Promise<AdminSessionEndingTransition | null> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      if (!this.matches(current, expected)) return null
      this.advanceGeneration()
      const ending = this.createSnapshot(current!)
      this.endingSession = ending
      this.closeAuthorizationForEnding(current!.userId)
      const cleanup = this.getOrStartAccountCleanup(
        current!.userId,
        ending.generation,
        () => beginAccountCleanup(current!.userId),
      )
      // The caller awaits and reports this promise after any remote side
      // effect. Observe it now so a fast rejection cannot become unhandled.
      void cleanup.catch(() => {})
      return { session: ending, cleanup }
    })
  }

  async finishEndingIfCurrent<T>(
    manager: CredentialManager,
    ending: AdminSessionSnapshot,
    operation: (current: StoredAdminTokens) => Promise<T>,
  ): Promise<AdminSessionMutationResult<T>> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      if (!this.matchesEnding(current, ending)) {
        if (this.sameSnapshot(this.endingSession, ending)) {
          this.endingSession = null
        }
        return { applied: false }
      }
      const value = await operation(current!)
      this.advanceGeneration()
      this.endingSession = null
      return { applied: true, value }
    })
  }

  private isCurrentSessionEnding(current: StoredAdminTokens): boolean {
    return Boolean(
      this.endingSession
      && this.endingSession.generation === this.generation
      && this.tokensMatch(current, this.endingSession.tokens),
    )
  }

  private matchesEnding(
    current: StoredAdminTokens | null,
    ending: AdminSessionSnapshot,
  ): boolean {
    return Boolean(
      current
      && this.sameSnapshot(this.endingSession, ending)
      && ending.generation === this.generation
      && this.tokensMatch(current, ending.tokens),
    )
  }

  private sameSnapshot(
    left: AdminSessionSnapshot | null,
    right: AdminSessionSnapshot,
  ): boolean {
    return Boolean(
      left
      && left.generation === right.generation
      && this.tokensMatch(left.tokens, right.tokens),
    )
  }

  private tokensMatch(
    current: StoredAdminTokens,
    expected: StoredAdminTokens,
  ): boolean {
    return (
      current.userId === expected.userId
      && current.accessToken === expected.accessToken
      && current.refreshToken === expected.refreshToken
    )
  }

  private matches(
    current: StoredAdminTokens | null,
    expected: AdminSessionSnapshot,
  ): boolean {
    return Boolean(
      current
      && expected.generation === this.generation
      && !this.isCurrentSessionEnding(current)
      && this.tokensMatch(current, expected.tokens),
    )
  }
}

function staleAdminSessionResult(): {
  success: false
  errorCode: 'SESSION_CHANGED'
  message: string
} {
  return {
    success: false,
    errorCode: 'SESSION_CHANGED',
    message: 'Admin session changed',
  }
}

function staleAdminValidationResult(): {
  loggedIn: false
  errorCode: 'SESSION_CHANGED'
  message: string
} {
  return {
    loggedIn: false,
    errorCode: 'SESSION_CHANGED',
    message: 'Admin session changed',
  }
}

export function registerAdminHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): AdminSessionControl {
  const log = deps.platform.logger
  let appCatalogSyncInvocation = 0
  const latestAppCatalogSyncByScope = new Map<string, number>()
  const appCatalogAuthorizationEpochByScope = new Map<string, number>()
  const appCatalogScopeKey = (accountId: string, organizationId: string) =>
    `${accountId}\0${organizationId}`
  const currentAppCatalogAuthorizationEpoch = (scopeKey: string) =>
    appCatalogAuthorizationEpochByScope.get(scopeKey) ?? 0
  const advanceAppCatalogAuthorizationEpoch = (scopeKey: string) => {
    appCatalogAuthorizationEpochByScope.set(
      scopeKey,
      currentAppCatalogAuthorizationEpoch(scopeKey) + 1,
    )
  }
  const closeCatalogAuthorizationForAccount = (accountId: string) => {
    const scopePrefix = `${accountId}\0`
    for (const scopeKey of appCatalogAuthorizationEpochByScope.keys()) {
      if (scopeKey.startsWith(scopePrefix)) {
        advanceAppCatalogAuthorizationEpoch(scopeKey)
      }
    }
    denyAppCatalogAccessForAccount(accountId)
    try {
      denyCachedAppCatalogAuthorizationForAccount(accountId)
    } catch (error) {
      log?.warn(
        '[Admin] failed to persist denied Catalog cache while ending the session:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  const catalogOrganizationIdsForAccount = (accountId: string) => {
    const organizationIds = new Set(
      listCachedAppCatalogs(accountId).map(cached => cached.organizationId),
    )
    const scopePrefix = `${accountId}\0`
    for (const scopeKey of appCatalogAuthorizationEpochByScope.keys()) {
      if (scopeKey.startsWith(scopePrefix)) {
        organizationIds.add(scopeKey.slice(scopePrefix.length))
      }
    }
    return organizationIds
  }
  const markCatalogAccessOfflineForAccount = (accountId: string) => {
    for (const organizationId of catalogOrganizationIdsForAccount(accountId)) {
      if (getAppCatalogAccessMode(accountId, organizationId) === 'online') {
        setAppCatalogAccessMode(accountId, organizationId, 'offline')
      }
    }
  }
  const denyCatalogScope = (
    accountId: string,
    organizationId: string,
  ) => {
    const scopeKey = appCatalogScopeKey(accountId, organizationId)
    // The in-memory epoch and gate are the security boundary. Persistence is
    // recovery metadata and must never keep a previously-online process open
    // when a denied-cache write fails.
    advanceAppCatalogAuthorizationEpoch(scopeKey)
    setAppCatalogAccessMode(accountId, organizationId, 'denied')
    try {
      denyCachedAppCatalogAuthorization(accountId, organizationId)
    } catch (error) {
      log?.warn(
        '[Admin] failed to persist denied Catalog cache:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  const sessions = new AdminSessionCoordinator(
    closeCatalogAuthorizationForAccount,
  )
  const callOrganization = async <T extends object>(
    operation: string,
    callback: (client: AdminClient, accessToken: string) => Promise<T>,
    onCurrentSuccess?: (
      result: T,
      session: AdminSessionSnapshot,
    ) => void | Promise<void>,
  ) => {
    let requestContext: AdminRequestContext | null = null
    let manager: CredentialManager | null = null
    try {
      const adminUrl = requireAdminUrl()
      manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(
        adminUrl,
        manager,
        sessions,
        deps,
      )
      if (!tokenResult.tokens) {
        if (tokenResult.stale) return staleAdminSessionResult()
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
      requestContext = { session: tokenResult.session }
      const result = await callback(
        createAuthenticatedAdminClient(
          adminUrl,
          manager,
          sessions,
          requestContext,
        ),
        tokenResult.tokens.accessToken,
      )
      const current = onCurrentSuccess
        ? await sessions.mutateIfCurrent(
            manager,
            requestContext.session,
            async () => onCurrentSuccess!(result, requestContext!.session),
          ).then(applied => applied.applied)
        : await sessions.isCurrent(manager, requestContext.session)
      if (!current) return staleAdminSessionResult()
      return { success: true as const, ...result }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminSessionResult()
      }
      if (isSessionEndingAuthFailure(error)) {
        if (!manager || !requestContext) return staleAdminSessionResult()
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminSessionResult()
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

    const loginAttempt = await sessions.beginLoginAttempt()
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const client = createPublicAdminClient(adminUrl)
      const login = await client.login(input.data.identifier, input.data.password)
      const session = await completeAdminLogin({
        adminUrl,
        manager,
        login,
        loginAttempt,
        sessions,
        deps,
        onSyncFailure: error => logPostLoginSyncFailure(log, error),
      })
      if (!session || !await sessions.isCurrent(manager, session)) {
        return staleAdminSessionResult()
      }

      return { success: true, user: login.user }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] login failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.GET_AUTH_CONFIG, async () => {
    try {
      return await createPublicAdminClient(requireAdminUrl()).getAuthConfig()
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] getAuthConfig failed:', adminError.message)
      return { phoneAuthEnabled: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG, async () => {
    try {
      const result = await createPublicAdminClient(
        requireAdminUrl(),
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
        const result = await createPublicAdminClient(requireAdminUrl())
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

      const loginAttempt = await sessions.beginLoginAttempt()
      try {
        const adminUrl = requireAdminUrl()
        const manager = getCredentialManager()
        const login = await createPublicAdminClient(adminUrl)
          .verifyPhoneAuthCode(input.data)
        const session = await completeAdminLogin({
          adminUrl,
          manager,
          login,
          loginAttempt,
          sessions,
          deps,
          onSyncFailure: error => logPostLoginSyncFailure(log, error),
        })
        if (!session || !await sessions.isCurrent(manager, session)) {
          return staleAdminSessionResult()
        }
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

    let requestContext: AdminRequestContext | null = null
    let manager: CredentialManager | null = null
    try {
      const adminUrl = requireAdminUrl()
      manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(
        adminUrl,
        manager,
        sessions,
        deps,
      )
      if (!tokenResult.tokens) {
        if (tokenResult.stale) return staleAdminSessionResult()
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

      requestContext = { session: tokenResult.session }
      const result = await createAuthenticatedAdminClient(
        adminUrl,
        manager,
        sessions,
        requestContext,
      )
        .setPassword(tokenResult.tokens.accessToken, input.data)
      if (!await sessions.isCurrent(manager, requestContext.session)) {
        return staleAdminSessionResult()
      }
      return { success: result.success }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminSessionResult()
      }
      if (isSessionEndingAuthFailure(error)) {
        if (!manager || !requestContext) return staleAdminSessionResult()
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminSessionResult()
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
    const tokenResult = await ensureValidTokens(
      adminUrl,
      manager,
      sessions,
      deps,
    )
    if (!tokenResult.tokens) {
      if (tokenResult.stale) {
        return staleAdminValidationResult()
      }
      if (tokenResult.authError) {
        return { loggedIn: false, ...tokenResult.authError }
      }
      return { loggedIn: false }
    }
    if (tokenResult.accessMode === 'offline') {
      const committed = await sessions.mutateIfCurrent(
        manager,
        tokenResult.session,
        async () => {
          markCatalogAccessOfflineForAccount(tokenResult.tokens.userId)
          return {
            loggedIn: true as const,
            user: adminUserFromStoredTokens(tokenResult.tokens),
            configVersion: getAdminConfigVersion() ?? 'offline',
            offline: true as const,
          }
        },
      )
      return committed.applied
        ? committed.value!
        : staleAdminValidationResult()
    }

    const requestContext: AdminRequestContext = {
      session: tokenResult.session,
    }
    try {
      const client = createAuthenticatedAdminClient(
        adminUrl,
        manager,
        sessions,
        requestContext,
      )
      const validation = await client.validate(tokenResult.tokens.accessToken)
      if (!validation.valid) {
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminValidationResult()
        return { loggedIn: false }
      }
      const verifiedSession = await persistVerifiedAdminUser(
        manager,
        sessions,
        requestContext.session,
        validation.user,
      )
      if (!verifiedSession) {
        return staleAdminValidationResult()
      }
      requestContext.session = verifiedSession

      if (getAdminConfigVersion() !== validation.configVersion) {
        const synced = await syncAdminConnections({
          adminUrl,
          manager,
          sessions,
          session: requestContext.session,
        })
        requestContext.session = synced.session
      }
      if (!await sessions.isCurrent(manager, requestContext.session)) {
        return staleAdminValidationResult()
      }

      return {
        loggedIn: true,
        user: validation.user,
        configVersion: validation.configVersion,
      }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminValidationResult()
      }
      if (isSessionEndingAuthFailure(error)) {
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminValidationResult()
        return { loggedIn: false, ...toAdminRpcError(error) }
      }
      if (isTemporaryAdminFailure(error)) {
        const committed = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async () => {
            markCatalogAccessOfflineForAccount(
              requestContext.session.tokens.userId,
            )
            return {
              loggedIn: true as const,
              user: adminUserFromStoredTokens(requestContext.session.tokens),
              configVersion: getAdminConfigVersion() ?? 'offline',
              offline: true as const,
            }
          },
        )
        return committed.applied
          ? committed.value!
          : staleAdminValidationResult()
      }
      throw error
    }
  })

  server.handle(RPC_CHANNELS.admin.LOGOUT, async () => {
    const adminUrl = getAdminUrl()
    const manager = getCredentialManager()
    const session = await sessions.capture(manager)
    if (!session) return { success: true }

    const ended = await endAdminSession(
      manager,
      deps,
      sessions,
      session,
      async () => {
        await deleteAdminManagedConnections(manager)
        setAdminConfigVersion(undefined)
      },
      async () => {
        if (!adminUrl) return
        try {
          await createPublicAdminClient(adminUrl)
            .logout(session.tokens.accessToken)
        } catch (error) {
          log?.warn(
            '[Admin] remote logout failed; clearing local state:',
            error instanceof Error ? error.message : String(error),
          )
        }
      },
    )
    if (!ended) return staleAdminSessionResult()

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
      const { session: _session, ...result } = await syncAdminConnections({
        adminUrl,
        manager,
        sessions,
        deps,
      })
      return { success: true, ...result }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminSessionResult()
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
      const syncInvocation = ++appCatalogSyncInvocation

      const adminUrl = getAdminUrl()
      if (!adminUrl) {
        return {
          success: false,
          errorCode: 'VALIDATION_ERROR',
          message: 'Admin URL is not configured',
        }
      }
      const manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(
        adminUrl,
        manager,
        sessions,
        deps,
      )
      if (!tokenResult.tokens) {
        if (tokenResult.stale) return staleAdminSessionResult()
        return {
          success: false,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }

      const accountId = tokenResult.tokens.userId
      const requestContext: AdminRequestContext = {
        session: tokenResult.session,
      }
      const catalogSyncKey = appCatalogScopeKey(accountId, organizationId.data)
      const registeredRequest = await sessions.mutateIfCurrent(
        manager,
        requestContext.session,
        async () => {
          if (!appCatalogAuthorizationEpochByScope.has(catalogSyncKey)) {
            appCatalogAuthorizationEpochByScope.set(catalogSyncKey, 0)
          }
          latestAppCatalogSyncByScope.set(
            catalogSyncKey,
            Math.max(
              latestAppCatalogSyncByScope.get(catalogSyncKey) ?? 0,
              syncInvocation,
            ),
          )
          return currentAppCatalogAuthorizationEpoch(catalogSyncKey)
        },
      )
      if (!registeredRequest.applied) return staleAdminSessionResult()
      const registeredAuthorizationEpoch = registeredRequest.value!
      const isCurrentCatalogSync = () => (
        latestAppCatalogSyncByScope.get(catalogSyncKey) === syncInvocation
        && currentAppCatalogAuthorizationEpoch(catalogSyncKey)
          === registeredAuthorizationEpoch
      )
      const supersededCatalogResult = (): AppCatalogSyncResult => ({
        success: false,
        errorCode: 'REQUEST_SUPERSEDED',
        message: 'A newer app catalog sync replaced this request',
      })
      const cached = getCachedAppCatalog(accountId, organizationId.data)
      if (tokenResult.accessMode === 'offline') {
        const committed = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async (): Promise<AppCatalogSyncResult> => {
            if (!isCurrentCatalogSync()) return supersededCatalogResult()
            setAppCatalogAccessMode(accountId, organizationId.data, 'offline')
            const current = getCachedAppCatalog(accountId, organizationId.data)
            if (current?.authorizationStatus === 'authorized') {
              return {
                success: true,
                catalog: current,
                source: 'cache',
                refreshed: false,
                accessMode: 'offline',
                warningCode: 'NETWORK_ERROR',
                warning: tokenResult.warning ?? 'Failed to reach admin server',
              }
            }
            return {
              success: false,
              errorCode: 'NETWORK_ERROR',
              message: tokenResult.warning ?? 'Failed to reach admin server',
            }
          }
        )
        return committed.applied
          ? committed.value!
          : staleAdminSessionResult()
      }
      try {
        const client = createAuthenticatedAdminClient(
          adminUrl,
          manager,
          sessions,
          requestContext,
        )
        let result = await client.getAppCatalog(
          tokenResult.tokens.accessToken,
          organizationId.data,
          force || cached?.authorizationStatus === 'denied'
            ? undefined
            : cached?.appConfigVersion,
        )
        if (result.notModified && !cached) {
          result = await client.getAppCatalog(
            requestContext.session.tokens.accessToken,
            organizationId.data,
          )
        }
        if (
          !result.notModified
          && result.apps.some(app => app.organizationId !== organizationId.data)
        ) {
          throw new AdminError(
            'Admin app catalog contains an app from another organization',
            'SERVER_ERROR',
          )
        }
        const retainedWithdrawnAppIds = result.notModified
          ? new Set<string>()
          : await deps.getRetainedCatalogAppIds?.(
              accountId,
              organizationId.data,
            ) ?? new Set<string>()
        const committed = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async (): Promise<AppCatalogSyncResult> => {
            if (!isCurrentCatalogSync()) return supersededCatalogResult()
            if (result.notModified) {
              if (!cached) {
                throw new AdminError(
                  'Admin returned not modified without a local app catalog',
                  'SERVER_ERROR',
                )
              }
              setAppCatalogAccessMode(accountId, organizationId.data, 'online')
              return {
                success: true as const,
                catalog: cached,
                source: 'cache' as const,
                refreshed: false,
                accessMode: 'online' as const,
                ...(cached.warnings?.length
                  ? { warningCode: 'INVALID_SEMVER' }
                  : {}),
              }
            }
            const savedCatalog = saveAppCatalog(
              accountId,
              organizationId.data,
              result,
              Date.now(),
              retainedWithdrawnAppIds,
            )
            setAppCatalogAccessMode(accountId, organizationId.data, 'online')
            return {
              success: true as const,
              catalog: savedCatalog,
              source: 'network' as const,
              refreshed: true,
              accessMode: 'online' as const,
              ...(savedCatalog.warnings?.length
                ? { warningCode: 'INVALID_SEMVER' }
                : {}),
            }
          },
        )
        return committed.applied ? committed.value! : staleAdminSessionResult()
      } catch (error) {
        if (error instanceof AdminSessionChangedError) {
          return staleAdminSessionResult()
        }
        const adminError = toAdminRpcError(error)
        if (isSessionEndingAuthFailure(error)) {
          const ended = await endAdminSession(
            manager,
            deps,
            sessions,
            requestContext.session,
          )
          if (!ended) {
            // Catalog request ordering is not an authentication truth source.
            // Only a real session generation/account change may suppress an
            // explicit session-ending failure from an older request.
            return staleAdminSessionResult()
          }
          log?.warn('[Admin] app catalog authorization denied:', adminError.message)
          return { success: false, ...adminError }
        } else if (cached && isCatalogAuthorizationFailure(error)) {
          const denied = await sessions.mutateIfCurrent(
            manager,
            requestContext.session,
            async (): Promise<AppCatalogSyncResult> => {
              if (!isCurrentCatalogSync()) return supersededCatalogResult()
              denyCatalogScope(accountId, organizationId.data)
              return { success: false, ...adminError }
            },
          )
          if (!denied.applied) return staleAdminSessionResult()
          log?.warn('[Admin] app catalog authorization denied:', adminError.message)
          return denied.value!
        } else if (cached && isTemporaryAdminFailure(error)) {
          const markedOffline = await sessions.mutateIfCurrent(
            manager,
            requestContext.session,
            async (): Promise<AppCatalogSyncResult> => {
              if (!isCurrentCatalogSync()) return supersededCatalogResult()
              setAppCatalogAccessMode(
                accountId,
                organizationId.data,
                'offline',
              )
              const current = getCachedAppCatalog(accountId, organizationId.data)
              if (!current || current.authorizationStatus !== 'authorized') {
                return { success: false, ...adminError }
              }
              return {
                success: true,
                catalog: current,
                source: 'cache',
                refreshed: false,
                accessMode: 'offline',
                warningCode: adminError.errorCode,
                warning: adminError.message,
              }
            },
          )
          if (!markedOffline.applied) return staleAdminSessionResult()
          log?.warn('[Admin] app catalog refresh failed; using cache:', adminError.message)
          return markedOffline.value!
        }
        const current = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async (): Promise<AppCatalogSyncResult> => (
            isCurrentCatalogSync()
              ? { success: false, ...adminError }
              : supersededCatalogResult()
          ),
        )
        if (!current.applied) return staleAdminSessionResult()
        log?.warn('[Admin] app catalog sync failed:', adminError.message)
        return current.value!
      }
    },
  )

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATIONS, async () => {
    return callOrganization(
      'listOrganizations',
      (client, accessToken) => client.listOrganizations(accessToken),
      async (result, session) => {
        const activeOrganizationIds = new Set(result.organizations
          .filter(organization => (
            organization.status !== 'suspended'
            && organization.membership.status === 'active'
          ))
          .map(organization => organization.id))
        const accountId = session.tokens.userId
        const scopedOrganizationIds = catalogOrganizationIdsForAccount(accountId)
        for (const organizationId of scopedOrganizationIds) {
          if (activeOrganizationIds.has(organizationId)) continue
          denyCatalogScope(accountId, organizationId)
        }
      },
    )
  })

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
      const result = await createPublicAdminClient(requireAdminUrl())
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

  return {
    async endCurrentSession(beforeDelete): Promise<AdminSessionEndResult> {
      const manager = getCredentialManager()
      const session = await sessions.capture(manager)
      if (session) {
        return await endAdminSession(
          manager,
          deps,
          sessions,
          session,
          () => beforeDelete?.(manager),
        )
          ? 'ended'
          : 'session_changed'
      }

      const cleared = await sessions.runExclusive(async () => {
        if (await manager.getAdminTokens()) return false
        await beforeDelete?.(manager)
        return true
      })
      return cleared ? 'no_session' : 'session_changed'
    },
  }
}

function requireAdminUrl(): string {
  const adminUrl = getAdminUrl()
  if (!adminUrl) {
    throw new AdminError('Admin URL is not configured', 'VALIDATION_ERROR')
  }
  return adminUrl
}

function createPublicAdminClient(adminUrl: string): AdminClient {
  return new AdminClient(adminUrl)
}

function createAuthenticatedAdminClient(
  adminUrl: string,
  manager: CredentialManager,
  sessions: AdminSessionCoordinator,
  requestContext: AdminRequestContext,
): AdminClient {
  return new AdminClient(adminUrl, {
    tokenStore: {
      async getRefreshToken() {
        return await sessions.isCurrent(manager, requestContext.session)
          ? requestContext.session.tokens.refreshToken
          : null
      },
      async onTokensRefreshed(tokens) {
        const refreshedSession = await persistRefreshedTokens(
          manager,
          sessions,
          requestContext.session,
          tokens,
        )
        if (!refreshedSession) throw new AdminSessionChangedError()
        requestContext.session = refreshedSession
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
  sessions: AdminSessionCoordinator,
  expected: AdminSessionSnapshot,
  user: AdminUser,
): Promise<AdminSessionSnapshot | null> {
  if (user.id !== expected.tokens.userId) {
    throw new AdminError(
      'Admin validation identity does not match the current session',
      'INVALID_TOKEN',
    )
  }
  const persisted = await sessions.mutateIfCurrent(
    manager,
    expected,
    async current => {
      const updated: StoredAdminTokens = {
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        expiresAt: current.expiresAt,
        userId: user.id,
        username: user.username,
        displayName: user.displayName ?? undefined,
        role: user.role,
        groupIds: user.groupIds,
      }
      sessions.advanceGeneration()
      await manager.setAdminTokens(updated)
      return sessions.createSnapshot(updated)
    },
  )
  return persisted.applied ? persisted.value! : null
}

async function endAdminSession(
  manager: CredentialManager,
  deps: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'> | undefined,
  sessions: AdminSessionCoordinator,
  expected: AdminSessionSnapshot,
  beforeDelete?: () => void | Promise<void>,
  whileEnding?: () => void | Promise<void>,
): Promise<boolean> {
  const transition = await sessions.beginEnding(
    manager,
    expected,
    accountId => deps?.onAdminSessionEnding?.(accountId),
  )
  if (!transition) return false
  const { session: ending, cleanup } = transition

  // Catalog authorization and the host lifecycle fence are already active.
  // Slow remote/process cleanup stays outside the lock so a replacement login
  // can proceed; final token deletion is guarded by the ending snapshot CAS.
  try {
    await whileEnding?.()
  } catch (error) {
    deps?.platform.logger.warn(
      '[Admin] session-ending side effect failed; continuing fail-closed cleanup:',
      error instanceof Error ? error.message : String(error),
    )
  }
  try {
    await cleanup
  } catch (error) {
    deps?.platform.logger.warn(
      '[Admin] local app cleanup failed while ending the session; continuing fail-closed cleanup:',
      error instanceof Error ? error.message : String(error),
    )
  }

  const ended = await sessions.finishEndingIfCurrent(
    manager,
    ending,
    async () => {
      try {
        await beforeDelete?.()
      } catch (error) {
        deps?.platform.logger.warn(
          '[Admin] secondary session cleanup failed; deleting Admin credentials:',
          error instanceof Error ? error.message : String(error),
        )
      }
      await manager.deleteAdminTokens()
      return true
    },
  )
  return ended.applied && ended.value === true
}

async function completeAdminLogin(args: {
  adminUrl: string
  manager: CredentialManager
  login: AdminLoginResponse
  loginAttempt: number
  sessions: AdminSessionCoordinator
  deps: Pick<
    HandlerDeps,
    'onAdminSessionEnding' | 'onAdminSessionStarted' | 'platform'
  >
  onSyncFailure: (error: unknown) => void
}): Promise<AdminSessionSnapshot | null> {
  const replacement = await args.sessions.runExclusive(async () => {
    if (!args.sessions.isLatestLoginAttempt(args.loginAttempt)) return null

    const previousTokens = await args.manager.getAdminTokens()
    const previousAdminConnectionSlugs = getAdminManagedConnectionSlugs()
    const switchingAccounts = Boolean(
      previousTokens && previousTokens.userId !== args.login.user.id,
    )

    // Advancing before the first cleanup await makes every older request
    // stale for the full account-transition window.
    const transitionGeneration = args.sessions.advanceGeneration()
    if (previousTokens && switchingAccounts) {
      args.sessions.closeAuthorizationForEnding(previousTokens.userId)
      // The coordinator deduplicates this against an already-running logout
      // cleanup. Starting it under the transition lock gates account A
      // immediately, but deliberately not awaiting it lets account B commit.
      void args.sessions.getOrStartAccountCleanup(
        previousTokens.userId,
        transitionGeneration,
        () => args.deps.onAdminSessionEnding?.(previousTokens.userId),
      ).catch(error => {
        args.deps.platform.logger.warn(
          '[Admin] previous account cleanup failed during login replacement:',
          error instanceof Error ? error.message : String(error),
        )
      })
      await deleteAdminManagedConnections(
        args.manager,
        previousAdminConnectionSlugs,
      )
      setAdminConfigVersion(undefined)
    }

    const nextTokens: StoredAdminTokens = {
      accessToken: args.login.accessToken,
      refreshToken: args.login.refreshToken,
      expiresAt: expiresAtFromNow(args.login.expiresIn),
      userId: args.login.user.id,
      username: args.login.user.username,
      displayName: args.login.user.displayName ?? undefined,
      role: args.login.user.role,
      groupIds: args.login.user.groupIds,
    }
    await args.deps.onAdminSessionStarted?.(args.login.user.id)
    await args.manager.setAdminTokens(nextTokens)
    // Only a newly authenticated session may reopen the account-level Catalog
    // gate. Individual organizations remain offline until their own sync.
    resumeAppCatalogAccessForAccount(args.login.user.id)
    setAdminConfigVersion(undefined)

    if (!switchingAccounts) {
      await deleteAdminManagedConnections(
        args.manager,
        previousAdminConnectionSlugs,
      )
    }
    return args.sessions.createSnapshot(nextTokens)
  })
  if (!replacement) return null

  try {
    const synced = await syncAdminConnections({
      adminUrl: args.adminUrl,
      manager: args.manager,
      sessions: args.sessions,
      session: replacement,
    })
    return synced.session
  } catch (error) {
    if (error instanceof AdminSessionChangedError) return null
    // Authentication has already succeeded and the one-time code may already
    // be consumed. Keep the persisted session, but fail closed for model
    // authorization so a previous account's managed connections cannot be used.
    args.onSyncFailure(error)
    return await args.sessions.isCurrent(args.manager, replacement)
      ? replacement
      : null
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
  sessions: AdminSessionCoordinator,
  deps?: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'>,
): Promise<TokenValidationResult> {
  const initialSession = await sessions.capture(manager)
  if (!initialSession) return { tokens: null }
  const { tokens } = initialSession

  if (!manager.isExpired({
    value: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  })) {
    return {
      tokens,
      session: initialSession,
      accessMode: 'online',
    }
  }

  try {
    const refreshed = await createPublicAdminClient(adminUrl)
      .refresh(tokens.refreshToken)
    const refreshedSession = await persistRefreshedTokens(
      manager,
      sessions,
      initialSession,
      refreshed,
    )
    if (!refreshedSession) return { tokens: null, stale: true }
    return {
      tokens: refreshedSession.tokens,
      session: refreshedSession,
      accessMode: 'online',
    }
  } catch (error) {
    if (error instanceof AdminSessionChangedError) {
      return { tokens: null, stale: true }
    }
    if (isSessionEndingAuthFailure(error)) {
      const ended = await endAdminSession(
        manager,
        deps,
        sessions,
        initialSession,
      )
      if (!ended) return { tokens: null, stale: true }
      return {
        tokens: null,
        authError: toAdminRpcError(error),
      }
    }
    if (isTemporaryAdminFailure(error)) {
      if (!await sessions.isCurrent(manager, initialSession)) {
        return { tokens: null, stale: true }
      }
      return {
        tokens,
        session: initialSession,
        accessMode: 'offline',
        warning: toAdminRpcError(error).message,
      }
    }
    if (!await sessions.isCurrent(manager, initialSession)) {
      return { tokens: null, stale: true }
    }
    const ended = await endAdminSession(
      manager,
      deps,
      sessions,
      initialSession,
    )
    if (!ended) return { tokens: null, stale: true }
    return {
      tokens: null,
      authError: toAdminRpcError(error),
    }
  }
}

async function persistRefreshedTokens(
  manager: CredentialManager,
  sessions: AdminSessionCoordinator,
  expected: AdminSessionSnapshot,
  refreshed: AdminRefreshResponse,
): Promise<AdminSessionSnapshot | null> {
  const persisted = await sessions.mutateIfCurrent(
    manager,
    expected,
    async existing => {
      const updated: StoredAdminTokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: expiresAtFromNow(refreshed.expiresIn),
        userId: existing.userId,
        username: existing.username,
        displayName: existing.displayName,
        role: existing.role,
        groupIds: existing.groupIds,
      }
      sessions.advanceGeneration()
      await manager.setAdminTokens(updated)
      return sessions.createSnapshot(updated)
    },
  )
  return persisted.applied ? persisted.value! : null
}

async function syncAdminConnections(args: {
  adminUrl: string
  manager: CredentialManager
  sessions: AdminSessionCoordinator
  session?: AdminSessionSnapshot
  deps?: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'>
}): Promise<{
  configVersion: string
  connectionCount: number
  defaultConnection: string | null
  session: AdminSessionSnapshot
}> {
  let session = args.session
  if (!session) {
    const tokens = await ensureValidTokens(
      args.adminUrl,
      args.manager,
      args.sessions,
      args.deps,
    )
    if (!tokens.tokens) {
      if (tokens.stale) throw new AdminSessionChangedError()
      throw new AdminError('Admin session is not logged in', 'UNAUTHORIZED')
    }
    if (tokens.accessMode === 'offline') {
      throw new AdminError('Failed to reach admin server', 'NETWORK_ERROR')
    }
    session = tokens.session
  }
  const requestContext: AdminRequestContext = { session }
  try {
    const client = createAuthenticatedAdminClient(
      args.adminUrl,
      args.manager,
      args.sessions,
      requestContext,
    )
    const response = await client.getLlmConnections(
      requestContext.session.tokens.accessToken,
    )
    const applied = await args.sessions.mutateIfCurrent(
      args.manager,
      requestContext.session,
      async () => {
        const incomingSlugs = new Set(
          response.connections.map(connection => connection.slug),
        )
        for (const existing of getLlmConnections()) {
          if (
            existing.managedBy === 'admin'
            && !incomingSlugs.has(existing.slug)
          ) {
            await deleteConnectionAndCredentials(args.manager, existing.slug)
          }
        }

        for (const connection of response.connections) {
          await upsertAdminConnection(
            args.manager,
            connection,
            response.configVersion,
            requestContext.session.tokens.accessToken,
          )
        }

        if (
          response.defaultConnection
          && getLlmConnections().some(
            connection => connection.slug === response.defaultConnection,
          )
        ) {
          setDefaultLlmConnection(response.defaultConnection)
        }
        setAdminConfigVersion(response.configVersion)
      },
    )
    if (!applied.applied) throw new AdminSessionChangedError()
    return {
      configVersion: response.configVersion,
      connectionCount: response.connections.length,
      defaultConnection: response.defaultConnection,
      session: requestContext.session,
    }
  } catch (error) {
    if (error instanceof AdminSessionChangedError) throw error
    if (isSessionEndingAuthFailure(error)) {
      const ended = await endAdminSession(
        args.manager,
        args.deps,
        args.sessions,
        requestContext.session,
      )
      if (!ended) throw new AdminSessionChangedError()
      throw error
    }
    const cleaned = await args.sessions.mutateIfCurrent(
      args.manager,
      requestContext.session,
      async () => {
        setAdminConfigVersion(undefined)
        await deleteAdminManagedConnections(args.manager)
      },
    )
    if (!cleaned.applied) throw new AdminSessionChangedError()
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
    error.errorCode === 'MEMBERSHIP_REMOVED' ||
    error.errorCode === 'MEMBERSHIP_SUSPENDED' ||
    error.errorCode === 'ORGANIZATION_UNAVAILABLE' ||
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
    || error.errorCode === 'MEMBERSHIP_REMOVED'
    || error.errorCode === 'MEMBERSHIP_SUSPENDED'
    || error.errorCode === 'ORGANIZATION_UNAVAILABLE'
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
