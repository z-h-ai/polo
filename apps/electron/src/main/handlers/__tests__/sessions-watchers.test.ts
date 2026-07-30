import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RPC_CHANNELS } from '../../../shared/types'
import { registerSessionsHandlers, cleanupSessionFileWatchForClient } from '@polo-ai/server-core/handlers/rpc'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function triggerUntil(
  trigger: () => void,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (!predicate() && Date.now() < deadline) {
    trigger()
    attempt += 1
    await wait(150)
  }
  expect(predicate(), `watch event missing after ${attempt} file updates`).toBe(true)
}

describe('sessions file watchers', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: any; args: any[] }> = []
  const clientA = `sessions-watchers-a-${randomUUID()}`
  const clientB = `sessions-watchers-b-${randomUUID()}`

  let tempRoot = ''
  let sessionDirA = ''
  let sessionDirB = ''

  beforeEach(() => {
    handlers.clear()
    pushed.length = 0

    tempRoot = mkdtempSync(join(tmpdir(), 'craft-session-watchers-'))
    sessionDirA = join(tempRoot, 'session-a')
    sessionDirB = join(tempRoot, 'session-b')
    mkdirSync(sessionDirA, { recursive: true })
    mkdirSync(sessionDirB, { recursive: true })

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn)
      },
      push(channel, target, ...args) {
        pushed.push({ channel, target, args })
      },
      async invokeClient() {
        return null
      },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }

    const deps: HandlerDeps = {
      sessionManager: {
        getSessionPath: (sessionId: string) => {
          if (sessionId === 'session-a') return sessionDirA
          if (sessionId === 'session-b') return sessionDirB
          return null
        },
      } as unknown as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
      oauthFlowStore: {
        store: () => {},
        getByState: () => null,
        remove: () => {},
        cleanup: () => {},
        dispose: () => {},
        get size() { return 0 },
      } as unknown as HandlerDeps['oauthFlowStore'],
    }

    registerSessionsHandlers(server, deps)
  })

  afterEach(() => {
    cleanupSessionFileWatchForClient(clientA)
    cleanupSessionFileWatchForClient(clientB)
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('isolates file change notifications per client watcher', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    const unwatch = handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)
    expect(watch).toBeTruthy()
    expect(unwatch).toBeTruthy()

    await watch!({ clientId: clientA }, 'session-a')
    await watch!({ clientId: clientB }, 'session-b')
    await wait(50)

    await triggerUntil(
      () => {
        writeFileSync(join(sessionDirA, 'a.txt'), `a-${Date.now()}`)
        writeFileSync(join(sessionDirB, 'b.txt'), `b-${Date.now()}`)
      },
      () => (
        pushed.some((evt) => evt.target?.clientId === clientA)
        && pushed.some((evt) => evt.target?.clientId === clientB)
      ),
    )

    const aEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === clientA)
    const bEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === clientB)

    expect(aEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-a')).toBe(true)
    expect(bEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)

    pushed.length = 0
    await unwatch!({ clientId: clientA })

    await triggerUntil(
      () => {
        writeFileSync(join(sessionDirA, 'a.txt'), `a2-${Date.now()}`)
        writeFileSync(join(sessionDirB, 'b.txt'), `b2-${Date.now()}`)
      },
      () => pushed.some((evt) => (
        evt.target?.clientId === clientB
        && evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED
        && evt.args[0] === 'session-b'
      )),
    )

    const aEventsAfter = pushed.filter((evt) => evt.target?.clientId === clientA)
    const bEventsAfter = pushed.filter((evt) => evt.target?.clientId === clientB)

    expect(aEventsAfter.length).toBe(0)
    expect(bEventsAfter.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)
  })

  it('disconnect cleanup removes watcher and prevents further events', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    expect(watch).toBeTruthy()

    await watch!({ clientId: clientA }, 'session-a')
    await wait(50)

    cleanupSessionFileWatchForClient(clientA)
    pushed.length = 0

    writeFileSync(join(sessionDirA, 'after-cleanup.txt'), `x-${Date.now()}`)
    await wait(300)

    expect(pushed.length).toBe(0)
  })
})
