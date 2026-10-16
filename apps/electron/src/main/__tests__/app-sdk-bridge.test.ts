import { afterEach, expect, test } from 'bun:test'
import { AdminError } from '@polo-ai/shared/admin'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSdkBridge, sdkLocalOrigin } from '../app-sdk-bridge'
import { LocalAppRuntimeCoordinator } from '../local-app-runtime/runtime-coordinator'
import { AppBillingOutbox } from '../local-app-runtime/app-billing-outbox'
import type { HostLlmPublicResult } from '@polo-ai/shared/agent/host-llm-executor'
import type { ActiveRuntime } from '../local-app-runtime/runtime-coordinator'
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'polo-sdk-test-'))
  let deny = false
  let scope = true, now = Date.now(), hold = false, finishFails = false, pending = false, partial = false
  let entered!: () => void, releaseStart!: () => void
  let startBarrier: Promise<void> | undefined
  const calls: { kind: string; signal?: AbortSignal; abortedAtCall?: boolean; accountId?: string; runId?: string; status?: string }[] = []
  let providers = 0
  const coordinator = new LocalAppRuntimeCoordinator({ now: () => now, isScopeCurrent: async () => scope, billingOutbox: new AppBillingOutbox(dir), getAdminOrigin: () => 'https://sdk.example',
    admin: {
      startAppRun: async (input, options) => { calls.push({ kind: 'start', runId: input.runId, ...options }); if (deny) throw new AdminError('insufficient', 'insufficient_credit'); entered?.(); if (startBarrier) await startBarrier; return {} },
      admitAppRequest: async (_id, input) => { calls.push({ kind: 'admit' }); return { request: { requestId: input.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false } },
      recordAppUsage: async (_input, options) => { calls.push({ kind: 'receipt', ...options }); return { settlement: pending ? 'pending' : 'confirmed' } },
      finishAppRun: async (runId, input, options) => { calls.push({ kind: 'finish', runId, status: input.status, abortedAtCall: options?.signal?.aborted, ...options }); if (finishFails) throw new Error('offline'); return { settlement: pending ? 'pending' : 'confirmed' } },
    }, resolveWorkspaceRoot: () => dir, loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: 'managed' } }), getDefaultLlmConnection: () => 'managed',
    createExecutor: ({ beforeSend }) => ({ execute: async input => {
      await beforeSend?.({ model: 'model', hostRequestId: 'host-' + crypto.randomUUID(), credentialFingerprint: 'a'.repeat(64), transportBaseUrl: 'https://provider.example/v1' })
      providers++
      if (hold) await new Promise<void>(resolve => { if (input.signal?.aborted) resolve(); else input.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      return input.signal?.aborted ? { status: 'cancelled', requestId: 'host-id', model: 'model', error: { code: 'cancelled', reason: 'caller_aborted', message: 'cancelled' } } as HostLlmPublicResult : {
        status: partial ? 'partial' : 'completed', requestId: 'host-id', model: 'model', provider: 'openai', text: 'ORIGINAL_PRIVATE_RESULT', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, reportedModel: 'model', terminalReason: 'stop', provenance: 'provider_final' }, providerObservation: { version: 1, state: 'observed', responseStatus: 200, providerRequestId: 'id' },
      } as HostLlmPublicResult
    }, dispose: async () => {} }),
  })
  await coordinator.ensureGateway()
  const identity = { accountId: crypto.randomUUID(), productSpaceId: crypto.randomUUID(), artifactInstanceId: crypto.randomUUID(), versionId: crypto.randomUUID(), version: '1.0.0' }
  const input = { identity, executionId: 'execution', runtimeGeneration: 1, scopeGeneration: 1, workspaceId: 'workspace', runtimeKind: 'static' as const }
  const generation = coordinator.issueBrowserCapability(input)
  const runtime = coordinator.registerActiveRuntime({ ...input, capabilityGeneration: generation })
  const host = Object.assign(new EventEmitter(), { id: 1 })
  const makeGuest = (id = 2) => {
    const events: unknown[] = []
    const frame = { url: 'http://127.0.0.1:43123/', detached: false, send: (_channel: string, data: unknown) => events.push(data) }
    const guest = Object.assign(new EventEmitter(), { id, mainFrame: frame, hostWebContents: host, getType: () => 'webview', isDestroyed: () => false, isLoadingMainFrame: () => false })
    return { guest, frame, events }
  }
  const bridge = new AppSdkBridge({ coordinator, preloadPath: '/packaged/app-sdk-preload.cjs', workspaceForHost: id => id === 1 ? 'workspace' : null, scopeCurrent: () => scope })
  bridge.registerLaunch(1, runtime, 'http://127.0.0.1:43123/')
  const prefs: any = { preload: '/untrusted.cjs', nodeIntegration: true }
  bridge.prepareGuest(1, 'http://127.0.0.1:43123/', prefs)
  const ticket = prefs.additionalArguments[0].split('=')[1]
  const { guest, frame, events } = makeGuest()
  bridge.attachGuest(host as any, guest as any)
  const invoke = (request: unknown, sender: any = guest, senderFrame: any = frame, nonce: unknown = ticket) => bridge.invoke({ sender, senderFrame }, request, nonce)
  closers.push(async () => { bridge.dispose(); await coordinator.shutdown(); rmSync(dir, { recursive: true, force: true }) })
  return { bridge, coordinator, runtime, prefs, ticket, guest, frame, events, makeGuest, invoke, calls, providers: () => providers,
    deny: () => { deny = true }, setScope: (v: boolean) => { scope = v }, expire: () => { now += 86_400_001 }, hold: () => { hold = true }, pending: () => { pending = true }, partial: () => { partial = true }, failFinish: () => { finishFails = true },
    barrier: () => { startBarrier = new Promise<void>(r => { releaseStart = r }); return new Promise<void>(r => { entered = r }) }, releaseStart: () => { startBarrier = undefined; releaseStart() },
  }
}
const start = (callId = crypto.randomUUID()) => ({ action: 'start', callId, input: { prompt: 'quote', responseFormat: 'text' } })
const wait = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(1) } throw new Error('condition timed out') }
test('only exact loopback origins qualify and Main strips injected preload/preferences', async () => {
  for (const url of ['https://example.com', 'http://localhost:123/', 'http://127.0.0.1/', 'http://x@127.0.0.1:123/', 'file:///a']) expect(sdkLocalOrigin(url)).toBeNull()
  const f = await setup(); expect(f.prefs).toMatchObject({ preload: '/packaged/app-sdk-preload.cjs', nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true, contextIsolation: true, webSecurity: true })
  const other: any = { preload: '/bad' }; f.bridge.prepareGuest(99, f.frame.url, other); expect(other.preload).toBeUndefined()
})
test('plain page, wrong ticket, iframe, sibling and foreign origins cannot start providers', async () => {
  const f = await setup()
  const sibling = f.makeGuest(3); f.bridge.attachGuest(f.guest.hostWebContents as any, sibling.guest as any)
  expect(await f.invoke(start(), f.guest, f.frame, 'wrong')).toMatchObject({ ok: false })
  expect(await f.invoke(start(), f.guest, { ...f.frame })).toMatchObject({ ok: false })
  expect(await f.invoke({ action: 'info' })).toMatchObject({ ok: true })
  expect(await f.invoke(start(), sibling.guest, sibling.frame)).toMatchObject({ ok: false })
  f.frame.url = 'http://127.0.0.1:43124/'
  expect(await f.invoke(start())).toMatchObject({ ok: false }); expect(f.providers()).toBe(0)
})
test('one Main-owned query has one admission/receipt/finish and independent original-identity cleanup', async () => {
  const f = await setup(); const request = start(); const reply = await f.invoke(request) as any
  expect(reply).toMatchObject({ ok: true, data: { text: 'ORIGINAL_PRIVATE_RESULT', settlement: 'confirmed' } })
  expect(f.calls.map(c => c.kind)).toEqual(['start','admit','receipt','finish']); expect(f.providers()).toBe(1)
  expect(f.calls.find(c => c.kind === 'finish')?.abortedAtCall).toBe(false)
  expect(await f.invoke(request)).toMatchObject({ ok: false, error: { code: 'idempotency_conflict' } })
  expect(f.events.map((e: any) => e.phase)).toEqual(['starting','running','settling','completed'])
})
test('partial query and pending settlement remain independent; finish uses existing completed enum', async () => {
  const f = await setup(); f.partial(); f.pending()
  expect(await f.invoke(start())).toMatchObject({ ok: true, data: { status: 'partial', settlement: 'pending' } })
  expect(f.calls.find(c => c.kind === 'finish')?.status).toBe('completed')
})
test('cancel before start authorization returns admits no provider and finishes original run', async () => {
  const f = await setup(), request = start(), entered = f.barrier(); const result = f.invoke(request)
  await entered; expect(await f.invoke({ action: 'cancel', callId: request.callId })).toMatchObject({ ok: true })
  f.releaseStart(); expect(await result).toMatchObject({ ok: false, error: { code: 'request_cancelled' } }); expect(f.providers()).toBe(0)
  expect(f.calls.find(c => c.kind === 'finish')).toMatchObject({ status: 'cancelled', accountId: f.runtime.identity.accountId })
})
test('active cancellation, reload and account/scope loss never deliver old text to a new document', async () => {
  for (const action of ['cancel','reload','scope','close'] as const) {
    const f = await setup(); f.hold(); const request = start(); const result = f.invoke(request)
    await wait(() => f.providers() === 1)
    if (action === 'cancel') await f.invoke({ action: 'cancel', callId: request.callId })
    if (action === 'reload') { f.guest.emit('did-start-navigation', {}, f.frame.url, false, true); f.guest.emit('dom-ready') }
    if (action === 'scope') { f.setScope(false); f.runtime.controller.abort() }
    if (action === 'close') f.guest.emit('destroyed')
    const reply = await result as any; expect(reply.ok).toBe(false); expect(JSON.stringify(reply)).not.toContain('ORIGINAL_PRIVATE_RESULT')
    expect(f.calls.filter(c => c.kind === 'finish')).toHaveLength(1)
    expect(f.calls.find(c => c.kind === 'finish')?.abortedAtCall).toBe(false)
  }
})
test('capability TTL/revocation, stopped runtime and replacement generation reject before provider', async () => {
  for (const action of ['ttl','revoke','replace','scope'] as const) {
    const f = await setup(); await f.invoke({ action: 'info' })
    if (action === 'ttl') f.expire()
    if (action === 'revoke') f.coordinator.capabilities.revoke(f.runtime.capabilityGeneration!)
    if (action === 'replace') f.coordinator.registerActiveRuntime({ ...f.runtime, runtimeGeneration: 2 })
    if (action === 'scope') f.setScope(false)
    expect(await f.invoke(start())).toMatchObject({ ok: false }); expect(f.providers()).toBe(0)
  }
})
test('same-document hash navigation does not cancel; pending finish is unknown and never retries the model', async () => {
  const f = await setup(); await f.invoke({ action: 'info' }); f.guest.emit('did-start-navigation', {}, f.frame.url+'#a', true, true); f.failFinish()
  expect(await f.invoke(start())).toMatchObject({ ok: true, data: { settlement: 'unknown' } }); expect(f.providers()).toBe(1)
})

test('credit rejection and post-authorization scope loss both have zero provider starts', async () => {
  const denied = await setup(); denied.deny()
  expect(await denied.invoke(start())).toMatchObject({ ok: false, error: { code: 'insufficient_credit' } }); expect(denied.providers()).toBe(0)
  const f = await setup(), entered = f.barrier(), result = f.invoke(start()); await entered
  f.setScope(false); f.releaseStart(); expect(await result).toMatchObject({ ok: false }); expect(f.providers()).toBe(0)
})
