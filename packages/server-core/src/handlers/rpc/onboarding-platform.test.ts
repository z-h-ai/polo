/**
 * Tests for onboarding RPC handler in platform mode
 *
 * AC4: Onboarding handler in platform mode returns early with "configured" status
 * AC4: No error when querying onboarding state in platform mode
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import { registerOnboardingHandlers } from './onboarding'
import type { HandlerDeps } from '../handler-deps'

// ============================================
// Test harness
// ============================================

function createHarness() {
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

  const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }

  const deps = {
    platform: {
      logger: noopLogger,
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      imageProcessor: {
        getMetadata: async () => null,
        process: async (input: Buffer | string) => Buffer.from(''),
      },
      isDebugMode: false,
    },
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {
      getState: () => null,
      setState: () => {},
      clearState: () => {},
    } as HandlerDeps['oauthFlowStore'],
  } as unknown as HandlerDeps

  registerOnboardingHandlers(server, deps)

  const getAuthStateHandler = handlers.get(RPC_CHANNELS.onboarding.GET_AUTH_STATE)
  if (!getAuthStateHandler) {
    throw new Error('GET_AUTH_STATE handler not registered')
  }

  return { getAuthStateHandler }
}

function ctx(): RequestContext {
  return {
    clientId: 'test-client',
    workspaceId: 'ws-test',
    webContentsId: 1,
    userId: null,
    username: null,
    userRole: null,
    userJwt: null,
  }
}

// ============================================
// AC4: Onboarding handler in platform mode
// ============================================

describe('onboarding GET_AUTH_STATE handler - platform mode', () => {
  let originalPlatformKey: string | undefined

  beforeEach(() => {
    originalPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (originalPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = originalPlatformKey
    }
  })

  it('AC4: returns setupNeeds.isFullyConfigured=true in platform mode', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-key'

    const { getAuthStateHandler } = createHarness()
    const result = await getAuthStateHandler(ctx()) as { authState: unknown; setupNeeds: { isFullyConfigured: boolean; needsBillingConfig: boolean; needsCredentials: boolean } }

    expect(result.setupNeeds.isFullyConfigured).toBe(true)
    expect(result.setupNeeds.needsBillingConfig).toBe(false)
    expect(result.setupNeeds.needsCredentials).toBe(false)
  })

  it('AC4: does not throw when querying onboarding state in platform mode', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-key'

    const { getAuthStateHandler } = createHarness()

    // Must not throw
    let result: unknown
    let threw = false
    try {
      result = await getAuthStateHandler(ctx())
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(result).toBeDefined()
  })

  it('AC4: authState.billing.hasCredentials=true in platform mode', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-key'

    const { getAuthStateHandler } = createHarness()
    const result = await getAuthStateHandler(ctx()) as { authState: { billing: { type: string; hasCredentials: boolean } }; setupNeeds: unknown }

    expect(result.authState.billing.hasCredentials).toBe(true)
    expect(result.authState.billing.type).toBe('api_key')
  })
})
