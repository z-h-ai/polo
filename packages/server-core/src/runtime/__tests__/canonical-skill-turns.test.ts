import { expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { installCanonicalSkill, canonicalSkillRoot } from '@polo-ai/shared/creator-skills'
import type { SkillTurnReceipt } from '@polo-ai/shared/admin'
import { bindCanonicalSkillContextResolver, loadProductSpaceSkills, bindCanonicalSkillResolver, bindCanonicalSkillTurnAuthority, createCanonicalSkillTurnController, type CanonicalSkillLaunch } from '../canonical-skills'

it('real native paths stay pinned during a turn, new turns require current, every use revalidates server receipt and original scope', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'canonical-skill-turn-')))
 try {
  const source = { accountId:randomUUID(),productSpaceId:randomUUID(),subjectKind:'personal_artifact' as const,subjectId:randomUUID(),versionId:randomUUID() }
  const scope = {...source,fenceGeneration:7}
  const first = zipSync({'same-slug/SKILL.md':strToU8('---\nname: same-slug\ndescription: First version.\n---\nPinned first bytes.\n')})
  const second = zipSync({'same-slug/SKILL.md':strToU8('---\nname: same-slug\ndescription: Second version.\n---\nNew current bytes.\n')})
  const checksum = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const newer = {...source,versionId:randomUUID()}
  async function install(tuple: typeof source, bytes: Uint8Array, version: string) { expect((await installCanonicalSkill(root,{workspaceId:'workspace-a',operationId:randomUUID(),source:tuple,version,downloadUrl:'https://original.example/download',expiresAt:'2030-01-01T00:00:00.000Z',checksum:checksum(bytes),sizeBytes:bytes.byteLength},{fetch:(async()=>new Response(bytes)) as unknown as typeof fetch})).success).toBe(true) }
  await install(source,first,'1.0.0')
  let current = source, currentBytes = first, version = '1.0.0', permitted = true
  bindCanonicalSkillResolver(async () => ({ context:{id:source.productSpaceId,kind:'personal'}, launch:{ productSpaceId:source.productSpaceId,subject:{kind:'artifact_instance',artifactType:'skill',artifactInstanceId:source.subjectId,versionId:current.versionId,version},delivery:{kind:'bundle',checksum:`sha256:${checksum(currentBytes)}`}}, assertCurrent:async()=>{if(!permitted)throw new Error('revoked')},fetch:globalThis.fetch }) as unknown as CanonicalSkillLaunch)
  const admitted = new Map<string,SkillTurnReceipt>(), operations: string[] = []
  bindCanonicalSkillTurnAuthority({begin:async (s,input)=>{
   expect(s.accountId).toBe(source.accountId); if (!permitted || input.versionId!==current.versionId) throw new Error('not current')
   const receipt: SkillTurnReceipt = {...input,receiptId:randomUUID(),accountId:s.accountId,productSpaceId:s.productSpaceId,version,state:'active',issuedAt:'2026-01-01T00:00:00.000Z',expiresAt:'2030-01-01T00:00:00.000Z'}; admitted.set(receipt.receiptId,receipt); return receipt
  },operate:async (_s,receipt,op)=>{operations.push(op);if(!permitted)throw new Error('source revoked');const saved=admitted.get(receipt.receiptId);if(!saved||saved.state!=='active')throw new Error('terminal');if(op==='finish')saved.state='finished';return {...saved}}})
  const controller=createCanonicalSkillTurnController(root), turn=randomUUID(), oldPath=join(canonicalSkillRoot(root,source),'skills/same-slug/SKILL.md')
  await controller.use(scope,[oldPath],turn)
  current=newer;currentBytes=second;version='1.1.0';await install(newer,second,'1.1.0')
  await controller.use(scope,[oldPath],turn)
  expect(await readFile(oldPath,'utf8')).toContain('Pinned first bytes')
  expect(admitted.size).toBe(1)
  await expect(controller.use(scope,[oldPath],randomUUID())).rejects.toThrow('current authorized version')
  const newPath=join(canonicalSkillRoot(root,newer),'skills/same-slug/SKILL.md'), newTurn=randomUUID()
  await controller.use(scope,[newPath],newTurn); expect(admitted.size).toBe(2)
  await expect(controller.use(scope,[newPath],turn)).rejects.toThrow('pinned version path')
  await expect(controller.use({...scope,accountId:randomUUID()},[oldPath],turn)).rejects.toThrow('scope changed')
  await expect(controller.use({...scope,productSpaceId:randomUUID()},[oldPath],turn)).rejects.toThrow('scope changed')
  await expect(controller.use({...scope,fenceGeneration:8},[oldPath],turn)).rejects.toThrow('scope changed')
  permitted=false;await expect(controller.use(scope,[oldPath],turn)).rejects.toThrow('revoked')
  permitted=true;await writeFile(oldPath,'locally modified');await expect(controller.use(scope,[oldPath],turn)).rejects.toThrow('native bytes')
  await controller.finish(turn); await expect(controller.use(scope,[oldPath],turn)).rejects.toThrow('native bytes')
  await controller.finish(newTurn);expect(operations.filter(op=>op==='finish')).toHaveLength(2)
  expect([...admitted.values()].every(row=>row.state==='finished')).toBe(true)
 } finally { await rm(root,{recursive:true,force:true}) }
})

it('actual discovery used by file-watcher publications excludes personal instructions in enterprise scope',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polo-skill-watch-scope-')))
 try {
  const {mkdir}=await import('node:fs/promises');await mkdir(join(root,'skills/private-helper'),{recursive:true});await writeFile(join(root,'skills/private-helper/SKILL.md'),'---\nname: private-helper\ndescription: Personal only.\n---\nPrivate instructions.')
  const scope={accountId:randomUUID(),productSpaceId:randomUUID(),fenceGeneration:1};let kind='enterprise',mode='active'
  bindCanonicalSkillContextResolver(async()=>({id:scope.productSpaceId,kind,accessMode:mode} as any))
  expect((await loadProductSpaceSkills(root,scope)).some(row=>row.slug==='private-helper')).toBe(false)
  kind='personal';expect((await loadProductSpaceSkills(root,scope)).some(row=>row.slug==='private-helper')).toBe(true)
  mode='read_only';expect((await loadProductSpaceSkills(root,scope)).some(row=>row.slug==='private-helper')).toBe(false)
  let reads=0;mode='active';bindCanonicalSkillContextResolver(async()=>({id:scope.productSpaceId,kind:'personal',accessMode:++reads===1?'active':'read_only'} as any))
  await expect(loadProductSpaceSkills(root,scope)).rejects.toThrow('policy changed')
 }finally{await rm(root,{recursive:true,force:true})}
})
