import { afterEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createSessionlessHostLlmExecutor } from '../../host-llm-executor'
import { clearInvocationLlmConnections, setInvocationLlmConnections } from '../../../config/storage'
import { clearInvocationCredentials, setInvocationCredential } from '../../../credentials'
import { adminNewApiConnection } from '../../../config/__fixtures__/admin-newapi'
import { validateHostRequest } from '../../../../../pi-agent-server/src/host-completion-protocol'
afterEach(() => { clearInvocationLlmConnections(); clearInvocationCredentials() })
describe('real Host child and installed Pi SDK correlation transport', () => {
  it('sends original key and only the admitted private header, then returns real response metadata', async () => {
    const nonce = randomBytes(16).toString('hex')
    let admittedBounds: any
    let actualBody = ''
    const calls: Array<{ nonce?: string; authorization?: string; path?: string; model?: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        actualBody = body
        const model = JSON.parse(body).model
        calls.push({ path: req.url, model, nonce: req.headers['x-polo-request-id'] as string, authorization: req.headers.authorization })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'X-Oneapi-Request-Id': 'actual-provider-call-1' })
        for (const chunk of [
          { id: 'chat1', model, choices: [{ delta: { role: 'assistant' } }] },
          { id: 'chat1', model, choices: [{ delta: { content: 'Delivered answer' } }] },
          { id: 'chat1', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, prompt_tokens_details: { cached_tokens: 3 } } },
        ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`
    const { apiKey: _fixtureKey, ...payload } = adminNewApiConnection('host-meter', endpoint)
    const conn = { ...payload, managedBy: 'admin' as const, createdAt: 1 }
    setInvocationLlmConnections([conn])
    setInvocationCredential({ type: 'llm_api_key', connectionSlug: conn.slug }, { value: 'ORIGINAL-TEST-KEY' })
    const executor = createSessionlessHostLlmExecutor({ connectionSlug: conn.slug, nodeRuntimePath: process.env.POLO_BILLING_NODE_RUNTIME ?? process.execPath, serverPath: process.env.POLO_BILLING_WORKER_ENTRY ?? join(import.meta.dir, '../../../../../pi-agent-server/src/index.ts'), beforeSend: async facts => { admittedBounds = facts.requestBounds; return { providerCorrelation: { header: 'X-Polo-Request-Id', nonce } } } })
    try {
      const result = await executor.execute({ prompt: 'Controlled transport test', maxOutputTokens: 32, timeoutMs: 20_000 })
      expect(calls).toEqual([{ path: '/v1/chat/completions', model: 'test-model', nonce, authorization: 'Bearer ORIGINAL-TEST-KEY' }])
      expect(result).toMatchObject({ status: 'completed', text: 'Delivered answer', providerObservation: { version: 1, state: 'observed', providerRequestId: 'actual-provider-call-1', responseStatus: 200 }, usage: { cacheReadTokens: 3, terminalReason: 'stop', provenance: 'provider_final' } })
      expect(admittedBounds.maxOutputTokens).toBe(32)
      expect(admittedBounds.bodySha256).toBe(createHash('sha256').update(actualBody).digest('hex'))
      expect(result.requestId).toMatch(/^host-/)
      expect(JSON.stringify(result)).not.toContain(nonce)
      expect(JSON.stringify(result)).not.toContain('ORIGINAL-TEST-KEY')
    } finally { await executor.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 30_000)

  it('rejects any worker header override outside the backend correlation contract', () => {
    const request = { type: 'host_completion', version: 1, parentValidation: 'sessionless-host-llm-executor.v1', requestId: 'host-internal', model: 'model', prompt: 'hello', maxOutputTokens: 8, timeoutMs: 1000, route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1/' }, credential: { type: 'api_key', value: 'PRIVATE-TEST-KEY' } }
    expect(validateHostRequest({ ...request, providerCorrelation: { header: 'Authorization', nonce: 'a'.repeat(32) } }).kind).toBe('invalid')
    expect(validateHostRequest({ ...request, providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'not-valid' } }).kind).toBe('invalid')
  })
})
