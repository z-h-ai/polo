import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppBillingOutbox } from '../app-billing-outbox'
const dirs:string[]=[]
function folder(){const d=mkdtempSync(join(tmpdir(),'app-billing-journal-'));dirs.push(d);return d}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
const space=crypto.randomUUID(),runId=crypto.randomUUID(),requestId=crypto.randomUUID()
const scope={accountId:'account-a',adminOrigin:'https://admin.example.com',productSpaceId:space,artifactInstanceId:crypto.randomUUID(),artifactVersionId:crypto.randomUUID()}
const admission={productSpaceId:space,requestId,model:'meter-model',hostRequestId:`host-${crypto.randomUUID()}`,transportBaseUrl:'https://api.example.com/v1/',credentialFingerprint:'a'.repeat(64)}
const receipt={productSpaceId:space,runId,requestId,inputTokens:4,outputTokens:2,outputDisposition:'usable' as const,actualModel:'meter-model',providerObservation:{version:1 as const,state:'observed' as const,providerRequestId:'real-provider-1',responseStatus:200}}
describe('durable App billing metadata outbox',()=>{
 it('persists admission before provider execution and restores original content-free identity',()=>{const d=folder(),outbox=new AppBillingOutbox(d);outbox.stageAdmission(scope,runId,admission);const loaded=new AppBillingOutbox(d).entries('account-a',scope.adminOrigin);expect(loaded).toHaveLength(1);expect(loaded[0]).toMatchObject({phase:'admission',scope,runId,admission});expect(new AppBillingOutbox(d).entries('account-b',scope.adminOrigin)).toHaveLength(0);expect(new AppBillingOutbox(d).entries('account-a','https://other.example.com')).toHaveLength(0)})
 it('keeps pending terminal receipt across restart, then removes only confirmed/no_charge facts',()=>{const d=folder(),outbox=new AppBillingOutbox(d);const key=outbox.stageAdmission(scope,runId,admission);outbox.stageReceipt(scope,receipt);outbox.applySettlement(key,'pending');const restored=new AppBillingOutbox(d);expect(restored.entries('account-a',scope.adminOrigin)[0]).toMatchObject({phase:'receipt',receipt});restored.applySettlement(key,'confirmed');expect(new AppBillingOutbox(d).entries('account-a',scope.adminOrigin)).toHaveLength(0)})
 it('rejects mutation of an original request and sensitive unknown fields without overwriting it',()=>{const d=folder(),outbox=new AppBillingOutbox(d);outbox.stageAdmission(scope,runId,admission);expect(()=>outbox.stageAdmission(scope,runId,{...admission,model:'swapped'})).toThrow();expect(()=>outbox.stageReceipt(scope,{...receipt,prompt:'SECRET-PROMPT',providerLease:{apiKey:'SECRET-KEY'}})).toThrow();const files=readdirSync(d);expect(files).toHaveLength(1);const contents=readFileSync(join(d,files[0]!),'utf8');expect(contents).not.toContain('SECRET');expect(contents).not.toContain('swapped')})
 it('quarantines conflicting receipts and never replays them',()=>{const d=folder(),outbox=new AppBillingOutbox(d);const key=outbox.stageAdmission(scope,runId,admission);outbox.stageReceipt(scope,receipt);expect(()=>outbox.stageReceipt(scope,{...receipt,inputTokens:99})).toThrow();outbox.markConflict(key);expect(new AppBillingOutbox(d).entries('account-a',scope.adminOrigin)).toHaveLength(0);expect(readdirSync(d)).toHaveLength(1)})
})
