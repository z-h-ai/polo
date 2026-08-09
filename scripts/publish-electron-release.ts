#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { compare } from 'semver'
import {
  parseReleaseContract,
  sha256,
  type ParsedReleaseContract,
  type ReleaseArtifactContract,
  type ReleaseContract,
} from './electron-release-contract'
import { isStrictSemver } from './strict-semver'

export const MANIFEST_NAMES = ['latest-mac.yml', 'latest-linux.yml'] as const
export const MACOS_X64_DMG_NAME = 'Polo-AI-x64.dmg'
export const MAX_DISK_USAGE = 0.70
export const KEEP_RELEASES = 3

const CONTRACT_NAME = 'release-contract.json'
const LOCK_NAME = '.publisher.lock'
const ROLLBACK_MARKER_PATTERN = /^\.(rollback|confirmed|compensated)-(.+)\.json$/

interface YamlFile {
  url: string
  sha512: string
  size: number
  arch?: string
}

interface UpdateManifest {
  version: string
  files: YamlFile[]
  path?: string
  sha512?: string
}

export interface ReleaseArguments {
  source: string
  releasesDir: string
  version: string
  repository: string
  tag: string
  commitSha: string
}

export interface ValidatedRelease {
  contract: ReleaseContract
  manifests: Record<(typeof MANIFEST_NAMES)[number], UpdateManifest>
  files: string[]
}

export type PublishResult = 'published' | 'idempotent'

export interface PublisherOptions {
  capacityCheck?: (releasesDir: string, source: string) => Promise<void>
}

export interface FinalizeOptions {
  /** Test seam for proving that recovery state survives a failed retention pass. */
  retentionCleanup?: (electronRoot: string, ignoredMarkers: ReadonlySet<string>) => Promise<void>
  /** Test seam for proving stale-marker removal is reported, rather than hidden. */
  markerCleanup?: (marker: string) => Promise<void>
}

function validateBasename(name: string, label: string): void {
  if (basename(name) !== name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`${label} contains an unsafe file name: ${name}`)
  }
}

async function checksum(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const file = await readFile(path)
  return createHash(algorithm).update(file).digest(algorithm === 'sha512' ? 'base64' : 'hex')
}

function asManifest(value: unknown, name: string): UpdateManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is not a YAML object`)
  }
  const manifest = value as Partial<UpdateManifest>
  if (typeof manifest.version !== 'string' || !Array.isArray(manifest.files) || manifest.files.length < 1) {
    throw new Error(`${name} must contain a version and at least one file`)
  }
  for (const entry of manifest.files) {
    if (
      !entry
      || typeof entry.url !== 'string'
      || typeof entry.sha512 !== 'string'
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
    ) {
      throw new Error(`${name} contains an invalid file entry`)
    }
    validateBasename(entry.url, name)
  }
  if (new Set(manifest.files.map(entry => entry.url)).size !== manifest.files.length) {
    throw new Error(`${name} contains duplicate file entries`)
  }
  if (manifest.path !== undefined) validateBasename(manifest.path, `${name}.path`)
  return manifest as UpdateManifest
}

function manifestEntryForArtifact(
  manifest: UpdateManifest,
  name: (typeof MANIFEST_NAMES)[number],
  expectedArtifact: ReleaseArtifactContract,
): YamlFile {
  const allowed = name === 'latest-mac.yml'
    ? new Set([expectedArtifact.fileName, MACOS_X64_DMG_NAME])
    : new Set([expectedArtifact.fileName])
  const unsupported = manifest.files.find(entry => !allowed.has(entry.url))
  if (unsupported) {
    throw new Error(`${name} references an unsupported artifact: ${unsupported.url}`)
  }
  const entry = manifest.files.find(item => item.url === expectedArtifact.fileName)
  if (!entry) {
    throw new Error(`${name} does not reference ${expectedArtifact.fileName}`)
  }
  if (manifest.path !== undefined && manifest.path !== entry.url) {
    throw new Error(`${name}.path references ${manifest.path}, expected ${entry.url}`)
  }
  if (manifest.sha512 !== undefined && manifest.sha512 !== entry.sha512) {
    throw new Error(`${name} top-level SHA-512 does not match ${entry.url}`)
  }
  return entry
}

function expectedManifestArtifacts(contract: ReleaseContract): Record<(typeof MANIFEST_NAMES)[number], ReleaseArtifactContract> {
  return {
    'latest-mac.yml': contract.artifacts.macosZip,
    'latest-linux.yml': contract.artifacts.linuxAppImage,
  }
}

async function assertRegularFilesOnly(source: string, expected: Set<string>): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  const expectedNames = [...expected].sort()
  if (
    names.length !== expectedNames.length
    || names.some((name, index) => name !== expectedNames[index])
  ) {
    const unexpected = names.filter((name) => !expected.has(name))
    const missing = expectedNames.filter((name) => !names.includes(name))
    throw new Error(
      `Release directory contents do not match the contract; `
      + `missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`,
    )
  }
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error(`Release entry must be a regular file: ${entry.name}`)
  }
}

export async function validateSource(
  source: string,
  expected: Pick<ReleaseArguments, 'version' | 'repository' | 'tag' | 'commitSha'>,
): Promise<ValidatedRelease> {
  const contractPath = join(source, CONTRACT_NAME)
  if (!(await lstat(contractPath)).isFile()) {
    throw new Error('release-contract.json must be a regular file')
  }
  const contract = parseReleaseContract(JSON.parse(await readFile(contractPath, 'utf8')))
  if (contract.schemaVersion !== 2) {
    throw new Error('Release source must use contract schema version 2')
  }
  if (contract.version !== expected.version) {
    throw new Error(`Release contract has version ${contract.version}, expected ${expected.version}`)
  }
  if (
    contract.repository !== expected.repository
    || contract.tag !== expected.tag
    || contract.commitSha !== expected.commitSha
  ) {
    throw new Error('Release contract repository, tag, or commit does not match the deployment')
  }

  const contractArtifacts = [
    ...Object.values(contract.artifacts),
    contract.installApp,
  ]
  const expectedFiles = new Set<string>([
    CONTRACT_NAME,
    ...MANIFEST_NAMES,
    ...contractArtifacts.map((artifact) => artifact.fileName),
  ])
  await assertRegularFilesOnly(source, expectedFiles)

  for (const artifact of contractArtifacts) {
    const path = join(source, artifact.fileName)
    if ((await sha256(path)) !== artifact.sha256) {
      throw new Error(`Release contract has an incorrect SHA-256 for ${artifact.fileName}`)
    }
  }

  const manifestArtifacts = expectedManifestArtifacts(contract)
  const manifests = {} as ValidatedRelease['manifests']
  for (const name of MANIFEST_NAMES) {
    const manifest = asManifest(load(await readFile(join(source, name), 'utf8')), name)
    if (manifest.version !== expected.version) {
      throw new Error(`${name} has version ${manifest.version}, expected ${expected.version}`)
    }
    const expectedArtifact = manifestArtifacts[name]
    manifestEntryForArtifact(manifest, name, expectedArtifact)
    for (const manifestEntry of manifest.files) {
      const artifactPath = join(source, manifestEntry.url)
      const artifactStat = await stat(artifactPath)
      if (!artifactStat.isFile()) throw new Error(`${name} references a non-file artifact: ${manifestEntry.url}`)
      if (artifactStat.size !== manifestEntry.size) throw new Error(`${name} has an incorrect size for ${manifestEntry.url}`)
      if ((await checksum(artifactPath, 'sha512')) !== manifestEntry.sha512) {
        throw new Error(`${name} has an incorrect SHA-512 for ${manifestEntry.url}`)
      }
    }
    manifests[name] = manifest
  }
  return { contract, manifests, files: [...expectedFiles].sort() }
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(entryPath)
    else if (entry.isFile()) total += (await stat(entryPath)).size
    else throw new Error(`Release source contains a non-regular entry: ${entry.name}`)
  }
  return total
}

export function projectedDiskUsage(
  blocks: number,
  freeBlocks: number,
  blockSize: number,
  payloadBytes: number,
): number {
  if (
    !Number.isFinite(blocks)
    || blocks <= 0
    || !Number.isFinite(freeBlocks)
    || !Number.isFinite(blockSize)
    || blockSize <= 0
  ) return 0
  const totalBytes = blocks * blockSize
  const usedBytes = (blocks - freeBlocks) * blockSize
  return (usedBytes + payloadBytes) / totalBytes
}

async function assertDiskCapacity(releasesDir: string, source: string): Promise<void> {
  const [filesystem, payloadBytes] = await Promise.all([statfs(releasesDir), directorySize(source)])
  const usage = projectedDiskUsage(
    Number(filesystem.blocks),
    Number(filesystem.bfree),
    Number(filesystem.bsize),
    payloadBytes,
  )
  if (usage > MAX_DISK_USAGE) {
    throw new Error(
      `Refusing to publish: projected releases volume use is ${Math.ceil(usage * 100)}% `
      + `(limit ${MAX_DISK_USAGE * 100}%)`,
    )
  }
}

async function withPublisherLock<T>(electronRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(electronRoot, LOCK_NAME)
  try {
    await mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Another release operation holds the PVC lock: ${lock}`)
    }
    throw error
  }
  try {
    await writeFile(join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`)
    return await operation()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function inventory(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Published release contains non-file entry: ${entry.name}`)
    result[entry.name] = await sha256(join(path, entry.name))
  }
  return result
}

async function sameContents(left: string, right: string): Promise<boolean> {
  const [leftInventory, rightInventory] = await Promise.all([inventory(left), inventory(right)])
  return JSON.stringify(leftInventory) === JSON.stringify(rightInventory)
}

async function readLatestContract(electronRoot: string): Promise<ParsedReleaseContract | undefined> {
  const latest = join(electronRoot, 'latest')
  try {
    const latestStat = await lstat(latest)
    if (!latestStat.isSymbolicLink()) throw new Error('electron/latest must be a symbolic link')
    const latestRealPath = await realpath(latest)
    const releasesRoot = await realpath(join(electronRoot, 'releases'))
    if (relative(releasesRoot, latestRealPath).startsWith('..')) {
      throw new Error('electron/latest points outside electron/releases')
    }
    return parseReleaseContract(JSON.parse(await readFile(join(latestRealPath, CONTRACT_NAME), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function switchLatest(electronRoot: string, destination: string): Promise<void> {
  const latest = join(electronRoot, 'latest')
  try {
    const existing = await lstat(latest)
    if (!existing.isSymbolicLink()) throw new Error('Refusing to replace non-symlink electron/latest')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(electronRoot, `.latest-${process.pid}-${Date.now()}`)
  await symlink(relative(electronRoot, destination), temporary)
  try {
    await rename(temporary, latest)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

interface RollbackTarget {
  previousTarget: string | null
}

function markerPath(electronRoot: string, state: 'rollback' | 'confirmed' | 'compensated', version: string): string {
  return join(electronRoot, `.${state}-${version}.json`)
}

async function readRollbackTarget(marker: string, version: string): Promise<RollbackTarget> {
  const parsed = JSON.parse(await readFile(marker, 'utf8')) as { previousTarget?: unknown }
  if (parsed.previousTarget !== null && typeof parsed.previousTarget !== 'string') {
    throw new Error(`Rollback marker for ${version} is invalid`)
  }
  if (typeof parsed.previousTarget === 'string') {
    if (!parsed.previousTarget.match(/^releases\/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)) {
      throw new Error(`Rollback marker for ${version} has an unsafe predecessor`)
    }
  }
  return { previousTarget: parsed.previousTarget }
}

async function assertLatestMatchesRollbackTarget(
  electronRoot: string,
  version: string,
  target: RollbackTarget,
): Promise<void> {
  const latestPath = join(electronRoot, 'latest')
  if (target.previousTarget === null) {
    const latest = await lstat(latestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (latest) throw new Error(`Rollback verification failed for ${version}: expected no electron/latest pointer`)
    return
  }
  const latest = await lstat(latestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!latest?.isSymbolicLink() || await readlink(latestPath) !== target.previousTarget) {
    throw new Error(`Rollback verification failed for ${version}: electron/latest is not its exact predecessor`)
  }
}

async function recordRollbackTarget(electronRoot: string, version: string): Promise<void> {
  // Marker lifecycle is deliberately durable across Service Exec boundaries:
  // publish writes .rollback-<version>, confirm renames it to .confirmed, and
  // either marker can compensate an ambiguous caller result back to its exact
  // predecessor before it is removed. This makes retries idempotent.
  const marker = markerPath(electronRoot, 'rollback', version)
  try {
    await lstat(marker)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let previousTarget: string | null = null
  try {
    const latest = join(electronRoot, 'latest')
    const latestStat = await lstat(latest)
    if (!latestStat.isSymbolicLink()) throw new Error('electron/latest must be a symbolic link')
    previousTarget = await readlink(latest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${marker}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ previousTarget })}\n`)
  await rename(temporary, marker)
}

async function protectedReleaseVersions(
  electronRoot: string,
  ignoredMarkers: ReadonlySet<string> = new Set(),
): Promise<Set<string>> {
  const protectedVersions = new Set<string>()
  const latest = await readLatestContract(electronRoot)
  if (latest) protectedVersions.add(latest.version)
  for (const entry of await readdir(electronRoot, { withFileTypes: true })) {
    if (ignoredMarkers.has(entry.name)) continue
    const marker = entry.name.match(ROLLBACK_MARKER_PATTERN)
    if (!marker || !entry.isFile()) continue
    try {
      const parsed = JSON.parse(await readFile(join(electronRoot, entry.name), 'utf8')) as { previousTarget?: unknown }
      if (typeof parsed.previousTarget !== 'string') continue
      const target = parsed.previousTarget.match(/^releases\/(.+)$/)?.[1]
      if (target && isStrictSemver(target)) protectedVersions.add(target)
    } catch {
      // A malformed marker must not cause retention to delete anything.
      return new Set((await readdir(join(electronRoot, 'releases'), { withFileTypes: true }))
        .filter((candidate) => candidate.isDirectory() && isStrictSemver(candidate.name))
        .map((candidate) => candidate.name))
    }
  }
  return protectedVersions
}

async function cleanOldReleases(
  electronRoot: string,
  ignoredMarkers: ReadonlySet<string> = new Set(),
): Promise<void> {
  const releaseRoot = join(electronRoot, 'releases')
  const releases = (await readdir(releaseRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((left, right) => compare(right, left))
  const protectedVersions = await protectedReleaseVersions(electronRoot, ignoredMarkers)
  const retained = new Set(releases.slice(0, KEEP_RELEASES))
  for (const version of protectedVersions) retained.add(version)
  await Promise.all(
    releases.filter((version) => !retained.has(version)).map((version) => rm(join(releaseRoot, version), {
      recursive: true,
      force: true,
    })),
  )
}

async function publishedReleaseVersions(electronRoot: string): Promise<string[]> {
  return (await readdir(join(electronRoot, 'releases'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && isStrictSemver(entry.name))
    .map(entry => entry.name)
}

async function assertSafeInventory(
  electronRoot: string,
  version: string,
  expectedCount?: number,
): Promise<void> {
  const latest = await readLatestContract(electronRoot)
  if (!latest || latest.version !== version) {
    throw new Error(`Cannot verify finalization of ${version}: it is not electron/latest`)
  }
  const releases = await publishedReleaseVersions(electronRoot)
  if (!releases.includes(version)) {
    throw new Error(`Cannot verify finalization of ${version}: latest is missing from release inventory`)
  }
  if (releases.length > KEEP_RELEASES) {
    throw new Error(`Cannot verify finalization of ${version}: expected at most ${KEEP_RELEASES} releases, found ${releases.length}`)
  }
  if (expectedCount !== undefined && releases.length !== expectedCount) {
    throw new Error(`Cannot verify finalization of ${version}: expected exactly ${expectedCount} safe releases, found ${releases.length}`)
  }
}

export async function publish(
  args: ReleaseArguments,
  options: PublisherOptions = {},
): Promise<PublishResult> {
  const source = resolve(args.source)
  const releasesDir = resolve(args.releasesDir)
  await validateSource(source, args)
  const electronRoot = join(releasesDir, 'electron')
  const releaseRoot = join(electronRoot, 'releases')
  await mkdir(releaseRoot, { recursive: true })

  return withPublisherLock(electronRoot, async () => {
    const latestContract = await readLatestContract(electronRoot)
    if (latestContract && compare(args.version, latestContract.version) < 0) {
      throw new Error(
        `Refusing version downgrade from ${latestContract.version} to ${args.version}`,
      )
    }

    const destination = join(releaseRoot, args.version)
    try {
      await lstat(destination)
      if (!(await sameContents(source, destination))) {
        throw new Error(`Release ${args.version} already exists with different contents`)
      }
      // A runner may resume after confirm but before GitHub publication. In
      // that state .confirmed records the only exact predecessor; recreating
      // .rollback from the current latest would replace it with self-history.
      const confirmedMarker = markerPath(electronRoot, 'confirmed', args.version)
      const confirmed = await lstat(confirmedMarker).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (latestContract?.version === args.version && confirmed?.isFile()) {
        return 'idempotent'
      }
      const compensatedMarker = markerPath(electronRoot, 'compensated', args.version)
      const compensated = await lstat(compensatedMarker).then(() => compensatedMarker).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (compensated) {
        // This is a new attempt after an earlier compensation. It may replace
        // the old durable proof only after proving its predecessor is still
        // current; recordRollbackTarget then persists the same new promise.
        await assertLatestMatchesRollbackTarget(electronRoot, args.version, await readRollbackTarget(compensated, args.version))
        await rm(compensated)
      }
      await recordRollbackTarget(electronRoot, args.version)
      await switchLatest(electronRoot, destination)
      return 'idempotent'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    await (options.capacityCheck ?? assertDiskCapacity)(releasesDir, source)
    const staging = join(releaseRoot, `.${args.version}.staging-${process.pid}`)
    await rm(staging, { recursive: true, force: true })
    try {
      await cp(source, staging, { recursive: true, errorOnExist: true, force: false })
      await rename(staging, destination)
      await recordRollbackTarget(electronRoot, args.version)
      await switchLatest(electronRoot, destination)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    return 'published'
  })
}

export async function rollback(releasesDir: string, targetVersion: string): Promise<void> {
  if (!isStrictSemver(targetVersion)) throw new Error('Rollback target must be strict SemVer')
  const electronRoot = join(resolve(releasesDir), 'electron')
  const releaseRoot = join(electronRoot, 'releases')
  await mkdir(releaseRoot, { recursive: true })
  await withPublisherLock(electronRoot, async () => {
    const destination = join(releaseRoot, targetVersion)
    const destinationStat = await stat(destination)
    if (!destinationStat.isDirectory()) throw new Error(`Rollback target is not a directory: ${targetVersion}`)
    const contract = parseReleaseContract(
      JSON.parse(await readFile(join(destination, CONTRACT_NAME), 'utf8')),
    )
    if (contract.version !== targetVersion) {
      throw new Error(`Rollback target contract is for ${contract.version}, not ${targetVersion}`)
    }
    await validateSource(destination, {
      version: contract.version,
      repository: contract.repository,
      tag: contract.tag,
      commitSha: contract.commitSha,
    })
    await switchLatest(electronRoot, destination)
  })
}

export async function confirmRelease(releasesDir: string, version: string): Promise<void> {
  if (!isStrictSemver(version)) throw new Error('Confirmed version must be strict SemVer')
  const electronRoot = join(resolve(releasesDir), 'electron')
  await withPublisherLock(electronRoot, async () => {
    const latest = await readLatestContract(electronRoot)
    if (!latest || latest.version !== version) {
      throw new Error(`Cannot confirm ${version}: it is not electron/latest`)
    }
    const rollbackMarker = markerPath(electronRoot, 'rollback', version)
    const confirmedMarker = markerPath(electronRoot, 'confirmed', version)
    try {
      await rename(rollbackMarker, confirmedMarker)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const confirmed = await lstat(confirmedMarker).catch((confirmedError: NodeJS.ErrnoException) => {
        if (confirmedError.code === 'ENOENT') return undefined
        throw confirmedError
      })
      if (!confirmed?.isFile()) {
        throw new Error(`Cannot confirm ${version}: rollback marker is missing`)
      }
    }
    for (const entry of await readdir(electronRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('.confirmed-') && entry.name !== `.confirmed-${version}.json`) {
        await rm(join(electronRoot, entry.name), { force: true })
      }
    }
    await cleanOldReleases(electronRoot)
  })
}

export async function rollbackFailedRelease(releasesDir: string, version: string): Promise<void> {
  if (!isStrictSemver(version)) throw new Error('Failed version must be strict SemVer')
  const electronRoot = join(resolve(releasesDir), 'electron')
  await withPublisherLock(electronRoot, async () => {
    const latest = await readLatestContract(electronRoot)
    const compensatedMarker = markerPath(electronRoot, 'compensated', version)
    const compensated = await lstat(compensatedMarker).then(() => compensatedMarker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (compensated) {
      // A compensation retry is only safe when the durable predecessor is
      // still the exact pointer.  "not this version" is insufficient: an
      // unrelated manual pointer must fail closed instead of being accepted.
      await assertLatestMatchesRollbackTarget(electronRoot, version, await readRollbackTarget(compensated, version))
      return
    }

    const rollbackMarker = markerPath(electronRoot, 'rollback', version)
    const confirmedMarker = markerPath(electronRoot, 'confirmed', version)
    const marker = await lstat(rollbackMarker).then(() => rollbackMarker).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return lstat(confirmedMarker).then(() => confirmedMarker)
    })
    const target = await readRollbackTarget(marker, version)
    if (!latest || latest.version !== version) {
      throw new Error(`Cannot compensate ${version}: electron/latest changed before rollback`)
    }
    if (target.previousTarget === null) {
      const latestPath = join(electronRoot, 'latest')
      const latestStat = await lstat(latestPath)
      if (!latestStat.isSymbolicLink()) throw new Error('electron/latest must be a symbolic link')
      await rm(latestPath)
    } else {
      const targetPath = resolve(electronRoot, target.previousTarget)
      const releaseRoot = await realpath(join(electronRoot, 'releases'))
      const targetRealPath = await realpath(targetPath)
      if (relative(releaseRoot, targetRealPath).startsWith('..')) {
        throw new Error('Recorded rollback target points outside electron/releases')
      }
      const contract = parseReleaseContract(
        JSON.parse(await readFile(join(targetRealPath, CONTRACT_NAME), 'utf8')),
      )
      await validateSource(targetRealPath, {
        version: contract.version,
        repository: contract.repository,
        tag: contract.tag,
        commitSha: contract.commitSha,
      })
      await switchLatest(electronRoot, targetPath)
    }
    await assertLatestMatchesRollbackTarget(electronRoot, version, target)
    // Keep the exact predecessor under lock after the switch.  Retries and
    // the workflow composite can therefore prove restoration, including the
    // bootstrap case where the only correct result is no latest symlink.
    await rename(marker, compensatedMarker)
  })
}

export async function finalizeRelease(
  releasesDir: string,
  version: string,
  options: FinalizeOptions = {},
): Promise<void> {
  if (!isStrictSemver(version)) throw new Error('Finalized version must be strict SemVer')
  const electronRoot = join(resolve(releasesDir), 'electron')
  await withPublisherLock(electronRoot, async () => {
    const latest = await readLatestContract(electronRoot)
    if (!latest || latest.version !== version) {
      throw new Error(`Cannot finalize ${version}: it is not electron/latest`)
    }
    const confirmedMarkerName = `.confirmed-${version}.json`
    const confirmedMarker = join(electronRoot, confirmedMarkerName)
    const confirmed = await lstat(confirmedMarker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!confirmed) {
      // A completed finalization is idempotent, but a missing marker before
      // retention is never silently treated as permission to discard history.
      await assertFinalizedLocked(electronRoot, version)
      return
    }
    // Retention intentionally ignores only this marker while it remains on
    // disk. If cleanup fails, the marker still preserves the exact rollback
    // predecessor and a later finalize can retry safely.
    const ignoredMarkers = new Set([confirmedMarkerName])
    const expectedInventoryCount = Math.min(KEEP_RELEASES, (await publishedReleaseVersions(electronRoot)).length)
    await (options.retentionCleanup ?? cleanOldReleases)(electronRoot, ignoredMarkers)
    await assertSafeInventory(electronRoot, version, expectedInventoryCount)
    await (options.markerCleanup ?? (async marker => rm(marker, { force: true })))(confirmedMarker)
    const remaining = await lstat(confirmedMarker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (remaining) throw new Error(`Cannot finalize ${version}: confirmation marker cleanup failed`)
  })
}

export async function assertConfirmedRelease(releasesDir: string, version: string): Promise<void> {
  if (!isStrictSemver(version)) throw new Error('Confirmed version must be strict SemVer')
  const electronRoot = join(resolve(releasesDir), 'electron')
  const latest = await readLatestContract(electronRoot)
  if (!latest || latest.version !== version) {
    throw new Error(`Cannot verify ${version}: it is not electron/latest`)
  }
  const marker = await lstat(join(electronRoot, `.confirmed-${version}.json`))
  if (!marker.isFile()) throw new Error(`Cannot verify ${version}: confirmation marker is missing`)
}

export async function assertFinalizedRelease(releasesDir: string, version: string): Promise<void> {
  if (!isStrictSemver(version)) throw new Error('Finalized version must be strict SemVer')
  const electronRoot = join(resolve(releasesDir), 'electron')
  await withPublisherLock(electronRoot, async () => {
    await assertFinalizedLocked(electronRoot, version)
  })
}

async function assertFinalizedLocked(electronRoot: string, version: string): Promise<void> {
  const entries = await readdir(electronRoot, { withFileTypes: true })
  const staleMarkers = entries
    .filter(entry => entry.isFile() && ROLLBACK_MARKER_PATTERN.test(entry.name))
    .map(entry => entry.name)
  if (staleMarkers.length > 0) {
    throw new Error(`Cannot verify finalization of ${version}: stale rollback markers remain: ${staleMarkers.join(', ')}`)
  }
  await assertSafeInventory(electronRoot, version)
}

export async function assertNotLatest(releasesDir: string, version: string): Promise<void> {
  if (!isStrictSemver(version)) throw new Error('Version must be strict SemVer')
  const latest = await readLatestContract(join(resolve(releasesDir), 'electron'))
  if (latest?.version === version) {
    throw new Error(`Rollback verification failed: ${version} is still electron/latest`)
  }
}

export async function assertRollbackTarget(releasesDir: string, version: string): Promise<void> {
  if (!isStrictSemver(version)) throw new Error('Version must be strict SemVer')
  const electronRoot = join(resolve(releasesDir), 'electron')
  await withPublisherLock(electronRoot, async () => {
    const marker = markerPath(electronRoot, 'compensated', version)
    await lstat(marker)
    await assertLatestMatchesRollbackTarget(electronRoot, version, await readRollbackTarget(marker, version))
  })
}

function required(values: Record<string, string | undefined>, key: string): string {
  const value = values[key]
  if (!value) throw new Error(`Missing --${key}`)
  return value
}

async function main(): Promise<void> {
  const [command = 'publish', ...argv] = process.argv.slice(2)
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      'releases-dir': { type: 'string' },
      version: { type: 'string' },
      repository: { type: 'string' },
      tag: { type: 'string' },
      commit: { type: 'string' },
    },
    strict: true,
  })
  if (command === 'publish') {
    const version = required(values, 'version')
    const result = await publish({
      source: required(values, 'source'),
      releasesDir: required(values, 'releases-dir'),
      version,
      repository: required(values, 'repository'),
      tag: required(values, 'tag'),
      commitSha: required(values, 'commit').toLowerCase(),
    })
    console.log(`Release ${version}: ${result}`)
    return
  }
  if (command === 'rollback') {
    const version = required(values, 'version')
    await rollback(required(values, 'releases-dir'), version)
    console.log(`electron/latest now points to ${version}`)
    return
  }
  if (command === 'confirm') {
    const version = required(values, 'version')
    await confirmRelease(required(values, 'releases-dir'), version)
    console.log(`Release ${version} confirmed`)
    return
  }
  if (command === 'rollback-failed') {
    const version = required(values, 'version')
    await rollbackFailedRelease(required(values, 'releases-dir'), version)
    console.log(`Failed release ${version} rolled back`)
    return
  }
  if (command === 'assert-confirmed') {
    const version = required(values, 'version')
    await assertConfirmedRelease(required(values, 'releases-dir'), version)
    console.log(`Release ${version} is confirmed`)
    return
  }
  if (command === 'finalize') {
    const version = required(values, 'version')
    await finalizeRelease(required(values, 'releases-dir'), version)
    console.log(`Release ${version} finalized`)
    return
  }
  if (command === 'assert-finalized') {
    const version = required(values, 'version')
    await assertFinalizedRelease(required(values, 'releases-dir'), version)
    console.log(`Release ${version} is finalized`)
    return
  }
  if (command === 'assert-not-latest') {
    const version = required(values, 'version')
    await assertNotLatest(required(values, 'releases-dir'), version)
    console.log(`Release ${version} is no longer electron/latest`)
    return
  }
  if (command === 'assert-rollback-target') {
    const version = required(values, 'version')
    await assertRollbackTarget(required(values, 'releases-dir'), version)
    console.log(`Rollback predecessor for ${version} is restored exactly`)
    return
  }
  throw new Error('Usage: publisher <publish|rollback|confirm|rollback-failed|finalize|assert-confirmed|assert-finalized|assert-not-latest|assert-rollback-target> [options]')
}

if (import.meta.main) await main()
