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
      globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
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
      }) as unknown as typeof fetch
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


test('late usable observation retires an absorbed unknown run through actual AdminClient without changing its terminal status', async () => {
 const dir=mkdtempSync(join(tmpdir(),'assistant-absorbed-'))
 try {
  const scope:AssistantBillingJournalScope={subjectKind:'polo_assistant',accountId:randomUUID(),productSpaceId:randomUUID(),adminOrigin:'https://admin.owned.invalid'}
  const outbox=new BillingOutbox<AssistantBillingJournalScope>(dir),client=new AdminClient(scope.adminOrigin)
  const runId=randomUUID(),requestId=randomUUID()
  outbox.stageAdmission(scope,runId,{productSpaceId:scope.productSpaceId,requestId,model:'owned-model',hostRequestId:`host-${randomUUID()}`,transportBaseUrl:'https://provider.owned.invalid/v1',credentialFingerprint:'a'.repeat(64)})
  outbox.stageReceipt(scope,{productSpaceId:scope.productSpaceId,runId,requestId,inputTokens:3,outputTokens:2,outputDisposition:'usable',actualModel:'owned-model',provenance:'provider_final'})
  let reports=0,finishes=0
  globalThis.fetch=(async()=>{reports++;return new Response(JSON.stringify({receipt:null,request:{requestId},recorded:true,idempotent:false,settlement:'no_charge',resolution:'platform_absorbed'}),{headers:{'Content-Type':'application/json'}})}) as unknown as typeof fetch
  const coordinator=new AssistantBillingCoordinator(outbox,()=>({
   start:async()=>{throw new Error('No new execution')},admit:async()=>{throw new Error('No new admission')},
   report:async(_scope,receipt)=>client.recordAppUsage('controlled-token',receipt),
   inspect:async()=>{throw new Error('Receipt recovery uses its original report')},
   finish:async()=>{finishes++;throw new Error('Original unknown terminal status cannot change')},
  }))
  await coordinator.recover(scope.accountId,scope.adminOrigin)
  expect(reports).toBe(1);expect(finishes).toBe(0);expect(outbox.entries(scope.accountId,scope.adminOrigin)).toHaveLength(0)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
