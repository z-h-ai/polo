import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import {
  AdminApiTimeoutError,
  AdminApiUnavailableError,
  AuthenticationError,
  type QuotaStatus,
} from '@polo-ai/shared/admin-api'
import type { HandlerFn, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerQuotaHandlers, HANDLED_CHANNELS } from './quota'

function createDeps(getQuotaStatus: NonNullable<HandlerDeps['adminApiClient']>['getQuotaStatus']): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    adminApiClient: { getQuotaStatus } as HandlerDeps['adminApiClient'],
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
  }
}

function createHarness(deps: HandlerDeps) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }

  registerQuotaHandlers(server, deps)

  return { handlers }
}

const ctx = {
  clientId: 'client-1',
  workspaceId: 'ws-1',
  webContentsId: 1,
  userId: 'user-1',
  username: 'admin',
  userRole: 'admin' as const,
  userJwt: 'jwt-token',
}

describe('registerQuotaHandlers', () => {
  const originalPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY

  beforeEach(() => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-test-key'
  })

  afterEach(() => {
    if (originalPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = originalPlatformKey
    }
  })

  it('registers quota GET_STATUS', () => {
    const { handlers } = createHarness(createDeps(async () => {
      throw new Error('not called')
    }))

    expect(HANDLED_CHANNELS).toEqual([RPC_CHANNELS.quota.GET_STATUS])
    expect([...handlers.keys()]).toEqual([RPC_CHANNELS.quota.GET_STATUS])
  })

  it('returns null outside platform mode', async () => {
    delete process.env.PLATFORM_ANTHROPIC_API_KEY
    const { handlers } = createHarness(createDeps(async () => {
      throw new Error('not called')
    }))

    const result = await handlers.get(RPC_CHANNELS.quota.GET_STATUS)!(ctx)

    expect(result).toBeNull()
  })

  it('returns quota status from Admin API', async () => {
    const status: QuotaStatus = {
      userId: 'user-1',
      period: 'monthly',
      limit: 1_000_000,
      used: 125_000,
      remaining: 875_000,
      usageBreakdown: [],
    }
    const { handlers } = createHarness(createDeps(async (jwt) => {
      expect(jwt).toBe('jwt-token')
      return status
    }))

    const result = await handlers.get(RPC_CHANNELS.quota.GET_STATUS)!(ctx)

    expect(result).toEqual({ ok: true, status })
  })

  it('maps missing JWT and auth failures to session_expired', async () => {
    const { handlers } = createHarness(createDeps(async () => {
      throw new AuthenticationError()
    }))

    await expect(handlers.get(RPC_CHANNELS.quota.GET_STATUS)!({ ...ctx, userJwt: null })).resolves.toEqual({
      ok: false,
      error: 'session_expired',
    })
    await expect(handlers.get(RPC_CHANNELS.quota.GET_STATUS)!(ctx)).resolves.toEqual({
      ok: false,
      error: 'session_expired',
    })
  })

  it('maps timeout and network failures to unavailable', async () => {
    for (const error of [new AdminApiTimeoutError(), new AdminApiUnavailableError()]) {
      const { handlers } = createHarness(createDeps(async () => {
        throw error
      }))

      await expect(handlers.get(RPC_CHANNELS.quota.GET_STATUS)!(ctx)).resolves.toEqual({
        ok: false,
        error: 'unavailable',
      })
    }
  })
})
