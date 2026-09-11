import { describe, expect, it } from 'bun:test'
import {
  HOST_ERRORS, HOST_PARENT_MARKER, ID_LIMIT, INVALID_RESULT_LINE, RESULT_TOO_LARGE_LINE, TEXT_LIMIT,
  canonicalTransportHref, failureResult, serializeHostResult, validateHostRequest,
  type HostCompletionResultV1,
} from '../host-completion-protocol.ts'
import { isLoopback } from '../host-completion.ts'

const CREDENTIAL_API = { type: 'api_key', value: 'sk-test' } as const
const IAM = { type: 'iam', accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' } as const

function baseRequest(overrides: Record<string, unknown> = {}, credential: unknown = CREDENTIAL_API): Record<string, unknown> {
  return {
    type: 'host_completion', version: 1, parentValidation: HOST_PARENT_MARKER, requestId: 'req-1',
    route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com/' },
    model: 'pi/claude-3-5-haiku-20241022', prompt: 'hello', maxOutputTokens: 64, timeoutMs: 1000, credential, ...overrides,
  }
}

describe('host completion protocol validation', () => {
  it('accepts a valid catalog request and canonicalizes route data', () => {
    const request = validateHostRequest(baseRequest())
    expect(request).not.toBeNull()
    expect(request!.routeKind).toBe('catalog')
    expect(request!.provider).toBe('anthropic')
    expect(request!.model).toBe('pi/claude-3-5-haiku-20241022')
    expect(request!.transportHref).toBe('https://api.anthropic.com/')
    expect(request!.responseFormat).toBe('text')
    expect(request!.systemPrompt).toBe('')
  })

  it('rejects marker drift, unknown and additional fields, and wrong shapes', () => {
    expect(validateHostRequest(baseRequest({ parentValidation: 'sessionless-host-llm-executor.v2' }))).toBeNull()
    expect(validateHostRequest({ ...baseRequest(), extra: 1 })).toBeNull()
    expect(validateHostRequest({ ...baseRequest(), type: 'prompt' })).toBeNull()
    expect(validateHostRequest(baseRequest({ route: { kind: 'direct', baseUrl: 'https://x.com/' } }))).toBeNull()
    expect(validateHostRequest(baseRequest({ credential: { type: 'api_key', value: 'v', extra: 1 } }))).toBeNull()
    expect(validateHostRequest('not-an-object')).toBeNull()
    expect(validateHostRequest(null)).toBeNull()
  })

  it('enforces integer ranges for maxOutputTokens and timeoutMs', () => {
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 0 }))).toBeNull()
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 65_537 }))).toBeNull()
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 1.5 }))).toBeNull()
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 65_536 }))).not.toBeNull()
    expect(validateHostRequest(baseRequest({ timeoutMs: 99 }))).toBeNull()
    expect(validateHostRequest(baseRequest({ timeoutMs: 600_001 }))).toBeNull()
    expect(validateHostRequest(baseRequest({ timeoutMs: 100 }))).not.toBeNull()
  })

  it('enforces per-field UTF-8 byte boundaries exactly at the limit', () => {
    const id = 'r'.repeat(ID_LIMIT)
    expect(validateHostRequest(baseRequest({ requestId: id }))).not.toBeNull()
    expect(validateHostRequest(baseRequest({ requestId: id + 'r' }))).toBeNull()
    const multibyte = '字'.repeat(2731)
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(8193)
    expect(validateHostRequest(baseRequest({ requestId: multibyte }))).toBeNull()
    expect(validateHostRequest(baseRequest({ prompt: 'p'.repeat(1_048_576) }))).not.toBeNull()
    expect(validateHostRequest(baseRequest({ prompt: 'p'.repeat(1_048_577) }))).toBeNull()
    expect(validateHostRequest(baseRequest({ systemPrompt: 's'.repeat(524_288) }))).not.toBeNull()
    expect(validateHostRequest(baseRequest({ systemPrompt: 's'.repeat(524_289) }))).toBeNull()
    expect(validateHostRequest(baseRequest({ requestId: '' }))).toBeNull()
    expect(validateHostRequest(baseRequest({ model: '' }))).toBeNull()
  })

  it('rejects empty or oversize credential strings at the 64KiB boundary', () => {
    expect(validateHostRequest(baseRequest({}, { type: 'api_key', value: '' }))).toBeNull()
    expect(validateHostRequest(baseRequest({}, { type: 'api_key', value: 'k'.repeat(65_536) }))).not.toBeNull()
    expect(validateHostRequest(baseRequest({}, { type: 'api_key', value: 'k'.repeat(65_537) }))).toBeNull()
    expect(validateHostRequest(baseRequest({}, { type: 'iam', accessKeyId: '', secretAccessKey: 's', region: 'r' }))).toBeNull()
    expect(validateHostRequest(baseRequest({}, { type: 'iam', accessKeyId: 'a', secretAccessKey: 's', region: '' }))).toBeNull()
    expect(validateHostRequest(baseRequest({}, { type: 'oauth_access', value: 'k'.repeat(65_536) }))).not.toBeNull()
  })

  it('requires the catalog transportBaseUrl wire to already be the canonical href', () => {
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com' } }))).toBeNull()
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'HTTPS://api.anthropic.com/' } }))).toBeNull()
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com//' } }))).not.toBeNull()
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://user:pass@api.anthropic.com/' } }))).toBeNull()
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'not a url' } }))).toBeNull()
  })

  it('validates custom routes: pairing, scheme, userinfo, hash; normalizes the rest', () => {
    const custom = (route: Record<string, unknown>): unknown => baseRequest({ route })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1/' }))).toBeNull()
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'anthropic', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/' }))).toBeNull()
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'ftp://127.0.0.1:1/' }))).toBeNull()
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://u:p@127.0.0.1:1/' }))).toBeNull()
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/#frag' }))).toBeNull()
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'not-a-url' }))).toBeNull()
    const normalized = validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'HTTP://[::1]:80' }))
    expect(normalized).not.toBeNull()
    expect(normalized!.transportHref).toBe('http://[::1]/')
    expect(normalized!.api).toBe('openai-completions')
  })

  it('maps canonical URL helpers', () => {
    expect(canonicalTransportHref('https://host.example/')).toBe('https://host.example/')
    expect(canonicalTransportHref('https://host.example')).toBeNull()
    expect(canonicalTransportHref('::bad::')).toBeNull()
    expect(isLoopback('http://localhost:8080/')).toBe(true)
    expect(isLoopback('http://127.0.0.1:1/')).toBe(true)
    expect(isLoopback('http://[::1]:1/')).toBe(true)
    expect(isLoopback('https://example.com/')).toBe(false)
    expect(isLoopback('http://127.0.0.1.evil/')).toBe(false)
  })

  it('carries the complete fixed error table verbatim', () => {
    expect(Object.keys(HOST_ERRORS).length).toBe(13)
    expect(HOST_ERRORS.invalid_worker_message).toEqual(['failed', 'provider_protocol_error', 'invalid_worker_message', 'Host LLM worker protocol failed'])
    expect(HOST_ERRORS.result_too_large[3]).toBe('Host LLM worker result exceeds the wire limit')
    expect(HOST_ERRORS.catalog_model_missing[3]).toBe('Model is not available in the sealed provider catalog')
    expect(HOST_ERRORS.deadline_exceeded).toEqual(['timed_out', 'timed_out', 'deadline_exceeded', 'Host LLM request timed out'])
    expect(HOST_ERRORS.retry_blocked[3]).toBe('LLM provider attempted an unsupported retry')
    expect(HOST_ERRORS.provider_rejected_credentials).toEqual(['failed', 'auth_failed', 'provider_rejected_credentials', 'LLM provider rejected the connection credential'])
    expect(HOST_ERRORS.provider_request_failed[2]).toBe('provider_request_failed')
    expect(HOST_ERRORS.provider_error_terminal[3]).toBe('LLM provider request failed')
    expect(HOST_ERRORS.provider_aborted[2]).toBe('provider_aborted')
    expect(HOST_ERRORS.unexpected_terminal[3]).toBe('LLM provider returned an unsupported terminal event')
    expect(HOST_ERRORS.empty_text).toEqual(['no_output', 'no_output', 'empty_text', 'LLM provider returned no output'])
    expect(HOST_ERRORS.provider_usage_invalid[3]).toBe('LLM provider returned invalid usage')
    expect(HOST_ERRORS.json_object_required[3]).toBe('LLM provider returned invalid structured output')
  })

  it('serializes bounded results and falls back to the fixed result_too_large line', () => {
    const failure = failureResult('req-1', 'pi/m', 'catalog_model_missing')
    expect(failure.status).toBe('failed')
    expect(failure.error).toEqual({ code: 'provider_protocol_error', reason: 'catalog_model_missing', message: 'Model is not available in the sealed provider catalog' })
    expect(serializeHostResult(failure)).toBe(JSON.stringify(failure) + '\n')
    expect(serializeHostResult(failureResult('invalid', 'invalid', 'invalid_worker_message'))).toBe(INVALID_RESULT_LINE)
    const oversized: HostCompletionResultV1 = { ...failure, text: 'x'.repeat(TEXT_LIMIT + 1) }
    expect(serializeHostResult(oversized)).toBe(RESULT_TOO_LARGE_LINE)
    const bigModel: HostCompletionResultV1 = { ...failure, model: 'm'.repeat(ID_LIMIT + 1) }
    expect(serializeHostResult(bigModel)).toBe(RESULT_TOO_LARGE_LINE)
    expect(RESULT_TOO_LARGE_LINE.endsWith('\n')).toBe(true)
    expect(Buffer.byteLength(RESULT_TOO_LARGE_LINE)).toBeLessThan(4_194_304)
    expect(INVALID_RESULT_LINE).toContain('"requestId":"invalid"')
  })
})
