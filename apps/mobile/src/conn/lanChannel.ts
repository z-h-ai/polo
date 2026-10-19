// LAN channel (POL-242 card step 1): WsRpcClient straight to the paired Mac.
//
// Card contract: direct connect over the wsUrl obtained at pairing, in-band
// token handshake with the admin JWT (server-core client.ts sends `token`
// inside the first handshake envelope — client.ts:412 — never in an HTTP
// header, which is why the RN no-custom-header limitation does not apply on
// this path; verified end-to-end by POL-231 / docs/rn-compat-checklist.md C1).
// Connection parameters: 5s handshake timeout (card), protocol-version check
// and request timeout semantics stay on the library defaults.
//
// autoReconnect is DISABLED here: the ConnectionManager owns retry timing
// (exponential backoff + relay fallback), so the two channels cannot fight
// over the socket. The WsRpcClient instance is kept across manager retries
// (the manager caches the channel), which preserves its internal
// reconnectClientId + lastSeq for ring-buffer replay (client.ts:697-703).
//
// RN contract surface: `@polo-ai/server-core/transport/client` is typechecked
// against types/shared-protocol.d.ts and bundled by Metro from the real
// server-core source via the rn resolver map (metro/ws-resolver.js). The lazy
// require below keeps that specifier out of the bun-test module graph, where
// tsconfig maps it to the type-shim (no runtime values) — tests inject fakes.

import type {
  TransportConnectionState,
  WsRpcClient,
  WsRpcClientOptions,
} from '@polo-ai/server-core/transport/client';

// ---------------------------------------------------------------------------
// Channel contract (shared by both channels; structural — no runtime edge)
// ---------------------------------------------------------------------------

export type ChannelKind = 'lan' | 'relay';

export type ChannelPhase = 'connecting' | 'online' | 'offline';

export interface ChannelState {
  phase: ChannelPhase;
  /** WebSocket close code, when the failure came with one (4005 etc.). */
  closeCode?: number;
  /** Close reason text, when available. */
  reason?: string;
  /** Transport-level error classification ('auth' | 'protocol' | ...). */
  errorKind?: string;
  /** Raw error message, when available. */
  errorMessage?: string;
}

export interface ConnChannel {
  readonly kind: ChannelKind;
  /** One connect attempt. Resolves on a completed handshake, rejects otherwise. */
  connect(): Promise<void>;
  /** WsRpc request/response over this channel. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Event stream (replay + live), as (channelName, args) pairs. */
  on(cb: (channel: string, args: unknown[]) => void): () => void;
  onState(cb: (state: ChannelState) => void): () => void;
  /** Tears the channel down; in-flight requests reject (fast-fail semantics). */
  destroy(): void;
}

/** Minimal structural surface of WsRpcClient used by the channel. */
export interface WsRpcClientLike {
  connect(): void
  destroy(): void
  invoke(channel: string, ...args: any[]): Promise<any>
  onAnyEvent(callback: (channel: string, ...args: any[]) => void): () => void
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
}

export type WsRpcClientFactory = (url: string, opts: WsRpcClientOptions) => WsRpcClientLike;

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export const LAN_HANDSHAKE_TIMEOUT_MS = 5_000;
export const LAN_REQUEST_TIMEOUT_MS = 30_000;

export interface LanChannelOptions {
  /** Paired Mac direct URL, e.g. ws://192.168.31.42:9100 (QR wsUrl hint). */
  wsUrl: string;
  /** Admin JWT — in-band handshake token (Mac validates against admin). */
  token: string;
  /** Handshake/connect timeout. Default 5000ms (card: 5s 握手超时). */
  connectTimeoutMs?: number;
  /** Per-request timeout. Default 30000ms (library default). */
  requestTimeoutMs?: number;
  /** Injectable client factory (tests). Default: real WsRpcClient (lazy). */
  createClient?: WsRpcClientFactory;
}

function defaultCreateClient(url: string, opts: WsRpcClientOptions): WsRpcClientLike {
  // Lazy require: under bun test this specifier maps to the type shim (types/
  // shared-protocol.d.ts), which carries no runtime values — tests inject
  // `createClient` fakes instead. Metro resolves it through the rn resolver
  // map to packages/server-core/src/transport/client.ts (RN-proven, POL-231).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const mod = require('@polo-ai/server-core/transport/client') as typeof import('@polo-ai/server-core/transport/client');
  return new mod.WsRpcClient(url, opts);
}

export function createLanChannel(options: LanChannelOptions): ConnChannel {
  const wsUrl = options.wsUrl;
  const token = options.token;
  const connectTimeoutMs = options.connectTimeoutMs ?? LAN_HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? LAN_REQUEST_TIMEOUT_MS;
  const createClient = options.createClient ?? defaultCreateClient;

  let client: WsRpcClientLike | null = null;
  let destroyed = false;
  const stateListeners = new Set<(state: ChannelState) => void>();
  const eventListeners = new Set<(channel: string, args: unknown[]) => void>();
  const eventUnsubs = new Set<() => void>();
  const stateUnsubs = new Set<() => void>();

  function emitState(state: ChannelState): void {
    for (const cb of stateListeners) {
      try {
        cb(state);
      } catch {
        // Listener errors must not break the channel.
      }
    }
  }

  function toChannelState(state: TransportConnectionState): ChannelState {
    if (state.status === 'connected') return { phase: 'online' };
    if (state.status === 'connecting' || state.status === 'reconnecting' || state.status === 'idle') {
      return { phase: 'connecting' };
    }
    return {
      phase: 'offline',
      closeCode: state.lastClose?.code,
      reason: state.lastClose?.reason,
      errorKind: state.lastError?.kind,
      errorMessage: state.lastError?.message,
    };
  }

  function attach(clientToWatch: WsRpcClientLike): void {
    stateUnsubs.add(
      clientToWatch.onConnectionStateChanged((state) => {
        emitState(toChannelState(state));
      }),
    );
    eventUnsubs.add(
      clientToWatch.onAnyEvent((channel, ...args) => {
        for (const cb of eventListeners) {
          try {
            cb(channel, args);
          } catch {
            // Listener errors must not break the channel.
          }
        }
      }),
    );
  }

  return {
    kind: 'lan',

    connect(): Promise<void> {
      if (destroyed) return Promise.reject(new Error('LAN channel destroyed'));
      if (!client) {
        // autoReconnect: false — retry timing belongs to the ConnectionManager.
        client = createClient(wsUrl, {
          token,
          connectTimeout: connectTimeoutMs,
          requestTimeout: requestTimeoutMs,
          autoReconnect: false,
        });
        attach(client);
      }

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const stateUnsub = client!.onConnectionStateChanged((state) => {
          if (settled) return;
          if (state.status === 'connected') {
            settled = true;
            stateUnsub();
            resolve();
            return;
          }
          if (state.status === 'failed' || state.status === 'disconnected') {
            settled = true;
            stateUnsub();
            const detail = state.lastError?.message ?? state.lastClose?.reason ?? 'LAN connection failed';
            const err = new Error(detail) as Error & { closeCode?: number; errorKind?: string };
            err.closeCode = state.lastClose?.code;
            err.errorKind = state.lastError?.kind;
            reject(err);
          }
        });
        try {
          client!.connect();
        } catch (err) {
          if (!settled) {
            settled = true;
            stateUnsub();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    },

    invoke(channel, ...args) {
      if (!client) return Promise.reject(new Error('LAN channel not connected'));
      return client.invoke(channel, ...args);
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
      for (const unsub of stateUnsubs) unsub();
      stateUnsubs.clear();
      for (const unsub of eventUnsubs) unsub();
      eventUnsubs.clear();
      // WsRpcClient.destroy rejects all pending requests ('Client destroyed') —
      // the fast-fail-on-channel-switch semantic the card requires.
      client?.destroy();
      client = null;
    },
  };
}
