/**
 * Xiaomi MiMo FILE-mode ASR adapter (POL-21, PRD §⑦ v1.5 裁决).
 *
 * Upstream: https://api.xiaomimimo.com/v1/chat/completions (OpenAI 兼容),
 * model mimo-v2.5-asr, Bearer MIMO_API_KEY（密钥只走环境变量，不落客户端）。
 * 关键区分（勿误判）：MiMo 无 WS/音频分片输入接口 —— 音频 wav/mp3 必须 Base64
 * 整段上送（Data URL，≤10MB ≈ 16kHz 16bit mono wav 5 分钟），FILE 模式松开后
 * 才转写；其 stream=true 仅指响应文本经 SSE 分块渐进到达，非按住期实时出字
 * （capabilities.realtimeStreaming=false）。
 *
 * 请求体（mimo.mi.com Speech-Recognition 文档形状）：
 *   { model, stream: true,
 *     messages: [{ role: 'user', content: [{ type: 'input_audio',
 *       input_audio: { data: 'data:<mime>;base64,<b64>', format } }] }],
 *     asr_options: { language: 'auto' | 'zh' | 'en' } }
 * 响应：SSE `data: {chat.completion.chunk}`，文本在 choices[].delta.content
 * （增量）；`data: [DONE]` 终止。
 *
 * partial 对齐（App 无感供应商差异）：火山 partial 是累计全文快照，MiMo delta
 * 是增量 —— adapter 累计 delta 后以「到目前为止的全文」作为 partial 上抛
 * （seq 单调递增），App 侧同一帧协议与状态机照常工作。
 *
 * 计量与计费衔接（POL-245 service 不改）：meterSeconds = 实际上送音频字节 /
 * 32000（16kHz s16le 口径，push 端封顶 300s×32000=9.6MB ≤ 10MB 上限），service
 * settle(asr_final.seconds) 与墙钟守卫照常消费该值。MiMo 侧任何失败（402/
 * 超时/格式/断流）统一以致命 upstream_error 上抛 —— service 层错误帧 +
 * refund 全退 + 4501 收口；整段调用不自动重试（避免重复计费，失败交上层决定）。
 * relay 不缓存音频：帧序列拼装完整即转发调用，无论成败调用结束即丢弃缓冲。
 * 不打日志（service 层日志仅含 supplier/时长/结果码，无音频内容与密钥）。
 *
 * 已知风险（FIX-5 已修）：service finishSession 原先在客户端 end 后仅等全局
 * finalWaitMs（默认 5s）就发送 asr_final 并按实测秒 settle 收口 —— FILE 模式
 * 长音频（≈300s 整段 ≈13MB base64 上送 + MiMo 推理）的 final 到达常 >5s，届时
 * App 收到空文本 final、连接被提前关闭。现 FILE 模式按 per-mode finalWait
 * （POLO_RELAY_ASR_FILE_FINAL_WAIT_MS，默认 30s）等待，且转写期间 SSE 渐进
 * partial 出字即顺延截止（出字=活性）；墙钟守卫（330s）仍是硬上界。
 */

import { ASR_MARKUP_PERMILLE } from './capabilities.ts'
import { SSE_DONE_SENTINEL, SseParser } from './sse.ts'
import {
  ASR_MAX_DURATION_SEC,
  ASR_PCM_BYTES_PER_SEC,
  ASR_PCM_SAMPLE_RATE,
  type AsrAdapter,
  type AsrCapabilities,
  type AsrPartial,
  type AsrRateCard,
  type AsrStreamContext,
  type AsrStreamHandle,
  type AsrTranscribeRequest,
  type AsrTranscribeResult,
} from './types.ts'

export const MIMO_ASR_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'
export const MIMO_ASR_MODEL = 'mimo-v2.5-asr'
/** MiMo 文档上限：Base64 前的原始音频字节数。 */
export const MIMO_MAX_AUDIO_BYTES = 10 * 1024 * 1024

export type MimoAsrLanguage = 'auto' | 'zh' | 'en'

export interface MimoAsrOptions {
  /** MIMO_API_KEY（env 注入；缺省 → isConfigured=false → 握手 supplier_unavailable）。 */
  apiKey?: string
  /** 测试注入 mock 上游用。 */
  endpoint?: string
  /** asr_options.language（缺省 auto）。 */
  language?: MimoAsrLanguage
  /** 整段调用总超时（MIMO_TIMEOUT_MS env，缺省 60s）。超时不重试 → refund 语义。 */
  timeoutMs?: number
  /** 测试注入 mock fetch 用。 */
  fetchImpl?: typeof fetch
}

export function mimoAsrOptionsFromEnv(env: Record<string, string | undefined> = process.env): MimoAsrOptions {
  const rawLanguage = env['MIMO_ASR_LANGUAGE']?.trim()
  const language = rawLanguage === 'zh' || rawLanguage === 'en' ? rawLanguage : 'auto'
  const rawTimeout = Number(env['MIMO_TIMEOUT_MS']?.trim())
  return {
    apiKey: env['MIMO_API_KEY']?.trim() || undefined,
    language,
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 60_000,
  }
}

export type MimoAsrErrorCode =
  | 'supplier_unavailable'
  | 'unsupported_audio_format'
  | 'audio_too_large'
  | 'insufficient_balance'
  | 'upstream_timeout'
  | 'upstream_error'

export class MimoAsrError extends Error {
  readonly code: MimoAsrErrorCode

  constructor(code: MimoAsrErrorCode, message: string) {
    super(message)
    this.name = 'MimoAsrError'
    this.code = code
  }
}

export type MimoAudioFormat = 'wav' | 'mp3'

/**
 * Magic-byte sniffing（服务端实测口径，不信任客户端上报的 mime）：
 * wav = 'RIFF'….…'WAVE'；mp3 = 'ID3' 头或 0xFFEx 帧同步。
 */
export function sniffMimoAudioFormat(bytes: Uint8Array): MimoAudioFormat | null {
  if (bytes.length >= 12) {
    const head = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
    const wave = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
    if (head === 'RIFF' && wave === 'WAVE') return 'wav'
  }
  if (bytes.length >= 3) {
    const head = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!)
    if (head === 'ID3') return 'mp3'
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'mp3'
  return null
}

interface MimoChatChunk {
  choices?: Array<{ delta?: { content?: string | null } | null } | null>
}

/** 从一条 SSE data 提取增量文本；非 JSON 行/空 delta → null（容错跳过）。 */
export function extractMimoDelta(data: string): string | null {
  if (data === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  const content = (parsed as MimoChatChunk).choices?.[0]?.delta?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}

export class MimoFileAsrAdapter implements AsrAdapter {
  readonly id = 'mimo'
  readonly mode = 'FILE' as const
  readonly capabilities: AsrCapabilities = {
    realtimeStreaming: false, // 松开后才转写；「流式」仅指响应 SSE 分块到达
    maxDurationSec: ASR_MAX_DURATION_SEC, // 300s：10MB ≈ 16kHz 16bit mono wav 5 分钟
    // 仅作展示提示，不做服务端语言强制校验（PRD §⑦）。
    languages: ['zh', 'en', 'auto', '粤语', '吴语', '闽南语', '四川话'],
    // App 采集端恒为 16kHz s16le PCM，FILE 模式由采集端拼装 wav 容器整段上送。
    audio: { encoding: 'pcm_s16le', sampleRate: ASR_PCM_SAMPLE_RATE },
  }
  /**
   * 内置速率卡占位：MiMo 按量单价未公开（pricePerRequestCny=null = 不可报价，
   * admin quote 422 / asr 4403 语义）。单价待控制台查证回填（2026-10-17 实测
   * key 有效、转写 402 insufficient_balance，充值后人工回填，关联 M2-6 待查项）。
   * admin/env 配置存在时被覆盖（admin 是事实源）。
   */
  readonly rateCard: AsrRateCard = {
    pricePerHourCny: null,
    pricePerRequestCny: null,
    markupPermille: ASR_MARKUP_PERMILLE,
    mock: false,
  }

  private readonly endpoint: string
  private readonly language: MimoAsrLanguage
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: MimoAsrOptions = {}) {
    this.endpoint = options.endpoint ?? MIMO_ASR_ENDPOINT
    this.language = options.language ?? 'auto'
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  isConfigured(): boolean {
    return Boolean(this.options.apiKey)
  }

  /**
   * FILE 模式的流式接入位：service（POL-245，不改）在 prehold 成功后的首个音频
   * 分片调 startStream，分片进本端缓冲（服务端实测计量封顶 300s），客户端 end
   * 触发 finish() → 整段拼装 → HTTP 调 MiMo → SSE 逐 chunk 经 onPartial 渐进
   * 上抛 → onFinal 收口。与火山 partial 转发机制完全同形。
   */
  startStream(ctx: AsrStreamContext): AsrStreamHandle {
    if (!this.isConfigured()) {
      ctx.onError('supplier_unavailable', 'mimo ASR credentials are not configured (MIMO_API_KEY)')
      return inertHandle()
    }

    const adapter = this
    const maxBytes = this.capabilities.maxDurationSec * ASR_PCM_BYTES_PER_SEC // 9.6MB ≤ 10MB
    let meteredBytes = 0
    let capNotified = false
    let finished = false
    let aborted = false
    /** onFinal/onError 已发出一次 —— 回调至多一次，abort/重复收口后不再发。 */
    let settled = false
    const chunks: Uint8Array[] = []
    const externalAbort = new AbortController()

    const notifyCapOnce = (): void => {
      if (capNotified) return
      capNotified = true
      ctx.onError('max_duration_reached', `max duration ${ASR_MAX_DURATION_SEC}s reached; trailing audio dropped`)
    }

    const runFinish = (): void => {
      if (finished) return
      finished = true
      // 拼装完整即转发；无论成败调用结束即丢弃缓冲（relay 无持久化）。
      const audio = concat(chunks)
      chunks.length = 0
      void adapter
        .transcribeStreaming(
          audio,
          (partial) => {
            if (!aborted && !settled) ctx.onPartial(partial)
          },
          externalAbort.signal,
        )
        .then((result) => {
          if (aborted || settled) return
          settled = true
          ctx.onFinal(result.text)
        })
        .catch((error: unknown) => {
          if (aborted || settled) return
          settled = true
          // 统一致命语义：service 对 upstream_error 回错误帧 + refund 全退 + 4501。
          const code = error instanceof MimoAsrError ? error.code : 'upstream_error'
          ctx.onError('upstream_error', `mimo ${code}: ${describe(error)}`)
        })
    }

    return {
      pushAudio(bytes: Uint8Array): void {
        if (finished || aborted) return
        if (meteredBytes >= maxBytes) {
          notifyCapOnce()
          return
        }
        const room = maxBytes - meteredBytes
        if (bytes.length > room) {
          // 边界分片截断到计量顶（超出部分丢弃）：装配结果恒 ≤ 9.6MB ≤ MiMo 10MB，
          // 不会出现「已报 max_duration_reached 却在 finish 时 audio_too_large 全退」。
          chunks.push(bytes.subarray(0, room))
          meteredBytes = maxBytes
          notifyCapOnce()
          return
        }
        meteredBytes += bytes.length
        chunks.push(bytes)
      },
      finish: runFinish,
      abort(): void {
        if (aborted) return
        aborted = true
        finished = true
        chunks.length = 0
        externalAbort.abort() // 中断在途上游调用（计费走上层 refund 全退）
      },
      meterSeconds(): number {
        // 服务端实测：实际上送音频字节 / 32000（16kHz s16le 口径）——计费唯一来源。
        return meteredBytes / ASR_PCM_BYTES_PER_SEC
      },
    }
  }

  /** AsrAdapter FILE 方法：整段转写（无 partial 上抛；流式版本供 startStream 用）。 */
  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return this.transcribeStreaming(request.audio)
  }

  /**
   * 核心 FILE 路径：mime/大小守卫 → Base64 Data URL 整段上送 → SSE 逐 chunk
   * 解析 delta.content 累计 → onDelta 渐进上抛（可选）→ 全文返回。
   * 失败不自动重试（避免重复计费）。
   */
  private async transcribeStreaming(
    audio: Uint8Array,
    onDelta?: (partial: AsrPartial) => void,
    externalSignal?: AbortSignal,
  ): Promise<AsrTranscribeResult> {
    if (!this.isConfigured()) {
      throw new MimoAsrError('supplier_unavailable', 'mimo ASR credentials are not configured (MIMO_API_KEY)')
    }
    // 守卫先于供应商调用：>10MB / 非 wav/mp3 不产生任何上游请求。
    if (audio.length > MIMO_MAX_AUDIO_BYTES) {
      throw new MimoAsrError('audio_too_large', `audio exceeds MiMo 10MB limit (${audio.length} bytes, http 413 semantics)`)
    }
    const format = sniffMimoAudioFormat(audio)
    if (!format) {
      throw new MimoAsrError('unsupported_audio_format', 'only wav/mp3 audio is supported by mimo ASR')
    }

    const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg'
    const base64 = toBase64(audio)
    const body = JSON.stringify({
      model: MIMO_ASR_MODEL,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: `data:${mime};base64,${base64}`, format },
            },
          ],
        },
      ],
      asr_options: { language: this.language },
    })

    const controller = new AbortController()
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    // 读循环竞态Abort：真 fetch abort 会使 reader.read() 拒绝；mock 流可能无视
    // signal，由该 promise 保证超时/取消仍能收口。
    const abortReject = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(
            timedOut
              ? new MimoAsrError('upstream_timeout', `mimo request timed out after ${this.timeoutMs}ms`)
              : new MimoAsrError('upstream_error', 'mimo request aborted'),
          )
        },
        { once: true },
      )
    })
    void abortReject.catch(() => {}) // 完成后才 abort 的场景不产生未处理拒绝

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        // 402 insufficient_balance（账户未充值实测形态）单独成码，便于上层归因；
        // 其余状态归 upstream_error。两者最终都映射致命错误帧 + 预扣全退。
        const code: MimoAsrErrorCode = response.status === 402 ? 'insufficient_balance' : 'upstream_error'
        throw new MimoAsrError(code, `mimo http ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      if (!response.body) {
        throw new MimoAsrError('upstream_error', 'mimo response has no body')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      let text = ''
      let seq = 0
      let sawDone = false

      const consume = (events: ReturnType<SseParser['push']>): boolean => {
        for (const event of events) {
          if (event.data === SSE_DONE_SENTINEL) return true // [DONE] 终止
          const delta = extractMimoDelta(event.data)
          if (delta !== null) {
            text += delta
            seq += 1
            onDelta?.({ text, seq }) // 累计全文快照 + 单调 seq —— 与火山 partial 同形
          }
        }
        return false
      }

      for (;;) {
        const { value, done } = await Promise.race([reader.read(), abortReject])
        if (done) break
        if (consume(parser.push(decoder.decode(value, { stream: true })))) {
          sawDone = true
          // [DONE] 提前收口：显式取消 body 释放底层连接，残余 chunk 不再读。
          void reader.cancel().catch(() => {})
          break
        }
      }
      if (!sawDone) {
        // 容错结尾无空行/无换行的最后一个事件；此后仍无 [DONE] = 断流。
        sawDone = consume(parser.flush())
      }
      if (!sawDone) {
        throw new MimoAsrError('upstream_error', 'mimo stream closed before [DONE]')
      }
      return { text, seconds: audio.length / ASR_PCM_BYTES_PER_SEC }
    } catch (error) {
      if (error instanceof MimoAsrError) throw error
      // 真 fetch 在 signal abort 时以 AbortError 拒绝（先于 abortReject 竞态分支），
      // 此处按 timedOut 标志还原超时语义。
      if (timedOut) throw new MimoAsrError('upstream_timeout', `mimo request timed out after ${this.timeoutMs}ms`)
      throw new MimoAsrError('upstream_error', `mimo upstream error: ${describe(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

// --- helpers -------------------------------------------------------------------

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  return new Uint8Array(Buffer.concat(chunks))
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inertHandle(): AsrStreamHandle {
  return { pushAudio: () => {}, finish: () => {}, abort: () => {}, meterSeconds: () => 0 }
}
