/**
 * RelayLoopbackBridge (POL-237) — injects relay-routed phone traffic into the
 * embedded WsRpcServer as if each phone were a local WebSocket client.
 *
 * Design (card step 4, refined against the actual transport code):
 * the embedded WsRpcServer builds its own listener and speaks the WsRpc
 * protocol end-to-end (handshake at server.ts:441 validates `envelope.token`
 * against the server token, per-client request correlation, replay, heartbeat).
 * To reuse ALL of that with zero server-core changes, the bridge opens one raw
 * loopback WebSocket per phone persona (`phone:<id>`) against
 * `${instance.protocol}://127.0.0.1:${instance.port}` and pumps bytes both ways:
 *
 *   phone → relay → Mac client → bridge: `envelope.payload` (a string holding
 *     the raw WsRpc frame — the phone's own WsRpc handshake incl. paired server
 *     token, requests, acks) is written to the loopback socket untouched.
 *   embedded server → loopback socket → bridge: raw WsRpc frames
 *     (handshake_ack, responses, `session:event` pushes) are wrapped into
 *     `{v:1, from:"mac:<id>", to:<phone>, kind:"rpc", payload:<frame>}` and sent
 *     back through the relay, which routes them to the originating phone.
 *
 * Per-phone sockets (not one shared WsRpcClient) are what make this correct:
 * each phone gets its own server clientId, its own handshake/replay state, and
 * event pushes targeted at that client come back on its own socket — a single
 * multiplexed client could not demultiplex responses across phones.
 *
 * The sockets are pure pipes: the bridge never interprets WsRpc semantics,
 * except sniffing `handshake_ack` once per socket to learn the server-assigned
 * clientId (used to exclude bridge sockets from the `online-lan` status input).
 */

import { WebSocket as NodeWebSocket } from 'ws'
import type { CompatibleWebSocket } from './client'

export const RELAY_ENVELOPE_KIND_RPC = 'rpc'

/** Default idle lifetime for a phone's loopback socket (no relay traffic). */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
/** Grace before a closed socket's bookkeeping is considered settled. */
const WS_CONNECTING = 0
const WS_OPEN = 1

export interface LoopbackBridgeOptions {
  protocol: 'ws' | 'wss'
  port: number
  logger?: BridgeLogger
  /** Injectable socket factory (tests). */
  createSocket?: (url: string) => CompatibleWebSocket
  /** Idle sweep window. Default 10 min. */
  idleTimeoutMs?: number
  /** Idle sweep interval. Default 60s. Set 0 to disable (tests). */
  sweepIntervalMs?: number
}

export interface BridgeLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

interface PhonePipe {
  ws: CompatibleWebSocket
  /** Server-assigned WsRpc clientId, sniffed from the passing handshake_ack. */
  clientId: string | null
  lastActivityAt: number
  /** Frames received while the socket was still connecting. */
  pending: string[]
}

export class RelayLoopbackBridge {
  private readonly pipes = new Map<string, PhonePipe>()
  private droppedPayloads = 0

  private readonly protocol: 'ws' | 'wss'
  private readonly port: number
  private readonly log: BridgeLogger
  private readonly socketFactory: (url: string) => CompatibleWebSocket
  private readonly idleTimeoutMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  /** Called with (phone persona, raw WsRpc frame) for server→phone frames. */
  onFrame: ((persona: string, frame: string) => void) | null = null

  constructor(options: LoopbackBridgeOptions) {
    this.protocol = options.protocol
    this.port = options.port
    this.log = options.logger ?? { info() {}, warn() {} }
    this.socketFactory = options.createSocket ?? defaultBridgeSocketFactory
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), sweepIntervalMs)
      this.sweepTimer.unref?.()
    }
  }

  // -------------------------------------------------------------------------
  // Phone → Mac (injection into the embedded server)
  // -------------------------------------------------------------------------

  /**
   * Handles a relay envelope addressed to this Mac. The payload must be a
   * string holding a raw WsRpc frame; anything else is dropped (counted,
   * never thrown).
   */
  handlePhoneEnvelope(persona: string, payload: unknown): void {
    if (typeof payload !== 'string' || payload.length === 0) {
      this.droppedPayloads++
      this.log.warn(`[relay-bridge] dropped non-string payload from=${persona}`)
      return
    }

    // The embedded server only processes a WsRpc handshake on a fresh socket.
    // When a phone reconnects over the relay (its previous relay socket died
    // without a peer_disconnected receipt reaching us), its handshake frame
    // must land on a NEW loopback socket — recycle the stale pipe instead of
    // letting the handshake be silently ignored post-handshake.
    if (looksLikeHandshakeFrame(payload)) {
      const existing = this.pipes.get(persona)
      if (existing && existing.clientId !== null) {
        this.log.info(`[relay-bridge] recycling completed pipe for reconnecting persona=${persona}`)
        this.closePersona(persona)
      }
    }

    const pipe = this.ensurePipe(persona)
    if (pipe.ws.readyState === WS_OPEN) {
      try {
        pipe.ws.send(payload)
      } catch (err) {
        this.log.warn(`[relay-bridge] send to loopback failed persona=${persona}:`, err instanceof Error ? err.message : String(err))
      }
      return
    }
    // Socket still connecting — queue the frame, flushed on open.
    pipe.pending.push(payload)
  }

  /** Closes one phone's loopback socket (peer_disconnected receipt / cleanup). */
  closePersona(persona: string): void {
    const pipe = this.pipes.get(persona)
    if (!pipe) return
    this.pipes.delete(persona)
    try { pipe.ws.close(1000, 'peer_disconnected') } catch { try { pipe.ws.terminate() } catch { /* gone */ } }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Server-assigned WsRpc clientIds currently owned by bridge sockets. */
  getManagedClientIds(): Set<string> {
    const ids = new Set<string>()
    for (const pipe of this.pipes.values()) {
      if (pipe.clientId) ids.add(pipe.clientId)
    }
    return ids
  }

  isManagedClientId(clientId: string): boolean {
    for (const pipe of this.pipes.values()) {
      if (pipe.clientId === clientId) return true
    }
    return false
  }

  getActivePersonas(): string[] {
    return [...this.pipes.keys()]
  }

  get droppedCount(): number {
    return this.droppedPayloads
  }

  destroy(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
    for (const [persona] of this.pipes) {
      this.closePersona(persona)
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensurePipe(persona: string): PhonePipe {
    const existing = this.pipes.get(persona)
    if (existing) {
      const state = existing.ws.readyState
      if (state === WS_OPEN || state === WS_CONNECTING) return existing
      // Dead socket — drop and rebuild.
      this.pipes.delete(persona)
      try { existing.ws.terminate() } catch { /* gone */ }
    }

    const url = `${this.protocol}://127.0.0.1:${this.port}`
    const ws = this.socketFactory(url)
    const pipe: PhonePipe = { ws, clientId: null, lastActivityAt: Date.now(), pending: [] }
    this.pipes.set(persona, pipe)

    ws.on('open', () => {
      if (this.pipes.get(persona) !== pipe) return
      this.log.info(`[relay-bridge] loopback open persona=${persona}`)
      const pending = pipe.pending.splice(0)
      for (const frame of pending) {
        try { ws.send(frame) } catch (err) {
          this.log.warn(`[relay-bridge] flush failed persona=${persona}:`, err instanceof Error ? err.message : String(err))
        }
      }
    })

    ws.on('message', (data) => {
      if (this.pipes.get(persona) !== pipe) return
      pipe.lastActivityAt = Date.now()
      const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
      this.sniffClientId(persona, pipe, text)
      try {
        this.onFrame?.(persona, text)
      } catch (err) {
        this.log.warn(`[relay-bridge] onFrame handler failed persona=${persona}:`, err instanceof Error ? err.message : String(err))
      }
    })

    ws.on('close', () => {
      if (this.pipes.get(persona) !== pipe) return
      this.log.info(`[relay-bridge] loopback closed persona=${persona}`)
      this.pipes.delete(persona)
    })

    ws.on('error', () => {
      // 'close' always follows — no logging to avoid noisy offline churn.
      if (this.pipes.get(persona) !== pipe) return
      try { ws.terminate() } catch { /* gone */ }
    })

    return pipe
  }

  /** One-time sniff of `handshake_ack` to learn the server-assigned clientId. */
  private sniffClientId(persona: string, pipe: PhonePipe, frame: string): void {
    if (pipe.clientId) return
    if (!frame.includes('handshake_ack')) return
    try {
      const parsed: unknown = JSON.parse(frame)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        if (record['type'] === 'handshake_ack' && typeof record['clientId'] === 'string') {
          pipe.clientId = record['clientId']
          this.log.info(`[relay-bridge] persona=${persona} clientId=${pipe.clientId}`)
        }
      }
    } catch {
      // Not JSON / not an ack — irrelevant, the frame still passes through.
    }
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.idleTimeoutMs
    for (const [persona, pipe] of this.pipes) {
      if (pipe.lastActivityAt < cutoff) {
        this.log.info(`[relay-bridge] idle sweep persona=${persona}`)
        this.closePersona(persona)
      }
    }
  }
}

function defaultBridgeSocketFactory(url: string): CompatibleWebSocket {
  // Embedded server may run wss with a self-signed local cert; mirror the
  // relaxation used by every other loopback client (WsRpcClient precedent).
  const options = url.startsWith('wss://') ? { rejectUnauthorized: false } : {}
  return new NodeWebSocket(url, options) as unknown as CompatibleWebSocket
}

/**
 * Cheap pre-filter + targeted check for a client WsRpc handshake frame
 * (`{"type":"handshake",...}`). Only used to detect phone reconnects; the
 * frame itself is forwarded untouched either way.
 */
function looksLikeHandshakeFrame(frame: string): boolean {
  if (!frame.includes('"handshake"')) return false
  try {
    const parsed: unknown = JSON.parse(frame)
    return typeof parsed === 'object' && parsed !== null
      && (parsed as Record<string, unknown>)['type'] === 'handshake'
  } catch {
    return false
  }
}
