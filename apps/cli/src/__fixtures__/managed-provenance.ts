import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.argv[2]!
process.env.POLO_AI_CONFIG_DIR = root
process.env.HOME = root
await mkdir(root, {recursive:true})
const { createCliThread } = await import('../cli-thread-store')
const { resolveConnection } = await import('../one-shot')
const { parseExecutionArgs } = await import('../execution-parser')
const record = await createCliThread({origin:'cli-exec',configurationScopeId:'global',configurationWorkspacePath:root,workingDirectory:root,persistence:'persistent'})
const scope = {id:'global',path:root}
const own = {slug:'owned',name:'Own',providerType:'pi',piAuthProvider:'openai',authType:'api_key',createdAt:1,baseUrl:'http://127.0.0.1:1/v1'}
const managed = {...own,slug:'managed-arbitrary',managedBy:'admin'}
const configure = (connections: unknown[], defaultSlug: string) => writeFile(join(root,'config.json'),JSON.stringify({workspaces:[],llmConnections:connections,defaultLlmConnection:defaultSlug}))
let count = 0
const denied = async (extra: string[] = []) => {
 try { await resolveConnection(parseExecutionArgs(['bun','index.ts','exec',...extra,'hello']),record,scope) }
 catch(error) { if(!String(error).includes('CLI_MANAGED_CONTEXT_REQUIRED')) throw error; count++; return }
 throw new Error('Managed connection laundered')
}
await configure([managed],managed.slug)
await denied()
await denied(['--provider','openai'])
await denied(['--provider','openai','--api-key','explicit-fake'])
record.metadata.connection={slug:managed.slug,provider:'openai',connectionType:'pi',authType:'api_key'}
await denied()
await configure([own],'polo-space-missing')
record.metadata.connection=undefined
await denied()
record.metadata.connection={slug:'polo-space-deleted',provider:'anthropic',connectionType:'anthropic',authType:'api_key'}
await denied()
record.metadata.connection={slug:'old-managed',provider:'openai',provenance:{kind:'managed',originalSlug:'managed-arbitrary'}}
await denied()
console.log(JSON.stringify({managedRejected:count}))
