import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import * as serverCoreDomain from '@polo-ai/server-core/domain'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'

// The delete-first silent convergence must settle the REAL sessions:SEND_MESSAGE
// RPC normally (no expected-cancellation rejection reaches the client), leave
// no error/ghost events and no storage resurrection.

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
const { getSessionFilePath, writeSessionJsonl } = await import('@polo-ai/shared/sessions')
type StoredSession = import('@polo-ai/shared/sessions').StoredSession
const { registerSessionsHandlers } = await import('./sessions.ts')

async function waitForConditionInternal(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('waitForConditionInternal timed out')
}

describe('sessions:SEND_MESSAGE RPC — delete-first silent convergence', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof import('@polo-ai/server-core/sessions').SessionManager>
  let events: Array<Record<string, unknown>>
  let handlers: Map<string, (ctx: unknown, ...args: unknown[]) => unknown>
  let server: RpcServer

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rpc-delete-first-'))
    sm = new SessionManager()
    events = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
    }) as never)
    handlers = new Map()
    server = {
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
    const queue = (sm as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
    try { queue.cancel('rpc-del-first') } catch { /* ignore */ }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedSession(sessionId: string) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'rpc session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [] as unknown as StoredSession['messages'],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as StoredSession
    writeSessionJsonl(filePath, stored)
    const managed = createManagedSession(
      { id: sessionId, name: stored.name, createdAt: stored.createdAt },
      { id: 'ws_test', name: 'WS', rootPath: tmpRoot, createdAt: Date.now() } as never,
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return managed
  }

  it('a send that races a delete settles the RPC normally (no reject, no error event, no storage resurrection)', async () => {
    seedSession('rpc-del-first')
    const sendMessage = handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!
    expect(sendMessage).toBeDefined()

    // Hold the question lock: the DELETE's declaration queues FIRST, the
    // send's critical section SECOND — the declaration wins the
    // linearization race and the send converges silently before any
    // persistence (deterministic, no scheduling sleeps).
    let releaseLock!: () => void
    const hungLock = new Promise<void>(resolve => { releaseLock = resolve })
    let lockAcquisitions = 0
    const realLock = (sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<unknown>) => Promise<unknown> }).withQuestionStateLock.bind(sm)
    ;(sm as unknown as { withQuestionStateLock: (id: string, critical: () => Promise<unknown>) => Promise<unknown> }).withQuestionStateLock = (id: string, critical: () => Promise<unknown>) => {
      lockAcquisitions++
      return realLock(id, critical)
    }
    void realLock('rpc-del-first', () => hungLock)
    await new Promise(r => setTimeout(r, 10))
    lockAcquisitions = 0

    const deletePromise = sm.deleteSession('rpc-del-first')
    await waitForConditionInternal(() => lockAcquisitions >= 1, 5000)

    const rpcPromise = sendMessage({ clientId: 'rpc-client' }, 'rpc-del-first', 'racing rpc message') as Promise<{ accepted: boolean; messageId: string }>
    await waitForConditionInternal(() => lockAcquisitions >= 2, 5000)

    releaseLock()
    // The declaration ran first — the send's section re-validates and
    // converges SILENTLY; the RPC settles normally (no expected-cancellation
    // rejection reaches the client).
    const result = (await rpcPromise) as { accepted: boolean; messageId: string }
    expect(result.accepted).toBe(true)
    expect(result.messageId).toBe('')
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
    expect(events.filter(e => e.type === 'error')).toHaveLength(0)

    await deletePromise
    expect(existsSync(getSessionFilePath(tmpRoot, 'rpc-del-first'))).toBe(false)
    expect(events.filter(e => e.type === 'session_deleted')).toHaveLength(1)
  })

  it('control: a normal send settles with a real persisted message id', async () => {
    seedSession('rpc-normal')
    const sendMessage = handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => ({
      allowRequestUserInput: false,
      chat: async function* () { yield { type: 'complete' as const } },
      getModel: () => 'fake-model',
      getSessionId: () => null,
      isProcessing: () => false,
      supportsBranching: true,
      setAllSources: () => {},
      setSourceServers: async () => {},
      getSummarizeCallback: () => undefined,
      dispose: () => {},
      interruptForHandoff: () => {},
      forceAbort: () => {},
      respondToPermission: () => {},
      setSessionTurnGeneration: () => {},
    })

    const result = (await sendMessage({ clientId: 'rpc-client' }, 'rpc-normal', 'a real message')) as { accepted: boolean; messageId: string }
    expect(result.accepted).toBe(true)
    expect(result.messageId).toEqual(expect.any(String))
    expect(result.messageId.length).toBeGreaterThan(0)
  })
})
