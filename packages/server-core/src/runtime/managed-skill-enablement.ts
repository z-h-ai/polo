/**
 * Managed Skill enablement store (POO-106 S1).
 *
 * One JSON document per trusted account × local workspace:
 * `<managedSkillsRoot>/<sha256(accountId)>/<sha256(workspaceRoot)>.json`.
 *
 * The desktop host injects `managedSkillsRoot` (its userData dir); server-core
 * falls back to the shared CONFIG_DIR so headless hosts and tests get the same
 * layout. Bundled skills never appear here — the RPC layer refuses them and
 * agent composition never consults this store for bundled slugs (SM-18d).
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join, resolve } from 'path'
import { CONFIG_DIR } from '@polo-ai/shared/config'
import {
  atomicWriteFileSync,
  withCrossProcessFileLockSync,
} from '@polo-ai/shared/utils/files'
import {
  createEmptyManagedSkillEnablementDocument,
  type ManagedSkillEnablementDocument,
} from '@polo-ai/shared/skills'

export const MANAGED_SKILLS_DIRNAME = 'managed-skills'

function hashSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Storage root override; the desktop host points this at its userData dir. */
let managedSkillsRootOverride: string | null = null
export function setManagedSkillsRoot(root: string | null): void {
  managedSkillsRootOverride = root
}

export function getManagedSkillsRoot(): string {
  return managedSkillsRootOverride ?? join(CONFIG_DIR, MANAGED_SKILLS_DIRNAME)
}

export function managedSkillEnablementFilePath(accountId: string, workspaceRoot: string): string {
  return join(
    getManagedSkillsRoot(),
    hashSegment(accountId),
    `${hashSegment(resolve(workspaceRoot))}.json`,
  )
}

/**
 * Read the raw document for a scope. Any absent or unreadable file resolves to
 * the empty document (revision 0) — enablement is purely additive state.
 */
export function readManagedSkillEnablementDocument(
  accountId: string,
  workspaceRoot: string,
): ManagedSkillEnablementDocument {
  const filePath = managedSkillEnablementFilePath(accountId, workspaceRoot)
  if (!existsSync(filePath)) return createEmptyManagedSkillEnablementDocument()
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<ManagedSkillEnablementDocument>
    if (parsed?.schemaVersion !== 1 || typeof parsed.revision !== 'number' || !parsed.entries || typeof parsed.entries !== 'object') {
      return createEmptyManagedSkillEnablementDocument()
    }
    return {
      schemaVersion: 1,
      revision: Math.max(0, Math.trunc(parsed.revision)),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      entries: parsed.entries,
    }
  } catch {
    return createEmptyManagedSkillEnablementDocument()
  }
}

/**
 * Extract the disabled local slugs for a scope. Exposed to runtime composition
 * (canonical-skills) as a plain set; callers decide per-skill eligibility, so a
 * stray stored slug can never disable a bundled or canonical skill by accident.
 */
export function readDisabledManagedSkillSlugs(accountId: string, workspaceRoot: string): Set<string> {
  const { entries } = readManagedSkillEnablementDocument(accountId, workspaceRoot)
  const disabled = new Set<string>()
  for (const [slug, entry] of Object.entries(entries)) {
    if (entry?.enabled === false && typeof slug === 'string' && slug.length > 0) disabled.add(slug)
  }
  return disabled
}

/**
 * Write one slug's enablement under the cross-process file lock and bump the
 * revision. `expectedRevision` implements the optimistic lock: a document that
 * moved on since the caller read it yields `revision_conflict` instead of a
 * lost update. Returns the document revision after a successful write.
 */
export function writeManagedSkillEnablement(input: {
  accountId: string
  workspaceRoot: string
  slug: string
  source: Exclude<import('@polo-ai/shared/skills').SkillSource, 'bundled'>
  enabled: boolean
  expectedRevision?: number
}): { ok: true; revision: number } | { ok: false; errorCode: 'revision_conflict'; revision: number } {
  const filePath = managedSkillEnablementFilePath(input.accountId, input.workspaceRoot)
  const lockDir = `${filePath}.lock`
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const result = withCrossProcessFileLockSync(lockDir, (): { ok: true; revision: number } | { ok: false; errorCode: 'revision_conflict'; revision: number } => {
    const document = readManagedSkillEnablementDocument(input.accountId, input.workspaceRoot)
    if (input.expectedRevision !== undefined && document.revision !== input.expectedRevision) {
      return { ok: false, errorCode: 'revision_conflict', revision: document.revision }
    }
    const next: ManagedSkillEnablementDocument = {
      schemaVersion: 1,
      revision: document.revision + 1,
      updatedAt: new Date().toISOString(),
      entries: { ...document.entries },
    }
    if (input.enabled) {
      // Enabled is the default: drop the entry instead of persisting `true`
      // rows so the document only carries actual overrides.
      delete next.entries[input.slug]
    } else {
      next.entries[input.slug] = { enabled: false, source: input.source, updatedAt: next.updatedAt }
    }
    atomicWriteFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 0o600)
    return { ok: true, revision: next.revision }
  })
  if (result.ok) enablementGeneration += 1
  return result
}

/**
 * In-process write counter. Two same-millisecond, same-byte-length writes
 * (disable → enable back to back) can leave mtime+size unchanged, so every
 * local write also moves this counter — the memo key in canonical-skills never
 * repeats across revisions (plan §3.3).
 */
let enablementGeneration = 0

/** File identity used by callers that memoize per-scope reads across revisions. */
export function managedSkillEnablementFingerprint(
  accountId: string,
  workspaceRoot: string,
): string {
  const filePath = managedSkillEnablementFilePath(accountId, workspaceRoot)
  if (!existsSync(filePath)) return `gen${enablementGeneration}:missing`
  try {
    const stats = statSync(filePath)
    return `gen${enablementGeneration}:${stats.mtimeMs}:${stats.size}`
  } catch {
    return `gen${enablementGeneration}:missing`
  }
}
