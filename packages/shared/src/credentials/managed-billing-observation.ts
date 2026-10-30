import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { BillingRuntimeUsageInput } from '../admin/billing-runtime-contract'
import { parseProviderObservation, type ProviderCorrelationV1 } from '../admin/provider-observation'

export interface ManagedBillingFacts {
  model: string
  hostRequestId: string
  transportBaseUrl: string
  credentialFingerprint: string
  requestBounds?: { maxInputTokens: number; maxOutputTokens: number; bodySha256: string }
}
export type ManagedBillingResult = Omit<BillingRuntimeUsageInput, 'productSpaceId' | 'runId' | 'requestId'>
export interface ManagedBillingLease {
  providerCorrelation: ProviderCorrelationV1
  assertCurrent(): void
  complete(result: ManagedBillingResult): Promise<void>
}
/** Trusted Host callbacks only; never serialized to the model subprocess. */
export interface ManagedBillingContext { signal?: AbortSignal }
export interface ManagedBillingHooks {
  beforeSend(facts: ManagedBillingFacts, context?: ManagedBillingContext): Promise<ManagedBillingLease>
}

export async function readManagedRequest(request: IncomingMessage, upstream: URL): Promise<{ body: Buffer; model: string; requestBounds: NonNullable<ManagedBillingFacts['requestBounds']> }> {
  if (request.method !== 'POST' || !upstream.pathname.endsWith('/chat/completions') || upstream.search) {
    throw new Error('Managed billing requires OpenAI chat completions')
  }
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 32 * 1024 * 1024) throw new Error('Managed request exceeds bounded input')
    chunks.push(buffer)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body.model !== 'string' || !body.model || body.model.length > 128) throw new Error('Managed model is required')
  if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true }
  // Hosted text requests carry a finite output limit on the actual wire.
  // Remote media cannot be bounded by its URL bytes: refuse before admission.
  const hasMedia = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(hasMedia)
    const row = value as Record<string, unknown>
    return ['image_url', 'input_audio', 'audio', 'video', 'file', 'input_image', 'input_file'].includes(String(row.type))
      || ['image_url', 'input_audio', 'audio', 'video_url', 'file_data', 'file_id'].some(key => row[key] !== undefined)
      || Object.values(row).some(hasMedia)
  }
  if (hasMedia(body.messages) || body.modalities?.some((value: unknown) => value !== 'text')) throw new Error('Managed reservation requires bounded text input')
  const limits = ['max_tokens', 'max_completion_tokens'].filter(key => body[key] !== undefined)
  if (limits.length > 1) throw new Error('Managed output limit is ambiguous')
  if (!limits.length) body.max_tokens = 8192
  const output = body[limits[0] ?? 'max_tokens'], count = body.n ?? 1
  if (!Number.isSafeInteger(output) || output <= 0 || !Number.isSafeInteger(count) || count < 1 || output * count > 1073741823) throw new Error('Managed output limit is invalid')
  const wire = Buffer.from(JSON.stringify(body))
  // UTF-8 bytes plus structural overhead deliberately overestimate ordinary
  // text tokenization. Any supplier discrepancy is still capped at settlement.
  const maxInputTokens = wire.length + 256 + (Array.isArray(body.messages) ? body.messages.length * 64 : 0)
  const requestBounds = { maxInputTokens, maxOutputTokens: output * count, bodySha256: createHash('sha256').update(wire).digest('hex') }
  return { model: body.model, body: wire, requestBounds }
}

/** Bounded in-memory wire observer. Prompts/output are never journaled. */
export class ManagedBillingObservation {
  private pending = ''
  private decoder = new TextDecoder()
  private usage?: Pick<ManagedBillingResult, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>
  private model?: string
  private usable = false
  private invalid = false
  private providerEnded = false
  private readonly streaming: boolean
  readonly providerObservation: ManagedBillingResult['providerObservation']
  constructor(upstream: IncomingMessage, private readonly requestModel?: string) {
    // The billing identity is the model on the actual admitted HTTP request.
    // A provider's dated/version label is separate metadata, never an alias
    // remapping decision or a replacement for the verified NewAPI log model.
    this.model = requestModel
    this.streaming = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
    const candidates = ['x-oneapi-request-id'].flatMap(name => {
      const raw = upstream.headers[name]; return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    })
    const ids = [...new Set(candidates)]
    this.providerObservation = parseProviderObservation({ version: 1, responseStatus: upstream.statusCode || 502,
      state: ids.length === 1 ? 'observed' : ids.length ? 'ambiguous' : 'missing',
      ...(ids.length === 1 ? { providerRequestId: ids[0] } : {}),
    }) ?? { version: 1, state: 'ambiguous', responseStatus: upstream.statusCode || 502 }
  }
  push(chunk: Buffer, final = false): void {
    if (this.invalid) return
    this.pending += this.decoder.decode(chunk, { stream: !final })
    if (this.streaming) {
      let end: number
      while ((end = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, end).trim(); this.pending = this.pending.slice(end + 1)
        if (line.startsWith('data:')) this.consume(line.slice(5).trim())
      }
      if (final && this.pending.trim().startsWith('data:')) this.consume(this.pending.trim().slice(5).trim())
    } else if (final) this.consume(this.pending)
    if (this.pending.length > 1024 * 1024) { this.invalid = true; this.pending = ''; this.usage = undefined }
  }
  private consume(text: string): void {
    if (text === '[DONE]') { this.providerEnded = true; return }
    if (!text) return
    try {
      const row = JSON.parse(text)
      if (!this.requestModel && typeof row.model === 'string' && row.model.length <= 128) this.model = row.model
      for (const choice of Array.isArray(row.choices) ? row.choices : []) {
        const message = choice.delta ?? choice.message
        if (message && (typeof message.content === 'string' && message.content.length > 0 || typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0 || Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) this.usable = true
      }
      if (!row.usage) return
      const usage = row.usage
      const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
      const cacheWrite = usage.cache_creation_input_tokens ?? 0
      const input = usage.prompt_tokens - cacheRead - cacheWrite, output = usage.completion_tokens
      if (![input, output, cacheRead, cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0)) return
      this.usage = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
    } catch { /* Invalid wire data cannot become provider-final usage. */ }
  }
  result(ended: boolean): ManagedBillingResult {
    return { inputTokens: 0, outputTokens: 0, ...this.usage,
      ...(this.usage && !this.invalid && (this.streaming ? this.providerEnded : ended) ? { provenance: 'provider_final' as const } : {}),
      ...(this.model ? { actualModel: this.model } : {}), providerObservation: this.providerObservation,
      outputDisposition: this.usable ? 'usable' : ended && !this.invalid ? 'no_output' : 'unknown',
      terminalReason: ended ? 'transport_complete' : 'transport_interrupted' }
  }
}
export const newManagedHostRequestId = () => `host-${randomUUID()}`
