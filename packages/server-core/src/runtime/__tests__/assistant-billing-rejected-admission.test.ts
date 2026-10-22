import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AdminError } from '@polo-ai/shared/admin'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { AssistantBillingCoordinator } from '../assistant-billing'

test('a definitive pre-start credit denial does not permanently exhaust the durable queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'polo-admission-denied-'))
  try {
    const scope: AssistantBillingJournalScope = { subjectKind: 'polo_assistant', accountId: randomUUID(), productSpaceId: randomUUID(), adminOrigin: 'https://admin.example' }
    const outbox = new BillingOutbox<AssistantBillingJournalScope>(dir)
    let finishes = 0
    const coordinator = new AssistantBillingCoordinator(outbox, () => ({ start: async () => { throw new AdminError('No credit', 'insufficient_credit', { status: 409 }) }, admit: async () => { throw new Error('must not admit') }, report: async () => { throw new Error('must not bill') }, inspect: async () => { throw new Error('does not exist') }, finish: async () => { finishes++; throw new Error('no run exists') } }))
    await expect(coordinator.hooks(scope, () => true).beforeSend({ model: 'deepseek-chat', hostRequestId: `host-${randomUUID()}`, transportBaseUrl: 'https://provider.example/v1', credentialFingerprint: 'a'.repeat(64) })).rejects.toThrow('No credit')
    expect(outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(0)
    expect(finishes).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
