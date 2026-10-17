import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAppRuntimeCoordinator } from '../runtime-coordinator'
import { AppBillingOutbox } from '../app-billing-outbox'

for (const phase of ['current', 'scope', 'dispose-pending'] as const) {
  test(`Host terminal closes a detached beforeSend awaiting ${phase}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-admission-lifetime-'))
    const outbox = new AppBillingOutbox(dir)
    let releaseGuard!: () => void, releaseDispose!: () => void, disposeEntered!: () => void
    const guard = new Promise<void>(resolve => { releaseGuard = resolve })
    const dispose = new Promise<void>(resolve => { releaseDispose = resolve })
    const disposing = new Promise<void>(resolve => { disposeEntered = resolve })
    let hookPhase = false, hook: Promise<unknown> | undefined
    const events: string[] = []
    const identity = { accountId: 'actor', productSpaceId: crypto.randomUUID(), artifactInstanceId: crypto.randomUUID(), versionId: crypto.randomUUID(), version: '1.0.0' }
    const coordinator = new LocalAppRuntimeCoordinator({
      billingOutbox: outbox, getAdminOrigin: () => 'https://admin.example',
      isScopeCurrent: async () => { if (hookPhase && phase === 'scope') await guard; return true },
      admin: {
        startAppRun: async () => ({}),
        admitAppRequest: async (_run, input) => { events.push('admission'); return { request: { requestId: input.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false } },
        recordAppUsage: async () => { events.push('receipt'); return { settlement: 'confirmed' } },
        finishAppRun: async (_run, input) => { events.push('finish:' + input.status); return { settlement: 'confirmed' } },
      },
      createExecutor: ({ beforeSend }) => ({ execute: async () => {
        hookPhase = true
        hook = beforeSend!({ model: 'managed-model', hostRequestId: `host-${crypto.randomUUID()}`, transportBaseUrl: 'https://provider.example/v1', credentialFingerprint: 'a'.repeat(64) })
        // Production Host admission timeout leaves the hook's await pending.
        try { await Promise.race([hook, new Promise((_, reject) => setTimeout(() => reject(Error('Admission timed out')), 10))]) } catch {}
        events.push('host-terminal')
        return { status: 'failed', model: 'managed-model', requestId: '', error: { code: 'provider_failed', reason: 'provider_request_failed', message: 'Admission timed out' } }
      }, dispose: async () => { events.push('dispose'); disposeEntered(); if (phase === 'dispose-pending') await dispose } }),
      resolveWorkspaceRoot: () => dir, loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: 'managed', model: 'managed-model' } }), getDefaultLlmConnection: () => null,
    })
    try {
      await coordinator.ensureGateway()
      const input = { identity, workspaceId: 'ws', executionId: 'exec', runtimeKind: 'static' as const, runtimeGeneration: 1, scopeGeneration: 1 }
      const generation = coordinator.issueBrowserCapability(input), runtime = coordinator.registerActiveRuntime({ ...input, capabilityGeneration: generation })
      const current = async () => { if (hookPhase && phase !== 'scope') await guard; return true }
      const runId = crypto.randomUUID(), requestId = crypto.randomUUID(), signal = new AbortController().signal
      await coordinator.dispatchBrowser(runtime, '/run/start', { runId }, signal, current)
      const pending = coordinator.dispatchBrowser(runtime, '/ai/query', { runId, requestId, prompt: 'controlled lifetime test', maxOutputTokens: 16, timeoutMs: 1000 }, signal, current)
      if (phase === 'dispose-pending') { await disposing; releaseGuard(); await hook!.catch(() => {}); releaseDispose() }
      const result = await pending
      const record = (coordinator as any).runState.getQuery(generation, runId, requestId)
      expect(result).toEqual({ errorCode: 'host_failed' })
      expect(record).toMatchObject({ state: 'settled', requiredReceipt: false, outcome: { kind: 'error', code: 'host_failed' } })
      expect(await coordinator.cleanupBrowserRun(runtime, runId, 'failed')).toMatchObject({ finished: true })
      releaseGuard(); await hook!.catch(() => {})
      expect(events).toEqual(['host-terminal', 'dispose', 'finish:failed'])
      expect(outbox.entries('actor', 'https://admin.example')).toHaveLength(0)
      expect(record.outcome.code).toBe('host_failed')
    } finally { releaseGuard(); releaseDispose(); await coordinator.shutdown(); rmSync(dir, { recursive: true, force: true }) }
  })
}
