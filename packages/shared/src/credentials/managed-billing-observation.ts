import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { BillingRuntimeUsageInput } from '../admin/billing-runtime-contract'
import { parseProviderObservation, type ProviderCorrelationV1 } from '../admin/provider-observation'

export interface ManagedBillingFacts {
  model: string
  hostRequestId: string
  transportBaseUrl: string
  credentialFingerprint: string
}
export type ManagedBillingResult = Omit<BillingRuntimeUsageInput, 'productSpaceId' | 'runId' | 'requestId'>
export interface ManagedBillingLease {
  providerCorrelation: ProviderCorrelationV1
  assertCurrent(): void
  complete(result: ManagedBillingResult): Promise<void>
}
/** Trusted Host callbacks only; never serialized to the model subprocess. */
export interface ManagedBillingHooks {
  beforeSend(facts: ManagedBillingFacts): Promise<ManagedBillingLease>
}

export async function readManagedRequest(request: IncomingMessage, upstream: URL): Promise<{ body: Buffer; model: string }> {
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
  return { model: body.model, body: Buffer.from(JSON.stringify(body)) }
}

/** Bounded in-memory wire observer. Prompts/output are never journaled. */
export class ManagedBillingObservation {
  private pending = ''
  private decoder = new TextDecoder()
  private usage?: Pick<ManagedBillingResult, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'provenance'>
  private model?: string
  private usable = false
  private invalid = false
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
    if (!text || text === '[DONE]') return
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
      this.usage = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, provenance: 'provider_final' }
    } catch { /* Invalid wire data cannot become provider-final usage. */ }
  }
  result(ended: boolean): ManagedBillingResult {
    return { inputTokens: 0, outputTokens: 0, ...this.usage,
      ...(this.model ? { actualModel: this.model } : {}), providerObservation: this.providerObservation,
      outputDisposition: this.usable ? 'usable' : ended && !this.invalid ? 'no_output' : 'unknown',
      terminalReason: ended ? 'transport_complete' : 'transport_interrupted' }
  }
}
export const newManagedHostRequestId = () => `host-${randomUUID()}`
