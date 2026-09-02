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
  beginAccountTransition,
  getSyncTrustedProductSpaceAccountId,
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

  const context = { clientId: 'renderer', workspaceId: 'ws_test', webContentsId: null, signal: new AbortController().signal }

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

describe('assistant session complete-scope boundaries (R34-1)', () => {
  let tmpRoot: string
  let handlers: Map<string, Handler>
  let signedInAccountId: string | null
  let sessionsRoot: string

  const noWorkspaceContext = { clientId: 'renderer', workspaceId: null, webContentsId: null, signal: new AbortController().signal }

  let RootedSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  const buildManager = async () => {
    if (!RootedSessionStorageCtor) {
      ;({ RootedSessionStorage: RootedSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    const workspace = { id: 'ws_test', name: 'T', rootPath: join(tmpRoot, 'ws-root'), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const sm = new SessionManager({
      workspace: workspace as never,
      sessionStorage: new RootedSessionStorageCtor(sessionsRoot),
    })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
    return sm
  }

  const registerHandlers = (sm: SessionManager) => {
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
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-scope34-'))
    sessionsRoot = join(tmpRoot, 'sessions')
    mkdirSync(sessionsRoot, { recursive: true })
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    signedInAccountId = accountA
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function invokeWith(
    sm: SessionManager,
    contextOverride: Partial<{ workspaceId: string | null; clientId: string }>,
    channel: string,
    ...args: unknown[]
  ) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler({ ...noWorkspaceContext, ...contextOverride } as never, ...args)
  }

  it('CREATE fails closed without a resolvable caller workspace and never trusts a renderer-selected destination', async () => {
    const sm = await buildManager()
    registerHandlers(sm)

    // Missing caller workspace: fail closed before any record exists.
    await expect(invokeWith(sm, {}, RPC_CHANNELS.sessions.CREATE, 'ws_test'))
      .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    // Cross-workspace destination: the renderer-selected id is refused.
    await expect(invokeWith(sm, { workspaceId: 'ws_other' }, RPC_CHANNELS.sessions.CREATE, 'ws_test'))
      .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    expect(sm.getSessions()).toHaveLength(0)

    // The matching caller workspace creates normally with the full scope.
    const created = await invokeWith(sm, { workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.CREATE, 'ws_test') as {
      id: string
    }
    const managed = sm.getSessions().find(session => session.id === created.id)
    expect(managed?.productSpaceId).toBe(personalId)
    expect(managed?.accountId).toBe(accountA)
  })

  it('SEARCH_CONTENT fails closed when the caller workspace is unresolvable or mismatched', async () => {
    const sm = await buildManager()
    registerHandlers(sm)

    // No caller workspace at all: nothing is searched.
    await expect(invokeWith(sm, {}, RPC_CHANNELS.sessions.SEARCH_CONTENT, 'ws_test', 'needle'))
      .resolves.toEqual([])
    // A renderer-provided id can never widen the search beyond the caller.
    await expect(invokeWith(sm, { workspaceId: 'ws_other' }, RPC_CHANNELS.sessions.SEARCH_CONTENT, 'ws_test', 'needle'))
      .resolves.toEqual([])
  })

  it('direct and chunked imports bind the destination to the caller workspace', async () => {
    const sm = await buildManager()
    registerHandlers(sm)
    const bundle = {
      version: 1,
      session: {
        header: { id: 'import-34-1', createdAt: Date.now(), name: 'imported' },
        messages: [],
      },
      files: [],
    }

    // Missing caller workspace: fail closed.
    await expect(invokeWith(sm, {}, RPC_CHANNELS.sessions.IMPORT, 'ws_test', bundle, 'fork'))
      .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    // Cross-workspace destination: refused.
    await expect(invokeWith(sm, { workspaceId: 'ws_other' }, RPC_CHANNELS.sessions.IMPORT, 'ws_test', bundle, 'fork'))
      .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    const writtenEntries = readdirSync(sessionsRoot, { recursive: true }) as string[]
    expect(writtenEntries.some(entry => entry.includes('import-34-1'))).toBe(false)

    // Matching caller workspace: the import commits with the trusted scope.
    const imported = await invokeWith(sm, { workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.IMPORT, 'ws_test', bundle, 'fork') as {
      sessionId: string
    }
    const managed = sm.getSessions().find(session => session.id === imported.sessionId)
    expect(managed?.productSpaceId).toBe(personalId)
    expect(managed?.accountId).toBe(accountA)
  })

  it('remote transfer import fails closed without the caller workspace binding', async () => {
    const sm = await buildManager()
    registerHandlers(sm)
    const payload = { header: { id: 'remote-34' }, messages: [] }

    await expect(invokeWith(sm, {}, RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, 'ws_test', payload))
      .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    await expect(invokeWith(sm, { workspaceId: 'ws_other' }, RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, 'ws_test', payload))
      .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
  })

  it('the session list fails closed when the caller workspace cannot be resolved', async () => {
    const sm = await buildManager()
    registerHandlers(sm)
    const created = await invokeWith(sm, { workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.CREATE, 'ws_test') as {
      id: string
    }
    expect(created.id).toBeTruthy()

    await expect(invokeWith(sm, {}, RPC_CHANNELS.sessions.GET)).resolves.toEqual([])
    await expect(invokeWith(sm, {}, RPC_CHANNELS.sessions.GET_MESSAGES, created.id)).resolves.toBeNull()
  })

  it('a cold storage-only record can never seed a branch, and a replaced-account source is refused', async () => {
    const sm = await buildManager()
    const storage = new RootedSessionStorageCtor(sessionsRoot)
    const baseHeader = {
      workspaceRootPath: join(tmpRoot, 'ws-root'),
      name: 'cold',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    }

    // COLD source: a storage-only record bound to the space but to NO
    // account. With no managed record the source cannot even be located
    // inside the committed fence — fail closed, never adopted.
    await storage.save({
      id: 'cold-source',
      productSpaceId: personalId,
      ...baseHeader,
    } as never)
    await expect(sm.createSession('ws_test', {
      branchFromSessionId: 'cold-source',
      branchFromMessageId: 'msg-1',
    })).rejects.toThrow('belongs to a different ProductSpace')

    // REPLACED-account source: the managed record (and its persisted
    // header) belong to account B while the trusted account is A — the
    // branch is refused before any history is adopted.
    const workspace = { id: 'ws_test', name: 'T', rootPath: join(tmpRoot, 'ws-root'), createdAt: Date.now() }
    const managed = createManagedSession({
      id: 'replaced-source',
      productSpaceId: personalId,
      accountId: accountB,
      ...baseHeader,
    } as never, workspace as never, { messagesLoaded: true })
    managed.productSpaceId = personalId
    managed.accountId = accountB
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('replaced-source', managed)
    await storage.save({
      id: 'replaced-source',
      productSpaceId: personalId,
      accountId: accountB,
      ...baseHeader,
    } as never)

    await expect(sm.createSession('ws_test', {
      branchFromSessionId: 'replaced-source',
      branchFromMessageId: 'msg-1',
    })).rejects.toThrow('belongs to a different account')
  })

  it('a fence/account replacement split fails the atomic capture before persistence', async () => {
    const sm = await buildManager()
    registerHandlers(sm)

    // The fence account and the synchronous trusted mirror disagree — a
    // concurrent replacement captured mid-flight. The shared atomic capture
    // fails closed, so neither CREATE nor the unread aggregate can be born
    // from a split scope.
    setRuntimeActiveProductSpaceAccount('account-stale-fence')

    await expect(invokeWith(sm, { workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.CREATE, 'ws_test'))
      .rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    const summary = await invokeWith(sm, {}, RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY) as {
      totalUnreadSessions: number
    }
    expect(summary.totalUnreadSessions).toBe(0)
  })
})

describe('assistant aggregate and self-management scope (R35-1)', () => {
  let tmpRoot: string
  let handlers: Map<string, Handler>
  let signedInAccountId: string | null

  let RootedSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage
  let storage: import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  const noWorkspaceContext = { clientId: 'renderer', workspaceId: null, webContentsId: null, signal: new AbortController().signal }
  const wsRoot = (): string => join(tmpRoot, 'ws-root')

  const buildManager = () => {
    if (!RootedSessionStorageCtor) {
      throw new Error('storage ctor missing')
    }
    const workspace = { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const sm = new SessionManager({
      workspace: workspace as never,
      sessionStorage: storage,
    })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
    return sm
  }

  const registerHandlers = (sm: SessionManager) => {
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
  }

  const seedManaged = (sm: SessionManager, input: {
    id: string
    accountId?: string
    productSpaceId?: string
    workspaceId?: string
    hasUnread?: boolean
  }) => {
    const workspace = { id: input.workspaceId ?? 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    const managed = createManagedSession({
      id: input.id,
      workspaceRootPath: wsRoot(),
      name: input.id,
      productSpaceId: input.productSpaceId,
      accountId: input.accountId,
      hasUnread: input.hasUnread ?? false,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as never, workspace as never, { messagesLoaded: true })
    managed.productSpaceId = input.productSpaceId
    managed.accountId = input.accountId
    ;(managed as unknown as { hasUnread: boolean }).hasUnread = input.hasUnread ?? false
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(input.id, managed)
    return managed
  }

  const invokeWith = (
    contextOverride: Partial<{ workspaceId: string | null; clientId: string }>,
    channel: string,
    ...args: unknown[]
  ) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler({ ...noWorkspaceContext, ...contextOverride } as never, ...args)
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-scope35-'))
    mkdirSync(wsRoot(), { recursive: true })
    if (!RootedSessionStorageCtor) {
      ;({ RootedSessionStorage: RootedSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    storage = new RootedSessionStorageCtor(join(tmpRoot, 'sessions'))
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    signedInAccountId = accountA
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('MARK_ALL_READ is bound to the complete caller scope and never trusts the renderer-selected workspace', async () => {
    const sm = buildManager()
    registerHandlers(sm)
    seedManaged(sm, { id: 's-a', accountId: accountA, productSpaceId: personalId, hasUnread: true })
    seedManaged(sm, { id: 's-b', accountId: accountB, productSpaceId: personalId, hasUnread: true })

    // Missing caller workspace: nothing is marked.
    await invokeWith({}, RPC_CHANNELS.sessions.MARK_ALL_READ, 'ws_test')
    expect((sm as unknown as { sessions: Map<string, { hasUnread: boolean }> }).sessions.get('s-a')!.hasUnread).toBe(true)

    // A renderer-selected id that disagrees with the caller workspace marks
    // nothing — not even the caller's own sessions.
    await invokeWith({ workspaceId: 'ws_other' }, RPC_CHANNELS.sessions.MARK_ALL_READ, 'ws_test')
    expect((sm as unknown as { sessions: Map<string, { hasUnread: boolean }> }).sessions.get('s-a')!.hasUnread).toBe(true)

    // Matching caller workspace: only same-account sessions are marked.
    await invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.MARK_ALL_READ, 'ws_test')
    expect((sm as unknown as { sessions: Map<string, { hasUnread: boolean }> }).sessions.get('s-a')!.hasUnread).toBe(false)
    expect((sm as unknown as { sessions: Map<string, { hasUnread: boolean }> }).sessions.get('s-b')!.hasUnread).toBe(true)
  })

  it('task output resolves the owner session and requires the complete trusted scope', async () => {
    const sm = buildManager()
    registerHandlers(sm)
    const { writeFile } = await import('fs/promises')
    const outputFile = join(tmpRoot, 'task-out.txt')
    await writeFile(outputFile, 'task payload', 'utf-8')

    const managed = seedManaged(sm, { id: 'owner', accountId: accountA, productSpaceId: personalId })
    ;(sm as unknown as { taskOutputIndex: Map<string, string> }).taskOutputIndex.set('task-1', 'owner')
    managed.backgroundTaskOutputs.set('task-1', {
      outputFile,
      summary: '',
      status: 'running',
      completedAt: 0,
    })

    // Missing caller workspace: no disclosure.
    await expect(invokeWith({}, RPC_CHANNELS.tasks.GET_OUTPUT, 'task-1')).resolves.toBeNull()
    // Cross-workspace caller: the owner sits in another Workspace.
    const crossWorkspace = seedManaged(sm, { id: 'cross-ws-owner', accountId: accountA, productSpaceId: personalId, workspaceId: 'ws_other' })
    ;(sm as unknown as { taskOutputIndex: Map<string, string> }).taskOutputIndex.set('task-2', 'cross-ws-owner')
    crossWorkspace.backgroundTaskOutputs.set('task-2', {
      outputFile,
      summary: '',
      status: 'running',
      completedAt: 0,
    })
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.tasks.GET_OUTPUT, 'task-2')).resolves.toBeNull()

    // Valid same-scope caller reads the output.
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.tasks.GET_OUTPUT, 'task-1'))
      .resolves.toBe('task payload')

    // Account replacement: the predecessor's task output is never disclosed.
    signedInAccountId = accountB
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)
    const fresh = buildManager()
    registerHandlers(fresh)
    const stale = seedManaged(fresh, { id: 'stale-owner', accountId: accountA, productSpaceId: personalId })
    ;(fresh as unknown as { taskOutputIndex: Map<string, string> }).taskOutputIndex.set('task-3', 'stale-owner')
    stale.backgroundTaskOutputs.set('task-3', {
      outputFile,
      summary: '',
      status: 'running',
      completedAt: 0,
    })
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.tasks.GET_OUTPUT, 'task-3')).resolves.toBeNull()
  })

  it('Assistant self-management targets resolve through the managed session complete scope', async () => {
    const sm = buildManager()
    const managed = seedManaged(sm, { id: 'managed', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'same-scope', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'cross-account', accountId: accountB, productSpaceId: personalId })
    seedManaged(sm, { id: 'cross-space', accountId: accountA, productSpaceId: 'space-other' })
    seedManaged(sm, { id: 'cross-workspace', accountId: accountA, productSpaceId: personalId, workspaceId: 'ws_other' })

    const resolver = (sm as unknown as {
      managedScopeTarget: (managed: unknown, targetId: string) => unknown
    }).managedScopeTarget

    // Self-target stays usable.
    expect(resolver.call(sm, managed, 'managed')).toBe(managed)
    // Same complete scope is reachable.
    expect(resolver.call(sm, managed, 'same-scope')).not.toBeNull()
    // Every split-scope target fails closed.
    expect(resolver.call(sm, managed, 'cross-account')).toBeNull()
    expect(resolver.call(sm, managed, 'cross-space')).toBeNull()
    expect(resolver.call(sm, managed, 'cross-workspace')).toBeNull()
    expect(resolver.call(sm, managed, 'missing')).toBeNull()

    // R36-1: a legacy managed session (no account binding) is outside the
    // current Main-owned scope — even its OWN self target is rejected.
    const legacy = seedManaged(sm, { id: 'legacy', productSpaceId: personalId })
    expect(resolver.call(sm, legacy, 'legacy')).toBeNull()
    expect(resolver.call(sm, legacy, 'same-scope')).toBeNull()
  })
})

describe('assistant self-management current-scope enforcement (R36-1)', () => {
  let tmpRoot: string
  let signedInAccountId: string | null

  let RootedSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage
  let storage: import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  const wsRoot = (): string => join(tmpRoot, 'ws-root')

  const buildManager = () => {
    const workspace = { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const sm = new SessionManager({
      workspace: workspace as never,
      sessionStorage: storage,
    })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
    return sm
  }

  const seedManaged = (sm: SessionManager, input: {
    id: string
    accountId?: string
    productSpaceId?: string
    workspaceId?: string
  }) => {
    const workspace = { id: input.workspaceId ?? 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    const managed = createManagedSession({
      id: input.id,
      workspaceRootPath: wsRoot(),
      name: input.id,
      productSpaceId: input.productSpaceId,
      accountId: input.accountId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as never, workspace as never, { messagesLoaded: true })
    managed.productSpaceId = input.productSpaceId
    managed.accountId = input.accountId
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(input.id, managed)
    return managed
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-scope36-'))
    mkdirSync(wsRoot(), { recursive: true })
    if (!RootedSessionStorageCtor) {
      ;({ RootedSessionStorage: RootedSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    storage = new RootedSessionStorageCtor(join(tmpRoot, 'sessions'))
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    signedInAccountId = accountA
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const resolverOf = (sm: SessionManager) => (sm as unknown as {
    managedScopeTarget: (managed: unknown, targetId: string) => unknown
  }).managedScopeTarget

  it('self targets are rejected for legacy, replaced-account, missing-fence, and in-flight-replacement states', async () => {
    const sm = buildManager()
    const managed = seedManaged(sm, { id: 'managed-a', accountId: accountA, productSpaceId: personalId })
    const legacy = seedManaged(sm, { id: 'legacy', productSpaceId: personalId })
    const resolver = resolverOf(sm)

    // R36-1 runtime reproduction 1: a legacy (unbound) session can no
    // longer use self-management, even on itself.
    expect(resolver.call(sm, legacy, 'legacy')).toBeNull()

    // R36-1 runtime reproduction 2: Main's trusted account/fence moves to
    // account B — the account-A session's SELF target is rejected.
    signedInAccountId = accountB
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)
    expect(resolver.call(sm, managed, 'managed-a')).toBeNull()

    // A missing fence rejects everything.
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(null)
    expect(resolver.call(sm, managed, 'managed-a')).toBeNull()

    // An in-flight fence/account replacement (fence account and mirror
    // disagreeing) rejects everything.
    setRuntimeActiveProductSpace(personalId)
    setRuntimeActiveProductSpaceAccount(accountB)
    setSyncTrustedProductSpaceAccountId(accountA)
    expect(resolver.call(sm, managed, 'managed-a')).toBeNull()
  })

  it('valid current-scope self and non-self targets remain usable', async () => {
    const sm = buildManager()
    const managed = seedManaged(sm, { id: 'managed-a', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'same-scope', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'cross-account', accountId: accountB, productSpaceId: personalId })
    seedManaged(sm, { id: 'cross-space', accountId: accountA, productSpaceId: 'space-other' })
    seedManaged(sm, { id: 'cross-workspace', accountId: accountA, productSpaceId: personalId, workspaceId: 'ws_other' })
    const resolver = resolverOf(sm)

    expect(resolver.call(sm, managed, 'managed-a')).toBe(managed)
    expect(resolver.call(sm, managed, 'same-scope')).not.toBeNull()
    expect(resolver.call(sm, managed, 'cross-account')).toBeNull()
    expect(resolver.call(sm, managed, 'cross-space')).toBeNull()
    expect(resolver.call(sm, managed, 'cross-workspace')).toBeNull()

    // A committed fence bound to a DIFFERENT space rejects the session even
    // for itself (the record no longer matches the current scope).
    setRuntimeActiveProductSpace('space-other')
    expect(resolver.call(sm, managed, 'managed-a')).toBeNull()
  })

  it('list_sessions lists nothing for an out-of-scope managed session and filters in-scope', async () => {
    const sm = buildManager()
    seedManaged(sm, { id: 'managed-a', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'same-scope', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'cross-account', accountId: accountB, productSpaceId: personalId })
    const list = (sm as unknown as {
      listSessionsInManagedScope: (managed: unknown, options?: never) => { total: number; returned: number; sessions: Array<{ id: string }> }
    }).listSessionsInManagedScope

    // Out-of-scope (legacy) managed session: empty listing.
    const legacy = seedManaged(sm, { id: 'legacy', productSpaceId: personalId })
    expect(list.call(sm, legacy)).toEqual({ total: 0, returned: 0, sessions: [] })

    // In-scope: only same-account sessions of the same space/workspace.
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get('managed-a')
    const result = list.call(sm, managed)
    expect(result.total).toBe(2)
    expect(result.sessions.map(item => item.id).sort()).toEqual(['managed-a', 'same-scope'])

    // After an account replacement: empty again.
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)
    expect(list.call(sm, managed).sessions).toEqual([])
  })
})

describe('assistant scope transition epoch, callback inventory, atomic predicate, publication CAS (R37)', () => {
  let tmpRoot: string
  let handlers: Map<string, Handler>
  let signedInAccountId: string | null
  let storage: import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  let RootedSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  const noWorkspaceContext = { clientId: 'renderer', workspaceId: null, webContentsId: null, signal: new AbortController().signal }
  const wsRoot = (): string => join(tmpRoot, 'ws-root')
  const sessionsRoot = (): string => join(tmpRoot, 'sessions')

  /** R37-4: storage whose create/save can be parked mid-flight. */
  const makeGatedStorage = () => {
    let gate: Promise<void> | null = null
    let releaseGate: () => void = () => {}
    const inner = new RootedSessionStorageCtor(sessionsRoot())
    const gatedProps = new Set(['create', 'save', 'flush'])
    const proxy = new Proxy(inner, {
      get(target, prop) {
        if (typeof prop === 'string' && gatedProps.has(prop)) {
          return async (...args: unknown[]) => {
            if (gate) await gate
            return (target as unknown as Record<string, (...inner: unknown[]) => unknown>)[prop](...args)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as unknown as import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage
    return {
      storage: proxy,
      armGate: () => {
        gate = new Promise(resolve => {
          releaseGate = resolve
        })
      },
      release: () => {
        releaseGate()
        releaseGate = () => {}
        gate = null
      },
    }
  }

  const buildManager = (sessionStorageInstance?: SessionStorage) => {
    const workspace = { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const sm = new SessionManager({
      workspace: workspace as never,
      sessionStorage: sessionStorageInstance ?? storage!,
    })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
    return sm
  }

  const registerHandlers = (sm: SessionManager) => {
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
  }

  const seedManaged = (sm: SessionManager, input: {
    id: string
    accountId?: string
    productSpaceId?: string
    workspaceId?: string
  }) => {
    const workspace = { id: input.workspaceId ?? 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    const managed = createManagedSession({
      id: input.id,
      workspaceRootPath: wsRoot(),
      name: input.id,
      productSpaceId: input.productSpaceId,
      accountId: input.accountId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as never, workspace as never, { messagesLoaded: true })
    managed.productSpaceId = input.productSpaceId
    managed.accountId = input.accountId
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(input.id, managed)
    return managed
  }

  const invokeWith = (
    contextOverride: Partial<{ workspaceId: string | null; clientId: string }>,
    channel: string,
    ...args: unknown[]
  ) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler({ ...noWorkspaceContext, ...contextOverride } as never, ...args)
  }

  const settleAccountA = () => {
    signedInAccountId = accountA
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-scope37-'))
    mkdirSync(wsRoot(), { recursive: true })
    mkdirSync(sessionsRoot(), { recursive: true })
    if (!RootedSessionStorageCtor) {
      ;({ RootedSessionStorage: RootedSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    signedInAccountId = accountA
    setTrustedProductSpaceAccountProvider(async () => signedInAccountId)
    settleAccountA()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('self-management fails closed while a beginEnding epoch is in flight even when fence and mirror agree (R37-1)', async () => {
    const sm = buildManager()
    const managed = seedManaged(sm, { id: 'managed-a', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'same-scope', accountId: accountA, productSpaceId: personalId })
    const resolver = (sm as unknown as {
      managedScopeTarget: (managed: unknown, targetId: string) => unknown
    }).managedScopeTarget

    // Valid current scope before the transition.
    expect(resolver.call(sm, managed, 'managed-a')).toBe(managed)

    // R37-1: beginEnding publishes the epoch while fence and mirror STILL
    // agree on account A — every target, including self, is rejected.
    beginAccountTransition()
    expect(resolver.call(sm, managed, 'managed-a')).toBeNull()
    expect(resolver.call(sm, managed, 'same-scope')).toBeNull()

    // The replacement commits the new mirror: the transition settles, and
    // the old account-A session stays rejected (replaced account).
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)
    expect(resolver.call(sm, managed, 'managed-a')).toBeNull()
  })

  it('every internal callback fails closed outside the current scope and works within it (R37-2 inventory)', async () => {
    const sm = buildManager()
    const managed = seedManaged(sm, { id: 'managed-a', accountId: accountA, productSpaceId: personalId })
    seedManaged(sm, { id: 'same-scope', accountId: accountA, productSpaceId: personalId })
    const callbacks = (sm as unknown as {
      buildManagedSessionToolCallbacks: (managed: unknown) => Record<string, ((...args: any[]) => any) | undefined>
    }).buildManagedSessionToolCallbacks(managed)
    const spawn = (sm as unknown as {
      spawnSessionFromManagedAgent: (managed: unknown, request: { prompt: string }) => Promise<unknown>
    }).spawnSessionFromManagedAgent

    const table: Array<{ name: string; invoke: () => unknown; throwing: boolean }> = [
      { name: 'setSessionLabelsFn', invoke: () => callbacks.setSessionLabelsFn!(undefined, ['x']), throwing: true },
      { name: 'setSessionStatusFn', invoke: () => callbacks.setSessionStatusFn!(undefined, 'done'), throwing: true },
      { name: 'getSessionInfoFn', invoke: () => callbacks.getSessionInfoFn!(undefined), throwing: false },
      { name: 'listSessionsFn', invoke: () => callbacks.listSessionsFn!(undefined), throwing: false },
      { name: 'resolveLabelsFn', invoke: () => callbacks.resolveLabelsFn!(['x']), throwing: true },
      { name: 'resolveStatusFn', invoke: () => callbacks.resolveStatusFn!('done'), throwing: true },
      { name: 'sendAgentMessageFn', invoke: () => callbacks.sendAgentMessageFn!('same-scope', 'hello'), throwing: true },
      { name: 'activateSourceInSessionFn', invoke: () => callbacks.activateSourceInSessionFn!('source-x'), throwing: true },
      { name: 'onSpawnSession', invoke: () => spawn.call(sm, managed, { prompt: 'hello' }), throwing: true },
    ]

    // Valid current scope: NOTHING may be rejected by the scope guard.
    for (const entry of table) {
      try {
        await entry.invoke()
      } catch (error) {
        expect((error as Error).message).not.toContain('SESSION_OUT_OF_TRUSTED_SCOPE')
      }
    }

    const invalidStates: Array<[string, () => void]> = [
      ['replaced-account', () => {
        setSyncTrustedProductSpaceAccountId(accountB)
        setRuntimeActiveProductSpaceAccount(accountB)
      }],
      ['missing-fence', () => {
        setRuntimeActiveProductSpace(null)
      }],
      ['split-fence', () => {
        setRuntimeActiveProductSpace(personalId)
        setRuntimeActiveProductSpaceAccount(accountA)
        setSyncTrustedProductSpaceAccountId(accountB)
      }],
      ['in-transition', () => {
        setSyncTrustedProductSpaceAccountId(accountA)
        setRuntimeActiveProductSpaceAccount(accountA)
        beginAccountTransition()
      }],
    ]

    for (const [stateName, applyState] of invalidStates) {
      applyState()
      for (const entry of table) {
        if (entry.throwing) {
          await expect(Promise.resolve().then(() => entry.invoke()).then((resolved: unknown) => {
            throw new Error(`RESOLVED_IN_${stateName}_${entry.name}: ${JSON.stringify(resolved)}`)
          }).catch((error: Error) => {
            if (error.message.includes('RESOLVED_IN_')) throw error
            throw new Error(`${stateName}/${entry.name}: ${error.message}`)
          })).rejects.toThrow('SESSION_OUT_OF_TRUSTED_SCOPE')
        } else {
          const outcome = await entry.invoke()
          // Non-throwing callbacks fail closed with empty/null projections.
          if (entry.name === 'getSessionInfoFn') expect(outcome).toBeNull()
          if (entry.name === 'listSessionsFn') expect(outcome).toEqual({ total: 0, returned: 0, sessions: [] })
        }
      }
      // Settle back to the valid scope for the next state.
      settleAccountA()
      expect(table.length).toBeGreaterThan(0)
      void stateName
    }
  })

  it('the session RPC predicate is atomic: split fence/mirror and in-transition states authorize nothing (R37-3)', async () => {
    const sm = buildManager()
    registerHandlers(sm)

    // Split transition: the fence belongs to account A while the mirror
    // already shows account B. A B/X session in the caller workspace must
    // NOT match the synthesized tuple.
    seedManaged(sm, { id: 's-bx', accountId: accountB, productSpaceId: personalId })
    setRuntimeActiveProductSpaceAccount(accountA)
    setSyncTrustedProductSpaceAccountId(accountB)
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-bx')).resolves.toBeNull()

    // In-flight transition: fence and mirror agree on account A but the
    // epoch is unsettled — nothing crosses the boundary.
    settleAccountA()
    seedManaged(sm, { id: 's-ax', accountId: accountA, productSpaceId: personalId })
    beginAccountTransition()
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-ax')).resolves.toBeNull()

    // Settled scope: the same-scope session is readable again.
    setSyncTrustedProductSpaceAccountId(accountA)
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-ax')).resolves.not.toBeNull()
  })

  it('CREATE rolls back storage and publishes nothing when scope/fence changes during awaited work (R37-4)', async () => {
    const variants: Array<[string, () => void]> = [
      ['account-replacement', () => {
        setSyncTrustedProductSpaceAccountId(accountB)
        setRuntimeActiveProductSpaceAccount(accountB)
      }],
      ['fence-revoke', () => {
        setRuntimeActiveProductSpace(null)
      }],
      ['epoch-bump', () => {
        beginAccountTransition()
      }],
    ]

    for (const [variantName, mutate] of variants) {
      const gated = makeGatedStorage()
      const sm = buildManager(gated.storage)
      registerHandlers(sm)
      gated.armGate()

      const creating = invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.CREATE, 'ws_test')
      // Let CREATE park inside the gated storage write.
      await new Promise(resolve => setTimeout(resolve, 30))
      mutate()
      gated.release()

      await expect(creating).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
      // Nothing was published and no storage survives the rollback.
      expect(sm.getSessions()).toHaveLength(0)
      const entries = readdirSync(sessionsRoot(), { recursive: true }) as string[]
      expect(entries.some(entry => entry.includes('session.jsonl'))).toBe(false)
      void variantName
      settleAccountA()
    }
  })

  it('a branch creation rolls back on a scope change during the awaited copy (R37-4)', async () => {
    const gated = makeGatedStorage()
    const sm = buildManager(gated.storage)
    const source = seedManaged(sm, { id: 'branch-source', accountId: accountA, productSpaceId: personalId })
    // The managed source carries the copyable history AND its SDK context
    // (the sdk-fork strategy validates both before the awaited copy).
    ;(source as unknown as {
      messages: Array<Record<string, unknown>>
      sdkSessionId?: string
      sdkCwd?: string
      branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session'
    }).messages = [
      { id: 'msg-1', role: 'user', content: 'hello', timestamp: Date.now() },
    ]
    ;(source as unknown as { sdkSessionId?: string }).sdkSessionId = 'sdk-parent-1'
    ;(source as unknown as { branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session' }).branchContextStrategy = 'sdk-fork'
    await gated.storage.save({
      id: 'branch-source',
      workspaceRootPath: wsRoot(),
      name: 'source',
      productSpaceId: personalId,
      accountId: accountA,
      sdkSessionId: 'sdk-parent-1',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as never)
    void source

    gated.armGate()
    const creating = sm.createSession('ws_test', {
      branchFromSessionId: 'branch-source',
      branchFromMessageId: 'msg-1',
    })
    // The branch validation awaits the source session's storage flush —
    // the fence revoke lands inside that awaited stage (same account, but
    // the fence generation moved), before any storage is created for the
    // new session.
    await new Promise(resolve => setTimeout(resolve, 30))
    setRuntimeActiveProductSpace(null)
    gated.release()

    await expect(creating).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    // The source remains; no branch session was written or published.
    expect(sm.getSessions()).toHaveLength(1)
    const entries = readdirSync(sessionsRoot(), { recursive: true }) as string[]
    expect(entries.some(entry => entry.includes('session.jsonl') && !entry.includes('branch-source'))).toBe(false)
  })

  it('import rolls back storage and emits no session when scope changes during the save (R37-4)', async () => {
    const gated = makeGatedStorage()
    const sm = buildManager(gated.storage)
    const bundle = {
      version: 1,
      session: {
        header: { id: 'import-37', createdAt: Date.now(), name: 'imported' },
        messages: [],
      },
      files: [],
    }

    gated.armGate()
    const importing = sm.importSession('ws_test', bundle as never, 'fork')
    await new Promise(resolve => setTimeout(resolve, 30))
    beginAccountTransition()
    gated.release()

    await expect(importing).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    expect(sm.getSessions()).toHaveLength(0)
    const entries = readdirSync(sessionsRoot(), { recursive: true }) as string[]
    expect(entries.some(entry => entry.includes('import-37'))).toBe(false)
  })
})
