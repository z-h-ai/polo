import { describe, expect, it } from 'bun:test'
import { createServer, type ServerResponse } from 'node:http'
import { createBrowserFastDecider, type ManagedBrowserTransport } from '../browser-fast-decider'
import { adminNewApiConnection } from '../../config/__fixtures__/admin-newapi'
import type { ManagedBillingResult } from '../../credentials/managed-billing-observation'

const input = { snapshotText: '@e1 [button] "Help"\n@e2 [button] "Delete"', substep: 'Click Help' }
const models = ['deepseek-flash', 'glm-5.3-flash']

async function fixture(options: { denied?: boolean; missing?: boolean; unmanaged?: boolean; noBilling?: boolean; revoke?: boolean; retry?: boolean; slow?: boolean; signal?: AbortSignal; admissionBarrier?: Promise<void>; transportBarrier?: Promise<void>; settlementBarrier?: Promise<void>; timeoutMs?: number } = {}) {
  const requests: Array<{ model: string; authorization: string | undefined; nonce: string | undefined; body: any }> = []
  const admissions: string[] = [], receipts: ManagedBillingResult[] = []
  let current = true, closed = 0
  const upstream = createServer((req, res) => {
    let text = ''
    req.on('data', c => { text += c })
    req.on('end', () => {
      const body = JSON.parse(text)
      requests.push({ model: body.model, authorization: req.headers.authorization, nonce: req.headers['x-polo-request-id'] as string, body })
      res.on('close', () => { closed++ })
      if (options.slow) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":['); return
      }
      if (options.retry && requests.filter(r => r.model === body.model).length === 1) {
        res.writeHead(429); res.end('{"error":"rate limited"}'); return
      }
      reply(res, body.model)
    })
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  const address = upstream.address() as { port: number }
  const { apiKey: _key, ...payload } = adminNewApiConnection('browser', `http://127.0.0.1:${address.port}/v1`, options.missing ? [] : models)
  const connection = { ...payload, managedBy: options.unmanaged ? undefined : 'admin' as const, createdAt: 1 }
  const transport: ManagedBrowserTransport = {
    connection,
    signal: options.signal,
    assertCurrent() { if (!current) throw new Error('revoked') },
    billing: options.noBilling ? undefined : {
      async beforeSend(facts) {
        admissions.push(facts.model)
        await options.admissionBarrier
        if (options.denied) throw new Error('insufficient credit')
        if (options.revoke) current = false
        return {
          providerCorrelation: { header: 'X-Polo-Request-Id', nonce: crypto.randomUUID().replaceAll('-', '') },
          assertCurrent() { if (!current) throw new Error('revoked') },
          async complete(result) { await options.settlementBarrier; receipts.push(result) },
        }
      },
    },
  }
  const decider = createBrowserFastDecider({
    resolveTransport: async () => { await options.transportBarrier; return transport },
    resolveApiKey: async key => {
      expect(key).toContain(connection.slug)
      return 'private-managed-test-key'
    },
    getConfig: () => ({ enabled: true, timeoutMs: options.timeoutMs ?? (options.slow ? 1000 : 3000),
      // A malicious/stale local config must have no authority over routing.
      paths: [{ name: 'A', model: 'unbilled', connectionSlug: 'byok-provider' }],
    }),
  })
  return { requests, admissions, receipts, decider, closed: () => closed,
    async close() { await decider.dispose(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())) },
  }
}
function reply(res: ServerResponse, model: string) {
  res.writeHead(200, { 'content-type': 'application/json', 'x-oneapi-request-id': `provider-${model}` })
  res.end(JSON.stringify({ model, choices: [{ message: { content: 'click @e1' } }], usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 } } }))
}

describe('browser fast layer uses the main model managed transport', () => {
  it('meters both exact Admin models through the real credential proxy and observes final usage', async () => {
    const f = await fixture()
    try {
      const result = await f.decider(input)
      expect(result.agreement).toBe('both')
      expect(result.paths.map(p => p.model)).toEqual(models)
      expect(f.requests.map(r => r.model).sort()).toEqual([...models].sort())
      expect(f.admissions.sort()).toEqual([...models].sort())
      expect(f.requests.every(r => r.authorization === 'Bearer private-managed-test-key' && /^[0-9a-f]{32}$/.test(r.nonce!))).toBeTrue()
      expect(f.requests.find(r => r.model === models[0])!.body.thinking).toEqual({ type: 'disabled' })
      expect(f.requests.find(r => r.model === models[1])!.body.reasoning_effort).toBe('low')
      expect(f.receipts).toHaveLength(2)
      for (const r of f.receipts) expect(r).toMatchObject({ inputTokens: 15, outputTokens: 4, cacheReadTokens: 5, provenance: 'provider_final', outputDisposition: 'usable' })
      expect(JSON.stringify(result)).not.toContain('private-managed-test-key')
      expect(f.receipts.map(r => r.actualModel).sort()).toEqual([...models].sort())
    } finally { await f.close() }
  })
  for (const option of ['denied', 'missing', 'unmanaged', 'noBilling', 'revoke'] as const) {
    it(`does not send provider requests when ${option}`, async () => {
      const f = await fixture({ [option]: true })
      try {
        const r = await f.decider(input)
        expect(r.suggestedCommand).toBeNull()
        expect(f.requests).toHaveLength(0)
        if (['missing', 'unmanaged', 'noBilling'].includes(option)) expect(f.admissions).toHaveLength(0)
      } finally { await f.close() }
    })
  }
  it('admits and settles every retry separately', async () => {
    const f = await fixture({ retry: true })
    try {
      expect((await f.decider(input)).agreement).toBe('both')
      expect(f.requests).toHaveLength(4)
      expect(f.admissions).toHaveLength(4)
      expect(f.receipts).toHaveLength(4)
      expect(new Set(f.requests.map(r => r.nonce)).size).toBe(4)
    } finally { await f.close() }
  })
  it('closes timed-out upstream requests and settles each admitted attempt once', async () => {
    const f = await fixture({ slow: true })
    try {
      const start = Date.now()
      const result = await f.decider(input)
      expect(Date.now() - start).toBeLessThan(2500)
      expect(result.suggestedCommand).toBeNull()
      await f.decider.dispose()
      expect(f.admissions).toHaveLength(2)
      expect(f.receipts).toHaveLength(2)
      expect(f.receipts.every(r => r.provenance !== 'provider_final')).toBeTrue()
    } finally { await f.close() }
  })
  it('sends nothing for a stopped turn', async () => {
    const controller = new AbortController(); controller.abort()
    const f = await fixture({ signal: controller.signal })
    try {
      expect((await f.decider(input)).suggestedCommand).toBeNull()
      expect(f.admissions).toHaveLength(0)
      expect(f.requests).toHaveLength(0)
    } finally { await f.close() }
  })
  for (const phase of ['request', 'retry', 'admission'] as const) {
    it(`user stop cancels both paths during ${phase} without extra provider attempts`, async () => {
      const controller = new AbortController()
      let release!: () => void
      const barrier = new Promise<void>(r => { release = r })
      const f = await fixture({ signal: controller.signal, slow: phase === 'request', retry: phase === 'retry', admissionBarrier: phase === 'admission' ? barrier : undefined })
      try {
        const pending = f.decider(input)
        const deadline = Date.now() + 2000
        while ((phase === 'admission' ? f.admissions.length : f.requests.length) < 2 && Date.now() < deadline) await Bun.sleep(5)
        expect(f.admissions).toHaveLength(2)
        controller.abort(); release()
        const stoppedAt = Date.now()
        expect((await pending).suggestedCommand).toBeNull()
        expect(Date.now() - stoppedAt).toBeLessThan(500)
        await f.decider.dispose()
        expect(f.requests).toHaveLength(phase === 'admission' ? 0 : 2)
        expect(f.receipts).toHaveLength(2)
      } finally { release(); await f.close() }
    })
  }
  for (const phase of ['transport', 'admission', 'settlement'] as const) {
    it(`returns by its total deadline during delayed ${phase}, then drains the original cleanup`, async () => {
      let release!: () => void
      const barrier = new Promise<void>(r => { release = r })
      const f = await fixture({ timeoutMs: 1000, [`${phase}Barrier`]: barrier })
      try {
        const start = Date.now()
        expect((await f.decider(input)).suggestedCommand).toBeNull()
        expect(Date.now() - start).toBeLessThan(1600)
        let drained = false
        const cleanup = f.decider.dispose().then(() => { drained = true })
        await Bun.sleep(25)
        expect(drained).toBeFalse()
        release(); await cleanup
        expect(f.requests).toHaveLength(phase === 'settlement' ? 2 : 0)
        expect(f.receipts).toHaveLength(phase === 'transport' ? 0 : 2)
        expect((await f.decider(input)).suggestedCommand).toBeNull()
      } finally { release(); await f.close() }
    })
  }
})
