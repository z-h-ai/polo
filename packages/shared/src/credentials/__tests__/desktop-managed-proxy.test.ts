import { expect, test } from 'bun:test'
import { createServer, request } from 'node:http'
import { startInvocationCredentialProxy } from '../invocation-credential-proxy'

test('desktop managed proxy rejects Host/Origin/model/path/auth before admission; close aborts admitted upstream and settles once', async () => {
  let providers = 0, admissions = 0, receipts = 0, current = true
  const upstream = createServer((req, res) => {
    providers++; req.resume(); res.setHeader('content-type', 'text/event-stream'); res.setHeader('x-oneapi-request-id', 'fixture-provider')
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const address = upstream.address() as { port: number }
  const proxy = await startInvocationCredentialProxy({ upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`, credential: 'fixture-private-key', credentialHeaders: [{ name: 'authorization', format: 'bearer' }] }, {
    managedPolicy: { allowedModels: ['allowed-model'] }, assertExecutionCurrent() { if (!current) throw new Error('revoked') },
    billing: { async beforeSend() { admissions++; return { providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) }, assertCurrent() {}, async complete(result) { receipts++; expect(result.outputDisposition).toBe('usable') } } } },
  })
  const send = async (path: string, headers: Record<string, string> = {}, model = 'allowed-model') => {
    const res = await fetch(proxy.url + path, { method: 'POST', headers: { authorization: `Bearer ${proxy.capability}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model, stream: true, messages: [] }) })
    await res.text(); expect(res.ok).toBe(false)
  }
  try {
    for (const path of ['/chat/completions', '/v1/chat/completions?x=1', '/v1/x/../chat/completions', '/v1//chat/completions', '/v1/responses']) {
      // fetch canonicalizes literal .., so use a raw HTTP request for that path.
      if (path.includes('..')) {
        await new Promise<void>((resolve, reject) => { const req = request(proxy.url, { method: 'POST', path, headers: { authorization: `Bearer ${proxy.capability}` } }, res => { expect(res.statusCode).not.toBe(200); res.resume(); res.on('end', resolve) }); req.on('error', reject); req.end('{}') })
      } else await send(path)
    }
    await send('/v1/chat/completions', { origin: 'https://evil.example' })
    await send('/v1/chat/completions', { host: 'evil.example' })
    await send('/v1/chat/completions', {}, 'forbidden-model')
    await send('/v1/chat/completions', { authorization: 'Bearer wrong' })
    expect(admissions).toBe(0); expect(providers).toBe(0)
    const response = await fetch(proxy.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${proxy.capability}` }, body: JSON.stringify({ model: 'allowed-model', stream: true }) })
    const consumed = response.text().catch(() => '')
    expect(admissions).toBe(1); expect(providers).toBe(1)
    current = false
    await proxy.close(); await consumed
    expect(receipts).toBe(1)
    await proxy.close(); expect(receipts).toBe(1)
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())) }
}, 15000)
