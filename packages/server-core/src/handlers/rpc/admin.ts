import { AdminClient, AdminError, type AdminRefreshResponse } from '@polo-ai/shared/admin'
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

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.admin.LOGIN,
  RPC_CHANNELS.admin.VALIDATE,
  RPC_CHANNELS.admin.LOGOUT,
  RPC_CHANNELS.admin.GET_STATUS,
  RPC_CHANNELS.admin.SYNC_CONNECTIONS,
] as const

type AdminManagedConnection = LlmConnection & {
  apiKey?: string
  key?: string
  credentials?: {
    apiKey?: string
    key?: string
  }
}

type StoredAdminTokens = NonNullable<Awaited<ReturnType<CredentialManager['getAdminTokens']>>>

export function registerAdminHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  server.handle(RPC_CHANNELS.admin.LOGIN, async (_ctx, username: string, password: string) => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const client = createAdminClient(adminUrl, manager)
      const login = await client.login(username, password)

      await manager.setAdminTokens({
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        expiresAt: expiresAtFromNow(login.expiresIn),
        userId: login.user.id,
        username: login.user.username,
        displayName: login.user.displayName,
      })

      await syncAdminConnections({
        adminUrl,
        manager,
        accessToken: login.accessToken,
      })

      return { success: true, user: login.user }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] login failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.VALIDATE, async () => {
    const adminUrl = getAdminUrl()
    if (!adminUrl) {
      return { loggedIn: false }
    }

    const manager = getCredentialManager()
    const tokens = await ensureValidTokens(adminUrl, manager)
    if (!tokens) {
      return { loggedIn: false }
    }

    try {
      const client = createAdminClient(adminUrl, manager)
      const validation = await client.validate(tokens.accessToken)
      if (!validation.valid) {
        await manager.deleteAdminTokens()
        return { loggedIn: false }
      }

      if (getAdminConfigVersion() !== validation.configVersion) {
        await syncAdminConnections({
          adminUrl,
          manager,
          accessToken: tokens.accessToken,
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
        return { loggedIn: false }
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

async function ensureValidTokens(adminUrl: string, manager: CredentialManager): Promise<StoredAdminTokens | null> {
  const tokens = await manager.getAdminTokens()
  if (!tokens) return null

  if (!manager.isExpired({
    value: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  })) {
    return tokens
  }

  try {
    const refreshed = await createAdminClient(adminUrl, manager).refresh(tokens.refreshToken)
    await persistRefreshedTokens(manager, refreshed)
    return {
      ...tokens,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: expiresAtFromNow(refreshed.expiresIn),
    }
  } catch {
    await manager.deleteAdminTokens()
    return null
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
  const accessToken = args.accessToken ?? tokens?.accessToken
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

  for (const connection of response.connections as AdminManagedConnection[]) {
    await upsertAdminConnection(args.manager, connection, response.configVersion)
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
  connection: AdminManagedConnection,
  configVersion: string,
): Promise<void> {
  const apiKey = readApiKey(connection)
  const { apiKey: _apiKey, key: _key, credentials: _credentials, ...configConnection } = connection
  const adminConnection: LlmConnection = {
    ...configConnection,
    createdAt: configConnection.createdAt ?? Date.now(),
    managedBy: 'admin',
    adminConfigVersion: configVersion,
  }

  const existing = getLlmConnections().find(item => item.slug === adminConnection.slug)
  if (existing) {
    const { slug: _slug, ...updates } = adminConnection
    updateLlmConnection(adminConnection.slug, updates)
  } else {
    addLlmConnection(adminConnection)
  }

  if (apiKey) {
    await manager.setLlmApiKey(adminConnection.slug, apiKey)
  }
}

function readApiKey(connection: AdminManagedConnection): string | null {
  const value =
    connection.apiKey ??
    connection.key ??
    connection.credentials?.apiKey ??
    connection.credentials?.key
  return typeof value === 'string' && value.length > 0 ? value : null
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
    error.errorCode === 'INVALID_TOKEN' ||
    error.errorCode === 'TOKEN_EXPIRED'
  )
}

function toAdminRpcError(error: unknown): { errorCode: string; message: string } {
  if (error instanceof AdminError) {
    return { errorCode: error.errorCode, message: error.message }
  }
  if (error instanceof Error) {
    return { errorCode: 'UNKNOWN_ERROR', message: error.message }
  }
  return { errorCode: 'UNKNOWN_ERROR', message: String(error) }
}
