import { SKILL_TURN_CONTRACT_VERSION, type SkillTurnBegin, type SkillTurnReceipt } from '@polo-ai/shared/admin'
import { join, resolve } from 'node:path'
import type { LoadedSkill } from '@polo-ai/shared/skills'
import { isLocalEnablementTarget } from '@polo-ai/shared/skills'
import type { CanonicalSkillSource, CanonicalSkillInstallation } from '@polo-ai/shared/creator-skills'
import type { TrustedProductSpaceSummary, ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import {
  managedSkillEnablementFingerprint,
  readDisabledManagedSkillSlugs,
} from './managed-skill-enablement'

export interface CanonicalSkillScope { accountId: string; productSpaceId: string; fenceGeneration: number }
export interface CanonicalSkillLaunch { context: TrustedProductSpaceSummary; launch: ResolveLaunchResponse; fetch: typeof fetch; assertCurrent: () => Promise<void> }
export type CanonicalSkillSelector = { catalogEntryId: string } | { subjectId: string }
type Resolver = (scope: CanonicalSkillScope, selector: CanonicalSkillSelector) => Promise<CanonicalSkillLaunch>
let resolver: Resolver | null = null
let contextResolver: ((scope: CanonicalSkillScope) => Promise<TrustedProductSpaceSummary>) | null = null
export function bindCanonicalSkillContextResolver(next: NonNullable<typeof contextResolver>): void { contextResolver = next }
export async function resolveCanonicalSkillContext(scope: CanonicalSkillScope): Promise<TrustedProductSpaceSummary> {
  if (!contextResolver) throw new Error('Skill ProductSpace authority unavailable')
  return contextResolver(scope)
}
/** Registered only by the production Admin coordinator, never renderer input. */
export function bindCanonicalSkillResolver(next: Resolver): void { resolver = next }
export async function resolveCanonicalSkill(scope: CanonicalSkillScope, selector: CanonicalSkillSelector): Promise<CanonicalSkillLaunch> {
  if (!resolver) throw new Error('Canonical Skill authority unavailable')
  return resolver(scope, selector)
}
export function canonicalSkillSourceFromLaunch(scope: CanonicalSkillScope, resolved: CanonicalSkillLaunch): CanonicalSkillSource {
  const { context, launch } = resolved
  if (context.id !== scope.productSpaceId || launch.productSpaceId !== scope.productSpaceId || launch.subject.kind !== 'artifact_instance' || launch.subject.artifactType !== 'skill' || launch.delivery.kind !== 'bundle') throw new Error('Canonical Skill launch tuple is invalid')
  return { accountId: scope.accountId, productSpaceId: scope.productSpaceId,
    subjectKind: context.kind === 'personal' ? 'personal_artifact' : 'enterprise_instance',
    subjectId: launch.subject.artifactInstanceId, versionId: launch.subject.versionId }
}
export async function authorizeCanonicalSkillInstallation(scope: CanonicalSkillScope, item: CanonicalSkillInstallation): Promise<void> {
  const row = item.installation, source = row.canonicalSource
  if (source.accountId !== scope.accountId || source.productSpaceId !== scope.productSpaceId) throw new Error('Canonical Skill owner changed')
  // CatalogEntryId is deliberately looked up from a fresh Catalog by the
  // resolver's subject-id mode; never inferred from the native directory.
  const resolved = await resolveCanonicalSkill(scope, { subjectId: source.subjectId })
  const current = canonicalSkillSourceFromLaunch(scope, resolved)
  const launch = resolved.launch
  if (current.accountId !== source.accountId || current.productSpaceId !== source.productSpaceId || current.subjectKind !== source.subjectKind || current.subjectId !== source.subjectId || current.versionId !== source.versionId || launch.subject.kind !== 'artifact_instance' || launch.subject.version !== row.version
    || launch.delivery.kind !== 'bundle' || launch.delivery.checksum.replace(/^sha256:/, '').toLowerCase() !== row.archiveChecksum) throw new Error('Installed Skill is not the current authorized version')
  await resolved.assertCurrent()
  const { readCanonicalSkillInstallations } = await import('@polo-ai/shared/creator-skills')
  // Recheck native bytes after the awaited server verdict, not just before it.
  const stillHealthy = (await readCanonicalSkillInstallations(item.workspaceRoot, scope))
    .some(row => row.path === item.path && row.installation.archiveChecksum === item.installation.archiveChecksum && row.installation.canonicalSource.versionId === source.versionId)
  if (!stillHealthy) throw new Error('Canonical Skill native bytes changed during authorization')
}
export async function loadCallableCanonicalSkills(workspaceRoot: string, scope: CanonicalSkillScope): Promise<LoadedSkill[]> {
  const { readCanonicalSkillInstallations } = await import('@polo-ai/shared/creator-skills')
  const rows = await readCanonicalSkillInstallations(workspaceRoot, scope)
  const { loadSkill } = await import('@polo-ai/shared/skills')
  const result: LoadedSkill[] = []
  for (const row of rows) {
    try {
      await authorizeCanonicalSkillInstallation(scope, row)
      const skill = loadSkill(row.root, row.installation.slug)
      if (skill) result.push({ ...skill, slug: `canonical-${row.root.split(/[\\/]/).pop()}`, canonicalInstallation: row.installation })
    } catch { /* No fresh permission means this record is unavailable. */ }
  }
  return result
}

interface SkillTurnAuthority {
  begin(scope: CanonicalSkillScope, input: SkillTurnBegin): Promise<SkillTurnReceipt>
  operate(scope: CanonicalSkillScope, receipt: SkillTurnReceipt, operation: 'authorize' | 'finish'): Promise<SkillTurnReceipt>
}
let turnAuthority: SkillTurnAuthority | null = null
export function bindCanonicalSkillTurnAuthority(next: SkillTurnAuthority): void { turnAuthority = next }
export async function beginCanonicalSkillTurn(scope: CanonicalSkillScope, input: SkillTurnBegin): Promise<SkillTurnReceipt> {
  if (!turnAuthority) throw new Error('Skill turn authority unavailable')
  return turnAuthority.begin(scope, input)
}
export async function operateCanonicalSkillTurn(scope: CanonicalSkillScope, receipt: SkillTurnReceipt, operation: 'authorize' | 'finish'): Promise<SkillTurnReceipt> {
  if (!turnAuthority) throw new Error('Skill turn authority unavailable')
  return turnAuthority.operate(scope, receipt, operation)
}

/** One controller per actual managed runtime owner, never renderer supplied. */
export function createCanonicalSkillTurnController(workspaceRoot: string) {
  type Pin = { scope: CanonicalSkillScope; row: CanonicalSkillInstallation; receipt: SkillTurnReceipt }
  const turns = new Map<string, Map<string, Pin>>()
  // Serializes first-use admission, reauthorization and finish for this owner.
  let queue = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work); queue = result.then(() => {}, () => {}); return result
  }
  const assertScope = (a: CanonicalSkillScope, b: CanonicalSkillScope) => {
    if (a.accountId !== b.accountId || a.productSpaceId !== b.productSpaceId || a.fenceGeneration !== b.fenceGeneration) throw new Error('Original Skill turn scope changed')
  }
  const assertNative = async (pin: Pin) => {
    const { readCanonicalSkillInstallations } = await import('@polo-ai/shared/creator-skills')
    const healthy = (await readCanonicalSkillInstallations(workspaceRoot, pin.scope)).some(row => row.path === pin.row.path && row.installation.canonicalSource.versionId === pin.receipt.versionId && row.installation.archiveChecksum === pin.receipt.checksum.replace(/^sha256:/, ''))
    if (!healthy) throw new Error('Pinned Skill native bytes are unavailable')
  }
  return {
    use(scope: CanonicalSkillScope, paths: readonly string[], turnId: string): Promise<void> {
      return serial(async () => {
        if (!turnAuthority) throw new Error('Skill turn authority unavailable')
        const { readCanonicalSkillInstallations } = await import('@polo-ai/shared/creator-skills')
        let pins = turns.get(turnId)
        if (!pins) { pins = new Map(); turns.set(turnId, pins) }
        for (const path of paths) {
          let pin = pins.get(path)
          if (!pin) {
            const row = (await readCanonicalSkillInstallations(workspaceRoot, scope)).find(row => path === join(row.path, 'SKILL.md') || path === row.path)
            if (!row) throw new Error('Skill native bytes unavailable for new turn')
            const source = row.installation.canonicalSource
            if ([...pins.values()].some(existing => existing.receipt.subjectKind === source.subjectKind && existing.receipt.subjectId === source.subjectId && (existing.receipt.versionId !== source.versionId || existing.row.path !== row.path))) throw new Error('An admitted Skill turn cannot switch its pinned version path')
            await authorizeCanonicalSkillInstallation(scope, row)
            const receipt = await beginCanonicalSkillTurn(scope, { contractVersion: SKILL_TURN_CONTRACT_VERSION, turnId, subjectKind: source.subjectKind, subjectId: source.subjectId, versionId: source.versionId, checksum: `sha256:${row.installation.archiveChecksum}` })
            if (receipt.version !== row.installation.version) throw new Error('Skill turn version changed')
            pin = { scope: { ...scope }, row, receipt }; pins.set(path, pin)
          }
          assertScope(pin.scope, scope)
          // The server rechecks source/enablement/safety for the immutable
          // receipt. A later current version does not replace these bytes.
          pin.receipt = await operateCanonicalSkillTurn(pin.scope, pin.receipt, 'authorize')
          await assertNative(pin)
        }
      })
    },
    finish(turnId: string): Promise<void> {
      return serial(async () => {
        const pins = turns.get(turnId)
        try {
          const results = await Promise.allSettled([...pins?.values() ?? []].map(pin => {
            if (!turnAuthority) throw new Error('Skill turn authority unavailable')
            return operateCanonicalSkillTurn(pin.scope, pin.receipt, 'finish')
          }))
          if (results.some(result => result.status === 'rejected')) throw new Error('Skill turn finish unavailable; server expiry remains authoritative')
        } finally { turns.delete(turnId) }
      })
    },
  }
}

/**
 * Memoized disabled-slug reads keyed by the enablement document's identity:
 * the in-process write generation (every local write moves it) plus the file's
 * mtime + size (which catches writes from other processes), so composition can
 * stay hot without ever reusing a stale enablement set — plan §3.3 keys the
 * cache on the revision, and this identity moves with every revision bump.
 */
interface EnablementMemo { fingerprint: string; disabled: Set<string> }
const disabledLocalSkillsMemo = new Map<string, EnablementMemo>()
function readDisabledLocalSkillsMemoized(accountId: string, workspaceRoot: string): Set<string> {
  const key = `${accountId} ${resolve(workspaceRoot)}`
  const fingerprint = managedSkillEnablementFingerprint(accountId, workspaceRoot)
  const cached = disabledLocalSkillsMemo.get(key)
  if (cached && cached.fingerprint === fingerprint) return cached.disabled
  const disabled = readDisabledManagedSkillSlugs(accountId, workspaceRoot)
  disabledLocalSkillsMemo.set(key, { fingerprint, disabled })
  return disabled
}

/**
 * Current-space discovery without the enablement filter. The management
 * inventory (skills.listManaged) builds on this: a disabled skill must stay
 * visible there or it could never be re-enabled.
 */
export async function discoverProductSpaceSkills(workspaceRoot: string, scope: CanonicalSkillScope, workingDirectory?: string): Promise<LoadedSkill[]> {
  const context = await resolveCanonicalSkillContext(scope)
  const canonical = await loadCallableCanonicalSkills(workspaceRoot, scope)
  const { loadAllSkills, loadBundledSkills } = await import('@polo-ai/shared/skills')
  // Bundled app Skills ship with the client and carry no personal scope, so an
  // active enterprise space still discovers them while every personal legacy
  // root stays closed. A read_only space starts no Skill work at all.
  const local = context.kind === 'personal' && context.accessMode === 'active'
    ? loadAllSkills(workspaceRoot, workingDirectory)
    : context.kind === 'enterprise' && context.accessMode === 'active'
      ? loadBundledSkills()
      : []
  // Recheck the space policy after the awaited discovery: a mid-flight
  // personal→enterprise switch must not publish legacy-root skills.
  const current = await resolveCanonicalSkillContext(scope)
  if (current.kind !== context.kind || current.accessMode !== context.accessMode) throw new Error('Skill ProductSpace policy changed during discovery')
  return [...local, ...canonical]
}

/** Current-space discovery shared by RPC and file-watcher publications. */
export async function loadProductSpaceSkills(workspaceRoot: string, scope: CanonicalSkillScope, workingDirectory?: string): Promise<LoadedSkill[]> {
  const discovered = await discoverProductSpaceSkills(workspaceRoot, scope, workingDirectory)
  // POO-106 S1: local user-tier skills the account disabled never enter agent
  // composition. Bundled and canonical rows are not enablement targets at all
  // (SM-18d/g), so a stray stored slug cannot disable them by accident.
  const disabledSlugs = readDisabledLocalSkillsMemoized(scope.accountId, workspaceRoot)
  return discovered.filter(skill => !isLocalEnablementTarget(skill) || !disabledSlugs.has(skill.slug))
}
