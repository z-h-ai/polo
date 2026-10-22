import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { startInvocationCredentialProxy } from '../invocation-credential-proxy'

test('provider cannot reflect private admission correlation into the child', async () => {
  const nonce = 'a'.repeat(32)
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader('x-polo-request-id', nonce)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: nonce } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const proxy = await startInvocationCredentialProxy({ upstreamBaseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, credential: 'actual-key', credentialHeaders: [{ name: 'authorization', format: 'bearer' }] }, { billing: { beforeSend: async () => ({ providerCorrelation: { header: 'X-Polo-Request-Id', nonce }, assertCurrent() {}, complete: async () => {} }) } })
  try {
    const response = await fetch(proxy.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${proxy.capability}` }, body: JSON.stringify({ model: 'deepseek-chat', messages: [] }) })
    expect(response.headers.get('x-polo-request-id')).toBeNull()
    expect(await response.text()).not.toContain(nonce)
  } finally {
    await proxy.close()
    await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections() })
  }
})
