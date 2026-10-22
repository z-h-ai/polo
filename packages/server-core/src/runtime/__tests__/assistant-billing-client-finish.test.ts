import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AdminClient } from '@polo-ai/shared/admin'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { AssistantBillingCoordinator } from '../assistant-billing'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
for (const outcome of ['no_charge', 'pending', 'lost', 'mismatch', 'malformed'] as const) {
  test(`actual AdminClient finish normalization preserves unused intent contract: ${outcome}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assistant-real-client-finish-'))
    try {
      const scope: AssistantBillingJournalScope = { subjectKind: 'polo_assistant', accountId: randomUUID(), productSpaceId: randomUUID(), adminOrigin: 'https://admin.owned.invalid' }
      const outbox = new BillingOutbox<AssistantBillingJournalScope>(dir)
      const client = new AdminClient(scope.adminOrigin)
      const calls: string[] = []
      let runId = '', finishResult: unknown
      globalThis.fetch = (async (url, init) => {
        const path = new URL(String(url)).pathname
        const input = JSON.parse(String(init?.body ?? '{}'))
        calls.push(`${init?.method} ${path}`)
        let body: unknown, status = 200
        if (path === '/api/billing/runs' && init?.method === 'POST') {
          runId = input.runId
          body = { run: { runId, status: 'running' }, idempotent: false }
        } else if (path === `/api/billing/runs/${runId}/requests`) {
          status = 500
          body = { error: { code: 'SERVER_ERROR', message: 'Controlled admission failure' } }
        } else if (path === `/api/billing/runs/${runId}` && init?.method === 'PATCH') {
          expect(input).toEqual({ status: 'failed' })
          if (outcome === 'lost') throw new Error('Controlled lost finish response')
          body = outcome === 'malformed' ? { settlement: 'no_charge' } : {
            run: { runId: outcome === 'mismatch' ? randomUUID() : runId, status: 'failed' },
            idempotent: false, settlement: outcome === 'pending' ? 'pending' : 'no_charge',
          }
        } else throw new Error(`Unexpected request ${path}`)
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      const coordinator = new AssistantBillingCoordinator(outbox, () => ({
        start: async (_scope, input) => client.startAssistantRun('controlled-token', input),
        admit: async (_scope, originalRun, input) => client.admitAppRequest('controlled-token', originalRun, input),
        finish: async (original, originalRun, input) => {
          expect(original).toEqual(scope); expect(originalRun).toBe(runId)
          finishResult = await client.finishAppRun('controlled-token', originalRun, input)
          return finishResult
        },
        report: async () => { throw new Error('Provider must never have been called') },
        inspect: async () => { throw new Error('404 cannot authorize retirement') },
      }))
      await expect(coordinator.hooks(scope, () => true).beforeSend({ model: 'owned-model', hostRequestId: `host-${randomUUID()}`, transportBaseUrl: 'https://provider.owned.invalid/v1', credentialFingerprint: 'a'.repeat(64) })).rejects.toThrow()
      expect(calls).toHaveLength(3)
      if (outcome === 'no_charge' || outcome === 'pending') {
        expect(finishResult).toEqual({ runId, status: 'failed', settlement: outcome })
      }
      expect(outbox.entries(scope.accountId, scope.adminOrigin)).toHaveLength(outcome === 'no_charge' ? 0 : 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
