import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Electron runs this transport under Node. Bun's HTTP compatibility layer
// does not emit downstream-close before headers; exercise the actual runtime.
test('stopping after upstream accepts POST but before first headers terminates the billing lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'polo-node-billing-cancel-'))
  try {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, '../invocation-credential-proxy.ts')], target: 'node', format: 'cjs', outdir: directory, naming: 'proxy.cjs' })
    expect(built.success).toBe(true)
    const child = spawnSync('node', ['-e', NODE_FIXTURE], { cwd: directory, encoding: 'utf8', timeout: 8000 })
    expect(child.status).toBe(0)
    const result = JSON.parse(child.stdout.trim())
    expect(result).not.toBeNull()
    expect(result).toMatchObject({ outputDisposition: 'unknown', providerObservation: { state: 'missing' } })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 15000)

const NODE_FIXTURE = "const {createServer}=require('node:http');const {startInvocationCredentialProxy}=require('./proxy.cjs');\n(async()=>{let accepted,completed;const received=new Promise(r=>accepted=r), receipt=new Promise(r=>completed=r);const s=createServer(async(req,res)=>{for await(const _ of req){} accepted()});await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=await startInvocationCredentialProxy({upstreamBaseUrl:`http://127.0.0.1:${s.address().port}/v1`,credential:'test-key',credentialHeaders:[{name:'authorization',format:'bearer'}]},{billing:{beforeSend:async()=>({providerCorrelation:{header:'X-Polo-Request-Id',nonce:'a'.repeat(32)},assertCurrent(){},complete:async r=>completed(r)})}});const c=new AbortController();const f=fetch(p.url+'/chat/completions',{method:'POST',signal:c.signal,headers:{authorization:`Bearer ${p.capability}`},body:JSON.stringify({model:'deepseek-chat',messages:[]})}).catch(()=>null);await received;c.abort();await f;const result=await Promise.race([receipt,new Promise(r=>setTimeout(()=>r(null),500))]);console.log(JSON.stringify(result));await p.close();await new Promise(r=>{s.close(r);s.closeAllConnections()})})().catch(e=>{console.error(e.message);process.exit(1)})\n"
