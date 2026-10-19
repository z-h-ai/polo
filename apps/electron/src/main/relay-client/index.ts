/**
 * relay-client module facade (POL-237) — assembles the outbound polo-relay
 * link, the loopback bridge into the embedded WsRpcServer, and the status
 * machine broadcast to renderer windows.
 *
 * Status broadcast chain:
 *   RelayClient onConnected/onDisconnected ─┐
 *   external (non-renderer, non-bridge)     ├→ computeRelayStatus →
 *   embedded-server client bookkeeping ─────┘   DebouncedEmitter → broadcast
 *                                               (windowManager
 *                                               .broadcastToAllWindows →
 *                                               RPC push / webContents.send)
 *
 * The bridge piggybacks on the embedded server's own event fan-out: because
 * each phone is a real WsRpc client of the embedded server, `session:event`
 * pushes targeted at that client flow back through its loopback socket and are
 * re-wrapped into envelopes for the originating phone — no extra event sink
 * wiring needed.
 */

import { RelayClient, type RelayClientLogger } from './client'
import { RelayLoopbackBridge } from './bridge'
import { computeRelayStatus, DebouncedEmitter } from './status'
import { loadRelayClientConfig } from './config'
import type { RelayLinkStatus } from '../../shared/types'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'

export { computeBackoffDelayMs, RelayClient } from './client'
export { RelayLoopbackBridge, RELAY_ENVELOPE_KIND_RPC } from './bridge'
export { computeRelayStatus, DebouncedEmitter } from './status'
export * from './config'

/** Grace before a fresh embedded-server clientId is classified as external. */
const EXTERNAL_CLASSIFY_DELAY_MS = 2_000
/** Status broadcast debounce — coalesces reconnect flapping. */
const STATUS_DEBOUNCE_MS = 1_500

export interface RelayLinkOptions {
  /** The bootstrapServer instance pieces the bridge needs. */
  instance: {
    protocol: 'ws' | 'wss'
    port: number
  }
  /** Returns the current admin access token (null when logged out). */
  tokenProvider: () => Promise<string | null>
  /** Status sink — main/index.ts wires this to windowManager broadcast. */
  broadcast: (status: RelayLinkStatus) => void
  logger?: RelayClientLogger
  env?: Record<string, string | undefined>
  /** Settings dir override (tests); defaults to the shared CONFIG_DIR. */
  configDir?: string
  /** Test seams. */
  overrides?: {
    createClient?: (options: ConstructorParameters<typeof RelayClient>[0]) => RelayClient
    createBridge?: (options: ConstructorParameters<typeof RelayLoopbackBridge>[0]) => RelayLoopbackBridge
    statusDebounceMs?: number
    externalClassifyDelayMs?: number
    schedule?: (fn: () => void, ms: number) => unknown
    cancel?: (handle: unknown) => void
  }
}

export interface RelayLink {
  start(): void
  stop(): void
  getStatus(): RelayLinkStatus
  /** True while the outbound relay socket is open. */
  isRelayConnected(): boolean
  /** Feed from bootstrapServer onClientConnected (all disconnects). */
  onClientConnected(clientId: string, webContentsId: number | null): void
  /** Feed from bootstrapServer cleanupClientResources (all disconnects). */
  onClientDisconnected(clientId: string): void
  /** IPC surface for the future settings page (M1-6). */
  getChannel(): string
  readonly client: RelayClient
  readonly bridge: RelayLoopbackBridge
}

export function createRelayLink(options: RelayLinkOptions): RelayLink {
  const log = options.logger ?? { info() {}, warn() {}, error() {} }
  const overrides = options.overrides ?? {}
  const statusDebounceMs = overrides.statusDebounceMs ?? STATUS_DEBOUNCE_MS
  const classifyDelayMs = overrides.externalClassifyDelayMs ?? EXTERNAL_CLASSIFY_DELAY_MS
  const schedule = overrides.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = overrides.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const config = loadRelayClientConfig(options.env ?? process.env, options.configDir)
  const macPersona = `mac:${config.deviceId}`

  // -- status ---------------------------------------------------------------
  let relayConnected = false
  const externalClients = new Set<string>()
  const classifying = new Map<string, unknown>()
  let currentStatus: RelayLinkStatus = 'offline'

  const emitter = new DebouncedEmitter<RelayLinkStatus>((status) => {
    currentStatus = status
    try {
      options.broadcast(status)
    } catch (err) {
      log.warn('[relay-link] broadcast failed:', err instanceof Error ? err.message : String(err))
    }
  }, statusDebounceMs, overrides.schedule ?? undefined, overrides.cancel ?? undefined)

  function recomputeStatus(): void {
    emitter.push(computeRelayStatus({ relayConnected, externalClientCount: externalClients.size }))
  }

  // -- bridge ----------------------------------------------------------------
  const bridge = overrides.createBridge
    ? overrides.createBridge({
        protocol: options.instance.protocol,
        port: options.instance.port,
        logger: log,
      })
    : new RelayLoopbackBridge({
        protocol: options.instance.protocol,
        port: options.instance.port,
        logger: log,
      })

  // -- client -----------------------------------------------------------------
  const client = overrides.createClient
    ? overrides.createClient({
        resolveUrl: () => loadRelayClientConfig(options.env ?? process.env, options.configDir).relayUrl,
        tokenProvider: options.tokenProvider,
        deviceId: config.deviceId,
        logger: log,
      })
    : new RelayClient({
        // Re-resolved per attempt so a runtime/admin override is picked up
        // without restarting the link.
        resolveUrl: () => loadRelayClientConfig(options.env ?? process.env, options.configDir).relayUrl,
        tokenProvider: options.tokenProvider,
        deviceId: config.deviceId,
        logger: log,
      })

  // Phone → Mac: relay envelope payload (raw WsRpc frame) into the loopback.
  client.onEnvelope((envelope) => {
    // Only accept phone-routed traffic; the relay already guarantees
    // phone<->mac bridging, this guards against a misconfigured persona.
    if (!envelope.from.startsWith('phone:')) {
      log.warn(`[relay-link] dropped envelope from=${envelope.from} (not a phone persona)`)
      return
    }
    bridge.handlePhoneEnvelope(envelope.from, envelope.payload)
  })

  // Mac → Phone: embedded-server frames leaving the phone's loopback socket.
  bridge.onFrame = (persona, frame) => {
    const sent = client.sendEnvelope(persona, 'rpc', frame)
    if (!sent) {
      log.warn(`[relay-link] relay offline — dropped server frame for=${persona}`)
    }
  }

  // A phone disappeared from the relay — retire its loopback socket. The
  // embedded server keeps the client replayable for its reconnect window.
  client.onPeerDisconnected((peer) => {
    if (peer.startsWith('phone:')) bridge.closePersona(peer)
  })

  client.onConnected(() => {
    relayConnected = true
    recomputeStatus()
  })
  client.onDisconnected(() => {
    relayConnected = false
    recomputeStatus()
  })

  // -- external client classification -----------------------------------------
  function onClientConnected(clientId: string, webContentsId: number | null): void {
    // Renderer windows are always connected in UI mode — counting them would
    // pin online-lan (see status.ts). They carry a webContentsId in their
    // handshake; CLI / relay-bridge / future LAN phone clients do not.
    if (webContentsId != null) return
    if (classifying.has(clientId)) return
    // Defer: the bridge learns its socket's clientId from the handshake_ack a
    // tick after the server fires onClientConnected. Waiting out this window
    // prevents misclassifying bridge sockets as external (online-lan) clients.
    const handle = schedule(() => {
      classifying.delete(clientId)
      if (bridge.isManagedClientId(clientId)) return
      externalClients.add(clientId)
      recomputeStatus()
    }, classifyDelayMs)
    classifying.set(clientId, handle)
  }

  function onClientDisconnected(clientId: string): void {
    const handle = classifying.get(clientId)
    if (handle !== undefined) {
      cancel(handle)
      classifying.delete(clientId)
    }
    if (externalClients.delete(clientId)) {
      recomputeStatus()
    }
  }

  return {
    start() {
      client.start()
      recomputeStatus()
    },
    stop() {
      client.stop()
      bridge.destroy()
      relayConnected = false
      for (const handle of classifying.values()) cancel(handle)
      classifying.clear()
      externalClients.clear()
      emitter.dispose()
      recomputeStatus()
    },
    getStatus: () => currentStatus,
    isRelayConnected: () => relayConnected,
    onClientConnected,
    onClientDisconnected,
    getChannel: () => RPC_CHANNELS.relay.STATUS_CHANGED,
    client,
    bridge,
  }
}
