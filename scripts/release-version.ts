import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const VERSION_FILES = [
  'package.json',
  'apps/electron/package.json',
  'apps/cli/package.json',
  'packages/server/package.json',
] as const

const LOCKFILE = 'bun.lock'
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

type PackageJson = {
  name?: string
  version?: unknown
  [key: string]: unknown
}

export type LockfileVersions = Partial<Record<(typeof VERSION_FILES)[number], string>>

export type VersionCommandOptions = {
  refreshLockfile?: (root: string) => void
}

function fail(message: string): never {
  throw new Error(message)
}

export function normalizeTag(input: string): { tag: string; version: string } {
  const value = input.trim()
  if (value !== input || value.length === 0) fail('Version is required')
  const version = value.startsWith('v') ? value.slice(1) : value
  if (!SEMVER.test(version)) fail(`Invalid strict SemVer: ${input}`)
  return { tag: `v${version}`, version }
}

function packagePath(root: string, relativePath: string): string {
  return join(root, relativePath)
}

function readPackage(root: string, relativePath: string): PackageJson {
  const path = packagePath(root, relativePath)
  if (!existsSync(path)) fail(`Required version file is missing: ${relativePath}`)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${relativePath} must contain a JSON object`)
  return value as PackageJson
}

function packageVersions(root: string): Record<(typeof VERSION_FILES)[number], string> {
  return Object.fromEntries(VERSION_FILES.map((relativePath) => {
    const pkg = readPackage(root, relativePath)
    if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
      fail(`${relativePath} has an invalid strict SemVer: ${String(pkg.version)}`)
    }
    return [relativePath, pkg.version]
  })) as Record<(typeof VERSION_FILES)[number], string>
}

function lockWorkspaceBlock(lockfile: string, workspace: string): string {
  const marker = `    "${workspace}": {`
  const start = lockfile.indexOf(marker)
  if (start < 0) fail(`bun.lock is missing workspace: ${workspace}`)
  const next = lockfile.indexOf('\n    "', start + marker.length)
  return lockfile.slice(start, next < 0 ? lockfile.length : next)
}

function setLockWorkspaceVersion(lockfile: string, workspace: string, version: string): string {
  const marker = `    "${workspace}": {`
  const start = lockfile.indexOf(marker)
  if (start < 0) fail(`bun.lock is missing workspace: ${workspace}`)
  const block = lockWorkspaceBlock(lockfile, workspace)
  const match = block.match(/^\s{6}"version":\s*"([^"]+)"/m)
  if (!match || match.index === undefined) fail(`bun.lock workspace ${workspace} is missing a version`)
  const absolute = start + match.index + match[0].indexOf(match[1])
  return `${lockfile.slice(0, absolute)}${version}${lockfile.slice(absolute + match[1].length)}`
}

function synchronizeLockfileWorkspaceVersions(root: string, version: string): void {
  const path = packagePath(root, LOCKFILE)
  let lockfile = readFileSync(path, 'utf8')
  for (const relativePath of VERSION_FILES) {
    if (relativePath === 'package.json') continue
    lockfile = setLockWorkspaceVersion(lockfile, dirname(relativePath), version)
  }
  writeFileSync(path, lockfile)
}

export function readLockfileVersions(root: string): LockfileVersions {
  const path = packagePath(root, LOCKFILE)
  if (!existsSync(path)) fail('bun.lock is missing')
  const lockfile = readFileSync(path, 'utf8')
  return Object.fromEntries(VERSION_FILES.map((relativePath) => {
    // Bun does not record the root package's version in bun.lock; the three
    // non-root workspace entries do carry it and are checked below.
    if (relativePath === 'package.json') return undefined
    const workspace = dirname(relativePath)
    const block = lockWorkspaceBlock(lockfile, workspace)
    const match = block.match(/^\s{6}"version":\s*"([^"]+)"/m)
    if (!match) fail(`bun.lock workspace ${workspace || '(root)'} is missing a version`)
    return [relativePath, match[1]]
  }).filter((entry): entry is [string, string] => entry !== undefined)) as LockfileVersions
}

function assertVersionsMatch(expectedTag: string, versions: Record<string, string>): void {
  const { tag, version } = normalizeTag(expectedTag)
  const entries = Object.entries(versions)
  const invalid = entries.filter(([, value]) => !SEMVER.test(value))
  if (invalid.length > 0) {
    fail(`Invalid package version(s): ${invalid.map(([path, value]) => `${path}=${value}`).join(', ')}`)
  }
  const mismatched = entries.filter(([, value]) => value !== version)
  if (mismatched.length > 0) {
    fail(`Version mismatch for ${tag}: expected ${version}; ${mismatched.map(([path, value]) => `${path}=${value}`).join(', ')}`)
  }
}

export function checkReleaseVersion(root: string, expectedTag: string): void {
  const packages = packageVersions(root)
  assertVersionsMatch(expectedTag, packages)
  const lockfile = readLockfileVersions(root)
  assertVersionsMatch(expectedTag, lockfile)
  console.log(`Release version check passed: ${normalizeTag(expectedTag).tag}`)
}

function writePackageVersion(path: string, version: string): void {
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as PackageJson
  pkg.version = version
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

function defaultRefreshLockfile(root: string): void {
  execFileSync('bun', ['install', '--lockfile-only'], {
    cwd: root,
    stdio: 'inherit',
  })
}

function restoreFiles(backups: Map<string, string>, root: string, lockBackup: string | undefined): void {
  for (const [relativePath, backupPath] of backups) {
    copyFileSync(backupPath, packagePath(root, relativePath))
    rmSync(backupPath, { force: true })
  }
  if (lockBackup !== undefined) {
    copyFileSync(lockBackup, packagePath(root, LOCKFILE))
    rmSync(lockBackup, { force: true })
  }
}

export function setReleaseVersion(rootInput: string, expectedTag: string, options: VersionCommandOptions = {}): void {
  const root = resolve(rootInput)
  const { tag, version } = normalizeTag(expectedTag)
  const backups = new Map<string, string>()
  const tempDir = mkdtempSync(join(tmpdir(), 'polo-release-version-'))
  let lockBackup: string | undefined
  try {
    for (const relativePath of VERSION_FILES) {
      const path = packagePath(root, relativePath)
      readPackage(root, relativePath)
      const backupPath = join(tempDir, relativePath.replaceAll('/', '__'))
      copyFileSync(path, backupPath)
      backups.set(relativePath, backupPath)
    }
    const lockPath = packagePath(root, LOCKFILE)
    if (!existsSync(lockPath)) fail('bun.lock is missing')
    lockBackup = join(tempDir, 'bun.lock')
    copyFileSync(lockPath, lockBackup)

    for (const relativePath of VERSION_FILES) writePackageVersion(packagePath(root, relativePath), version)
    ;(options.refreshLockfile ?? defaultRefreshLockfile)(root)
    // Bun regenerates dependency data but may retain stale workspace metadata;
    // synchronize the three workspace version records before the final check.
    synchronizeLockfileWorkspaceVersions(root, version)
    checkReleaseVersion(root, tag)
  } catch (error) {
    restoreFiles(backups, root, lockBackup)
    throw error
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  console.log(`Release version set: ${tag}`)
}

function usage(): never {
  console.error('Usage: bun run scripts/release-version.ts <set|check> -- <vX.Y.Z>')
  process.exit(2)
}

if (import.meta.main) {
  const command = process.argv[2]
  const input = process.argv[3] === '--' ? process.argv[4] : process.argv[3]
  if ((command !== 'set' && command !== 'check') || !input) usage()
  try {
    if (command === 'set') setReleaseVersion(join(import.meta.dir, '..'), input)
    else checkReleaseVersion(join(import.meta.dir, '..'), input)
  } catch (error) {
    console.error(`Release version check failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
