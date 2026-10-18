/**
 * /asr WebSocket streaming pipeline (POL-20, PRD v1.6 §⑦).
 *
 * 手机 → wss relay /asr → 供应商流式 ASR（决策一：计费权威 + API key 不落客户端
 * + admin 保持纯 HTTP）。单连接时序：
 *
 *   upgrade  复用信封路由同款双层鉴权（本地 HS256 + admin introspection）；
 *            无效 token → HTTP 401，不升级。
 *   open     能力解析（admin 配置 60s 缓存，本卡先 env/本地源）→ 未知供应商
 *            4404 / 未配置凭据 4405 → quote（不可报价 422 → 4403）→ prehold(60s)
 *            （余额不足 409 → 4402；admin 不可达 fail-closed → 4500）→ 下发
 *            asr_ready（supplier+capabilities+rateCard 握手帧，App 仅展示）。
 *   stream   客户端 audio 分片（base64 text 帧或裸 binary 帧）→ adapter.pushAudio
 *            （服务端实测计量）→ partial 按序回推 asr_partial。
 *   close    settle(实测秒)（多退少补）/ 无音频或失败 refund 全退；preholdId
 *            幂等，admin PENDING TTL 过期兜底防 relay 崩溃丢账。
 *   wall     prehold 生效起 330s 墙钟守卫（< admin TTL 360s）：慢滴/挂死/死连接
 *            按实测秒强制 settle 收口（4502 session_timeout），不给全退白嫖留窗口。
 *
 * 错误帧统一 {type:'asr_error',code,message}；close code 见 ASR_CLOSE_CODE。
 * 沿用每连接限流（超限 4008，结算仍由 close 路径执行）。
 */

import { randomUUID } from 'node:crypto'

import type { RelayAuth } from '../auth.ts'
import { HeartbeatFrameSchema } from '../envelope.ts'
import { SlidingWindowLimiter } from '../ratelimit.ts'
import type { RelayLogger } from '../server.ts'
import { AsrAdapterRegistry } from './adapter.ts'
import { VoiceBillingClient, type VoiceBillingResult } from './billing.ts'
import { AsrCapabilityService, supplierConfigFromEnv } from './capabilities.ts'
import { MockAsrAdapter } from './mock-adapter.ts'
import {
  ASR_CLOSE_CODE,
  ASR_PREHOLD_SECONDS,
  ASR_SESSION_WALL_GUARD_SECONDS,
  AsrClientFrameSchema,
  serializeAsrFrame,
  type AsrAdapter,
  type AsrErrorFrameCode,
  type AsrServerFrame,
  type AsrStreamHandle,
} from './types.ts'
import { volcanoAsrOptionsFromEnv, VolcanoStreamAsrAdapter } from './volcano-adapter.ts'

/** Per-connection /asr state; attached at WsData.asr (envelope connections never set it). */
export interface AsrConnectionState {
  token: string
  userId: string
  requestedSupplier?: string
  /** 能力解析后的 supplier id（= state.requestedSupplier ?? config.defaultSupplier）。 */
  supplierId?: string
  preholdId: string
  /** quote+prehold 通过、asr_ready 已发。 */
  ready: boolean
  /** prehold 已生效（有账可结，即使 ready 未到也要 refund）。 */
  held: boolean
  /** 客户端已 end/cancel，会话进入收尾。 */
  ending: boolean
  /** 计费已终态（或 prehold 未生效无需计费）——本连接只 settle/refund 一次。 */
  settled: boolean
  closed: boolean
  handle?: AsrStreamHandle
  /** 墙钟守卫定时器（prehold 生效时挂上；settle 终态时摘除）。 */
  wallTimer?: ReturnType<typeof setTimeout>
  finalText: string
  resolveFinal?: (text: string) => void
}

export interface AsrServiceOptions {
  auth: RelayAuth
  registry: AsrAdapterRegistry
  capabilities: AsrCapabilityService
  billing: VoiceBillingClient
  logger?: RelayLogger
  now?: () => number
  /** 预扣秒数（PRD §⑦ 固定 60）。 */
  preholdSeconds?: number
  /** 每连接限流 msg/s（与信封路由同款滑动窗口）。 */
  maxMsgPerSec?: number
  /** end 后等待 final 的时长（测试缩短常数）。 */
  finalWaitMs?: number
  /**
   * 单连接墙钟上限（自 prehold 起算）。admin PENDING TTL = 60+300 = 360s，settle
   * 迟到会被 EXPIRED 全退 —— 慢滴/挂死/死连接路径必须由本守卫按实测秒强制收口。
   */
  maxSessionWallMs?: number
}

/** Minimal structural view of ServerWebSocket<WsData> (avoids circular import). */
export interface AsrWsLike {
  send(data: string): unknown
  close(code?: number, reason?: string): unknown
  terminate(): unknown
  data: { limiter: SlidingWindowLimiter; asr: AsrConnectionState }
}

export class AsrService {
  private readonly log: RelayLogger
  private readonly now: () => number
  private readonly preholdSeconds: number
  private readonly maxMsgPerSec: number
  private readonly finalWaitMs: number
  private readonly maxSessionWallMs: number

  constructor(private readonly options: AsrServiceOptions) {
    this.log = options.logger ?? ((line) => console.log(`[relay:asr] ${line}`))
    this.now = options.now ?? Date.now
    this.preholdSeconds = options.preholdSeconds ?? ASR_PREHOLD_SECONDS
    this.maxMsgPerSec = options.maxMsgPerSec ?? 20
    this.finalWaitMs = options.finalWaitMs ?? 5_000
    this.maxSessionWallMs = options.maxSessionWallMs ?? ASR_SESSION_WALL_GUARD_SECONDS * 1_000
  }

  get registry(): AsrAdapterRegistry {
    return this.options.registry
  }

  // --- Upgrade ---------------------------------------------------------------

  /**
   * Handles GET /asr upgrade: same dual-layer auth as the envelope route. The
   * `data` literal matches the concrete WsData in server.ts (structurally typed
   * as unknown here to avoid a circular import; covered by tests).
   */
  async handleUpgrade(
    req: Request,
    upgrade: { upgrade(req: Request, options: { data: unknown }): boolean },
    connId: number,
  ): Promise<Response | undefined> {
    const url = new URL(req.url)
    const headerToken = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const token = headerToken || (url.searchParams.get('token') ?? '')
    if (!token) {
      return jsonResponse(401, 'unauthorized', '/asr handshake requires a token')
    }
    const authenticated = await this.options.auth.authenticate(token)
    if (!authenticated.ok) {
      this.log(`asr handshake_rejected reason=unauthorized connId=${connId}`)
      return jsonResponse(401, 'unauthorized', 'invalid token')
    }
    const sideParam = url.searchParams.get('side')
    const side: 'phone' | 'mac' = sideParam === 'mac' ? 'mac' : 'phone'
    const deviceId = url.searchParams.get('deviceId')?.trim() || `asr-${connId}`
    const supplier = url.searchParams.get('supplier')?.trim() || undefined

    const state: AsrConnectionState = {
      token,
      userId: authenticated.userId,
      requestedSupplier: supplier,
      preholdId: randomUUID(),
      ready: false,
      held: false,
      ending: false,
      settled: false,
      closed: false,
      finalText: '',
    }

    const upgraded = upgrade.upgrade(req, {
      data: {
        connId,
        identity: { side, userId: state.userId, deviceId, persona: `asr:${connId}`, token },
        lastPongAt: this.now(),
        lastAuthAt: this.now(),
        limiter: new SlidingWindowLimiter(this.maxMsgPerSec, 1_000, this.now),
        recentPeers: new Set<string>(),
        asr: state,
      },
    })
    if (!upgraded) {
      return jsonResponse(400, 'upgrade_failed', 'websocket upgrade failed')
    }
    return undefined
  }

  // --- Lifecycle ----------------------------------------------------------------

  handleOpen(ws: AsrWsLike): void {
    void this.beginSession(ws)
  }

  private async beginSession(ws: AsrWsLike): Promise<void> {
    const state = ws.data.asr
    try {
      const config = await this.options.capabilities.current()
      if (state.closed) return

      const supplierId = state.requestedSupplier ?? config.defaultSupplier
      const adapter = this.options.registry.get(supplierId)
      if (!adapter) {
        this.failBeforeReady(ws, 'supplier_unknown', ASR_CLOSE_CODE.SUPPLIER_UNKNOWN, `unknown supplier: ${supplierId}`)
        return
      }
      // 速率卡：admin/env 配置是事实源，adapter 内置声明仅兜底。
      const rateCard = config.suppliers[supplierId]?.rateCard ?? adapter.rateCard

      if (!adapter.isConfigured()) {
        this.failBeforeReady(ws, 'supplier_unavailable', ASR_CLOSE_CODE.SUPPLIER_UNAVAILABLE, `supplier ${supplierId} is missing upstream credentials`)
        return
      }

      // 计费埋点：连接建立 → quote（可报价性闸门）→ prehold(预扣 60s)。
      const quoted = await this.options.billing.quote(state.token, supplierId, this.preholdSeconds)
      if (state.closed) return // quote 只读，断连无账可结
      if (!this.okOrFailBeforeReady(ws, quoted)) return

      const held = await this.options.billing.prehold(state.token, {
        preholdId: state.preholdId,
        supplier: supplierId,
        seconds: this.preholdSeconds,
      })
      if (state.closed) {
        // prehold 已生效但连接已断：按 0 秒全退。
        if (held.ok) {
          state.held = true
          void this.settle(state, 'refund')
        }
        return
      }
      if (!held.ok) {
        this.okOrFailBeforeReady(ws, held)
        return
      }

      state.held = true
      state.supplierId = supplierId
      state.ready = true
      this.armSessionWallGuard(ws)
      this.sendFrame(ws, {
        type: 'asr_ready',
        supplier: supplierId,
        mode: adapter.mode,
        realtimeStreaming: adapter.capabilities.realtimeStreaming,
        maxDurationSec: adapter.capabilities.maxDurationSec,
        languages: adapter.capabilities.languages,
        rateCard,
        preholdSeconds: this.preholdSeconds,
        preholdCredits: held.data.preholdCredits,
        preholdId: state.preholdId,
      })
      this.log(`asr ready supplier=${supplierId} preholdId=${state.preholdId} credits=${held.data.preholdCredits}`)
    } catch (error) {
      if (!state.closed && !state.settled) {
        this.failBeforeReady(ws, 'billing_unavailable', ASR_CLOSE_CODE.BILLING_UNAVAILABLE, `asr handshake failed: ${describe(error)}`)
      }
    }
  }

  /** Maps a failed billing call onto the pre-ready failure path (frame + close code). */
  private okOrFailBeforeReady(ws: AsrWsLike, result: VoiceBillingResult<unknown>): boolean {
    if (result.ok) return true
    if (!result.reachable) {
      this.failBeforeReady(ws, 'billing_unavailable', ASR_CLOSE_CODE.BILLING_UNAVAILABLE, 'billing service unreachable')
      return false
    }
    if (result.errorCode === 'voice_insufficient_balance' || result.httpStatus === 409) {
      this.failBeforeReady(ws, 'insufficient_balance', ASR_CLOSE_CODE.INSUFFICIENT_BALANCE, result.message ?? 'insufficient voice credits')
      return false
    }
    if (result.errorCode === 'voice_not_quotable' || result.httpStatus === 422) {
      this.failBeforeReady(ws, 'not_quotable', ASR_CLOSE_CODE.NOT_QUOTABLE, result.message ?? 'supplier is not quotable')
      return false
    }
    if (result.httpStatus === 401 || result.httpStatus === 403) {
      this.failBeforeReady(ws, 'unauthorized', ASR_CLOSE_CODE.UNAUTHORIZED, 'token rejected by billing')
      return false
    }
    this.failBeforeReady(ws, 'billing_unavailable', ASR_CLOSE_CODE.BILLING_UNAVAILABLE, `billing error ${result.httpStatus}`)
    return false
  }

  private failBeforeReady(ws: AsrWsLike, code: AsrErrorFrameCode, closeCode: number, message: string): void {
    const state = ws.data.asr
    if (state.closed || state.settled) return
    state.settled = true // prehold 未生效：无账可结，防后续分支重复处理
    this.log(`asr handshake_failed code=${code}`)
    this.sendFrame(ws, { type: 'asr_error', code, message })
    this.close(ws, closeCode, code)
  }

  handleMessage(ws: AsrWsLike, raw: string | Uint8Array): void {
    const state = ws.data.asr
    if (state.closed || state.settled) return

    // 能力协商/计费预扣尚未完成：心跳照常回应，其余先过每连接限流再拒收
    // （与信封路径一致：心跳不限流、其它帧一律计数，防预就绪期错误帧放大）。
    if (!state.ready) {
      if (typeof raw === 'string') {
        const heartbeat = tryParse(raw)
        if (heartbeat && HeartbeatFrameSchema.safeParse(heartbeat).success) {
          if ((heartbeat as { type: string }).type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: this.now() }))
          return
        }
      }
      if (!checkRate(ws, this.log)) return
      this.sendFrame(ws, { type: 'asr_error', code: 'not_ready', message: 'session negotiation in progress; frame dropped' })
      return
    }

    // Binary frame == one audio chunk (saves the base64 hop).
    if (typeof raw !== 'string') {
      if (!checkRate(ws, this.log)) return
      this.forwardAudio(ws, new Uint8Array(raw))
      return
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      if (!checkRate(ws, this.log)) return
      this.sendFrame(ws, { type: 'asr_error', code: 'invalid_frame', message: 'frames must be JSON audio|end|cancel' })
      return
    }
    if (HeartbeatFrameSchema.safeParse(parsedJson).success) {
      if ((parsedJson as { type: string }).type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: this.now() }))
      return
    }

    if (!checkRate(ws, this.log)) return

    const parsed = AsrClientFrameSchema.safeParse(parsedJson)
    if (!parsed.success) {
      this.sendFrame(ws, { type: 'asr_error', code: 'invalid_frame', message: 'unknown frame; expected audio|end|cancel' })
      return
    }
    const frame = parsed.data
    if (frame.type === 'audio') {
      this.forwardAudio(ws, decodeBase64(frame.data))
      return
    }
    if (frame.type === 'cancel') {
      this.cancelSession(ws)
      return
    }
    this.finishSession(ws)
  }

  private forwardAudio(ws: AsrWsLike, bytes: Uint8Array): void {
    if (bytes.length === 0) return
    const state = ws.data.asr
    if (state.ending || state.settled) return
    if (!state.handle) {
      // 上游会话懒启动：prehold 成功后的首个分片才真正连供应商。
      state.handle = this.startUpstream(ws)
    }
    state.handle.pushAudio(bytes)
  }

  private startUpstream(ws: AsrWsLike): AsrStreamHandle {
    const state = ws.data.asr
    const adapter: AsrAdapter | undefined = state.supplierId ? this.options.registry.get(state.supplierId) : undefined
    // beginSession 已保证 adapter 存在且 configured；此处仅防御。
    if (!adapter) {
      this.failBeforeReady(ws, 'supplier_unknown', ASR_CLOSE_CODE.SUPPLIER_UNKNOWN, `unknown supplier: ${state.supplierId ?? '-'}`)
      return inertHandle()
    }
    return adapter.startStream({
      userId: state.userId,
      onPartial: (partial) => {
        this.sendFrame(ws, { type: 'asr_partial', text: partial.text, seq: partial.seq })
      },
      onFinal: (text) => {
        state.finalText = text
        state.resolveFinal?.(text)
      },
      onError: (code, message) => {
        if (code === 'upstream_error') {
          this.upstreamFailed(ws, message)
          return
        }
        this.sendFrame(ws, { type: 'asr_error', code: normalizeNoticeCode(code), message })
      },
    })
  }

  /** 供应商级致命错误：错误帧 + refund 全退（PRD §⑦ 识别失败全退）+ 关闭。 */
  private upstreamFailed(ws: AsrWsLike, message: string): void {
    const state = ws.data.asr
    if (state.closed || state.settled) return
    this.log(`asr upstream_failed preholdId=${state.preholdId}`)
    this.sendFrame(ws, { type: 'asr_error', code: 'upstream_error', message })
    void this.settle(state, 'refund')
    this.close(ws, ASR_CLOSE_CODE.UPSTREAM_ERROR, 'upstream_error')
  }

  private finishSession(ws: AsrWsLike): void {
    const state = ws.data.asr
    if (!state.ready || state.ending || state.settled) return
    state.ending = true
    const handle = state.handle
    if (!handle) {
      // 未推过任何音频：0 秒 → 全退。
      void this.settle(state, 'refund')
      this.close(ws, 1000, 'refunded')
      return
    }
    handle.finish()
    const waitFinal = new Promise<string>((resolve) => {
      state.resolveFinal = resolve
      if (state.finalText) resolve(state.finalText)
    })
    void Promise.race([waitFinal, Bun.sleep(this.finalWaitMs).then(() => state.finalText)]).then((text) => {
      if (state.closed) return
      this.sendFrame(ws, { type: 'asr_final', text, seconds: handle.meterSeconds() })
      void this.settle(state, 'auto')
      this.close(ws, 1000, 'settled')
    })
  }

  private cancelSession(ws: AsrWsLike): void {
    const state = ws.data.asr
    if (!state.ready || state.settled) return
    state.ending = true
    state.handle?.abort()
    void this.settle(state, 'refund') // PRD §⑦ 取消全退不计费
    this.close(ws, 1000, 'cancelled')
  }

  handleClose(ws: AsrWsLike, _code: number | undefined, _reason: string | undefined): void {
    const state = ws.data.asr
    state.closed = true
    if (state.settled || !state.ready) return
    // 连接中断：按服务端实测秒结算；0 秒（无音频）→ refund 全退。
    void this.settle(state, 'auto')
  }

  // --- Billing --------------------------------------------------------------------

  /**
   * 墙钟守卫：prehold 生效时挂上。触发 = 会话墙钟逼近 admin PENDING TTL（360s），
   * 按服务端实测秒强制 settle 收口 —— 慢滴音频 / 到顶挂死 / 死连接都由此兜住，
   * 不给「EXPIRED 全退白嫖」留窗口；正常会话（实时音频 ≤300s + finalWait 5s）
   * 恒早于 330s，不受影响。
   */
  private armSessionWallGuard(ws: AsrWsLike): void {
    const state = ws.data.asr
    const timer = setTimeout(() => {
      state.wallTimer = undefined
      if (state.closed || state.settled) return
      this.log(`asr session_wall_timeout preholdId=${state.preholdId} seconds=${state.handle?.meterSeconds() ?? 0}`)
      this.sendFrame(ws, { type: 'asr_error', code: 'session_timeout', message: 'session exceeded wall-clock limit; settled by measured seconds' })
      void this.settle(state, 'auto')
      this.close(ws, ASR_CLOSE_CODE.SESSION_TIMEOUT, 'session_timeout')
    }, this.maxSessionWallMs)
    timer.unref?.()
    state.wallTimer = timer
  }

  /** 唯一结算入口；preholdId 幂等保证重放安全。 */
  private async settle(state: AsrConnectionState, mode: 'settle' | 'refund' | 'auto'): Promise<void> {
    if (state.settled) return
    state.settled = true
    if (state.wallTimer) {
      clearTimeout(state.wallTimer)
      state.wallTimer = undefined
    }
    if (!state.held) return
    const seconds = Math.min(state.handle?.meterSeconds() ?? 0, 300)
    const action = mode === 'auto' ? (seconds > 0 ? 'settle' : 'refund') : mode
    const result = await this.options.billing.settle(state.token, {
      preholdId: state.preholdId,
      action,
      ...(action === 'settle' ? { actualSeconds: seconds } : {}),
    })
    if (result.ok) {
      this.log(`asr billed action=${action} seconds=${seconds} preholdId=${state.preholdId} status=${result.data.status} balanceAfter=${result.data.balanceAfter}`)
    } else {
      // 失败仅记日志：admin PENDING TTL 惰性过期全退兜底，不丢账不超扣。
      this.log(`asr settle_failed action=${action} preholdId=${state.preholdId} http=${result.httpStatus} code=${result.errorCode ?? '-'}`)
    }
  }

  // --- Helpers -----------------------------------------------------------------

  private sendFrame(ws: AsrWsLike, frame: AsrServerFrame): void {
    if (ws.data.asr.closed) return
    try {
      ws.send(serializeAsrFrame(frame))
    } catch {
      // socket gone; close handler settles
    }
  }

  private close(ws: AsrWsLike, code: number, reason: string): void {
    const state = ws.data.asr
    if (state.closed) return
    state.closed = true
    try {
      ws.close(code, reason)
    } catch {
      ws.terminate()
    }
  }
}

// --- Default assembly (used by startRelayServer unless injected) -----------------

export interface CreateDefaultAsrServiceOptions {
  auth: RelayAuth
  adminBaseUrl: string
  maxMsgPerSec?: number
  logger?: RelayLogger
  now?: () => number
  env?: Record<string, string | undefined>
}

/** env/本地配置 + 火山/mock 注册表 + admin 计费客户端的默认组装（测试可整体注入覆盖）。 */
export function createDefaultAsrService(options: CreateDefaultAsrServiceOptions): AsrService {
  const env = options.env ?? process.env
  const registry = new AsrAdapterRegistry()
  registry.register(new VolcanoStreamAsrAdapter(volcanoAsrOptionsFromEnv(env)))
  registry.register(new MockAsrAdapter())
  return new AsrService({
    auth: options.auth,
    registry,
    capabilities: new AsrCapabilityService({ load: () => supplierConfigFromEnv(env) }),
    billing: new VoiceBillingClient({ baseUrl: options.adminBaseUrl }),
    logger: options.logger,
    now: options.now,
    maxMsgPerSec: options.maxMsgPerSec,
  })
}

// --- misc ------------------------------------------------------------------------

function checkRate(ws: AsrWsLike, log: RelayLogger): boolean {
  if (ws.data.limiter.check()) return true
  log('asr closed reason=rate_limited')
  ws.close(ASR_CLOSE_CODE.RATE_LIMITED, 'rate_limited')
  ws.data.asr.closed = true
  return false
}

function normalizeNoticeCode(code: string): AsrErrorFrameCode {
  return code === 'max_duration_reached' ? 'max_duration_reached' : 'upstream_error'
}

function inertHandle(): AsrStreamHandle {
  return { pushAudio: () => {}, finish: () => {}, abort: () => {}, meterSeconds: () => 0 }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonResponse(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status })
}
