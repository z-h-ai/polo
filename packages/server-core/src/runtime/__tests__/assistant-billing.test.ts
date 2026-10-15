import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BillingOutbox, type AssistantBillingJournalScope } from '../../../../shared/src/admin/billing-outbox'
import { AssistantBillingCoordinator, type AssistantBillingTransport } from '../assistant-billing'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
const scope: AssistantBillingJournalScope = { subjectKind: 'polo_assistant', accountId: randomUUID(), productSpaceId: randomUUID(), adminOrigin: 'https://admin.example' }
const facts = { model: 'deepseek-chat', hostRequestId: `host-${randomUUID()}`, transportBaseUrl: 'https://provider.example/v1', credentialFingerprint: 'b'.repeat(64) }
const result = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, provenance: 'provider_final' as const, outputDisposition: 'usable' as const, actualModel: 'deepseek-chat', providerObservation: { version: 1 as const, state: 'observed' as const, providerRequestId: 'provider-request', responseStatus: 200 } }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'polo-assistant-billing-')); dirs.push(dir)
  const events: any[] = []
  let unavailable = false, currentAccount = scope.accountId
  const transport: AssistantBillingTransport = {
    async start(s, input) { expect(s).toEqual(scope); events.push(['start', input]) },
    async admit(s, runId, input) { expect(s).toEqual(scope); events.push(['admit', runId, input]); return { request: { requestId: input.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false } },
    async report(s, input) {
      if (s.accountId !== currentAccount || unavailable) throw new Error('Original session unavailable')
      events.push(['report', s, input]); return { settlement: 'confirmed' }
    },
    async inspect() { return { settlement: 'pending' } },
    async finish(s, runId, input) { events.push(['finish', s, runId, input]) },
  }
  const outbox = new BillingOutbox<AssistantBillingJournalScope>(dir)
  return { dir, events, transport, outbox, coordinator: new AssistantBillingCoordinator(outbox, () => transport), setUnavailable(v: boolean) { unavailable = v }, setAccount(v: string) { currentAccount = v } }
}
test('assistant scope is durable without fictitious App identity; successful original receipt is retired', async () => {
  const f = setup(), hook = f.coordinator.hooks(scope, () => true)
  const lease = await hook.beforeSend(facts)
  const before = f.outbox.entries(scope.accountId, scope.adminOrigin)
  expect(before).toHaveLength(1); expect(before[0]!.scope).toEqual(scope)
  expect(f.events[0][1]).toMatchObject({ subjectKind: 'polo_assistant', productSpaceId: scope.productSpaceId })
  expect(f.events[0][1]).not.toHaveProperty('artifactInstanceId')
  await lease.complete(result)
  expect(f.outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(0)
  const report = f.events.find(e => e[0] === 'report')[2]
  expect(report).toMatchObject({ ...result, productSpaceId: scope.productSpaceId, runId: before[0]!.runId, requestId: before[0]!.admission.requestId })
})
test('offline receipt survives restart and replays original identities only, never model execution', async () => {
  const f = setup(), lease = await f.coordinator.hooks(scope, () => true).beforeSend(facts)
  f.setUnavailable(true); await lease.complete(result)
  const saved = f.outbox.entries(scope.accountId, scope.adminOrigin)[0]!
  expect(saved.phase).toBe('receipt')
  expect(readFileSync(join(f.dir, readdirSync(f.dir)[0]!), 'utf8')).not.toContain('nonce')
  f.setUnavailable(false)
  const restarted = new AssistantBillingCoordinator(new BillingOutbox<AssistantBillingJournalScope>(f.dir), () => f.transport)
  await restarted.recover(randomUUID(), scope.adminOrigin)
  expect(f.outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(1)
  await restarted.recover(scope.accountId, 'https://other.example')
  expect(f.outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(1)
  await restarted.recover(scope.accountId, scope.adminOrigin)
  expect(f.outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(0)
  expect(f.events.filter(e => e[0] === 'start')).toHaveLength(1)
  expect(f.events.filter(e => e[0] === 'admit')).toHaveLength(1)
})
test('account switch keeps receipt queued for original account; space switch never changes original receipt', async () => {
  const f = setup(); let current = true
  const lease = await f.coordinator.hooks(scope, () => current).beforeSend(facts)
  current = false; f.setAccount(randomUUID())
  expect(() => lease.assertCurrent()).toThrow()
  await lease.complete(result)
  expect(f.outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(1)
  f.setAccount(scope.accountId); await f.coordinator.recover(scope.accountId, scope.adminOrigin)
  expect(f.events.find(e => e[0] === 'report')[1]).toEqual(scope)
})
test('stale scope cannot even start admission', async () => {
  const f = setup()
  await expect(f.coordinator.hooks(scope, () => false).beforeSend(facts)).rejects.toThrow()
  expect(f.events).toHaveLength(0)
})
