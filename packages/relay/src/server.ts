/**
 * polo-relay server (POL-11, PRD v1.6 §⑥): a stateless, DB-free WebSocket
 * envelope dumb-router. Mac and phone each dial out over WSS; the relay routes
 * `{v,from,to,kind,payload,queuedAt}` envelopes without interpreting WsRpc
 * semantics.
 *
 * - Handshake: `?token=<admin JWT>&side=phone|mac&deviceId=<id>`; dual-layer
 *   auth (local HS256 + admin introspection, 60s cache). Mac side additionally
 *   proves its binding via check-access.
 * - Revocation recheck (FIX-4): an independent timer (POLO_RELAY_REVOKE_RECHECK_MS,
 *   default 15s) re-introspects every online connection bypassing the auth
 *   cache, so a revoked token is closed 4401 within ~15s — inside the PRD §⑤
 *   60s promise — instead of authCacheTtl(60s)+heartbeat(30s) ≈ 90s worst case.
 *   Admin unreachable → skip the round, degraded semantics untouched.
 * - Routing: phone→mac requires check-access (60s cache, 401/403 → close);
 *   offline Macs stage envelopes in the 5-minute in-memory queue.
 * - Heartbeat: server app-level `{type:"ping"}` every 30s; a connection with
 *   no liveness evidence for 60s is terminated and its recent peers get
 *   `{type:"peer_disconnected"}`.
 * - Rate limit: per-connection sliding window, over-limit → close 4008.
 * - `/asr` (POL-20): streaming ASR proxy upgrade path — same dual-layer auth,
 *   own frames/close codes, billing prehold→settle埋点. Envelope routing
 *   semantics on every other path are unchanged (纯新增路径).
 *
 * Bun.serve usage follows the repo precedent in
 * packages/server-core/src/bootstrap/headless-start.ts (and the POL-7 PoC in
 * dev/infra/zeabur-ws-poc/echo.ts). No payload is ever logged or persisted.
 */

import type { Server, ServerWebSocket } from 'bun'
import { AdminClient, RelayAuth, type RelayJwtOptions } from './auth.ts'
import type { RelayConfig } from './config.ts'
import {
  EnvelopeSchema,
  HeartbeatFrameSchema,
  buildControlEnvelope,
  parsePersona,
  serializeEnvelope,
  type ControlPayload,
  type Envelope,
  type PersonaSide,
} from './envelope.ts'
import { OfflineQueue, type QueueEntry } from './queue.ts'
import { SlidingWindowLimiter } from './ratelimit.ts'
import { createDefaultAsrService, type AsrConnectionState, type AsrService, type AsrWsLike } from './asr/service.ts'

export const CLOSE_CODE = {
  RATE_LIMITED: 4008,
  HEARTBEAT_TIMEOUT: 4000,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  REPLACED: 4009,
} as const

const RECENT_PEERS_CAP = 100

export interface ConnectionIdentity {
  side: PersonaSide
  userId: string
  deviceId: string
  /** Canonical `phone:<id>` / `mac:<id>` persona used as envelope from/to key. */
  persona: string
  /** Kept in memory only (needed for cached admin calls); never logged. */
  token: string
}

export interface WsData {
  connId: number
  identity: ConnectionIdentity
  lastPongAt: number
  lastAuthAt: number
  limiter: SlidingWindowLimiter
  recentPeers: Set<string>
  /** Set only for /asr streaming connections (POL-20); envelope connections never have it. */
  asr?: AsrConnectionState
}

export interface RelayLogger {
  (line: string): void
}

export interface StartRelayServerOptions {
  config: RelayConfig
  /** Injectable for tests; defaults to an AdminClient against config.adminBaseUrl. */
  adminClient?: AdminClient
  auth?: RelayAuth
  logger?: RelayLogger
  /** Injectable clock for tests. */
  now?: () => number
  /**
   * /asr streaming pipeline (POL-20). Defaults to the env-backed assembly
   * (volcano + mock adapters); `null` disables the /asr path entirely.
   */
  asr?: AsrService | null
}

export interface RelayServerHandle {
  server: Server<WsData>
  port: number
  queue: OfflineQueue
  stop(): void
}

export function startRelayServer(options: StartRelayServerOptions): RelayServerHandle {
  const config = options.config
  const now = options.now ?? Date.now
  const log: RelayLogger = options.logger ?? ((line) => console.log(`[relay] ${line}`))
  const admin = options.adminClient ?? new AdminClient({ baseUrl: config.adminBaseUrl })
  const jwt: RelayJwtOptions = {
    secret: config.jwtSecret,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  }
  const auth = options.auth ?? new RelayAuth(admin, jwt, { authCacheTtlMs: config.authCacheTtlMs, now })
  const asr = options.asr !== undefined
    ? options.asr
    : createDefaultAsrService({
        auth,
        adminBaseUrl: config.adminBaseUrl,
        maxMsgPerSec: config.maxMsgPerSec,
        logger: log,
        now,
        fileFinalWaitMs: config.asrFileFinalWaitMs,
      })

  const connections = new Map<string, ServerWebSocket<WsData>>()
  let nextConnId = 1

  const queue = new OfflineQueue({
    ttlMs: config.offlineQueueTtlMs,
    maxPerMac: config.offlineQueueMaxPerMac,
    onExpire: (entry) => notifyDeliveryFailed(entry.envelope.from, 'mac_offline', entry.ownerUserId),
  })

  function notifyDeliveryFailed(
    to: string,
    reason: Extract<ControlPayload, { type: 'delivery_failed' }>['reason'],
    ownerUserId?: string,
  ): void {
    const target = parsePersona(to)
    if (!target) return
    const ws = connections.get(target.persona)
    if (!ws) return
    // Receipts only ever flow to a connection owned by the user the event
    // belongs to — never to someone who grabbed the persona while the owner
    // was offline.
    if (ownerUserId !== undefined && ws.data.identity.userId !== ownerUserId) return
    log(`receipt to=${target.persona} type=delivery_failed reason=${reason}`)
    ws.send(serializeEnvelope(buildControlEnvelope(target.persona, { type: 'delivery_failed', reason }, now())))
  }

  function sendControl(persona: string, payload: ControlPayload): void {
    const ws = connections.get(persona)
    if (!ws) return
    ws.send(serializeEnvelope(buildControlEnvelope(persona, payload, now())))
  }

  function touchPeer(sender: ServerWebSocket<WsData>, peerPersona: string): void {
    if (sender.data.recentPeers.size >= RECENT_PEERS_CAP) return
    sender.data.recentPeers.add(peerPersona)
  }

  /** Tells the peers a dying connection used to talk to that it is gone. */
  function notifyPeersOfDisconnect(ws: ServerWebSocket<WsData>): void {
    for (const peer of ws.data.recentPeers) {
      if (peer !== ws.data.identity.persona) {
        sendControl(peer, { type: 'peer_disconnected', peer: ws.data.identity.persona })
      }
    }
    ws.data.recentPeers.clear()
  }

  function dropConnection(ws: ServerWebSocket<WsData>, code: number, reason: string): void {
    notifyPeersOfDisconnect(ws)
    try {
      ws.close(code, reason)
    } catch {
      ws.terminate()
    }
  }

  function deliverToPersona(persona: string, raw: string): boolean {
    const ws = connections.get(persona)
    if (!ws) return false
    ws.send(raw)
    return true
  }

  async function routeEnvelope(sender: ServerWebSocket<WsData>, envelope: Envelope, raw: string): Promise<void> {
    const target = parsePersona(envelope.to)
    const senderIdentity = sender.data.identity
    if (!target || envelope.to === 'relay') {
      log(`dropped reason=unroutable_to from=${senderIdentity.persona} connId=${sender.data.connId}`)
      return
    }
    // The relay only bridges phone<->mac; same-side delivery has no semantics.
    if (target.side === senderIdentity.side) {
      log(`dropped reason=same_side_route from=${senderIdentity.persona} to=${target.persona}`)
      return
    }

    if (target.side === 'mac') {
      if (senderIdentity.side === 'phone') {
        const access = await auth.checkAccess(senderIdentity.token, senderIdentity.userId, target.id)
        if (access === 'unauthorized') {
          log(`closed reason=access_unauthorized connId=${sender.data.connId}`)
          dropConnection(sender, CLOSE_CODE.UNAUTHORIZED, 'token_revoked')
          return
        }
        if (access === 'denied') {
          notifyDeliveryFailed(senderIdentity.persona, 'not_allowed')
          return
        }
        if (access === 'unreachable') {
          notifyDeliveryFailed(senderIdentity.persona, 'access_check_failed')
          return
        }
      }
      if (deliverToPersona(target.persona, raw)) {
        touchPeer(sender, target.persona)
        log(`routed from=${senderIdentity.persona} to=${target.persona} mode=direct`)
        return
      }
      const entry = queue.enqueue(target.id, envelope, senderIdentity.userId)
      if (!entry) {
        notifyDeliveryFailed(senderIdentity.persona, 'queue_full')
        return
      }
      touchPeer(sender, target.persona)
      log(`routed from=${senderIdentity.persona} to=${target.persona} mode=queued pending=${queue.pendingCount(target.id)}`)
      return
    }

    // target.side === 'phone'
    const peer = connections.get(target.persona)
    if (peer) {
      // A Mac may only reach phones belonging to the user it is bound to —
      // phone personas are claimed at handshake, so the relay re-checks the
      // owner here instead of trusting the route key alone.
      if (peer.data.identity.userId !== senderIdentity.userId) {
        log(`dropped reason=phone_not_owned from=${senderIdentity.persona} to=${target.persona}`)
        notifyDeliveryFailed(senderIdentity.persona, 'not_allowed')
        return
      }
      peer.send(raw)
      touchPeer(sender, target.persona)
      log(`routed from=${senderIdentity.persona} to=${target.persona} mode=direct`)
      return
    }
    log(`routed from=${senderIdentity.persona} to=${target.persona} mode=rejected_offline`)
    notifyDeliveryFailed(senderIdentity.persona, 'phone_offline')
  }

  function handleOpen(ws: ServerWebSocket<WsData>): void {
    const identity = ws.data.identity
    const existing = connections.get(identity.persona)
    if (existing && existing !== ws) {
      if (existing.data.identity.userId !== identity.userId) {
        // Cross-user persona takeover attempt: reject the newcomer and keep
        // the incumbent. A phone deviceId is claimed at handshake, so without
        // this check any logged-in user could hijack another user's persona.
        log(`rejected reason=persona_takeover persona=${identity.persona} connId=${ws.data.connId}`)
        ws.close(CLOSE_CODE.FORBIDDEN, 'persona_owned_by_other_user')
        return
      }
      log(`replaced persona=${identity.persona} oldConnId=${existing.data.connId}`)
      existing.close(CLOSE_CODE.REPLACED, 'replaced')
    }
    connections.set(identity.persona, ws)
    log(`connected side=${identity.side} userId=${identity.userId} deviceId=${identity.deviceId} connId=${ws.data.connId}`)

    if (identity.side === 'mac') {
      const drained = queue.drain(identity.deviceId)
      if (drained.length > 0) {
        log(`drained queue for=${identity.persona} count=${drained.length}`)
        // Deliver staged envelopes to the reconnecting Mac (their `to`), oldest first.
        for (const envelope of drained) {
          ws.send(serializeEnvelope(envelope))
        }
      }
    }
  }

  function handleMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    const ts = now()
    // Any inbound frame is liveness evidence.
    ws.data.lastPongAt = ts

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(text)
    } catch {
      parsedJson = undefined
    }

    const heartbeat = HeartbeatFrameSchema.safeParse(parsedJson)
    if (heartbeat.success) {
      if (heartbeat.data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: ts }))
      }
      return
    }

    if (!ws.data.limiter.check()) {
      log(`closed reason=rate_limited connId=${ws.data.connId} persona=${ws.data.identity.persona}`)
      dropConnection(ws, CLOSE_CODE.RATE_LIMITED, 'rate_limited')
      return
    }

    const parsed = EnvelopeSchema.safeParse(parsedJson)
    if (!parsed.success) {
      log(`dropped reason=bad_envelope connId=${ws.data.connId}`)
      return
    }
    const envelope = parsed.data as Envelope
    // `kind:"control"` is reserved for relay→client receipts/notifications.
    // Clients never send it, and letting it through would let a malicious peer
    // forge e.g. peer_disconnected / delivery_failed signals.
    if (envelope.kind === 'control') {
      log(`dropped reason=control_kind_reserved connId=${ws.data.connId}`)
      return
    }
    if (envelope.from !== ws.data.identity.persona) {
      log(`closed reason=from_mismatch connId=${ws.data.connId} persona=${ws.data.identity.persona}`)
      dropConnection(ws, CLOSE_CODE.FORBIDDEN, 'from_mismatch')
      return
    }
    void routeEnvelope(ws, envelope, text)
  }

  function handleClose(ws: ServerWebSocket<WsData>, code: number | undefined, reason: string | undefined): void {
    const identity = ws.data.identity
    if (connections.get(identity.persona) === ws) {
      connections.delete(identity.persona)
    }
    log(`disconnected side=${identity.side} deviceId=${identity.deviceId} connId=${ws.data.connId} code=${code} reason=${reason || '-'}`)
    notifyPeersOfDisconnect(ws)
  }

  // Per-tick liveness sweep + cache hygiene (expired auth-cache entries would
  // otherwise linger forever when their keys are never re-read).
  function heartbeatTimerTick(): void {
    const ts = now()
    auth.sweepCaches()
    for (const [persona, ws] of connections) {
      if (ts - ws.data.lastPongAt > config.heartbeatTimeoutMs) {
        log(`closed reason=heartbeat_timeout persona=${persona} connId=${ws.data.connId}`)
        notifyPeersOfDisconnect(ws)
        ws.terminate()
        continue
      }
      if (ts - ws.data.lastAuthAt >= config.authCacheTtlMs) {
        ws.data.lastAuthAt = ts
        const token = ws.data.identity.token
        const connId = ws.data.connId
        void auth.authenticate(token).then((result) => {
          if (result.ok) return
          if (connections.get(persona)?.data.connId !== connId) return
          log(`closed reason=token_revoked persona=${persona} connId=${connId}`)
          dropConnection(connections.get(persona)!, CLOSE_CODE.UNAUTHORIZED, 'token_revoked')
        })
      }
      ws.send(JSON.stringify({ type: 'ping', t: ts }))
    }
  }

  const heartbeatTimer = config.heartbeatIntervalMs > 0
    ? setInterval(heartbeatTimerTick, config.heartbeatIntervalMs)
    : null
  heartbeatTimer?.unref?.()

  // FIX-4 (PRD §⑤「最长 60 秒内全网断开」): independent revocation-recheck timer.
  // The legacy path only re-authenticates within [authCacheTtl(60s) + heartbeat
  // sweep(30s)] ≈ 90s worst case. This sweep bypasses the auth cache entirely
  // and re-introspects every online connection against admin every
  // revokeRecheckMs (default 15s), so revocation lands in ≤ interval + one RTT.
  // Connection count is small per PRD, so the extra introspection load is
  // bounded; admin unreachable → skip the round (debug log), degraded
  // semantics untouched.
  async function revokeRecheckTick(): Promise<void> {
    const targets = [...connections.values()]
    await Promise.all(targets.map((ws) => recheckConnection(ws)))
  }

  async function recheckConnection(ws: ServerWebSocket<WsData>): Promise<void> {
    const { persona, token } = ws.data.identity
    const connId = ws.data.connId
    const result = await auth.recheckToken(token)
    if (result !== 'revoked') {
      if (result === 'unreachable') log(`recheck skipped reason=admin_unreachable persona=${persona} connId=${connId}`)
      return
    }
    // 复核在途时连接可能已被顶替/断开：只对仍然在线的同一连接执行收口。
    const current = connections.get(persona)
    if (!current || current.data.connId !== connId) return
    log(`closed reason=token_revoked source=revoke_recheck persona=${persona} connId=${connId}`)
    dropConnection(current, CLOSE_CODE.UNAUTHORIZED, 'token_revoked')
  }

  const revokeRecheckTimer = config.revokeRecheckMs > 0
    ? setInterval(() => void revokeRecheckTick(), config.revokeRecheckMs)
    : null
  revokeRecheckTimer?.unref?.()

  function handshakeErrorResponse(status: number, code: string, message: string): Response {
    return Response.json({ ok: false, error: { code, message } }, { status })
  }

  const server = Bun.serve<WsData>({
    port: config.port,
    async fetch(req, server): Promise<Response | undefined> {
      const url = new URL(req.url)
      if (url.pathname === '/healthz') {
        return Response.json({ ok: true, connections: connections.size })
      }

      // POL-20: /asr streaming path — pure addition; every other path keeps the
      // envelope semantics below untouched.
      if (url.pathname === '/asr') {
        if (!asr) return handshakeErrorResponse(404, 'asr_disabled', '/asr is disabled on this relay')
        return asr.handleUpgrade(req, server, nextConnId++)
      }

      // Prefer the Authorization header (keeps the token out of intermediary
      // access logs); the `?token=` query param stays supported for clients
      // that cannot set WS headers.
      const headerToken = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
      const token = headerToken || (url.searchParams.get('token') ?? '')
      const side = url.searchParams.get('side')
      const deviceId = (url.searchParams.get('deviceId') ?? '').trim()
      if (!token || (side !== 'phone' && side !== 'mac') || !deviceId) {
        return handshakeErrorResponse(401, 'unauthorized', 'handshake requires token, side=phone|mac and deviceId')
      }

      const authenticated = await auth.authenticate(token)
      if (!authenticated.ok) {
        log(`handshake_rejected reason=unauthorized side=${side}`)
        return handshakeErrorResponse(401, 'unauthorized', 'invalid token')
      }
      const userId = authenticated.userId

      // A Mac must prove the requesting user owns this macDeviceId binding.
      if (side === 'mac') {
        const access = await auth.checkAccess(token, userId, deviceId)
        if (access === 'unauthorized') {
          log(`handshake_rejected reason=access_unauthorized side=mac deviceId=${deviceId}`)
          return handshakeErrorResponse(401, 'unauthorized', 'invalid token')
        }
        if (access !== 'allowed') {
          log(`handshake_rejected reason=not_allowed side=mac deviceId=${deviceId}`)
          return handshakeErrorResponse(403, 'not_allowed', 'device binding check failed')
        }
      }

      const upgraded = server.upgrade(req, {
        data: {
          connId: nextConnId++,
          identity: { side, userId, deviceId, persona: `${side}:${deviceId}`, token },
          lastPongAt: now(),
          lastAuthAt: now(),
          limiter: new SlidingWindowLimiter(config.maxMsgPerSec),
          recentPeers: new Set<string>(),
        },
      })
      if (!upgraded) {
        return handshakeErrorResponse(400, 'upgrade_failed', 'websocket upgrade failed')
      }
      return undefined
    },
    websocket: {
      maxPayloadLength: config.maxPayloadBytes,
      open: (ws) => {
        if (ws.data.asr) asr?.handleOpen(ws as ServerWebSocket<WsData> & AsrWsLike)
        else handleOpen(ws)
      },
      message: (ws, raw) => {
        if (ws.data.asr) asr?.handleMessage(ws as ServerWebSocket<WsData> & AsrWsLike, raw)
        else handleMessage(ws, raw)
      },
      close: (ws, code, reason) => {
        if (ws.data.asr) asr?.handleClose(ws as ServerWebSocket<WsData> & AsrWsLike, code, reason)
        else handleClose(ws, code, reason)
      },
    },
  })

  return {
    server,
    get port(): number {
      return server.port ?? 0
    },
    queue,
    stop(): void {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (revokeRecheckTimer) clearInterval(revokeRecheckTimer)
      queue.dispose()
      server.stop(true)
    },
  }
}
