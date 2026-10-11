import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { validateCreatorSkillArchive, scanCreatorSkillDirectory } from './archive.ts'
import { downloadCreatorSkillArchive, installCreatorSkill, recoverCreatorSkillOperations, type CreatorSkillInstallerDependencies } from './installer.ts'
import { CreatorSkillsLedgerSchema, CanonicalSkillSourceSchema } from './schemas.ts'
import { DEFAULT_SKILL_ARCHIVE_POLICY, type CanonicalSkillSource, type CreatorSkillOperationResult, type CanonicalInstalledSkill } from './types.ts'

export const CANONICAL_SKILLS_DIRECTORY = '.polo/canonical-skills'
const recoveryByRoot = new Map<string, Promise<void>>()
function ensureCanonicalRecovery(root: string): Promise<void> {
  const existing = recoveryByRoot.get(root)
  if (existing) return existing
  // Recovery is a startup boundary, not an operation to run over a live
  // install journal. Share one preparation per exact local root.
  const pending = recoverCreatorSkillOperations(root).catch(error => { recoveryByRoot.delete(root); throw error })
  recoveryByRoot.set(root, pending)
  return pending
}
export function canonicalSkillIdentity(source: CanonicalSkillSource): string {
  const checked = CanonicalSkillSourceSchema.parse(source)
  return createHash('sha256').update(JSON.stringify([checked.accountId, checked.productSpaceId, checked.subjectKind, checked.subjectId, checked.versionId])).digest('hex')
}
export function canonicalSkillRoot(workspaceRoot: string, source: CanonicalSkillSource): string {
  return join(workspaceRoot, CANONICAL_SKILLS_DIRECTORY, canonicalSkillIdentity(source))
}
/** Every ancestor must be an actual local directory, never a symlink. */
export async function ensureCanonicalSkillRoot(workspaceRoot: string, source: CanonicalSkillSource): Promise<string> {
  const workspace = await realpath(workspaceRoot)
  let current = workspace
  for (const segment of ['.polo', 'canonical-skills', canonicalSkillIdentity(source)]) {
    current = join(current, segment)
    try { await mkdir(current, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new Error('Canonical Skill directory is not a local directory')
  }
  return current
}
export interface CanonicalSkillNativeInput {
  workspaceId: string
  operationId: string
  source: CanonicalSkillSource
  version: string
  checksum: string
  sizeBytes: number
  downloadUrl: string
  expiresAt: string
  replaceExisting?: boolean
  backupLocalChanges?: boolean
}
/** Canonical grant is fetched in Main. Metadata is derived only from its verified ZIP. */
export async function installCanonicalSkill(workspaceRoot: string, input: CanonicalSkillNativeInput,
  dependencies: CreatorSkillInstallerDependencies & {
    signal?: AbortSignal
    onValidated?: (root: string, slug: string) => Promise<{ nativeInstallationAdmissionId?: string; onNativeCommitted?: CreatorSkillInstallerDependencies['onNativeCommitted'] }>
  } = {}): Promise<CreatorSkillOperationResult> {
  const root = await ensureCanonicalSkillRoot(workspaceRoot, input.source)
  const incoming = join(root, `.incoming-${randomUUID()}`)
  const checksum = input.checksum.replace(/^sha256:/, '').toLowerCase()
  if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw new Error('Canonical Skill download grant expired')
  if (!/^[a-f0-9]{64}$/.test(checksum) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > DEFAULT_SKILL_ARCHIVE_POLICY.maxArchiveBytes) throw new Error('Canonical Skill bundle is invalid')
  const ledgerFile = await readFile(join(root, 'creator-skills.json'), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (ledgerFile) {
    const ledger = CreatorSkillsLedgerSchema.parse(JSON.parse(ledgerFile))
    if (ledger.installed.some(row => !row.canonicalSource || canonicalSkillIdentity(row.canonicalSource) !== canonicalSkillIdentity(input.source) || row.archiveChecksum.replace(/^sha256:/, '') !== checksum || row.version !== input.version)) throw new Error('Canonical version identity cannot be replaced by different bytes')
  }
  await mkdir(incoming, { mode: 0o700 })
  try {
    const archive = join(incoming, 'archive.zip')
    await downloadCreatorSkillArchive({ url: input.downloadUrl, outputPath: archive, maxBytes: input.sizeBytes,
      signal: dependencies.signal ?? new AbortController().signal, fetchImpl: dependencies.fetch ?? fetch, onChunk: () => {} })
    if ((await stat(archive)).size !== input.sizeBytes) throw new Error('Canonical Skill bundle size differs from the grant')
    const validated = await validateCreatorSkillArchive({ archivePath: archive, expectedArchiveChecksum: checksum })
    const witnessRoot = join(root, '.archives')
    try { await mkdir(witnessRoot, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const witnessInfo = await lstat(witnessRoot)
    if (!witnessInfo.isDirectory() || witnessInfo.isSymbolicLink() || await realpath(witnessRoot) !== witnessRoot) throw new Error('Canonical Skill witness root is unsafe')
    const witness = join(witnessRoot, `${checksum}.zip`)
    try { await copyFile(archive, witness, 1) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const witnessFile = await lstat(witness)
    if (!witnessFile.isFile() || witnessFile.isSymbolicLink() || await realpath(witness) !== witness) throw new Error('Canonical Skill witness is unsafe')
    await validateCreatorSkillArchive({ archivePath: witness, slug: validated.slug, expectedArchiveChecksum: checksum, expectedContentDigest: validated.contentDigest })
    await ensureCanonicalRecovery(root)
    const hooks = await dependencies.onValidated?.(root, validated.slug)
    return await installCreatorSkill(root, { workspaceId: input.workspaceId, operationId: input.operationId,
      replaceExisting: input.replaceExisting, backupLocalChanges: input.backupLocalChanges,
      // This typed branch deliberately has no organizationId. A derived local
      // manifest proves the already SHA-bound ZIP, not a new server contract.
      grant: { canonicalSource: input.source, artifactId: input.source.subjectId, slug: validated.slug, version: input.version,
        url: input.downloadUrl, expiresAt: input.expiresAt, archiveChecksum: checksum,
        contentDigest: validated.contentDigest, manifest: validated.manifest, validationPolicy: DEFAULT_SKILL_ARCHIVE_POLICY },
    }, { ...dependencies, ...hooks, preparedArchivePath: archive })
  } finally { await rm(incoming, { recursive: true, force: true }) }
}
/** Reserved canonical native roots only; no symlink traversal or external cleanup. */
export async function listCanonicalSkillRoots(workspaceRoot: string): Promise<string[]> {
  const root = join(await realpath(workspaceRoot), CANONICAL_SKILLS_DIRECTORY)
  const info = await lstat(root).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) return []
  const roots: string[] = []
  for (const name of (await readdir(root)).filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const path = join(root, name), entry = await lstat(path).catch(() => null)
    if (entry?.isDirectory() && !entry.isSymbolicLink() && await realpath(path) === path) roots.push(path)
  }
  return roots
}
export async function recoverCanonicalSkillOperations(workspaceRoot: string): Promise<void> {
  for (const root of await listCanonicalSkillRoots(workspaceRoot)) await ensureCanonicalRecovery(root)
}
export interface CanonicalSkillInstallation { workspaceRoot: string; root: string; path: string; installation: CanonicalInstalledSkill }
export async function readCanonicalSkillInstallations(workspaceRoot: string, scope: { accountId: string; productSpaceId: string }, options: { nativeMutationFacts?: boolean } = {}): Promise<CanonicalSkillInstallation[]> {
  const canonicalWorkspace = await realpath(workspaceRoot)
  const root = join(canonicalWorkspace, CANONICAL_SKILLS_DIRECTORY)
  const directory = await lstat(root).catch(() => null)
  if (!directory?.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== root) return []
  const found: CanonicalSkillInstallation[] = []
  for (const name of (await readdir(root)).filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const isolated = join(root, name)
    try {
      const info = await lstat(isolated)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(isolated) !== isolated) continue
      const ledger = CreatorSkillsLedgerSchema.parse(JSON.parse(await readFile(join(isolated, 'creator-skills.json'), 'utf8')))
      for (const row of ledger.installed) {
        const source = row.canonicalSource
        if (!source || source.accountId !== scope.accountId || source.productSpaceId !== scope.productSpaceId || canonicalSkillIdentity(source) !== name) continue
        const path = join(isolated, 'skills', row.slug)
        const target = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
        if (target && (!target.isDirectory() || target.isSymbolicLink() || !(await realpath(path)).startsWith(`${isolated}${sep}`))) continue
        if (!options.nativeMutationFacts) {
          if (!target) continue
          const witness = join(isolated, '.archives', `${row.archiveChecksum}.zip`)
          const witnessFile = await lstat(witness)
          if (!witnessFile.isFile() || witnessFile.isSymbolicLink() || await realpath(witness) !== witness) continue
          const original = await validateCreatorSkillArchive({ archivePath: witness, slug: row.slug, expectedArchiveChecksum: row.archiveChecksum })
          const bytes = await scanCreatorSkillDirectory(path)
          if (bytes.contentDigest !== original.contentDigest || row.contentDigest !== original.contentDigest) continue
        }
        found.push({ workspaceRoot: canonicalWorkspace, root: isolated, path, installation: { ...row, organizationId: undefined, canonicalSource: source } })
      }
    } catch { /* Corrupt or modified native facts grant no permission. */ }
  }
  return found
}
