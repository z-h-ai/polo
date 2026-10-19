/**
 * Volcengine doubao streaming ASR adapter (POL-245 首发 STREAM 供应商, PRD §⑦).
 *
 * Upstream: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel (豆包流式语音
 * 识别大模型), full-duplex binary framing per the Volcano speech protocol:
 *   4-byte header [version|headerSize][messageType|flags][serialization|compression][reserved]
 *   - full client request  0b0001, JSON payload       → [u32 size][json]
 *   - audio-only request   0b0010, raw PCM payload    → [u32 size][pcm]; last frame flag 0b0010
 *   - full server response 0b1001, JSON (+gzip opt.)  → [u32 size][json] (seq flag adds seq prefix)
 *   - error response       0b1111                      → [u32 code][u32 size][message]
 * Auth headers (X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id) come only
 * from VOLCENGINE_ASR_* env — keys never reach the client (API key 不落客户端).
 *
 * 真连火山联调列人工（需注入密钥）；测试经 mock 上游 WS 验证协议形状。
 * meterSeconds: 16kHz s16le mono = 32000 B/s, capped at maxDurationSec —
 * 服务端实测，计费唯一来源。
 */

import { gunzipSync } from 'node:zlib'

import {
  ASR_MAX_DURATION_SEC,
  ASR_PCM_BYTES_PER_SEC,
  type AsrAdapter,
  type AsrCapabilities,
  type AsrRateCard,
  type AsrStreamContext,
  type AsrStreamHandle,
  type AsrTranscribeRequest,
  type AsrTranscribeResult,
} from './types.ts'

export const VOLC_ASR_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
const VOLC_ASR_RESOURCE_ID = 'volcengine.stream.asr'

// --- Binary framing constants (Volcano speech protocol) --------------------

const PROTOCOL_VERSION = 0b0001
const HEADER_SIZE_WORDS = 0b0001

const MSG_FULL_CLIENT_REQUEST = 0b0001
const MSG_AUDIO_ONLY_REQUEST = 0b0010
const MSG_FULL_SERVER_RESPONSE = 0b1001
const MSG_ERROR_SERVER_RESPONSE = 0b1111

const FLAG_NO_SEQUENCE = 0b0000
const FLAG_POSITIVE_SEQUENCE = 0b0001
const FLAG_LAST_NO_SEQUENCE = 0b0010

const SERIALIZATION_JSON = 0b0001
const SERIALIZATION_NONE = 0b1111
const COMPRESSION_NONE = 0b0000
const COMPRESSION_GZIP = 0b0001

function header(messageType: number, flags: number, serialization: number, compression: number): Uint8Array {
  const bytes = new Uint8Array(4)
  bytes[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS
  bytes[1] = (messageType << 4) | flags
  bytes[2] = (serialization << 4) | compression
  bytes[3] = 0x00
  return bytes
}

function withSizePrefix(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length, false)
  out.set(payload, 4)
  return out
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Full client request: header + [u32 size][json]. */
export function encodeVolcanoFullClientRequest(payload: unknown): Uint8Array {
  return concat([header(MSG_FULL_CLIENT_REQUEST, FLAG_NO_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_NONE), withSizePrefix(new TextEncoder().encode(JSON.stringify(payload)))])
}

/** Audio-only request: header + [u32 size][raw pcm]; `last` sets the last-frame flag. */
export function encodeVolcanoAudioChunk(pcm: Uint8Array, last: boolean): Uint8Array {
  return concat([
    header(MSG_AUDIO_ONLY_REQUEST, last ? FLAG_LAST_NO_SEQUENCE : FLAG_NO_SEQUENCE, SERIALIZATION_NONE, COMPRESSION_NONE),
    withSizePrefix(pcm),
  ])
}

export type VolcanoServerFrame =
  | { kind: 'result'; json: unknown; final: boolean }
  | { kind: 'error'; code: number; message: string }

/** Decodes a full/error server response (plain or gzip; with/without sequence prefix). */
export function decodeVolcanoServerFrame(data: Uint8Array): VolcanoServerFrame | null {
  if (data.length < 4) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const messageType = (view.getUint8(1) >> 4) & 0x0f
  const flags = view.getUint8(1) & 0x0f
  const serialization = (view.getUint8(2) >> 4) & 0x0f
  const compression = view.getUint8(2) & 0x0f

  // Message body after the 4-byte header: [optional seq block][u32 size][payload],
  // where the payload itself is (de)compressed per the compression nibble.
  let cursor = 4
  if (messageType === MSG_ERROR_SERVER_RESPONSE) {
    // [u32 code][u32 size][message] — a truncated frame must decode to null,
    // never throw (this runs inside the upstream onmessage handler).
    if (cursor + 8 > data.length) return null
    const code = view.getUint32(cursor, false)
    cursor += 4
    const size = view.getUint32(cursor, false)
    cursor += 4
    // Same strictness as the result branch: a declared size beyond the actual
    // payload is malformed — reject instead of silently clamping.
    if (cursor + size > data.length) return null
    const message = new TextDecoder().decode(data.subarray(cursor, cursor + size))
    return { kind: 'error', code, message }
  }

  if (messageType !== MSG_FULL_SERVER_RESPONSE) return null
  if ((flags & FLAG_POSITIVE_SEQUENCE) !== 0) {
    cursor += 8 // [u32 seq-size][i32 seq] — sequence value not needed for forwarding order
  }
  if (cursor + 4 > data.length) return null
  const size = view.getUint32(cursor, false)
  cursor += 4
  if (cursor + size > data.length) return null
  let payload = data.subarray(cursor, cursor + size)
  try {
    if (compression === COMPRESSION_GZIP) payload = new Uint8Array(gunzipSync(payload))
  } catch {
    return null
  }
  let decoded: unknown = null
  if (serialization === SERIALIZATION_JSON) {
    try {
      decoded = JSON.parse(new TextDecoder().decode(payload))
    } catch {
      decoded = null
    }
  }
  return { kind: 'result', json: decoded, final: (flags & FLAG_LAST_NO_SEQUENCE) !== 0 }
}

// --- Adapter ----------------------------------------------------------------

export interface VolcanoAsrOptions {
  /** VOLCENGINE_ASR_APPID（火山控制台应用 AppID）。 */
  appId?: string
  /** VOLCENGINE_ASR_ACCESS_TOKEN。 */
  accessToken?: string
  /** VOLCENGINE_ASR_RESOURCE_ID，以火山控制台开通页面为准（缺省 volcengine.stream.asr）。 */
  resourceId?: string
  /** 测试注入 mock 上游用。 */
  endpoint?: string
  connectTimeoutMs?: number
}

export function volcanoAsrOptionsFromEnv(env: Record<string, string | undefined> = process.env): VolcanoAsrOptions {
  return {
    appId: env['VOLCENGINE_ASR_APPID']?.trim() || undefined,
    accessToken: env['VOLCENGINE_ASR_ACCESS_TOKEN']?.trim() || undefined,
    resourceId: env['VOLCENGINE_ASR_RESOURCE_ID']?.trim() || VOLC_ASR_RESOURCE_ID,
  }
}

interface VolcanoResultPayload {
  result?: {
    text?: string
    is_final?: boolean
    utterances?: Array<{ text?: string; definite?: boolean }>
  }
}

export class VolcanoStreamAsrAdapter implements AsrAdapter {
  readonly id = 'volcengine'
  readonly mode = 'STREAM' as const
  readonly capabilities: AsrCapabilities = {
    realtimeStreaming: true,
    maxDurationSec: ASR_MAX_DURATION_SEC,
    languages: ['zh', 'en'],
    audio: { encoding: 'pcm_s16le', sampleRate: ASR_PCM_BYTES_PER_SEC / 2 },
  }
  /** 内置声明（首发 4.5 元/h ×1.3）；admin/env 配置存在时被覆盖。 */
  readonly rateCard: AsrRateCard = {
    pricePerHourCny: 4.5,
    pricePerRequestCny: null,
    markupPermille: 1300,
    mock: false,
  }

  private readonly endpoint: string
  private readonly connectTimeoutMs: number

  constructor(private readonly options: VolcanoAsrOptions = {}) {
    this.endpoint = options.endpoint ?? VOLC_ASR_ENDPOINT
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000
  }

  isConfigured(): boolean {
    return Boolean(this.options.appId && this.options.accessToken)
  }

  startStream(ctx: AsrStreamContext): AsrStreamHandle {
    if (!this.isConfigured()) {
      ctx.onError('supplier_unavailable', 'volcengine ASR credentials are not configured (VOLCENGINE_ASR_*)')
      return inertHandle()
    }

    const maxBytes = this.capabilities.maxDurationSec * ASR_PCM_BYTES_PER_SEC
    let meteredBytes = 0
    let seq = 0
    let lastText = ''
    let finalDelivered = false
    let fatal = false
    let finished = false
    let aborted = false
    let upstreamOpen = false
    let capNotified = false
    const pending: Uint8Array[] = []

    const ws = new WebSocket(this.endpoint, {
      headers: {
        'X-Api-App-Key': this.options.appId!,
        'X-Api-Access-Key': this.options.accessToken!,
        'X-Api-Resource-Id': this.options.resourceId ?? VOLC_ASR_RESOURCE_ID,
      },
    })
    ws.binaryType = 'arraybuffer'

    const connectTimer = setTimeout(() => {
      if (!upstreamOpen && !fatal) {
        fatal = true
        try { ws.close() } catch { /* already gone */ }
        ctx.onError('upstream_error', 'upstream connect timeout')
      }
    }, this.connectTimeoutMs)

    const sendAudio = (pcm: Uint8Array, last: boolean): void => {
      ws.send(encodeVolcanoAudioChunk(pcm, last))
    }
    const flushPending = (): void => {
      for (const chunk of pending.splice(0)) sendAudio(chunk, false)
      if (finished) sendAudio(new Uint8Array(0), true)
    }

    ws.onopen = () => {
      upstreamOpen = true
      clearTimeout(connectTimer)
      // 豆包 bigmodel 会话配置：16kHz s16le mono PCM，累计全文 + 分句 utterances。
      ws.send(encodeVolcanoFullClientRequest({
        user: { uid: ctx.userId ?? 'polo-relay' },
        audio: { format: 'pcm', codec: 'raw', rate: ASR_PCM_BYTES_PER_SEC / 2, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_punc: true, show_utterances: true, result_type: 'full' },
      }))
      flushPending()
    }

    ws.onmessage = (event: MessageEvent) => {
      if (fatal || finalDelivered) return
      const raw = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(0)
      const frame = decodeVolcanoServerFrame(raw)
      if (!frame) return
      if (frame.kind === 'error') {
        fatal = true
        ctx.onError('upstream_error', `volcengine ${frame.code}: ${frame.message}`)
        return
      }
      const payload = (frame.json ?? {}) as VolcanoResultPayload
      const text = payload.result?.text ?? lastText
      const isFinal = finished || frame.final || payload.result?.is_final === true
      if (isFinal) {
        // 收口消息只走 final，不再重复发 partial。
        finalDelivered = true
        lastText = text
        ctx.onFinal(text)
        return
      }
      if (text !== lastText) {
        lastText = text
        seq += 1
        ctx.onPartial({ text, seq })
      }
    }

    const failUpstream = (message: string): void => {
      if (fatal || finalDelivered) return
      fatal = true
      ctx.onError('upstream_error', message)
    }
    ws.onerror = () => failUpstream('upstream connection error')
    ws.onclose = () => {
      clearTimeout(connectTimer)
      failUpstream('upstream closed before final result')
    }

    return {
      pushAudio(bytes: Uint8Array): void {
        if (finished || aborted || fatal) return
        if (meteredBytes >= maxBytes) {
          if (!capNotified) {
            capNotified = true
            ctx.onError('max_duration_reached', `max duration ${ASR_MAX_DURATION_SEC}s reached; trailing audio dropped`)
          }
          return
        }
        meteredBytes = Math.min(maxBytes, meteredBytes + bytes.length)
        if (aborted) return
        if (upstreamOpen) sendAudio(bytes, false)
        else pending.push(bytes)
      },
      finish(): void {
        if (finished) return
        finished = true
        if (upstreamOpen) sendAudio(new Uint8Array(0), true)
        // 仍在连接中时由 flushPending 在 open 后补发 last 帧。
      },
      abort(): void {
        if (aborted) return
        aborted = true
        finished = true
        clearTimeout(connectTimer)
        try { ws.close() } catch { /* already gone */ }
      },
      meterSeconds(): number {
        return meteredBytes / ASR_PCM_BYTES_PER_SEC
      },
    }
  }

  /** FILE 方法接口位：火山无 FILE 模式，MiMo 在 POL-21 实现。显式拒绝而非静默。 */
  async transcribe(_request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    const error = new Error('volcengine is STREAM-only; FILE transcription is the mimo adapter (POL-21)')
    ;(error as Error & { code?: string }).code = 'file_not_supported'
    throw error
  }
}

function inertHandle(): AsrStreamHandle {
  return {
    pushAudio: () => {},
    finish: () => {},
    abort: () => {},
    meterSeconds: () => 0,
  }
}
