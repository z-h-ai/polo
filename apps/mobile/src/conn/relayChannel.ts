// Relay channel (POL-242 card step 2): the same WsRpc frame protocol, tunneled
// through polo-relay envelopes (packages/relay, PRD v1.6 §⑥ 链路②).
//
// Wire semantics (verified against packages/relay/src/server.ts + envelope.ts
// and the POL-237 Mac bridge — apps/electron/src/main/relay-client/{client,
// bridge}.ts — do not guess from the card):
//   - Handshake happens at HTTP upgrade: the relay reads the admin JWT from
//     the `Authorization: Bearer` header OR, for clients that cannot set WS
//     headers (RN), from the `?token=` query param (server.ts:360-363 keeps
//     both supported on purpose), plus `?side=phone&deviceId=<phoneDeviceId>`.
//     The phone persona is `phone:<deviceId>` — deviceId is the phone's own
//     admin device row id (POL-241 bind/list DeviceView.id).
//   - Frames: `{v:1, from:"phone:<id>", to:"mac:<id>", kind:"rpc", payload}`
//     where payload is the RAW WsRpc frame string — including the very first
//     WsRpc handshake frame, whose in-band `token` is validated end-to-end by
//     the Mac's embedded server (POL-237 bridge pumps payload bytes untouched).
//     So the admin JWT appears twice by design: query param (relay auth) and
//     handshake payload (Mac auth).
//   - The relay sends app-level `{type:"ping"}` every 30s; any frame (here:
//     our `{type:"pong"}`) is liveness evidence — a silent connection is
//     killed after 60s. Ping frames are transport-level, never routed.
//   - `kind:"control"` envelopes (from the `relay` pseudo-persona) are relay
//     receipts: peer_disconnected (Mac dropped off the relay) and
//     delivery_failed. They are surfaced as synthetic WsRpc events on the
//     reserved channels `relay:peerDisconnected` / `relay:deliveryFailed` so
//     the message layer (M1-11 暂存语义) can consume them like any event.
//   - Replay: reconnectClientId + lastSeq ride the FIRST payload frame of each
//     new socket (the WsRpc handshake) and are kept in memory per card.
//     Replayed event frames are deduped/ordered by EventSequencer.

import type { MessageEnvelope } from '@polo-ai/shared/protocol';
import type { ChannelKind, ChannelState, ConnChannel } from './lanChannel';
import { EventSequencer, classifyClose } from './reconnect';

// ---------------------------------------------------------------------------
// WebSocket surface (RN global WebSocket is property-style — M0-2 C6 item 1)
// ---------------------------------------------------------------------------

export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event?: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null
  onerror: ((event?: unknown) => void) | null
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** ws / RN readyState values. */
const WS_OPEN = 1;

// ---------------------------------------------------------------------------
// Relay envelope helpers (mirror of packages/relay/src/envelope.ts — minimal)
// ---------------------------------------------------------------------------

export const RELAY_ENVELOPE_VERSION = 1 as const;

export interface RelayEnvelope {
  v: typeof RELAY_ENVELOPE_VERSION
  from: string
  to: string
  kind: string
  payload: unknown
  queuedAt?: number
}

export const RELAY_PERSONA_CONTROL = 'relay';

/** Reserved WsRpc channel names for relay control receipts. */
export const RELAY_CONTROL_CHANNELS = {
  peerDisconnected: 'relay:peerDisconnected',
  deliveryFailed: 'relay:deliveryFailed',
} as const;

/**
 * Builds the relay handshake URL. Query-param token: the relay prefers the
 * Authorization header (keeps the token out of intermediary logs) but keeps
 * `?token=` for WS clients that cannot set headers — RN is exactly that case.
 */
export function buildRelayHandshakeUrl(
  relayUrl: string,
  phoneDeviceId: string,
  token: string,
): string {
  const separator = relayUrl.includes('?') ? '&' : '?';
  return (
    `${relayUrl}${separator}side=phone` +
    `&deviceId=${encodeURIComponent(phoneDeviceId)}` +
    `&token=${encodeURIComponent(token)}`
  );
}

/**
 * EXPO_PUBLIC_RELAY_URL reader, same shape as src/api/config.ts. Empty default
 * = relay channel disabled until the deployment provides the endpoint
 * (.env.example is outside this card's allowed files).
 */
export function resolveRelayUrl(env?: string): string {
  const raw = (env ?? process.env.EXPO_PUBLIC_RELAY_URL ?? '').trim();
  return raw.replace(/\/+$/, '');
}

/**
 * Protocol version for the payload handshake frame. Metro bundles the real
 * @polo-ai/shared/protocol source; under bun test the tsconfig maps the
 * specifier to the type shim (no runtime values) so fall back to the literal
 * mirror of types.ts:175.
 */
function defaultProtocolVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@polo-ai/shared/protocol') as { PROTOCOL_VERSION?: string };
    if (typeof mod.PROTOCOL_VERSION === 'string' && mod.PROTOCOL_VERSION) return mod.PROTOCOL_VERSION;
  } catch {
    // fall through to the literal
  }
  return '1.0';
}

function defaultFrameCodec(): FrameCodec {
  // Lazy require — same reasoning as defaultProtocolVersion (and as the LAN
  // channel's lazy WsRpcClient): Metro resolves the real codec via the rn
  // resolver map; tests inject `frameCodec` fakes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@polo-ai/server-core/transport/codec') as typeof import('@polo-ai/server-core/transport/codec');
  return { serialize: mod.serializeEnvelope, deserialize: mod.deserializeEnvelope };
}

function defaultCreateWebSocket(url: string): WebSocketLike {
  // RN global WebSocket (property-style listeners). No custom headers —
  // auth rides the query string (see buildRelayHandshakeUrl).
  return new WebSocket(url) as unknown as WebSocketLike;
}

export interface FrameCodec {
  serialize(envelope: MessageEnvelope): string
  deserialize(raw: string): MessageEnvelope
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export const RELAY_CONNECT_TIMEOUT_MS = 5_000;
export const RELAY_REQUEST_TIMEOUT_MS = 30_000;
/** Mirror of shared protocol SEQUENCE_ACK_INTERVAL_MS (types.ts:206). */
const SEQUENCE_ACK_INTERVAL_MS = 5_000;

export interface RelayChannelOptions {
  /** Relay endpoint, e.g. wss://relay.z-h-ai.com (EXPO_PUBLIC_RELAY_URL). */
  relayUrl: string;
  /** Phone persona id — admin device row id of THIS phone (from:`phone:<id>`). */
  phoneDeviceId: string;
  /** Selected Mac persona id (to:`mac:<id>`); single-device MVP. */
  macDeviceId: string;
  /** Admin JWT — relay upgrade auth (query) + in-band Mac handshake token. */
  token: string;
  protocolVersion?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  createWebSocket?: WebSocketFactory;
  frameCodec?: FrameCodec;
  uuid?: () => string;
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Error carrying classification fields the ConnectionManager reads. */
type ChannelError = Error & { closeCode?: number; errorKind?: string };

function typedError(message: string, fields: { closeCode?: number; errorKind?: string }): ChannelError {
  const err = new Error(message) as ChannelError;
  if (fields.closeCode !== undefined) err.closeCode = fields.closeCode;
  if (fields.errorKind !== undefined) err.errorKind = fields.errorKind;
  return err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createRelayChannel(options: RelayChannelOptions): ConnChannel {
  const relayUrl = options.relayUrl;
  const phoneDeviceId = options.phoneDeviceId;
  const macDeviceId = options.macDeviceId;
  const token = options.token;
  const phonePersona = `phone:${phoneDeviceId}`;
  const macPersona = `mac:${macDeviceId}`;
  const protocolVersion = options.protocolVersion ?? defaultProtocolVersion();
  const connectTimeoutMs = options.connectTimeoutMs ?? RELAY_CONNECT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? RELAY_REQUEST_TIMEOUT_MS;
  const createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
  const newUuid = options.uuid ?? (() => crypto.randomUUID());
  const frameCodec = options.frameCodec ?? defaultFrameCodec();

  let ws: WebSocketLike | null = null;
  let destroyed = false;
  let phase: 'idle' | 'connecting' | 'online' | 'offline' = 'idle';
  let clientId: string | null = null;
  let lastSeq = 0;
  /** In-memory replay identity (card: reconnectClientId+lastSeq 持久化到内存即可). */
  let replaySnapshot: { clientId: string; lastSeq: number } | null = null;
  const sequencer = new EventSequencer();

  const pending = new Map<string, PendingRequest>();
  const stateListeners = new Set<(state: ChannelState) => void>();
  const eventListeners = new Set<(channel: string, args: unknown[]) => void>();
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let ackTimer: ReturnType<typeof setInterval> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let lastCloseCode: number | undefined;
  let lastCloseReason: string | undefined;
  let lastErrorKind: string | undefined;
  let lastErrorMessage: string | undefined;

  function emitState(next: ChannelState): void {
    for (const cb of stateListeners) {
      try {
        cb(next);
      } catch {
        // Listener errors must not break the channel.
      }
    }
  }

  function setPhase(next: 'connecting' | 'online' | 'offline'): void {
    phase = next;
    if (next === 'connecting') {
      emitState({ phase });
      return;
    }
    emitState({
      phase,
      closeCode: next === 'offline' ? lastCloseCode : undefined,
      reason: next === 'offline' ? lastCloseReason : undefined,
      errorKind: next === 'offline' ? lastErrorKind : undefined,
      errorMessage: next === 'offline' ? lastErrorMessage : undefined,
    });
  }

  function clearTimers(): void {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (ackTimer) {
      clearInterval(ackTimer);
      ackTimer = null;
    }
  }

  function rejectPending(message: string): void {
    for (const [, req] of pending) {
      clearTimeout(req.timeout);
      req.reject(new Error(message));
    }
    pending.clear();
  }

  function rawSend(text: string): boolean {
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Wraps a WsRpc frame into the relay envelope and sends it. */
  function sendFrame(frame: MessageEnvelope): boolean {
    const envelope: RelayEnvelope = {
      v: RELAY_ENVELOPE_VERSION,
      from: phonePersona,
      to: macPersona,
      kind: 'rpc',
      payload: frameCodec.serialize(frame),
    };
    return rawSend(JSON.stringify(envelope));
  }

  function sendHandshake(): void {
    const frame: MessageEnvelope = {
      id: newUuid(),
      type: 'handshake',
      protocolVersion,
      token,
    };
    if (replaySnapshot) {
      frame.reconnectClientId = replaySnapshot.clientId;
      frame.lastSeq = replaySnapshot.lastSeq;
    }
    sendFrame(frame);
  }

  function startAckTimer(): void {
    if (ackTimer) clearInterval(ackTimer);
    ackTimer = setInterval(() => {
      if (phase === 'online' && lastSeq > 0) {
        rawSend(JSON.stringify({ id: newUuid(), type: 'sequence_ack', lastSeq }));
      }
    }, SEQUENCE_ACK_INTERVAL_MS);
  }

  function failReady(error: Error): void {
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  }

  function detachSocket(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // best effort
    }
  }

  // -- inbound ---------------------------------------------------------------

  function handleRaw(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // non-JSON frame — the relay never sends those; drop defensively
    }
    if (!isRecord(parsed)) return;

    // App-level heartbeat (transport-level, never routed).
    if (parsed.type === 'ping') {
      rawSend(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (parsed.type === 'pong') return;

    // Relay envelope?
    if (parsed.v !== RELAY_ENVELOPE_VERSION) return;
    const from = typeof parsed.from === 'string' ? parsed.from : '';
    const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
    if (!from || !kind) return;

    if (from === RELAY_PERSONA_CONTROL) {
      handleControl(parsed.payload);
      return;
    }
    if (from !== macPersona) return; // only the paired Mac routes traffic to us
    if (kind !== 'rpc') return;

    // payload = raw WsRpc frame (string) — unwrap and dispatch.
    const payload = parsed.payload;
    if (typeof payload !== 'string') return;
    let frame: MessageEnvelope;
    try {
      frame = frameCodec.deserialize(payload);
    } catch {
      return;
    }
    dispatchFrame(frame);
  }

  function handleControl(payload: unknown): void {
    if (!isRecord(payload) || typeof payload.type !== 'string') return;
    if (payload.type === 'peer_disconnected') {
      deliver(RELAY_CONTROL_CHANNELS.peerDisconnected, [payload]);
      return;
    }
    if (payload.type === 'delivery_failed') {
      deliver(RELAY_CONTROL_CHANNELS.deliveryFailed, [payload]);
    }
  }

  function deliver(channel: string, args: unknown[]): void {
    for (const cb of eventListeners) {
      try {
        cb(channel, args);
      } catch {
        // Listener errors must not break the channel.
      }
    }
  }

  function dispatchFrame(frame: MessageEnvelope): void {
    switch (frame.type) {
      case 'handshake_ack': {
        const reconnected = frame.reconnected === true;
        clientId = frame.clientId ?? null;
        if (!reconnected) {
          // Fresh session — the server restarts per-client seq from scratch
          // (mirror of WsRpcClient.onMessage handshake_ack handling).
          lastSeq = 0;
          sequencer.reset();
          replaySnapshot = null;
        } else {
          replaySnapshot = { clientId: clientId ?? '', lastSeq: sequencer.lastSeenSeq };
        }
        lastErrorKind = undefined;
        lastErrorMessage = undefined;
        lastCloseCode = undefined;
        lastCloseReason = undefined;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        setPhase('online');
        startAckTimer();
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        return;
      }
      case 'response': {
        const req = frame.id !== undefined ? pending.get(frame.id) : undefined;
        if (req) {
          pending.delete(frame.id);
          clearTimeout(req.timeout);
          if (frame.error) {
            const err = new Error(frame.error.message);
            (err as Error & { code?: string }).code = frame.error.code;
            req.reject(err);
          } else {
            req.resolve(frame.result);
          }
        }
        return;
      }
      case 'error': {
        // Protocol-level error (handshake rejection / version mismatch —
        // server-core only sends type:'error' during the handshake). On the
        // relay path the Mac's AUTH_FAILED closes only its loopback pipe, so
        // without this teardown our relay socket would linger half-open until
        // the connect timer fired and mislabeled the failure as 'timeout'.
        lastErrorKind = frame.error?.code === 'AUTH_FAILED' ? 'auth' : 'protocol';
        lastErrorMessage = frame.error?.message ?? 'Relay tunnel protocol error';
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        const erroredSocket = ws;
        ws = null;
        if (erroredSocket) detachSocket(erroredSocket);
        setPhase('offline');
        failReady(typedError(lastErrorMessage, { errorKind: lastErrorKind }));
        return;
      }
      case 'event': {
        if (typeof frame.seq === 'number') lastSeq = Math.max(lastSeq, frame.seq);
        // Replay dedup + ordering gate (card step 4).
        if (!sequencer.shouldDeliver(frame)) return;
        if (frame.channel !== undefined) deliver(frame.channel, frame.args ?? []);
        return;
      }
      default:
        return; // request/sequence_ack are Mac-side concerns; ignore
    }
  }

  // -- lifecycle -------------------------------------------------------------

  function handleClose(event: { code?: number; reason?: string; wasClean?: boolean }): void {
    lastCloseCode = typeof event?.code === 'number' ? event.code : undefined;
    lastCloseReason = event?.reason || undefined;
    if (classifyClose(lastCloseCode) === 'auth') lastErrorKind = 'auth';
    // Snapshot replay identity for the next connect (mirror of WsRpcClient
    // onDisconnect): reconnectClientId + lastSeq, kept in memory per card.
    if (clientId) replaySnapshot = { clientId, lastSeq };
    const wasOnline = phase === 'online';
    clearTimers();
    rejectPending(wasOnline ? 'Connection lost' : 'Relay connection failed');
    const readyError = typedError(
      lastErrorMessage ?? `Relay connection closed${lastCloseCode !== undefined ? ` (${lastCloseCode})` : ''}`,
      { closeCode: lastCloseCode, errorKind: lastErrorKind },
    );
    failReady(readyError);
    ws = null;
    if (phase !== 'offline') setPhase('offline');
  }

  return {
    kind: 'relay' as ChannelKind,

    connect(): Promise<void> {
      if (destroyed) return Promise.reject(new Error('Relay channel destroyed'));
      if (phase === 'online') return Promise.resolve();

      if (ws) {
        const stale = ws;
        ws = null;
        detachSocket(stale);
      }
      clearTimers();
      rejectPending('Relay channel reconnecting');

      lastCloseCode = undefined;
      lastCloseReason = undefined;
      lastErrorKind = undefined;
      lastErrorMessage = undefined;
      setPhase('connecting');

      return new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;

        const socket = createWebSocket(buildRelayHandshakeUrl(relayUrl, phoneDeviceId, token));
        ws = socket;

        connectTimer = setTimeout(() => {
          if (phase === 'online') return;
          lastErrorKind = 'timeout';
          lastErrorMessage = `Relay connect timeout after ${connectTimeoutMs}ms`;
          const socketToClose = ws;
          ws = null;
          if (socketToClose) detachSocket(socketToClose);
          setPhase('offline');
          failReady(typedError(lastErrorMessage, { errorKind: 'timeout' }));
        }, connectTimeoutMs);

        socket.onopen = () => {
          if (ws !== socket) return; // stale socket
          sendHandshake();
        };

        socket.onmessage = (event) => {
          if (ws !== socket) return;
          const data = event.data;
          handleRaw(typeof data === 'string' ? data : String(data));
        };

        socket.onclose = (event) => {
          if (ws !== socket) return;
          handleClose(event);
        };

        socket.onerror = () => {
          if (ws !== socket) return;
          // 'close' follows; record a network cause in case close is info-free.
          if (!lastErrorMessage) lastErrorKind = 'network';
        };
      });
    },

    invoke(channel, ...args) {
      if (phase !== 'online' || !ws) {
        return Promise.reject(new Error(`Not connected (relay channel: ${channel})`));
      }
      return new Promise<unknown>((resolve, reject) => {
        const id = newUuid();
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Request timeout: ${channel} (${requestTimeoutMs}ms)`));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timeout });
        const sent = sendFrame({ id, type: 'request', channel, args });
        if (!sent) {
          pending.delete(id);
          clearTimeout(timeout);
          reject(new Error(`Not connected (relay channel: ${channel})`));
        }
      });
    },

    on(cb) {
      eventListeners.add(cb);
      return () => {
        eventListeners.delete(cb);
      };
    },

    onState(cb) {
      stateListeners.add(cb);
      return () => {
        stateListeners.delete(cb);
      };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimers();
      // Fast-fail on channel switch — never silently drop (card step 3).
      rejectPending('Channel switched — retry on the active channel');
      failReady(new Error('Relay channel destroyed'));
      const socket = ws;
      ws = null;
      if (socket) detachSocket(socket);
      if (phase !== 'offline') setPhase('offline');
      stateListeners.clear();
      eventListeners.clear();
    },
  };
}
