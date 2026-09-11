import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
export const HOST_PARENT_MARKER = 'sessionless-host-llm-executor.v1'
export const ID_LIMIT = 8192
export const TEXT_LIMIT = 524_288
const PROMPT_LIMIT = 1_048_576
const SYSTEM_LIMIT = 524_288
const CRED_LIMIT = 65_536
const REASON_LIMIT = 1024
const RESULT_LIMIT = 4_194_304
export type HostFailureKind = 'invalid_worker_message' | 'result_too_large' | 'catalog_model_missing' | 'deadline_exceeded' | 'retry_blocked'
  | 'provider_rejected_credentials' | 'provider_request_failed' | 'provider_error_terminal' | 'provider_aborted' | 'unexpected_terminal' | 'empty_text' | 'provider_usage_invalid' | 'json_object_required'
export const HOST_ERRORS: Readonly<Record<HostFailureKind, readonly [string, string, string, string]>> = {
  invalid_worker_message: ['failed', 'provider_protocol_error', 'invalid_worker_message', 'Host LLM worker protocol failed'],
  result_too_large: ['failed', 'provider_protocol_error', 'result_too_large', 'Host LLM worker result exceeds the wire limit'],
  catalog_model_missing: ['failed', 'provider_protocol_error', 'catalog_model_missing', 'Model is not available in the sealed provider catalog'],
  deadline_exceeded: ['timed_out', 'timed_out', 'deadline_exceeded', 'Host LLM request timed out'],
  retry_blocked: ['failed', 'provider_failed', 'retry_blocked', 'LLM provider attempted an unsupported retry'],
  provider_rejected_credentials: ['failed', 'auth_failed', 'provider_rejected_credentials', 'LLM provider rejected the connection credential'],
  provider_request_failed: ['failed', 'provider_failed', 'provider_request_failed', 'LLM provider request failed'],
  provider_error_terminal: ['failed', 'provider_failed', 'provider_error_terminal', 'LLM provider request failed'],
  provider_aborted: ['failed', 'provider_failed', 'provider_aborted', 'LLM provider request failed'],
  unexpected_terminal: ['failed', 'provider_protocol_error', 'unexpected_terminal', 'LLM provider returned an unsupported terminal event'],
  empty_text: ['no_output', 'no_output', 'empty_text', 'LLM provider returned no output'],
  provider_usage_invalid: ['failed', 'invalid_usage', 'provider_usage_invalid', 'LLM provider returned invalid usage'],
  json_object_required: ['failed', 'invalid_structured_output', 'json_object_required', 'LLM provider returned invalid structured output'],
}
export type HostWorkerCredential = { type: 'api_key'; value: string } | { type: 'oauth_access'; value: string }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string } | { type: 'none' }
export interface ValidatedHostRequest {
  requestId: string; model: string; prompt: string; systemPrompt: string; responseFormat: 'text' | 'json_object'
  maxOutputTokens: number; timeoutMs: number; routeKind: 'catalog' | 'custom'; provider: string; api: 'openai-completions' | 'anthropic-messages'
  transportHref: string; credential: HostWorkerCredential
}
export interface HostResultUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number
  reportedModel: string; terminalReason: 'stop' | 'length'; provenance: 'provider_final'
}
export interface HostCompletionResultV1 {
  type: 'host_completion_result'; version: 1; requestId: string; model: string; text?: string; usage?: HostResultUsage
  status: 'completed' | 'partial' | 'no_output' | 'timed_out' | 'failed'
  error?: { code: string; reason: string; message: string }
}
const credentialSchema = Type.Union([
  Type.Object({ type: Type.Literal('api_key'), value: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('oauth_access'), value: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('iam'), accessKeyId: Type.String(), secretAccessKey: Type.String(), sessionToken: Type.Optional(Type.String()), region: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('none') }, { additionalProperties: false }),
])
const routeSchema = Type.Union([
  Type.Object({ kind: Type.Literal('catalog'), provider: Type.String(), transportBaseUrl: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('custom'), provider: Type.Union([Type.Literal('openai'), Type.Literal('anthropic')]), api: Type.Union([Type.Literal('openai-completions'), Type.Literal('anthropic-messages')]), baseUrl: Type.String() }, { additionalProperties: false }),
])
const requestSchema = Type.Object({
  type: Type.Literal('host_completion'), version: Type.Literal(1), parentValidation: Type.Literal(HOST_PARENT_MARKER),
  requestId: Type.String(), route: routeSchema, model: Type.String(), prompt: Type.String(), systemPrompt: Type.Optional(Type.String()),
  responseFormat: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('json_object')])),
  maxOutputTokens: Type.Integer({ minimum: 1, maximum: 65_536 }), timeoutMs: Type.Integer({ minimum: 100, maximum: 600_000 }), credential: credentialSchema,
}, { additionalProperties: false })
function byteOver(value: string, limit: number): boolean { return Buffer.byteLength(value, 'utf8') > limit }
export function canonicalTransportHref(value: string): string | null {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === '' && parsed.href === value ? parsed.href : null } catch { return null }
}
export function validateHostRequest(raw: unknown): ValidatedHostRequest | null {
  if (!Value.Check(requestSchema, raw)) return null
  const r = raw as { requestId: string; model: string; prompt: string; systemPrompt?: string; responseFormat?: 'text' | 'json_object'; maxOutputTokens: number; timeoutMs: number; route: { kind: 'catalog'; provider: string; transportBaseUrl: string } | { kind: 'custom'; provider: 'openai' | 'anthropic'; api: 'openai-completions' | 'anthropic-messages'; baseUrl: string }; credential: HostWorkerCredential }
  if (r.requestId.length === 0 || r.model.length === 0 || byteOver(r.requestId, ID_LIMIT) || byteOver(r.model, ID_LIMIT)) return null
  if (byteOver(r.prompt, PROMPT_LIMIT) || (r.systemPrompt !== undefined && byteOver(r.systemPrompt, SYSTEM_LIMIT))) return null
  const credential = r.credential
  const credStrings = credential.type === 'none' ? [] : credential.type === 'iam' ? [credential.accessKeyId, credential.secretAccessKey, credential.region, ...(credential.sessionToken !== undefined ? [credential.sessionToken] : [])] : [credential.value]
  if (credStrings.some((s) => s.length === 0 || byteOver(s, CRED_LIMIT))) return null
  const common = { requestId: r.requestId, model: r.model, prompt: r.prompt, systemPrompt: r.systemPrompt ?? '', responseFormat: r.responseFormat ?? 'text' as const, maxOutputTokens: r.maxOutputTokens, timeoutMs: r.timeoutMs, credential }
  if (r.route.kind === 'catalog') {
    const href = canonicalTransportHref(r.route.transportBaseUrl)
    if (r.route.provider.length === 0 || byteOver(r.route.provider, ID_LIMIT) || !href) return null
    return { ...common, routeKind: 'catalog' as const, provider: r.route.provider, api: 'openai-completions' as const, transportHref: href }
  }
  if ((r.route.provider === 'openai') !== (r.route.api === 'openai-completions')) return null
  let href: string | null = null
  try {
    const parsed = new URL(r.route.baseUrl)
    href = parsed.protocol !== 'https:' && parsed.protocol !== 'http:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' ? null : parsed.href
  } catch { href = null }
  return href ? { ...common, routeKind: 'custom' as const, provider: r.route.provider, api: r.route.api, transportHref: href } : null
}
export function failureResult(requestId: string, model: string, kind: HostFailureKind, usage?: HostResultUsage): HostCompletionResultV1 {
  const [status, code, reason, message] = HOST_ERRORS[kind]
  return { type: 'host_completion_result', version: 1, requestId, status: status as HostCompletionResultV1['status'], model, ...(usage ? { usage } : {}), error: { code, reason, message } }
}
export const RESULT_TOO_LARGE_LINE = JSON.stringify(failureResult('invalid', 'invalid', 'result_too_large')) + '\n'
export const INVALID_RESULT_LINE = JSON.stringify(failureResult('invalid', 'invalid', 'invalid_worker_message')) + '\n'
export function serializeHostResult(result: HostCompletionResultV1): string {
  if (byteOver(result.requestId, ID_LIMIT) || byteOver(result.model, ID_LIMIT) || byteOver(result.usage?.reportedModel ?? '', ID_LIMIT) || byteOver(result.text ?? '', TEXT_LIMIT) || byteOver(result.error?.reason ?? '', REASON_LIMIT) || byteOver(result.error?.message ?? '', REASON_LIMIT)) return RESULT_TOO_LARGE_LINE
  const line = JSON.stringify(result) + '\n'
  return byteOver(line, RESULT_LIMIT) ? RESULT_TOO_LARGE_LINE : line
}
export function writeHostResultLine(line: string): Promise<boolean> {
  return new Promise((resolve) => { process.stdout.write(line, (error?: Error | null) => resolve(!error)) })
}
