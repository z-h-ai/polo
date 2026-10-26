import { afterEach, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { startInvocationCredentialProxy, type InvocationCredentialProxy } from '../invocation-credential-proxy'
import { INSUFFICIENT_CREDIT_ERROR_CODES } from '../insufficient-credit-codes'

const servers: Server[] = []
const proxies: InvocationCredentialProxy[] = []
afterEach(async () => {
  await Promise.all(proxies.splice(0).map(p => p.close()))
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.close(() => r()); s.closeAllConnections() })))
})
async function fixture(billing: unknown, stream = true) {
  const seen: { headers: unknown; body: any }[] = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    seen.push({ headers: req.headers, body: JSON.parse(body) })
    res.setHeader('x-oneapi-request-id', 'provider-request-123')
    if (stream) {
      res.setHeader('content-type', 'text/event-stream')
      const chunks = [
        { model: 'deepseek-chat', choices: [{ delta: { content: 'answer' } }] },
        { model: 'deepseek-chat', choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } } },
      ]
      for (const chunk of chunks) {
        const frame = `data: ${JSON.stringify(chunk)}\n\n`
        res.write(frame.slice(0, 12)); res.write(frame.slice(12))
      }
      res.end('data: [DONE]\n\n')
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { tool_calls: [{ id: 'call1' }] } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }))
    }
  })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}/v1`
  const proxy = await startInvocationCredentialProxy({ upstreamBaseUrl: base, credential: 'private-upstream-key', credentialHeaders: [{ name: 'authorization', format: 'bearer' }] }, { billing } as any)
  proxies.push(proxy)
  const send = (path = '/v1/chat/completions', extra: Record<string, unknown> = {}) => fetch(proxy.url + path, {
    method: 'POST', headers: { authorization: `Bearer ${proxy.capability}`, 'content-type': 'application/json', 'x-polo-request-id': 'forged-child-correlation' },
    body: JSON.stringify({ model: 'deepseek-chat', stream, messages: [{ role: 'user', content: 'private prompt' }], ...extra }),
  })
  return { seen, send, base }
}
const correlation = { header: 'X-Polo-Request-Id' as const, nonce: 'a'.repeat(32) }
test('managed request is denied before upstream consumption', async () => {
  const f = await fixture({ beforeSend: async () => { throw new Error('insufficient_quota') } })
  const response = await f.send(); await response.text()
  expect(response.ok).toBe(false)
  expect(f.seen).toHaveLength(0)
})
test('every backend spelling of an exhausted allowance classifies as insufficient credit', async () => {
  for (const errorCode of INSUFFICIENT_CREDIT_ERROR_CODES) {
    const f = await fixture({ beforeSend: async () => { throw Object.assign(new Error('denied'), { errorCode }) } })
    const response = await f.send(); const body = await response.text()
    expect(response.status).toBe(402)
    expect(body).toContain('POLO_INSUFFICIENT_CREDIT')
  }
  const unavailable = await fixture({ beforeSend: async () => { throw Object.assign(new Error('denied'), { errorCode: 'validation_error' }) } })
  const response = await unavailable.send(); const body = await response.text()
  expect(response.status).toBe(502)
  expect(body).toContain('Credential proxy upstream request failed')
})
test('each real request gets private admission and provider-final usage; cache tokens are disjoint', async () => {
  const admissions: any[] = [], receipts: any[] = []
  const f = await fixture({ beforeSend: async (facts: any) => {
    admissions.push(facts)
    return { providerCorrelation: correlation, assertCurrent() {}, complete: async (result: any) => { receipts.push(result) } }
  } })
  for (let i = 0; i < 2; i++) { const r = await f.send(); expect(r.ok).toBe(true); expect(await r.text()).toContain('answer') }
  expect(admissions).toHaveLength(2)
  expect(admissions[0]).toMatchObject({ model: 'deepseek-chat', transportBaseUrl: f.base, credentialFingerprint: createHash('sha256').update('private-upstream-key').digest('hex') })
  expect(admissions[0].hostRequestId).not.toBe(admissions[1].hostRequestId)
  expect(admissions[0]).not.toHaveProperty('messages')
  expect(f.seen[0]!.headers).toMatchObject({ authorization: 'Bearer private-upstream-key', 'x-polo-request-id': correlation.nonce })
  expect(f.seen[0]!.body.stream_options.include_usage).toBe(true)
  expect(f.seen[0]!.body.max_tokens).toBe(8192)
  expect(admissions[0].requestBounds.maxOutputTokens).toBe(8192)
  expect(admissions[0].requestBounds.bodySha256).toBe(createHash('sha256').update(JSON.stringify(f.seen[0]!.body)).digest('hex'))
  expect(admissions[0].requestBounds.maxInputTokens).toBeGreaterThan(Buffer.byteLength(JSON.stringify(f.seen[0]!.body)))
  expect(receipts).toHaveLength(2)
  expect(receipts[0]).toMatchObject({ inputTokens: 60, outputTokens: 7, cacheReadTokens: 40, cacheWriteTokens: 0, actualModel: 'deepseek-chat', provenance: 'provider_final', outputDisposition: 'usable', providerObservation: { version: 1, state: 'observed', providerRequestId: 'provider-request-123', responseStatus: 200 } })
  expect(JSON.stringify(receipts)).not.toContain('private prompt')
})
test('scope is rechecked after asynchronous admission before sending', async () => {
  const receipts: unknown[] = []
  const f = await fixture({ beforeSend: async () => ({ providerCorrelation: correlation, assertCurrent() { throw new Error('space changed') }, complete: async (result: unknown) => { receipts.push(result) } }) })
  const r = await f.send(); await r.text()
  expect(r.ok).toBe(false); expect(f.seen).toHaveLength(0)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ outputDisposition: 'unknown' })
})
test('unsupported managed transport fails closed without a provider call', async () => {
  let admitted = false
  const f = await fixture({ beforeSend: async () => { admitted = true; return { providerCorrelation: correlation, assertCurrent() {}, complete: async () => {} } } })
  const r = await f.send('/v1/responses'); await r.text()
  expect(r.ok).toBe(false); expect(f.seen).toHaveLength(0); expect(admitted).toBe(false)
})
test('non-stream utility/tool response uses the same billing boundary', async () => {
  const receipts: any[] = []
  const f = await fixture({ beforeSend: async () => ({ providerCorrelation: correlation, assertCurrent() {}, complete: async (r: any) => { receipts.push(r) } }) }, false)
  const r = await f.send(); expect(r.ok).toBe(true); await r.text()
  expect(receipts[0]).toMatchObject({ inputTokens: 11, outputTokens: 3, outputDisposition: 'usable', provenance: 'provider_final' })
})

test.each([
 { max_tokens: 0 }, { max_tokens: -1 }, { max_tokens: '100' },
 { max_tokens: 10, max_completion_tokens: 20 }, { n: 0 },
 { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/private.png' } }] }] },
])('unbounded requests are refused before admission and provider consumption: %j', async extra => {
 let admissions = 0
 const f = await fixture({ beforeSend: async () => { admissions++; throw new Error('unexpected admission') } })
 const response = await f.send('/v1/chat/completions', extra); await response.text()
 expect(response.ok).toBe(false); expect(admissions).toBe(0); expect(f.seen).toHaveLength(0)
})
test('explicit completion limit and choice count bind the forwarded body', async () => {
 let facts: any
 const f = await fixture({ beforeSend: async (value: any) => { facts = value; return { providerCorrelation: correlation, assertCurrent() {}, complete: async () => {} } } })
 const response = await f.send('/v1/chat/completions', { max_completion_tokens: 31, n: 2 }); await response.text()
 expect(response.ok).toBe(true); expect(facts.requestBounds.maxOutputTokens).toBe(62)
 expect(f.seen[0]!.body.max_tokens).toBeUndefined(); expect(f.seen[0]!.body.max_completion_tokens).toBe(31)
})

test('insufficient balance returns a recharge prompt and consumes no upstream request',async()=>{
 const {setupI18n}=await import('../../i18n');const locale=setupI18n(),previous=locale.language;await locale.changeLanguage('zh-Hans')
 try {const f=await fixture({beforeSend:async()=>{throw Object.assign(new Error('Insufficient credit'),{errorCode:'insufficient_credit'})}})
 const response=await f.send();expect(response.status).toBe(402);expect(await response.text()).toContain('余额不足，请充值后重试。');expect(f.seen).toHaveLength(0)
 } finally {await locale.changeLanguage(previous)}
})
