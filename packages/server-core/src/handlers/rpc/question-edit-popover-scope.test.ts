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

  const seedColdEditPopoverHeader = (sessionId: string) => {
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
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    } as unknown as StoredSession
    writeSessionJsonl(filePath, stored)
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
  })
})
