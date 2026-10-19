// /asr WebSocket session (POL-249 card step 3) — the App side of the relay
// streaming pipeline (POL-245; wire verified against packages/relay/src/asr/
// {types,service,server}.ts — relay source is the contract, App adapts).
//
//   connect  GET {relay}/asr?side=phone&deviceId=<id>&token=<adminJWT>
//            (RN cannot set WS headers — query-param auth, relayChannel.ts:9).
//            The RELAY performs quote+prehold during the handshake and then
//            emits the capability frame; the App never calls prehold itself.
//   frames   client → {type:"audio",data:<base64>} | {type:"end"} | {type:"cancel"}
//            (binary WS frames are also accepted as raw audio chunks — used
//            here for STREAM tails);
//            server → asr_ready{supplier,mode,realtimeStreaming,maxDurationSec,
//            languages,rateCard,preholdSeconds,preholdCredits,preholdId}
//                   | asr_partial{text,seq}   (cumulative snapshots)
//                   | asr_final{text,seconds}
//                   | asr_error{code,message} (+ close codes 4401-4502).
//   billing  settle/refund happen relay-side on {end}/{cancel}/close (service.ts
//            settle()). The App displays outcomes from wire signals only —
//            it must NOT settle/refund the relay-owned preholdId itself.
//   close    any close ends the session; the hook owns recorder cleanup.

// ---------------------------------------------------------------------------
// Wire types (mirror of relay AsrServerFrame — structural, no runtime import:
// packages/relay is outside the mobile module graph)
// ---------------------------------------------------------------------------

export type AsrMode = 'STREAM' | 'FILE';

export type AsrErrorFrameCode =
  | 'invalid_frame'
  | 'not_ready'
  | 'supplier_unknown'
  | 'supplier_unavailable'
  | 'insufficient_balance'
  | 'not_quotable'
  | 'billing_unavailable'
  | 'unauthorized'
  | 'upstream_error'
  | 'max_duration_reached'
  | 'session_timeout';

export interface AsrRateCard {
  pricePerHourCny: number | null;
  pricePerRequestCny: number | null;
  markupPermille: number;
  mock: boolean;
}

/** asr_ready 握手帧 — App 存能力缓存，按 realtimeStreaming 分支渲染。 */
export interface AsrReadyInfo {
  supplier: string;
  mode: AsrMode;
  realtimeStreaming: boolean;
  maxDurationSec: number;
  languages: string[];
  rateCard: AsrRateCard;
  preholdSeconds: number;
  preholdCredits: number;
  preholdId: string;
}

export type AsrServerFrame =
  | ({ type: 'asr_ready' } & AsrReadyInfo)
  | { type: 'asr_partial'; text: string; seq: number }
  | { type: 'asr_final'; text: string; seconds: number }
  | { type: 'asr_error'; code: AsrErrorFrameCode; message: string };

export interface AsrCloseInfo {
  code?: number;
  reason?: string;
}

/** Relay /asr close codes (relay types.ts ASR_CLOSE_CODE) — classification only. */
export const ASR_CLOSE = {
  UNAUTHORIZED: 4401,
  INSUFFICIENT_BALANCE: 4402,
  NOT_QUOTABLE: 4403,
  SUPPLIER_UNKNOWN: 4404,
  SUPPLIER_UNAVAILABLE: 4405,
  BILLING_UNAVAILABLE: 4500,
  UPSTREAM_ERROR: 4501,
  SESSION_TIMEOUT: 4502,
} as const;

/** Minimal WS surface (RN global WebSocket fits; tests inject fakes). */
export interface AsrWebSocketLike {
  readyState: number;
  /** Text (JSON frames) or binary (audio chunk frames, RN sends ArrayBuffer). */
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export type AsrWebSocketFactory = (url: string) => AsrWebSocketLike;

export interface AsrSessionOptions {
  /** Relay base, e.g. wss://relay.z-h-ai.com (EXPO_PUBLIC_RELAY_URL). */
  relayUrl: string;
  /** This phone's admin device row id (relay persona deviceId). */
  phoneDeviceId: string;
  /** Admin JWT — /asr upgrade auth (query param). */
  token: string;
  /** asr_ready budget (quote+prehold hop). Default 8000ms. */
  readyTimeoutMs?: number;
  createWebSocket?: AsrWebSocketFactory;
}

export interface AsrSessionHandlers {
  onReady(info: AsrReadyInfo): void;
  onPartial(text: string, seq: number): void;
  onFinal(text: string, seconds: number): void;
  onError(code: AsrErrorFrameCode, message: string): void;
  onClosed(info: AsrCloseInfo): void;
}

/** Error carrying the asr_error frame code (handshake failures, etc.). */
export class AsrSessionError extends Error {
  readonly code: AsrErrorFrameCode | 'closed' | 'timeout';
  readonly closeInfo?: AsrCloseInfo;

  constructor(code: AsrErrorFrameCode | 'closed' | 'timeout', message: string, closeInfo?: AsrCloseInfo) {
    super(message);
    this.name = 'AsrSessionError';
    this.code = code;
    this.closeInfo = closeInfo;
  }
}

const WS_OPEN = 1;
const DEFAULT_READY_TIMEOUT_MS = 8_000;

/** Builds {relay}/asr upgrade URL with RN query-param auth. */
export function buildAsrUrl(relayUrl: string, phoneDeviceId: string, token: string): string {
  const base = relayUrl.replace(/\/+$/, '');
  const separator = base.includes('?') ? '&' : '?';
  return (
    `${base}/asr${separator}side=phone` +
    `&deviceId=${encodeURIComponent(phoneDeviceId)}` +
    `&token=${encodeURIComponent(token)}`
  );
}

/**
 * Parses one relay → client frame. Returns null for anything that is not an
 * asr frame (heartbeats arrive here too — ping is answered by the caller).
 */
export function parseAsrServerFrame(raw: string): AsrServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  switch (frame.type) {
    case 'asr_ready': {
      if (
        typeof frame.supplier !== 'string' ||
        (frame.mode !== 'STREAM' && frame.mode !== 'FILE') ||
        typeof frame.realtimeStreaming !== 'boolean' ||
        typeof frame.maxDurationSec !== 'number' ||
        typeof frame.preholdId !== 'string'
      ) {
        return null;
      }
      return {
        type: 'asr_ready',
        supplier: frame.supplier,
        mode: frame.mode,
        realtimeStreaming: frame.realtimeStreaming,
        maxDurationSec: frame.maxDurationSec,
        languages: asStringArray(frame.languages),
        rateCard: asRateCard(frame.rateCard),
        preholdSeconds: asNumber(frame.preholdSeconds, 60),
        preholdCredits: asNumber(frame.preholdCredits, 0),
        preholdId: frame.preholdId,
      };
    }
    case 'asr_partial': {
      if (typeof frame.text !== 'string' || typeof frame.seq !== 'number') return null;
      return { type: 'asr_partial', text: frame.text, seq: frame.seq };
    }
    case 'asr_final': {
      if (typeof frame.text !== 'string' || typeof frame.seconds !== 'number') return null;
      return { type: 'asr_final', text: frame.text, seconds: frame.seconds };
    }
    case 'asr_error': {
      if (typeof frame.code !== 'string' || typeof frame.message !== 'string') return null;
      return { type: 'asr_error', code: frame.code as AsrErrorFrameCode, message: frame.message };
    }
    default:
      return null;
  }
}

/** One /asr session = one 按住. Create via connectAsrSession(). */
export interface AsrSessionLike {
  readonly readyInfo: AsrReadyInfo | null;
  /** Raw audio chunk uplink (binary frame — relay treats it as one audio chunk). */
  sendAudioBytes(bytes: Uint8Array): void;
  /** Base64 text-frame uplink (same semantics; kept for contract parity). */
  sendAudioBase64(data: string): void;
  /** 松开：上游收尾 → asr_final（relay 按 metered 秒结算）。 */
  finish(): void;
  /** 上滑取消：relay refund 全退并收口。 */
  cancel(): void;
  /** Local teardown (no wire semantics beyond close). */
  close(): void;
}

export async function connectAsrSession(
  options: AsrSessionOptions,
  handlers: AsrSessionHandlers,
): Promise<AsrSessionLike> {
  const factory = options.createWebSocket ?? defaultWebSocket;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const url = buildAsrUrl(options.relayUrl, options.phoneDeviceId, options.token);

  const ws = factory(url);
  let readyInfo: AsrReadyInfo | null = null;
  let settledLocal = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let readyResolve: ((info: AsrReadyInfo) => void) | null = null;
  let readyReject: ((error: AsrSessionError) => void) | null = null;

  const detach = () => {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  };

  const clearReadyTimer = () => {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  };

  const failReady = (error: AsrSessionError) => {
    if (!readyReject) return;
    const reject = readyReject;
    readyResolve = null;
    readyReject = null;
    clearReadyTimer();
    reject(error);
  };

  ws.onclose = (event) => {
    const closeInfo: AsrCloseInfo = { code: event?.code, reason: event?.reason };
    if (!settledLocal) {
      settledLocal = true;
      clearReadyTimer();
      detach();
      if (readyReject) {
        failReady(new AsrSessionError('closed', '语音连接已关闭', closeInfo));
      }
      handlers.onClosed(closeInfo);
      return;
    }
  };

  ws.onerror = () => {
    // 'close' always follows; nothing to do but avoid unhandled rejections.
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let parsedHeartbeat: { type?: unknown } | null = null;
    try {
      const candidate: unknown = JSON.parse(event.data);
      if (typeof candidate === 'object' && candidate !== null) parsedHeartbeat = candidate;
    } catch {
      parsedHeartbeat = null;
    }
    // Relay app-level heartbeat (server.ts pings every 30s) — answer directly.
    if (parsedHeartbeat?.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      } catch {
        // socket dying; the close handler settles
      }
      return;
    }
    if (parsedHeartbeat?.type === 'pong') return;
    const frame = parseAsrServerFrame(event.data);
    if (frame === null) return;
    switch (frame.type) {
      case 'asr_ready': {
        readyInfo = frame;
        clearReadyTimer();
        const resolve = readyResolve;
        readyResolve = null;
        readyReject = null;
        resolve?.(frame);
        handlers.onReady(frame);
        return;
      }
      case 'asr_partial':
        handlers.onPartial(frame.text, frame.seq);
        return;
      case 'asr_final':
        handlers.onFinal(frame.text, frame.seconds);
        return;
      case 'asr_error':
        handlers.onError(frame.code, frame.message);
        return;
    }
  };

  // Await the handshake (asr_ready) before the first audio byte is legal
  // (relay drops pre-ready frames with asr_error not_ready).
  const ready = await new Promise<AsrReadyInfo>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    readyTimer = setTimeout(() => {
      // 握手超时必须就地收口：否则 socket 连同 handlers 一起泄漏——relay 照常完成
      // quote+prehold，连接被心跳维持到 330s 墙钟守卫才结算（预扣悬挂半小时+）。
      settledLocal = true; // onclose 静默（超时已由 reject 表达）
      detach();
      try {
        ws.close(1000, 'ready_timeout');
      } catch {
        // best effort
      }
      failReady(new AsrSessionError('timeout', `语音握手超时（${readyTimeoutMs}ms）`));
    }, readyTimeoutMs);
    ws.onopen = () => {
      // The relay drives quote+prehold on open; nothing to send first.
    };
  });

  const sendText = (text: string): boolean => {
    if (ws.readyState !== WS_OPEN || settledLocal) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  };

  return {
    get readyInfo() {
      return readyInfo;
    },
    sendAudioBytes(bytes) {
      if (bytes.length === 0) return;
      if (ws.readyState !== WS_OPEN || settledLocal) return;
      // Binary frame == one audio chunk (saves the base64 hop, service.ts:303).
      // Copy into a plain ArrayBuffer (RN/Hermes WebSocket sends it natively;
      // Uint8Array.buffer may be a SharedArrayBuffer per TS lib defs).
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      try {
        ws.send(buffer);
      } catch {
        // drop — the session-level error path handles the dead socket
      }
    },
    sendAudioBase64(data) {
      if (!data) return;
      sendText(JSON.stringify({ type: 'audio', data }));
    },
    finish() {
      if (settledLocal) return;
      sendText(JSON.stringify({ type: 'end' }));
    },
    cancel() {
      if (settledLocal) return;
      sendText(JSON.stringify({ type: 'cancel' }));
    },
    close() {
      if (settledLocal) return;
      settledLocal = true;
      clearReadyTimer();
      detach();
      try {
        ws.close();
      } catch {
        // best effort
      }
    },
  };
}

function defaultWebSocket(url: string): AsrWebSocketLike {
  return new WebSocket(url) as unknown as AsrWebSocketLike;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asRateCard(value: unknown): AsrRateCard {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    pricePerHourCny: typeof record.pricePerHourCny === 'number' ? record.pricePerHourCny : null,
    pricePerRequestCny: typeof record.pricePerRequestCny === 'number' ? record.pricePerRequestCny : null,
    markupPermille: asNumber(record.markupPermille, 1300),
    mock: record.mock === true,
  };
}
