import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { NetworkError, TokenRevokedError } from '@polo-ai/shared/auth'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import type { HandlerDeps } from '../../handler-deps'
import { registerAuthHandlers } from '../auth'

function createHarness(overrides: Partial<HandlerDeps> = {}) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    ...overrides,
  }

  registerAuthHandlers(server, deps)

  const logout = handlers.get(RPC_CHANNELS.auth.LOGOUT)
  if (!logout) {
    throw new Error('LOGOUT handler not registered')
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'ws-1',
    webContentsId: 101,
    userId: 'user-1',
    username: 'zhangsan',
    userRole: 'admin',
    userJwt: 'jwt.cached',
  }

  return { logout, ctx }
}

describe('registerAuthHandlers LOGOUT', () => {
  it('calls Admin logout with the cached JWT, clears session cache, and deletes LLM API key credentials', async () => {
    const adminLogout = mock(async () => {})
    const clearCachedAuthData = mock(async () => {})
    const list = mock(async () => [
      { type: 'llm_api_key' as const, connectionSlug: 'anthropic-prod' },
      { type: 'llm_api_key' as const, connectionSlug: 'openai-prod' },
    ])
    const deleteCredential = mock(async () => true)
    const { logout, ctx } = createHarness({
      authLogout: { logout: adminLogout },
      clearCachedAuthData,
      credentialManager: { list, delete: deleteCredential },
    })

    await logout(ctx)

    expect(adminLogout).toHaveBeenCalledTimes(1)
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith({ type: 'llm_api_key' })
    expect(deleteCredential).toHaveBeenCalledTimes(2)
  })

  it('still clears local auth cache and credentials when Admin logout has a network error', async () => {
    const clearCachedAuthData = mock(async () => {})
    const deleteCredential = mock(async () => true)
    const { logout, ctx } = createHarness({
      authLogout: {
        logout: mock(async () => {
          throw new NetworkError('offline')
        }),
      },
      clearCachedAuthData,
      credentialManager: {
        list: mock(async () => [{ type: 'llm_api_key' as const, connectionSlug: 'partial' }]),
        delete: deleteCredential,
      },
    })

    await logout(ctx)

    expect(clearCachedAuthData).toHaveBeenCalledTimes(1)
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'partial' })
  })

  it('still clears local auth cache and credentials when Admin logout returns 401', async () => {
    const clearCachedAuthData = mock(async () => {})
    const { logout, ctx } = createHarness({
      authLogout: {
        logout: mock(async () => {
          throw new TokenRevokedError(401, { error: 'token_revoked' })
        }),
      },
      clearCachedAuthData,
      credentialManager: {
        list: mock(async () => []),
        delete: mock(async () => false),
      },
    })

    await logout(ctx)

    expect(clearCachedAuthData).toHaveBeenCalledTimes(1)
  })
})
