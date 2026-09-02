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
  getActiveAccountTransitionEpoch,
  isAccountTransitionInProgress,
  getSyncTrustedProductSpaceAccountId,
  settleAccountTransition,
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
    // R38-1: an outstanding transition from a previous test is aborted by
    // its owner handle (mirror commits no longer settle transitions).
    const outstanding = getActiveAccountTransitionEpoch()
    if (outstanding !== null) settleAccountTransition(outstanding, 'abort')
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

    // R38-1: the replacement OWNER settles its transition (commit).
    const ownedEpoch = getActiveAccountTransitionEpoch()
    expect(ownedEpoch).not.toBeNull()
    expect(settleAccountTransition(ownedEpoch!, 'commit')).toBe(true)
    // After settlement the boundary is valid again for the new scope.
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
      // R38-2: with the authoritative guard wrapper, EVERY entry — including
      // the read-only projections — rejects uniformly outside the scope.
      { name: 'getSessionInfoFn', invoke: () => callbacks.getSessionInfoFn!(undefined), throwing: true },
      { name: 'listSessionsFn', invoke: () => callbacks.listSessionsFn!(undefined), throwing: true },
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
          // Defensive: no entry resolves outside the current scope.
          await expect(Promise.resolve().then(() => entry.invoke())).rejects.toThrow()
        }
      }
      // R38-1: settle the in-transition state by its owner handle, then
      // settle back to the valid scope for the next state.
      const activeEpoch = getActiveAccountTransitionEpoch()
      if (activeEpoch !== null) settleAccountTransition(activeEpoch, 'abort')
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

    // R38-1: the owner abort settles the boundary; the settled scope reads
    // the same-scope session again.
    settleAccountTransition(getActiveAccountTransitionEpoch()!, 'abort')

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
      // R38-1: settle the transition the variant began.
      const activeEpoch = getActiveAccountTransitionEpoch()
      if (activeEpoch !== null) settleAccountTransition(activeEpoch, 'abort')
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

describe('account-transition owner lifecycle and settlement (R38-1)', () => {
  let tmpRoot: string
  let storage: import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  let RootedSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  const wsRoot = (): string => join(tmpRoot, 'ws-root')
  const sessionsRoot = (): string => join(tmpRoot, 'sessions')

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

  const seedManaged = (sm: SessionManager, input: { id: string; accountId?: string; productSpaceId?: string }) => {
    const workspace = { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
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
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-owner38-'))
    mkdirSync(wsRoot(), { recursive: true })
    mkdirSync(sessionsRoot(), { recursive: true })
    if (!RootedSessionStorageCtor) {
      ;({ RootedSessionStorage: RootedSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    storage = new RootedSessionStorageCtor(sessionsRoot())
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    setTrustedProductSpaceAccountProvider(async () => accountA)
    // Abort any transition an earlier test left unsettled.
    const outstanding = getActiveAccountTransitionEpoch()
    if (outstanding !== null) settleAccountTransition(outstanding, 'abort')
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
  })

  afterEach(() => {
    const outstanding = getActiveAccountTransitionEpoch()
    if (outstanding !== null) settleAccountTransition(outstanding, 'abort')
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('settlement is owner-CAS: a wrong epoch never clears the boundary', () => {
    const epoch = beginAccountTransition()
    expect(isAccountTransitionInProgress()).toBe(true)
    // A different (older/unknown) epoch is not the owner.
    expect(settleAccountTransition(epoch + 100, 'commit')).toBe(false)
    expect(settleAccountTransition(epoch - 1, 'abort')).toBe(false)
    expect(isAccountTransitionInProgress()).toBe(true)
    // Only the owner settles.
    expect(settleAccountTransition(epoch, 'commit')).toBe(true)
    expect(isAccountTransitionInProgress()).toBe(false)
  })

  it('an explicit abort restores a valid prior boundary after failed cleanup', async () => {
    const sm = buildManager()
    const managed = seedManaged(sm, { id: 'managed-a', accountId: accountA, productSpaceId: personalId })
    const resolver = (sm as unknown as {
      managedScopeTarget: (managed: unknown, targetId: string) => unknown
    }).managedScopeTarget

    expect(resolver.call(sm, managed, 'managed-a')).toBe(managed)

    // The replacement begins; cleanup then FAILS (rejected) — the owner
    // aborts instead of leaving account_transition_pending forever.
    const epoch = beginAccountTransition()
    expect(resolver.call(sm, managed, 'managed-a')).toBeNull()
    expect(settleAccountTransition(epoch, 'abort')).toBe(true)

    // The prior account boundary is valid again for the same scope.
    expect(resolver.call(sm, managed, 'managed-a')).toBe(managed)
    expect(isAccountTransitionInProgress()).toBe(false)
  })

  it('concurrent logout/login transitions never settle an older transition early', () => {
    // Logout cleanup begins transition T1.
    const t1 = beginAccountTransition()
    expect(isAccountTransitionInProgress()).toBe(true)

    // A replacement login begins its OWN transition T2 — it supersedes T1.
    const t2 = beginAccountTransition()
    expect(t2).toBeGreaterThan(t1)

    // The OLD logout owner tries to settle: refused (T2 owns the boundary).
    expect(settleAccountTransition(t1, 'commit')).toBe(false)
    expect(isAccountTransitionInProgress()).toBe(true)

    // Only the newest owner settles.
    expect(settleAccountTransition(t2, 'commit')).toBe(true)
    expect(isAccountTransitionInProgress()).toBe(false)
  })

  it('a mirror refresh that did not start the transition never clears it', () => {
    const epoch = beginAccountTransition()
    // Any unrelated mirror snapshot/refresh happens here.
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)
    // The transition is still in flight — the mirror cannot clear it.
    expect(isAccountTransitionInProgress()).toBe(true)
    expect(getActiveAccountTransitionEpoch()).toBe(epoch)

    // The owner settles it after its cleanup outcome.
    expect(settleAccountTransition(epoch, 'abort')).toBe(true)
    expect(isAccountTransitionInProgress()).toBe(false)
  })
})

describe('session RPC post-await scope CAS races (R38-3)', () => {
  let tmpRoot: string
  let handlers: Map<string, Handler>
  let storage: import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  let RootedSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  const noWorkspaceContext = { clientId: 'renderer', workspaceId: null, webContentsId: null, signal: new AbortController().signal }
  const wsRoot = (): string => join(tmpRoot, 'ws-root')
  const sessionsRoot = (): string => join(tmpRoot, 'sessions')

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
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-race38-'))
    mkdirSync(wsRoot(), { recursive: true })
    mkdirSync(sessionsRoot(), { recursive: true })
    if (!RootedSessionStorageCtor) {
      ;({ RootedSessionStorage: RootedSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    storage = new RootedSessionStorageCtor(sessionsRoot())
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    const outstanding = getActiveAccountTransitionEpoch()
    if (outstanding !== null) settleAccountTransition(outstanding, 'abort')
    setTrustedProductSpaceAccountProvider(async () => accountA)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
  })

  afterEach(() => {
    const outstanding = getActiveAccountTransitionEpoch()
    if (outstanding !== null) settleAccountTransition(outstanding, 'abort')
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('the R38 GET_MESSAGES runtime reproduction: a transition begun mid-read returns null (R38-3)', async () => {
    const sm = buildManager()
    registerHandlers(sm)
    const managed = createManagedSession({
      id: 's-race',
      workspaceRootPath: wsRoot(),
      name: 's-race',
      productSpaceId: personalId,
      accountId: accountA,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ id: 'm1', role: 'user', content: 'secret' }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as never, { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() } as never, { messagesLoaded: true })
    managed.productSpaceId = personalId
    managed.accountId = accountA
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('s-race', managed)

    // Park the awaited read INSIDE getSession, begin the transition, release.
    const realGetSession = sm.getSession.bind(sm)
    let releaseRead: () => void = () => {}
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    ;(sm as unknown as { getSession: unknown }).getSession = async (...args: unknown[]) => {
      await readGate
      return (realGetSession as (...a: unknown[]) => unknown)(...args)
    }

    const reading = invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-race')
    await new Promise(resolve => setTimeout(resolve, 30))
    beginAccountTransition()
    releaseRead()

    // The post-await CAS discloses nothing once the transition began.
    await expect(reading).resolves.toBeNull()

    // Settle: the same read under the settled boundary discloses normally.
    settleAccountTransition(getActiveAccountTransitionEpoch()!, 'abort')
    await expect(invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-race'))
      .resolves.not.toBeNull()
  })

  it('table-driven post-await race suite across read/aggregate/mutation/task boundaries (R38-3)', async () => {
    const sm = buildManager()
    registerHandlers(sm)
    const workspace = { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    const managed = createManagedSession({
      id: 's-table',
      workspaceRootPath: wsRoot(),
      name: 's-table',
      productSpaceId: personalId,
      accountId: accountA,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as never, workspace as never, { messagesLoaded: true })
    managed.productSpaceId = personalId
    managed.accountId = accountA
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('s-table', managed)

    // Park helper: wrap one awaited SessionManager dependency.
    const parkOn = (method: string) => {
      const target = sm as unknown as Record<string, (...a: unknown[]) => unknown>
      const real = target[method].bind(sm)
      let release: () => void = () => {}
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      target[method] = async (...args: unknown[]) => {
        await gate
        return real(...args)
      }
      return () => {
        release()
        target[method] = real
      }
    }

    // Seed one unread session so the list/aggregate valid legs have data.
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.get('s-table') as unknown as { hasUnread: boolean }

    const races: Array<{
      name: string
      parkOn: string
      act: () => Promise<unknown>
      assertLost: (outcome: unknown) => void
      assertValid: (outcome: unknown) => void
    }> = [
      {
        name: 'GET list',
        parkOn: 'waitForInit',
        act: async () => invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET),
        assertLost: outcome => expect(outcome).toEqual([]),
        assertValid: outcome => expect(outcome).not.toEqual([]),
      },
      {
        name: 'GET_MESSAGES',
        parkOn: 'getSession',
        act: async () => invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_MESSAGES, 's-table'),
        assertLost: outcome => expect(outcome).toBeNull(),
        assertValid: outcome => expect(outcome).not.toBeNull(),
      },
      {
        name: 'task output',
        parkOn: 'getTaskOutput',
        act: async () => invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.tasks.GET_OUTPUT, 'task-38'),
        assertLost: outcome => expect(outcome).toBeNull(),
        assertValid: outcome => expect(outcome).toBeNull(),
      },
      {
        name: 'GET_PENDING_PLAN_EXECUTION',
        parkOn: 'getPendingPlanExecution',
        act: async () => invokeWith({ workspaceId: 'ws_test' }, RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, 's-table'),
        assertLost: outcome => expect(outcome).toBeNull(),
        assertValid: outcome => expect(outcome).toBeNull(),
      },
    ]

    for (const race of races) {
      const release = parkOn(race.parkOn)
      const acting = race.act()
      await new Promise(resolve => setTimeout(resolve, 30))
      // The transition begins while the awaited dependency is parked.
      beginAccountTransition()
      release()
      race.assertLost(await acting)
      // R38-1: abort settles the boundary.
      settleAccountTransition(getActiveAccountTransitionEpoch()!, 'abort')
      // Valid current scope: the same boundary stays usable.
      race.assertValid(await race.act())
    }
  })
})

describe('publication rollback completeness (R38-4)', () => {
  let tmpRoot: string
  let storage: import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  let RootedSessionStorageCtor: typeof import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

  const wsRoot = (): string => join(tmpRoot, 'ws-root')
  const sessionsRoot = (): string => join(tmpRoot, 'sessions')

  const buildManager = (sessionStorageInstance?: SessionStorage) => {
    const workspace = { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const sm = new SessionManager({
      workspace: workspace as never,
      sessionStorage: sessionStorageInstance ?? storage,
    })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
    return sm
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-roll38-'))
    mkdirSync(wsRoot(), { recursive: true })
    mkdirSync(sessionsRoot(), { recursive: true })
    if (!RootedSessionStorageCtor) {
      ;({ RootedSessionStorage: RootedSessionStorageCtor } = await import('@polo-ai/shared/sessions/session-storage.ts'))
    }
    storage = new RootedSessionStorageCtor(sessionsRoot())
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    const outstanding = getActiveAccountTransitionEpoch()
    if (outstanding !== null) settleAccountTransition(outstanding, 'abort')
    setTrustedProductSpaceAccountProvider(async () => accountA)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setRuntimeActiveProductSpace(personalId)
  })

  afterEach(() => {
    const outstanding = getActiveAccountTransitionEpoch()
    if (outstanding !== null) settleAccountTransition(outstanding, 'abort')
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('a failed storage delete during CREATE rollback surfaces a fail-closed error and keeps the record quarantined', async () => {
    // ONE storage proxy: create is gate-able (the CAS loss lands mid-write)
    // and delete can be injected to fail (R38-4 rollback verification).
    const inner = new RootedSessionStorageCtor(sessionsRoot())
    let gate: Promise<void> | null = null
    let releaseGate: () => void = () => {}
    const state = { failDeletes: false }
    const gatedStorage = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'create') {
          return async (...args: unknown[]) => {
            if (gate) await gate
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>).create(...args)
          }
        }
        if (prop === 'delete') {
          return (...args: unknown[]) => {
            if (state.failDeletes) return false
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>).delete(...args)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as unknown as import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage

    const sm = buildManager(gatedStorage)

    gate = new Promise(resolve => {
      releaseGate = resolve
    })
    const creating = sm.createSession('ws_test', {})
    await new Promise(resolve => setTimeout(resolve, 30))
    setSyncTrustedProductSpaceAccountId(accountB)
    setRuntimeActiveProductSpaceAccount(accountB)
    state.failDeletes = true
    releaseGate()

    // R38-4: the rollback-incomplete marker is surfaced, never swallowed.
    await expect(creating).rejects.toThrow('rollback incomplete')
    // The stale on-disk record survives (delete failed) — the failure was
    // surfaced instead of ignored, and nothing was published.
    const writtenEntries = readdirSync(sessionsRoot(), { recursive: true }) as string[]
    expect(writtenEntries.length).toBeGreaterThan(0)
  })

  it('import rollback preserves a concurrent valid same-ID owner and its storage (R38-4)', async () => {
    const sm = buildManager()
    const bundle = {
      version: 1,
      session: {
        header: { id: 'owned-import', createdAt: Date.now(), name: 'imported' },
        messages: [],
      },
      files: [],
    }

    // A concurrent valid same-ID owner commits BEFORE our CAS loss.
    const workspace = { id: 'ws_test', name: 'T', rootPath: wsRoot(), createdAt: Date.now() }
    const owner = createManagedSession({
      id: 'owned-import',
      workspaceRootPath: wsRoot(),
      name: 'concurrent-owner',
      productSpaceId: personalId,
      accountId: accountA,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as never, workspace as never, { messagesLoaded: true })
    owner.productSpaceId = personalId
    owner.accountId = accountA
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('owned-import', owner)

    // Park the awaited storage save; the transition begins mid-save.
    const inner = storage
    let releaseSave: () => void = () => {}
    const saveGate = new Promise<void>(resolve => {
      releaseSave = resolve
    })
    const gatedStorage = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'save') {
          return async (...args: unknown[]) => {
            await saveGate
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>).save(...args)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as unknown as import('@polo-ai/shared/sessions/session-storage.ts').RootedSessionStorage
    ;(sm as unknown as { sessionStorage: SessionStorage }).sessionStorage = gatedStorage

    const importing = sm.importSession('ws_test', bundle as never, 'fork')
    await new Promise(resolve => setTimeout(resolve, 30))
    beginAccountTransition()
    releaseSave()

    // The CAS loss refuses the import…
    await expect(importing).rejects.toThrow('PRODUCT_SPACE_CONTEXT_REQUIRED')
    // …and the concurrent valid owner's in-memory record is preserved (no
    // delete was attempted against a published same-ID owner).
    expect(sm.getSessions().find(session => session.id === 'owned-import')).not.toBeUndefined()
  })
})

describe('authoritative callback guard inventory (R38-2)', () => {
  const SESSION_MANAGER_SOURCE = 'packages/server-core/src/sessions/SessionManager.ts'

  it('every direct agent callback registration routes through the guard inventory (source scan)', async () => {
    const { readFileSync } = await import('fs')
    const source = readFileSync(SESSION_MANAGER_SOURCE, 'utf-8')

    // Every `managed.agent.on<X> =` assignment must be wrapped through the
    // authoritative guard mechanism.
    const assignments = [...new Set(
      (source.match(/managed\.agent\.on[A-Za-z]+ =/g) ?? []).map(a => a.replace(' =', '')),
    )]
    expect(assignments.length).toBeGreaterThanOrEqual(8)
    for (const assignment of assignments) {
      const callbackName = assignment.replace('managed.agent.', '')
      expect(source).toContain(`this.guardManagedCallback(managed, 'agent.${callbackName}'`)
    }

    // The tool-callback builder and the browser-pane record go through the
    // same authoritative mechanism.
    expect(source).toContain('mergeSessionScopedToolCallbacks(managed.id, this.buildManagedSessionToolCallbacks(managed))')
    expect(source).toContain('this.guardManagedCallbackRecord(managed, \'browserPaneFns\', rawBrowserPaneFns.browserPaneFns)')
  })

  it('the builder registers every entry in the inventory with the caller guard (runtime)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sm-inv38-'))
    const wsRoot = join(tmpRoot, 'ws-root')
    mkdirSync(wsRoot, { recursive: true })
    try {
      const { RootedSessionStorage: RootedStorage } = await import('@polo-ai/shared/sessions/session-storage.ts')
      setSyncTrustedProductSpaceAccountId(accountA)
      setRuntimeActiveProductSpaceAccount(accountA)
      setRuntimeActiveProductSpace(personalId)
      const sm = new SessionManager({
        workspace: { id: 'ws_test', name: 'T', rootPath: wsRoot, createdAt: Date.now() } as never,
        sessionStorage: new RootedStorage(join(tmpRoot, 'sessions')),
      })
      ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
      const managed = createManagedSession({
        id: 'inv-managed',
        workspaceRootPath: wsRoot,
        name: 'inv',
        productSpaceId: personalId,
        accountId: accountA,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
      } as never, { id: 'ws_test', name: 'T', rootPath: wsRoot, createdAt: Date.now() } as never, { messagesLoaded: true })
      managed.productSpaceId = personalId
      managed.accountId = accountA

      const callbacks = (sm as unknown as {
        buildManagedSessionToolCallbacks: (managed: unknown) => Record<string, ((...args: never[]) => unknown) | undefined>
      }).buildManagedSessionToolCallbacks(managed)

      // Every entry is registered in the authoritative inventory.
      const expected = [
        'self.setSessionLabelsFn',
        'self.setSessionStatusFn',
        'self.getSessionInfoFn',
        'self.listSessionsFn',
        'self.resolveLabelsFn',
        'self.resolveStatusFn',
        'self.sendAgentMessageFn',
        'self.activateSourceInSessionFn',
      ]
      const inventory = (sm as unknown as {
        getManagedCallbackInventoryForTests: (sessionId: string) => string[]
      }).getManagedCallbackInventoryForTests('inv-managed')
      for (const name of expected) {
        expect(inventory).toContain(name)
        // The object key drops the 'self.' inventory prefix.
        expect(callbacks[name.replace('self.', '')]).toBeDefined()
      }

      // The wrapper enforces the caller scope: outside it, every entry rejects.
      setSyncTrustedProductSpaceAccountId(accountB)
      setRuntimeActiveProductSpaceAccount(accountB)
      for (const name of expected) {
        await expect(Promise.resolve().then(() => callbacks[name.replace('self.', '')]!(undefined as never)))
          .rejects.toThrow('SESSION_OUT_OF_TRUSTED_SCOPE')
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
      setSyncTrustedProductSpaceAccountId(accountA)
      setRuntimeActiveProductSpaceAccount(accountA)
      setRuntimeActiveProductSpace(personalId)
    }
  })
})
