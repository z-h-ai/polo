/**
 * RelayClient — outbound WSS envelope client to polo-relay (POL-237, PRD v1.6 §⑥).
 *
 * Protocol alignment with packages/relay (M1-4, verified against src/server.ts
 * and src/envelope.ts — do not guess from the card):
 *   - Handshake happens at HTTP upgrade: `Authorization: Bearer <admin JWT>`
 *     header (preferred by the relay — keeps the token out of intermediary
 *     access logs) plus `?side=mac&deviceId=<id>` query params. There is NO
 *     in-band first frame; the relay authenticates during the upgrade and
 *     closes with 401/403 before the socket opens on rejection.
 *   - Frames: `{v:1,from,to,kind,payload,queuedAt?}` envelopes (JSON text).
 *     `kind:"control"` is reserved for relay→client receipts; clients must
 *     never send it (the relay drops client-sent control envelopes).
 *   - Heartbeat: the server sends `{type:"ping"}` every 30s; answering
 *     `{type:"pong"}` (and any other frame) counts as liveness evidence. A
 *     connection with no evidence for 60s is killed server-side, so this
 *     client answers every ping and force-recycles the socket if no server
 *     frame arrives within `livenessTimeoutMs`.
 *   - Close codes: 4401 unauthorized / 4403 forbidden (auth), 4009 replaced
 *     (another connection took the persona), 4008 rate limit, 4000 heartbeat.
 *
 * Reconnect: exponential backoff (base 1s, doubling, capped at 30s) with
 * ±20% jitter; the attempt counter resets after a stable connection
 * (same mental model as server-core WsRpcClient.scheduleBackoffReset).
 */

import { WebSocket as NodeWebSocket } from 'ws'
import {
  HeartbeatFrameSchema,
  EnvelopeSchema,
  serializeEnvelope,
  type Envelope,
} from '@polo-ai/relay/envelope'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RelayCloseInfo {
  code?: number
  reason?: string
}

export interface RelayClientOptions {
  /** Returns the relay endpoint for each attempt (null → stay offline). */
  resolveUrl: () => string | null
  /** Returns the admin JWT for each attempt (null → skip the attempt). */
  tokenProvider: () => Promise<string | null>
  /** Stable device id — relay persona `mac:<deviceId>`. */
  deviceId: string
  /** Backoff base in ms. Default 1000. */
  baseReconnectDelayMs?: number
  /** Backoff cap in ms. Default 30_000 (per card). */
  maxReconnectDelayMs?: number
  /** Attempt counter resets after the connection stayed open this long. Default 10_000. */
  stableResetMs?: number
  /** Force-recycle when no server frame arrives within this window. Default 90_000. */
  livenessTimeoutMs?: number
  /** Injectable socket factory (tests). Default: `ws` WebSocket. */
  createWebSocket?: (url: string, headers: Record<string, string>) => CompatibleWebSocket
  /** Injectable RNG for jitter (tests). Default: Math.random. */
  random?: () => number
  logger?: RelayClientLogger
}

export interface RelayClientLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** Minimal structural surface of a `ws`-like client socket used here. */
export interface CompatibleWebSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'unexpected-response', listener: (req: unknown, res: { statusCode?: number }) => void): unknown
  removeAllListeners?(): void
}

export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000
const DEFAULT_BASE_RECONNECT_DELAY_MS = 1_000
const DEFAULT_STABLE_RESET_MS = 10_000
const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000
/** ws readyState values (mirrored to avoid importing ws constants everywhere). */
const WS_OPEN = 1
const WS_CONNECTING = 0

// ---------------------------------------------------------------------------
// Backoff (pure — unit tested)
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with cap and ±20% jitter: base * 2^attempt, capped.
 * attempt is 0-based (first retry uses `base`).
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS
  const max = options.maxMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
  const rng = options.random ?? Math.random
  const capped = Math.min(base * Math.pow(2, Math.max(0, attempt)), max)
  const jitter = 0.8 + rng() * 0.4
  return Math.round(capped * jitter)
}

// ---------------------------------------------------------------------------
// RelayClient
// ---------------------------------------------------------------------------

export class RelayClient {
  private ws: CompatibleWebSocket | null = null
  private stopped = true
  private connected = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stableResetTimer: ReturnType<typeof setTimeout> | null = null
  private livenessTimer: ReturnType<typeof setTimeout> | null = null

  private lastClose: RelayCloseInfo | null = null
  private invalidFrameCount = 0

  private readonly resolveUrl: () => string | null
  private readonly tokenProvider: () => Promise<string | null>
  private readonly deviceId: string
  private readonly baseReconnectDelayMs: number
  private readonly maxReconnectDelayMs: number
  private readonly stableResetMs: number
  private readonly livenessTimeoutMs: number
  private readonly random: () => number
  private readonly socketFactory: (url: string, headers: Record<string, string>) => CompatibleWebSocket
  private readonly log: RelayClientLogger

  private onConnectedCb: (() => void) | null = null
  private onDisconnectedCb: ((close: RelayCloseInfo) => void) | null = null
  private onEnvelopeCb: ((envelope: Envelope) => void) | null = null
  private onPeerDisconnectedCb: ((peer: string) => void) | null = null

  constructor(options: RelayClientOptions) {
    this.resolveUrl = options.resolveUrl
    this.tokenProvider = options.tokenProvider
    this.deviceId = options.deviceId
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
    this.stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS
    this.livenessTimeoutMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS
    this.random = options.random ?? Math.random
    this.socketFactory = options.createWebSocket ?? defaultSocketFactory
    this.log = options.logger ?? { info() {}, warn() {}, error() {} }
  }

  // -- event wiring ---------------------------------------------------------

  onConnected(cb: () => void): void { this.onConnectedCb = cb }
  onDisconnected(cb: (close: RelayCloseInfo) => void): void { this.onDisconnectedCb = cb }
  /** Envelopes routed to this Mac (phone→Mac payloads; excludes control receipts). */
  onEnvelope(cb: (envelope: Envelope) => void): void { this.onEnvelopeCb = cb }
  /** Relay told us a peer (e.g. `phone:<id>`) disconnected. */
  onPeerDisconnected(cb: (peer: string) => void): void { this.onPeerDisconnectedCb = cb }

  // -- lifecycle ------------------------------------------------------------

  /** Starts the connect loop. Idempotent. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.reconnectAttempt = 0
    this.connectAttempt()
  }

  /** Stops permanently (no further reconnects). */
  stop(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (ws) {
      try { ws.removeAllListeners?.() } catch { /* best effort */ }
      try { ws.close(1000, 'client_stop') } catch { try { ws.terminate() } catch { /* gone */ } }
    }
    this.setConnected(false)
  }

  get isConnected(): boolean {
    return this.connected
  }

  /** Current backoff attempt (0 = connected / first attempt pending). */
  get attempt(): number {
    return this.reconnectAttempt
  }

  get lastCloseInfo(): RelayCloseInfo | null {
    return this.lastClose
  }

  /** Frames that failed envelope AND heartbeat parsing (never crash the client). */
  get invalidFrames(): number {
    return this.invalidFrameCount
  }

  /** Sends an envelope to `to` (e.g. `phone:<id>`). Returns false when offline. */
  sendEnvelope(to: string, kind: string, payload: unknown): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WS_OPEN) return false
    const envelope: Envelope = {
      v: 1,
      from: `mac:${this.deviceId}`,
      to,
      kind,
      payload,
    }
    try {
      ws.send(serializeEnvelope(envelope))
      return true
    } catch (err) {
      this.log.warn('[relay-client] send failed:', err instanceof Error ? err.message : String(err))
      return false
    }
  }

  // -- internals ------------------------------------------------------------

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.stableResetTimer) { clearTimeout(this.stableResetTimer); this.stableResetTimer = null }
    if (this.livenessTimer) { clearTimeout(this.livenessTimer); this.livenessTimer = null }
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    if (connected) {
      this.onConnectedCb?.()
    } else {
      this.onDisconnectedCb?.(this.lastClose ?? {})
    }
  }

  private connectAttempt(): void {
    if (this.stopped) return
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }

    const url = this.resolveUrl()
    if (!url) {
      // Not configured (yet) — retry on the normal backoff cadence so a URL
      // injected at runtime (admin override / settings) is picked up.
      this.log.info('[relay-client] no relay URL configured — staying offline')
      this.scheduleReconnect()
      return
    }

    void this.tokenProvider().then((token) => {
      if (this.stopped) return
      if (!token) {
        this.log.info('[relay-client] no admin token (not logged in) — staying offline')
        this.scheduleReconnect()
        return
      }
      this.openSocket(url, token)
    }).catch((err) => {
      this.log.warn('[relay-client] token provider failed:', err instanceof Error ? err.message : String(err))
      this.scheduleReconnect()
    })
  }

  private openSocket(url: string, token: string): void {
    // Detach any previous socket.
    if (this.ws) {
      const old = this.ws
      this.ws = null
      try { old.removeAllListeners?.() } catch { /* best effort */ }
      try { old.close() } catch { /* best effort */ }
    }

    const ws = this.socketFactory(buildRelayHandshakeUrl(url, this.deviceId), { authorization: `Bearer ${token}` })
    this.ws = ws
    // Set when the relay rejected the HTTP upgrade — preserved across the
    // info-free 1006 close that our forced abort produces.
    let upgradeRejected: RelayCloseInfo | null = null

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.log.info(`[relay-client] connected url=${maskUrl(url)} deviceId=${this.deviceId}`)
      this.lastClose = null
      this.setConnected(true)
      this.touchLiveness()
      // Reset the backoff counter only after the connection proved stable.
      if (this.stableResetTimer) clearTimeout(this.stableResetTimer)
      this.stableResetTimer = setTimeout(() => {
        this.stableResetTimer = null
        this.reconnectAttempt = 0
      }, this.stableResetMs)
    })

    ws.on('message', (data) => {
      if (this.ws !== ws) return
      this.touchLiveness()
      const text = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBuffer)))).toString('utf8')
            : String(data)
      this.handleFrame(text)
    })

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      this.ws = null
      // A 1006 after an upgrade rejection is just our own forced abort — keep
      // the richer 401/403 record for diagnostics.
      if (!(code === 1006 && upgradeRejected)) {
        this.lastClose = { code, reason: reason?.toString?.() || undefined }
      }
      this.log.info(`[relay-client] closed code=${code} reason=${this.lastClose?.reason ?? '-'}`)
      this.setConnected(false)
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      if (this.ws !== ws) return
      // 'close' follows; logged here for diagnostics only.
      this.log.warn('[relay-client] socket error:', err instanceof Error ? err.message : String(err))
    })

    ws.on('unexpected-response', (_req, res) => {
      if (this.ws !== ws) return
      // Relay rejects the upgrade with 401/403 before any socket opens.
      upgradeRejected = { code: res.statusCode, reason: 'upgrade_rejected' }
      this.lastClose = upgradeRejected
      this.log.warn(`[relay-client] upgrade rejected status=${res.statusCode}`)
      // ws emits 'unexpected-response' to a registered listener WITHOUT
      // aborting the handshake and WITHOUT any error/close follow-up
      // (websocket.js:929 — the abort only runs when no listener is attached),
      // so the socket would otherwise stall in CONNECTING forever. Force the
      // close (abortHandshake emits error+close) to reach scheduleReconnect.
      try { ws.close() } catch { try { ws.terminate() } catch { /* gone */ } }
    })
  }

  private handleFrame(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.invalidFrameCount++
      this.log.warn('[relay-client] dropped non-JSON frame')
      return
    }

    // Heartbeat frames are transport-level, never routed.
    const heartbeat = HeartbeatFrameSchema.safeParse(parsed)
    if (heartbeat.success) {
      if (heartbeat.data.type === 'ping') {
        try { this.ws?.send(JSON.stringify({ type: 'pong' })) } catch { /* socket dying */ }
      }
      return
    }

    const parsedEnvelope = EnvelopeSchema.safeParse(parsed)
    if (!parsedEnvelope.success) {
      this.invalidFrameCount++
      this.log.warn('[relay-client] dropped invalid envelope')
      return
    }

    const envelope = parsedEnvelope.data as Envelope
    if (envelope.kind === 'control') {
      // Receipts from the `relay` pseudo-persona (metadata only, never payload).
      const control = envelope.payload as { type?: string; peer?: string } | null
      if (control && control.type === 'peer_disconnected' && typeof control.peer === 'string') {
        this.onPeerDisconnectedCb?.(control.peer)
      }
      return
    }

    this.onEnvelopeCb?.(envelope)
  }

  private touchLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null
      const ws = this.ws
      if (!ws || ws.readyState !== WS_OPEN) return
      this.log.warn('[relay-client] no server frame within liveness window — recycling socket')
      try { ws.terminate() } catch { /* gone */ }
    }, this.livenessTimeoutMs)
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = computeBackoffDelayMs(this.reconnectAttempt, {
      baseMs: this.baseReconnectDelayMs,
      maxMs: this.maxReconnectDelayMs,
      random: this.random,
    })
    this.reconnectAttempt++
    this.log.info(`[relay-client] reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectAttempt()
    }, delay)
  }
}

/**
 * Appends the relay handshake query params (`side=mac&deviceId=<id>`) — the
 * relay reads side/deviceId from the query and the token from the
 * Authorization header (or `?token=`, which we avoid: header keeps the token
 * out of intermediary access logs).
 */
export function buildRelayHandshakeUrl(url: string, deviceId: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('side', 'mac')
    parsed.searchParams.set('deviceId', deviceId)
    return parsed.toString()
  } catch {
    return url
  }
}

function defaultSocketFactory(url: string, headers: Record<string, string>): CompatibleWebSocket {
  // Loopback-embedded servers may use self-signed TLS (wss) — the embedded
  // server's own clients use the same relaxation (see WsRpcClient). The relay
  // endpoint is public-internet TLS terminated by the platform.
  const options = url.startsWith('wss://') ? { headers, rejectUnauthorized: false } : { headers }
  return new NodeWebSocket(url, options) as unknown as CompatibleWebSocket
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return 'invalid-url'
  }
}

// Re-exported for bridge tests that classify socket readiness.
export const SOCKET_READY_STATE = { CONNECTING: WS_CONNECTING, OPEN: WS_OPEN } as const
