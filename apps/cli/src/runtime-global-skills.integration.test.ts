import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('owned CLI preserves global Skills when execution directory differs from HOME', async () => {
 const root = await mkdtemp(join(tmpdir(), 'polo-skills-'))
 const work = join(root, 'work')
 await mkdir(work)
 const skill = join(root, '.agents', 'skills', 'local-proof', 'SKILL.md')
 await mkdir(join(root,'.agents','skills','local-proof'),{recursive:true})
 const nonce=crypto.randomUUID()
 await writeFile(skill,`---\nname: local-proof\ndescription: Local CLI proof.\n---\nRead this nonce: ${nonce}.\n`)
 const requests: any[]=[]
 let calls=0
 const provider=Bun.serve({port:0,async fetch(req){
  const body=await req.json() as any
  let delta:any={role:'assistant',content:'Title'}
  if(body.tools?.length){
   requests.push(body);calls++
   delta=calls<=2?{role:'assistant',tool_calls:[{index:0,id:`safe_${calls}`,type:'function',function:{name:calls===1?'read':'write',arguments:JSON.stringify(calls===1?{path:skill}:{path:join(root,'forbidden.txt'),content:'must not be written'})}}]}:{role:'assistant',content:'DONE'}
  }
  const finish=delta.tool_calls?'tool_calls':'stop'
  const chunk=(delta:any,finish_reason:string|null)=>`data: ${JSON.stringify({id:'safe',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta,finish_reason}]})}\n\n`
  return new Response(chunk(delta,null)+chunk({},finish)+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 try{
  await writeFile(join(root,'config.json'),JSON.stringify({workspaces:[],defaultLlmConnection:'own',llmConnections:[{slug:'own',name:'Own',providerType:'pi',piAuthProvider:'openai',authType:'api_key',baseUrl:`http://127.0.0.1:${provider.port}/v1`,customEndpoint:{api:'openai-completions'},models:['test-model'],defaultModel:'test-model',createdAt:1}]}))
  const child=Bun.spawn([process.execPath,resolve('apps/cli/src/index.ts'),'exec','--json','-C',work,'[skill:local-proof] Read the skill, then attempt to write forbidden.txt.'],{env:{...process.env,HOME:root,POLO_AI_CONFIG_DIR:root,LLM_API_KEY:'controlled-key'},stdout:'pipe',stderr:'pipe'})
  const timer=setTimeout(()=>child.kill('SIGTERM'),15000)
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer)
  if(code)throw new Error(out+err)
  expect(requests[0].messages.some((m:any)=>JSON.stringify(m.content).includes(skill))).toBe(true)
  expect(requests[1].messages.some((m:any)=>m.role==='tool'&&JSON.stringify(m.content).includes(nonce))).toBe(true)
  expect(await readFile(join(root,'forbidden.txt'),'utf8').catch(()=>null)).toBe(null)
  expect(requests[2].messages.some((m:any)=>m.role==='tool'&&/block|safe|explore|denied/i.test(JSON.stringify(m.content)))).toBe(true)
 }finally{provider.stop(true);await rm(root,{recursive:true,force:true})}
},25000)
