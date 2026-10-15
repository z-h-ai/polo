import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AdminError } from '@polo-ai/shared/admin'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { AssistantBillingCoordinator } from '../assistant-billing'

for (const outcome of ['no_charge', 'pending', 'lost', 'mismatch', 'malformed'] as const) {
  test(`unused intent after transient admission failure: finish ${outcome}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assistant-unused-intent-'))
    try {
      const scope: AssistantBillingJournalScope = { subjectKind: 'polo_assistant', accountId: randomUUID(), productSpaceId: randomUUID(), adminOrigin: 'https://admin.owned.invalid' }
      const outbox = new BillingOutbox<AssistantBillingJournalScope>(dir)
      let startedRun = '', finishes = 0
      const coordinator = new AssistantBillingCoordinator(outbox, () => ({
        start: async (_scope, input) => { startedRun = input.runId; return {} },
        admit: async () => { throw new AdminError('Serialization failure', 'internal_error', { status: 500 }) },
        report: async () => { throw new Error('No provider request was sent') },
        inspect: async () => { throw new AdminError('No admission', 'not_found', { status: 404 }) },
        finish: async (original, runId) => {
          expect(original).toEqual(scope); expect(runId).toBe(startedRun); finishes++
          if (outcome === 'lost') throw new Error('Lost finish response')
          if (outcome === 'malformed') return { settlement: 'no_charge' }
          return { run: { runId: outcome === 'mismatch' ? randomUUID() : runId, status: 'failed' }, idempotent: false, settlement: outcome === 'pending' ? 'pending' : 'no_charge' }
        },
      }))
      await expect(coordinator.hooks(scope, () => true).beforeSend({ model: 'owned-model', hostRequestId: `host-${randomUUID()}`, transportBaseUrl: 'https://provider.owned.invalid/v1', credentialFingerprint: 'a'.repeat(64) })).rejects.toThrow('Serialization failure')
      expect(finishes).toBe(1)
      expect(outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(outcome === 'no_charge' ? 0 : 1)
      await coordinator.recover(scope.accountId, scope.adminOrigin)
      expect(outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(outcome === 'no_charge' ? 0 : 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
