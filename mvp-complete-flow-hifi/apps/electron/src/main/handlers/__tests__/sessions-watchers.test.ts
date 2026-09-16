import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RPC_CHANNELS } from '../../../shared/types'
import { registerSessionsHandlers, cleanupSessionFileWatchForClient } from '@polo-ai/server-core/handlers/rpc'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

const CLIENT_A = 'sessions-watchers-client-a'
const CLIENT_B = 'sessions-watchers-client-b'

describe('sessions file watchers', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: any; args: any[] }> = []
  const watchers = new Map<string, {
    closed: boolean
    listener: (eventType: string, filename: string | Buffer | null) => void
  }>()
  const pushWaiters: Array<{
    clientId: string
    resolve: () => void
  }> = []

  let tempRoot = ''
  let sessionDirA = ''
  let sessionDirB = ''

  beforeEach(() => {
    handlers.clear()
    pushed.length = 0
    watchers.clear()
    pushWaiters.length = 0

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
        const targetClientId = target.to === 'client'
          ? target.clientId
          : null
        for (let index = pushWaiters.length - 1; index >= 0; index -= 1) {
          if (pushWaiters[index]!.clientId !== targetClientId) continue
          pushWaiters.splice(index, 1)[0]!.resolve()
        }
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
      sessionFileWatchFactory: (path, _options, listener) => {
        const watcher = { closed: false, listener }
        watchers.set(path, watcher)
        return {
          close() {
            watcher.closed = true
          },
        }
      },
    }

    registerSessionsHandlers(server, deps)
  })

  function emitFileChange(path: string, filename: string): void {
    const watcher = watchers.get(path)
    if (!watcher || watcher.closed) return
    watcher.listener('rename', filename)
  }

  function waitForClientPush(clientId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = pushWaiters.findIndex(
          waiter => waiter.resolve === resolvePush,
        )
        if (waiterIndex >= 0) pushWaiters.splice(waiterIndex, 1)
        reject(new Error(`Timed out waiting for watcher push to ${clientId}`))
      }, 2_000)
      const resolvePush = () => {
        clearTimeout(timeout)
        resolve()
      }
      pushWaiters.push({ clientId, resolve: resolvePush })
    })
  }

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

    const clientAChanged = waitForClientPush(CLIENT_A)
    const clientBChanged = waitForClientPush(CLIENT_B)
    emitFileChange(sessionDirA, 'a.txt')
    emitFileChange(sessionDirB, 'b.txt')
    await Promise.all([clientAChanged, clientBChanged])

    const aEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === CLIENT_A)
    const bEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === CLIENT_B)

    expect(aEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-a')).toBe(true)
    expect(bEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)

    pushed.length = 0
    await unwatch!({ clientId: CLIENT_A })

    const clientBAfterChanged = waitForClientPush(CLIENT_B)
    emitFileChange(sessionDirA, 'a.txt')
    emitFileChange(sessionDirB, 'b.txt')
    await clientBAfterChanged

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

    emitFileChange(sessionDirA, 'after-cleanup.txt')

    expect(pushed.length).toBe(0)
  })
})
