import { describe, expect, it } from 'bun:test'
import {
  HOST_ERRORS, HOST_PARENT_MARKER, ID_LIMIT, INVALID_RESULT_LINE, RESULT_TOO_LARGE_LINE, TEXT_LIMIT,
  canonicalTransportHref, failureResult, serializeHostResult, unsafeSegments, validateHostRequest,
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
    const verdict = validateHostRequest(baseRequest())
    expect(verdict.kind).toBe('valid')
    const request = verdict.kind === 'valid' ? verdict.request : null
    expect(request!.routeKind).toBe('catalog')
    expect(request!.provider).toBe('anthropic')
    expect(request!.model).toBe('pi/claude-3-5-haiku-20241022')
    expect(request!.transportHref).toBe('https://api.anthropic.com/')
    expect(request!.responseFormat).toBe('text')
    expect(request!.systemPrompt).toBe('')
  })

  it('rejects marker drift, unknown and additional fields, and wrong shapes as invalid', () => {
    expect(validateHostRequest(baseRequest({ parentValidation: 'sessionless-host-llm-executor.v2' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest({ ...baseRequest(), extra: 1 })).toEqual({ kind: 'invalid' })
    expect(validateHostRequest({ ...baseRequest(), type: 'prompt' })).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ route: { kind: 'direct', baseUrl: 'https://x.com/' } }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ credential: { type: 'api_key', value: 'v', extra: 1 } }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest('not-an-object')).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(null)).toEqual({ kind: 'invalid' })
  })

  it('enforces integer ranges for maxOutputTokens and timeoutMs as invalid', () => {
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 0 }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 65_537 }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 1.5 }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ maxOutputTokens: 65_536 })).kind).toBe('valid')
    expect(validateHostRequest(baseRequest({ timeoutMs: 99 }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ timeoutMs: 600_001 }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ timeoutMs: 100 })).kind).toBe('valid')
  })

  it('maps every over-limit field byte boundary to result_too_large, not invalid', () => {
    expect(validateHostRequest(baseRequest({ requestId: 'r'.repeat(ID_LIMIT + 1) }))).toEqual({ kind: 'oversize' })
    expect(validateHostRequest(baseRequest({ requestId: 'r'.repeat(ID_LIMIT) })).kind).toBe('valid')
    const multibyte = '字'.repeat(2731)
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(8193)
    expect(validateHostRequest(baseRequest({ requestId: multibyte }))).toEqual({ kind: 'oversize' })
    expect(validateHostRequest(baseRequest({ prompt: 'p'.repeat(1_048_577) }))).toEqual({ kind: 'oversize' })
    expect(validateHostRequest(baseRequest({ prompt: 'p'.repeat(1_048_576) })).kind).toBe('valid')
    expect(validateHostRequest(baseRequest({ systemPrompt: 's'.repeat(524_289) }))).toEqual({ kind: 'oversize' })
    expect(validateHostRequest(baseRequest({ systemPrompt: 's'.repeat(524_288) })).kind).toBe('valid')
    expect(validateHostRequest(baseRequest({}, { type: 'api_key', value: 'k'.repeat(65_537) }))).toEqual({ kind: 'oversize' })
    expect(validateHostRequest(baseRequest({}, { type: 'api_key', value: 'k'.repeat(65_536) })).kind).toBe('valid')
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://a.example/'.slice(0, 13) + 'a'.repeat(8192 - 13 + 1) + '/' } }))).toEqual({ kind: 'oversize' })
  })

  it('rejects empty identifiers and credential strings as invalid, not oversize', () => {
    expect(validateHostRequest(baseRequest({ requestId: '' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ model: '' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({}, { type: 'api_key', value: '' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({}, { type: 'iam', accessKeyId: '', secretAccessKey: 's', region: 'r' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({}, { type: 'iam', accessKeyId: 'a', secretAccessKey: 's', region: '' }))).toEqual({ kind: 'invalid' })
  })

  it('requires the catalog transportBaseUrl wire to already be the canonical href', () => {
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com' } }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'HTTPS://api.anthropic.com/' } }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com//' } })).kind).toBe('valid')
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://user:pass@api.anthropic.com/' } }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'not a url' } }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(baseRequest({ route: { kind: 'catalog', provider: '', transportBaseUrl: 'https://api.anthropic.com/' } }))).toEqual({ kind: 'invalid' })
  })

  it('validates custom routes: pairing, scheme, userinfo, hash, and 8KiB bound', () => {
    const custom = (route: Record<string, unknown>): unknown => baseRequest({ route })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1/' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'anthropic', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: '', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'ftp://127.0.0.1:1/' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://u:p@127.0.0.1:1/' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/#frag' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'not-a-url' }))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: `http://127.0.0.1:1/${'a'.repeat(8193)}` }))).toEqual({ kind: 'oversize' })
    expect(validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: `http://127.0.0.1:1/${'a'.repeat(8173)}` })).kind).toBe('valid')
    const normalized = validateHostRequest(custom({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'HTTP://[::1]:80' }))
    expect(normalized.kind).toBe('valid')
    const normalizedRequest = normalized.kind === 'valid' ? normalized.request : null
    expect(normalizedRequest!.transportHref).toBe('http://[::1]/')
    expect(normalizedRequest!.api).toBe('openai-completions')
  })

  it('rejects encoded traversal and adjacent path segments in the raw custom baseUrl before normalization', () => {
    const custom = (baseUrl: string): unknown => baseRequest({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl } })
    expect(validateHostRequest(custom('https://example.com/base/%2e%2e/evil'))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom('https://example.com/%2e/evil'))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom('https://example.com/a%2fb/evil'))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom('https://example.com/a%5Cb/evil'))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom('https://example.com/base/../evil'))).toEqual({ kind: 'invalid' })
    expect(validateHostRequest(custom('https://example.com/ok/path'))).not.toEqual({ kind: 'invalid' })
    expect(unsafeSegments('/base/%2e%2e/evil')).toBe(true)
    expect(unsafeSegments('/base/ok')).toBe(false)
    expect(unsafeSegments('/%2e%2e/')).toBe(true)
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
