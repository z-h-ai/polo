import {afterEach, expect, test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NativeInstallationOutbox} from '../native-installations'
import {recoverNativeSkillInstallationEvidence} from '../native-skill-installation-evidence'
import type {NativeInstallationAdmission} from '@polo-ai/shared/admin'
const roots: string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'native-skill-commit-evidence-'));roots.push(root)
  const workspaceRoot=await import('node:fs/promises').then(fs=>fs.realpath(root))
  const admission: NativeInstallationAdmission={contractVersion:1,admissionId:randomUUID(),accountId:randomUUID(),productSpaceId:randomUUID(),subjectKind:'personal_artifact',subjectId:randomUUID(),versionId:randomUUID(),version:'1.0.0',checksum:`sha256:${'a'.repeat(64)}`}
  const outbox=new NativeInstallationOutbox(join(root,'outbox'),()=>null)
  await outbox.prepare(admission,{kind:'skill',workspaceRoot,slug:'original-skill'},'install')
  await writeFile(join(root,'creator-skills.json'),JSON.stringify({schemaVersion:1,installed:[{nativeInstallationAdmissionId:admission.admissionId,artifactId:'legacy-artifact',organizationId:'original-organization',slug:'original-skill',version:'1.0.0',archiveChecksum:admission.checksum,contentDigest:admission.checksum,installedAt:new Date().toISOString()}]}))
  return {root,workspaceRoot,outbox,admission}
}
async function pending(root: string) {return JSON.parse(await readFile(join(root,'outbox','journal.json'),'utf8')).pending}
test('a valid ledger with a missing physical target remains unknown after restart',async()=>{
  const f=await fixture();await recoverNativeSkillInstallationEvidence(f.workspaceRoot,f.outbox);expect(await pending(f.root)).toEqual([])
})
test('a symlink is not a healthy native Skill installation witness',async()=>{
  const f=await fixture();await mkdir(join(f.root,'skills'));await mkdir(join(f.root,'foreign-target'));await symlink(join(f.root,'foreign-target'),join(f.root,'skills','original-skill'))
  await recoverNativeSkillInstallationEvidence(f.workspaceRoot,f.outbox);expect(await pending(f.root)).toEqual([])
})
test('a healthy original directory and exact ledger admission recover once',async()=>{
  const f=await fixture();await mkdir(join(f.root,'skills','original-skill'),{recursive:true})
  await recoverNativeSkillInstallationEvidence(f.workspaceRoot,f.outbox);await recoverNativeSkillInstallationEvidence(f.workspaceRoot,f.outbox)
  const reports=await pending(f.root);expect(reports).toHaveLength(1);expect(reports[0].accountId).toBe(f.admission.accountId);expect(reports[0].report.admissionId).toBe(f.admission.admissionId)
})

test('the locked native completion persists its outbox before later token recovery or transport',async()=>{
  const f=await fixture();await mkdir(join(f.root,'skills','original-skill'),{recursive:true})
  let sent=0
  const box=new NativeInstallationOutbox(join(f.root,'outbox'),()=>({admit:async()=>f.admission,report:async(_account,report)=>{sent++;return {contractVersion:1,eventId:report.eventId,revision:report.revision,outcome:'accepted'}}}))
  const intent=JSON.parse(await readFile(join(f.root,'outbox','journal.json'),'utf8')).intents[0]
  const {finishNativeSkillInstallation}=await import('../native-skill-installation-evidence')
  const {readCreatorSkillsLedger}=await import('@polo-ai/shared/creator-skills')
  await finishNativeSkillInstallation(intent,{success:true,operationId:randomUUID(),installed:(await readCreatorSkillsLedger(f.root)).installed[0]!},box)
  expect(sent).toBe(0);expect(await pending(f.root)).toHaveLength(1)
  await box.flush();expect(sent).toBe(1)
})

test('actual modified detach and credential-bound force delete commit the original partition states',async()=>{
  const f=await fixture();const target=join(f.root,'skills','original-skill');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'---\nname: original-skill\ndescription: native evidence fixture\n---\nModified native content.\n')
  await recoverNativeSkillInstallationEvidence(f.workspaceRoot,f.outbox)
  const {uninstallCreatorSkill}=await import('@polo-ai/shared/creator-skills')
  const {prepareNativeSkillUninstall,finishNativeSkillInstallation}=await import('../native-skill-installation-evidence')
  let intent: Awaited<ReturnType<typeof prepareNativeSkillUninstall>>=null
  const hooks={beforeNativeMutation:async()=>{intent=await prepareNativeSkillUninstall(f.workspaceRoot,'original-skill',f.outbox)},onNativeCommitted:async(result: Parameters<typeof finishNativeSkillInstallation>[1])=>{await finishNativeSkillInstallation(intent,result,f.outbox)}}
  const detached=await uninstallCreatorSkill({workspaceRoot:f.workspaceRoot,workspaceId:'workspace-test',operationId:randomUUID(),slug:'original-skill'},hooks)
  expect(detached.success && detached.detached).toBe(true);expect(await f.outbox.retainedManagedDetach({kind:'skill',workspaceRoot:f.workspaceRoot,slug:'original-skill'})).toEqual(f.admission)
  expect(await readFile(join(target,'SKILL.md'),'utf8')).toContain('Modified native content')
  const removed=await uninstallCreatorSkill({workspaceRoot:f.workspaceRoot,workspaceId:'workspace-test',operationId:randomUUID(),slug:'original-skill',forceDeleteModified:true,forceDeleteCredential:detached.success?detached.forceDeleteCredential:undefined},hooks)
  expect(removed.success).toBe(true)
  const reports=await pending(f.root);expect(reports.map((row:{report:{state:string}})=>row.report.state)).toEqual(['installed','managed_detached','uninstalled'])
  expect(new Set(reports.map((row:{report:{partitionId:string}})=>row.report.partitionId)).size).toBe(1)
  expect(reports.every((row:{accountId:string})=>row.accountId===f.admission.accountId)).toBe(true)
})
test('actual missing-target uninstall reports its original owner rather than inventing an installed recovery',async()=>{
  const f=await fixture();const {uninstallCreatorSkill}=await import('@polo-ai/shared/creator-skills')
  const {prepareNativeSkillUninstall,finishNativeSkillInstallation}=await import('../native-skill-installation-evidence')
  let intent: Awaited<ReturnType<typeof prepareNativeSkillUninstall>>=null
  const result=await uninstallCreatorSkill({workspaceRoot:f.workspaceRoot,workspaceId:'workspace-test',operationId:randomUUID(),slug:'original-skill'}, {
    beforeNativeMutation:async()=>{intent=await prepareNativeSkillUninstall(f.workspaceRoot,'original-skill',f.outbox)},
    onNativeCommitted:async result=>{await finishNativeSkillInstallation(intent,result,f.outbox)},
  })
  expect(result.success).toBe(true);const reports=await pending(f.root);expect(reports).toHaveLength(1);expect(reports[0].report.state).toBe('uninstalled');expect(reports[0].report.admissionId).toBe(f.admission.admissionId)
})
