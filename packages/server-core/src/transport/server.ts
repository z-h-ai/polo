/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */

import { WebSocketServer, type VerifyClientCallbackAsync, type WebSocket } from 'ws'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  EVENT_BUFFER_MAX_SIZE,
  EVENT_BUFFER_TTL_MS,
  DISCONNECTED_CLIENT_TTL_MS,
  isErrorCode,
  type MessageEnvelope,
  type PushTarget,
  type ErrorCode,
} from '@polo-ai/shared/protocol'
import type { RpcServer, HandlerFn, RequestContext } from './types'
import { serializeEnvelope, deserializeEnvelope } from './codec'
import { createLogger } from '@polo-ai/shared/utils'

// ---------------------------------------------------------------------------
// Client connection state
// ---------------------------------------------------------------------------

interface BufferedEvent {
  seq: number
  /** Shared serialized envelope — one allocation referenced by all client buffers. */
  data: string
  timestamp: number
}

interface ClientConnection {
  id: string
  ws: WebSocket
  auth: WsAuthContext
  userId: string | null
  username: string | null
  userRole: RequestContext['userRole']
  userJwt: string | null
  workspaceId: string | null
  webContentsId: number | null
  capabilities: Set<string>
  missedPongs: number
  alive: boolean
  /** Ring buffer of recent events for replay on reconnect. */
  eventBuffer: BufferedEvent[]
  /** Highest per-client seq the client has acknowledged. */
  lastAckedSeq: number
  /** Highest per-client seq assigned to this client. */
  lastSentSeq: number
}

interface PendingInvoke {
  clientId: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export interface WsRpcTlsOptions {
  /** PEM-encoded certificate (or Buffer). */
  cert: string | Buffer
  /** PEM-encoded private key (or Buffer). */
  key: string | Buffer
  /** Optional PEM-encoded CA chain for client certificate verification. */
  ca?: string | Buffer
  /** Optional passphrase for encrypted private keys. */
  passphrase?: string
}

export interface WsAuthContext {
  userId: string | null
  username: string
  role: string
  jwt: string | null
}

export interface WsClientConnectedInfo {
  clientId: string
  webContentsId: number | null
  workspaceId: string | null
  capabilities: string[]
  userId: string | null
  username: string
  role: string
  jwt: string | null
}

export interface WsRpcServerOptions {
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string
  /** Port to bind to. 0 = random available port. Default: 0 */
  port?: number
  /** Whether to require a bearer token on handshake. Default: false */
  requireAuth?: boolean
  /** Token validator. Called when requireAuth is true. */
  validateToken?: (token: string) => Promise<boolean>
  /** Optional Bearer JWT validator for WebSocket upgrade Authorization headers. */
  validateBearerToken?: (token: string) => Promise<WsAuthContext | null>
  /**
   * Optional cookie-based session validator (for web UI auth).
   * Called with the Cookie header from the HTTP upgrade request.
   * If provided, a valid session cookie is accepted as an alternative to a bearer token.
   */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<WsAuthContext | null>
  /** Server identity stamp on outgoing events. Default: 'local' */
  serverId?: string
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
  /** App version string, included in handshake_ack for client compatibility checks. */
  serverVersion?: string
  /** Maximum concurrent clients. 0 = unlimited. Default: 50 */
  maxClients?: number
  /** Called when a client completes handshake. */
  onClientConnected?: (info: WsClientConnectedInfo) => void
  /** Called when a client disconnects. */
  onClientDisconnected?: (clientId: string) => void
  /**
   * Optional HTTP request handler for non-WebSocket requests.
   * When provided, regular HTTP requests to the server's port are
   * routed here instead of being rejected. This enables serving the
   * WebUI from the same port as the WebSocket server.
   * Must use Node.js HTTP callback signature (IncomingMessage, ServerResponse).
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
  /**
   * Optional hook for auto-creating a workspace when an authenticated user
   * connects without specifying a workspaceId. Called with the user's id and
   * username; must return the workspace id to include in the handshake_ack.
   *
   * When omitted, auto-create is disabled and the handshake_ack workspaceId
   * is sourced only from the client's handshake envelope.
   */
  onAutoCreateWorkspace?: (userId: string, username: string) => Promise<string>
}

const transportLog = createLogger('ws-rpc-server')
const SESSION_COOKIE_NAME = 'polo_ai_session'

function createSystemAuthContext(): WsAuthContext {
  return {
    userId: null,
    username: 'system',
    role: 'admin',
    jwt: null,
  }
}

function requestUserRoleFromAuth(auth: WsAuthContext): RequestContext['userRole'] {
  if (auth.role === 'admin' || auth.role === 'user') return auth.role
  return null
}

function applyAuthContextToClient(client: ClientConnection, auth: WsAuthContext): void {
  client.auth = auth
  client.userId = auth.userId
  client.username = auth.username
  client.userRole = requestUserRoleFromAuth(auth)
  client.userJwt = auth.jwt
}

// ---------------------------------------------------------------------------
// WsRpcServer
// ---------------------------------------------------------------------------

export class WsRpcServer implements RpcServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private httpsServer: HttpsServer | null = null
  private clients = new Map<string, ClientConnection>()
  private handlers = new Map<string, HandlerFn>()
  private pendingInvokes = new Map<string, PendingInvoke>()
  private upgradeAuthContexts = new WeakMap<IncomingMessage, WsAuthContext>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _port = 0
  private _protocol: 'ws' | 'wss' = 'ws'

  /** Recently disconnected clients retained for reconnect replay. */
  private disconnectedClients = new Map<string, { client: ClientConnection; timer: ReturnType<typeof setTimeout> }>()

  private readonly host: string
  private readonly requestedPort: number
  private readonly requireAuth: boolean
  private readonly validateToken: ((token: string) => Promise<boolean>) | null
  private readonly validateBearerToken: ((token: string) => Promise<WsAuthContext | null>) | null
  private readonly validateSessionCookie: ((cookieHeader: string | null) => Promise<WsAuthContext | null>) | null
  private readonly serverId: string
  private readonly tlsOptions: WsRpcTlsOptions | null
  private readonly serverVersion: string
  private readonly maxClients: number
  private readonly onClientConnected: WsRpcServerOptions['onClientConnected']
  private readonly onClientDisconnected: WsRpcServerOptions['onClientDisconnected']
  private readonly httpHandler: WsRpcServerOptions['httpHandler']
  private readonly onAutoCreateWorkspace: WsRpcServerOptions['onAutoCreateWorkspace']

  constructor(opts?: WsRpcServerOptions) {
    this.host = opts?.host ?? '127.0.0.1'
    this.requestedPort = opts?.port ?? 0
    this.requireAuth = opts?.requireAuth ?? false
    this.validateToken = opts?.validateToken ?? null
    this.validateBearerToken = opts?.validateBearerToken ?? null
    this.validateSessionCookie = opts?.validateSessionCookie ?? null
    this.serverId = opts?.serverId ?? 'local'
    this.serverVersion = opts?.serverVersion ?? ''
    this.tlsOptions = opts?.tls ?? null
    this.maxClients = opts?.maxClients ?? 50
    this.onClientConnected = opts?.onClientConnected
    this.onClientDisconnected = opts?.onClientDisconnected
    this.httpHandler = opts?.httpHandler
    this.onAutoCreateWorkspace = opts?.onAutoCreateWorkspace
  }

  /** The actual port the server is listening on (available after listen()). */
  get port(): number {
    return this._port
  }

  /** The protocol the server is using: 'wss' when TLS is configured, 'ws' otherwise. */
  get protocol(): 'ws' | 'wss' {
    return this._protocol
  }

  /** Number of currently connected (handshake-completed) clients. */
  getConnectedClientCount(): number {
    return this.clients.size
  }

  // -------------------------------------------------------------------------
  // RpcServer interface
  // -------------------------------------------------------------------------

  handle(channel: string, handler: HandlerFn): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler already registered for channel: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  push(channel: string, target: PushTarget, ...args: any[]): void {
    const timestamp = Date.now()

    for (const client of this.clients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, true)
    }

    for (const { client } of this.disconnectedClients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, false)
    }
  }

  hasClientCapability(clientId: string, capability: string): boolean {
    const client = this.clients.get(clientId)
    return !!client && client.capabilities.has(capability)
  }

  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[] {
    const results: string[] = []
    for (const [clientId, client] of this.clients) {
      if (!client.capabilities.has(capability)) continue
      if (opts?.workspaceId !== undefined && client.workspaceId !== opts.workspaceId) continue
      results.push(clientId)
    }
    return results
  }

  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = this.clients.get(clientId)

      // Check connection
      if (!client) {
        const err = new Error(`Client not connected: ${clientId}`)
        ;(err as any).code = 'CLIENT_DISCONNECTED'
        reject(err)
        return
      }

      // Check capability
      if (!client.capabilities.has(channel)) {
        const err = new Error(`Client lacks capability: ${channel}`)
        ;(err as any).code = 'CAPABILITY_UNAVAILABLE'
        reject(err)
        return
      }

      const id = randomUUID()
      const timeout = setTimeout(() => {
        this.pendingInvokes.delete(id)
        const err = new Error(`Client request timeout: ${channel} (30000ms)`)
        ;(err as any).code = 'CLIENT_REQUEST_TIMEOUT'
        reject(err)
      }, 30_000)

      this.pendingInvokes.set(id, { clientId, resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
        serverId: this.serverId,
      }
      this.safeSend(client.ws, serializeEnvelope(envelope))
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.tlsOptions) {
        // TLS mode: create HTTPS server, attach WebSocketServer to it.
        // When httpHandler is set, regular HTTP requests are served by it
        // (e.g. WebUI), while ws intercepts WebSocket upgrade requests.
        this._protocol = 'wss'
        this.httpsServer = createHttpsServer(
          {
            cert: this.tlsOptions.cert,
            key: this.tlsOptions.key,
            ca: this.tlsOptions.ca,
            passphrase: this.tlsOptions.passphrase,
          },
          this.httpHandler,
        )

        this.wss = new WebSocketServer({ server: this.httpsServer, ...this.getUpgradeAuthOptions() })

        this.httpsServer.on('error', (err) => reject(err))

        this.httpsServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpsServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else if (this.httpHandler) {
        // Plain WS + HTTP handler: create an HTTP server for both.
        this._protocol = 'ws'
        this.httpServer = createHttpServer(this.httpHandler)
        this.wss = new WebSocketServer({ server: this.httpServer, ...this.getUpgradeAuthOptions() })

        this.httpServer.on('error', (err) => reject(err))

        this.httpServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else {
        // Plain WS mode, no HTTP handler
        this._protocol = 'ws'
        this.wss = new WebSocketServer({
          host: this.host,
          port: this.requestedPort,
          ...this.getUpgradeAuthOptions(),
        })

        this.wss.on('listening', () => {
          const addr = this.wss!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })

        this.wss.on('error', (err) => {
          reject(err)
        })
      }

      this.wss.on('connection', (ws, req) => {
        this.onConnection(ws, req)
      })
    })
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // Reject all pending invokes before tearing down connections
    for (const [id, pending] of this.pendingInvokes) {
      clearTimeout(pending.timeout)
      const err = new Error('Server shutting down')
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
    for (const client of this.clients.values()) {
      client.ws.terminate()
    }
    this.clients.clear()
    // Clean up disconnected client timers
    for (const entry of this.disconnectedClients.values()) {
      clearTimeout(entry.timer)
    }
    this.disconnectedClients.clear()
    this.wss?.close()
    this.wss = null
    this.httpServer?.close()
    this.httpServer = null
    this.httpsServer?.close()
    this.httpsServer = null
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // Reject if at capacity
    if (this.maxClients > 0 && this.clients.size >= this.maxClients) {
      transportLog.warn('Connection rejected: at capacity', {
        maxClients: this.maxClients,
        current: this.clients.size,
      })
      ws.close(4008, 'Server at capacity')
      return
    }

    let handshakeCompleted = false
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null
    let authContext = this.upgradeAuthContexts.get(req) ?? null
    this.upgradeAuthContexts.delete(req)

    // Give the client 5 seconds to send a handshake
    handshakeTimeout = setTimeout(() => {
      if (!handshakeCompleted) {
        ws.close(4001, 'Handshake timeout')
      }
    }, 5_000)

    ws.on('message', async (raw) => {
      let envelope: MessageEnvelope
      try {
        envelope = deserializeEnvelope(raw.toString())
      } catch {
        ws.close(4002, 'Invalid JSON')
        return
      }

      if (!handshakeCompleted) {
        if (envelope.type !== 'handshake') {
          ws.close(4003, 'Expected handshake')
          return
        }

        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout)
          handshakeTimeout = null
        }

        // Protocol version check (required)
        if (!envelope.protocolVersion || typeof envelope.protocolVersion !== 'string') {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Missing protocolVersion. Server protocol ${PROTOCOL_VERSION}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        const clientMajor = parseInt(envelope.protocolVersion.split('.')[0] ?? '0', 10)
        const serverMajor = parseInt(PROTOCOL_VERSION.split('.')[0] ?? '0', 10)
        if (clientMajor !== serverMajor) {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Server protocol ${PROTOCOL_VERSION}, client ${envelope.protocolVersion}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        // Auth check. In WebUI mode authContext is established during HTTP
        // upgrade. Without a session-cookie validator, retain legacy
        // handshake-token auth for older clients.
        if (this.requireAuth) {
          if (!authContext && envelope.token && this.validateToken) {
            const authenticated = await this.validateToken(envelope.token)
            if (authenticated) {
              authContext = createSystemAuthContext()
            }
          }

          if (!authContext) {
            const reason = envelope.token ? 'Invalid token' : 'Token required'
            this.sendError(ws, envelope.id, 'AUTH_FAILED', reason)
            ws.close(4005, 'Auth failed')
            return
          }
        }

        // ── Reconnect attempt ──
        if (envelope.reconnectClientId && envelope.lastSeq != null) {
          const entry = this.disconnectedClients.get(envelope.reconnectClientId)
          if (entry) {
            const prevClient = entry.client

            // Identity must match (workspace + webContentsId)
            const currentAuth = authContext ?? createSystemAuthContext()

            const identityMatch =
              prevClient.workspaceId === (envelope.workspaceId ?? null) &&
              prevClient.webContentsId === (envelope.webContentsId ?? null) &&
              prevClient.auth.userId === currentAuth.userId

            if (identityMatch) {
              // Valid reconnect — prepare client state but do NOT add to
              // this.clients yet. The client stays in disconnectedClients
              // during replay so that push() can't interleave new events
              // between replayed ones. (Currently safe due to Node.js
              // single-threading, but this ordering makes the invariant
              // explicit and future-proof.)
              clearTimeout(entry.timer)

              prevClient.ws = ws
              prevClient.alive = true
              prevClient.missedPongs = 0
              applyAuthContextToClient(prevClient, currentAuth)
              handshakeCompleted = true

              // Determine replay vs stale using the per-client delivery sequence.
              // Retained buffers continue collecting events while the client is disconnected,
              // but TTL eviction still applies during the reconnect window.
              this.evictBuffer(prevClient)

              const lastSeq = envelope.lastSeq as number
              const hasMissedEvents = lastSeq < prevClient.lastSentSeq
              const firstBufferedSeq = prevClient.eventBuffer[0]?.seq
              const canReplay = !hasMissedEvents
                ? true
                : firstBufferedSeq != null && lastSeq >= firstBufferedSeq - 1

              if (canReplay) {
                const replayEvents = prevClient.eventBuffer.filter(e => e.seq > lastSeq)

                const ack = this.createHandshakeAck(envelope.id, prevClient, {
                  reconnected: true,
                })
                this.safeSend(ws, serializeEnvelope(ack))

                // Replay missed events in order
                for (const event of replayEvents) {
                  this.safeSend(ws, event.data)
                }

                transportLog.info('Client reconnected with replay', {
                  clientId: prevClient.id,
                  replayedCount: replayEvents.length,
                  lastSeq,
                })
              } else {
                // Buffer evicted — client must full-refresh
                const ack = this.createHandshakeAck(envelope.id, prevClient, {
                  reconnected: true,
                  stale: true,
                })
                this.safeSend(ws, serializeEnvelope(ack))

                transportLog.info('Client reconnected as stale', {
                  clientId: prevClient.id,
                  lastSeq,
                  firstBufferedSeq,
                  lastSentSeq: prevClient.lastSentSeq,
                })
              }

              // Atomic state transition: move from disconnected → active
              // AFTER replay is complete so push() can't target this client mid-replay.
              this.disconnectedClients.delete(envelope.reconnectClientId)
              this.clients.set(prevClient.id, prevClient)

              this.setupClientHandlers(ws, prevClient)
              this.onClientConnected?.({
                clientId: prevClient.id,
                webContentsId: prevClient.webContentsId,
                workspaceId: prevClient.workspaceId,
                capabilities: [...prevClient.capabilities],
                ...prevClient.auth,
              })
              return
            }

            // Identity mismatch — fall through to fresh connect
            transportLog.warn('Reconnect identity mismatch', {
              reconnectClientId: envelope.reconnectClientId,
            })
          }
          // reconnectClientId not found — fall through to fresh connect
        }

        // ── Normal fresh connect ──
        const clientId = randomUUID()
        const freshAuth = authContext ?? createSystemAuthContext()
        const client: ClientConnection = {
          id: clientId,
          ws,
          auth: freshAuth,
          userId: null,
          username: null,
          userRole: null,
          userJwt: null,
          workspaceId: envelope.workspaceId ?? null,
          webContentsId: envelope.webContentsId ?? null,
          capabilities: new Set(envelope.clientCapabilities ?? []),
          missedPongs: 0,
          alive: true,
          eventBuffer: [],
          lastAckedSeq: 0,
          lastSentSeq: 0,
        }
        applyAuthContextToClient(client, client.auth)

        // Auto-create workspace for authenticated users who didn't specify one
        if (client.userId && client.username && !client.workspaceId && this.onAutoCreateWorkspace) {
          try {
            client.workspaceId = await this.onAutoCreateWorkspace(client.userId, client.username)
          } catch (err) {
            transportLog.warn('Auto-create workspace failed', {
              userId: client.userId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        this.clients.set(clientId, client)
        handshakeCompleted = true

        // Send handshake_ack (includes workspaceId from client envelope or auto-created)
        const ack = this.createHandshakeAck(envelope.id, client)
        this.safeSend(ws, serializeEnvelope(ack))

        // Notify lifecycle listener
        transportLog.info('Client connected', {
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
        })
        this.onClientConnected?.({
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
          capabilities: [...client.capabilities],
          ...client.auth,
        })

        this.setupClientHandlers(ws, client)
        return
      }

      // Post-handshake: find the client for this ws
      const client = this.findClientByWs(ws)
      if (!client) {
        ws.close(4006, 'Unknown client')
        return
      }

      if (envelope.type === 'request') {
        await this.onRequest(client, envelope)
      } else if (envelope.type === 'response') {
        this.onClientResponse(envelope)
      } else if (envelope.type === 'sequence_ack') {
        const ackSeq = envelope.lastSeq
        if (typeof ackSeq === 'number' && ackSeq > client.lastAckedSeq) {
          client.lastAckedSeq = ackSeq
          // Evict acknowledged events
          const buf = client.eventBuffer
          let removeCount = 0
          while (removeCount < buf.length && buf[removeCount]!.seq <= ackSeq) {
            removeCount++
          }
          if (removeCount > 0) {
            buf.splice(0, removeCount)
          }
        }
      }
    })

    ws.on('error', () => {
      // Connection errors are handled by the close event
    })
  }

  // -------------------------------------------------------------------------
  // Request dispatching
  // -------------------------------------------------------------------------

  /** Server-side timeout for RPC handler execution (ms). */
  private static readonly HANDLER_TIMEOUT_MS = 60_000

  private async onRequest(client: ClientConnection, envelope: MessageEnvelope): Promise<void> {
    const { channel, id, args } = envelope

    if (!channel) {
      this.sendResponseError(client.ws, id, undefined, 'CHANNEL_NOT_FOUND', 'Missing channel')
      return
    }

    const handler = this.handlers.get(channel)
    if (!handler) {
      this.sendResponseError(client.ws, id, channel, 'CHANNEL_NOT_FOUND', `No handler for: ${channel}`)
      return
    }

    const ctx: RequestContext = {
      clientId: client.id,
      workspaceId: client.workspaceId,
      webContentsId: client.webContentsId,
      userId: client.userId,
      username: client.username,
      userRole: client.userRole,
      userJwt: client.userJwt,
    }

    try {
      const result = await Promise.race([
        handler(ctx, ...(args ?? [])),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Handler timeout: ${channel} (${WsRpcServer.HANDLER_TIMEOUT_MS}ms)`)),
            WsRpcServer.HANDLER_TIMEOUT_MS),
        ),
      ])
      const response: MessageEnvelope = {
        id,
        type: 'response',
        channel,
        result,
      }
      this.safeSend(client.ws, serializeEnvelope(response))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rawCode = (err as { code?: unknown } | null)?.code
      const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR'
      this.sendResponseError(client.ws, id, channel, code, message)
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [, client] of this.clients) {
        // Skip sockets that are already closing/closed (e.g. terminated on a previous tick)
        if (client.ws.readyState !== client.ws.OPEN) continue

        if (!client.alive) {
          client.missedPongs++
          if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
            // Let the close handler (setupClientHandlers) handle all cleanup:
            // clients.delete, buffer retention for reconnect, onClientDisconnected.
            client.ws.terminate()
            continue
          }
        }
        client.alive = false
        client.ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getUpgradeAuthOptions(): { verifyClient?: VerifyClientCallbackAsync } {
    if (!this.requireAuth || (!this.validateSessionCookie && !this.validateBearerToken)) {
      return {}
    }

    return {
      verifyClient: (info, callback) => {
        void this.authenticateUpgradeRequest(info.req)
          .then((auth) => {
            if (!auth) {
              callback(false, 401, 'Unauthorized')
              return
            }

            this.upgradeAuthContexts.set(info.req, auth)
            callback(true)
          })
          .catch(() => {
            callback(false, 401, 'Unauthorized')
          })
      },
    }
  }

  private async authenticateUpgradeRequest(req: IncomingMessage): Promise<WsAuthContext | null> {
    const cookieHeader = this.headerToString(req.headers.cookie)
    const hasSessionCookie = this.hasSessionCookie(cookieHeader)

    if (this.validateSessionCookie) {
      const cookieAuth = await this.validateSessionCookie(cookieHeader)
      if (cookieAuth) return cookieAuth
      if (hasSessionCookie) return null
    }

    const bearerToken = this.extractBearerToken(this.headerToString(req.headers.authorization))
    if (bearerToken && this.validateBearerToken) {
      return this.validateBearerToken(bearerToken)
    }

    return null
  }

  private extractBearerToken(authorizationHeader: string | null): string | null {
    if (!authorizationHeader) return null
    const match = authorizationHeader.match(/^Bearer\s+(.+)$/i)
    return match?.[1]?.trim() || null
  }

  private headerToString(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value.join('; ')
    return value ?? null
  }

  private hasSessionCookie(cookieHeader: string | null): boolean {
    if (!cookieHeader) return false
    for (const pair of cookieHeader.split(';')) {
      const [name] = pair.trim().split('=')
      if (name === SESSION_COOKIE_NAME) return true
    }
    return false
  }

  private createHandshakeAck(
    id: string,
    client: ClientConnection,
    extra?: Pick<MessageEnvelope, 'reconnected' | 'stale'>,
  ): MessageEnvelope {
    return {
      id,
      type: 'handshake_ack',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.serverVersion || undefined,
      clientId: client.id,
      registeredChannels: [...this.handlers.keys()],
      userId: client.auth.userId,
      username: client.auth.username,
      role: client.auth.role,
      workspaceId: client.workspaceId ?? undefined,
      ...extra,
    }
  }

  /** Wire up close + pong handlers for a WebSocket ↔ ClientConnection pair. */
  private setupClientHandlers(ws: WebSocket, client: ClientConnection): void {
    ws.on('close', () => {
      transportLog.info('Client disconnected', { clientId: client.id })
      this.clients.delete(client.id)

      // Retain buffer for potential reconnect
      const timer = setTimeout(() => {
        this.disconnectedClients.delete(client.id)
      }, DISCONNECTED_CLIENT_TTL_MS)
      this.disconnectedClients.set(client.id, { client, timer })

      // Cap disconnectedClients to prevent unbounded growth
      if (this.disconnectedClients.size > 50) {
        const oldestKey = this.disconnectedClients.keys().next().value
        if (oldestKey) {
          const oldest = this.disconnectedClients.get(oldestKey)
          if (oldest) clearTimeout(oldest.timer)
          this.disconnectedClients.delete(oldestKey)
        }
      }

      this.rejectPendingInvokesForClient(client.id)
      this.onClientDisconnected?.(client.id)
    })

    ws.on('pong', () => {
      client.alive = true
      client.missedPongs = 0
    })
  }

  /** Assign a per-client seq, retain the event for replay, and optionally send it immediately. */
  private bufferAndMaybeSendEvent(
    client: ClientConnection,
    channel: string,
    args: any[],
    timestamp: number,
    shouldSend: boolean,
  ): void {
    client.lastSentSeq += 1
    const seq = client.lastSentSeq

    const envelope: MessageEnvelope = {
      id: randomUUID(),
      type: 'event',
      channel,
      args,
      serverId: this.serverId,
      seq,
    }

    const data = serializeEnvelope(envelope)
    client.eventBuffer.push({ seq, data, timestamp })
    this.evictBuffer(client)

    if (shouldSend) {
      this.safeSend(client.ws, data)
    }
  }

  /** Evict stale/oversized entries from a client's event buffer via batch splice. */
  private evictBuffer(client: ClientConnection): void {
    const buf = client.eventBuffer
    if (buf.length === 0) return

    const now = Date.now()
    let removeCount = 0

    // Evict by TTL
    while (removeCount < buf.length &&
           now - buf[removeCount]!.timestamp > EVENT_BUFFER_TTL_MS) {
      removeCount++
    }

    // Evict by size (keep at most EVENT_BUFFER_MAX_SIZE after TTL eviction)
    const remaining = buf.length - removeCount
    if (remaining > EVENT_BUFFER_MAX_SIZE) {
      removeCount += remaining - EVENT_BUFFER_MAX_SIZE
    }

    // Single splice instead of O(n) shift loop
    if (removeCount > 0) {
      buf.splice(0, removeCount)
    }
  }

  private matchesTarget(client: ClientConnection, target: PushTarget): boolean {
    switch (target.to) {
      case 'all':
        return target.exclude ? client.id !== target.exclude : true
      case 'workspace':
        if (target.exclude && client.id === target.exclude) return false
        return client.workspaceId === target.workspaceId
      case 'client':
        return client.id === target.clientId
      default:
        return false
    }
  }

  /** Update a client's workspaceId (called after SWITCH_WORKSPACE so push routing stays correct). */
  updateClientWorkspace(clientId: string, workspaceId: string): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.workspaceId = workspaceId
    }
  }

  private findClientByWs(ws: WebSocket): ClientConnection | undefined {
    for (const client of this.clients.values()) {
      if (client.ws === ws) return client
    }
    return undefined
  }

  /** Handler/request errors — sent as type:'response' with error field. */
  private sendResponseError(
    ws: WebSocket, id: string, channel: string | undefined,
    code: ErrorCode, message: string,
  ): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'response',
      channel,
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  /** Protocol-level errors only (handshake rejection, version mismatch). May close connection. */
  private sendError(ws: WebSocket, id: string, code: ErrorCode, message: string): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'error',
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  private onClientResponse(envelope: MessageEnvelope): void {
    const pending = this.pendingInvokes.get(envelope.id)
    if (!pending) return

    this.pendingInvokes.delete(envelope.id)
    clearTimeout(pending.timeout)

    if (envelope.error) {
      const err = new Error(envelope.error.message)
      ;(err as any).code = envelope.error.code
      ;(err as any).data = envelope.error.data
      pending.reject(err)
    } else {
      pending.resolve(envelope.result)
    }
  }

  private rejectPendingInvokesForClient(clientId: string): void {
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.clientId !== clientId) continue
      clearTimeout(pending.timeout)
      const err = new Error(`Client disconnected: ${clientId}`)
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
  }

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(data)
    }
  }
}
