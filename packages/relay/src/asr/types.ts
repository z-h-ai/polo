/**
 * ASR domain types & wire protocol for polo-relay (POL-245, PRD v1.6 §⑦).
 *
 * 多供应商适配层：AsrAdapter = supplier + capabilities{realtimeStreaming,
 * maxDurationSec, languages} + rateCard + STREAM/FILE 双方法 + meterSeconds()
 * 服务端实测计量（计费唯一来源，客户端上报不可信）。
 *
 * 链路决策一：手机 → wss relay /asr → 供应商流式 ASR。理由：计费权威在
 * relay/admin（服务端计量）、供应商 API key 永不下落手机端、admin 保持纯 HTTP。
 *
 * Wire protocol（App 与 relay 对齐用，App 侧类型在 M2-5 落地）：
 * - client → relay（text WS 帧，JSON）：{type:"audio",data:<base64>} | {type:"end"} | {type:"cancel"}
 *   纯二进制 WS 帧也接受，等价于 audio 分片（省一次 base64）。
 * - relay → client：asr_ready（能力+速率卡握手帧）/ asr_partial / asr_final / asr_error。
 *   错误帧统一携带 code 与 message，App 按 code 决定禁按、重试或重新登录，不解析自由文本。
 * - 速率卡数值随握手帧下发，App 仅展示、不参与任何计算（计费恒在 admin）。
 */

import { z } from 'zod'

export const ASR_PROTOCOL_VERSION = 1 as const

/** PRD §⑦ 单次识别上限 5 分钟（admin settle 入参上限同值）。 */
export const ASR_MAX_DURATION_SEC = 300
/** PRD §⑦ 开始识别预扣 60 秒。 */
export const ASR_PREHOLD_SECONDS = 60
/**
 * 单连接墙钟上限（秒）＝ prehold 60 + 计量顶 300 − 30s 结算余量 = 330。
 * admin PENDING 惰性过期窗 = 60+300 = 360s（自 prehold 起）；settle 必须在此之前
 * 到达，否则流水被 EXPIRED 全退 —— 慢滴音频 / 到顶后挂死 / 死连接都会让墙钟远超
 * 计量秒数，relay 端必须自带守卫按实测秒收口（资金口径：不得依赖 admin 全退兜底白嫖）。
 */
export const ASR_SESSION_WALL_GUARD_SECONDS = ASR_PREHOLD_SECONDS + ASR_MAX_DURATION_SEC - 30
/** 火山 STREAM 上行音频：16kHz s16le mono PCM。 */
export const ASR_PCM_SAMPLE_RATE = 16_000
export const ASR_PCM_BYTES_PER_SEC = ASR_PCM_SAMPLE_RATE * 2

export type AsrMode = 'STREAM' | 'FILE'

export interface AsrCapabilities {
  realtimeStreaming: boolean
  maxDurationSec: number
  languages: string[]
  /** 上行音频期望格式（relay 是透传代理，此字段仅供 App 采集端对齐）。 */
  audio: { encoding: 'pcm_s16le'; sampleRate: number }
}

export interface AsrRateCard {
  /** STREAM 供应商：元/小时；FILE 供应商为 null（null = 未定价 = 不可报价）。 */
  pricePerHourCny: number | null
  /** FILE 供应商：元/次；STREAM 供应商为 null。 */
  pricePerRequestCny: number | null
  /** 加价系数，permille 整数（1300 = ×1.3），与 admin VOICE_MARKUP_PERMILLE 同源。 */
  markupPermille: number
  /** true = mock 占位数值（测试/本地联调），App 展示须带演示标注，不可作真实价格。 */
  mock: boolean
}

/** partial 事件：按序推送，seq 自 1 单调递增。 */
export interface AsrPartial {
  text: string
  seq: number
}

export interface AsrStreamContext {
  /** 上行用户 id（供应商侧 user.uid / 审计线索；不参与计费）。 */
  userId?: string
  onPartial(partial: AsrPartial): void
  onFinal(text: string): void
  /**
   * 供应商级错误/通知。`upstream_error` 由 service 视为致命（错误帧 + refund +
   * 关闭 4501）；其余 code（如 max_duration_reached）仅回错误帧，连接保持。
   */
  onError(code: string, message: string): void
}

export interface AsrStreamHandle {
  /** 推一段音频分片（原始 PCM 字节；超出计量上限的分片被丢弃并回报 max_duration_reached）。 */
  pushAudio(bytes: Uint8Array): void
  /** 客户端声明上行结束；adapter 收尾并最终回调 onFinal 一次。 */
  finish(): void
  /** 客户端取消（上滑）：中断上游；计费走 refund 全退。 */
  abort(): void
  /** 服务端实测已收音频秒数（封顶 maxDurationSec）——计费唯一来源。 */
  meterSeconds(): number
}

export interface AsrTranscribeRequest {
  audio: Uint8Array
  audioEncoding?: string
}

export interface AsrTranscribeResult {
  text: string
  /** 服务端实测音频秒数（FILE 计费计量）。 */
  seconds: number
}

/**
 * AsrAdapter（PRD §⑦ 一等公民接口）。STREAM = startStream 分片推流 + partial
 * 回调；FILE = transcribe 整段转写（首发仅接口位，MiMo 在 POL-21 实现）。
 */
export interface AsrAdapter {
  /** supplier id（= admin 供应商配置键）：'volcengine' | 'mimo' | 'mock'。 */
  readonly id: string
  readonly mode: AsrMode
  readonly capabilities: AsrCapabilities
  /** 内置速率卡声明；admin/env 配置存在时被覆盖（admin 是事实源）。 */
  readonly rateCard: AsrRateCard
  /** 是否具备真实上游连通条件（如火山 env 凭据齐全）；false → 握手报 supplier_unavailable。 */
  isConfigured(): boolean
  startStream(ctx: AsrStreamContext): AsrStreamHandle
  transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult>
}

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

export const AsrClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('audio'), data: z.string().min(1) }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('cancel') }),
])

export type AsrClientFrame = z.infer<typeof AsrClientFrameSchema>

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
  | 'session_timeout'

/** 握手帧（能力描述）：App 按能力位自适应渲染、不内置供应商分支。 */
export type AsrServerFrame =
  | {
      type: 'asr_ready'
      supplier: string
      mode: AsrMode
      realtimeStreaming: boolean
      maxDurationSec: number
      languages: string[]
      rateCard: AsrRateCard
      preholdSeconds: number
      preholdCredits: number
      preholdId: string
    }
  | { type: 'asr_partial'; text: string; seq: number }
  | { type: 'asr_final'; text: string; seconds: number }
  | { type: 'asr_error'; code: AsrErrorFrameCode; message: string }

/** /asr 专用 close code（4401 与信封路由语义对齐；4402/4403 为本卡计费语义）。 */
export const ASR_CLOSE_CODE = {
  UNAUTHORIZED: 4401,
  /** prehold 409 voice_insufficient_balance → 余额不足，App 禁按依据。 */
  INSUFFICIENT_BALANCE: 4402,
  /** prehold/quote 422 voice_not_quotable → 供应商未定价，不可报价。 */
  NOT_QUOTABLE: 4403,
  /** 请求了未注册的 supplier。 */
  SUPPLIER_UNKNOWN: 4404,
  /** 供应商存在但缺少上游凭据（如火山 env 未注入）。 */
  SUPPLIER_UNAVAILABLE: 4405,
  /** admin 计费接口不可达（fail closed）。 */
  BILLING_UNAVAILABLE: 4500,
  /** 供应商上游流式会话失败。 */
  UPSTREAM_ERROR: 4501,
  /** 会话墙钟超限（330s，早于 admin PENDING TTL 360s）：按实测秒结算后收口。 */
  SESSION_TIMEOUT: 4502,
  /** 每连接限流（与信封路由 4008 同码）。 */
  RATE_LIMITED: 4008,
} as const

export function serializeAsrFrame(frame: AsrServerFrame): string {
  return JSON.stringify(frame)
}
