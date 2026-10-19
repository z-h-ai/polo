/**
 * Deterministic mock STREAM adapter (POL-245): 测试与本地联调用。无外部依赖、
 * 零随机性 —— partial 序列按固定脚本推进，final 文本固定；meterSeconds 仍按
 * 真实收流字节数计量（与火山同口径 16kHz s16le），供计费流程测试断言。
 *
 * 本地联调：POLO_RELAY_ASR_DEFAULT_SUPPLIER=mock。速率卡带 mock:true 标注，
 * App 展示须带演示标注（速率卡仅展示、不参与计算）。
 */

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

export const MOCK_ASR_FINAL_TEXT = '你好，世界'

export interface MockAsrOptions {
  /** 逐 partial 文本脚本（按 chunk 推进，可短于 chunk 数 —— 脚本耗尽后不再发 partial）。 */
  partialScript?: string[]
  /** finish() 时的 final 文本。 */
  finalText?: string
  /** 每 N 个音频分片推进一个 partial（缺省 1）。 */
  chunksPerPartial?: number
  /** 覆盖 supplier id（测试注册 'mimo' 等 FILE 占位时复用本类）。 */
  id?: string
  mode?: 'STREAM' | 'FILE'
  realtimeStreaming?: boolean
}

export class MockAsrAdapter implements AsrAdapter {
  readonly id: string
  readonly mode: 'STREAM' | 'FILE'
  readonly capabilities: AsrCapabilities
  readonly rateCard: AsrRateCard = {
    pricePerHourCny: 4.5,
    pricePerRequestCny: null,
    markupPermille: 1300,
    mock: true,
  }

  private readonly partialScript: string[]
  private readonly finalText: string
  private readonly chunksPerPartial: number
  private readonly realtimeStreaming: boolean

  constructor(options: MockAsrOptions = {}) {
    this.id = options.id ?? 'mock'
    this.mode = options.mode ?? 'STREAM'
    this.realtimeStreaming = options.realtimeStreaming ?? true
    this.partialScript = options.partialScript ?? ['你', '你好', '你好，世界']
    this.finalText = options.finalText ?? MOCK_ASR_FINAL_TEXT
    this.chunksPerPartial = Math.max(1, options.chunksPerPartial ?? 1)
    this.capabilities = {
      realtimeStreaming: this.realtimeStreaming,
      maxDurationSec: ASR_MAX_DURATION_SEC,
      languages: ['zh', 'en'],
      audio: { encoding: 'pcm_s16le', sampleRate: ASR_PCM_BYTES_PER_SEC / 2 },
    }
  }

  isConfigured(): boolean {
    return true
  }

  startStream(ctx: AsrStreamContext): AsrStreamHandle {
    const maxBytes = this.capabilities.maxDurationSec * ASR_PCM_BYTES_PER_SEC
    let meteredBytes = 0
    let chunks = 0
    let partialSeq = 0
    let scriptIndex = 0
    let finished = false
    let aborted = false
    let capNotified = false

    return {
      pushAudio: (bytes: Uint8Array): void => {
        if (finished || aborted) return
        if (meteredBytes >= maxBytes) {
          if (!capNotified) {
            capNotified = true
            ctx.onError('max_duration_reached', `max duration ${ASR_MAX_DURATION_SEC}s reached`)
          }
          return
        }
        meteredBytes = Math.min(maxBytes, meteredBytes + bytes.length)
        chunks += 1
        if (chunks % this.chunksPerPartial === 0 && scriptIndex < this.partialScript.length) {
          partialSeq += 1
          ctx.onPartial({ text: this.partialScript[scriptIndex]!, seq: partialSeq })
          scriptIndex += 1
        }
      },
      finish: (): void => {
        if (finished) return
        finished = true
        ctx.onFinal(this.finalText)
      },
      abort: (): void => {
        aborted = true
        finished = true
      },
      meterSeconds: (): number => meteredBytes / ASR_PCM_BYTES_PER_SEC,
    }
  }

  /** FILE 方法（整段转写）——mock 确定性实现，也验证接口形状；真实 FILE 见 POL-21 MiMo。 */
  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return { text: this.finalText, seconds: request.audio.length / ASR_PCM_BYTES_PER_SEC }
  }
}
