// tsc-side view of @polo-ai/shared/protocol (+ server-core transport) for the
// mobile app (POL-5; extended by POL-17).
//
// Why a shim instead of the real source: the app tsconfig program carries
// global typings that packages/* were never written against (expo-router's
// metro-require.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV;
// lib DOM's URL clashes with @types/node's), and those augmentations apply
// program-wide, so letting tsc follow imports into packages/*/src breaks on
// files that are green in their own tsconfig (checked by `typecheck:all`).
// The card forbids touching packages/*, so the app checks its usage against
// this curated surface while Metro keeps bundling the REAL shared source
// (verified by `bunx expo export`); extend this file as App cards consume
// more of the protocol — a missing export fails loudly in tsc.
//
// POL-17 additions mirror packages/shared/src/protocol/types.ts (MessageEnvelope)
// and packages/server-core/src/transport/{client,codec}.ts (WsRpcClient +
// frame codec) as of main@58f4cb01. Runtime values do NOT live here: bun test
// resolves these specifiers to this file (no runtime exports), so conn/ code
// either receives the real objects via injection or lazy-requires them with a
// documented fallback (see src/conn/*).

// ---------------------------------------------------------------------------
// @polo-ai/shared/protocol
// ---------------------------------------------------------------------------

export declare const PROTOCOL_VERSION: string;

export type MessageType =
  | 'handshake'
  | 'handshake_ack'
  | 'request'
  | 'response'
  | 'event'
  | 'error'
  | 'sequence_ack';

export interface WireError {
  code: string;
  message: string;
  data?: unknown;
}

export interface MessageEnvelope {
  id: string;
  type: MessageType;
  channel?: string;
  args?: unknown[];
  result?: unknown;
  error?: WireError;
  protocolVersion?: string;
  workspaceId?: string;
  token?: string;
  clientId?: string;
  serverId?: string;
  webContentsId?: number;
  clientCapabilities?: string[];
  registeredChannels?: string[];
  seq?: number;
  lastSeq?: number;
  reconnectClientId?: string;
  reconnected?: boolean;
  stale?: boolean;
  serverVersion?: string;
}

// ---------------------------------------------------------------------------
// @polo-ai/server-core/transport/client (WS-RPC client used by the LAN channel)
// ---------------------------------------------------------------------------

export type TransportMode = 'local' | 'remote';

export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown';

export interface TransportConnectionError {
  kind: TransportConnectionErrorKind;
  message: string;
  code?: string;
}

export interface TransportCloseInfo {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface TransportConnectionState {
  mode: TransportMode;
  status: TransportConnectionStatus;
  url: string;
  attempt: number;
  nextRetryInMs?: number;
  lastError?: TransportConnectionError;
  lastClose?: TransportCloseInfo;
  updatedAt: number;
}

export interface WsRpcClientOptions {
  workspaceId?: string;
  webContentsId?: number;
  /** Bearer token for remote auth — carried IN-BAND in the handshake envelope. */
  token?: string;
  requestTimeout?: number;
  maxReconnectDelay?: number;
  autoReconnect?: boolean;
  connectTimeout?: number;
  clientCapabilities?: string[];
  mode?: TransportMode;
  tlsRejectUnauthorized?: boolean;
}

export declare class WsRpcClient {
  constructor(url: string, opts?: WsRpcClientOptions);
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, callback: (...args: any[]) => void): () => void;
  onAnyEvent(callback: (channel: string, ...args: any[]) => void): () => void;
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void;
  getConnectionState(): TransportConnectionState;
  get isConnected(): boolean;
  connect(): void;
  reconnectNow(): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// @polo-ai/server-core/transport/codec (WsRpc frame codec)
// ---------------------------------------------------------------------------

export declare function serializeEnvelope(envelope: MessageEnvelope): string;
export declare function deserializeEnvelope(raw: string): MessageEnvelope;
