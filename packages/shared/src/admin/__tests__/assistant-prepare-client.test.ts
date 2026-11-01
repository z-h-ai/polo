import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { AdminClient } from '../client'
import { AdminError } from '../types'
const input = () => ({ runId: randomUUID(), admission: { productSpaceId: randomUUID(), requestId: randomUUID(), hostRequestId: `host-${randomUUID()}`, model: 'owned-model', transportBaseUrl: 'https://provider.invalid/v1', credentialFingerprint: 'b'.repeat(64) } })
for (const result of ['wrong_run', 'wrong_request', 'missing_nonce', 'server_error', 'not_found', 'unauthorized'] as const) {
  test(`prepare ${result} never retries or falls back`, async () => {
    const original = input(); let calls = 0, refreshes = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      calls++; expect(new URL(req.url).pathname).toBe('/api/billing/assistant-requests')
      expect(await req.json()).toEqual(original)
      if (result === 'server_error' || result === 'not_found' || result === 'unauthorized') return Response.json({ error: 'forbidden' }, { status: result === 'not_found' ? 404 : result === 'unauthorized' ? 401 : 500 })
      return Response.json({ runId: result === 'wrong_run' ? randomUUID() : original.runId, request: { requestId: result === 'wrong_request' ? randomUUID() : original.admission.requestId, state: 'admitted', providerCorrelation: { nonce: result === 'missing_nonce' ? '' : 'a'.repeat(32), header: 'X-Polo-Request-Id' } }, idempotent: false })
    } })
    try {
      const client = new AdminClient(`http://127.0.0.1:${server.port}`, { tokenStore: { getRefreshToken: async () => { refreshes++; return 'fixture' } } })
      await expect(client.prepareAssistantRequest('fixture', original)).rejects.toBeInstanceOf(AdminError)
      expect(calls).toBe(1); expect(refreshes).toBe(0)
    } finally { await server.stop(true) }
  })
}
for (const config of [{}, { phoneAuthEnabled: false }, { phoneAuthEnabled: false, selfRegistrationEnabled: false, assistantPreparationVersion: 2 }]) {
  test('unrecognized capability response cannot silently choose legacy writes', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(config) })
    try { await expect(new AdminClient(`http://127.0.0.1:${server.port}`).supportsAssistantPreparation()).rejects.toBeInstanceOf(AdminError) }
    finally { await server.stop(true) }
  })
}
test('only schema-validated, bound preparation details survive error normalization', async () => {
  const original = input()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ error: 'insufficient_credit', details: { secret: 'must-not-propagate', assistantPreparation: { runId: original.runId, requestId: original.admission.requestId, phase: 'start_rejected' } } }, { status: 409 }) })
  try {
    let error: unknown
    try { await new AdminClient(`http://127.0.0.1:${server.port}`).prepareAssistantRequest('fixture', original) } catch (e) { error = e }
    expect(error).toBeInstanceOf(AdminError)
    expect((error as AdminError).details).toEqual({ assistantPreparation: { runId: original.runId, requestId: original.admission.requestId, phase: 'start_rejected' } })
  } finally { await server.stop(true) }
})

for (const mode of ['legacy', 'preparation', 'recovery'] as const) {
  test(`one public config read distinguishes ${mode} from a recovery guarantee`, async () => {
    let calls = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
      calls++; expect(req.method).toBe('GET'); expect(new URL(req.url).pathname).toBe('/api/auth/config')
      return Response.json({ phoneAuthEnabled: false, selfRegistrationEnabled: false,
        ...(mode !== 'legacy' ? { assistantPreparationVersion: 1 } : {}), ...(mode === 'recovery' ? { assistantRecoveryVersion: 1 } : {}),
      })
    } })
    try {
      expect(await new AdminClient(`http://127.0.0.1:${server.port}`).getAssistantBillingCapabilities()).toEqual({ preparation: mode !== 'legacy', recovery: mode === 'recovery' })
      expect(calls).toBe(1)
    } finally { await server.stop(true) }
  })
}
for (const versions of [{ assistantRecoveryVersion: 1 }, { assistantPreparationVersion: 1, assistantRecoveryVersion: 2 }]) {
  test('an inconsistent or unknown recovery contract cannot grant post-ack journaling', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ phoneAuthEnabled: false, selfRegistrationEnabled: false, ...versions }) })
    try { await expect(new AdminClient(`http://127.0.0.1:${server.port}`).getAssistantBillingCapabilities()).rejects.toBeInstanceOf(AdminError) }
    finally { await server.stop(true) }
  })
}
