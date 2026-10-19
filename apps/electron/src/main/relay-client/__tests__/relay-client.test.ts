/**
 * POL-237 relay-client tests.
 *
 * Strategy (per card step 7): a mock polo-relay is spun up with Bun.serve and
 * every envelope it builds/parses uses the real `@polo-ai/relay/envelope`
 * exports, so the wire contract cannot drift between mock and production. The
 * loopback side uses the REAL embedded WsRpcServer from server-core — proving
 * the "phone as an embedded-server client" bridge with zero server-core
 * changes (handshake auth incl. token check, request correlation, event push).
 *
 * Covered: bridge round-trip (handshake + RPC + event push), status broadcast,
 * disconnect → backoff → reconnect, invalid envelopes never crash, control
 * receipts retire loopback sockets, config resolution chain, status machine,
 * debounce.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { WebSocket as NodeWebSocket } from 'ws'
import { WsRpcServer } from '@polo-ai/server-core/transport'
import { PROTOCOL_VERSION, RPC_CHANNELS } from '@polo-ai/shared/protocol'
import {
  EnvelopeSchema,
  HeartbeatFrameSchema,
  buildControlEnvelope,
  serializeEnvelope,
  type Envelope,
} from '@polo-ai/relay/envelope'

import { computeBackoffDelayMs, RelayClient } from '../client'
import { RelayLoopbackBridge } from '../bridge'
import { computeRelayStatus, DebouncedEmitter } from '../status'
import {
  createRelayLink,
  loadRelayClientConfig,
  normalizeRelayUrl,
  resolveRelayUrl,
  setRelayUrlOverride,
} from '../index'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAC_PERSONA = 'mac:mac-test-1'
const PHONE_PERSONA = 'phone:p1'

async function waitFor<T>(probe: () => T | undefined | null, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== null) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(15)
  }
}

interface MockRelayHandle {
  port: number
  url: string
  /** Simulates the relay's control receipt path (peer_disconnected etc.). */
  sendControl(persona: string, payload: unknown): void
  /** Writes a raw frame straight onto a persona's socket (the production
   * relay drops garbage before routing — this exercises the client's own
   * robustness against a misbehaving/compromised peer). */
  injectRaw(persona: string, text: string): void
  connectedPersonas(): string[]
  stop(): void
}

/** Minimal relay stand-in: persona registry + envelope dumb-routing (real schema). */
function startMockRelay(preferredPort?: number): MockRelayHandle {
  type Data = { persona: string }
  const connections = new Map<string, ServerWebSocket<Data>>()
  const server = Bun.serve<Data>({
    port: preferredPort ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      const headerToken = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
      const token = headerToken || (url.searchParams.get('token') ?? '')
      const side = url.searchParams.get('side')
      const deviceId = (url.searchParams.get('deviceId') ?? '').trim()
      if (!token || (side !== 'phone' && side !== 'mac') || !deviceId) {
        return new Response('unauthorized', { status: 401 })
      }
      const upgraded = srv.upgrade(req, { data: { persona: `${side}:${deviceId}` } })
      return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(ws) {
        connections.set(ws.data.persona, ws)
      },
      message(ws, raw) {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          return
        }
        const heartbeat = HeartbeatFrameSchema.safeParse(parsed)
        if (heartbeat.success) {
          if (heartbeat.data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
          return
        }
        const parsedEnvelope = EnvelopeSchema.safeParse(parsed)
        if (!parsedEnvelope.success) return
        const envelope = parsedEnvelope.data as Envelope
        const target = connections.get(envelope.to)
        if (target) target.send(serializeEnvelope(envelope))
        // Offline targets are dropped — enough for these tests.
      },
      close(ws) {
        connections.delete(ws.data.persona)
      },
    },
  })
  return {
    port: server.port ?? 0,
    url: `ws://127.0.0.1:${server.port}`,
    sendControl(persona, payload) {
      const ws = connections.get(persona)
      if (!ws) return
      ws.send(serializeEnvelope(buildControlEnvelope(persona, payload as never)))
    },
    injectRaw(persona, text) {
      connections.get(persona)?.send(text)
    },
    connectedPersonas: () => [...connections.keys()],
    stop: () => server.stop(true),
  }
}

/** Test phone — raw WS speaking the relay client contract. */
class FakePhone {
  private ws: NodeWebSocket
  readonly frames: string[] = []
  private waiters: Array<(frame: string) => void> = []
  private readIndex = 0
  private opened: Promise<void>

  constructor(url: string, personaDeviceId: string) {
    this.ws = new NodeWebSocket(`${url}/?token=phone-jwt&side=phone&deviceId=${personaDeviceId}`)
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve())
      this.ws.on('error', reject)
    })
    this.ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
      this.frames.push(text)
      const waiter = this.waiters.shift()
      if (waiter) waiter(text)
    })
  }

  async open(): Promise<void> {
    await this.opened
  }

  async nextFrame(what: string, timeoutMs = 4000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.frames.length > this.readIndex) {
        return this.frames[this.readIndex++]!
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
      await Bun.sleep(10)
    }
  }

  /** All envelopes received so far (parsed). */
  envelopes(): Envelope[] {
    return this.frames
      .map((f) => { try { return JSON.parse(f) } catch { return undefined } })
      .filter((p): p is Envelope => EnvelopeSchema.safeParse(p).success)
  }

  sendEnvelope(envelope: Envelope): void {
    this.ws.send(serializeEnvelope(envelope))
  }

  sendRaw(text: string): void {
    this.ws.send(text)
  }

  close(): void {
    try { this.ws.close() } catch { /* already gone */ }
  }
}

function rpcFrame(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}

function phoneEnvelope(payload: unknown): Envelope {
  return { v: 1, from: PHONE_PERSONA, to: MAC_PERSONA, kind: 'rpc', payload }
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('computeBackoffDelayMs', () => {
  it('doubles exponentially from the base with deterministic jitter', () => {
    const rng = () => 0.5 // jitter factor exactly 1.0
    expect(computeBackoffDelayMs(0, { baseMs: 1000, random: rng })).toBe(1000)
    expect(computeBackoffDelayMs(1, { baseMs: 1000, random: rng })).toBe(2000)
    expect(computeBackoffDelayMs(2, { baseMs: 1000, random: rng })).toBe(4000)
    expect(computeBackoffDelayMs(3, { baseMs: 1000, random: rng })).toBe(8000)
  })

  it('caps at maxMs and applies jitter within ±20%', () => {
    const low = computeBackoffDelayMs(10, { baseMs: 1000, maxMs: 30_000, random: () => 0 })
    const high = computeBackoffDelayMs(10, { baseMs: 1000, maxMs: 30_000, random: () => 1 })
    expect(low).toBe(24_000)   // 30_000 * 0.8
    expect(high).toBe(36_000)  // 30_000 * 1.2
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = computeBackoffDelayMs(attempt, { baseMs: 1000, maxMs: 30_000, random: () => 0.5 })
      expect(delay).toBeGreaterThanOrEqual(800)
      expect(delay).toBeLessThanOrEqual(36_000)
    }
  })
})

describe('computeRelayStatus', () => {
  it('ranks online-relay > online-lan > offline', () => {
    expect(computeRelayStatus({ relayConnected: true, externalClientCount: 0 })).toBe('online-relay')
    expect(computeRelayStatus({ relayConnected: true, externalClientCount: 2 })).toBe('online-relay')
    expect(computeRelayStatus({ relayConnected: false, externalClientCount: 1 })).toBe('online-lan')
    expect(computeRelayStatus({ relayConnected: false, externalClientCount: 0 })).toBe('offline')
  })
})

describe('RelayClient reconnect resilience', () => {
  /**
   * Emulates the real `ws` contract on Node: a listener on
   * 'unexpected-response' receives the rejection and ws emits NO error/close
   * afterwards (the abort path only runs without a listener) — close() in
   * CONNECTING triggers abortHandshake → 'error' + 'close'. (Bun's ws shim
   * does not implement 'unexpected-response', so the fake is the only way to
   * pin this production behavior.)
   */
  class UpgradeRejectingSocket {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    readyState = 0
    private closed = false
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
      return this
    }
    removeAllListeners(): void { this.listeners.clear() }
    send(): void { /* never opens */ }
    close(): void {
      if (this.closed) return
      this.closed = true
      setTimeout(() => {
        this.emit('error', new Error('WebSocket was closed before the connection was established'))
        this.emit('close', 1006, Buffer.from(''))
      }, 0)
    }
    terminate(): void { this.close() }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }
  }

  it('keeps the reconnect loop alive after an upgrade rejection (401/403)', async () => {
    const sockets: UpgradeRejectingSocket[] = []
    const client = new RelayClient({
      resolveUrl: () => 'wss://relay.example',
      tokenProvider: async () => 'admin-jwt',
      deviceId: 'mac-reject-1',
      baseReconnectDelayMs: 5,
      maxReconnectDelayMs: 10,
      createWebSocket: () => {
        const socket = new UpgradeRejectingSocket()
        sockets.push(socket)
        setTimeout(() => socket.emit('unexpected-response', {}, { statusCode: 403 }), 1)
        return socket as unknown as import('../client').CompatibleWebSocket
      },
    })
    client.start()
    // Without the forced close on unexpected-response the loop stalls at
    // attempt 0 — this wait would time out.
    await waitFor(() => (client.attempt >= 3 ? true : undefined), 'reconnect attempts past rejection', 4000)
    expect(client.isConnected).toBe(false)
    expect(client.lastCloseInfo?.code).toBe(403)
    expect(client.lastCloseInfo?.reason).toBe('upgrade_rejected')
    client.stop()
  })

  it('resets the backoff attempt counter after a connection stays open past stableResetMs', async () => {
    // Dead endpoint = a port with no listener (ECONNREFUSED → error + close
    // on every runtime, unlike HTTP-level rejections).
    const dead = Bun.serve({ port: 0, fetch: () => new Response('down') })
    const deadPort = dead.port
    dead.stop(true)
    const live = startMockRelay()
    let url: string | null = `ws://127.0.0.1:${deadPort}`
    const client = new RelayClient({
      resolveUrl: () => url,
      tokenProvider: async () => 'admin-jwt',
      deviceId: 'mac-stable-1',
      baseReconnectDelayMs: 5,
      maxReconnectDelayMs: 20,
      stableResetMs: 120,
      logger: { info() {}, warn() {}, error() {} },
    })
    client.start()
    await waitFor(() => (client.attempt >= 2 ? true : undefined), 'attempts accumulate against dead endpoint', 4000)
    url = live.url
    await waitFor(() => (client.isConnected ? true : undefined), 'connects to live relay')
    await Bun.sleep(220) // > stableResetMs
    expect(client.attempt).toBe(0)
    client.stop()
    live.stop()
  })
})

describe('DebouncedEmitter', () => {
  it('coalesces rapid pushes into a single trailing emission', async () => {
    const seen: number[] = []
    const emitter = new DebouncedEmitter<number>((v) => seen.push(v), 30)
    emitter.push(1)
    await Bun.sleep(5)
    emitter.push(2)
    emitter.push(3)
    await Bun.sleep(80)
    expect(seen).toEqual([3])
    emitter.dispose()
  })

  it('stops emitting after dispose', async () => {
    const seen: number[] = []
    const emitter = new DebouncedEmitter<number>((v) => seen.push(v), 10)
    emitter.dispose()
    emitter.push(1)
    await Bun.sleep(40)
    expect(seen).toEqual([])
  })
})

describe('relay URL config resolution', () => {
  it('normalizes http(s) to ws(s) and rejects garbage', () => {
    expect(normalizeRelayUrl('https://relay.example.com')).toBe('wss://relay.example.com')
    expect(normalizeRelayUrl('http://127.0.0.1:8787/')).toBe('ws://127.0.0.1:8787')
    expect(normalizeRelayUrl('wss://relay.example.com/ws')).toBe('wss://relay.example.com/ws')
    expect(normalizeRelayUrl('relay.example.com')).toBeNull()
    expect(normalizeRelayUrl('ftp://relay.example.com')).toBeNull()
    expect(normalizeRelayUrl('')).toBeNull()
  })

  it('resolves override > env > local settings, never hardcoding a domain', () => {
    const settings = { relayUrl: 'wss://from-settings.example' }
    expect(resolveRelayUrl({}, settings)).toBe('wss://from-settings.example')
    expect(resolveRelayUrl({ POLO_RELAY_URL: 'wss://from-env.example' }, settings)).toBe('wss://from-env.example')
    expect(resolveRelayUrl({ POLO_RELAY_URL: 'wss://from-env.example' }, settings, 'https://override.example')).toBe('wss://override.example')
    expect(resolveRelayUrl({}, {}, null)).toBeNull()
  })

  it('persists a stable deviceId in the settings dir and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polo-relay-config-'))
    try {
      const first = loadRelayClientConfig({}, dir)
      expect(first.deviceId).toBeTruthy()
      expect(first.relayUrl).toBeNull() // not configured → link disabled
      const second = loadRelayClientConfig({}, dir)
      expect(second.deviceId).toBe(first.deviceId)
      // Env beats the (unset) file; the file keeps holding the deviceId.
      const withEnv = loadRelayClientConfig({ POLO_RELAY_URL: 'wss://env.example' }, dir)
      expect(withEnv.relayUrl).toBe('wss://env.example')
      expect(withEnv.deviceId).toBe(first.deviceId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('admin override wins over env and settings via the module-level setter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polo-relay-config-'))
    try {
      setRelayUrlOverride('wss://admin-pushed.example')
      const config = loadRelayClientConfig({ POLO_RELAY_URL: 'wss://env.example' }, dir)
      expect(config.relayUrl).toBe('wss://admin-pushed.example')
      setRelayUrlOverride(null)
      expect(loadRelayClientConfig({ POLO_RELAY_URL: 'wss://env.example' }, dir).relayUrl).toBe('wss://env.example')
    } finally {
      setRelayUrlOverride(undefined as unknown as null)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: mock relay + real embedded WsRpcServer + relay link
// ---------------------------------------------------------------------------

describe('relay link integration', () => {
  let relay: MockRelayHandle
  let embedded: WsRpcServer
  let configDir: string
  let broadcasts: Array<{ status: string; at: number }>
  let link: ReturnType<typeof createRelayLink> | null = null

  const baseOverrides = () => ({
    statusDebounceMs: 10,
    externalClassifyDelayMs: 10,
  })

  beforeAll(async () => {
    relay = startMockRelay()
    embedded = new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (token) => token === 'server-token',
      serverId: 'test-embedded',
      // Production wiring equivalent (main/index.ts feeds these into the link).
      onClientConnected: (info) => link?.onClientConnected(info.clientId, info.webContentsId),
      onClientDisconnected: (clientId) => link?.onClientDisconnected(clientId),
    })
    await embedded.listen()
    embedded.handle('test:ping', async () => 'pong-value')
    configDir = mkdtempSync(join(tmpdir(), 'polo-relay-test-'))
    broadcasts = []
  })

  afterAll(() => {
    link?.stop()
    relay.stop()
    embedded.close()
    if (configDir) rmSync(configDir, { recursive: true, force: true })
  })

  function makeLink(deviceId = 'mac-test-1') {
    return createRelayLink({
      instance: { protocol: 'ws', port: embedded.port },
      tokenProvider: async () => 'admin-jwt',
      broadcast: (status) => broadcasts.push({ status, at: Date.now() }),
      env: { POLO_RELAY_URL: relay.url },
      configDir,
      logger: { info() {}, warn() {}, error() {} },
      overrides: {
        ...baseOverrides(),
        createClient: (clientOptions) => new RelayClient({
          ...clientOptions,
          deviceId,
          baseReconnectDelayMs: 10,
          maxReconnectDelayMs: 60,
          stableResetMs: 100,
          livenessTimeoutMs: 60_000,
        }),
      },
    })
  }

  it('bridges a phone handshake + RPC request through the relay into the embedded server and back', async () => {
    link = makeLink()
    link.start()
    await waitFor(() => link!.getStatus() === 'online-relay' ? true : undefined, 'online-relay status')

    const phone = new FakePhone(relay.url, 'p1')
    await phone.open()

    // Phone's WsRpc handshake, carried as a relay envelope payload (raw frame).
    phone.sendEnvelope(phoneEnvelope(rpcFrame({
      id: 'h1',
      type: 'handshake',
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: 'ws1',
      token: 'server-token',
    })))

    const ackFrame = await phone.nextFrame('handshake_ack')
    const ackEnvelope = EnvelopeSchema.parse(JSON.parse(ackFrame)) as Envelope
    expect(ackEnvelope.from).toBe(MAC_PERSONA)
    expect(ackEnvelope.to).toBe(PHONE_PERSONA)
    const ack = JSON.parse(String(ackEnvelope.payload)) as { type: string; clientId: string }
    expect(ack.type).toBe('handshake_ack')
    expect(ack.clientId).toBeTruthy()
    // The bridge owns this server clientId — it must not count as external.
    expect(link.bridge.isManagedClientId(ack.clientId)).toBe(true)
    expect(link.bridge.getManagedClientIds().has(ack.clientId)).toBe(true)

    // sessions-RPC round trip: request through relay → embedded handler → response.
    phone.sendEnvelope(phoneEnvelope(rpcFrame({ id: 'r1', type: 'request', channel: 'test:ping', args: [] })))
    const responseFrame = await phone.nextFrame('rpc response')
    const response = JSON.parse(String((JSON.parse(responseFrame) as Envelope).payload)) as { id: string; type: string; result?: string }
    expect(response.id).toBe('r1')
    expect(response.type).toBe('response')
    expect(response.result).toBe('pong-value')

    phone.close()
  }, 20_000)

  it('wraps embedded-server event pushes back into envelopes for the phone', async () => {
    const phone = new FakePhone(relay.url, 'p1')
    await phone.open()
    phone.sendEnvelope(phoneEnvelope(rpcFrame({
      id: 'h2', type: 'handshake', protocolVersion: PROTOCOL_VERSION, workspaceId: 'ws1', token: 'server-token',
    })))
    const ack = JSON.parse(String((JSON.parse(await phone.nextFrame('handshake_ack')) as Envelope).payload)) as { clientId: string }

    // Server pushes an event targeted at the phone's embedded-server client —
    // it must flow back through the bridge as an envelope (session:event path).
    embedded.push('session:event', { to: 'client', clientId: ack.clientId }, 'evt-arg')
    const eventFrame = await phone.nextFrame('event push')
    const event = JSON.parse(String((JSON.parse(eventFrame) as Envelope).payload)) as { type: string; channel?: string; args?: string[] }
    expect(event.type).toBe('event')
    expect(event.channel).toBe('session:event')
    expect(event.args).toEqual(['evt-arg'])

    phone.close()
  }, 20_000)

  it('broadcasts status changes (online-relay → offline → back) with debounce', async () => {
    broadcasts = []
    expect(RPC_CHANNELS.relay.STATUS_CHANGED).toBe('relay:statusChanged')
    expect(link!.getChannel()).toBe('relay:statusChanged')
    link!.stop() // recycle the link so reconnect timers restart clean

    link = makeLink()
    link.start()
    await waitFor(() => broadcasts.some((b) => b.status === 'online-relay') ? true : undefined, 'first online-relay')

    // Take the relay down → the existing client must report offline.
    relay.stop()
    await waitFor(() => broadcasts.some((b) => b.status === 'offline') ? true : undefined, 'offline after relay down')

    // Restart the relay on the same port → backoff reconnect succeeds.
    relay = startMockRelay(relay.port)
    await waitFor(() => {
      const last = broadcasts[broadcasts.length - 1]
      return last?.status === 'online-relay' ? true : undefined
    }, 'online-relay after reconnect', 8000)
    // Debounce: every broadcast is a state transition, none repeated back-to-back.
    for (let i = 1; i < broadcasts.length; i++) {
      expect(broadcasts[i]!.status).not.toBe(broadcasts[i - 1]!.status)
    }
  }, 30_000)

  it('never crashes on invalid frames and keeps routing valid ones', async () => {
    const phone = new FakePhone(relay.url, 'p1')
    await phone.open()
    phone.sendEnvelope(phoneEnvelope(rpcFrame({
      id: 'h3', type: 'handshake', protocolVersion: PROTOCOL_VERSION, workspaceId: 'ws1', token: 'server-token',
    })))
    await phone.nextFrame('handshake_ack')

    const invalidBefore = link!.client.invalidFrames
    const droppedBefore = link!.bridge.droppedCount
    // Garbage that never passes a real relay is injected raw: the client must
    // count it and stay up (the heartbeat-shaped frame is answered, silently).
    relay.injectRaw(MAC_PERSONA, 'this is not json')
    relay.injectRaw(MAC_PERSONA, JSON.stringify({ v: 99, from: 'x' }))
    relay.injectRaw(MAC_PERSONA, JSON.stringify({ type: 'ping' }))
    // A well-formed envelope whose payload is not a raw WsRpc frame string.
    phone.sendEnvelope(phoneEnvelope({ notEvenAFrame: true }))

    // Valid traffic still flows after the garbage (match by request id — the
    // heartbeat pong above is a raw frame, not an envelope).
    phone.sendEnvelope(phoneEnvelope(rpcFrame({ id: 'r3', type: 'request', channel: 'test:ping', args: [] })))
    const responseFrame = await waitFor(
      () => phone.envelopes()
        .map((e) => JSON.parse(String(e.payload)) as { id?: string; type?: string })
        .find((f) => f.type === 'response' && f.id === 'r3'),
      'rpc response after garbage',
    )
    expect(responseFrame.id).toBe('r3')
    expect(link!.client.invalidFrames).toBeGreaterThanOrEqual(invalidBefore + 2) // non-JSON + bad envelope
    expect(link!.bridge.droppedCount).toBeGreaterThan(droppedBefore) // non-string payload
    expect(link!.client.isConnected).toBe(true)
    phone.close()
  }, 20_000)

  it('retires a phone loopback socket on peer_disconnected control receipt', async () => {
    const phone = new FakePhone(relay.url, 'p1')
    await phone.open()
    phone.sendEnvelope(phoneEnvelope(rpcFrame({
      id: 'h4', type: 'handshake', protocolVersion: PROTOCOL_VERSION, workspaceId: 'ws1', token: 'server-token',
    })))
    await phone.nextFrame('handshake_ack')
    expect(link!.bridge.getActivePersonas()).toContain(PHONE_PERSONA)

    relay.sendControl(MAC_PERSONA, { type: 'peer_disconnected', peer: PHONE_PERSONA })
    await waitFor(() => link!.bridge.getActivePersonas().includes(PHONE_PERSONA) ? undefined : true, 'persona retired')
    phone.close()
  }, 20_000)

  it('classifies external embedded-server clients as online-lan once the relay link is down', async () => {
    // Fresh link with the relay down (status ranking: relay > lan — the
    // online-relay state would otherwise mask online-lan).
    relay.stop()
    link!.stop()
    broadcasts = []
    link = makeLink()
    link.start()
    await waitFor(() => broadcasts.some((b) => b.status === 'offline') ? true : undefined, 'offline baseline')

    // Direct, non-relay external client on the embedded server (LAN-like).
    const direct = new NodeWebSocket(`ws://127.0.0.1:${embedded.port}`)
    await new Promise<void>((resolve, reject) => {
      direct.on('open', () => resolve())
      direct.on('error', reject)
    })
    direct.send(rpcFrame({ id: 'hd', type: 'handshake', protocolVersion: PROTOCOL_VERSION, workspaceId: 'wsd', token: 'server-token' }))
    await waitFor(() => broadcasts.some((b) => b.status === 'online-lan') ? true : undefined, 'online-lan via external client', 6000)
    direct.close()
    await waitFor(() => broadcasts.some((b) => b.status === 'offline') ? true : undefined, 'offline after direct client left')
  }, 20_000)

  it('never counts renderer-window clients (webContentsId set) as online-lan', async () => {
    relay.stop()
    link!.stop()
    broadcasts = []
    link = makeLink()
    link.start()
    await waitFor(() => broadcasts.some((b) => b.status === 'offline') ? true : undefined, 'offline baseline')

    // A renderer window carries a webContentsId in its handshake; it is
    // always connected in UI mode, so counting it would pin online-lan.
    const renderer = new NodeWebSocket(`ws://127.0.0.1:${embedded.port}`)
    await new Promise<void>((resolve, reject) => {
      renderer.on('open', () => resolve())
      renderer.on('error', reject)
    })
    renderer.send(rpcFrame({
      id: 'hr', type: 'handshake', protocolVersion: PROTOCOL_VERSION,
      workspaceId: 'wsr', token: 'server-token', webContentsId: 7,
    }))
    await Bun.sleep(250) // > externalClassifyDelayMs + status debounce
    expect(broadcasts.some((b) => b.status === 'online-lan')).toBe(false)
    renderer.close()
    await waitFor(() => broadcasts.some((b) => b.status === 'offline') ? true : undefined, 'still offline after renderer client left', 3000)
  }, 20_000)
})
