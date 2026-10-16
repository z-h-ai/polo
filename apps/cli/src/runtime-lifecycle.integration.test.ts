import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { processIdentityMatches, getProcessBirthIdentity } from '@polo-ai/shared/utils'

for (const mode of ['SIGINT', 'SIGTERM', 'SIGKILL', 'lease', 'deadline'] as const) {
 test(`real Pi worker and server stop after ${mode}; persistent Thread remains`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-live-owner-'))
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let mainCalls = 0
  const provider = Bun.serve({port:0, async fetch(req) {
   const body = await req.json() as any
   const isMain = !!body.tools?.length
   const chunk = (text: string, finish: string | null = null) => `data: ${JSON.stringify({id:'lifecycle',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:finish}]})}\n\n`
   if (isMain) { mainCalls++; markStarted() }
   return isMain ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(chunk('working'))); } }), {headers:{'content-type':'text/event-stream'}})
    : new Response(chunk('Title','stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  }})
  await writeFile(join(root,'config.json'),JSON.stringify({workspaces:[],defaultLlmConnection:'owned',llmConnections:[{slug:'owned',name:'Own',providerType:'pi',piAuthProvider:'openai',authType:'api_key',baseUrl:`http://127.0.0.1:${provider.port}/v1`,customEndpoint:{api:'openai-completions'},models:['test-model'],defaultModel:'test-model',createdAt:1}]}))
  const args = ['run','--mode','safe','--no-cleanup','--output-format','stream-json','--send-timeout',mode==='deadline'?'3000':'60000','-C',root,'Reply after thinking.']
  const child=Bun.spawn([process.execPath,resolve('apps/cli/src/index.ts'),...args],{env:{...process.env,HOME:root,POLO_AI_CONFIG_DIR:root,LLM_API_KEY:'controlled-key'},stdout:'pipe',stderr:'pipe'})
  const out=new Response(child.stdout).text(),err=new Response(child.stderr).text()
  const safety=setTimeout(()=>child.kill('SIGKILL'),20000)
  let descendants: Array<{pid:number;identity:string}> = []
  try {
   await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Pi provider request did not start')),10000))])
   const rows=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number))
   const ids=new Set([child.pid]);let size=0
   while(size!==ids.size){size=ids.size;for(const [pid,ppid] of rows)if(ids.has(ppid!))ids.add(pid!)}
   descendants=[...ids].filter(p=>p!==child.pid).map(pid=>({pid,identity:getProcessBirthIdentity(pid)!})).filter(p=>p.identity)
   expect(descendants.length).toBeGreaterThanOrEqual(2)
   const executions=join(root,'cli-sessions','global','executions')
   const [threadId]=await readdir(executions)
   const threadRoot=join(executions,threadId!)
   if(mode==='lease'){
    const ownerFile=join(threadRoot,'owner.json')
    const owner=JSON.parse(await readFile(ownerFile,'utf8'))
    await writeFile(ownerFile,JSON.stringify({...owner,leaseId:'successor'}))
   }else if(mode!=='deadline')child.kill(mode)
   const code=await child.exited
   expect(code).not.toBe(0)
   const deadline=Date.now()+7000
   while(Date.now()<deadline && descendants.some(p=>processIdentityMatches(p.pid,p.identity))) await Bun.sleep(100)
   expect(descendants.filter(p=>processIdentityMatches(p.pid,p.identity))).toEqual([])
   expect(mainCalls).toBe(1)
   expect(JSON.parse(await readFile(join(threadRoot,'thread.json'),'utf8')).threadId).toBe(threadId)
   if(mode!=='SIGKILL')expect(await out).not.toContain('"turn.completed"')
  }finally{
   clearTimeout(safety);child.kill('SIGKILL');await child.exited
   await out;await err
   for(const p of descendants)if(processIdentityMatches(p.pid,p.identity))try{process.kill(p.pid,'SIGKILL')}catch{}
   provider.stop(true);await rm(root,{recursive:true,force:true})
  }
 },30000)
}
