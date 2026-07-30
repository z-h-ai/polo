/**
 * Session file watcher isolation tests.
 *
 * Verifies per-client watcher lifecycle: creation, cleanup, disconnect,
 * and that concurrent clients don't interfere with each other.
 *
 * Uses an injected event-controlled watcher so registration, delivery, and
 * cleanup phases are deterministic under full-suite concurrency.
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { RpcServer, RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { RPC_CHANNELS } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Electron mock (needed by transitive imports)
// ---------------------------------------------------------------------------

mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/', quit: () => {}, dock: { setIcon: () => {}, setBadge: () => {} } },
  nativeTheme: { shouldUseDarkColors: false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createFromDataURL: () => ({}) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
  shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  session: {},
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface PushCall {
  channel: string
  target: any
  args: any[]
}

let tempDirs: string[] = []

function makeTempSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-test-'))
  tempDirs.push(dir)
  return dir
}

function createTestHarness(sessionPaths: Map<string, string>) {
  const handlers = new Map<string, Function>()
  const pushCalls: PushCall[] = []
  const watchers = new Map<string, {
    closed: boolean
    listener: (eventType: string, filename: string | Buffer | null) => void
  }>()
  const pushWaiters: Array<{
    predicate: (call: PushCall) => boolean
    resolve: (call: PushCall) => void
  }> = []

  const server: RpcServer = {
    handle(channel: string, handler: Function) {
      handlers.set(channel, handler as any)
    },
    push(channel: string, target: any, ...args: any[]) {
      const call = { channel, target, args }
      pushCalls.push(call)
      for (let index = pushWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = pushWaiters[index]!
        if (!waiter.predicate(call)) continue
        pushWaiters.splice(index, 1)
        waiter.resolve(call)
      }
    },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      getSessionPath: (sessionId: string) => sessionPaths.get(sessionId) ?? null,
      waitForInit: async () => {},
      getSessions: () => [],
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    } as unknown as HandlerDeps['platform'],
    oauthFlowStore: {
      store: () => {}, getByState: () => null, remove: () => {}, cleanup: () => {}, dispose: () => {}, size: 0,
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

  const emitFileChange = (path: string, filename: string) => {
    const watcher = watchers.get(path)
    if (!watcher || watcher.closed) return
    watcher.listener('rename', filename)
  }
  const waitForPush = (predicate: (call: PushCall) => boolean) =>
    new Promise<PushCall>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = pushWaiters.findIndex(
          waiter => waiter.resolve === resolvePush,
        )
        if (waiterIndex >= 0) pushWaiters.splice(waiterIndex, 1)
        reject(new Error('Timed out waiting for deterministic watcher push'))
      }, 2_000)
      const resolvePush = (call: PushCall) => {
        clearTimeout(timeout)
        resolve(call)
      }
      pushWaiters.push({ predicate, resolve: resolvePush })
    })

  return {
    server,
    deps,
    handlers,
    pushCalls,
    emitFileChange,
    waitForPush,
  }
}

function makeCtx(clientId: string, workspaceId = 'ws-1'): RequestContext {
  return { clientId, workspaceId, webContentsId: null, signal: new AbortController().signal }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session file watcher isolation', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    tempDirs = []
  })

  it('creates independent watchers per client and cleans up on disconnect', async () => {
    const dir1 = makeTempSessionDir()
    const dir2 = makeTempSessionDir()
    const sessionPaths = new Map([['s1', dir1], ['s2', dir2]])
    const {
      server,
      deps,
      handlers,
      pushCalls,
      emitFileChange,
      waitForPush,
    } = createTestHarness(sessionPaths)

    const { registerSessionsHandlers, cleanupSessionFileWatchForClient } = await import('@polo-ai/server-core/handlers/rpc')
    registerSessionsHandlers(server, deps)

    const watchHandler = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)!
    const unwatchHandler = handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)!

    // Client A watches session s1, Client B watches session s2
    await watchHandler(makeCtx('client-a'), 's1')
    await watchHandler(makeCtx('client-b'), 's2')

    const clientAChanged = waitForPush(
      call => call.target?.clientId === 'client-a',
    )
    emitFileChange(dir1, 'output.txt')
    await clientAChanged

    // Only client-a should have received the notification
    const clientAPushes = pushCalls.filter(p => p.target?.clientId === 'client-a')
    const clientBPushes = pushCalls.filter(p => p.target?.clientId === 'client-b')
    expect(clientAPushes.length).toBeGreaterThanOrEqual(1)
    expect(clientBPushes.length).toBe(0)

    // Verify push target is client-specific, not broadcast
    expect(clientAPushes[0].channel).toBe(RPC_CHANNELS.sessions.FILES_CHANGED)
    expect(clientAPushes[0].target).toEqual({ to: 'client', clientId: 'client-a' })

    // Unwatch client A — should not affect client B
    await unwatchHandler(makeCtx('client-a'))

    // Clear push history
    pushCalls.length = 0

    const clientBChanged = waitForPush(
      call => call.target?.clientId === 'client-b',
    )
    emitFileChange(dir2, 'data.json')
    await clientBChanged

    // Client B should still receive notifications
    const clientBAfter = pushCalls.filter(p => p.target?.clientId === 'client-b')
    expect(clientBAfter.length).toBeGreaterThanOrEqual(1)

    // Disconnect cleanup for client B
    cleanupSessionFileWatchForClient('client-b')

    // Double cleanup is a no-op (doesn't throw)
    cleanupSessionFileWatchForClient('client-b')
  })

  it('cleans up previous watcher when same client watches a different session', async () => {
    const dir1 = makeTempSessionDir()
    const dir2 = makeTempSessionDir()
    const sessionPaths = new Map([['s1', dir1], ['s2', dir2]])
    const {
      server,
      deps,
      handlers,
      pushCalls,
      emitFileChange,
      waitForPush,
    } = createTestHarness(sessionPaths)

    const { registerSessionsHandlers, cleanupSessionFileWatchForClient } = await import('@polo-ai/server-core/handlers/rpc')
    registerSessionsHandlers(server, deps)

    const watchHandler = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)!

    // Client A watches s1
    await watchHandler(makeCtx('client-a'), 's1')

    // Client A switches to s2 — old watcher should be cleaned up
    await watchHandler(makeCtx('client-a'), 's2')

    // Write to s1 — should NOT trigger notification (old watcher closed)
    emitFileChange(dir1, 'old.txt')

    const s1Pushes = pushCalls.filter(p =>
      p.args[0] === 's1' && p.channel === RPC_CHANNELS.sessions.FILES_CHANGED
    )
    expect(s1Pushes.length).toBe(0)

    // Write to s2 — should trigger notification
    const sessionTwoChanged = waitForPush(
      call => call.args[0] === 's2',
    )
    emitFileChange(dir2, 'new.txt')
    await sessionTwoChanged

    const s2Pushes = pushCalls.filter(p =>
      p.args[0] === 's2' && p.channel === RPC_CHANNELS.sessions.FILES_CHANGED
    )
    expect(s2Pushes.length).toBeGreaterThanOrEqual(1)

    cleanupSessionFileWatchForClient('client-a')
  })

  it('ignores internal session.jsonl and hidden files', async () => {
    const dir = makeTempSessionDir()
    const sessionPaths = new Map([['s1', dir]])
    const {
      server,
      deps,
      handlers,
      pushCalls,
      emitFileChange,
      waitForPush,
    } = createTestHarness(sessionPaths)

    const { registerSessionsHandlers, cleanupSessionFileWatchForClient } = await import('@polo-ai/server-core/handlers/rpc')
    registerSessionsHandlers(server, deps)

    const watchHandler = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)!
    await watchHandler(makeCtx('client-a'), 's1')

    // Write internal files — should be ignored
    emitFileChange(dir, 'session.jsonl')
    emitFileChange(dir, '.hidden')

    expect(pushCalls.length).toBe(0)

    // Write a normal file — should trigger notification
    const resultChanged = waitForPush(call => call.args[0] === 's1')
    emitFileChange(dir, 'result.txt')
    await resultChanged

    expect(pushCalls.length).toBeGreaterThanOrEqual(1)

    cleanupSessionFileWatchForClient('client-a')
  })
})
