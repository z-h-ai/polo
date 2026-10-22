/** Browser-safe protocol. This is the only bridge DTO source for SDK/Main/preload. */
export const SDK_PROTOCOL_VERSION = 1 as const
export const SDK_CHANNEL = 'polo-app-sdk:v1' as const
export const SDK_STATUS_CHANNEL = 'polo-app-sdk:status:v1' as const
export type PoloErrorCode =
  | 'host_unavailable' | 'unsupported_host' | 'invalid_request'
  | 'capability_invalid' | 'route_not_found' | 'method_not_allowed'
  | 'request_too_large' | 'unsupported_media_type' | 'request_in_progress'
  | 'idempotency_conflict' | 'run_state_conflict' | 'run_finalized'
  | 'insufficient_credit' | 'request_cancelled' | 'host_auth_failed'
  | 'host_failed' | 'host_configuration_unavailable' | 'metering_unconfirmed'
  | 'sink_unavailable' | 'shutting_down' | 'response_cache_full'
  | 'run_registry_full' | 'host_timed_out' | 'no_output'
export interface QueryInput {
  prompt: string
  systemPrompt?: string
  responseFormat?: 'text' | 'json_object'
  maxOutputTokens?: number
  timeoutMs?: number
}
export type Settlement = 'pending' | 'confirmed' | 'no_charge' | 'unknown'
export interface PoloResult {
  status: 'completed' | 'partial'
  text: string
  requestId: string
  settlement: Settlement
}
export type PoloPhase = 'starting' | 'running' | 'settling' | 'completed' | 'cancelled' | 'failed'
export interface PoloStatus { phase: PoloPhase }
export interface HostInfo { protocolVersion: 1; features: readonly ['single_query', 'cancel', 'status'] }
export type Reply<T> = { ok: true; data: T } | { ok: false; error: { code: PoloErrorCode } }
/** Fixed capability surface; no channels, runtime identity, tokens, or raw IPC. */
export interface AppSdkHost {
  info(): Promise<Reply<HostInfo>>
  start(callId: string, input: QueryInput): Promise<Reply<PoloResult>>
  cancel(callId: string): Promise<Reply<{ accepted: boolean }>>
  onStatus(listener: (event: { callId: string; phase: PoloPhase }) => void): () => void
}
export function validCallId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
/** Defense in depth; the Main also applies the authoritative shared schema. */
export function validQuery(value: unknown): value is QueryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['prompt', 'systemPrompt', 'responseFormat', 'maxOutputTokens', 'timeoutMs'].includes(k))) return false
  const bytes = (s: string) => new TextEncoder().encode(s).length
  return typeof v.prompt === 'string' && !!v.prompt.trim() && bytes(v.prompt) <= 1_048_576
    && (v.systemPrompt === undefined || typeof v.systemPrompt === 'string' && bytes(v.systemPrompt) <= 524_288)
    && (v.responseFormat === undefined || v.responseFormat === 'text' || v.responseFormat === 'json_object')
    && (v.maxOutputTokens === undefined || Number.isInteger(v.maxOutputTokens) && (v.maxOutputTokens as number) >= 1 && (v.maxOutputTokens as number) <= 8192)
    && (v.timeoutMs === undefined || Number.isInteger(v.timeoutMs) && (v.timeoutMs as number) >= 1000 && (v.timeoutMs as number) <= 120_000)
}
