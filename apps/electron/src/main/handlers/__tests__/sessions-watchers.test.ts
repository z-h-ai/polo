import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
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

async function triggerUntilObserved(
  trigger: (attempt: number) => void,
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    trigger(attempt++)
    const attemptDeadline = Math.min(deadline, Date.now() + 250)
    while (Date.now() < attemptDeadline) {
      if (condition()) return
      await wait(20)
    }
  }
  throw new Error('timed out waiting for retried session watcher event')
}

const CLIENT_A = 'sessions-watchers-client-a'
const CLIENT_B = 'sessions-watchers-client-b'

describe('sessions file watchers', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: any; args: any[] }> = []

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
    cleanupSessionFileWatchForClient(CLIENT_A)
    cleanupSessionFileWatchForClient(CLIENT_B)
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('isolates file change notifications per client watcher', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    const unwatch = handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)
    expect(watch).toBeTruthy()
    expect(unwatch).toBeTruthy()

    await watch!({ clientId: CLIENT_A }, 'session-a')
    await watch!({ clientId: CLIENT_B }, 'session-b')

    await triggerUntilObserved(
      (attempt) => {
        writeFileSync(join(sessionDirA, 'a.txt'), `a-${Date.now()}-${attempt}`)
        writeFileSync(join(sessionDirB, 'b.txt'), `b-${Date.now()}-${attempt}`)
      },
      () => pushed.some(evt => evt.target?.clientId === CLIENT_A && evt.args[0] === 'session-a')
        && pushed.some(evt => evt.target?.clientId === CLIENT_B && evt.args[0] === 'session-b'),
    )

    const aEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === CLIENT_A)
    const bEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === CLIENT_B)

    expect(aEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-a')).toBe(true)
    expect(bEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)

    pushed.length = 0
    await unwatch!({ clientId: CLIENT_A })

    await triggerUntilObserved(
      (attempt) => {
        // Repeatedly exercise both paths. Delivery for B proves the platform
        // watcher is live while the absence of A events verifies unwatch.
        writeFileSync(join(sessionDirA, 'a.txt'), `a2-${Date.now()}-${attempt}`)
        writeFileSync(join(sessionDirB, 'b.txt'), `b2-${Date.now()}-${attempt}`)
      },
      () => pushed.some(evt => evt.target?.clientId === CLIENT_B && evt.args[0] === 'session-b'),
    )

    const aEventsAfter = pushed.filter((evt) => evt.target?.clientId === CLIENT_A)
    const bEventsAfter = pushed.filter((evt) => evt.target?.clientId === CLIENT_B)

    expect(aEventsAfter.length).toBe(0)
    expect(bEventsAfter.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)
  })

  it('disconnect cleanup removes watcher and prevents further events', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    expect(watch).toBeTruthy()

    await watch!({ clientId: CLIENT_A }, 'session-a')

    cleanupSessionFileWatchForClient(CLIENT_A)
    pushed.length = 0

    writeFileSync(join(sessionDirA, 'after-cleanup.txt'), `x-${Date.now()}`)
    await wait(300)

    expect(pushed.length).toBe(0)
  })
})
