import {
  AdminClient,
  AdminError,
  type AdminLlmConnection,
  type AdminLoginResponse,
  type AdminRefreshResponse,
} from '@polo-ai/shared/admin'
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
] as const

type StoredAdminTokens = NonNullable<Awaited<ReturnType<CredentialManager['getAdminTokens']>>>
type TokenValidationResult =
  | { tokens: StoredAdminTokens }
  | { tokens: null; authError?: { errorCode: string; message: string; status?: number } }

export function registerAdminHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  server.handle(RPC_CHANNELS.admin.LOGIN, async (_ctx, identifier: string, password: string) => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const client = createAdminClient(adminUrl, manager)
      const login = await client.login(identifier, password)
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
    async (_ctx, phone: string, challengeToken: string) => {
      try {
        const result = await createAdminClient(requireAdminUrl(), getCredentialManager())
          .sendPhoneAuthCode({ phone, challengeToken })
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
    async (_ctx, phone: string, code: string) => {
      try {
        const adminUrl = requireAdminUrl()
        const manager = getCredentialManager()
        const login = await createAdminClient(adminUrl, manager)
          .verifyPhoneAuthCode({ phone, code })
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

  server.handle(RPC_CHANNELS.admin.SET_PASSWORD, async (_ctx, password: string) => {
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
        .setPassword(tokenResult.tokens.accessToken, { password })
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
      return { loggedIn: false }
    }

    const manager = getCredentialManager()
    const tokenResult = await ensureValidTokens(adminUrl, manager)
    if (!tokenResult.tokens) {
      if (tokenResult.authError) {
        return { loggedIn: false, ...tokenResult.authError }
      }
      return { loggedIn: false }
    }

    try {
      const client = createAdminClient(adminUrl, manager)
      const validation = await client.validate(tokenResult.tokens.accessToken)
      if (!validation.valid) {
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
        await manager.deleteAdminTokens()
        return { loggedIn: false, ...toAdminRpcError(error) }
      }
      throw error
    }
  })

  server.handle(RPC_CHANNELS.admin.LOGOUT, async () => {
    const adminUrl = getAdminUrl()
    const manager = getCredentialManager()
    const tokens = await manager.getAdminTokens()

    if (adminUrl && tokens?.refreshToken) {
      try {
        await createAdminClient(adminUrl, manager).logout(tokens.refreshToken)
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

  try {
    await syncAdminConnections({
      adminUrl: args.adminUrl,
      manager: args.manager,
      accessToken: args.login.accessToken,
    })
  } catch (error) {
    // Authentication has already succeeded and the one-time code may already
    // be consumed. Keep the persisted session and let the dedicated
    // admin:syncConnections path retry this post-login operation.
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

  const client = createAdminClient(args.adminUrl, args.manager)
  const response = await client.getLlmConnections(accessToken)
  const incomingSlugs = new Set(response.connections.map(connection => connection.slug))

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

async function deleteAdminManagedConnections(manager: CredentialManager): Promise<void> {
  for (const connection of getLlmConnections()) {
    if (connection.managedBy === 'admin') {
      await deleteConnectionAndCredentials(manager, connection.slug)
    }
  }
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
} {
  if (error instanceof AdminError) {
    return {
      errorCode: error.errorCode,
      message: error.message,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(typeof error.details?.retryAfter === 'number'
        ? { retryAfter: error.details.retryAfter }
        : {}),
    }
  }
  if (error instanceof Error) {
    return { errorCode: 'UNKNOWN_ERROR', message: error.message }
  }
  return { errorCode: 'UNKNOWN_ERROR', message: String(error) }
}
