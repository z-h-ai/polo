/**
 * WsRpcClient React Native compatibility tests (POL-6, PRD v1.6 C1 + C6).
 *
 * Proves that client.ts works unchanged inside an RN-like global environment:
 *  - a) RN globals (no process.versions.node, polyfilled Buffer/crypto, global
 *    WebSocket): client takes the global-WebSocket branch and the in-band
 *    token handshake succeeds (C1). The upgrade request carries no auth
 *    header/query, and the require('ws') branch is proven unreachable by a
 *    differential: with the only input that reaches it in Node
 *    (wss:// + tlsRejectUnauthorized:false), Node picks the ws-library socket
 *    while the RN-simulated environment picks the global WebSocket.
 *  - b) In-band auth: valid token -> handshake_ack; wrong token -> close 4005;
 *    missing handshake within 5s -> close 4001.
 *  - c) Reconnect replay on the RN identity path (no workspaceId/webContentsId,
 *    null==null identity match): missed events are replayed by seq, no dup/no gap.
 *  - d) codec base64 dual path with and without a global Buffer (btoa/atob fallback).
 *
 * No source files are modified — this is a zero-change compatibility proof.
 * Hermes on-device behavior (btoa/atob etc.) is flagged for M0-ACC manual
 * verification in docs/rn-compat-checklist.md.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import WebSocket from 'ws'
import { WsRpcServer, type WsRpcServerOptions } from '../server'
import { WsRpcClient } from '../client'
import { serializeEnvelope, deserializeEnvelope } from '../codec'
import type { MessageEnvelope } from '@polo-ai/shared/protocol'

const TEST_TOKEN = 'rn-compat-test-token'
const SERVER_VERSION = '0.0.0-rn-compat'

// ---------------------------------------------------------------------------
// Global environment simulation helpers
// ---------------------------------------------------------------------------

type Restore = () => void

/** LIFO stack of global mutations — unwound in afterEach even on failure. */
const restorers: Restore[] = []
const openSockets: WebSocket[] = []
const openClients: WsRpcClient[] = []

function overrideGlobalValue(key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  restorers.push(() => {
    if (original) {
      Object.defineProperty(globalThis, key, original)
    } else {
      delete (globalThis as Record<string, unknown>)[key]
    }
  })
}

/**
 * Install the RN-like global environment:
 *  - delete process.versions.node (RN's process polyfill has no versions)
 *  - mount globalThis.Buffer from the `buffer` npm polyfill (the ~2KB adapter
 *    the app entry installs, per PRD C6)
 *  - stub crypto.randomUUID (simulating an app-side polyfill on top of
 *    getRandomValues — RN has no native randomUUID)
 *  - optionally replace globalThis.WebSocket with an instrumented subclass to
 *    prove the client instantiates the *global* WebSocket (not require('ws'))
 * Returns the list of client sockets created through the instrumented ctor.
 */
function installRnGlobals(opts?: { instrumentWebSocket?: boolean }): WebSocket[] {
  const versions = process.versions as Record<string, string | undefined>
  const savedNode = versions.node
  delete versions.node
  restorers.push(() => {
    if (savedNode !== undefined) versions.node = savedNode
  })

  // RN default has no Buffer; app entry installs `require('buffer').Buffer`.
  overrideGlobalValue('Buffer', require('buffer').Buffer)

  let uuidCounter = 0
  overrideGlobalValue('crypto', {
    randomUUID: () => `rn-uuid-${String(++uuidCounter).padStart(4, '0')}`,
  })

  const created: WebSocket[] = []
  if (opts?.instrumentWebSocket) {
    const RealWebSocket = globalThis.WebSocket as unknown as new (url: string | URL, protocols?: string | string[]) => WebSocket
    class InstrumentedWebSocket extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        created.push(this)
      }
    }
    overrideGlobalValue('WebSocket', InstrumentedWebSocket)
  }
  return created
}

// ---------------------------------------------------------------------------
// Server / wait helpers (same shape as server-lifecycle.test.ts)
// ---------------------------------------------------------------------------

function createServer(opts?: Partial<WsRpcServerOptions>): WsRpcServer {
  return new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (t) => t === TEST_TOKEN,
    serverId: 'test',
    serverVersion: SERVER_VERSION,
    ...opts,
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 4000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WsRpcClient RN compatibility (POL-6)', () => {
  let server: WsRpcServer | null = null

  afterEach(() => {
    for (const client of openClients) {
      try { client.destroy() } catch { /* best effort teardown */ }
    }
    openClients.length = 0
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    openSockets.length = 0
    server?.close()
    server = null
    while (restorers.length) {
      const restore = restorers.pop()
      restore?.()
    }
  })

  // -- a) RN globals: global WebSocket branch + in-band token handshake --

  it('connects through the global WebSocket with RN globals and completes the in-band-token handshake', async () => {
    const instrumentedSockets = installRnGlobals({ instrumentWebSocket: true })

    // The RN process polyfill has no versions.node — hold for the whole test.
    expect((process.versions as Record<string, string | undefined>).node).toBeUndefined()

    let connectedInfo: { clientId: string; webContentsId: number | null; workspaceId: string | null } | null = null
    const tokensSeen: string[] = []
    server = createServer({
      onClientConnected: (info) => { connectedInfo = info },
      validateToken: async (t) => {
        tokensSeen.push(t)
        return t === TEST_TOKEN
      },
    })
    await server.listen()
    server.handle('rn:echo', async (_ctx, ...args: unknown[]) => args)

    // Hook the server's ws 'connection' event (second listener — the server's
    // own is unaffected) to capture the HTTP upgrade request, so the test can
    // prove the token never travels out-of-band.
    const wss = (server as unknown as { wss: import('ws').WebSocketServer | null }).wss
    expect(wss).not.toBeNull()
    let upgradeCapture: { authorization: unknown; url: string | undefined } | null = null
    wss!.on('connection', (_ws, req) => {
      upgradeCapture = { authorization: req.headers.authorization, url: req.url }
    })

    // A phone connects to the Mac over LAN → explicit remote mode.
    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: TEST_TOKEN,
      mode: 'remote',
      autoReconnect: false,
    })
    openClients.push(client)

    // RPC over the RN-simulated globals; exercises both the string path and
    // the Uint8Array→base64 path of the codec under the polyfilled Buffer.
    const payload = new Uint8Array([0, 1, 254, 255])
    const result = await client.invoke('rn:echo', 'hello-rn', payload)

    expect(result[0]).toBe('hello-rn')
    expect(result[1]).toEqual(payload)

    // The only socket the client created is the instrumented global WebSocket.
    expect(instrumentedSockets.length).toBe(1)
    expect(instrumentedSockets[0]!.readyState).toBe(1) // OPEN

    // Token travelled in-band (inside the handshake envelope — the only place
    // a client token can appear). The captured HTTP upgrade request proves it:
    // no Authorization header, no token query parameter.
    expect(tokensSeen).toEqual([TEST_TOKEN])
    const upgrade = upgradeCapture as { authorization: unknown; url: string | undefined } | null
    expect(upgrade).not.toBeNull()
    expect(upgrade!.authorization).toBeUndefined()
    expect(new URL(upgrade!.url ?? '/', 'ws://127.0.0.1').searchParams.get('token')).toBeNull()

    // RN identity: no workspaceId/webContentsId → server stores null/null.
    expect(connectedInfo).not.toBeNull()
    expect(connectedInfo!.workspaceId).toBeNull()
    expect(connectedInfo!.webContentsId).toBeNull()

    expect(client.isConnected).toBe(true)
    expect(client.getConnectionState().status).toBe('connected')
    expect(client.getConnectionState().mode).toBe('remote')
    expect(client.getServerVersion()).toBe(SERVER_VERSION)
  })

  it('in a Node environment, wss + tlsRejectUnauthorized:false DOES select the ws-library socket (branch discriminator)', () => {
    // Sanity anchor for the next test: wss:// + tlsRejectUnauthorized:false is
    // the ONLY input combination that can reach the require('ws') branch in
    // createWebSocket (a ws:// URL or default tlsRejectUnauthorized skips it
    // even in Node). In a Node/Bun run the branch is taken — the created
    // socket is a ws-library WebSocket (EventEmitter-style `.on` API), so the
    // RN assertion below genuinely discriminates the two branches instead of
    // testing a URL shape that never reaches either.
    const client = new WsRpcClient('wss://127.0.0.1:1', {
      token: TEST_TOKEN,
      mode: 'remote',
      autoReconnect: false,
      tlsRejectUnauthorized: false,
    })
    openClients.push(client)
    client.connect() // socket creation is synchronous; no I/O has settled yet

    const socket = (client as unknown as { ws: WebSocket | null }).ws
    expect(socket).not.toBeNull()
    expect(typeof socket!.on).toBe('function') // ws-library API surface
    client.destroy()
  })

  it('under RN globals, the same wss + tlsRejectUnauthorized:false stays on the global WebSocket (require(ws) unreachable)', () => {
    // With process.versions.node gone, the Node/ws branch cannot trigger even
    // for the only input that reaches it in Node (proven by the previous
    // test): the client instantiates the instrumented global WebSocket, never
    // the ws library. This is the RN branch decision itself, not a ws:// URL
    // side effect.
    const instrumentedSockets = installRnGlobals({ instrumentWebSocket: true })
    expect((process.versions as Record<string, string | undefined>).node).toBeUndefined()

    const client = new WsRpcClient('wss://127.0.0.1:1', {
      token: TEST_TOKEN,
      mode: 'remote',
      autoReconnect: false,
      tlsRejectUnauthorized: false,
    })
    openClients.push(client)
    client.connect() // synchronous — the (failing, async) TLS dial cannot intervene

    const socket = (client as unknown as { ws: unknown }).ws
    expect(instrumentedSockets.length).toBe(1) // a ws-library socket would skip the instrumented ctor
    expect(socket).toBe(instrumentedSockets[0]) // the client's socket IS the global-WebSocket instance
    expect(typeof (socket as { on?: unknown } | null)?.on).not.toBe('function') // browser-style API, not EventEmitter
    client.destroy()
  })

  // -- b) In-band token behavior --

  it('rejects a wrong token with close 4005 after an AUTH_FAILED error envelope', async () => {
    server = createServer()
    await server.listen()

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    openSockets.push(ws)

    let authError: Record<string, any> | null = null
    const close = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: '1.0',
          token: 'wrong-token',
        }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, any>
        if (msg.type === 'error') authError = msg
      })
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })

    // TS narrows the closure-assigned variable to null — retype at read site.
    const capturedError = authError as Record<string, any> | null
    expect(capturedError?.error?.code).toBe('AUTH_FAILED')
    expect(close.code).toBe(4005)
    expect(close.reason).toBe('Auth failed')
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('surfaces auth failure (kind auth, lastClose 4005) through the client API', async () => {
    server = createServer()
    await server.listen()

    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: 'wrong-token',
      autoReconnect: false,
    })
    openClients.push(client)

    let rejected: any = null
    try {
      await client.invoke('rn:echo', 'should-not-send')
    } catch (err) {
      rejected = err
    }

    expect(rejected).not.toBeNull()
    expect(rejected.kind).toBe('auth')
    expect(rejected.code).toBe('AUTH_FAILED')
    expect(client.isConnected).toBe(false)

    // The close frame lands right after the error envelope — wait for the
    // client to record it, then assert the wire-level close code (4005).
    await waitFor(() => client.getConnectionState().lastClose !== undefined)
    expect(client.getConnectionState().lastClose?.code).toBe(4005)
    expect(client.getConnectionState().lastClose?.reason).toBe('Auth failed')
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('closes with 4001 when the client sends no handshake within 5s', async () => {
    server = createServer()
    await server.listen()

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    openSockets.push(ws)

    const close = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('open', () => { /* deliberately never handshake */ })
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })

    expect(close.code).toBe(4001)
    expect(close.reason).toBe('Handshake timeout')
  }, 10_000)

  // -- c) Reconnect replay on the null==null identity path --

  it('replays missed events by seq on reconnect without duplicates (RN null identity)', async () => {
    server = createServer()
    await server.listen()
    server.handle('rn:echo', async (_ctx, ...args: unknown[]) => args)

    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: TEST_TOKEN,
      // no workspaceId / webContentsId — the RN identity path (null==null)
      maxReconnectDelay: 2000,
    })
    openClients.push(client)

    await client.invoke('rn:echo', 'ready') // wait for fresh connect
    expect(server.getConnectedClientCount()).toBe(1)

    const received: number[] = []
    const reconnectIsStale: boolean[] = []
    client.on('rn:evt', (p: { n: number }) => received.push(p.n))
    client.on('__transport:reconnected', (isStale: boolean) => reconnectIsStale.push(isStale))

    // 1) live events while connected → seq 1..3, client lastSeenSeq = 3
    server.push('rn:evt', { to: 'all' }, { n: 1 })
    server.push('rn:evt', { to: 'all' }, { n: 2 })
    server.push('rn:evt', { to: 'all' }, { n: 3 })
    await waitFor(() => received.length >= 3)

    // 2) simulate app suspension / network drop: close the underlying socket.
    //    onDisconnect captures { clientId, lastSeq: 3 } for the reconnect.
    const socket = (client as unknown as { ws: WebSocket | null }).ws
    expect(socket).not.toBeNull()
    socket!.close()

    await waitFor(() => server!.getConnectedClientCount() === 0)

    // 3) events pushed while "offline" → buffered server-side (seq 4, 5)
    server.push('rn:evt', { to: 'all' }, { n: 4 })
    server.push('rn:evt', { to: 'all' }, { n: 5 })
    await sleep(150) // nothing may arrive before the reconnect handshake
    expect(received.length).toBe(3)

    // 4) auto-reconnect (~1s backoff) sends reconnectClientId + lastSeq=3;
    //    server matches null==null identity and replays seq 4..5.
    await waitFor(() => received.length >= 5, 6000)
    expect(reconnectIsStale).toEqual([false]) // server recognized the reconnect

    // 5) fully live again after replay
    const echo = await client.invoke('rn:echo', 'after-replay')
    expect(echo[0]).toBe('after-replay')
    server.push('rn:evt', { to: 'all' }, { n: 6 })
    await waitFor(() => received.length >= 6)

    expect(received).toEqual([1, 2, 3, 4, 5, 6]) // ordered, no gaps
    expect(new Set(received).size).toBe(received.length) // no duplicates
    expect(server.getConnectedClientCount()).toBe(1)
  }, 15_000)

  // -- d) codec base64 dual path (C6 item 4) --

  it('codec falls back to btoa/atob when no global Buffer exists (RN default)', () => {
    // RN default: no global Buffer until the app installs the polyfill.
    overrideGlobalValue('Buffer', undefined)

    let btoaCalls = 0
    let atobCalls = 0
    const realBtoa = globalThis.btoa.bind(globalThis)
    const realAtob = globalThis.atob.bind(globalThis)
    overrideGlobalValue('btoa', (s: string) => { btoaCalls++; return realBtoa(s) })
    overrideGlobalValue('atob', (s: string) => { atobCalls++; return realAtob(s) })

    const envelope: MessageEnvelope = {
      id: 'rn-no-buffer',
      type: 'event',
      channel: 'rn:binary',
      args: [new Uint8Array([0, 1, 254, 255])],
      seq: 1,
    }
    const wire = serializeEnvelope(envelope)
    expect(wire).toContain('__craftRpcType')
    const decoded = deserializeEnvelope(wire)
    expect(decoded.args?.[0]).toEqual(new Uint8Array([0, 1, 254, 255]))
    expect(btoaCalls).toBeGreaterThan(0)
    expect(atobCalls).toBeGreaterThan(0)
  })

  it('codec uses the polyfilled Buffer path when globalThis.Buffer is mounted', () => {
    // The ~2KB app-entry adapter: global.Buffer = require('buffer').Buffer
    overrideGlobalValue('Buffer', require('buffer').Buffer)

    let btoaCalls = 0
    const realBtoa = globalThis.btoa.bind(globalThis)
    overrideGlobalValue('btoa', (s: string) => { btoaCalls++; return realBtoa(s) })

    const envelope: MessageEnvelope = {
      id: 'rn-with-buffer',
      type: 'event',
      channel: 'rn:binary',
      args: [new Uint8Array([0, 1, 254, 255])],
      seq: 1,
    }
    const wire = serializeEnvelope(envelope)
    const decoded = deserializeEnvelope(wire)
    expect(decoded.args?.[0]).toEqual(new Uint8Array([0, 1, 254, 255]))
    expect(btoaCalls).toBe(0) // Buffer path taken, btoa untouched
  })
})
