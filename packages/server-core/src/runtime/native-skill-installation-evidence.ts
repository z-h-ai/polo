import { readFile, realpath, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { CreatorSkillsLedgerSchema } from '@polo-ai/shared/creator-skills'
import type { CreatorSkillDownloadGrant, CreatorSkillOperationResult, CreatorSkillsLedger } from '@polo-ai/shared/creator-skills'
import { admitTrustedNativeInstallation, getNativeInstallationOutbox, type NativeInstallationIntent, type NativeInstallationSnapshot, type NativeInstallationOutbox } from './native-installations'

async function healthyLedger(workspaceRoot: string) {
  // The existing UI reader deliberately tolerates corrupt ledgers. Inventory
  // evidence must use the strict schema and retain unknown on every failure.
  try { return CreatorSkillsLedgerSchema.parse(JSON.parse(await readFile(join(workspaceRoot,'creator-skills.json'),'utf8'))) as CreatorSkillsLedger }
  catch { return null }
}
const wireChecksum = (checksum: string) => `sha256:${checksum.trim().toLowerCase().replace(/^sha256:/,'')}`
export async function prepareNativeSkillInstall(scope: { accountId: string; productSpaceId: string }, workspaceRoot: string, grant: CreatorSkillDownloadGrant) {
  // This is only a lookup hint from the existing trusted download grant.
  // The server resolves the exact persisted claim and verifies its owner;
  // parsing a payload here does not turn it into authenticated authority.
  const token = new URL(grant.url).searchParams.get('token')
  if (!token || token.length > 8192) throw new Error('Original Skill download claim unavailable')
  const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { claimId?: string }
  if (!payload.claimId) throw new Error('Original Skill download claim unavailable')
  const admission = await admitTrustedNativeInstallation(scope.accountId, { contractVersion: 1, productSpaceId: scope.productSpaceId,
    subjectKind: 'creator_skill', subjectId: grant.artifactId, downloadClaimId: payload.claimId, version: grant.version, checksum: wireChecksum(grant.archiveChecksum) })
  const binding = {kind: 'skill' as const, workspaceRoot: await realpath(workspaceRoot), slug: grant.slug}
  return getNativeInstallationOutbox().prepare(admission,binding,'install')
}
export async function prepareNativeSkillUninstall(workspaceRoot: string, slug: string) {
  const root = await realpath(workspaceRoot), ledger = await healthyLedger(root)
  if (!ledger) return null
  const installed = ledger?.installed.find(row => row.slug === slug)
  const binding = {kind: 'skill' as const, workspaceRoot: root,slug}
  if (installed && !installed.nativeInstallationAdmissionId) return null
  const original = installed
    ? (await getNativeInstallationOutbox().retained(binding)).find(row => row.admissionId === installed.nativeInstallationAdmissionId)
    : await getNativeInstallationOutbox().retainedManagedDetach(binding)
  return original ? getNativeInstallationOutbox().prepare(original,binding,'uninstall') : null
}
async function snapshot(intent: NativeInstallationIntent, outbox: NativeInstallationOutbox): Promise<NativeInstallationSnapshot|null> {
  if (intent.binding.kind !== 'skill') return null
  const binding = intent.binding
  const ledger = await healthyLedger(binding.workspaceRoot); if (!ledger) return null
  const installed = ledger.installed.find(row => row.slug === binding.slug)
  const retained = await outbox.retained(intent.binding)
  const original = retained.find(row => row.admissionId === installed?.nativeInstallationAdmissionId
    && row.accountId === intent.admission.accountId && row.productSpaceId === intent.admission.productSpaceId && row.subjectId === intent.admission.subjectId
    && row.version === installed.version && row.checksum === wireChecksum(installed.archiveChecksum))
  if (original) {
    try {
      const target = await lstat(join(binding.workspaceRoot,'skills',binding.slug))
      if (!target.isDirectory() || target.isSymbolicLink()) return null
    } catch { return null }
    return {state: 'installed',installedAdmissionIds: [original.admissionId],unmappedVersionCount: 0}
  }
  // Another ledger owner may have replaced this slug after a crash. Its
  // directory cannot prove that the original work left detached content.
  if (installed) return null
  if (intent.action !== 'uninstall') return null
  try {
    // Ledger absence alone is insufficient. Modified detached content keeps
    // a distinct state; a failed/corrupt directory probe remains unknown.
    const target = await lstat(join(intent.binding.workspaceRoot,'skills',intent.binding.slug))
    if (!target.isDirectory() || target.isSymbolicLink()) return null
    return {state: 'managed_detached',installedAdmissionIds: [],unmappedVersionCount: 0}
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {state: 'uninstalled',installedAdmissionIds: [],unmappedVersionCount: 0} : null
  }
}
export async function finishNativeSkillInstallation(intent: NativeInstallationIntent|null, result: CreatorSkillOperationResult, outbox = getNativeInstallationOutbox()) {
  if (!intent || !result.success) return
  const evidence = intent.action === 'uninstall'
    ? {state: result.detached ? 'managed_detached' as const : 'uninstalled' as const,installedAdmissionIds: [],unmappedVersionCount: 0}
    : await snapshot(intent,outbox)
  if (evidence) await outbox.commit(intent.id,evidence,{deliver: false})
}
export function flushNativeSkillInstallationEvidence() { return getNativeInstallationOutbox().flush() }
export async function recoverNativeSkillInstallationEvidence(workspaceRoot: string, outbox = getNativeInstallationOutbox()) {
  const root = await realpath(workspaceRoot)
  await outbox.recover(intent => intent.binding.kind === 'skill' && intent.binding.workspaceRoot === root ? snapshot(intent,outbox) : Promise.resolve(null))
}
