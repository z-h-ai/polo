import { expect, test } from 'bun:test'
import { build, stop } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Exercise Electron's Node HTTP cancellation, not Bun's different response-close
// emulation. All remote endpoints, tokens and journals here are owned fixtures.
test('actual assistant admission HTTP respects the canonical deadline, cancellation and recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'polo-assistant-admission-http-'))
  try {
    const imports = {
      AdminClient: '../../../../shared/src/admin/client.ts',
      BillingOutbox: '../../../../shared/src/admin/billing-outbox.ts',
      AssistantBillingCoordinator: '../assistant-billing.ts',
      createAssistantBillingTransport: '../assistant-billing-transport.ts',
      startInvocationCredentialProxy: '../../../../shared/src/credentials/invocation-credential-proxy.ts',
    }
    const contents = Object.entries(imports).map(([name, path]) => `export { ${name} } from ${JSON.stringify(join(import.meta.dir, path))}`).join('\n')
    const entry = join(dir, 'entry.ts')
    writeFileSync(entry, contents)
    await build({ entryPoints: [entry], platform: 'node', bundle: true, format: 'cjs', outfile: join(dir, 'modules.cjs'), logLevel: 'silent', external: ['koffi', 'electron', 'sharp'], plugins: [{ name: 'real-leaf-exports', setup(builder) {
      // Exact barrel aliases avoid unrelated native keychain side effects.
      builder.onResolve({ filter: /^@polo-ai\/shared\/admin$/ }, () => ({ path: join(import.meta.dir, '../../../../shared/src/admin/types.ts') }))
      builder.onResolve({ filter: /^@polo-ai\/shared\/config$/ }, () => ({ path: join(import.meta.dir, '../../../../shared/src/config/paths.ts') }))
    } }] })
    stop()
    const child = spawnSync('node', ['-e', NODE_FIXTURE], { cwd: dir, encoding: 'utf8', timeout: 25000, env: { ...process.env, POLO_AI_CONFIG_DIR: join(dir, 'config'), NODE_PATH: join(import.meta.dir, '../../../../../node_modules') } })
    // The child reports all independent checks before exiting, including red.
    console.log(child.stdout.trim())
    if (child.stderr) console.error(child.stderr.trim())
    expect(child.error).toBeUndefined()
    const result = JSON.parse(child.stdout.trim()) as { checks: Record<string, boolean> }
    for (const [name, passed] of Object.entries(result.checks)) expect(passed, name).toBe(true)
    expect(child.status).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30000)

const NODE_FIXTURE = String.raw`
const {createServer}=require('node:http');
const {mkdtempSync,rmSync,readdirSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join}=require('node:path');const {randomUUID}=require('node:crypto');
const {AdminClient,BillingOutbox,AssistantBillingCoordinator,createAssistantBillingTransport,startInvocationCredentialProxy}=require('./modules.cjs');
const checks={};const timers=new Set();const sleep=ms=>new Promise(r=>{const t=setTimeout(()=>{timers.delete(t);r()},ms);timers.add(t)});
const json=(res,status,body)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))}};
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections()});
(async()=>{
 let admin,provider,proxy;const dir=mkdtempSync(join(tmpdir(),'polo-admission-node-journal-'));
 try{
  let delay=5500,admissions=0,models=0,finishes=0,inspectState='pending',reportState='confirmed',finishConflict=false,finishCode='run_finalized',current=true,contextOnWire=false;
  let admissionEntered;let entered=new Promise(r=>admissionEntered=r);
  admin=createServer(async(req,res)=>{
   let text='';for await(const b of req)text+=b;const input=text?JSON.parse(text):{};const path=req.url;
   if(req.method==='POST'&&path==='/api/billing/runs')return json(res,201,{run:{runId:input.runId,status:'running'},idempotent:false});
   if(req.method==='POST'&&path.endsWith('/requests')){admissions++;contextOnWire ||= 'signal' in input || 'context' in input;admissionEntered();await sleep(delay);return json(res,201,{request:{requestId:input.requestId,state:'admitted',providerCorrelation:{header:'X-Polo-Request-Id',nonce:'a'.repeat(32)}},idempotent:false})}
   if(req.method==='POST'&&path==='/api/billing/usage')return json(res,200,{receipt:reportState==='pending'?null:{requestId:input.requestId},request:{requestId:input.requestId},recorded:true,idempotent:false,settlement:reportState});
   if(req.method==='GET'){if(inspectState==='missing')return json(res,404,{errorCode:'not_found'});return json(res,200,{request:{requestId:path.split('/').at(-1),state:inspectState},settlement:inspectState})}
   if(req.method==='PATCH'){finishes++;if(finishConflict)return json(res,finishCode==='SERVER_ERROR'?500:409,{errorCode:finishCode});return json(res,200,{run:{runId:path.split('/').at(-1),status:input.status},settlement:input.status==='completed'?'confirmed':'no_charge',idempotent:false})}
   json(res,500,{errorCode:'fixture_unexpected'});
  });await listen(admin);const origin='http://127.0.0.1:'+admin.address().port;
  provider=createServer(async(req,res)=>{for await(const _ of req){};models++;res.setHeader('x-oneapi-request-id','fixture-only');json(res,200,{model:'fixture-model',choices:[{message:{role:'assistant',content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:1}})});await listen(provider);
  const client=new AdminClient(origin);const scope={subjectKind:'polo_assistant',accountId:randomUUID(),productSpaceId:randomUUID(),adminOrigin:origin};
  const outbox=new BillingOutbox(dir);const transport=createAssistantBillingTransport(async original=>{if(original.accountId!==scope.accountId||original.adminOrigin!==origin)throw Error('wrong original scope');return {client,accessToken:'fixture-token'}});
  const coordinator=new AssistantBillingCoordinator(outbox,()=>transport);
  const facts={model:'fixture-model',hostRequestId:'host-'+randomUUID(),transportBaseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',credentialFingerprint:'a'.repeat(64)};
  proxy=await startInvocationCredentialProxy({upstreamBaseUrl:facts.transportBaseUrl,credential:'fixture-key',credentialHeaders:[{name:'authorization',format:'bearer'}]},{billing:coordinator.hooks(scope,()=>current)});
  const response=await fetch(proxy.url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+proxy.capability},body:JSON.stringify({model:'fixture-model',messages:[]})});await response.text();
  checks.slow5500UsesExistingAdminDeadline=response.status===200&&models===1&&admissions===1&&outbox.entries(scope.accountId,origin).length===0;
  // A real timeout remains bounded, distinct from explicit user cancellation.
  delay=250;let code;try{await client.admitAppRequest('fixture-token',randomUUID(),{...facts,productSpaceId:scope.productSpaceId,requestId:randomUUID()},{signal:AbortSignal.timeout(30)})}catch(e){code=e.errorCode}
  checks.callerTimeoutClassified=code==='TIMEOUT';
  const shortClient=new AdminClient(origin,{requestTimeoutMs:35});code=undefined;try{await shortClient.admitAppRequest('fixture-token',randomUUID(),{...facts,productSpaceId:scope.productSpaceId,requestId:randomUUID()})}catch(e){code=e.errorCode}
  checks.canonicalTimeoutStillBounded=code==='TIMEOUT';
  const cancelled=new AbortController();cancelled.abort();const before=admissions;let rejected=false;try{await transport.admit(scope,randomUUID(),{...facts,productSpaceId:scope.productSpaceId,requestId:randomUUID()},{signal:cancelled.signal})}catch(e){rejected=true}
  checks.preCancelledDoesNotAdmit=rejected&&admissions===before;
  // Cancellation must abort admission promptly; cleanup retains the original run.
  delay=400;entered=new Promise(r=>admissionEntered=r);const controller=new AbortController();
  const pending=coordinator.hooks(scope,()=>current).beforeSend(facts,{signal:controller.signal});await entered;controller.abort();const at=Date.now();rejected=false;try{await pending}catch(e){rejected=true}
  checks.cancelDuringAdmissionStopsBeforeProvider=rejected&&Date.now()-at<250&&models===1&&outbox.entries(scope.accountId,origin).length===0;
  delay=400;entered=new Promise(r=>admissionEntered=r);const downstream=new AbortController(),beforeFinish=finishes;
  const disconnected=fetch(proxy.url+'/v1/chat/completions',{method:'POST',signal:downstream.signal,headers:{authorization:'Bearer '+proxy.capability},body:JSON.stringify({model:'fixture-model',messages:[]})}).catch(()=>null);await entered;downstream.abort();await disconnected;await sleep(160);
  checks.downstreamCloseCancelsAdmission=finishes===beforeFinish+1&&models===1;
  checks.internalContextNeverOnWire=!contextOnWire;
  // Scope change during the final await must not return a dispatchable lease.
  delay=70;entered=new Promise(r=>admissionEntered=r);const stale=coordinator.hooks(scope,()=>current).beforeSend(facts);await entered;current=false;rejected=false;try{await stale}catch(e){rejected=true}current=true;
  checks.postAdmissionScopeRevalidated=rejected&&models===1;
  // Recovery never sends a model. Canonical terminal request + run_finalized is
  // sufficient; pending, missing and an arbitrary 409 are not settlement proof.
  const modelsBeforeRecovery=models;
  for(const [state,conflict] of [['no_charge','run_finalized'],['confirmed','run_finalized'],['pending','run_finalized'],['missing','run_finalized'],['no_charge','idempotency_conflict'],['no_charge','SERVER_ERROR']]){
   const d=mkdtempSync(join(tmpdir(),'polo-recovery-node-'));try{
    const box=new BillingOutbox(d);box.stageAdmission(scope,randomUUID(),{...facts,requestId:randomUUID(),productSpaceId:scope.productSpaceId});inspectState=state;finishConflict=true;finishCode=conflict;
    const c=new AssistantBillingCoordinator(box,()=>transport);await c.recover(scope.accountId,origin);
    checks['recovery_'+state+'_'+conflict]=readdirSync(d).filter(n=>n.endsWith('.json')).length===(['no_charge','confirmed'].includes(state)&&conflict==='run_finalized'?0:1)&&models===modelsBeforeRecovery;
   }finally{rmSync(d,{recursive:true,force:true})}
  }
  for(const state of ['no_charge','confirmed','pending']){
   const d=mkdtempSync(join(tmpdir(),'polo-receipt-node-'));try{
    const box=new BillingOutbox(d),runId=randomUUID(),requestId=randomUUID();box.stageAdmission(scope,runId,{...facts,requestId,productSpaceId:scope.productSpaceId});box.stageReceipt(scope,{productSpaceId:scope.productSpaceId,runId,requestId,inputTokens:1,outputTokens:1,outputDisposition:'usable',provenance:'provider_final'});inspectState=state;reportState=state;finishConflict=true;finishCode='run_finalized';
    const c=new AssistantBillingCoordinator(box,()=>transport);await c.recover(scope.accountId,origin);
    checks['receiptRecovery_'+state]=box.entries(scope.accountId,origin).length===(state==='pending'?1:0)&&models===modelsBeforeRecovery;
   }finally{rmSync(d,{recursive:true,force:true})}
  }
  // Admission failures surface a safe protocol marker; raw errors stay private.
  const timeoutProxy=await startInvocationCredentialProxy({upstreamBaseUrl:facts.transportBaseUrl,credential:'fixture-key',credentialHeaders:[{name:'authorization',format:'bearer'}]},{billing:{beforeSend:async()=>{throw Object.assign(new Error('private fixture detail'),{errorCode:'TIMEOUT'})}}});
  try{const r=await fetch(timeoutProxy.url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+timeoutProxy.capability},body:JSON.stringify({model:'fixture-model',messages:[]})});const body=await r.text();checks.admissionTimeoutNotGeneric502=r.status===504&&body.includes('POLO_BILLING_ADMISSION_TIMEOUT')&&!body.includes('private fixture detail')}finally{await timeoutProxy.close()}
 }finally{await proxy?.close();if(admin)await close(admin);if(provider)await close(provider);for(const t of timers)clearTimeout(t);timers.clear();rmSync(dir,{recursive:true,force:true})}
 console.log(JSON.stringify({checks,resources:{serversClosed:true,journalsRemoved:true,pendingTimers:timers.size}}));if(Object.values(checks).some(v=>!v))process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1});
`
