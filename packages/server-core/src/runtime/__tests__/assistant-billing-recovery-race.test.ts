import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { AssistantBillingCoordinator, type AssistantBillingTransport } from '../assistant-billing'

function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(r => { resolve = r }), resolve: () => resolve() }
}
for (const phase of ['admission-cleanup', 'receipt-settlement'] as const) {
  test(`recovery does not race an in-flight ${phase} for the same immutable run`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'polo-billing-self-race-'))
    const entered = deferred(), release = deferred()
    let inspections = 0, reports = 0, finishes = 0
    try {
      const scope: AssistantBillingJournalScope = { subjectKind: 'polo_assistant', accountId: randomUUID(), productSpaceId: randomUUID(), adminOrigin: 'https://fixture.invalid' }
      const transport: AssistantBillingTransport = {
        start: async () => {},
        admit: async (_scope, _runId, admission) => {
          if (phase === 'admission-cleanup') throw new Error('Controlled admission failure')
          return { request: { requestId: admission.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false }
        },
        report: async () => { reports++; entered.resolve(); await release.promise; return { settlement: 'confirmed' } },
        inspect: async () => { inspections++; return { settlement: 'no_charge' } },
        finish: async (_scope, runId, input) => {
          finishes++
          if (phase === 'admission-cleanup') { entered.resolve(); await release.promise }
          return { runId, status: input.status, settlement: phase === 'admission-cleanup' ? 'no_charge' : 'confirmed' }
        },
      }
      const outbox = new BillingOutbox<AssistantBillingJournalScope>(directory)
      const coordinator = new AssistantBillingCoordinator(outbox, () => transport)
      const ticket = coordinator.hooks(scope, () => true).beforeSend({ model: 'fixture-model', hostRequestId: `host-${randomUUID()}`, transportBaseUrl: 'https://provider.fixture.invalid/v1', credentialFingerprint: 'a'.repeat(64) })
      const operation = phase === 'admission-cleanup' ? ticket.catch(() => {}) : ticket.then(lease => lease.complete({ inputTokens: 1, outputTokens: 1, outputDisposition: 'usable', provenance: 'provider_final' }))
      await entered.promise
      const recovery = coordinator.recover(scope.accountId, scope.adminOrigin)
      // Let recovery reach its first transport await without timing guesses.
      await Promise.resolve(); await Promise.resolve()
      release.resolve()
      await Promise.all([operation, recovery])
      expect(inspections).toBe(0)
      expect(reports).toBe(phase === 'receipt-settlement' ? 1 : 0)
      expect(finishes).toBe(1)
      expect(outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(0)
    } finally { release.resolve(); rmSync(directory, { recursive: true, force: true }) }
  })
}
