import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { startInvocationCredentialProxy } from '../invocation-credential-proxy'

test('stopping after upstream accepts POST but before first headers terminates the billing lease', async () => {
  let accepted!: () => void, completed!: (r: unknown) => void
  const received = new Promise<void>(r => { accepted = r })
  const receipt = new Promise<any>(r => { completed = r })
  const server = createServer(async (req, res) => { for await (const _ of req) {} accepted(); /* intentionally wait for original request cancellation */ })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const proxy = await startInvocationCredentialProxy({ upstreamBaseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, credential: 'original-key', credentialHeaders: [{ name: 'authorization', format: 'bearer' }] }, { billing: { beforeSend: async () => ({ providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) }, assertCurrent() {}, complete: async r => { completed(r) } }) } })
  const controller = new AbortController()
  try {
    const response = fetch(proxy.url + '/chat/completions', { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${proxy.capability}` }, body: JSON.stringify({ model: 'deepseek-chat', messages: [] }) }).catch(() => null)
    await received; controller.abort(); await response
    const result = await Promise.race([receipt, new Promise(resolve => setTimeout(() => resolve(null), 500))])
    expect(result).not.toBeNull()
    expect(result).toMatchObject({ outputDisposition: 'unknown', providerObservation: { state: 'missing' } })
  } finally {
    await proxy.close()
    await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections() })
  }
})
