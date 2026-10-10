import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeInstallationOutbox, type NativeInstallationTransport } from '../native-installations'
import type { NativeInstallationAdmission, NativeInstallationReport } from '@polo-ai/shared/admin'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive: true,force: true}))) })
async function root() { const path = await mkdtemp(join(tmpdir(),'polo-native-install-evidence-')); roots.push(path); return path }
function admission(overrides: Partial<NativeInstallationAdmission> = {}): NativeInstallationAdmission {
  return {contractVersion: 1,admissionId: randomUUID(),accountId: randomUUID(),productSpaceId: randomUUID(),subjectKind: 'personal_artifact',subjectId: randomUUID(),versionId: randomUUID(),version: '1.0.0',checksum: `sha256:${'a'.repeat(64)}`,...overrides}
}
function binding(a: NativeInstallationAdmission) { return {kind: 'app' as const,accountId: a.accountId,productSpaceId: a.productSpaceId,subjectId: a.subjectId} }
const installed = (a: NativeInstallationAdmission) => ({state: 'installed' as const,installedAdmissionIds: [a.admissionId],unmappedVersionCount: 0})
function sender(send: (accountId: string,report: NativeInstallationReport) => Promise<unknown>): NativeInstallationTransport {
  return {admit: async () => { throw new Error('No admission fetch in outbox test') },report: async (accountId,report) => {
    await send(accountId,report); return {contractVersion: 1,eventId: report.eventId,revision: report.revision,outcome: 'accepted'}
  }}
}
describe('native installation durable original-scope outbox', () => {
  test('offline success survives restart with the exact original tuple and immutable event', async () => {
    const path = await root(), a = admission(), offline = sender(async () => { throw new Error('offline') })
    const box = new NativeInstallationOutbox(path,() => offline), intent = await box.prepare(a,binding(a),'install')
    await box.commit(intent.id,installed(a))
    const journal = JSON.parse(await readFile(join(path,'journal.json'),'utf8')); expect(journal.pending).toHaveLength(1)
    const delivered: NativeInstallationReport[] = [], online = sender(async (accountId,report) => { expect(accountId).toBe(a.accountId); delivered.push(report) })
    const restarted = new NativeInstallationOutbox(path,() => online); await restarted.flush(); await restarted.flush()
    expect(delivered).toEqual([journal.pending[0].report]); expect(delivered[0].admissionId).toBe(a.admissionId)
    expect(JSON.stringify(delivered)).not.toMatch(/workspaceRoot|password|accessToken|launchKey/)
  })
  test('account B cannot send account A evidence and does not replace its pending identity', async () => {
    const path = await root(), a = admission(); let current: string = randomUUID(), sends = 0
    const guarded = sender(async accountId => { if (current !== accountId) throw new Error('Original session unavailable'); sends++ })
    const box = new NativeInstallationOutbox(path,() => guarded), intent = await box.prepare(a,binding(a),'install')
    await box.commit(intent.id,installed(a)); expect(sends).toBe(0)
    expect(JSON.parse(await readFile(join(path,'journal.json'),'utf8')).pending[0].accountId).toBe(a.accountId)
    current = a.accountId; await box.flush(); expect(sends).toBe(1)
  })
  test('revisions partition by original work, retain every admitted version, and survive a restart', async () => {
    const path = await root(), a = admission(), b = admission({...a,admissionId: randomUUID(),versionId: randomUUID(),version: '2.0.0'})
    const reports: NativeInstallationReport[] = [], transport = sender(async (_account,report) => { reports.push(report) })
    const box = new NativeInstallationOutbox(path,() => transport), first = await box.prepare(a,binding(a),'install')
    await box.commit(first.id,installed(a)); const second = await box.prepare(b,binding(b),'install')
    await box.commit(second.id,{state: 'installed',installedAdmissionIds: [a.admissionId,b.admissionId],unmappedVersionCount: 0})
    const restarted = new NativeInstallationOutbox(path,() => transport), uninstall = await restarted.prepare(b,binding(b),'uninstall')
    await restarted.commit(uninstall.id,{state: 'uninstalled',installedAdmissionIds: [],unmappedVersionCount: 0})
    expect(reports.map(row => row.revision)).toEqual([1,2,3]); expect(new Set(reports.map(row => row.deviceId)).size).toBe(1)
    expect(new Set(reports.map(row => row.partitionId)).size).toBe(1); expect(await restarted.retained(binding(a))).toHaveLength(2)
  })
  test('prepared native mutations require a positive commit witness; missing/corrupt evidence is unknown', async () => {
    const path = await root(), a = admission(), reports: NativeInstallationReport[] = [], transport = sender(async (_account,report) => { reports.push(report) })
    const box = new NativeInstallationOutbox(path,() => transport); await box.prepare(a,binding(a),'install')
    const restarted = new NativeInstallationOutbox(path,() => transport); await restarted.recover(async () => null); expect(reports).toEqual([])
    await restarted.recover(async intent => installed(intent.admission)); expect(reports).toHaveLength(1)
    await restarted.recover(async intent => installed(intent.admission)); expect(reports).toHaveLength(1)
  })
  test('an unreadable journal never becomes an empty inventory or reset device/revision', async () => {
    const path = await root(), a = admission(); await writeFile(join(path,'journal.json'),'INVALID_JSON')
    const box = new NativeInstallationOutbox(path,() => null); await expect(box.prepare(a,binding(a),'install')).rejects.toThrow()
    expect(await readFile(join(path,'journal.json'),'utf8')).toBe('INVALID_JSON')
  })
  test('concurrent native commits allocate distinct monotonic revisions', async () => {
    const path = await root(), a = admission(), box = new NativeInstallationOutbox(path,() => null)
    const intents = await Promise.all([1,2,3].map(() => box.prepare(a,binding(a),'install')))
    await Promise.all(intents.map(intent => box.commit(intent.id,installed(a))))
    const journal = JSON.parse(await readFile(join(path,'journal.json'),'utf8'))
    expect(journal.pending.map((row: {report: NativeInstallationReport}) => row.report.revision)).toEqual([1,2,3])
    expect(new Set(journal.pending.map((row: {report: NativeInstallationReport}) => row.report.eventId)).size).toBe(3)
  })
  test('a verified same-slug Skill replacement terminates the old original owner atomically and recovers once', async () => {
    const path = await root(), a = admission(), b = admission(), binding = {kind: 'skill' as const,workspaceRoot: '/private/local-workspace',slug: 'same-skill'}
    const box = new NativeInstallationOutbox(path,() => null)
    const first = await box.prepare(a,binding,'install');await box.commit(first.id,installed(a))
    await box.prepare(b,binding,'install')
    const restarted = new NativeInstallationOutbox(path,() => null)
    await restarted.recover(async intent => intent.admission.admissionId === b.admissionId ? installed(b) : null)
    const journal = JSON.parse(await readFile(join(path,'journal.json'),'utf8'))
    const ended = journal.pending.find((row: {accountId: string; report: NativeInstallationReport})=>row.accountId === a.accountId && row.report.state === 'uninstalled')
    expect(ended.report.admissionId).toBe(a.admissionId);expect(ended.report.partitionId).toBe(first.partitionId);expect(ended.report.revision).toBe(2)
    expect(journal.pending.filter((row: {accountId: string})=>row.accountId === b.accountId)).toHaveLength(1)
    await restarted.recover(async intent => installed(intent.admission))
    expect(JSON.parse(await readFile(join(path,'journal.json'),'utf8')).pending).toHaveLength(3)
  })

})
