import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
test('raw selection, explicit provider, stored-key fallback, synthetic resume and deleted managed slugs fail before credential use', async () => {
 const root=await mkdtemp(join(tmpdir(),'polo-managed-'))
 try {
  const child=Bun.spawn([process.execPath,resolve('apps/cli/src/__fixtures__/managed-provenance.ts'),root],{stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(code)throw new Error(err+out)
  expect(JSON.parse(out).managedRejected).toBe(7)
 }finally{await rm(root,{recursive:true,force:true})}
})
