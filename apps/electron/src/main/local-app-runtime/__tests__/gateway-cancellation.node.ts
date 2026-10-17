/**
 * Actual Node HTTP regression (Bun's HTTP event ordering is not equivalent):
 * bun run esbuild apps/electron/src/main/local-app-runtime/__tests__/gateway-cancellation.node.ts --bundle --platform=node --format=cjs --outfile=.tmp/gateway-cancellation.cjs
 * node --test .tmp/gateway-cancellation.cjs
 * All gateways use owned ephemeral ports; executor/Admin are offline fixtures.
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { request, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AppApiGateway, type AppApiGatewayDelegate } from '../app-api-gateway'
import type { CapabilityRecord } from '../app-api-capabilities'
import { LocalAppRuntimeCoordinator } from '../runtime-coordinator'
import { AppBillingOutbox } from '../app-billing-outbox'
import type { AppApiRunState } from '../app-api-run-state'

assert.equal(process.versions.bun, undefined, 'run this regression with actual Node')

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1500
  while (!check()) {
    assert.ok(Date.now() < deadline, 'bounded condition deadline')
    await delay(5)
  }
}
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('delegate entry deadline')), 1500)
    })])
  } finally { clearTimeout(timer) }
}
const token = 'offline-fixture-capability'
const payload = () => ({ runId: crypto.randomUUID(), requestId: crypto.randomUUID(), prompt: 'offline', maxOutputTokens: 16, timeoutMs: 2000 })
function post(url: string, body: unknown, bearer = token, complete = true) {
  const bytes = JSON.stringify(body)
  let client!: ReturnType<typeof request>
  const received = new Promise<{ status?: number; body?: Record<string, any>; error?: string }>(resolve => {
    client = request(url, { method: 'POST', agent: false, headers: {
      Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes),
    } }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
      response.on('error', error => resolve({ error: error.message }))
    })
    client.on('error', error => resolve({ error: error.message }))
    if (complete) client.end(bytes)
    else client.write(bytes.slice(0, 10))
  })
  return { client, received }
}
interface Observation { response: ServerResponse; prematureClose: boolean; writesAfterClose: number }
function observe(server: Server) {
  const observations: Observation[] = []
  server.on('request', (_request, response) => {
    const observation = { response, prematureClose: false, writesAfterClose: 0 }
    observations.push(observation)
    response.on('close', () => { observation.prematureClose = !response.writableEnded })
    const original = response.end
    response.end = function (this: ServerResponse, ...args: Parameters<typeof original>) {
      if (observation.prematureClose) observation.writesAfterClose++
      return original.apply(this, args)
    } as typeof original
  })
  return observations
}
async function transport(t: TestContext, handle: AppApiGatewayDelegate['handle']) {
  const releases: Array<() => void> = []
  const gateway = new AppApiGateway({
    delegate: { handle },
    verifyToken: value => value === token ? { capabilityGeneration: 1, identityKey: 'offline' } as CapabilityRecord : null,
  })
  await gateway.start()
  const server = (gateway as unknown as { server: Server }).server
  const observations = observe(server)
  const clients: ReturnType<typeof request>[] = []
  t.after(async () => { releases.forEach(release => release()); clients.forEach(client => client.destroy()); await gateway.close() })
  return { server, observations, releases, post(body = payload(), bearer = token, complete = true) {
    const result = post(gateway.url + '/ai/query', body, bearer, complete)
    clients.push(result.client)
    return result
  } }
}
for (const deferred of [false, true]) {
  test(`connected ${deferred ? 'delayed' : 'immediate'} response never aborts`, { timeout: 4000 }, async t => {
    let signal!: AbortSignal
    const entered = gate(), release = gate()
    const f = await transport(t, async (_route, _body, _capability, incoming) => {
      signal = incoming; entered.release()
      if (deferred) await release.promise
      return { data: { status: 'completed' } }
    })
    f.releases.push(release.release)
    const pending = f.post()
    await bounded(entered.promise)
    if (deferred) { await delay(25); assert.equal(signal.aborted, false); release.release() }
    assert.equal((await pending.received).status, 200)
    await until(() => f.observations[0]!.response.destroyed)
    assert.equal(signal.aborted, false)
    assert.equal(f.observations[0]!.response.listenerCount('close'), 1, 'only observation listener remains')
  })
}
test('invalid capability is 401 with zero delegate entries', { timeout: 4000 }, async t => {
  let calls = 0
  const f = await transport(t, async () => { calls++; return {} })
  assert.equal((await f.post(payload(), 'invalid').received).status, 401)
  assert.equal(calls, 0)
  assert.equal(f.observations[0]!.response.listenerCount('close'), 1)
})
for (const rejectLate of [false, true]) {
  test(`entered query disconnect aborts once; late ${rejectLate ? 'reject' : 'resolve'} writes nothing`, { timeout: 4000 }, async t => {
    const entered = gate(), release = gate()
    let signal!: AbortSignal, aborts = 0
    const f = await transport(t, async (_route, _body, _capability, incoming) => {
      signal = incoming; signal.addEventListener('abort', () => { aborts++ }); entered.release()
      await release.promise
      if (rejectLate) throw new Error('offline late rejection')
      return { data: { status: 'completed' } }
    })
    f.releases.push(release.release)
    const pending = f.post()
    await bounded(entered.promise)
    assert.equal(signal.aborted, false)
    pending.client.destroy()
    await until(() => signal.aborted)
    assert.equal(aborts, 1)
    release.release()
    await until(() => f.observations[0]!.response.listenerCount('close') === 1)
    await delay(15)
    assert.equal(f.observations[0]!.writesAfterClose, 0)
    assert.equal(f.observations[0]!.response.writableEnded, false)
    assert.equal((await pending.received).status, undefined)
  })
}
test('same capability concurrent A disconnect does not abort B', { timeout: 4000 }, async t => {
  const signals = new Map<string, AbortSignal>(), release = gate()
  const f = await transport(t, async (_route, body, _capability, signal) => {
    signals.set(body.requestId as string, signal)
    await release.promise
    return { data: { requestId: body.requestId } }
  })
  f.releases.push(release.release)
  const a = payload(), b = payload(), ca = f.post(a), cb = f.post(b)
  await until(() => signals.size === 2)
  ca.client.destroy()
  await until(() => signals.get(a.requestId)!.aborted)
  assert.equal(signals.get(b.requestId)!.aborted, false)
  release.release()
  assert.equal((await cb.received).status, 200)
  assert.equal(signals.get(b.requestId)!.aborted, false)
  await until(() => f.observations.every(o => o.response.listenerCount('close') === 1))
})
test('body end / dispatch race fences already destroyed response before close event', { timeout: 4000 }, async t => {
  let calls = 0
  const f = await transport(t, async () => { calls++; return {} })
  // Real Node body end resolves readBody; this listener destroys the actual
  // response before its awaiting continuation runs, ahead of response.close.
  f.server.on('request', (incoming, response) => incoming.once('end', () => response.destroy()))
  const pending = f.post()
  await pending.received
  await until(() => f.observations[0]!.response.listenerCount('close') === 1)
  assert.equal(calls, 0)
  assert.equal(f.observations[0]!.writesAfterClose, 0)
})
test('incomplete body disconnect settles and removes its response listener', { timeout: 4000 }, async t => {
  let calls = 0
  const f = await transport(t, async () => { calls++; return {} })
  const pending = f.post(payload(), token, false)
  await until(() => f.observations.length === 1)
  pending.client.destroy()
  await until(() => f.observations[0]!.response.destroyed && f.observations[0]!.response.listenerCount('close') === 1)
  assert.equal(calls, 0)
  assert.equal(f.observations[0]!.writesAfterClose, 0)
})
test('connected delegate rejection returns stable 502 and removes listener', { timeout: 4000 }, async t => {
  const f = await transport(t, async () => { throw new Error('offline rejection') })
  const received = await f.post().received
  assert.equal(received.status, 502)
  assert.equal(received.body?.error.code, 'host_failed')
  assert.equal(f.observations[0]!.response.listenerCount('close'), 1)
})

for (const phase of ['before-dispatch', 'unknown-admission', 'dispatched-cancelled', 'late-success'] as const) {
  test(`actual gateway to coordinator cancellation/settlement: ${phase}`, { timeout: 5000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-cancel-'))
    const outbox = new AppBillingOutbox(dir), entered = gate(), release = gate()
    const facts = { model: 'offline-model', hostRequestId: `host-${crypto.randomUUID()}`, transportBaseUrl: 'https://offline.invalid/v1', credentialFingerprint: 'a'.repeat(64) }
    const cancelled = { status: 'cancelled' as const, model: facts.model, requestId: facts.hostRequestId, error: { code: 'cancelled' as const, reason: 'caller_aborted' as const, message: 'Offline cancellation' } }
    const calls = { admissions: 0, simulatedDispatches: 0, receipts: [] as unknown[], finishes: [] as unknown[], disposed: 0 }
    let signal: AbortSignal | undefined, admissionSignal: AbortSignal | undefined
    const coordinator = new LocalAppRuntimeCoordinator({
      billingOutbox: outbox, getAdminOrigin: () => 'https://offline.invalid',
      admin: {
        startAppRun: async () => ({}),
        admitAppRequest: async (_runId, body, options) => {
          calls.admissions++; admissionSignal = options?.signal
          if (phase === 'unknown-admission') { entered.release(); await release.promise; throw new Error('Offline lost acknowledgement') }
          return { request: { requestId: body.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false }
        },
        recordAppUsage: async body => { calls.receipts.push(body); return { settlement: 'pending' } },
        finishAppRun: async (_runId, body, options) => { calls.finishes.push({ body, aborted: options?.signal?.aborted }); return { settlement: 'pending' } },
      },
      createExecutor: ({ beforeSend }) => ({
        execute: async input => {
          signal = input.signal
          if (phase === 'before-dispatch') { entered.release(); await release.promise }
          try { await beforeSend!(facts) } catch { return cancelled }
          calls.simulatedDispatches++ // No HTTP/provider exists behind this fixture.
          entered.release(); await release.promise
          if (phase !== 'late-success') return cancelled
          return { status: 'completed', model: facts.model, requestId: facts.hostRequestId, provider: 'offline', text: 'late controlled output', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, reportedModel: facts.model } }
        },
        dispose: async () => { calls.disposed++ },
      }),
      resolveWorkspaceRoot: () => dir,
      loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: 'offline', model: facts.model } }),
      getDefaultLlmConnection: () => null,
    })
    const clients: ReturnType<typeof request>[] = []
    t.after(async () => { release.release(); clients.forEach(client => client.destroy()); await coordinator.shutdown(); rmSync(dir, { recursive: true, force: true }) })
    const url = await coordinator.ensureGateway()
    const identity = { accountId: 'offline', productSpaceId: crypto.randomUUID(), artifactInstanceId: crypto.randomUUID(), versionId: crypto.randomUUID(), version: '1.0.0' }
    const runtime = { identity, workspaceId: 'offline', executionId: 'offline', runtimeKind: 'python' as const, runtimeGeneration: 1, scopeGeneration: 1 }
    const signing = coordinator.signCapability(runtime)
    coordinator.registerActiveRuntime({ ...runtime, capabilityGeneration: signing.capabilityGeneration })
    const gateway = (coordinator as unknown as { gateway: { server: Server } }).gateway
    const observations = observe(gateway.server)
    const query = payload()
    assert.equal((await post(url + '/run/start', { runId: query.runId }, signing.token).received).status, 200)
    const pending = post(url + '/ai/query', query, signing.token)
    clients.push(pending.client)
    await bounded(entered.promise)
    assert.equal(signal?.aborted, false)
    pending.client.destroy()
    await until(() => signal?.aborted === true)
    if (phase === 'unknown-admission') assert.equal(admissionSignal?.aborted, true)
    release.release()
    await until(() => observations[1]!.response.listenerCount('close') === 1)
    assert.equal(calls.disposed, 1)
    assert.equal(observations[1]!.writesAfterClose, 0)
    assert.equal(observations[1]!.response.writableEnded, false)
    assert.equal(calls.admissions, phase === 'before-dispatch' ? 0 : 1)
    assert.equal(calls.simulatedDispatches, phase === 'before-dispatch' || phase === 'unknown-admission' ? 0 : 1)
    assert.equal(calls.receipts.length, calls.simulatedDispatches)
    const record = (coordinator as unknown as { runState: AppApiRunState }).runState.getQuery(signing.capabilityGeneration, query.runId, query.requestId)!
    assert.ok(record)
    if (phase === 'late-success') assert.equal(record.outcome?.kind, 'success', 'preserve actual Host terminal for accounting')
    else assert.deepEqual(record.outcome, { kind: 'error', code: phase === 'unknown-admission' ? 'metering_unconfirmed' : 'request_cancelled', ...(phase === 'dispatched-cancelled' ? { hostRequestId: facts.hostRequestId, actualModel: facts.model, providerObservation: { version: 1, state: 'missing' }, outputDisposition: 'unknown' } : {}) })
    assert.notEqual(record.settlement, 'no_charge')
    assert.notEqual(record.settlement, 'confirmed')
    const entries = outbox.entries('offline', 'https://offline.invalid')
    if (phase === 'unknown-admission') {
      assert.equal(entries[0]?.phase, 'admission', 'unknown acknowledgement remains durable')
      const replay = await post(url + '/ai/query', query, signing.token).received
      assert.equal(replay.body?.error.code, 'metering_unconfirmed')
      assert.equal(calls.admissions, 1, 'no paid replay')
    } else if (phase !== 'before-dispatch') {
      assert.equal(entries.length, 1, 'pending receipt remains durable')
      assert.equal(entries[0]?.phase, 'receipt')
      assertPartialReceipt(calls.receipts[0], query)
    } else assert.equal(entries.length, 0)
    // A separate connected finish uses original settlement authority and cleanup.
    const finished = await post(url + '/run/finish', { runId: query.runId, status: 'cancelled' }, signing.token).received
    // Finishing the run and confirming its financial settlement are separate:
    // the existing coordinator permits a successful finish with pending billing.
    assert.equal(finished.status, 200)
    assert.equal(finished.body?.data?.settlement, 'pending')
    assert.equal(calls.finishes.length, 1)
    assert.equal(outbox.entries('offline', 'https://offline.invalid').length, entries.length, 'pending finish retains recovery metadata')
    assert.notEqual(finished.body?.data?.settlement, 'no_charge')
    assert.notEqual(finished.body?.data?.settlement, 'confirmed')
    assert.ok(calls.finishes.every(value => !(value as { aborted?: boolean }).aborted))
    assert.equal((await pending.received).status, undefined)
  })
}
function assertPartialReceipt(value: unknown, query: ReturnType<typeof payload>) {
  assert.equal((value as { runId: string }).runId, query.runId)
  assert.equal((value as { requestId: string }).requestId, query.requestId)
  assert.equal((value as { actualModel: string }).actualModel, 'offline-model')
  return value
}
