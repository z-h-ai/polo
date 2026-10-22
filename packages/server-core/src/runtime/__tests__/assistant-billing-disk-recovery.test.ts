import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { AssistantBillingCoordinator } from '../assistant-billing'

test('temporary receipt write failure retains the original final usage for recovery without another model request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'polo-billing-disk-'))
  try {
    const scope: AssistantBillingJournalScope = { subjectKind: 'polo_assistant', accountId: randomUUID(), productSpaceId: randomUUID(), adminOrigin: 'https://admin.example' }
    const outbox = new BillingOutbox<AssistantBillingJournalScope>(directory)
    let fail = true, starts = 0; const reported: any[] = []
    const stage = outbox.stageReceipt.bind(outbox)
    outbox.stageReceipt = (s, input) => { if (fail) throw new Error('ENOSPC'); return stage(s, input) }
    const coordinator = new AssistantBillingCoordinator(outbox, () => ({
      start: async () => { starts++ }, admit: async (_, __, input) => ({ request: { requestId: input.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: 'a'.repeat(32) } }, idempotent: false }),
      report: async (_, input) => { reported.push(input); return { settlement: 'confirmed' } }, inspect: async () => ({ settlement: 'pending' }), finish: async () => {},
    }))
    const lease = await coordinator.hooks(scope, () => true).beforeSend({ model: 'deepseek-chat', hostRequestId: `host-${randomUUID()}`, transportBaseUrl: 'https://provider.example/v1', credentialFingerprint: 'a'.repeat(64) })
    const result = { inputTokens: 12, outputTokens: 4, provenance: 'provider_final' as const, outputDisposition: 'usable' as const, actualModel: 'deepseek-chat', providerObservation: { version: 1 as const, state: 'observed' as const, providerRequestId: 'original-request', responseStatus: 200 } }
    await expect(lease.complete(result)).rejects.toThrow('ENOSPC')
    fail = false; await coordinator.recover(scope.accountId, scope.adminOrigin)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject(result)
    expect(starts).toBe(1)
    expect(outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
