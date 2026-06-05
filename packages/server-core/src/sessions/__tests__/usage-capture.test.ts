/**
 * Usage capture tests — polo-quota.usage-capture
 *
 * Tests the usage capture logic triggered by `event.type === 'complete'` in the
 * SessionManager event iteration loop. The logic is extracted into
 * `captureAndReportUsage` (exported from SessionManager.ts) for testability.
 *
 * Spec: spec-polo-ai.md §5.2 (Usage 捕获)
 * Acceptance criteria: AC1–AC6
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { captureAndReportUsage, type UsageCaptureDeps } from '../SessionManager.ts'
import type { AgentEventUsage } from '@polo-ai/core/types'
import type { QuotaContext } from '../../handlers/quota-errors.ts'
import type { PendingUsageEntry } from '@polo-ai/shared/admin-api'

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeUsage(
  inputTokens = 100,
  outputTokens = 200,
): AgentEventUsage {
  return { inputTokens, outputTokens }
}

function makeQuotaContext(overrides?: Partial<QuotaContext>): QuotaContext {
  return {
    requestId: 'req-test-001',
    userId: 'user-42',
    userJwt: 'jwt-token-abc',
    sessionId: 'session-001',
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<UsageCaptureDeps>): UsageCaptureDeps & {
  addedEntries: PendingUsageEntry[]
  removedIds: string[]
  retriedIds: string[]
  reportedCalls: Array<{ jwt: string; usage: { requestId: string; model: string } }>
} {
  const addedEntries: PendingUsageEntry[] = []
  const removedIds: string[] = []
  const retriedIds: string[] = []
  const reportedCalls: Array<{ jwt: string; usage: { requestId: string; model: string } }> = []

  return {
    addedEntries,
    removedIds,
    retriedIds,
    reportedCalls,
    pendingStore: {
      add: mock((entry: PendingUsageEntry) => { addedEntries.push(entry) }),
      remove: mock((id: string) => { removedIds.push(id) }),
      markRetry: mock((id: string) => { retriedIds.push(id) }),
    },
    adminApi: {
      reportUsage: mock(async (jwt: string, usage: { requestId: string; model: string }) => {
        reportedCalls.push({ jwt, usage })
        return { recorded: true, totalUsed: 100, remaining: 900 }
      }),
    },
    getModel: mock(() => 'claude-opus-4-5'),
    logWarning: mock((_msg: string) => {}),
    logError: mock((_msg: string, _err?: unknown) => {}),
    ...overrides,
  }
}

// ─── AC1: Usage extraction from complete event ────────────────────────────────

describe('AC1: Usage extraction from complete event', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'plat-key-test'
  })

  afterEach(() => {
    if (savedPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    }
  })

  it('AC1: captures inputTokens and outputTokens from event.usage', async () => {
    const deps = makeDeps()
    const usage = makeUsage(100, 200)
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    expect(deps.addedEntries.length).toBe(1)
    expect(deps.addedEntries[0].inputTokens).toBe(100)
    expect(deps.addedEntries[0].outputTokens).toBe(200)
  })

  it('AC1: extracts model name from getModel()', async () => {
    const deps = makeDeps()
    const usage = makeUsage()
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    expect(deps.addedEntries[0].model).toBe('claude-opus-4-5')
  })

  it('AC1: if event.usage is undefined → skip capture (no-op, log warning)', async () => {
    const deps = makeDeps()
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({
      event: { type: 'complete', usage: undefined },
      quotaContext: qCtx,
      deps,
    })

    expect(deps.addedEntries.length).toBe(0)
    expect((deps.logWarning as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0)
  })

  it('AC1: if event.usage is null → skip capture (no-op, log warning)', async () => {
    const deps = makeDeps()
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({
      event: { type: 'complete', usage: null as unknown as AgentEventUsage },
      quotaContext: qCtx,
      deps,
    })

    expect(deps.addedEntries.length).toBe(0)
    expect((deps.logWarning as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0)
  })
})

// ─── AC2: Quota context retrieval ────────────────────────────────────────────

describe('AC2: Quota context retrieval', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'plat-key-test'
  })

  afterEach(() => {
    if (savedPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    }
  })

  it('AC2: if no quota context → skip capture (non-platform or system call)', async () => {
    const deps = makeDeps()
    const usage = makeUsage()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: undefined, deps })

    expect(deps.addedEntries.length).toBe(0)
  })

  it('AC2: retrieves requestId, userId, userJwt, sessionId from quota context', async () => {
    const deps = makeDeps()
    const usage = makeUsage()
    const qCtx = makeQuotaContext({
      requestId: 'req-unique-99',
      userId: 'user-77',
      userJwt: 'jwt-xyz',
      sessionId: 'sess-abc',
    })

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    const entry = deps.addedEntries[0]
    expect(entry.requestId).toBe('req-unique-99')
    expect(entry.userId).toBe('user-77')
    expect(entry.userJwt).toBe('jwt-xyz')
    expect(entry.sessionId).toBe('sess-abc')
  })
})

// ─── AC3: Pending store write ─────────────────────────────────────────────────

describe('AC3: Pending store write', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'plat-key-test'
  })

  afterEach(() => {
    if (savedPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    }
  })

  it('AC3: pendingStore.add() is called with all required fields', async () => {
    const deps = makeDeps()
    const usage = makeUsage(150, 300)
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    expect(deps.addedEntries.length).toBe(1)
    const entry = deps.addedEntries[0]
    expect(entry.requestId).toBe('req-test-001')
    expect(entry.userId).toBe('user-42')
    expect(entry.userJwt).toBe('jwt-token-abc')
    expect(entry.sessionId).toBe('session-001')
    expect(entry.model).toBe('claude-opus-4-5')
    expect(entry.inputTokens).toBe(150)
    expect(entry.outputTokens).toBe(300)
  })

  it('AC3: userJwt comes from quota context (not elsewhere)', async () => {
    const deps = makeDeps()
    const usage = makeUsage()
    const qCtx = makeQuotaContext({ userJwt: 'user-specific-jwt' })

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    expect(deps.addedEntries[0].userJwt).toBe('user-specific-jwt')
  })

  it('AC3: all fields populated — no missing required fields', async () => {
    const deps = makeDeps()
    const usage = makeUsage(10, 20)
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    const entry = deps.addedEntries[0]
    // All required fields present and non-empty
    expect(entry.requestId).toBeTruthy()
    expect(entry.userId).toBeTruthy()
    expect(entry.userJwt).toBeTruthy()
    expect(entry.sessionId).toBeTruthy()
    expect(entry.model).toBeTruthy()
    expect(typeof entry.inputTokens).toBe('number')
    expect(typeof entry.outputTokens).toBe('number')
  })
})

// ─── AC4: Triggers async reporting ────────────────────────────────────────────

describe('AC4: Async reporting', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'plat-key-test'
  })

  afterEach(() => {
    if (savedPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    }
  })

  it('AC4: adminApi.reportUsage() is called (fire-and-forget)', async () => {
    const deps = makeDeps()
    const usage = makeUsage()
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    // Wait for the fire-and-forget promise to settle
    await new Promise(r => setTimeout(r, 10))

    expect((deps.adminApi.reportUsage as ReturnType<typeof mock>).mock.calls.length).toBe(1)
  })

  it('AC4: on success → pendingStore.remove(requestId) is called', async () => {
    const deps = makeDeps()
    const usage = makeUsage()
    const qCtx = makeQuotaContext({ requestId: 'req-success' })

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })
    await new Promise(r => setTimeout(r, 10))

    expect(deps.removedIds).toContain('req-success')
  })

  it('AC4: on failure → pendingStore.markRetry(requestId) is called (entry persists)', async () => {
    const deps = makeDeps({
      adminApi: {
        reportUsage: mock(async () => { throw new Error('network error') }),
      },
    })
    const usage = makeUsage()
    const qCtx = makeQuotaContext({ requestId: 'req-fail' })

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })
    await new Promise(r => setTimeout(r, 10))

    expect(deps.retriedIds).toContain('req-fail')
    // remove should NOT have been called on failure
    expect(deps.removedIds).not.toContain('req-fail')
  })

  it('AC4: on 409 DuplicateRequestError → pendingStore.remove(requestId) (treat as success)', async () => {
    const { DuplicateRequestError } = await import('@polo-ai/shared/admin-api')
    const deps = makeDeps({
      adminApi: {
        reportUsage: mock(async () => { throw new DuplicateRequestError() }),
      },
    })
    const usage = makeUsage()
    const qCtx = makeQuotaContext({ requestId: 'req-dup' })

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })
    await new Promise(r => setTimeout(r, 10))

    // 409 means already recorded — safe to remove
    expect(deps.removedIds).toContain('req-dup')
    expect(deps.retriedIds).not.toContain('req-dup')
  })
})

// ─── AC5: Error resilience ────────────────────────────────────────────────────

describe('AC5: Error resilience', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'plat-key-test'
  })

  afterEach(() => {
    if (savedPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    }
  })

  it('AC5: if usage capture throws → captureAndReportUsage does NOT throw (returns void)', async () => {
    const deps = makeDeps({
      pendingStore: {
        add: mock(() => { throw new Error('disk full') }),
        remove: mock(() => {}),
        markRetry: mock(() => {}),
      },
    })
    const usage = makeUsage()
    const qCtx = makeQuotaContext()

    // Should not throw
    await expect(
      captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })
    ).resolves.toBeUndefined()
  })

  it('AC5: error is logged for debugging when capture throws', async () => {
    const deps = makeDeps({
      pendingStore: {
        add: mock(() => { throw new Error('disk full') }),
        remove: mock(() => {}),
        markRetry: mock(() => {}),
      },
    })
    const usage = makeUsage()
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    expect((deps.logError as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0)
  })
})

// ─── AC6: Non-platform mode ────────────────────────────────────────────────────

describe('AC6: Non-platform mode', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    delete process.env.PLATFORM_ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (savedPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    }
  })

  it('AC6: without PLATFORM_ANTHROPIC_API_KEY, usage capture is NOT triggered', async () => {
    const deps = makeDeps()
    const usage = makeUsage()
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    expect(deps.addedEntries.length).toBe(0)
  })

  it('AC6: no pending store writes in non-platform mode', async () => {
    const deps = makeDeps()
    const usage = makeUsage()
    const qCtx = makeQuotaContext()

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })

    expect((deps.pendingStore.add as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })
})

// ─── Boundary matrix ─────────────────────────────────────────────────────────

describe('Boundary matrix', () => {
  let savedPlatformKey: string | undefined

  beforeEach(() => {
    savedPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (savedPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = savedPlatformKey
    }
  })

  it('no platform mode, any event → no capture', async () => {
    delete process.env.PLATFORM_ANTHROPIC_API_KEY
    const deps = makeDeps()
    const usage = makeUsage(100, 200)

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: makeQuotaContext(), deps })
    await new Promise(r => setTimeout(r, 10))

    expect(deps.addedEntries.length).toBe(0)
    expect((deps.pendingStore.remove as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })

  it('platform mode, complete with usage, report 200 OK → add then remove from pending', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'key'
    const deps = makeDeps()
    const usage = makeUsage(100, 200)
    const qCtx = makeQuotaContext({ requestId: 'req-ok' })

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })
    await new Promise(r => setTimeout(r, 10))

    expect(deps.addedEntries.length).toBe(1)
    expect(deps.removedIds).toContain('req-ok')
  })

  it('platform mode, complete with usage, report network error → add then markRetry', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'key'
    const deps = makeDeps({
      adminApi: {
        reportUsage: mock(async () => { throw new Error('network error') }),
      },
    })
    const usage = makeUsage(100, 200)
    const qCtx = makeQuotaContext({ requestId: 'req-net-err' })

    await captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })
    await new Promise(r => setTimeout(r, 10))

    expect(deps.addedEntries.length).toBe(1)
    expect(deps.retriedIds).toContain('req-net-err')
    expect(deps.removedIds).not.toContain('req-net-err')
  })

  it('platform mode, capture throws → error logged, user unaffected (no exception propagation)', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'key'
    const deps = makeDeps({
      getModel: mock(() => { throw new Error('model unavailable') }),
    })
    const usage = makeUsage(100, 200)
    const qCtx = makeQuotaContext()

    await expect(
      captureAndReportUsage({ event: { type: 'complete', usage }, quotaContext: qCtx, deps })
    ).resolves.toBeUndefined()

    expect((deps.logError as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0)
  })
})
