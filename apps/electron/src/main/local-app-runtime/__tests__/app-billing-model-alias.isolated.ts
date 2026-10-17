import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAppRuntimeCoordinator } from '../runtime-coordinator'
import { AppBillingOutbox } from '../app-billing-outbox'

test('SDK billing uses admitted sent model while Host retains response alias and original provider facts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'polo-app-alias-'))
  const identity = { accountId: 'account-a', productSpaceId: crypto.randomUUID(), artifactInstanceId: crypto.randomUUID(), versionId: crypto.randomUUID(), version: '1.0.0' }
  const captured: unknown[] = []
  const hostRequestId = `host-${crypto.randomUUID()}`
  const hostUsage = { inputTokens: 201, outputTokens: 58, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 259, reportedModel: 'deepseek-flash', terminalReason: 'stop' as const, provenance: 'provider_final' as const }
  const coordinator = new LocalAppRuntimeCoordinator({
    billingOutbox: new AppBillingOutbox(directory), getAdminOrigin: () => 'https://admin.example',
    admin: {
      startAppRun: async () => ({}),
      admitAppRequest: async (_runId, input) => { expect(input.model).toBe('deepseek-chat'); return { request: { requestId: input.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false } },
      recordAppUsage: async input => { captured.push(input); return { runId: input.runId, requestId: input.requestId, recorded: true, settlement: 'confirmed' } },
      finishAppRun: async runId => ({ runId, status: 'completed', settlement: 'confirmed' }),
    },
    createExecutor: ({ beforeSend }) => ({ execute: async () => {
      await beforeSend?.({ model: 'deepseek-chat', hostRequestId, transportBaseUrl: 'https://relay.example/v1', credentialFingerprint: 'a'.repeat(64) })
      return { status: 'completed', text: '{}', model: 'pi:deepseek-chat', requestId: hostRequestId, provider: 'openai', usage: hostUsage, providerObservation: { version: 1, state: 'observed', providerRequestId: 'provider-original', responseStatus: 200 } }
    }, dispose: async () => {} }),
    resolveWorkspaceRoot: () => directory, loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: 'managed', model: 'deepseek-chat' } }), getDefaultLlmConnection: () => null,
  })
  try {
    const url = await coordinator.ensureGateway()
    const signed = coordinator.signCapability({ identity, workspaceId: 'ws', executionId: 'exec', runtimeKind: 'js', runtimeGeneration: 1, scopeGeneration: 1 })
    coordinator.registerActiveRuntime({ identity, workspaceId: 'ws', executionId: 'exec', runtimeKind: 'js', runtimeGeneration: 1, scopeGeneration: 1, capabilityGeneration: signed.capabilityGeneration })
    const post = async (route: string, body: unknown) => { const r = await fetch(url + route, { method: 'POST', headers: { authorization: 'Bearer ' + signed.token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any } }
    const runId = crypto.randomUUID(), requestId = crypto.randomUUID()
    expect((await post('/run/start', { runId })).status).toBe(200)
    expect((await post('/ai/query', { runId, requestId, prompt: 'quote', maxOutputTokens: 4096, timeoutMs: 1000 })).body.data).toMatchObject({ text: '{}', settlement: 'confirmed' })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ runId, requestId, actualModel: 'deepseek-chat', inputTokens: 201, outputTokens: 58, provenance: 'provider_final', providerObservation: { providerRequestId: 'provider-original' } })
    expect(hostUsage.reportedModel).toBe('deepseek-flash')
  } finally { await coordinator.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})
