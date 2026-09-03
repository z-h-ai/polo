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
      const result = await (sm as unknown as {
        disposeManagedAgentRuntime: (m: unknown, reason: string, opts?: { bestEffort?: boolean }) => Promise<{ failures: string[]; callbacksUnregistered: boolean }>
      }).disposeManagedAgentRuntime(managed, 'test', { bestEffort: true })
      expect(result.failures.length).toBeGreaterThan(0)
      expect(result.failures.some(f => f.includes('dispose boom'))).toBe(true)
      // The failed reference is deliberately KEPT (never a fake cleanup).
      expect(managed.agent).toBeTruthy()
      expect(result.callbacksUnregistered).toBe(true)
    })
  })

  // ==========================================================================
  // R45-A: the resume-quarantine barrier must be fail-closed on I/O and
  // schema errors, contain path traversal, and be atomic under concurrency.
  // ==========================================================================

  describe('resume-quarantine barrier hardening (R45-A)', () => {
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
      const smX = new (SessionManager as unknown as { new(options: unknown): InstanceType<typeof SessionManager> })({
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() },
      })
      const malicious = '../../outside-quarantine'
      const mX = createManagedSession(
        { id: malicious, name: 'malicious', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        {},
      )
      const barrierPath = (smX as unknown as {
        resumeQuarantineBarrierPath: (root: string, id: string) => string
      }).resumeQuarantineBarrierPath(tmpRoot, malicious)
      const quarantineDir = join(tmpRoot, '.polo-resume-quarantine')
      expect(barrierPath.startsWith(quarantineDir + '/')).toBe(true)
      expect(resolvePath(barrierPath).startsWith(resolvePath(quarantineDir) + '/')).toBe(true)
      expect(barrierPath.includes('..')).toBe(false)
      // Writing a barrier for the malicious id lands INSIDE the directory,
      // keyed by the sha256 digest — nothing escapes the workspace.
      await (smX as unknown as {
        writeResumeQuarantineBarrier: (m: unknown, r: unknown, reason: string) => Promise<void>
      }).writeResumeQuarantineBarrier(mX, { messageId: 'm1', invocationSource: 'desktop' }, 'probe')
      expect(existsSync(barrierPath)).toBe(true)
      expect(existsSync(join(tmpRoot, 'outside-quarantine.json'))).toBe(false)
      expect(await (smX as unknown as {
        isResumeQuarantinedByBarrier: (root: string, id: string, messageId?: string) => Promise<boolean>
      }).isResumeQuarantinedByBarrier(tmpRoot, malicious, 'm1')).toBe(true)
    })

    it('concurrent barrier writers cannot expose partial JSON (atomic private rename)', async () => {
      seedBarrierScenario('q-barr-concurrent')
      const smX = new (SessionManager as unknown as { new(options: unknown): InstanceType<typeof SessionManager> })({
        workspace: { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() },
      })
      const mX = createManagedSession(
        { id: 'q-barr-concurrent', name: 'x', createdAt: Date.now() },
        { id: WORKSPACE_ID, name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
        {},
      )
      const writeBarrier = (smX as unknown as {
        writeResumeQuarantineBarrier: (m: unknown, r: unknown, reason: string) => Promise<void>
      }).writeResumeQuarantineBarrier.bind(smX)
      await Promise.all([
        writeBarrier(mX, { messageId: 'm1', invocationSource: 'desktop' }, 'w1'),
        writeBarrier(mX, { messageId: 'm2', invocationSource: 'desktop' }, 'w2'),
      ])
      // The file at the barrier path is ALWAYS a complete document.
      const parsed = JSON.parse(readFileSync(barrierFileFor('q-barr-concurrent'), 'utf-8')) as { version?: number }
      expect(parsed.version).toBe(1)
      expect(await (smX as unknown as {
        isResumeQuarantinedByBarrier: (root: string, id: string, messageId?: string) => Promise<boolean>
      }).isResumeQuarantinedByBarrier(tmpRoot, 'q-barr-concurrent', 'm1')).toBe(true)
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
})
