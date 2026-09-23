import type { BackendHostRuntimeContext } from './backend/types.ts'
export type { BackendHostRuntimeContext }

export const HOST_PARENT_MARKER = 'sessionless-host-llm-executor.v1'
export const ID_LIMIT = 8192, TEXT_LIMIT = 524_288, PROMPT_LIMIT = 1_048_576, SYSTEM_LIMIT = 524_288
export const AGGREGATE_BYTE_LIMIT = 2_097_152, MAX_OUTPUT_TOKENS_MAX = 8192, TIMEOUT_MS_MAX = 120_000

export type HostLlmErrorCode = 'invalid_request' | 'connection_not_found' | 'connection_changed' | 'invalid_connection' | 'model_not_allowed'
  | 'credential_unavailable' | 'auth_failed' | 'provider_failed' | 'provider_protocol_error' | 'invalid_usage' | 'invalid_structured_output'
  | 'no_output' | 'cancelled' | 'timed_out' | 'executor_closed' | 'worker_failed' | 'executor_busy'
export type HostLlmErrorReason = 'missing_slug' | 'unsupported_provider_auth' | 'configuration_drift' | 'default_model_missing' | 'model_not_in_connection'
  | 'catalog_model_missing' | 'credential_missing' | 'credential_expired' | 'invalid_input' | 'wire_request_too_large' | 'provider_rejected_credentials'
  | 'provider_request_failed' | 'provider_error_terminal' | 'provider_aborted' | 'retry_blocked' | 'empty_text' | 'unexpected_terminal'
  | 'provider_usage_invalid' | 'json_object_required' | 'invalid_worker_message' | 'result_too_large' | 'spawn_failed' | 'worker_exited'
  | 'caller_aborted' | 'deadline_exceeded' | 'host_disposed' | 'concurrent_execute'

export interface HostLlmPublicUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; reportedModel: string }
export interface HostLlmPublicError { code: HostLlmErrorCode; reason: HostLlmErrorReason; message: string }
export type HostLlmPublicResult =
  | { status: 'completed' | 'partial'; text: string; usage: HostLlmPublicUsage; requestId: string; model: string; provider: string }
  | { status: 'no_output' | 'timed_out' | 'failed' | 'cancelled'; error: HostLlmPublicError; requestId: string; model: string; usage?: HostLlmPublicUsage }
export interface HostLlmExecuteInput { model?: string; prompt: string; systemPrompt?: string; responseFormat?: 'text' | 'json_object'; maxOutputTokens: number; timeoutMs: number; signal?: AbortSignal }
export interface HostLlmExecutorOptions { connectionSlug: string; model?: string; nodeRuntimePath?: string; serverPath?: string; hostRuntime?: BackendHostRuntimeContext }
export interface SessionlessHostLlmExecutor { execute(input: HostLlmExecuteInput): Promise<HostLlmPublicResult>; dispose(): Promise<void> }

export class HostLlmConfigurationError extends Error {
  readonly code = 'connection_not_found' as const
  constructor(_slug: string) { super('LLM connection not found for the given slug'); this.name = 'HostLlmConfigurationError' }
}

export interface WireUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; reportedModel: string; terminalReason: 'stop' | 'length'; provenance: 'provider_final' }
export interface WireResult { type: 'host_completion_result'; version: 1; requestId: string; model: string; status: 'completed' | 'partial' | 'no_output' | 'timed_out' | 'failed'; text?: string; usage?: WireUsage; error?: { code: string; reason: string; message: string } }

export const WIRE_RESULT_ROWS: Readonly<Record<string, readonly [string, string, string, string]>> = {
  'provider_protocol_error|invalid_worker_message': ['failed', 'provider_protocol_error', 'invalid_worker_message', 'Host LLM worker protocol failed'],
  'provider_protocol_error|result_too_large': ['failed', 'provider_protocol_error', 'result_too_large', 'Host LLM worker result exceeds the wire limit'],
  'provider_protocol_error|catalog_model_missing': ['failed', 'provider_protocol_error', 'catalog_model_missing', 'Model is not available in the sealed provider catalog'],
  'timed_out|deadline_exceeded': ['timed_out', 'timed_out', 'deadline_exceeded', 'Host LLM request timed out'],
  'provider_failed|retry_blocked': ['failed', 'provider_failed', 'retry_blocked', 'LLM provider attempted an unsupported retry'],
  'auth_failed|provider_rejected_credentials': ['failed', 'auth_failed', 'provider_rejected_credentials', 'LLM provider rejected the connection credential'],
  'provider_failed|provider_request_failed': ['failed', 'provider_failed', 'provider_request_failed', 'LLM provider request failed'],
  'provider_failed|provider_error_terminal': ['failed', 'provider_failed', 'provider_error_terminal', 'LLM provider request failed'],
  'provider_failed|provider_aborted': ['failed', 'provider_failed', 'provider_aborted', 'LLM provider request failed'],
  'provider_protocol_error|unexpected_terminal': ['failed', 'provider_protocol_error', 'unexpected_terminal', 'LLM provider returned an unsupported terminal event'],
  'no_output|empty_text': ['no_output', 'no_output', 'empty_text', 'LLM provider returned no output'],
  'invalid_usage|provider_usage_invalid': ['failed', 'invalid_usage', 'provider_usage_invalid', 'LLM provider returned invalid usage'],
  'invalid_structured_output|json_object_required': ['failed', 'invalid_structured_output', 'json_object_required', 'LLM provider returned invalid structured output'],
}
export const PUBLIC_ERROR_MESSAGES: Readonly<Record<string, readonly [string, string]>> = {
  'invalid_request|invalid_input': ['failed', 'Host LLM request is invalid'],
  'invalid_request|wire_request_too_large': ['failed', 'Host LLM wire request exceeds the 2 MiB aggregated limit'],
  'connection_not_found|missing_slug': ['failed', 'LLM connection not found for the given slug'],
  'connection_changed|configuration_drift': ['failed', 'LLM connection configuration changed since the executor was created'],
  'invalid_connection|unsupported_provider_auth': ['failed', 'Connection is not executable by sessionless-host-llm-executor.v1'],
  'model_not_allowed|default_model_missing': ['failed', 'Connection default model is missing or empty'],
  'model_not_allowed|model_not_in_connection': ['failed', 'Requested model is not part of the connection model list'],
  'credential_unavailable|credential_missing': ['failed', 'LLM connection credential is missing'],
  'credential_unavailable|credential_expired': ['failed', 'LLM connection credential has expired'],
  'cancelled|caller_aborted': ['cancelled', 'Host LLM request was aborted by the caller'],
  'executor_closed|host_disposed': ['failed', 'Host LLM executor is closed'],
  'worker_failed|spawn_failed': ['failed', 'Failed to start the Host LLM worker'],
  'worker_failed|worker_exited': ['failed', 'Host LLM worker exited before completing'],
  'executor_busy|concurrent_execute': ['failed', 'Host LLM executor is already executing a request'],
}

const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
export function validateWorkerResult(line: string, sentRequestId: string, sentModel: string): { ok: true; result: WireResult } | { ok: false } {
  let p: unknown
  try { p = JSON.parse(line) } catch { return { ok: false } }
  if (typeof p !== 'object' || p === null) return { ok: false }
  const r = p as Record<string, unknown>
  if (r['type'] !== 'host_completion_result' || r['version'] !== 1) return { ok: false }
  if (r['requestId'] !== sentRequestId || r['model'] !== sentModel) return { ok: false }
  const status = r['status']
  if (status !== 'completed' && status !== 'partial' && status !== 'no_output' && status !== 'timed_out' && status !== 'failed') return { ok: false }
  const allowed = new Set(['type', 'version', 'requestId', 'model', 'status', 'text', 'usage', 'error'])
  for (const k of Object.keys(r)) { if (!allowed.has(k)) return { ok: false } }
  const text = r['text'], usage = r['usage'], error = r['error']
  const needsText = status === 'completed' || status === 'partial'
  if (needsText) { if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > TEXT_LIMIT || usage === undefined) return { ok: false } }
  else { if (text !== undefined) return { ok: false } }
  if (error !== undefined) {
    if (typeof error !== 'object' || error === null) return { ok: false }
    const e = error as Record<string, unknown>
    if (typeof e['code'] !== 'string' || typeof e['reason'] !== 'string' || typeof e['message'] !== 'string') return { ok: false }
    const row = WIRE_RESULT_ROWS[`${e['code']}|${e['reason']}`]
    if (!row || row[0] !== status || row[3] !== e['message']) return { ok: false }
  } else if (!needsText) { return { ok: false } }
  if (usage !== undefined) {
    if (typeof usage !== 'object' || usage === null) return { ok: false }
    const u = usage as Record<string, unknown>
    const nums = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']
    if (!nums.every(f => isSafeInt(u[f]))) return { ok: false }
    if ((u['totalTokens'] as number) !== ((u['inputTokens'] as number) + (u['outputTokens'] as number) + (u['cacheReadTokens'] as number) + (u['cacheWriteTokens'] as number))) return { ok: false }
    if (typeof u['reportedModel'] !== 'string' || !u['reportedModel'] || Buffer.byteLength(u['reportedModel'], 'utf8') > ID_LIMIT) return { ok: false }
    if (u['terminalReason'] !== 'stop' && u['terminalReason'] !== 'length') return { ok: false }
    if (u['provenance'] !== 'provider_final') return { ok: false }
  }
  return { ok: true, result: r as unknown as WireResult }
}

function unsafeSegments(url: string): boolean {
  const path = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/[?#].*$/, '')
  return path.split('/').some(s => { try { const d = decodeURIComponent(s); return d === '.' || d === '..' || d.includes('/') || d.includes('\\') } catch { return true } })
}
export function normalizeCustomTransportHref(raw: string): string | null {
  if (unsafeSegments(raw)) return null
  let u: URL; try { u = new URL(raw) } catch { return null }
  if (u.username !== '' || u.password !== '' || u.hash !== '') return null
  if (u.protocol === 'https:') return u.href
  if (u.protocol === 'http:') { const h = u.hostname.replace(/^\[(.+)\]$/, '$1'); if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return u.href }
  return null
}
export function copilotTransportHref(token: string): string | null {
  const m = token.match(/proxy-ep=([^;]+)/)
  const raw = m?.[1] ? `https://${m[1].replace(/^proxy\./, 'api.')}` : 'https://api.individual.githubcopilot.com'
  try { return new URL(raw).href } catch { return null }
}
export function bedrockTransportHref(region: string): string { return `https://bedrock-runtime.${region}.amazonaws.com/` }
export function makePublicError(code: HostLlmErrorCode, reason: HostLlmErrorReason, requestId: string, model: string, usage?: HostLlmPublicUsage): HostLlmPublicResult {
  const key = `${code}|${reason}`
  const wire = WIRE_RESULT_ROWS[key]
  if (wire) return { status: wire[0] as 'no_output' | 'timed_out' | 'failed', error: { code, reason, message: wire[3] }, requestId, model, ...(usage ? { usage } : {}) }
  const row = PUBLIC_ERROR_MESSAGES[key]!
  return { status: row[0] as 'failed' | 'cancelled', error: { code, reason, message: row[1] }, requestId, model, ...(usage ? { usage } : {}) }
}
