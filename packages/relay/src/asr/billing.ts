/**
 * Voice billing HTTP client (POL-20 计费埋点) against polo-admin
 * main@c3257421, verified field-by-field against
 * src/app/api/billing/voice/{quote,prehold,settle}/route.ts +
 * src/lib/voice-billing/service.ts + src/lib/validation.ts:
 * - POST /api/billing/voice/quote   {supplier, seconds} → VoiceQuote view
 * - POST /api/billing/voice/prehold {preholdId, supplier, seconds?} → VoiceBillingTxn view
 * - POST /api/billing/voice/settle  {preholdId, action:"settle", actualSeconds}
 *                                   | {preholdId, action:"refund"}
 * - all endpoints: Authorization: Bearer <user JWT>（授权主体 = JWT sub）
 * - errors: {error, message, requestId, details?}; 错误码
 *   voice_insufficient_balance(409) / voice_not_quotable(422)
 * - settle/refund 幂等（admin 按 preholdId 去重，relay 重试安全）
 */

export interface VoiceQuoteView {
  supplier: string
  seconds: number
  credits: number | null
  quoted: boolean
  pricePerHourCny: number | null
  markupPermille: number
}

export interface VoiceBillingTxnView {
  preholdId: string
  userId: string
  supplier: string
  status: 'PENDING' | 'SETTLED' | 'REFUNDED' | 'EXPIRED'
  preholdSeconds: number
  preholdCredits: number
  settleSeconds: number | null
  settleCredits: number | null
  balanceAfter: number
  idempotentReplay: boolean
}

export type VoiceBillingResult<T> =
  | { ok: true; data: T }
  | { ok: false; /** false = admin 网络不可达（fail closed → billing_unavailable）。 */ reachable: boolean; httpStatus: number; errorCode?: string; message?: string }

export interface VoiceBillingClientOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
}

export class VoiceBillingClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: VoiceBillingClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async quote(token: string, supplier: string, seconds: number): Promise<VoiceBillingResult<VoiceQuoteView>> {
    return this.call(token, '/api/billing/voice/quote', { supplier, seconds })
  }

  async prehold(
    token: string,
    input: { preholdId: string; supplier: string; seconds?: number },
  ): Promise<VoiceBillingResult<VoiceBillingTxnView>> {
    return this.call(token, '/api/billing/voice/prehold', {
      preholdId: input.preholdId,
      supplier: input.supplier,
      ...(input.seconds !== undefined ? { seconds: input.seconds } : {}),
    })
  }

  async settle(
    token: string,
    input: { preholdId: string; action: 'settle' | 'refund'; actualSeconds?: number },
  ): Promise<VoiceBillingResult<VoiceBillingTxnView>> {
    return this.call(token, '/api/billing/voice/settle', {
      preholdId: input.preholdId,
      action: input.action,
      ...(input.action === 'settle' ? { actualSeconds: input.actualSeconds ?? 0 } : {}),
    })
  }

  private async call<T>(token: string, path: string, body: Record<string, unknown>): Promise<VoiceBillingResult<T>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      return { ok: false, reachable: false, httpStatus: 0 }
    }
    const parsed = await safeJson(response)
    if (response.status < 200 || response.status >= 300) {
      const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
      return {
        ok: false,
        reachable: true,
        httpStatus: response.status,
        errorCode: typeof record['error'] === 'string' ? record['error'] : undefined,
        message: typeof record['message'] === 'string' ? record['message'] : undefined,
      }
    }
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, reachable: true, httpStatus: response.status, errorCode: 'malformed_response' }
    }
    return { ok: true, data: parsed as T }
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}
