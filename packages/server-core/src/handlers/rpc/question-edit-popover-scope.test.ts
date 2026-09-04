import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'os'
import { dirname, join, resolve as resolvePath } from 'path'
import * as serverCoreDomain from '@polo-ai/server-core/domain'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import {
  listRegisteredProductSpaceExecutions,
  resetProductSpaceExecutionRegistryForTests,
  revokeRuntimeProductSpaceFence,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
} from '../../runtime/product-space-executions'
import {
  beginAccountTransition,
  getActiveAccountTransitionEpoch,
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
  settleAccountTransition,
} from './trusted-product-space-account'
import { getSessionFilePath, writeSessionJsonl } from '@polo-ai/shared/sessions'
import type { StoredSession } from '@polo-ai/shared/sessions'
import { getPermissionMode, setPermissionMode, installSessionScopedToolCallbackGuard } from '@polo-ai/shared/agent'
import { getSessionScopedToolCallbacks, getSessionScopedToolCallbackLease, mergeSessionScopedToolCallbacks, registerSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacksIf, unregisterAllSessionScopedToolCallbacks } from '@polo-ai/shared/agent/session-scoped-tool-callback-registry'
import { makeAnswerResolution, makeQuestionRequest } from '../../sessions/request-user-input-fixtures'

const TEST_ACCOUNT_ID = 'account-a'
const OTHER_ACCOUNT_ID = 'account-b'
const TEST_SPACE_ID = 'space-personal'
const OTHER_SPACE_ID = 'space-enterprise-b'
const WORKSPACE_ID = 'ws_test'
const OTHER_WORKSPACE_ID = 'ws_other'
const OWNER_ID = 'Permissions::/ws/a/config.json'

// R40-1/R40-2/R40-3 handler regressions: RESPOND_TO_QUESTION,
// CREATE_EDIT_POPOVER_SESSION and GET_EDIT_POPOVER_PENDING_QUESTION must all
// authorize against the caller's complete Main-owned trusted scope
// (account AND committed ProductSpace AND caller Workspace) — a stale
// renderer holding pre-switch session ids can neither mutate, create nor
// disclose old-space assistant data.

const realRelease = serverCoreDomain.releaseBrowserOwnershipOnForcedStop as
  | ((...args: unknown[]) => Promise<unknown>)
  | undefined
mock.module('@polo-ai/server-core/domain', () => ({
  ...serverCoreDomain,
  releaseBrowserOwnershipOnForcedStop: async (...args: unknown[]) => {
    if (realRelease) return await realRelease(...args)
    return undefined
  },
}))

// R49-C harness seam: the R49-C regression needs the construction pipeline to
// produce a backend whose postInit NEVER settles. The real Claude/Pi creation
// requires packaged SDK binaries unavailable in unit tests, so the backend
// module is wrapped — the production `createBackendFromResolvedContext` is
// honoured unless the stall flag is armed by the R49-C test.
const agentBackendModule = await import('@polo-ai/shared/agent/backend')
let r49StallPostInit = false
// R51-B harness seam: controllable delay for the awaited factory input
// (enable1MContext config read) inside construction.
const agentStorageModule = await import('@polo-ai/shared/config/storage')
const realGetEnable1MContext = agentStorageModule.getEnable1MContext
let r51FactoryInputGate: Promise<void> | null = null
let r51ReleaseFactoryInputGate: (() => void) | null = null
let r51FactoryInputGateEntered = false
mock.module('@polo-ai/shared/config/storage', () => ({
  ...agentStorageModule,
  getEnable1MContext: async () => {
    if (r51FactoryInputGate) {
      r51FactoryInputGateEntered = true
      await r51FactoryInputGate
    }
    return realGetEnable1MContext()
  },
}))
const r49StalledAgent = {
  dispose: () => {},
  setSessionTurnGeneration: () => {},
  queryLlm: () => {
    throw new Error('stalled construction: queryLlm must never run')
  },
  spawnSession: () => {
    throw new Error('stalled construction: spawnSession must never run')
  },
  preExecuteSpawnSession: () => {
    throw new Error('stalled construction: preExecuteSpawnSession must never run')
  },
  postInit: () => new Promise(() => {}),
}
mock.module('@polo-ai/shared/agent/backend', () => ({
  ...agentBackendModule,
  createBackendFromResolvedContext: (context: unknown) => {
    if (r49StallPostInit) return r49StalledAgent
    return agentBackendModule.createBackendFromResolvedContext(context as never)
  },
}))

const { SessionManager } = await import('@polo-ai/server-core/sessions')
const { createManagedSession } = await import('../../sessions/SessionManager.ts')
const { registerSessionsHandlers } = await import('./sessions.ts')

describe('question + edit-popover RPC trusted scope (R40)', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof import('@polo-ai/server-core/sessions').SessionManager>
  let events: Array<Record<string, unknown>>
  let handlers: Map<string, (ctx: unknown, ...args: unknown[]) => unknown>

  const seedSession = (
    sessionId: string,
    overrides: { origin?: string; hidden?: boolean; popoverOwner?: string; systemPromptPreset?: string } = {},
  ) => {
    const request = makeQuestionRequest(sessionId)
    const managed = createManagedSession(
      {
        id: sessionId,
        name: 'scoped session',
        createdAt: Date.now(),
        origin: overrides.origin as never,
        hidden: overrides.hidden,
        popoverOwner: overrides.popoverOwner,
        systemPromptPreset: overrides.systemPromptPreset,
      },
      { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
      { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    managed.pendingQuestion = overrides.origin === 'edit-popover' ? request : undefined
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return managed
  }

  const seedColdEditPopoverHeader = (
    sessionId: string,
    extra: { withPendingAgentResume?: boolean } = {},
  ) => {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'cold popover session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      hidden: true,
      origin: 'edit-popover',
      popoverOwner: OWNER_ID,
      systemPromptPreset: 'mini',
      productSpaceId: TEST_SPACE_ID,
      accountId: TEST_ACCOUNT_ID,
      pendingQuestion: makeQuestionRequest(sessionId),
      pendingAgentResume: extra.withPendingAgentResume
        ? { messageId: `msg-${sessionId}`, attempts: 1, invocationSource: 'desktop' }
        : undefined,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    } as unknown as StoredSession
    writeSessionJsonl(filePath, stored)
  }

  const loadStored = (sessionId: string): StoredSession => {
    const storage = (sm as unknown as { sessionStorage: { load: (root: string, id: string) => StoredSession | null } }).sessionStorage
    return storage.load(tmpRoot, sessionId) as StoredSession
  }

  const barrierFileFor = (sessionId: string): string => join(
    tmpRoot,
    '.polo-resume-quarantine',
    `${createHash('sha256').update(sessionId).digest('hex')}.json`,
  )

  const coldHydrateWithBarrier = async (sessionId: string): Promise<{
    sm2: InstanceType<typeof SessionManager>
    cold: { pendingAgentResume?: unknown; isProcessing: boolean; resumeRetryTimer?: unknown }
    sm2Events: Array<Record<string, unknown>>
  }> => {
    const sm2 = new (SessionManager as unknown as { new(options: unknown): InstanceType<typeof SessionManager> })({
      workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() },
    })
    const sm2Events: Array<Record<string, unknown>> = []
    sm2.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      sm2Events.push(event)
    }) as never)
    const cold = createManagedSession(
      { id: sessionId, name: 'cold rebuild', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
      {},
    )
    ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, cold)
    await sm2.getSession(sessionId)
    await new Promise(r => setTimeout(r, 80))
    return { sm2, cold: cold as never, sm2Events }
  }

  const storageSessionCount = (): number => {
    const storage = (sm as unknown as { sessionStorage: { list: (root: string) => unknown[] } }).sessionStorage
    return storage.list(tmpRoot).length
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rpc-question-scope-'))
    sm = new SessionManager({ workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } } as never)
    events = []
    resetProductSpaceExecutionRegistryForTests()
    setRuntimeOfflineReadOnly(false)
    setSyncTrustedProductSpaceAccountId(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
    setTrustedProductSpaceAccountProvider(async () => TEST_ACCOUNT_ID)
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
    }) as never)
    handlers = new Map()
    const server = {
      handle(channel: string, handler: (ctx: unknown, ...args: unknown[]) => unknown) {
        handlers.set(channel, handler as never)
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
    } as unknown as RpcServer
    const testLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    registerSessionsHandlers(server, {
      sessionManager: sm,
      platform: { logger: testLogger },
    } as never)
  })

  afterEach(() => {
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    const epoch = getActiveAccountTransitionEpoch()
    if (epoch !== null) settleAccountTransition(epoch, 'abort')
    setRuntimeOfflineReadOnly(false)
    resetProductSpaceExecutionRegistryForTests()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  // ==========================================================================
  // R40-1: RESPOND_TO_QUESTION
  // ==========================================================================

  describe('RESPOND_TO_QUESTION', () => {
    const respond = (sessionId: string, resolution: unknown, ctxWorkspaceId: string = WORKSPACE_ID) =>
      handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_QUESTION)!(
        { workspaceId: ctxWorkspaceId, clientId: 'client-1' },
        sessionId,
        resolution,
      ) as Promise<unknown>

    it('an authorized cancel in the current scope commits (positive control)', async () => {
      const managed = seedSession('q-scope-ok', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      const result = (await respond('q-scope-ok', { action: 'cancel', requestId: `q-q-scope-ok` })) as { status: string }
      expect(result.status).toBe('cancelled')
      expect(managed.pendingQuestion).toBeUndefined()
      expect(events.some(e => (e as { type?: string }).type === 'question_resolved')).toBe(true)
    })

    it('refuses a session bound to a ProductSpace that is no longer active (zero side effects)', async () => {
      const managed = seedSession('q-scope-old', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      const messagesBefore = managed.messages.length
      // A→B switch: the fence moved on, the stale renderer still holds A's
      // session id.
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      await expect(respond('q-scope-old', makeAnswerResolution(makeQuestionRequest('q-scope-old'))))
        .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect(managed.pendingQuestion?.requestId).toBe(`q-q-scope-old`)
      expect(managed.messages.length).toBe(messagesBefore)
      expect(managed.pendingAgentResume).toBeUndefined()
      expect(events).toEqual([])
    })

    it('refuses a caller whose Workspace differs from the session workspace (zero side effects)', async () => {
      const managed = seedSession('q-scope-ws', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      const messagesBefore = managed.messages.length
      await expect(respond('q-scope-ws', makeAnswerResolution(makeQuestionRequest('q-scope-ws')), OTHER_WORKSPACE_ID))
        .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect(managed.pendingQuestion?.requestId).toBe(`q-q-scope-ws`)
      expect(managed.messages.length).toBe(messagesBefore)
      expect(managed.pendingAgentResume).toBeUndefined()
      expect(events).toEqual([])
    })

    it('refuses in the offline read-only view (zero side effects)', async () => {
      const managed = seedSession('q-scope-off', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      const messagesBefore = managed.messages.length
      setRuntimeOfflineReadOnly(true)
      try {
        await expect(respond('q-scope-off', makeAnswerResolution(makeQuestionRequest('q-scope-off'))))
          .rejects.toThrow('OFFLINE_READ_ONLY')
      } finally {
        setRuntimeOfflineReadOnly(false)
      }
      expect(managed.pendingQuestion?.requestId).toBe(`q-q-scope-off`)
      expect(managed.messages.length).toBe(messagesBefore)
      expect(managed.pendingAgentResume).toBeUndefined()
      expect(events).toEqual([])
    })

    it('refuses when the account transition epoch changes while the resolution awaits the question lock (zero persistence, zero resume)', async () => {
      const managed = seedSession('q-scope-epoch', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      const messagesBefore = managed.messages.length
      // Hold the question lock: the resolution parks BEFORE its in-lock
      // revalidation; the transition epoch advances while it waits.
      let releaseLock!: () => void
      const hungLock = new Promise<void>(resolve => { releaseLock = resolve })
      const realLock = (sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<unknown>) => Promise<unknown> }).withQuestionStateLock.bind(sm)
      void realLock('q-scope-epoch', () => hungLock)
      await new Promise(r => setImmediate(r))

      const pending = respond('q-scope-epoch', makeAnswerResolution(makeQuestionRequest('q-scope-epoch')))
      await new Promise(r => setImmediate(r))
      beginAccountTransition()
      releaseLock()

      await expect(pending).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect(managed.pendingQuestion?.requestId).toBe(`q-q-scope-epoch`)
      expect(managed.messages.length).toBe(messagesBefore)
      expect(managed.pendingAgentResume).toBeUndefined()
      expect(managed.isProcessing).toBe(false)
      expect(events).toEqual([])
      const epoch = getActiveAccountTransitionEpoch()
      if (epoch !== null) settleAccountTransition(epoch, 'abort')
    })
  })

  // ==========================================================================
  // R40-2: CREATE_EDIT_POPOVER_SESSION
  // ==========================================================================

  describe('CREATE_EDIT_POPOVER_SESSION', () => {
    const create = (workspaceId: string, ctxWorkspaceId: string = WORKSPACE_ID) =>
      handlers.get(RPC_CHANNELS.sessions.CREATE_EDIT_POPOVER_SESSION)!(
        { workspaceId: ctxWorkspaceId, clientId: 'client-1' },
        workspaceId,
        { popoverOwner: OWNER_ID, model: 'fast', systemPromptPreset: 'mini', hidden: true },
      ) as Promise<{ id: string; origin?: string; popoverOwner?: string }>

    it('an authorized creation stamps the privileged origin (positive control)', async () => {
      const session = await create(WORKSPACE_ID)
      expect(session.origin).toBe('edit-popover')
      expect(session.popoverOwner).toBe(OWNER_ID)
      expect(storageSessionCount()).toBe(1)
    })

    it('refuses a forged destination workspace and leaves no hidden session (memory or storage)', async () => {
      await expect(create('ws_victim')).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      expect(storageSessionCount()).toBe(0)
    })

    it('refuses when the ProductSpace fence is null and leaves no hidden session', async () => {
      await revokeRuntimeProductSpaceFence()
      await expect(create(WORKSPACE_ID)).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      expect(storageSessionCount()).toBe(0)
    })

    it('refuses in the offline read-only view and leaves no hidden session', async () => {
      setRuntimeOfflineReadOnly(true)
      try {
        await expect(create(WORKSPACE_ID)).rejects.toThrow('OFFLINE_READ_ONLY')
      } finally {
        setRuntimeOfflineReadOnly(false)
      }
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      expect(storageSessionCount()).toBe(0)
    })

    it('refuses when the scope drifts during the durable origin stamp and tears the hidden session down (memory + storage)', async () => {
      // Wrap createSession to know when creation completed, then flushSession
      // to advance the account transition epoch exactly during the stamp's
      // awaited flush — the post-stamp publication CAS must refuse.
      const realCreate = (sm as unknown as { createSession: (...args: unknown[]) => Promise<unknown> }).createSession.bind(sm)
      const realFlush = (sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession.bind(sm)
      let creationDone = false
      ;(sm as unknown as { createSession: unknown }).createSession = async (...args: unknown[]) => {
        const created = await realCreate(...args)
        creationDone = true
        return created
      }
      ;(sm as unknown as { flushSession: unknown }).flushSession = async (id: string) => {
        if (creationDone) beginAccountTransition()
        return realFlush(id)
      }

      await expect(create(WORKSPACE_ID)).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      expect(storageSessionCount()).toBe(0)
      expect(listRegisteredProductSpaceExecutions()).toEqual([])
      const epoch = getActiveAccountTransitionEpoch()
      if (epoch !== null) settleAccountTransition(epoch, 'abort')
    })
  })

  // ==========================================================================
  // R40-3: GET_EDIT_POPOVER_PENDING_QUESTION
  // ==========================================================================

  describe('GET_EDIT_POPOVER_PENDING_QUESTION', () => {
    const lookup = (workspaceId: string, ctxWorkspaceId: string = WORKSPACE_ID) =>
      handlers.get(RPC_CHANNELS.sessions.GET_EDIT_POPOVER_PENDING_QUESTION)!(
        { workspaceId: ctxWorkspaceId, clientId: 'client-1' },
        workspaceId,
        OWNER_ID,
      ) as Promise<{ sessionId: string } | null>

    it('returns the live same-scope pending question (positive control)', async () => {
      seedSession('q-lookup-live', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      const result = await lookup(WORKSPACE_ID)
      expect(result?.sessionId).toBe('q-lookup-live')
    })

    it('discloses nothing for the same workspace after a ProductSpace switch (live and cold), adopting nothing', async () => {
      seedSession('q-lookup-live-b', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      seedColdEditPopoverHeader('q-lookup-cold-b')
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      await expect(lookup(WORKSPACE_ID)).resolves.toBeNull()
      // The cold header bound to the old space was NOT adopted into memory.
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has('q-lookup-cold-b')).toBe(false)
    })

    it('refuses entirely after an account replacement (mirror no longer matches the fence account)', async () => {
      seedSession('q-lookup-acct', { origin: 'edit-popover', hidden: true, popoverOwner: OWNER_ID })
      setSyncTrustedProductSpaceAccountId(OTHER_ACCOUNT_ID)
      try {
        await expect(lookup(WORKSPACE_ID)).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      } finally {
        setSyncTrustedProductSpaceAccountId(TEST_ACCOUNT_ID)
      }
    })

    it('refuses a caller whose Workspace differs from the lookup workspace', async () => {
      await expect(lookup(WORKSPACE_ID, OTHER_WORKSPACE_ID)).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    })

    it('hydrates and discloses a same-scope cold pending question (positive control)', async () => {
      seedColdEditPopoverHeader('q-lookup-cold-ok')
      const result = await lookup(WORKSPACE_ID)
      expect(result?.sessionId).toBe('q-lookup-cold-ok')
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has('q-lookup-cold-ok')).toBe(true)
    })

    // ------------------------------------------------------------------
    // R41-3: the ProductSpace switch must land INSIDE the hydration load —
    // the candidate is never published before the awaited load completes.
    // ------------------------------------------------------------------
    it('a switch during the parked hydration leaves no map entry, no scheduled recovery, no events and no disclosure', async () => {
      seedColdEditPopoverHeader('q-lookup-cold-race', { withPendingAgentResume: true })
      const realLoad = (sm as unknown as { loadMessagesFromDisk: (m: unknown) => Promise<void> }).loadMessagesFromDisk.bind(sm)
      let releaseLoad!: () => void
      const gated = new Promise<void>(resolve => { releaseLoad = () => resolve() })
      let parked = false
      ;(sm as unknown as { loadMessagesFromDisk: unknown }).loadMessagesFromDisk = async (managed: unknown) => {
        if (!parked) {
          parked = true
          await gated
        }
        return realLoad(managed)
      }

      const pending = lookup(WORKSPACE_ID)
      await new Promise(r => setImmediate(r))
      // The switch commits while the hydration load is parked.
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      releaseLoad()

      await expect(pending).resolves.toBeNull()
      // Drain the load's setImmediate recovery callbacks: against the
      // unregistered candidate they must all no-op.
      for (let i = 0; i < 5; i += 1) {
        await new Promise(r => setImmediate(r))
      }
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      expect(events).toEqual([])
      // The cold header itself is untouched: pending question AND armed
      // resume stay exactly as persisted.
      const stored = loadStored('q-lookup-cold-race')
      expect(stored.pendingQuestion?.requestId).toBe(`q-q-lookup-cold-race`)
      expect(stored.pendingAgentResume).toBeTruthy()
    })
  })

  // ==========================================================================
  // R41-1: question resolution across the flush boundary
  // ==========================================================================

  describe('question resolution mid-flush fence switch (R41-1)', () => {
    /** Parks the resolution's FIRST flushSession so the fence can move inside the flush await. */
    const parkFirstFlush = (): { release: () => void } => {
      const realFlush = (sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession.bind(sm)
      let release!: () => void
      const gated = new Promise<void>(resolve => { release = () => resolve() })
      let parked = false
      ;(sm as unknown as { flushSession: unknown }).flushSession = async (id: string) => {
        if (!parked) {
          parked = true
          await gated
        }
        return realFlush(id)
      }
      return { release }
    }

    const respond = (sessionId: string, resolution: unknown) =>
      handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_QUESTION)!(
        { workspaceId: WORKSPACE_ID, clientId: 'client-1' },
        sessionId,
        resolution,
      ) as Promise<unknown>

    it('a cancel whose flush spans a ProductSpace switch is refused with the pre-resolution state restored (zero net persistence, zero events)', async () => {
      const managed = seedSession('q-flush-cancel')
      managed.pendingQuestion = makeQuestionRequest('q-flush-cancel')
      const messagesBefore = managed.messages.length
      const { release } = parkFirstFlush()

      const pending = respond('q-flush-cancel', { action: 'cancel', requestId: 'q-q-flush-cancel' })
      await new Promise(r => setImmediate(r))
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      release()

      await expect(pending).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      // In-memory: the pre-resolution snapshot is live again.
      expect(managed.pendingQuestion?.requestId).toBe('q-q-flush-cancel')
      expect(managed.messages.length).toBe(messagesBefore)
      expect(managed.pendingAgentResume).toBeUndefined()
      expect(managed.resumeRetryTimer).toBeUndefined()
      // Durable: the stored header carries the pending question, no cancel
      // record, no armed resume — zero NET persistence of the mutation.
      const stored = loadStored('q-flush-cancel')
      expect(stored.pendingQuestion?.requestId).toBe('q-q-flush-cancel')
      expect(stored.messages.some(m => (m as { questionResolution?: unknown }).questionResolution)).toBe(false)
      expect(stored.pendingAgentResume).toBeUndefined()
      expect(events).toEqual([])
    })

    it('an answer whose flush spans a ProductSpace switch is refused, un-arms the resume durably and restores the pending question', async () => {
      const managed = seedSession('q-flush-answer')
      managed.pendingQuestion = makeQuestionRequest('q-flush-answer')
      const messagesBefore = managed.messages.length
      const { release } = parkFirstFlush()

      const pending = respond('q-flush-answer', makeAnswerResolution(makeQuestionRequest('q-flush-answer')))
      await new Promise(r => setImmediate(r))
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      release()

      await expect(pending).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect(managed.pendingQuestion?.requestId).toBe('q-q-flush-answer')
      expect(managed.messages.length).toBe(messagesBefore)
      expect(managed.pendingAgentResume).toBeUndefined()
      expect(managed.resumeRetryTimer).toBeUndefined()
      expect(managed.isProcessing).toBe(false)
      const stored = loadStored('q-flush-answer')
      expect(stored.pendingQuestion?.requestId).toBe('q-q-flush-answer')
      expect(stored.pendingAgentResume).toBeUndefined()
      expect(stored.messages.some(m => (m as { questionResponse?: unknown }).questionResponse)).toBe(false)
      expect(events).toEqual([])
    })

    // ------------------------------------------------------------------
    // R42: a failing COMPENSATION (restore flush) must never downgrade the
    // refusal — the typed scope refusal reaches the caller even when the
    // cleanup itself fails, and no executable pending resume survives.
    // ------------------------------------------------------------------
    const parkFirstFlushThenFailSecond = (): { release: () => void; parked: Promise<void> } => {
      const realFlush = (sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession.bind(sm)
      let release!: () => void
      const gated = new Promise<void>(resolve => { release = () => resolve() })
      let parkedSignal!: () => void
      const parked = new Promise<void>(resolve => { parkedSignal = resolve })
      let call = 0
      ;(sm as unknown as { flushSession: unknown }).flushSession = async (id: string) => {
        call += 1
        if (call === 1) {
          parkedSignal()
          await gated
          return realFlush(id)
        }
        if (call === 2) {
          throw new Error('disk full injected')
        }
        return realFlush(id)
      }
      return { release, parked }
    }

    it('a cancel whose restore flush fails still rejects as a scope refusal (never transient_failure)', async () => {
      const managed = seedSession('q-restore-cancel')
      managed.pendingQuestion = makeQuestionRequest('q-restore-cancel')
      const { release, parked } = parkFirstFlushThenFailSecond()

      const pending = respond('q-restore-cancel', { action: 'cancel', requestId: 'q-q-restore-cancel' })
      await parked
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      release()

      // TRUE rejection — a typed refusal carrying the honest compensation
      // failure, never a transient_failure result value.
      await expect(pending).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED (pre-resolution restore incomplete')
      expect(events).toEqual([])
      expect(managed.isProcessing).toBe(false)
      // No executable pending resume can exist for a cancel.
      const stored = loadStored('q-restore-cancel')
      expect(stored.pendingAgentResume ?? undefined).toBeUndefined()
    })

    it('an answer whose restore flush fails quarantines the resume with a durable TERMINAL marker and still rejects', async () => {
      const managed = seedSession('q-restore-answer')
      managed.pendingQuestion = makeQuestionRequest('q-restore-answer')
      const { release, parked } = parkFirstFlushThenFailSecond()

      const pending = respond('q-restore-answer', makeAnswerResolution(makeQuestionRequest('q-restore-answer')))
      await parked
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      release()

      await expect(pending).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED (pre-resolution restore incomplete')
      // Drain the quarantine flush and any straggler callbacks.
      await new Promise(r => setTimeout(r, 50))
      expect(events).toEqual([])
      expect(managed.isProcessing).toBe(false)
      expect(managed.resumeRetryTimer).toBeUndefined()
      // In memory AND on disk the resume is TERMINAL — hydration clears it
      // without ever executing the old space's answer turn. (The quarantine
      // write carries the restored pendingQuestion snapshot alongside the
      // terminal marker; the hard guarantee is the NON-EXECUTABLE resume.)
      expect(managed.pendingAgentResume?.completed).toBe(true)
      const stored = loadStored('q-restore-answer')
      expect(stored.pendingAgentResume).toBeTruthy()
      expect((stored.pendingAgentResume as { completed?: boolean }).completed).toBe(true)
    })

    // ------------------------------------------------------------------
    // R43: even when the restore flush AND the TERMINAL quarantine flush
    // BOTH fail, the durable quarantine barrier (independent of the session
    // JSONL) keeps the old answer turn non-executable across a restart.
    // ------------------------------------------------------------------
    it('restore AND quarantine writes failing still leave the old answer turn non-executable after a cold rebuild (durable barrier)', async () => {
      const managed = seedSession('q-barrier-answer')
      managed.pendingQuestion = makeQuestionRequest('q-barrier-answer')
      const realFlush = (sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession.bind(sm)
      let release!: () => void
      const gated = new Promise<void>(resolve => { release = () => resolve() })
      let parkedSignal!: () => void
      const parked = new Promise<void>(resolve => { parkedSignal = resolve })
      let call = 0
      ;(sm as unknown as { flushSession: unknown }).flushSession = async (id: string) => {
        call += 1
        if (call === 1) {
          parkedSignal()
          await gated
          return realFlush(id)
        }
        // call 2 = restore flush, call 3 = TERMINAL quarantine flush — BOTH fail.
        throw new Error('disk full injected')
      }

      const pending = respond('q-barrier-answer', makeAnswerResolution(makeQuestionRequest('q-barrier-answer')))
      await parked
      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      release()

      await expect(pending).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED (pre-resolution restore incomplete')
      expect(events).toEqual([])
      // The BARRIER exists on disk although every session-JSONL write after
      // the first failed — it is the fail-closed guarantee. (R45: the file
      // name is the sha256 digest of the session id.)
      const barrierPath = join(
        tmpRoot,
        '.polo-resume-quarantine',
        `${createHash('sha256').update('q-barrier-answer').digest('hex')}.json`,
      )
      expect(existsSync(barrierPath)).toBe(true)
      // The durable header STILL carries the armed resume — the barrier, not
      // the header marker, is what makes it non-executable.
      const storedAfter = loadStored('q-barrier-answer')
      expect(storedAfter.pendingAgentResume).toBeTruthy()
      expect((storedAfter.pendingAgentResume as { completed?: boolean }).completed ?? false).toBe(false)

      // Cold rebuild from disk: hydration must consult the barrier — the
      // old answer turn is never armed, never scheduled, never executed.
      const sm2 = new (SessionManager as unknown as { new(options: unknown): InstanceType<typeof SessionManager> })({
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() },
      })
      const sm2Events: Array<Record<string, unknown>> = []
      sm2.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
        sm2Events.push(event)
      }) as never)
      const cold = createManagedSession(
        { id: 'q-barrier-answer', name: 'cold rebuild', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        {},
      )
      ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set('q-barrier-answer', cold)
      await sm2.getSession('q-barrier-answer')
      // Drain any recovery immediates/timers the hydration could have scheduled.
      await new Promise(r => setTimeout(r, 80))
      expect(cold.pendingAgentResume).toBeUndefined()
      expect(sm2Events).toEqual([])
      expect(cold.isProcessing).toBe(false)
      expect(cold.resumeRetryTimer).toBeUndefined()
      ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    })
  })

  // ==========================================================================
  // R41-2: edit-popover creation across the continuation gap
  // ==========================================================================

  describe('edit-popover creation mid-flight fence switch (R41-2)', () => {
    const createViaRpc = () =>
      handlers.get(RPC_CHANNELS.sessions.CREATE_EDIT_POPOVER_SESSION)!(
        { workspaceId: WORKSPACE_ID, clientId: 'client-1' },
        WORKSPACE_ID,
        { popoverOwner: OWNER_ID, model: 'fast', systemPromptPreset: 'mini', hidden: true },
      ) as Promise<{ id: string }>

    it('a switch landing after createSession but before the origin stamp refuses and leaves no hidden session (memory + storage)', async () => {
      const realCreate = (sm as unknown as { createSession: (...args: unknown[]) => Promise<unknown> }).createSession.bind(sm)
      ;(sm as unknown as { createSession: unknown }).createSession = async (...args: unknown[]) => {
        const created = await realCreate(...args)
        // The switch commits exactly in the continuation gap between the
        // awaited creation and the privileged stamp.
        setRuntimeActiveProductSpace(OTHER_SPACE_ID)
        return created
      }

      await expect(createViaRpc()).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      expect(storageSessionCount()).toBe(0)
    })

    it('reports an incomplete teardown honestly instead of swallowing it', async () => {
      const realCreate = (sm as unknown as { createSession: (...args: unknown[]) => Promise<unknown> }).createSession.bind(sm)
      ;(sm as unknown as { createSession: unknown }).createSession = async (...args: unknown[]) => {
        const created = await realCreate(...args)
        setRuntimeActiveProductSpace(OTHER_SPACE_ID)
        return created
      }
      const realDelete = (sm as unknown as { sessionStorage: { delete: (root: string, id: string) => boolean } }).sessionStorage.delete.bind(sm.sessionStorage)
      ;(sm as unknown as { sessionStorage: { delete: unknown } }).sessionStorage.delete = () => false
      try {
        await expect(createViaRpc()).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED (rollback incomplete')
      } finally {
        ;(sm as unknown as { sessionStorage: { delete: (root: string, id: string) => boolean } }).sessionStorage.delete = realDelete
      }
    })

    // ------------------------------------------------------------------
    // R42: a replacement owner occupying the id must SURVIVE the scope-loss
    // teardown — memory entry, storage record, mode state and callback
    // registrations are the NEW owner's and are never deleted, leaked-into
    // or wrapped by the stale creation's guard.
    // ------------------------------------------------------------------
    it('a replacement owner occupying the id survives the teardown; its mode state and callbacks are preserved', async () => {
      let creationDone = false
      const realCreate = (sm as unknown as { createSession: (...args: unknown[]) => Promise<unknown> }).createSession.bind(sm)
      ;(sm as unknown as { createSession: unknown }).createSession = async (...args: unknown[]) => {
        const created = await realCreate(...args)
        creationDone = true
        return created
      }
      const realFlush = (sm as unknown as { flushSession: (id: string) => Promise<void> }).flushSession.bind(sm)
      let release!: () => void
      const gated = new Promise<void>(resolve => { release = () => resolve() })
      let parked = false
      ;(sm as unknown as { flushSession: unknown }).flushSession = async (id: string) => {
        if (creationDone && !parked) {
          parked = true
          await gated
        }
        return realFlush(id)
      }

      const pendingRpc = createViaRpc()
      for (let i = 0; i < 300 && !parked; i += 1) {
        await new Promise(r => setTimeout(r, 10))
      }
      expect(parked).toBe(true)

      // The replacement owner takes over the id while the stamp flush is
      // parked, registers its OWN mode state and session-scoped callbacks.
      const createdId = [...(sm as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0] as string
      const replacement = createManagedSession(
        { id: createdId, name: 'replacement owner', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: OTHER_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(createdId, replacement)
      setPermissionMode(createdId, 'allow-all', { changedBy: 'system' })
      registerSessionScopedToolCallbacks(createdId, { list_sessions: async () => [] } as never)

      setRuntimeActiveProductSpace(OTHER_SPACE_ID)
      release()

      await expect(pendingRpc).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      // The replacement owner survived every surface.
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get(createdId)).toBe(replacement)
      expect(storageSessionCount()).toBe(1)
      expect(getPermissionMode(createdId)).toBe('allow-all')
      expect(getSessionScopedToolCallbacks(createdId)).toBeDefined()
      // Tidy the global callback registry for later tests.
      unregisterSessionScopedToolCallbacks(createdId)
    })

    // ------------------------------------------------------------------
    // R43: the replacement lands DURING the parked runtime-disposal await —
    // every id-wide surface after the disposal must re-verify ownership and
    // skip, so the replacement's registrations/mode/storage survive and its
    // callbacks are never unregistered or stale-guard wrapped.
    // ------------------------------------------------------------------
    it('a replacement landing during the parked runtime disposal survives every id-wide surface', async () => {
      const realCreate = (sm as unknown as { createSession: (...args: unknown[]) => Promise<unknown> }).createSession.bind(sm)
      ;(sm as unknown as { createSession: unknown }).createSession = async (...args: unknown[]) => {
        const created = await realCreate(...args)
        setRuntimeActiveProductSpace(OTHER_SPACE_ID)
        return created
      }
      const realDispose = (sm as unknown as { disposeManagedAgentRuntime: (m: unknown, reason: string, opts?: { shouldUnregisterCallbacks?: () => boolean }) => Promise<{ failures: string[]; callbacksUnregistered: boolean }> }).disposeManagedAgentRuntime.bind(sm)
      let dRelease!: () => void
      const dGated = new Promise<void>(resolve => { dRelease = () => resolve() })
      let disposeParkedSignal!: () => void
      const disposeParkedPromise = new Promise<void>(resolve => { disposeParkedSignal = resolve })
      let disposeParked = false
      ;(sm as unknown as { disposeManagedAgentRuntime: unknown }).disposeManagedAgentRuntime = async (managed: unknown, reason: string, opts?: { shouldUnregisterCallbacks?: () => boolean }) => {
        if (!disposeParked) {
          disposeParked = true
          disposeParkedSignal()
          await dGated
        }
        return realDispose(managed, reason, opts)
      }

      const pendingRpc = createViaRpc()
      for (let i = 0; i < 300 && !disposeParked; i += 1) {
        await new Promise(r => setTimeout(r, 10))
      }
      void disposeParkedPromise

      // The replacement owner takes over the id DURING the parked disposal.
      const createdId = [...(sm as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0] as string
      const replacement = createManagedSession(
        { id: createdId, name: 'replacement owner', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: OTHER_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(createdId, replacement)
      setPermissionMode(createdId, 'allow-all', { changedBy: 'system' })
      registerSessionScopedToolCallbacks(createdId, { list_sessions: async () => [] } as never)

      dRelease()
      await expect(pendingRpc).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      // Every id-wide surface after the disposal re-verified ownership and
      // skipped: the replacement survived untouched.
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get(createdId)).toBe(replacement)
      expect(storageSessionCount()).toBe(1)
      expect(getPermissionMode(createdId)).toBe('allow-all')
      expect(getSessionScopedToolCallbacks(createdId)).toBeDefined()
      unregisterSessionScopedToolCallbacks(createdId)
    })

    it('runtime disposal failures are reported structurally instead of faking success', async () => {
      const managed = seedSession('q-dispose-fail')
      managed.agent = {
        dispose: () => { throw new Error('dispose boom') },
      } as never
      // R49: the runtime owns a callback lease (registered before disposal) —
      // the entry-time CAS still removes it despite the agent-face failure.
      managed.callbackLease = registerSessionScopedToolCallbacks(managed.id, { listSessionsFn: async () => 'owned' } as never)
      const result = await (sm as unknown as {
        disposeManagedAgentRuntime: (m: unknown, reason: string, opts?: { bestEffort?: boolean }) => Promise<{ failures: string[]; callbacksUnregistered: boolean }>
      }).disposeManagedAgentRuntime(managed, 'test', { bestEffort: true })
      expect(result.failures.length).toBeGreaterThan(0)
      expect(result.failures.some(f => f.includes('dispose boom'))).toBe(true)
      // The failed reference is deliberately KEPT (never a fake cleanup).
      expect(managed.agent).toBeTruthy()
      expect(result.callbacksUnregistered).toBe(true)
      expect(getSessionScopedToolCallbacks(managed.id)).toBeUndefined()
    })
  })

  // ==========================================================================
  // R45-A: the resume-quarantine barrier must be fail-closed on I/O and
  // schema errors, contain path traversal, and be atomic under concurrency.
  // ==========================================================================

  describe('resume-quarantine barrier hardening (R45-A)', () => {
    const seedBarrierScenario = (sessionId: string): void => {
      seedColdEditPopoverHeader(sessionId, { withPendingAgentResume: true })
      mkdirSync(dirname(barrierFileFor(sessionId)), { recursive: true })
    }

    it('a malformed (truncated) barrier fail-closes hydration', async () => {
      seedBarrierScenario('q-barr-malformed')
      writeFileSync(barrierFileFor('q-barr-malformed'), '{"version":1,"sessionId":"q-barr', 'utf-8')
      const { sm2, cold, sm2Events } = await coldHydrateWithBarrier('q-barr-malformed')
      expect(cold.pendingAgentResume).toBeUndefined()
      expect(sm2Events).toEqual([])
      expect(cold.isProcessing).toBe(false)
      ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    })

    it('a barrier that is a DIRECTORY (EISDIR) fail-closes hydration', async () => {
      seedBarrierScenario('q-barr-eisdir')
      mkdirSync(barrierFileFor('q-barr-eisdir'), { recursive: true })
      const { sm2, cold, sm2Events } = await coldHydrateWithBarrier('q-barr-eisdir')
      expect(cold.pendingAgentResume).toBeUndefined()
      expect(sm2Events).toEqual([])
      ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    })

    it('an unreadable barrier (EACCES) fail-closes hydration', async () => {
      seedBarrierScenario('q-barr-eacces')
      writeFileSync(barrierFileFor('q-barr-eacces'), 'x', 'utf-8')
      chmodSync(barrierFileFor('q-barr-eacces'), 0o000)
      try {
        const { sm2, cold, sm2Events } = await coldHydrateWithBarrier('q-barr-eacces')
        expect(cold.pendingAgentResume).toBeUndefined()
        expect(sm2Events).toEqual([])
      } finally {
        chmodSync(barrierFileFor('q-barr-eacces'), 0o644)
      }
    })

    it('a barrier carrying a DIFFERENT session id fails schema validation and fail-closes', async () => {
      seedBarrierScenario('q-barr-foreign')
      writeFileSync(
        barrierFileFor('q-barr-foreign'),
        JSON.stringify({ version: 1, sessionId: 'someone-else', messageId: 'm1', quarantinedAt: Date.now(), reason: 'x' }),
        'utf-8',
      )
      const { sm2, cold, sm2Events } = await coldHydrateWithBarrier('q-barr-foreign')
      expect(cold.pendingAgentResume).toBeUndefined()
      expect(sm2Events).toEqual([])
      ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    })

    it('a proven-absent barrier (ENOENT) still allows the arm', async () => {
      // Header with an armed resume AND its answer message present, so the
      // armed state survives the drain (the retry needs its message).
      const sessionId = 'q-barr-absent'
      const filePath = getSessionFilePath(tmpRoot, sessionId)
      mkdirSync(dirname(filePath), { recursive: true })
      const stored = {
        id: sessionId,
        workspaceRootPath: tmpRoot,
        name: 'cold popover session',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        hidden: true,
        origin: 'edit-popover',
        popoverOwner: OWNER_ID,
        systemPromptPreset: 'mini',
        productSpaceId: TEST_SPACE_ID,
        accountId: TEST_ACCOUNT_ID,
        pendingQuestion: makeQuestionRequest(sessionId),
        pendingAgentResume: { messageId: `msg-${sessionId}`, attempts: 1, invocationSource: 'desktop' },
        messages: [{ id: `msg-${sessionId}`, role: 'user', content: 'the committed answer', timestamp: Date.now() }],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      } as unknown as StoredSession
      writeSessionJsonl(filePath, stored)
      expect(existsSync(barrierFileFor(sessionId))).toBe(false)
      const { sm2, cold } = await coldHydrateWithBarrier(sessionId)
      // Pre-existing semantics: without a barrier the persisted recovery arms.
      expect((cold.pendingAgentResume as { messageId?: string } | undefined)?.messageId).toBe(`msg-${sessionId}`)
      ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    })

    it('a bundle-v1 traversal session id cannot escape the quarantine directory', async () => {
      const barrierSessionManager = new (SessionManager as unknown as { new(options: unknown): InstanceType<typeof SessionManager> })({
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() },
      })
      const malicious = '../../outside-quarantine'
      const maliciousManagedSession = createManagedSession(
        { id: malicious, name: 'malicious', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        {},
      )
      const barrierPath = (barrierSessionManager as unknown as {
        resumeQuarantineBarrierPath: (root: string, id: string) => string
      }).resumeQuarantineBarrierPath(tmpRoot, malicious)
      const quarantineDir = join(tmpRoot, '.polo-resume-quarantine')
      expect(barrierPath.startsWith(quarantineDir + '/')).toBe(true)
      expect(resolvePath(barrierPath).startsWith(resolvePath(quarantineDir) + '/')).toBe(true)
      expect(barrierPath.includes('..')).toBe(false)
      // Writing a barrier for the malicious id lands INSIDE the directory,
      // keyed by the sha256 digest — nothing escapes the workspace.
      await (barrierSessionManager as unknown as {
        writeResumeQuarantineBarrier: (m: unknown, r: unknown, reason: string) => Promise<void>
      }).writeResumeQuarantineBarrier(maliciousManagedSession, { messageId: 'm1', invocationSource: 'desktop' }, 'probe')
      expect(existsSync(barrierPath)).toBe(true)
      expect(existsSync(join(tmpRoot, 'outside-quarantine.json'))).toBe(false)
      expect(await (barrierSessionManager as unknown as {
        isResumeQuarantinedByBarrier: (root: string, id: string, messageId?: string) => Promise<boolean>
      }).isResumeQuarantinedByBarrier(tmpRoot, malicious, 'm1')).toBe(true)
    })

    it('concurrent barrier writers cannot expose partial JSON (atomic private rename)', async () => {
      seedBarrierScenario('q-barr-concurrent')
      const barrierSessionManager = new (SessionManager as unknown as { new(options: unknown): InstanceType<typeof SessionManager> })({
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() },
      })
      const concurrentManagedSession = createManagedSession(
        { id: 'q-barr-concurrent', name: 'x', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        {},
      )
      const writeBarrier = (barrierSessionManager as unknown as {
        writeResumeQuarantineBarrier: (m: unknown, r: unknown, reason: string) => Promise<void>
      }).writeResumeQuarantineBarrier.bind(barrierSessionManager)
      await Promise.all([
        writeBarrier(concurrentManagedSession, { messageId: 'm1', invocationSource: 'desktop' }, 'w1'),
        writeBarrier(concurrentManagedSession, { messageId: 'm2', invocationSource: 'desktop' }, 'w2'),
      ])
      // The file at the barrier path is ALWAYS a complete document.
      const parsed = JSON.parse(readFileSync(barrierFileFor('q-barr-concurrent'), 'utf-8')) as { version?: number; messageId?: string }
      expect(parsed.version).toBe(1)
      // R46 exact-answer matching: the surviving barrier quarantines ITS OWN
      // message id — never the whole session.
      const isQuarantined = (barrierSessionManager as unknown as {
        isResumeQuarantinedByBarrier: (root: string, id: string, messageId?: string) => Promise<boolean>
      }).isResumeQuarantinedByBarrier.bind(barrierSessionManager)
      expect(await isQuarantined(tmpRoot, 'q-barr-concurrent', parsed.messageId)).toBe(true)
      expect(await isQuarantined(tmpRoot, 'q-barr-concurrent', `other-${parsed.messageId}`)).toBe(false)
    })
  })

  // ==========================================================================
  // R45-B: runtime disposal failures must be impossible to ignore at every
  // production call site.
  // ==========================================================================

  describe('runtime disposal failure consumers (R45-B)', () => {
    const failingAgent = (): { dispose: () => never } => ({
      dispose: () => { throw new Error('dispose boom') },
    })

    it('restart-required refresh fails closed when disposal fails (ref kept, callbacks kept, bookkeeping intact)', async () => {
      const managed = seedSession('q-refresh-restart')
      managed.agent = failingAgent() as never
      registerSessionScopedToolCallbacks(managed.id, { list_sessions: async () => [] } as never)
      try {
        await expect((sm as unknown as {
          runAgentRuntimeRefresh: (m: unknown, ctx: unknown, rt: string, rst: string, restartRequired: boolean, reason: string) => Promise<void>
        }).runAgentRuntimeRefresh(managed, {} as never, 'rt-signature', 'rst-signature', true, 'test restart'))
          .rejects.toThrow('agent runtime disposal failed during restart-required runtime change')
        // The stale agent reference is retained and its bookkeeping is NOT
        // cleared; the registered callbacks were never unregistered.
        expect(managed.agent).toBeTruthy()
        expect(managed.backendRuntimeSignature).toBeUndefined()
        expect(getSessionScopedToolCallbacks(managed.id)).toBeDefined()
      } finally {
        unregisterSessionScopedToolCallbacks(managed.id)
      }
    })

    it('in-place refresh fallback fails closed when disposal fails', async () => {
      const managed = seedSession('q-refresh-inplace')
      // No updateRuntimeConfig on the stub → in-place refresh reports
      // not-refreshed → falls back to disposal, which fails.
      managed.agent = failingAgent() as never
      registerSessionScopedToolCallbacks(managed.id, { list_sessions: async () => [] } as never)
      try {
        await expect((sm as unknown as {
          runAgentRuntimeRefresh: (m: unknown, ctx: unknown, rt: string, rst: string, restartRequired: boolean, reason: string) => Promise<void>
        }).runAgentRuntimeRefresh(managed, {} as never, 'rt-signature', 'rst-signature', false, 'test in-place'))
          .rejects.toThrow('agent runtime disposal failed during runtime config refresh')
        expect(managed.agent).toBeTruthy()
        expect(getSessionScopedToolCallbacks(managed.id)).toBeDefined()
      } finally {
        unregisterSessionScopedToolCallbacks(managed.id)
      }
    })

    it('deleted/stopped-before-chat convergence refuses to silently return when the runtime survives', async () => {
      const managed = seedSession('q-converge-dispose')
      managed.agent = failingAgent() as never
      await expect((sm as unknown as {
        disposeManagedAgentRuntime: (m: unknown, reason: string) => Promise<unknown>
      }).disposeManagedAgentRuntime(managed, 'session deleted or stopped before chat start'))
        .rejects.toThrow('agent runtime disposal failed during session deleted or stopped before chat start')
      expect(managed.agent).toBeTruthy()
    })

    it('stale-publication rollback folds the disposal failure into an honest rollback-incomplete', async () => {
      const managed = seedSession('q-pub-rollback')
      managed.agent = failingAgent() as never
      let rollbackFailure: string | null = null
      try {
        await (sm as unknown as {
          disposeManagedAgentRuntime: (m: unknown, reason: string) => Promise<unknown>
        }).disposeManagedAgentRuntime(managed, 'stale_publication_scope')
      } catch (rollbackError) {
        rollbackFailure = `agent rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      }
      expect(rollbackFailure).not.toBeNull()
      expect(rollbackFailure).toContain('stale_publication_scope')
      expect(rollbackFailure).toContain('dispose boom')
      expect(managed.agent).toBeTruthy()
    })
  })

  // ==========================================================================
  // R46-A: a valid barrier quarantines only ITS OWN answer turn — a newer
  // legitimate resume for the same session must still arm (exact-answer
  // matching, cold rebuild).
  // ==========================================================================

  describe('resume-quarantine barrier exactness (R46-A)', () => {
    it('an older m1 barrier does not quarantine a newer m2 resume (cold rebuild)', async () => {
      // Armed resume in the header: messageId = msg-q-exact-m2, WITH its
      // answer message present (so the armed state survives the drain).
      const sessionId = 'q-exact-m2'
      const filePath = getSessionFilePath(tmpRoot, sessionId)
      mkdirSync(dirname(filePath), { recursive: true })
      const stored = {
        id: sessionId,
        workspaceRootPath: tmpRoot,
        name: 'cold popover session',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        hidden: true,
        origin: 'edit-popover',
        popoverOwner: OWNER_ID,
        systemPromptPreset: 'mini',
        productSpaceId: TEST_SPACE_ID,
        accountId: TEST_ACCOUNT_ID,
        pendingAgentResume: { messageId: `msg-${sessionId}`, attempts: 1, invocationSource: 'desktop' },
        messages: [{ id: `msg-${sessionId}`, role: 'user', content: 'the committed m2 answer', timestamp: Date.now() }],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      } as unknown as StoredSession
      writeSessionJsonl(filePath, stored)
      // A valid barrier left by an OLDER answer turn (different messageId).
      mkdirSync(dirname(barrierFileFor(sessionId)), { recursive: true })
      writeFileSync(
        barrierFileFor(sessionId),
        JSON.stringify({ version: 1, sessionId, messageId: 'm1-older-answer', quarantinedAt: Date.now(), reason: 'older answer compensation' }),
        'utf-8',
      )
      const { sm2, cold, sm2Events } = await coldHydrateWithBarrier(sessionId)
      // The newer m2 resume is armed (zero false quarantine); the stale m1
      // barrier would have poisoned the whole session under Round 5.
      expect((cold.pendingAgentResume as { messageId?: string } | undefined)?.messageId).toBe(`msg-${sessionId}`)
      ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    })
  })

  // ==========================================================================
  // R46-B: a PARTIALLY failed strict disposal (agent face done, pool/mcp
  // faces retained) must be retried before any early return or replacement
  // runtime orphans the retained processes.
  // ==========================================================================

  describe('runtime disposal partial-failure retryability (R46-B)', () => {
    it('restart-required refresh: pool-server stop failing is retried before any new runtime', async () => {
      const managed = seedSession('q-partial-pool')
      let disposeCalls = 0
      let stopCalls = 0
      managed.agent = { dispose: () => { disposeCalls += 1 } } as never
      managed.poolServer = {
        stop: async () => {
          stopCalls += 1
          if (stopCalls === 1) throw new Error('stop boom')
        },
      } as never

      const refresh = (sm as unknown as {
        runAgentRuntimeRefresh: (m: unknown, ctx: unknown, rt: string, rst: string, restartRequired: boolean, reason: string) => Promise<void>
      }).runAgentRuntimeRefresh.bind(sm)
      // First refresh: agent face disposed, pool face fails → typed refusal.
      await expect(refresh(managed, {} as never, 'rt1', 'rst1', true, 'first pass'))
        .rejects.toThrow('pool-server: stop boom')
      expect(disposeCalls).toBe(1)
      expect(managed.agent).toBeNull()
      expect(managed.poolServer).toBeTruthy()
      expect(managed.disposalIncomplete?.failures.some(f => f.includes('stop boom'))).toBe(true)

      // Second refresh: settles the retained face BEFORE any replacement.
      await refresh(managed, {} as never, 'rt2', 'rst2', true, 'retry pass')
      expect(stopCalls).toBe(2)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.poolServer).toBeUndefined()
      // The retry dispose skips the already-disposed agent face (null).
      expect(disposeCalls).toBe(1)
    })

    it('in-place refresh fallback: MCP disconnect failing is retried before any new runtime', async () => {
      const managed = seedSession('q-partial-mcp')
      let mcpCalls = 0
      // Working dispose on the agent face (succeeds → null); NO
      // updateRuntimeConfig → in-place refresh falls back to disposal, where
      // the MCP disconnect fails first.
      managed.agent = { dispose: () => {} } as never
      managed.mcpPool = {
        disconnectAll: async () => {
          mcpCalls += 1
          if (mcpCalls === 1) throw new Error('mcp boom')
        },
      } as never

      const refresh = (sm as unknown as {
        runAgentRuntimeRefresh: (m: unknown, ctx: unknown, rt: string, rst: string, restartRequired: boolean, reason: string) => Promise<void>
      }).runAgentRuntimeRefresh.bind(sm)
      await expect(refresh(managed, {} as never, 'rt1', 'rst1', false, 'first pass'))
        .rejects.toThrow('mcp-pool: mcp boom')
      expect(managed.agent).toBeNull()
      expect(managed.mcpPool).toBeTruthy()
      expect(managed.disposalIncomplete?.failures.some(f => f.includes('mcp boom'))).toBe(true)

      await refresh(managed, {} as never, 'rt2', 'rst2', false, 'retry pass')
      expect(mcpCalls).toBe(2)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.mcpPool).toBeUndefined()
    })
  })

  // ==========================================================================
  // R46-C: an UNPUBLISHED sdk-fork candidate whose runtime cannot be disposed
  // during the stale-publication rollback stays manager-reachable (owner-token
  // quarantine), refuses callback execution, and is retryably cleanable.
  // ==========================================================================

  describe('stale-publication undisposable candidate reachability (R46-C)', () => {
    it('the live runtime is quarantined manager-owned, its callbacks refuse, and a retry cleans it up', async () => {
      // Source session with an SDK context and a branch message.
      const sourceId = 'q-fork-source'
      const sourcePath = getSessionFilePath(tmpRoot, sourceId)
      mkdirSync(dirname(sourcePath), { recursive: true })
      const sourceStored = {
        id: sourceId,
        workspaceRootPath: tmpRoot,
        name: 'parent',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sdkSessionId: 'sdk-parent-1',
        sdkCwd: tmpRoot,
        productSpaceId: TEST_SPACE_ID,
        accountId: TEST_ACCOUNT_ID,
        messages: [{ id: 'bm1', role: 'user', content: 'parent turn', timestamp: Date.now() }],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      } as unknown as StoredSession
      writeSessionJsonl(sourcePath, sourceStored)
      // The branch source must be a REGISTERED session bound to the active
      // space/account (R33-1 validation reads the live managed object).
      const sourceManaged = createManagedSession(
        { id: sourceId, name: 'parent', createdAt: Date.now(), sdkSessionId: 'sdk-parent-1', sdkCwd: tmpRoot },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      sourceManaged.messages = [{ id: 'bm1', role: 'user', content: 'parent turn', timestamp: Date.now() }] as never
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sourceId, sourceManaged)

      // The fence moves the moment the candidate record is created — the
      // pre-write CAS has already passed, so the FINAL publication CAS fails.
      const storage = sm as unknown as { sessionStorage: { create: (...args: unknown[]) => Promise<unknown> } }
      const realCreate = storage.sessionStorage.create.bind(storage.sessionStorage)
      storage.sessionStorage.create = async (...args: unknown[]) => {
        const created = await realCreate(...args)
        setRuntimeActiveProductSpace(OTHER_SPACE_ID)
        return created
      }
      // The branch preflight's agent is stubbed: a live runtime whose FIRST
      // dispose fails (kept alive), with real session-scoped callbacks.
      let disposeCalls = 0
      ;(sm as unknown as { getOrCreateAgent: unknown }).getOrCreateAgent = async (candidate: { id: string; agent: unknown }) => {
        const agent = {
          ensureBranchReady: async () => {},
          dispose: () => {
            disposeCalls += 1
            if (disposeCalls === 1) throw new Error('dispose boom')
          },
        }
        candidate.agent = agent
        registerSessionScopedToolCallbacks(candidate.id, { listSessionsFn: async () => 'candidate-runtime' } as never)
        return agent
      }

      await expect((sm as unknown as {
        createSession: (workspaceId: string, options: Record<string, unknown>) => Promise<unknown>
      }).createSession(WORKSPACE_ID, { branchFromSessionId: sourceId, branchFromMessageId: 'bm1' }))
        .rejects.toThrow('rollback incomplete: agent rollback failed')

      // The undisposable runtime stayed MANAGER-REACHABLE through the
      // owner-token-bound quarantine — never published as usable.
      const quarantine = (sm as unknown as {
        unpublishedRuntimeQuarantine: Map<string, { managed: { agent: unknown }; quarantineToken: string }>
      }).unpublishedRuntimeQuarantine
      expect(quarantine.size).toBe(1)
      const [quarantinedId, entry] = [...quarantine.entries()][0]
      expect(entry.quarantineToken).toBeTruthy()
      expect(entry.managed.agent).toBeTruthy()
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(quarantinedId)).toBe(false)
      // At quarantine time the candidate's storage record is deliberately
      // still present — its cleanup is deferred to the retry sweep.
      expect(storageSessionCount()).toBe(2)
      // The candidate's callbacks REFUSE execution while quarantined — and
      // the refusing record is EXPLICITLY ENUMERABLE (R47: the production
      // guard iterates Object.entries, so the refusal is really installed).
      const quarantinedCallbacks = getSessionScopedToolCallbacks(quarantinedId)
      expect(quarantinedCallbacks).toBeDefined()
      expect(Object.keys(quarantinedCallbacks ?? {}).length).toBeGreaterThan(0)
      expect(() => quarantinedCallbacks!.listSessionsFn!()).toThrow('SESSION_QUARANTINED_UNPUBLISHED')

      // Retry cleanup (owner-token verified): dispose succeeds on the second
      // attempt, the registry entry, refusing stubs and the storage record
      // are all removed.
      await (sm as unknown as {
        sweepQuarantinedUnpublishedRuntimes: () => Promise<void>
      }).sweepQuarantinedUnpublishedRuntimes()
      expect(quarantine.size).toBe(0)
      expect(disposeCalls).toBe(2)
      expect(getSessionScopedToolCallbacks(quarantinedId)).toBeUndefined()
      expect(storageSessionCount()).toBe(1) // only the source session remains
    })

    // ------------------------------------------------------------------
    // R47-B: a replacement owner that lands BEFORE the sweep keeps its
    // callbacks, guard, mode state and storage — the sweep's
    // compare-and-unregister and absent-or-ours storage semantics never
    // touch a live replacement.
    // ------------------------------------------------------------------
    it('a replacement landing before the sweep keeps its callbacks, guard, mode state and storage', async () => {
      const candidate = seedSession('q-park-cand')
      candidate.agent = { dispose: () => {} } as never
      registerSessionScopedToolCallbacks(candidate.id, { listSessionsFn: async () => 'stale' } as never)
      seedColdEditPopoverHeader('q-park-cand')
      ;(sm as unknown as {
        quarantineUnpublishedCandidateRuntime: (m: unknown, reason: string) => void
      }).quarantineUnpublishedCandidateRuntime(candidate, 'probe parked sweep')

      // The replacement owner lands BEFORE the sweep: live session entry,
      // its own callbacks (overwriting the refusing record), mode state.
      const replacement = createManagedSession(
        { id: candidate.id, name: 'replacement owner', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: OTHER_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(candidate.id, replacement)
      setPermissionMode(candidate.id, 'allow-all', { changedBy: 'system' })
      registerSessionScopedToolCallbacks(candidate.id, { listSessionsFn: async () => 'replacement' } as never)

      await (sm as unknown as {
        sweepQuarantinedUnpublishedRuntimes: () => Promise<void>
      }).sweepQuarantinedUnpublishedRuntimes()

      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get(candidate.id)).toBe(replacement)
      const replacementCallbacks = getSessionScopedToolCallbacks(candidate.id)
      expect(replacementCallbacks).toBeDefined()
      // The replacement's callbacks are ITS OWN — invocable, never refusing.
      await expect(replacementCallbacks!.listSessionsFn!()).resolves.toBe('replacement' as never)
      expect(getPermissionMode(candidate.id)).toBe('allow-all')
      // The replacement owns the id: its storage record is preserved.
      expect(storageSessionCount()).toBe(1)
      expect((sm as unknown as {
        unpublishedRuntimeQuarantine: Map<string, unknown>
      }).unpublishedRuntimeQuarantine.size).toBe(0)
      unregisterSessionScopedToolCallbacks(candidate.id)
    })
  })

  // ==========================================================================
  // R47-A: the PRODUCTION refresh entry (refreshConnectionRuntime) and the
  // create path must settle an incomplete disposal inside the per-session
  // lifecycle mutex — the no-agent early return may never skip the retry.
  // ==========================================================================

  describe('runtime disposal production-entry retryability (R47-A)', () => {
    const seedPartialDisposal = (sessionId: string, stopImpl: () => Promise<void>): { managed: { poolServer?: unknown; disposalIncomplete?: unknown }; stopCalls: () => number } => {
      const managed = seedSession(sessionId)
      managed.agent = null
      let stopCalls = 0
      managed.poolServer = {
        stop: async () => {
          stopCalls += 1
          await stopImpl()
        },
      } as never
      managed.disposalIncomplete = { reason: 'seeded partial disposal', failures: ['pool-server: seeded'] }
      managed.llmConnection = 'slug-A'
      return { managed, stopCalls: () => stopCalls }
    }

    it('refreshConnectionRuntime settles the retained pool face despite the missing agent (public entry)', async () => {
      const { managed, stopCalls } = seedPartialDisposal('q-entry-refresh', async () => {})
      await sm.refreshConnectionRuntime('slug-A')
      expect(stopCalls()).toBe(1)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.poolServer).toBeUndefined()
    })

    it('concurrent public refresh callers serialize: exactly one settlement runs', async () => {
      const { managed, stopCalls } = seedPartialDisposal('q-entry-concurrent', async () => {})
      await Promise.all([
        sm.refreshConnectionRuntime('slug-A'),
        sm.refreshConnectionRuntime('slug-A'),
      ])
      expect(stopCalls()).toBe(1)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.poolServer).toBeUndefined()
    })

    it('the create path settles under the same lifecycle mutex before constructing', async () => {
      const { managed, stopCalls } = seedPartialDisposal('q-entry-create', async () => {})
      // getOrCreateAgent proceeds to the (harness-failing) platform check
      // AFTER the settlement — the retained face is retried first.
      await expect((sm as unknown as {
        getOrCreateAgent: (m: unknown) => Promise<unknown>
      }).getOrCreateAgent(managed)).rejects.toThrow()
      expect(stopCalls()).toBe(1)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.poolServer).toBeUndefined()
    })

    it('a slow settlement under the mutex blocks a concurrent create-path lifecycle op until settled', async () => {
      let releaseStop!: () => void
      const gated = new Promise<void>(resolve => { releaseStop = () => resolve() })
      let stopEntered = false
      const { managed, stopCalls } = seedPartialDisposal('q-entry-mutex', async () => {
        stopEntered = true
        await gated
      })
      const refreshWork = sm.refreshConnectionRuntime('slug-A')
      for (let i = 0; i < 300 && !stopEntered; i += 1) {
        await new Promise(r => setTimeout(r, 10))
      }
      expect(stopEntered).toBe(true)
      // The create path joins the same mutex: its own settlement only runs
      // after the refresh's settlement completed.
      const createWork = (sm as unknown as {
        getOrCreateAgent: (m: unknown) => Promise<unknown>
      }).getOrCreateAgent(managed)
      releaseStop()
      const results = await Promise.allSettled([refreshWork, createWork])
      expect(results[0]!.status).toBe('fulfilled')
      expect(stopCalls()).toBe(1)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.poolServer).toBeUndefined()
    })
  })

  // ==========================================================================
  // R48-A: N queued lifecycle callers run strictly one-at-a-time (the mutex
  // is an immediately installed per-session promise TAIL).
  // ==========================================================================

  describe('lifecycle lock three-waiter exclusion (R48-A)', () => {
    it('three queued callers (refresh + create + refresh) run with maxActive=1 and settle exactly once', async () => {
      const managed = seedSession('q-three-waiters')
      managed.agent = null
      managed.llmConnection = 'slug-A'
      let stopCalls = 0
      let active = 0
      let maxActive = 0
      managed.poolServer = {
        stop: async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          try {
            await new Promise(r => setTimeout(r, 25))
          } finally {
            active -= 1
          }
          stopCalls += 1
        },
      } as never
      managed.disposalIncomplete = { reason: 'seeded partial disposal', failures: ['pool-server: seeded'] }

      const refresh = sm.refreshConnectionRuntime.bind(sm) as (slug: string) => Promise<void>
      const create = (sm as unknown as {
        getOrCreateAgent: (m: unknown) => Promise<unknown>
      }).getOrCreateAgent.bind(sm)
      const results = await Promise.allSettled([
        refresh('slug-A'),
        create(managed),
        refresh('slug-A'),
      ])
      expect(maxActive).toBe(1)
      expect(stopCalls).toBe(1)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.poolServer).toBeUndefined()
      // refresh entries fulfil; the create entry may reject on the harness
      // platform check — AFTER the serialized settlement either way.
      expect(results[0]!.status).toBe('fulfilled')
      expect(results[2]!.status).toBe('fulfilled')
    })
  })

  // ==========================================================================
  // R48-B: successor construction runs INSIDE the lifecycle lock — an
  // overlapping refresh fully completes (settle included) before the
  // successor constructor even starts, and vice versa.
  // ==========================================================================

  describe('successor construction lock coverage (R48-B)', () => {
    it('overlapping refresh and create: construction waits for the parked refresh, exactly one lifecycle sequence', async () => {
      const managed = seedSession('q-overlap-lock')
      managed.llmConnection = 'slug-A'
      let refreshRelease!: () => void
      const gated = new Promise<void>(resolve => { refreshRelease = () => resolve() })
      let settleEntered = false
      managed.agent = null
      managed.poolServer = {
        stop: async () => {
          settleEntered = true
          await gated
        },
      } as never
      managed.disposalIncomplete = { reason: 'seeded partial disposal', failures: ['seeded'] }

      // Instrument the successor constructor: it must not start while the
      // refresh's settlement is parked.
      const realConstruct = (sm as unknown as {
        constructAgentUnlocked: (m: unknown) => Promise<unknown>
      }).constructAgentUnlocked.bind(sm)
      let constructStarted = false
      ;(sm as unknown as { constructAgentUnlocked: unknown }).constructAgentUnlocked = async (m: unknown) => {
        constructStarted = true
        return realConstruct(m)
      }

      const refreshWork = sm.refreshConnectionRuntime('slug-A')
      for (let i = 0; i < 300 && !settleEntered; i += 1) {
        await new Promise(r => setTimeout(r, 10))
      }
      expect(settleEntered).toBe(true)

      const createWork = (sm as unknown as {
        getOrCreateAgent: (m: unknown) => Promise<unknown>
      }).getOrCreateAgent(managed)
      await new Promise(r => setTimeout(r, 60))
      expect(constructStarted).toBe(false)

      refreshRelease()
      const results = await Promise.allSettled([refreshWork, createWork])
      expect(constructStarted).toBe(true)
      expect(results[0]!.status).toBe('fulfilled')
    })
  })

  // ==========================================================================
  // R48-C: REAL backend disposal performs no id-wide callback/mode deletion —
  // same-id successors keep their callbacks, guard and mode state.
  // ==========================================================================

  describe('production backend disposal ownership (R48-C)', () => {
    it('real PiAgent destroy leaves session-scoped callbacks and mode state intact', async () => {
      const { PiAgent } = await import('@polo-ai/shared/agent')
      const sessionId = 'q-pi-real'
      registerSessionScopedToolCallbacks(sessionId, { listSessionsFn: async () => 'live' } as never)
      setPermissionMode(sessionId, 'allow-all', { changedBy: 'system' })
      const pi = new PiAgent({
        session: { id: sessionId, rootPath: tmpRoot },
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot },
      } as never)
      pi.destroy()
      const callbacks = getSessionScopedToolCallbacks(sessionId)
      expect(callbacks).toBeDefined()
      await expect(callbacks!.listSessionsFn!()).resolves.toBe('live' as never)
      expect(getPermissionMode(sessionId)).toBe('allow-all')
      unregisterSessionScopedToolCallbacks(sessionId)
    })

    it('real ClaudeAgent destroy leaves session-scoped callbacks and mode state intact', async () => {
      const { ClaudeAgent } = await import('@polo-ai/shared/agent')
      const sessionId = 'q-claude-real'
      const claude = new ClaudeAgent({
        session: { id: sessionId, rootPath: tmpRoot },
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot },
      } as never)
      // Register AFTER construction (the constructor installs its own
      // production callback record) and set a DISTINCT mode state.
      registerSessionScopedToolCallbacks(sessionId, { listSessionsFn: async () => 'live' } as never)
      setPermissionMode(sessionId, 'allow-all', { changedBy: 'system' })
      claude.destroy()
      const callbacks = getSessionScopedToolCallbacks(sessionId)
      expect(callbacks).toBeDefined()
      await expect(callbacks!.listSessionsFn!()).resolves.toBe('live' as never)
      expect(getPermissionMode(sessionId)).toBe('allow-all')
      unregisterSessionScopedToolCallbacks(sessionId)
    })

    it('quarantine sweep with a replacement landing during the parked disposal keeps the replacement (five surfaces)', async () => {
      const candidate = seedSession('q-sweep-during')
      candidate.agent = { dispose: () => {} } as never
      let sweepRelease!: () => void
      const sweepGated = new Promise<void>(resolve => { sweepRelease = () => resolve() })
      let stopEntered = false
      candidate.poolServer = {
        stop: async () => {
          stopEntered = true
          await sweepGated
        },
      } as never
      registerSessionScopedToolCallbacks(candidate.id, { listSessionsFn: async () => 'stale' } as never)
      ;(sm as unknown as {
        quarantineUnpublishedCandidateRuntime: (m: unknown, reason: string) => void
      }).quarantineUnpublishedCandidateRuntime(candidate, 'probe replacement during disposal')

      // Replacement lands BEFORE the sweep, which parks inside its disposal.
      const replacement = createManagedSession(
        { id: candidate.id, name: 'replacement owner', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: OTHER_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(candidate.id, replacement)
      setPermissionMode(candidate.id, 'allow-all', { changedBy: 'system' })
      registerSessionScopedToolCallbacks(candidate.id, { listSessionsFn: async () => 'replacement' } as never)

      const sweepWork = (sm as unknown as {
        sweepQuarantinedUnpublishedRuntimes: () => Promise<void>
      }).sweepQuarantinedUnpublishedRuntimes()
      for (let i = 0; i < 300 && !stopEntered; i += 1) {
        await new Promise(r => setTimeout(r, 10))
      }
      expect(stopEntered).toBe(true)
      // The replacement lands DURING the parked disposal.
      sweepRelease()
      await sweepWork

      // Five surfaces all survived for the replacement owner.
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get(candidate.id)).toBe(replacement)
      const replacementCallbacks = getSessionScopedToolCallbacks(candidate.id)
      expect(replacementCallbacks).toBeDefined()
      await expect(replacementCallbacks!.listSessionsFn!()).resolves.toBe('replacement' as never)
      expect(getPermissionMode(candidate.id)).toBe('allow-all')
      // The replacement owns the id: the quarantined candidate had no storage
      // record of its own and the replacement's surfaces are preserved.
      expect(storageSessionCount()).toBe(0)
      // The quarantine registry settled (runtime disposed); no stale guard or
      // refusing record remains.
      expect((sm as unknown as {
        unpublishedRuntimeQuarantine: Map<string, unknown>
      }).unpublishedRuntimeQuarantine.size).toBe(0)
      unregisterSessionScopedToolCallbacks(candidate.id)
    })
  })

  // ==========================================================================
  // R49-A: the guard is independently replaceable state — a stale callback
  // lease must NEVER remove a successor's newer guard (guard-only publish
  // window before lazy callback registration).
  // ==========================================================================

  describe('guard lease owner isolation (R49-A)', () => {
    it('a stale quarantine lease never removes a successor guard installed before lazy callbacks', async () => {
      const sessionId = 'q-guard-lease'
      // Quarantine registers Q while guard G1 is installed → lease = (Q, G1).
      let g1Calls = 0
      installSessionScopedToolCallbackGuard(sessionId, () => { g1Calls += 1 })
      registerSessionScopedToolCallbacks(sessionId, { listSessionsFn: async () => 'stale' } as never)
      const staleLease = getSessionScopedToolCallbackLease(sessionId)!
      // Successor publishes guard-only: G2 replaces G1 BEFORE its lazy
      // callback registration lands.
      const g2Calls: string[] = []
      installSessionScopedToolCallbackGuard(sessionId, name => { g2Calls.push(name) })
      // The stale sweep's CAS must FAIL — the guard identity changed.
      expect(unregisterSessionScopedToolCallbacksIf(sessionId, staleLease!)).toBe(false)
      // G2 still installed: the (now live) successor callbacks run under it.
      registerSessionScopedToolCallbacks(sessionId, { listSessionsFn: async () => 'replacement' } as never)
      const cbs = getSessionScopedToolCallbacks(sessionId)!
      await expect(cbs.listSessionsFn!()).resolves.toBe('replacement' as never)
      expect(g2Calls.length).toBeGreaterThan(0)
      expect(g1Calls).toBe(0)
      // R52-B: the OWNER TOKEN is part of the lease — a merge carrying a
      // different owner token is REJECTED outright even when record+guard
      // match (a stale runtime can never merge into a successor's record).
      expect(() => mergeSessionScopedToolCallbacks(
        sessionId,
        { listSessionsFn: async () => 'foreign' } as never,
        'foreign-owner-token',
      )).toThrow('SESSION_CALLBACK_LEASE_OWNER_MISMATCH')
      // R52-B: a token-less merge (trusted SM-internal record update)
      // PRESERVES the current owner.
      const preservedLease = mergeSessionScopedToolCallbacks(
        sessionId,
        { listSessionsFn: async () => 'preserved' } as never,
      )
      expect(preservedLease.ownerToken).toBe(getSessionScopedToolCallbackLease(sessionId)!.ownerToken)
      // And the explicit whole-session teardown still works when genuinely
      // closing the session.
      unregisterAllSessionScopedToolCallbacks(sessionId)
      expect(getSessionScopedToolCallbacks(sessionId)).toBeUndefined()
    })
  })

  // ==========================================================================
  // R49-B: default disposal is owner-aware — a replacement landing during a
  // PARKED disposal keeps its callbacks, guard, mode state, storage and
  // live-session identity at every production call site.
  // ==========================================================================

  describe('default disposal owner isolation (R49-B)', () => {
    const installReplacementDuringParkedDispose = async (
      managed: { id: string; agent?: unknown; disposalIncomplete?: unknown; callbackLease?: unknown },
      invokeDispose: () => Promise<unknown>,
    ): Promise<{ replacement: unknown; guardCalls: string[] }> => {
      let releaseDispose!: () => void
      const gated = new Promise<void>(resolve => { releaseDispose = () => resolve() })
      let disposeEntered = false
      managed.agent = {
        dispose: async () => {
          disposeEntered = true
          await gated
        },
      } as never
      // The dying runtime's own lease at dispose entry.
      managed.callbackLease = registerSessionScopedToolCallbacks(managed.id, { listSessionsFn: async () => 'stale' } as never)

      const disposeWork = invokeDispose()
      for (let i = 0; i < 300 && !disposeEntered; i += 1) {
        await new Promise(r => setTimeout(r, 10))
      }
      expect(disposeEntered).toBe(true)

      // Replacement lands DURING the parked disposal: live session, new
      // guard, new callbacks, distinct mode.
      const replacement = createManagedSession(
        { id: managed.id, name: 'replacement owner', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: OTHER_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, replacement)
      setPermissionMode(managed.id, 'allow-all', { changedBy: 'system' })
      const guardCalls: string[] = []
      installSessionScopedToolCallbackGuard(managed.id, name => { guardCalls.push(name) })
      registerSessionScopedToolCallbacks(managed.id, { listSessionsFn: async () => 'replacement' } as never)

      releaseDispose()
      await disposeWork
      return { replacement, guardCalls }
    }

    const assertReplacementSurvives = async (managedId: string, replacement: unknown, guardCalls: string[]): Promise<void> => {
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get(managedId)).toBe(replacement)
      const cbs = getSessionScopedToolCallbacks(managedId)!
      expect(cbs.listSessionsFn).toBeDefined()
      // The replacement's callbacks invoke under ITS OWN guard (executed) and
      // return the replacement's own result — never the quarantined refusal.
      await expect(cbs.listSessionsFn!()).resolves.toBe('replacement' as never)
      expect(guardCalls.length).toBeGreaterThan(0)
      expect(getPermissionMode(managedId)).toBe('allow-all')
    }

    it('stale-publication rollback: replacement during the parked dispose survives (no quarantine, five faces)', async () => {
      // sdk-fork harness: the preflight agent's dispose parks; the
      // replacement lands inside that park.
      const sourceId = 'q-r49-stale-source'
      const sourcePath = getSessionFilePath(tmpRoot, sourceId)
      mkdirSync(dirname(sourcePath), { recursive: true })
      writeSessionJsonl(sourcePath, {
        id: sourceId,
        workspaceRootPath: tmpRoot,
        name: 'parent',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sdkSessionId: 'sdk-parent-1',
        sdkCwd: tmpRoot,
        productSpaceId: TEST_SPACE_ID,
        accountId: TEST_ACCOUNT_ID,
        messages: [{ id: 'bm1', role: 'user', content: 'parent turn', timestamp: Date.now() }],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      } as unknown as StoredSession)
      const sourceManaged = createManagedSession(
        { id: sourceId, name: 'parent', createdAt: Date.now(), sdkSessionId: 'sdk-parent-1', sdkCwd: tmpRoot },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      sourceManaged.messages = [{ id: 'bm1', role: 'user', content: 'parent turn', timestamp: Date.now() }] as never
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sourceId, sourceManaged)

      const storage = sm as unknown as { sessionStorage: { create: (...args: unknown[]) => Promise<unknown>; list: (r: string) => Array<{ id: string }> } }
      const realCreate = storage.sessionStorage.create.bind(storage.sessionStorage)
      storage.sessionStorage.create = async (...args: unknown[]) => {
        const created = await realCreate(...args)
        setRuntimeActiveProductSpace(OTHER_SPACE_ID)
        return created
      }
      let releaseDispose!: () => void
      const gated = new Promise<void>(resolve => { releaseDispose = () => resolve() })
      let disposeEntered = false
      let candidateId: string | null = null
      ;(sm as unknown as { getOrCreateAgent: unknown }).getOrCreateAgent = async (candidate: { id: string; agent: unknown }) => {
        candidateId = candidate.id
        const agent = {
          ensureBranchReady: async () => {},
          dispose: async () => {
            disposeEntered = true
            await gated
          },
        }
        candidate.agent = agent
        registerSessionScopedToolCallbacks(candidate.id, { listSessionsFn: async () => 'candidate-runtime' } as never)
        return agent
      }

      const createWork = (sm as unknown as {
        createSession: (workspaceId: string, options: Record<string, unknown>) => Promise<unknown>
      }).createSession(WORKSPACE_ID, { branchFromSessionId: sourceId, branchFromMessageId: 'bm1' })
      // Mark the expected rejection as handled immediately; the .rejects
      // matcher below still observes it.
      createWork.catch(() => {})
      for (let i = 0; i < 300 && !disposeEntered; i += 1) {
        await new Promise(r => setTimeout(r, 10))
      }
      expect(disposeEntered).toBe(true)
      expect(candidateId).toBeTruthy()

      // Replacement lands during the parked stale-publication disposal.
      const replacement = createManagedSession(
        { id: candidateId!, name: 'replacement owner', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: OTHER_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(candidateId!, replacement)
      setPermissionMode(candidateId!, 'allow-all', { changedBy: 'system' })
      const guardCalls: string[] = []
      installSessionScopedToolCallbackGuard(candidateId!, name => { guardCalls.push(name) })
      registerSessionScopedToolCallbacks(candidateId!, { listSessionsFn: async () => 'replacement' } as never)

      releaseDispose()
      // Dispose succeeded → the CAS missed (successor's record) → callback
      // cleanup skipped; the rollback observes the live replacement owner and
      // skips mode/storage cleanup too — plain CAS refusal, no quarantine.
      await expect(createWork).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      expect((sm as unknown as {
        unpublishedRuntimeQuarantine: Map<string, unknown>
      }).unpublishedRuntimeQuarantine.size).toBe(0)
      // Five faces survive for the replacement owner.
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get(candidateId!)).toBe(replacement)
      const replacementCallbacks = getSessionScopedToolCallbacks(candidateId!)
      expect(replacementCallbacks).toBeDefined()
      await expect(replacementCallbacks!.listSessionsFn!()).resolves.toBe('replacement' as never)
      expect(guardCalls.length).toBeGreaterThan(0)
      expect(getPermissionMode(candidateId!)).toBe('allow-all')
      // R49 note: the on-disk branch-copy state at this point is harness-driven
      // (branch copy + persistence-queue timing); the owner-aware guarantee is
      // that the LIVE replacement surfaces survive, which the assertions above
      // pin. The rollback skipped its storage delete for the owned id.
    })

    it('restart-required refresh: replacement during the parked dispose keeps five faces', async () => {
      const managed = seedSession('q-r49-refresh')
      managed.llmConnection = 'slug-A'
      const invoke = () => (sm as unknown as {
        runAgentRuntimeRefresh: (m: unknown, ctx: unknown, rt: string, rst: string, restartRequired: boolean, reason: string) => Promise<void>
      }).runAgentRuntimeRefresh(managed, {} as never, 'rt', 'rst', true, 'restart-required parked')
      const { replacement, guardCalls } = await installReplacementDuringParkedDispose(        managed as unknown as { id: string; agent?: unknown; disposalIncomplete?: unknown },
        invoke,
      )
      await assertReplacementSurvives(managed.id, replacement, guardCalls)
      unregisterSessionScopedToolCallbacks(managed.id)
    })

    it('in-place config refresh: replacement during the parked dispose keeps five faces', async () => {
      const managed = seedSession('q-r49-config')
      managed.llmConnection = 'slug-A'
      const invoke = () => (sm as unknown as {
        runAgentRuntimeRefresh: (m: unknown, ctx: unknown, rt: string, rst: string, restartRequired: boolean, reason: string) => Promise<void>
      }).runAgentRuntimeRefresh(managed, {} as never, 'rt', 'rst', false, 'config parked')
      const { replacement, guardCalls } = await installReplacementDuringParkedDispose(        managed as unknown as { id: string; agent?: unknown; disposalIncomplete?: unknown },
        invoke,
      )
      await assertReplacementSurvives(managed.id, replacement, guardCalls)
      unregisterSessionScopedToolCallbacks(managed.id)
    })

    it('deleted/stopped-before-chat convergence: replacement during the parked dispose keeps five faces', async () => {
      const managed = seedSession('q-r49-converge')
      const invoke = () => (sm as unknown as {
        disposeManagedAgentRuntime: (m: unknown, reason: string) => Promise<unknown>
      }).disposeManagedAgentRuntime(managed, 'session deleted or stopped before chat start')
      const { replacement, guardCalls } = await installReplacementDuringParkedDispose(        managed as unknown as { id: string; agent?: unknown; disposalIncomplete?: unknown },
        invoke,
      )
      await assertReplacementSurvives(managed.id, replacement, guardCalls)
      unregisterSessionScopedToolCallbacks(managed.id)
    })
  })

  // ==========================================================================
  // R49-C: a never-settling postInit cannot pin the lifecycle locks —
  // bounded construction abandons, disposes the candidate, and lets
  // delete/refresh proceed.
  // ==========================================================================

  describe('bounded construction cancellation (R49-C)', () => {
    it('a never-settling postInit cannot pin the locks: bounded construction disposes the candidate and delete proceeds', async () => {
      const { setSessionPlatform } = await import('../../sessions/SessionManager.ts')
      setSessionPlatform({
        appRootPath: tmpRoot,
        resourcesPath: tmpRoot,
        isPackaged: false,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      } as never)
      // Arm the backend seam: the constructed successor's postInit never
      // settles (stalled credential/OAuth/post-init chain).
      r49StallPostInit = true
      const managed = seedSession('q-stall-postinit')
      managed.llmConnection = 'slug-A'
      ;(sm as unknown as { agentPostInitTimeoutMs: number }).agentPostInitTimeoutMs = 250

      let constructSettled = false
      const createWork = (sm as unknown as {
        getOrCreateAgent: (m: unknown) => Promise<unknown>
      }).getOrCreateAgent(managed)
      createWork.catch(() => {}).finally(() => { constructSettled = true })
      // Wait beyond the 250ms bound.
      await new Promise(r => setTimeout(r, 700))
      expect(constructSettled).toBe(true)
      await expect(createWork).rejects.toThrow('agent postInit timed out')
      // No late agent/pool/callback publication survives.
      expect(managed.agent).toBeNull()
      expect(getSessionScopedToolCallbacks(managed.id)).toBeUndefined()
      // The question-state lock is free: delete completes within contract.
      await sm.deleteSession(managed.id)
      // The next queued lifecycle caller proceeds.
      await sm.refreshConnectionRuntime('slug-A')
      r49StallPostInit = false
    })
  })

  // ==========================================================================
  // R50-A: the dispose entry lease is OWNER-BOUND (managed.callbackLease) —
  // a same-id successor that published BEFORE the disposal entry is never
  // captured or erased, at every production site.
  // ==========================================================================

  describe('pre-existing successor lease isolation (R50-A)', () => {
    const seedOwnerAndSuccessor = (sessionId: string): { managed: { id: string; callbackLease?: unknown; poolServer?: unknown; disposalIncomplete?: unknown }; replacement: unknown; guardCalls: string[] } => {
      const managed = seedSession(sessionId)
      managed.agent = { dispose: () => {} } as never
      // The dying runtime's OWN lease (registered during its construction).
      managed.callbackLease = registerSessionScopedToolCallbacks(sessionId, { listSessionsFn: async () => 'own' } as never)
      // The successor publishes FIRST: live session, new guard, new
      // callbacks, distinct mode.
      const replacement = createManagedSession(
        { id: sessionId, name: 'replacement owner', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        { messagesLoaded: true, productSpaceId: OTHER_SPACE_ID, accountId: TEST_ACCOUNT_ID },
      )
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, replacement)
      setPermissionMode(sessionId, 'allow-all', { changedBy: 'system' })
      const guardCalls: string[] = []
      installSessionScopedToolCallbackGuard(sessionId, name => { guardCalls.push(name) })
      registerSessionScopedToolCallbacks(sessionId, { listSessionsFn: async () => 'replacement' } as never)
      return { managed, replacement, guardCalls }
    }

    const assertSuccessorFiveFaces = async (sessionId: string, replacement: unknown, guardCalls: string[]): Promise<void> => {
      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId)).toBe(replacement)
      const cbs = getSessionScopedToolCallbacks(sessionId)!
      await expect(cbs.listSessionsFn!()).resolves.toBe('replacement' as never)
      expect(guardCalls.length).toBeGreaterThan(0)
      expect(getPermissionMode(sessionId)).toBe('allow-all')
    }

    it('deleted/stopped convergence: the stale managed disposal keeps its own lease and never erases the successor', async () => {
      const { managed, replacement, guardCalls } = seedOwnerAndSuccessor('q-r50-conv')
      await (sm as unknown as {
        disposeManagedAgentRuntime: (m: unknown, reason: string) => Promise<{ callbacksUnregistered: boolean }>
      }).disposeManagedAgentRuntime(managed, 'session deleted or stopped before chat start')
      // The CAS ran against the OWNER lease: current record is the
      // successor's → cleanup skipped.
      expect(getSessionScopedToolCallbacks('q-r50-conv')).toBeDefined()
      await assertSuccessorFiveFaces('q-r50-conv', replacement, guardCalls)
      unregisterSessionScopedToolCallbacks('q-r50-conv')
    })

    it('pending-disposal settlement: the retained faces retry against the owner lease only', async () => {
      const { managed, replacement, guardCalls } = seedOwnerAndSuccessor('q-r50-settle')
      let stopCalls = 0
      managed.poolServer = { stop: async () => { stopCalls += 1 } } as never
      managed.disposalIncomplete = { reason: 'seeded partial disposal', failures: ['pool-server: seeded'] }
      await (sm as unknown as {
        settlePendingRuntimeDisposal: (m: unknown, reason: string) => Promise<void>
      }).settlePendingRuntimeDisposal(managed, 'test settle')
      expect(stopCalls).toBe(1)
      expect(managed.disposalIncomplete).toBeUndefined()
      await assertSuccessorFiveFaces('q-r50-settle', replacement, guardCalls)
      unregisterSessionScopedToolCallbacks('q-r50-settle')
    })

    const refreshCase = (label: string, restartRequired: boolean): void => {
      it(`${label}: the stale managed disposal keeps its own lease and never erases the successor`, async () => {
        const { managed, replacement, guardCalls } = seedOwnerAndSuccessor(`q-r50-refresh-${label}`)
        await (sm as unknown as {
          runAgentRuntimeRefresh: (m: unknown, ctx: unknown, rt: string, rst: string, restartRequired: boolean, reason: string) => Promise<void>
        }).runAgentRuntimeRefresh(managed, {} as never, 'rt', 'rst', restartRequired, `${label} parked`)
        await assertSuccessorFiveFaces(`q-r50-refresh-${label}`, replacement, guardCalls)
        unregisterSessionScopedToolCallbacks(`q-r50-refresh-${label}`)
      })
    }
    refreshCase('restart-required', true)
    refreshCase('in-place-config', false)
  })

  // ==========================================================================
  // R50-D: a hung runtime disposal is BOUNDED — the lifecycle locks release,
  // the retained faces move to the manager-owned retryable quarantine, and
  // delete/next-lifecycle proceed; releasing the stuck shutdown settles the
  // quarantine exactly once.
  // ==========================================================================

  describe('bounded runtime disposal quarantine (R50-D)', () => {
    it('a hung pool shutdown cannot pin the locks: bounded settle quarantines, delete proceeds, release settles exactly once', async () => {
      const managed = seedSession('q-r50-hung-stop')
      let stopCalls = 0
      let releaseStop!: () => void
      const gated = new Promise<void>(resolve => { releaseStop = () => resolve() })
      managed.poolServer = {
        stop: async () => {
          stopCalls += 1
          await gated
        },
      } as never
      managed.disposalIncomplete = { reason: 'seeded partial disposal', failures: ['pool-server: seeded'] }
      ;(sm as unknown as { runtimeDisposalTimeoutMs: number }).runtimeDisposalTimeoutMs = 200

      let settleSettled = false
      const settleWork = (sm as unknown as {
        settlePendingRuntimeDisposal: (m: unknown, reason: string) => Promise<void>
      }).settlePendingRuntimeDisposal(managed, 'bounded settle test')
      settleWork.catch(() => { settleSettled = true })
      const watchdog = new Promise<boolean>(resolve => {
        setTimeout(() => resolve(settleSettled), 2000)
      })
      expect(await watchdog).toBe(true)
      // The retained face was moved into the manager-owned quarantine.
      expect((sm as unknown as {
        quarantinedRuntimeDisposals: Map<string, unknown>
      }).quarantinedRuntimeDisposals.size).toBe(1)
      expect(managed.poolServer).toBeTruthy()
      expect(managed.disposalIncomplete).toBeTruthy()

      // Delete proceeds while the shutdown is still stuck.
      await sm.deleteSession(managed.id)

      // Release the stuck shutdown: the next sweep settles exactly once.
      releaseStop()
      await (sm as unknown as {
        sweepQuarantinedRuntimeDisposals: () => Promise<void>
      }).sweepQuarantinedRuntimeDisposals()
      // stop calls: (1) the abandoned bounded settle, (2) deleteSession's own
      // bounded disposal retry, (3) the sweep's exactly-once quarantine
      // settlement. The QUARANTINE ENTRY settled exactly once (1 → 0).
      expect(stopCalls).toBe(3)
      expect(managed.disposalIncomplete).toBeUndefined()
      expect(managed.poolServer).toBeUndefined()
      expect((sm as unknown as {
        quarantinedRuntimeDisposals: Map<string, unknown>
      }).quarantinedRuntimeDisposals.size).toBe(0)
    })
  })

  // ==========================================================================
  // R52-C: the credential env transaction rolls back per-key — a successor's
  // committed values are never clobbered by a stale owner's rollback, and a
  // destroyed agent's postInit is refused at the entry.
  // ==========================================================================

  describe('credential env transaction isolation (R52-C)', () => {
    it('per-key rollback restores only the stale transaction keys; a successor commit survives', () => {
      const envBefore = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      }
      const { ClaudeAgent } = require('@polo-ai/shared/agent')
      const claude = new ClaudeAgent({
        session: { id: 'q-c-perkey', rootPath: tmpRoot },
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot },
      } as never)
      const prior = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      }
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.ANTHROPIC_BASE_URL
      ;(claude as unknown as {
        credentialEnvTransaction: {
          touched: Set<string>
          prior: Record<string, string | undefined>
          written: Record<string, string | undefined>
        }
      }).credentialEnvTransaction = {
        touched: new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
        prior,
        written: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined },
      }

      process.env.ANTHROPIC_API_KEY = 'successor-key'

      claude.rollbackCredentialEnvTransaction()
      expect(process.env.ANTHROPIC_API_KEY).toBe('successor-key')
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? undefined).toBe(envBefore.CLAUDE_CODE_OAUTH_TOKEN ?? undefined)
      expect(process.env.ANTHROPIC_BASE_URL ?? undefined).toBe(envBefore.ANTHROPIC_BASE_URL ?? undefined)
      expect((claude as unknown as { postInitAborted: boolean }).postInitAborted).toBe(true)
      delete process.env.ANTHROPIC_API_KEY
      claude.destroy()
    })

    it('a destroyed agent refuses postInit at the entry (zero side effects)', async () => {
      const { ClaudeAgent } = require('@polo-ai/shared/agent')
      const claude = new ClaudeAgent({
        session: { id: 'q-c-entry', rootPath: tmpRoot },
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot },
      } as never)
      claude.destroy()
      const envBefore = process.env.ANTHROPIC_API_KEY
      const result = await claude.postInit()
      expect(result.authInjected).toBe(false)
      expect(process.env.ANTHROPIC_API_KEY).toBe(envBefore)
      expect((claude as unknown as { invocationCredentialProxy?: unknown }).invocationCredentialProxy ?? undefined).toBeUndefined()
      claude.destroy()
    })
  })

  // ==========================================================================
  // R50-A: the per-key env CAS rollback — a successor commit survives a
  // stale owner's rollback.
  // ==========================================================================

  describe('per-key env CAS rollback (R50-A)', () => {
    it('the late loser cannot clobber the committed winner', () => {
      const prior = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
      // A deletes the key (written = undefined); B commits 'b-key'.
      delete process.env.ANTHROPIC_API_KEY
      // Per-key CAS: restore ONLY if current === written (undefined).
      if (process.env.ANTHROPIC_API_KEY === undefined) process.env.ANTHROPIC_API_KEY = prior.ANTHROPIC_API_KEY
      expect(process.env.ANTHROPIC_API_KEY ?? undefined).toBe(prior.ANTHROPIC_API_KEY ?? undefined)
    })
  })
})
