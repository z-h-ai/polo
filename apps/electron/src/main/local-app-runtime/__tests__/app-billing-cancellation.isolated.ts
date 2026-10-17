import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAppRuntimeCoordinator, type CoordinatorExecutor } from '../runtime-coordinator'
import { AppBillingOutbox } from '../app-billing-outbox'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const facts = { model: 'managed-model', hostRequestId: `host-${crypto.randomUUID()}`, transportBaseUrl: 'https://provider.example/v1', credentialFingerprint: 'a'.repeat(64) }
const cancelled = { status: 'cancelled' as const, model: 'managed-model', requestId: facts.hostRequestId, error: { code: 'cancelled' as const, reason: 'caller_aborted' as const, message: 'Cancelled' } }
const failed = { ...cancelled, status: 'failed' as const, error: { code: 'credential_unavailable' as const, reason: 'credential_missing' as const, message: 'Unavailable' } }
const success = { status: 'completed' as const, model: 'managed-model', requestId: facts.hostRequestId, provider: 'openai', text: '{}', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, reportedModel: 'alias', terminalReason: 'stop' as const, provenance: 'provider_final' as const } }

type Phase = 'host-cancel' | 'current-await' | 'scope-await' | 'ack-unknown' | 'admitted-cancel' | 'late-success' | 'error-then-abort' | 'guard-withdrawal'
async function fixture(phase: Phase) {
  const dir = mkdtempSync(join(tmpdir(), 'app-cancel-phase-'))
  const outbox = new AppBillingOutbox(dir), entered = gate(), resume = gate()
  const controller = new AbortController()
  const identity = { accountId: 'actor', productSpaceId: crypto.randomUUID(), artifactInstanceId: crypto.randomUUID(), versionId: crypto.randomUUID(), version: '1.0.0' }
  const calls = { admissions: 0, providers: 0, executions: 0, receipts: [] as unknown[], finishes: [] as any[] }
  let beforeSendPhase = false
  const coordinator = new LocalAppRuntimeCoordinator({
    billingOutbox: outbox, getAdminOrigin: () => 'https://admin.example',
    isScopeCurrent: async () => {
      if (beforeSendPhase && phase === 'scope-await') { entered.release(); await resume.promise }
      return true
    },
    admin: {
      startAppRun: async () => ({}),
      admitAppRequest: async (_run, input) => {
        calls.admissions++
        if (phase === 'ack-unknown') { entered.release(); await resume.promise; throw Error('Acknowledgement lost') }
        return { request: { requestId: input.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false }
      },
      recordAppUsage: async input => { calls.receipts.push(input); return { settlement: 'confirmed' } },
      finishAppRun: async (runId, input, options) => { calls.finishes.push({ runId, input, accountId: options?.accountId, signalAborted: options?.signal?.aborted }); return { settlement: 'confirmed' } },
    },
    createExecutor: ({ beforeSend }) => ({ execute: async () => {
      calls.executions++
      if (phase === 'host-cancel' || phase === 'error-then-abort') {
        entered.release(); await resume.promise
        return phase === 'host-cancel' ? cancelled : failed
      }
      beforeSendPhase = true
      try { await beforeSend?.(facts) } catch { return { ...cancelled, status: 'failed', error: { code: 'provider_failed', reason: 'provider_request_failed', message: 'Admission rejected' } } }
      calls.providers++
      if (phase === 'admitted-cancel' || phase === 'late-success') { entered.release(); await resume.promise }
      return phase === 'admitted-cancel' ? cancelled : success
    }, dispose: async () => {} } as CoordinatorExecutor),
    resolveWorkspaceRoot: () => dir, loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: 'managed', model: 'managed-model' } }), getDefaultLlmConnection: () => null,
  })
  await coordinator.ensureGateway()
  const input = { identity, workspaceId: 'ws', executionId: 'exec', runtimeKind: 'static' as const, runtimeGeneration: 1, scopeGeneration: 1 }
  const capabilityGeneration = coordinator.issueBrowserCapability(input)
  const runtime = coordinator.registerActiveRuntime({ ...input, capabilityGeneration })
  const current = async () => {
    if (beforeSendPhase && phase === 'current-await') { entered.release(); await resume.promise }
    return !(beforeSendPhase && phase === 'guard-withdrawal')
  }
  const runId = crypto.randomUUID(), requestId = crypto.randomUUID()
  await coordinator.dispatchBrowser(runtime, '/run/start', { runId }, controller.signal, current)
  const query = { runId, requestId, prompt: 'quote', maxOutputTokens: 16, timeoutMs: 1000 }
  const pending = coordinator.dispatchBrowser(runtime, '/ai/query', query, controller.signal, current)
  if (phase !== 'guard-withdrawal') { await entered.promise; controller.abort(); resume.release() }
  const outcome = await pending
  return { coordinator, calls, outbox, identity, runId, requestId, outcome,
    record: (coordinator as any).runState.getQuery(capabilityGeneration, runId, requestId),
    cleanup: () => coordinator.cleanupBrowserRun(runtime, runId, 'cancelled'),
    replay: () => coordinator.dispatchBrowser(runtime, '/ai/query', query, new AbortController().signal, async () => true),
    close: async () => { await coordinator.shutdown(); rmSync(dir, { recursive: true, force: true }) } }
}

for (const phase of ['host-cancel', 'current-await', 'scope-await'] as const) {
  test(`managed browser cancellation before dispatch: ${phase}`, async () => {
    const f = await fixture(phase)
    try {
      expect(f.outcome).toEqual({ errorCode: 'request_cancelled' })
      expect(f.record).toMatchObject({ state: 'settled', requiredReceipt: false, outcome: { kind: 'error', code: 'request_cancelled' } })
      expect(f.calls.admissions).toBe(0); expect(f.calls.providers).toBe(0); expect(f.calls.receipts).toHaveLength(0)
      expect(f.outbox.entries('actor', 'https://admin.example')).toHaveLength(0)
      expect(await f.replay()).toEqual({ errorCode: 'request_cancelled' }); expect(f.calls.executions).toBe(1)
      expect(await f.cleanup()).toMatchObject({ finished: true })
      await f.cleanup()
      expect(f.calls.finishes).toEqual([{ runId: f.runId, input: { status: 'cancelled' }, accountId: 'actor', signalAborted: false }])
    } finally { await f.close() }
  })
}
test('dispatched admission with unknown acknowledgement remains unknown and is never resent', async () => {
  const f = await fixture('ack-unknown')
  try {
    expect(f.outcome).toEqual({ errorCode: 'metering_unconfirmed' })
    expect(await f.replay()).toEqual({ errorCode: 'metering_unconfirmed' })
    expect(f.calls.admissions).toBe(1); expect(f.calls.providers).toBe(0); expect(f.calls.executions).toBe(1)
    expect(f.calls.receipts).toHaveLength(0)
    expect(f.outbox.entries('actor', 'https://admin.example')[0]).toMatchObject({ phase: 'admission', runId: f.runId, admission: { requestId: f.requestId } })
  } finally { await f.close() }
})
for (const phase of ['admitted-cancel', 'late-success'] as const) {
  test(`confirmed admission retains existing terminal and receipt contract: ${phase}`, async () => {
    const f = await fixture(phase)
    try {
      expect(f.calls.admissions).toBe(1); expect(f.calls.providers).toBe(1); expect(f.calls.receipts).toHaveLength(1)
      expect(f.calls.receipts[0]).toMatchObject({ runId: f.runId, requestId: f.requestId, actualModel: 'managed-model' })
      if (phase === 'admitted-cancel') expect(f.outcome).toEqual({ errorCode: 'request_cancelled' })
      else expect(f.outcome).toMatchObject({ data: { text: '{}', settlement: 'confirmed' } })
      expect(await f.cleanup()).toMatchObject({ finished: true })
      expect(f.calls.finishes[0].input.status).toBe(phase === 'admitted-cancel' ? 'cancelled' : 'completed')
    } finally { await f.close() }
  })
}
for (const phase of ['error-then-abort', 'guard-withdrawal'] as const) {
  test(`non-cancellation pre-dispatch errors retain their original error: ${phase}`, async () => {
    const f = await fixture(phase)
    try {
      expect(f.outcome).toEqual({ errorCode: phase === 'error-then-abort' ? 'host_auth_failed' : 'host_failed' })
      expect(f.record).toMatchObject({ state: 'settled', requiredReceipt: false })
      expect(f.calls.admissions).toBe(0); expect(f.calls.providers).toBe(0); expect(f.calls.receipts).toHaveLength(0)
      expect(await f.cleanup()).toMatchObject({ finished: true })
      expect(f.calls.finishes[0].input.status).toBe('failed')
    } finally { await f.close() }
  })
}
