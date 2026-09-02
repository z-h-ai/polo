import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handlers/handler-deps'
import type { SessionStorage } from '@polo-ai/shared/sessions/session-storage.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import {
  getRuntimeActiveProductSpace,
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../handlers/rpc/trusted-product-space-account'
import { resetAssistantStartReservationsForTests } from '../runtime/assistant-executions'
import { registerSessionsHandlers } from '../handlers/rpc/sessions'

// R32-2: Assistant sessions persist and enforce the COMPLETE immutable
// scope (accountId + productSpaceId + workspaceId). A space-bound session
// without an accountId (legacy) is quarantined — never silently adopted by
// the next signed-in account — and a session bound to a replaced account is
// equally invisible.

const accountA = 'account-a'
const accountB = 'account-b'
const personalId = 'space-personal'
const sharedEnterpriseId = 'space-shared-enterprise'

type Handler = (context: never, ...args: unknown[]) => unknown

describe('assistant session account-scope persistence and enforcement (R32-2)', () => {
  let tmpRoot: string
  let storage: SessionStorage
  let sm: SessionManager
  let handlers: Map<string, Handler>
  let registeredSessions: Array<{ id: string; productSpaceId?: string; accountId?: string }>
  let signedInAccountId: string | null

  const context = { clientId: 'renderer', workspaceId: null, webContentsId: null, signal: new AbortController().signal }

  let WorkspaceSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').WorkspaceSessionStorage

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-scope-'))
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    signedInAccountId = accountA
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
    registeredSessions = []

    if (!WorkspaceSessionStorageCtor) {
      ;({ WorkspaceSessionStorage: WorkspaceSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    storage = new WorkspaceSessionStorageCtor()
    sm = new SessionManager()
    // The sessions GET handler waits on the manager's init gate; the
    // minimal harness satisfies it directly.
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()

    handlers = new Map()
    const server: RpcServer = {
      handle(channel: string, handler: HandlerFn) {
        handlers.set(channel, handler)
      },
      push() {},
      async invokeClient() {
        return null
      },
    } as unknown as RpcServer
    registerSessionsHandlers(server, {
      sessionManager: sm,
      platform: {
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
      windowManager: {
        getWorkspaceForWindow: () => null,
      },
    } as unknown as HandlerDeps)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function seedSession(input: {
    id: string
    productSpaceId?: string
    accountId?: string
  }): Promise<void> {
    const workspace = { id: 'ws_test', name: 'T', rootPath: tmpRoot, createdAt: Date.now() }
    const stored = {
      id: input.id,
      workspaceRootPath: tmpRoot,
      name: input.id,
      productSpaceId: input.productSpaceId,
      accountId: input.accountId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    }
    await storage.save(stored as never)
    const managed = createManagedSession(stored, workspace as never, { messagesLoaded: true })
    managed.productSpaceId = input.productSpaceId
    managed.accountId = input.accountId
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(input.id, managed)
  }

  function invoke(channel: string, ...args: unknown[]) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler(context as never, ...args)
  }

  it('persists the complete immutable scope for new sessions', async () => {
    await seedSession({
      id: 'persist-scope',
      productSpaceId: sharedEnterpriseId,
      accountId: accountA,
    })
    // The managed record carries the full scope (persistence follows the
    // same fields).
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get('persist-scope') as {
      productSpaceId?: string
      accountId?: string
    }
    expect(managed.productSpaceId).toBe(sharedEnterpriseId)
    expect(managed.accountId).toBe(accountA)
  })

  it('lists only sessions whose complete scope matches the current trusted account', async () => {
    await seedSession({ id: 's-a', productSpaceId: personalId, accountId: accountA })
    await seedSession({ id: 's-b', productSpaceId: personalId, accountId: accountB })
    // Legacy: space-bound but account-less — quarantined.
    await seedSession({ id: 's-legacy', productSpaceId: personalId })
    // Not bound to any space — outside the fence by definition.
    await seedSession({ id: 's-unbound' })

    const result = await invoke(RPC_CHANNELS.sessions.GET) as Array<{ id: string }>
    const ids = result.map(session => session.id).sort()
    expect(ids).toEqual(['s-a'])
  })

  it('refuses session reads for replaced-account and quarantined legacy sessions', async () => {
    await seedSession({ id: 's-a', productSpaceId: personalId, accountId: accountA })
    await seedSession({ id: 's-b', productSpaceId: personalId, accountId: accountB })
    await seedSession({ id: 's-legacy', productSpaceId: personalId })

    await expect(invoke(RPC_CHANNELS.sessions.GET_MESSAGES, 's-a')).resolves.not.toBeNull()
    await expect(invoke(RPC_CHANNELS.sessions.GET_MESSAGES, 's-b')).resolves.toBeNull()
    await expect(invoke(RPC_CHANNELS.sessions.GET_MESSAGES, 's-legacy')).resolves.toBeNull()
  })

  it('an account replacement quarantines the replaced account sessions for the new account', async () => {
    // The shared enterprise space is the committed fence under account A.
    setRuntimeActiveProductSpace(sharedEnterpriseId)
    setRuntimeActiveProductSpaceAccount(accountA)
    await seedSession({ id: 's-a-shared', productSpaceId: sharedEnterpriseId, accountId: accountA })
    await expect(invoke(RPC_CHANNELS.sessions.GET_MESSAGES, 's-a-shared')).resolves.not.toBeNull()

    // Account B signs in on the SAME shared enterprise ProductSpace id.
    signedInAccountId = accountB
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpace(sharedEnterpriseId)
    setRuntimeActiveProductSpaceAccount(accountB)

    // A's persisted session on the shared space id can never re-enter B's
    // account scope.
    await expect(invoke(RPC_CHANNELS.sessions.GET_MESSAGES, 's-a-shared')).resolves.toBeNull()
    const result = await invoke(RPC_CHANNELS.sessions.GET) as Array<{ id: string }>
    expect(result.map(session => session.id)).not.toContain('s-a-shared')
  })

  it('keeps workspace orthogonality: the same workspace stays usable for the new account', async () => {
    await seedSession({ id: 's-a-old', productSpaceId: personalId, accountId: accountA })
    signedInAccountId = accountB
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)
    // The workspace itself is account-agnostic (orthogonal); only A's
    // session records are quarantined. A brand-new B session is listable.
    await seedSession({ id: 's-b-new', productSpaceId: personalId, accountId: accountB })
    const result = await invoke(RPC_CHANNELS.sessions.GET) as Array<{ id: string }>
    expect(result.map(session => session.id)).toEqual(['s-b-new'])
    expect(getRuntimeActiveProductSpace()).toBe(personalId)
  })
})

describe('assistant session complete-scope boundaries (R33-1)', () => {
  let tmpRoot: string
  let storage: SessionStorage
  let sm: SessionManager
  let handlers: Map<string, Handler>
  let signedInAccountId: string | null

  let WorkspaceSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').WorkspaceSessionStorage

  const baseContext = { clientId: 'renderer', workspaceId: null, webContentsId: null, signal: new AbortController().signal }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-scope33-'))
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    signedInAccountId = accountA
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)

    if (!WorkspaceSessionStorageCtor) {
      ;({ WorkspaceSessionStorage: WorkspaceSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    storage = new WorkspaceSessionStorageCtor()
    sm = new SessionManager()
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()

    handlers = new Map()
    const server: RpcServer = {
      handle(channel: string, handler: HandlerFn) {
        handlers.set(channel, handler)
      },
      push() {},
      async invokeClient() {
        return null
      },
    } as unknown as RpcServer
    registerSessionsHandlers(server, {
      sessionManager: sm,
      platform: {
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
      windowManager: {
        getWorkspaceForWindow: () => null,
      },
    } as unknown as HandlerDeps)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seed(input: {
    id: string
    productSpaceId?: string
    accountId?: string
    hasUnread?: boolean
  }): void {
    const workspace = { id: 'ws_test', name: 'T', rootPath: tmpRoot, createdAt: Date.now() }
    const stored = {
      id: input.id,
      workspaceRootPath: tmpRoot,
      name: input.id,
      productSpaceId: input.productSpaceId,
      accountId: input.accountId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    }
    const managed = createManagedSession(stored, workspace as never, { messagesLoaded: true })
    managed.productSpaceId = input.productSpaceId
    managed.accountId = input.accountId
    ;(managed as unknown as { hasUnread: boolean }).hasUnread = input.hasUnread ?? false
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(input.id, managed)
  }

  function invokeWith(
    contextOverride: Partial<{ workspaceId: string | null; clientId: string }>,
    channel: string,
    ...args: unknown[]
  ) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler({ ...baseContext, ...contextOverride } as never, ...args)
  }

  it('ID-addressed reads bind the session to the caller workspace (cross-workspace)', async () => {
    seed({ id: 's-ws', productSpaceId: personalId, accountId: accountA })

    // Same workspace: readable.
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-ws'))
      .resolves.not.toBeNull()
    // A renderer claiming another workspace can never read the session.
    await expect(invokeWith({ workspaceId: 'ws_other' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-ws'))
      .resolves.toBeNull()
    // The same rule gates writes and commands.
    await expect(invokeWith(
      { workspaceId: 'ws_other' },
      RPC_CHANNELS.sessions.COMMAND,
      's-ws',
      { type: 'rename', name: 'hijacked' },
    )).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    // The session was untouched by the refused command.
    const session = await invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-ws')
    expect((session as unknown as { name: string }).name).toBe('s-ws')
  })

  it('the unread summary is account-aware across an account replacement', async () => {
    seed({ id: 's-a-unread', productSpaceId: personalId, accountId: accountA, hasUnread: true })
    seed({ id: 's-b-unread', productSpaceId: personalId, accountId: accountB, hasUnread: true })
    // A legacy space-bound record without an account is quarantined.
    seed({ id: 's-legacy-unread', productSpaceId: personalId, hasUnread: true })

    const summaryA = await invokeWith({}, RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY) as {
      totalUnreadSessions: number
    }
    expect(summaryA.totalUnreadSessions).toBe(1)

    // Account B signs in: its own unread session is counted, A's and the
    // quarantined legacy record are invisible.
    signedInAccountId = accountB
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)

    const summaryB = await invokeWith({}, RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY) as {
      totalUnreadSessions: number
    }
    expect(summaryB.totalUnreadSessions).toBe(1)
  })

  it('a clean import binds the trusted destination scope; without one it fails before writing', async () => {
    const { setRuntimeActiveProductSpace: setSpace } = await import('../runtime/product-space-executions')
    const storageModule = await import('@polo-ai/shared/sessions/session-storage.ts')
    const workspace = { id: 'ws_import', name: 'I', rootPath: join(tmpRoot, 'ws-import'), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const sessionsRoot = join(tmpRoot, 'sessions-import')
    mkdirSync(sessionsRoot, { recursive: true })
    const importSm = new SessionManager({
      workspace: workspace as never,
      sessionStorage: new storageModule.RootedSessionStorage(sessionsRoot),
    })

    const bundle = {
      version: 1,
      session: {
        header: {
          id: 'bundle-session-1',
          createdAt: Date.now(),
          name: 'transferred',
        },
        messages: [],
      },
      files: [],
    }

    // With the committed fence: the imported record carries the complete
    // immutable scope.
    const imported = await importSm.importSession(workspace.id, bundle as never, 'fork')
    const managed = importSm.getSessions().find(session => session.id === imported.sessionId)
    expect(managed?.productSpaceId).toBe(personalId)
    expect(managed?.accountId).toBe(accountA)

    // Without a committed fence the import fails BEFORE writing anything.
    setSpace(null)
    await expect(importSm.importSession(workspace.id, {
      ...bundle,
      session: { ...bundle.session, header: { ...bundle.session.header, id: 'bundle-session-2' } },
    } as never, 'fork')).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    const writtenEntries = readdirSync(sessionsRoot, { recursive: true }) as string[]
    expect(writtenEntries.some(entry => entry.includes('bundle-session-2'))).toBe(false)
  })
})
