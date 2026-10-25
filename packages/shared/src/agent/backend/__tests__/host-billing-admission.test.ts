import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createSessionlessHostLlmExecutor } from '../../host-llm-executor'
import { setInvocationLlmConnections, clearInvocationLlmConnections } from '../../../config/storage'
import { setInvocationCredential, clearInvocationCredentials } from '../../../credentials'

const connection = {slug:'app-billing-admission',name:'Billing',providerType:'pi_compat' as const,authType:'api_key_with_endpoint' as const,baseUrl:'http://127.0.0.1:1/v1/',customEndpoint:{api:'openai-completions' as const},defaultModel:'meter-model',models:['meter-model'],createdAt:1}
function setup() {setInvocationLlmConnections([connection]);setInvocationCredential({type:'llm_api_key',connectionSlug:connection.slug},{value:'ORIGINAL-PRIVATE-KEY'})}
afterEach(() => {clearInvocationLlmConnections();clearInvocationCredentials()})
const input={prompt:'DO-NOT-PERSIST-PROMPT',maxOutputTokens:10,timeoutMs:20000}
describe('App billing pre-send admission fence', () => {
 it('checks an already aborted signal before credential/admission/provider work',async()=>{setup();const c=new AbortController();c.abort();let calls=0;const e=createSessionlessHostLlmExecutor({connectionSlug:connection.slug,serverPath:join(import.meta.dir, '../../../../../pi-agent-server/src/index.ts'),beforeSend:async()=>{calls++}});const r=await e.execute({...input,signal:c.signal});expect(calls).toBe(0);expect(r).toMatchObject({status:'cancelled',error:{reason:'caller_aborted'}});await e.dispose()})
 it('passes only actual connection facts and content-free IDs, and rechecks abort after admission awaits',async()=>{setup();const c=new AbortController();let metadata:unknown;const e=createSessionlessHostLlmExecutor({connectionSlug:connection.slug,serverPath:join(import.meta.dir, '../../../../../pi-agent-server/src/index.ts'),beforeSend:async(facts)=>{metadata=facts;c.abort();return {providerCorrelation:{header:'X-Polo-Request-Id' as const,nonce:crypto.randomUUID().replaceAll('-','')}}}});const r=await e.execute({...input,signal:c.signal});expect(metadata).toMatchObject({model:'meter-model',transportBaseUrl:connection.baseUrl,credentialFingerprint:createHash('sha256').update('ORIGINAL-PRIVATE-KEY').digest('hex')});expect((metadata as {hostRequestId:string}).hostRequestId).toMatch(/^host-[0-9a-f-]{36}$/);expect(JSON.stringify(metadata)).not.toContain('PRIVATE-KEY');expect(JSON.stringify(metadata)).not.toContain(input.prompt);expect(r).toMatchObject({status:'cancelled',error:{reason:'caller_aborted'}});await e.dispose()})
 it('does not send upstream after the original connection changes while admission is pending',async()=>{setup();let calls=0;const e=createSessionlessHostLlmExecutor({connectionSlug:connection.slug,serverPath:join(import.meta.dir, '../../../../../pi-agent-server/src/index.ts'),beforeSend:async()=>{calls++;setInvocationLlmConnections([{...connection,baseUrl:'http://127.0.0.1:2/v1/'}])}});const r=await e.execute(input);expect(calls).toBe(1);expect(r).toMatchObject({error:{code:'connection_changed',reason:'configuration_drift'}});await e.dispose()})
})
