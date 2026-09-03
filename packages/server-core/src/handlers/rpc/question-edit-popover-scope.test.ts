import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
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
import { getPermissionMode, setPermissionMode } from '@polo-ai/shared/agent'
import { getSessionScopedToolCallbacks, registerSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '@polo-ai/shared/agent/session-scoped-tool-callback-registry'
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
  })
})
