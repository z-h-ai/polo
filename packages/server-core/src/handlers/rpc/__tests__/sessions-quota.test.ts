/**
 * sessions-quota.test.ts
 *
 * TDD tests for the quota check + ownership validation added to sendMessage.
 *
 * AC1: Ownership validation
 * AC2: Quota check (admin API allowed/denied)
 * AC3: Effective remaining calculation (admin.remaining - pending tokens)
 * AC4: RequestId propagation + quota context object
 * AC5: Non-platform mode bypass
 * AC6: Admin API unavailable → ServiceUnavailableError
 * AC7: Platform mode with null JWT → skip quota check
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import type { HandlerDeps } from '../../handler-deps'
import { registerSessionsHandlers } from '../sessions'
import { ForbiddenError } from '../../../workspace-access'
import type { AdminApiClient } from '@polo-ai/shared/admin-api'
import type { PendingUsageStore } from '@polo-ai/shared/admin-api'
import type { QuotaCheckResult } from '@polo-ai/shared/admin-api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-quota-test'
const OWNER_USER_ID = 'user-quota-owner'
const OTHER_USER_ID = 'user-quota-other'
const SESSION_ID = 'session-quota-test'
const USER_JWT = 'eyJhbGciOiJIUzI1NiJ9.test.jwt'

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    clientId: 'c-quota',
    workspaceId: WORKSPACE_ID,
    webContentsId: null,
    userId: OWNER_USER_ID,
    username: OWNER_USER_ID,
    userRole: 'user',
    userJwt: USER_JWT,
    ...overrides,
  }
}

// A minimal mock for AdminApiClient
function makeAdminApiClient(checkQuotaResult: QuotaCheckResult | Error): Partial<AdminApiClient> {
  return {
    checkQuota: async (_jwt: string) => {
      if (checkQuotaResult instanceof Error) throw checkQuotaResult
      return checkQuotaResult
    },
  }
}

// A minimal mock for PendingUsageStore
function makePendingUsageStore(pendingTokens = 0): Partial<PendingUsageStore> {
  return {
    getPendingTokens: (_userId: string) => pendingTokens,
  }
}

type TestHarness = {
  handlers: Map<string, HandlerFn>
  server: RpcServer
  deps: HandlerDeps
  sendMessage: HandlerFn
  mockAdminApi: Partial<AdminApiClient>
  mockPendingUsage: Partial<PendingUsageStore>
  sessionManagerCalls: Array<{ sessionId: string; message: string }>
}

function createHarness(options: {
  adminApi?: Partial<AdminApiClient> | null
  pendingUsage?: Partial<PendingUsageStore> | null
  /** The ownerUserId for the test workspace. Defaults to OWNER_USER_ID. Pass null for "no owner" (legacy). */
  ownerUserId?: string | null
  sendMessageImpl?: (...args: any[]) => Promise<void>
} = {}): TestHarness {
  const handlers = new Map<string, HandlerFn>()
  const sessionManagerCalls: Array<{ sessionId: string; message: string }> = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const mockAdminApi = options.adminApi ?? makeAdminApiClient({
    allowed: true,
    remaining: 1_000_000,
    limit: 1_000_000,
    used: 0,
    period: '2026-06',
  })

  const mockPendingUsage = options.pendingUsage ?? makePendingUsageStore(0)

  // Fake workspace config with ownerUserId
  const ownerUserId = options.ownerUserId !== undefined ? options.ownerUserId : OWNER_USER_ID

  // Default sendMessage: acks and resolves
  const defaultSendMessage = async (
    _sessionId: string,
    _message: string,
    _attachments?: any,
    _storedAttachments?: any,
    _options?: any,
    _arg6?: any,
    _arg7?: any,
    onAck?: (messageId: string) => void,
    _extra?: any,
  ) => {
    sessionManagerCalls.push({ sessionId: _sessionId, message: _message })
    if (onAck) onAck('msg-' + Date.now())
  }

  const deps: HandlerDeps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [],
      getSession: async () => null,
      getUnreadSummary: () => ({}),
      markAllSessionsRead: async () => {},
      createSession: async () => ({ id: SESSION_ID }),
      deleteSession: async () => {},
      sendMessage: options.sendMessageImpl ?? defaultSendMessage,
      cancelProcessing: async () => {},
      killShell: async () => {},
      getTaskOutput: async () => '',
      respondToPermission: async () => true,
      respondToCredential: async () => true,
      flagSession: async () => {},
      unflagSession: async () => {},
      archiveSession: async () => {},
      unarchiveSession: async () => {},
      renameSession: async () => {},
      setSessionStatus: async () => {},
      markSessionRead: async () => {},
      markSessionUnread: async () => {},
      setActiveViewingSession: async () => {},
      setSessionPermissionMode: async () => {},
      setSessionThinkingLevel: async () => {},
      updateWorkingDirectory: async () => {},
      setSessionSources: async () => {},
      setSessionLabels: async () => {},
      showItemInFolder: async () => {},
      getSessionPath: () => null,
      shareToViewer: async () => {},
      updateShare: async () => {},
      revokeShare: async () => {},
      refreshTitle: async () => {},
      setSessionConnection: async () => {},
      setPendingPlanExecution: async () => {},
      markCompactionComplete: async () => {},
      markPendingPlanExecutionDispatched: async () => {},
      clearPendingPlanExecution: async () => {},
      addMessageAnnotation: async () => {},
      removeMessageAnnotation: async () => {},
      updateMessageAnnotation: async () => {},
      getPendingPlanExecution: async () => null,
      getSessionPermissionModeState: async () => ({}),
      searchSessions: async () => [],
      exportSession: async () => null,
      importSession: async () => null,
      exportRemoteSessionTransfer: async () => null,
      importRemoteSessionTransfer: async () => null,
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      appVersion: '0.0.0-test',
    } as unknown as HandlerDeps['platform'],
    adminApiClient: mockAdminApi as AdminApiClient,
    pendingUsageStore: mockPendingUsage as PendingUsageStore,
    // Injectable workspace ownership resolver for tests (avoids filesystem config lookup)
    resolveWorkspaceOwner: (workspaceId: string) => {
      if (workspaceId === WORKSPACE_ID) return ownerUserId
      return null
    },
  } as unknown as HandlerDeps

  registerSessionsHandlers(server, deps)

  const sendMessage = handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)
  if (!sendMessage) {
    throw new Error('SEND_MESSAGE handler not registered')
  }

  return { handlers, server, deps, sendMessage, mockAdminApi, mockPendingUsage, sessionManagerCalls }
}

// ---------------------------------------------------------------------------
// AC5: Non-platform mode bypass (this is tested first per TDD principles)
// ---------------------------------------------------------------------------

describe('AC5: Non-platform mode bypass', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    delete process.env.PLATFORM_ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (savedPlatformKey !== undefined) {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    } else {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    }
  })

  it('AC5: ownership check skipped without PLATFORM_ANTHROPIC_API_KEY', async () => {
    const { sendMessage, sessionManagerCalls } = createHarness()
    // Non-owner user should NOT get forbidden in non-platform mode
    const ctx = makeCtx({ userId: OTHER_USER_ID, workspaceId: WORKSPACE_ID })
    // Use a new harness where sendMessage acks right away — ownership check is skipped
    let threw = false
    try {
      await sendMessage(ctx, SESSION_ID, 'hello')
    } catch (err: any) {
      if (err?.code === 'FORBIDDEN') threw = true
      // Other errors (no workspace, etc.) are acceptable
    }
    // Should not throw ForbiddenError in non-platform mode
    expect(threw).toBe(false)
  })

  it('AC5: quota check skipped without PLATFORM_ANTHROPIC_API_KEY', async () => {
    let adminCalled = false
    const adminApi = {
      checkQuota: async () => {
        adminCalled = true
        return { allowed: false, remaining: 0, limit: 1000, used: 1000, period: '2026-06' } as QuotaCheckResult
      },
    }
    const { sendMessage } = createHarness({ adminApi })
    const ctx = makeCtx()
    // Even though admin API would deny, it shouldn't be called
    await sendMessage(ctx, SESSION_ID, 'hello')
    expect(adminCalled).toBe(false)
  })

  it('AC5: existing non-platform sendMessage behavior unchanged', async () => {
    const { sendMessage, sessionManagerCalls } = createHarness()
    const ctx = makeCtx({ userId: OWNER_USER_ID, userJwt: USER_JWT })
    const result = await sendMessage(ctx, SESSION_ID, 'hello world')
    // Should resolve with accepted: true
    expect((result as any).accepted).toBe(true)
    expect(sessionManagerCalls.length).toBe(1)
    expect(sessionManagerCalls[0].message).toBe('hello world')
  })
})

// ---------------------------------------------------------------------------
// Platform mode tests
// ---------------------------------------------------------------------------

describe('Platform mode quota tests', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-test-key'
    process.env.ADMIN_API_URL = 'https://admin.test.example.com'
  })

  afterEach(() => {
    if (savedPlatformKey !== undefined) {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    } else {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    }
    delete process.env.ADMIN_API_URL
  })

  // ─── AC1: Ownership validation ──────────────────────────────────────────────

  describe('AC1: Ownership validation', () => {
    it('AC1: owner proceeds to quota check (no ForbiddenError)', async () => {
      const { sendMessage } = createHarness()
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      const result = await sendMessage(ctx, SESSION_ID, 'hello')
      expect((result as any).accepted).toBe(true)
    })

    it('AC1: non-owner throws ForbiddenError, no LLM call', async () => {
      const { sendMessage, sessionManagerCalls } = createHarness()
      const ctx = makeCtx({ userId: OTHER_USER_ID })
      await expect(sendMessage(ctx, SESSION_ID, 'hello')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(sessionManagerCalls.length).toBe(0)
    })

    it('AC1: server-token (userId=null) skips ownership check', async () => {
      const { sendMessage } = createHarness()
      const ctx = makeCtx({ userId: null, userJwt: null })
      const result = await sendMessage(ctx, SESSION_ID, 'hello')
      expect((result as any).accepted).toBe(true)
    })
  })

  // ─── AC2: Quota check ───────────────────────────────────────────────────────

  describe('AC2: Quota check', () => {
    it('AC2: calls adminApiClient.checkQuota(ctx.userJwt) before LLM call', async () => {
      let capturedJwt: string | undefined
      const adminApi = {
        checkQuota: async (jwt: string) => {
          capturedJwt = jwt
          return { allowed: true, remaining: 500_000, limit: 1_000_000, used: 500_000, period: '2026-06' } as QuotaCheckResult
        },
      }
      const { sendMessage, sessionManagerCalls } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID, userJwt: USER_JWT })
      await sendMessage(ctx, SESSION_ID, 'hello')
      expect(capturedJwt).toBe(USER_JWT)
      expect(sessionManagerCalls.length).toBe(1)
    })

    it('AC2: admin returns allowed=false → throws QuotaExceededError', async () => {
      const adminApi = makeAdminApiClient({
        allowed: false,
        remaining: 0,
        limit: 1_000_000,
        used: 1_000_000,
        period: '2026-06',
      })
      const { sendMessage } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      await expect(sendMessage(ctx, SESSION_ID, 'hello')).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
    })

    it('AC2: QuotaExceededError carries remaining, limit, used, period', async () => {
      const adminApi = makeAdminApiClient({
        allowed: false,
        remaining: 0,
        limit: 1_000_000,
        used: 1_000_000,
        period: '2026-06',
      })
      const { sendMessage } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      let err: any
      try {
        await sendMessage(ctx, SESSION_ID, 'hello')
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(err.code).toBe('QUOTA_EXCEEDED')
      expect(err.remaining).toBeDefined()
      expect(err.limit).toBeDefined()
      expect(err.used).toBeDefined()
      expect(err.period).toBeDefined()
    })

    it('AC2: QuotaExceededError has user-friendly message about monthly reset', async () => {
      const adminApi = makeAdminApiClient({
        allowed: false,
        remaining: 0,
        limit: 1_000_000,
        used: 1_000_000,
        period: '2026-06',
      })
      const { sendMessage } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      let err: any
      try {
        await sendMessage(ctx, SESSION_ID, 'hello')
      } catch (e) {
        err = e
      }
      expect(err.message.toLowerCase()).toMatch(/quota|limit|monthly|reset/)
    })
  })

  // ─── AC3: Effective remaining calculation ───────────────────────────────────

  describe('AC3: Effective remaining calculation', () => {
    it('AC3: effectiveRemaining = admin.remaining - pendingTokens', async () => {
      // Admin says 850000 remaining, pending = 100000
      // effectiveRemaining = 750000 → allowed
      const adminApi = makeAdminApiClient({
        allowed: true,
        remaining: 850_000,
        limit: 1_000_000,
        used: 150_000,
        period: '2026-06',
      })
      const pendingUsage = makePendingUsageStore(100_000)
      const { sendMessage, sessionManagerCalls } = createHarness({ adminApi, pendingUsage })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      await sendMessage(ctx, SESSION_ID, 'hello')
      expect(sessionManagerCalls.length).toBe(1)
    })

    it('AC3: effectiveRemaining <= 0 → QuotaExceededError even if Admin said allowed=true', async () => {
      // Admin says allowed=true with 850000 remaining, but pending = 900000
      // effectiveRemaining = -50000 → QUOTA_EXCEEDED
      const adminApi = makeAdminApiClient({
        allowed: true,
        remaining: 850_000,
        limit: 1_000_000,
        used: 150_000,
        period: '2026-06',
      })
      const pendingUsage = makePendingUsageStore(900_000)
      const { sendMessage } = createHarness({ adminApi, pendingUsage })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      await expect(sendMessage(ctx, SESSION_ID, 'hello')).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
    })

    it('AC3: no pending entries → effectiveRemaining equals admin.remaining', async () => {
      let capturedEffectiveRemaining: number | undefined
      const adminApi = makeAdminApiClient({
        allowed: true,
        remaining: 750_000,
        limit: 1_000_000,
        used: 250_000,
        period: '2026-06',
      })
      const pendingUsage = makePendingUsageStore(0)
      const { sendMessage, sessionManagerCalls } = createHarness({ adminApi, pendingUsage })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      await sendMessage(ctx, SESSION_ID, 'hello')
      // Should proceed (750000 - 0 = 750000 > 0)
      expect(sessionManagerCalls.length).toBe(1)
    })
  })

  // ─── AC4: RequestId propagation ─────────────────────────────────────────────

  describe('AC4: RequestId propagation', () => {
    it('AC4: each sendMessage generates a unique requestId (crypto.randomUUID format)', async () => {
      const capturedQuotaContexts: any[] = []

      // We'll check the requestId passed into the underlying sendMessage (7th arg = quotaContext)
      const sendMessageImpl = async (
        _sessionId: string,
        _message: string,
        _att?: any,
        _stored?: any,
        _opts?: any,
        _arg6?: any,
        quotaContext?: any,
        onAck?: (messageId: string) => void,
        _extra?: any,
      ) => {
        capturedQuotaContexts.push(quotaContext)
        if (onAck) onAck('msg-' + Date.now())
      }

      const { sendMessage } = createHarness({ sendMessageImpl })

      const ctx1 = makeCtx()
      const ctx2 = makeCtx()
      await sendMessage(ctx1, SESSION_ID, 'hello 1')
      await sendMessage(ctx2, SESSION_ID, 'hello 2')

      // Both calls should have a quotaContext with a requestId
      expect(capturedQuotaContexts.length).toBe(2)
      const id1 = capturedQuotaContexts[0]?.requestId
      const id2 = capturedQuotaContexts[1]?.requestId
      expect(id1).toBeDefined()
      expect(id2).toBeDefined()
      // UUIDs should be unique across calls
      expect(id1).not.toBe(id2)
      // Should look like a UUID (8-4-4-4-12)
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('AC4: quota context includes requestId, userId, userJwt, sessionId', async () => {
      let capturedContext: any

      const sendMessageImpl = async (
        _sessionId: string,
        _message: string,
        _att?: any,
        _stored?: any,
        _opts?: any,
        _arg6?: any,
        quotaContext?: any,
        onAck?: (messageId: string) => void,
        _extra?: any,
      ) => {
        capturedContext = quotaContext
        if (onAck) onAck('msg-1')
      }

      const { sendMessage } = createHarness({ sendMessageImpl })
      const ctx = makeCtx({ userId: OWNER_USER_ID, userJwt: USER_JWT })
      await sendMessage(ctx, SESSION_ID, 'hello')

      expect(capturedContext).toBeDefined()
      expect(capturedContext.requestId).toBeDefined()
      expect(capturedContext.userId).toBe(OWNER_USER_ID)
      expect(capturedContext.userJwt).toBe(USER_JWT)
      expect(capturedContext.sessionId).toBe(SESSION_ID)
    })
  })

  // ─── AC6: Admin API unavailable ─────────────────────────────────────────────

  describe('AC6: Admin API unavailable', () => {
    it('AC6: Admin unreachable → ServiceUnavailableError (fail-closed)', async () => {
      const { AdminApiUnavailableError } = await import('@polo-ai/shared/admin-api')
      const adminApi = makeAdminApiClient(new AdminApiUnavailableError('Network error'))
      const { sendMessage } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      await expect(sendMessage(ctx, SESSION_ID, 'hello')).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      })
    })

    it('AC6: Admin timeout → ServiceUnavailableError', async () => {
      const { AdminApiTimeoutError } = await import('@polo-ai/shared/admin-api')
      const adminApi = makeAdminApiClient(new AdminApiTimeoutError('Timeout'))
      const { sendMessage } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      await expect(sendMessage(ctx, SESSION_ID, 'hello')).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      })
    })

    it('AC6: Admin unreachable → no LLM call (fail-closed)', async () => {
      const { AdminApiUnavailableError } = await import('@polo-ai/shared/admin-api')
      const adminApi = makeAdminApiClient(new AdminApiUnavailableError())
      const { sendMessage, sessionManagerCalls } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID })
      try {
        await sendMessage(ctx, SESSION_ID, 'hello')
      } catch { /* expected */ }
      expect(sessionManagerCalls.length).toBe(0)
    })
  })

  // ─── AC7: Platform mode with null JWT ───────────────────────────────────────

  describe('AC7: Platform mode with null JWT', () => {
    it('AC7: in platform mode, ctx.userJwt=null (server-token) → skip quota check', async () => {
      let adminCalled = false
      const adminApi = {
        checkQuota: async () => {
          adminCalled = true
          return { allowed: true, remaining: 1_000_000, limit: 1_000_000, used: 0, period: '2026-06' } as QuotaCheckResult
        },
      }
      const { sendMessage } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: null, userJwt: null })
      await sendMessage(ctx, SESSION_ID, 'hello')
      expect(adminCalled).toBe(false)
    })

    it('AC7: in platform mode, ctx.userJwt present → proceed with quota check', async () => {
      let adminCalled = false
      const adminApi = {
        checkQuota: async () => {
          adminCalled = true
          return { allowed: true, remaining: 1_000_000, limit: 1_000_000, used: 0, period: '2026-06' } as QuotaCheckResult
        },
      }
      const { sendMessage } = createHarness({ adminApi })
      const ctx = makeCtx({ userId: OWNER_USER_ID, userJwt: USER_JWT })
      await sendMessage(ctx, SESSION_ID, 'hello')
      expect(adminCalled).toBe(true)
    })
  })
})
