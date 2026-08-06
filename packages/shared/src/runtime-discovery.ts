import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getProcessInstanceFingerprint } from './utils/files'

export const RUNTIME_DISCOVERY_SCHEMA_VERSION = 2

export interface ElectronRuntimeDiscovery {
  schemaVersion: typeof RUNTIME_DISCOVERY_SCHEMA_VERSION
  pid: number
  instanceId: string
  url: string
  token: string
  version: string
  startedAt: string
}

export type RuntimeDiscoveryErrorCode =
  | 'directory_owner'
  | 'directory_permissions'
  | 'file_owner'
  | 'file_permissions'
  | 'invalid_json'
  | 'unsafe_schema'
  | 'process_unavailable'
  | 'version_incompatible'

export interface RuntimeDiscoveryErrorParams {
  pid?: number
  cliVersion?: string
  appVersion?: string
}

interface RuntimeDiscoveryFailure {
  path: string
  errorCode: RuntimeDiscoveryErrorCode
  errorParams?: RuntimeDiscoveryErrorParams
}

export type RuntimeDiscoveryResult =
  | { status: 'available'; record: ElectronRuntimeDiscovery; path: string }
  | { status: 'missing'; path: string }
  | ({ status: 'stale' } & RuntimeDiscoveryFailure)
  | ({ status: 'invalid' } & RuntimeDiscoveryFailure)
  | ({ status: 'incompatible'; record: ElectronRuntimeDiscovery } & RuntimeDiscoveryFailure)

export function getElectronRuntimeDiscoveryPath(options?: {
  platform?: NodeJS.Platform
  homeDir?: string
  localAppData?: string
}): string {
  if (process.env.POLO_AI_RUNTIME_DISCOVERY_FILE) {
    return process.env.POLO_AI_RUNTIME_DISCOVERY_FILE
  }

  const platform = options?.platform ?? process.platform
  if (platform === 'win32') {
    const base = options?.localAppData ?? process.env.LOCALAPPDATA
    if (!base) {
      throw new Error('LOCALAPPDATA is required to locate the Polo runtime file')
    }
    return join(base, 'Polo AI', 'runtime', 'electron.json')
  }

  return join(options?.homeDir ?? homedir(), '.polo-ai', 'runtime', 'electron.json')
}

export function getMajorVersion(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim())
  return match ? Number(match[1]) : null
}

export function areMajorVersionsCompatible(left: string, right: string): boolean {
  const leftMajor = getMajorVersion(left)
  const rightMajor = getMajorVersion(right)
  return leftMajor !== null && rightMajor !== null && leftMajor === rightMajor
}

function isLoopbackWebSocketUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false
    return parsed.hostname === '127.0.0.1'
      || parsed.hostname === 'localhost'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is ElectronRuntimeDiscovery {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ElectronRuntimeDiscovery>
  return record.schemaVersion === RUNTIME_DISCOVERY_SCHEMA_VERSION
    && Number.isSafeInteger(record.pid)
    && (record.pid ?? 0) > 0
    && typeof record.instanceId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.instanceId)
    && typeof record.url === 'string'
    && isLoopbackWebSocketUrl(record.url)
    && typeof record.token === 'string'
    && record.token.length >= 16
    && typeof record.version === 'string'
    && getMajorVersion(record.version) !== null
    && typeof record.startedAt === 'string'
    && !Number.isNaN(Date.parse(record.startedAt))
}

const WINDOWS_PROCESS_OWNER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:POLO_AI_RUNTIME_PID
$expectedStartedAt = [DateTimeOffset]::Parse($env:POLO_AI_RUNTIME_STARTED_AT).UtcDateTime
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$target = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $targetPid)
if ($null -eq $target) { exit 2 }
$owner = Invoke-CimMethod -InputObject $target -MethodName GetOwnerSid
if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)) { exit 3 }
if ($owner.Sid -cne $currentSid) { exit 4 }
if ($target.CreationDate.ToUniversalTime() -gt $expectedStartedAt) { exit 5 }
[Console]::Out.Write('owned')
`

export function isWindowsProcessOwnedByCurrentUser(pid: number, startedAt: string): boolean {
  const powershell = process.env.SystemRoot
    ? join(
        process.env.SystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : 'powershell.exe'
  try {
    const result = spawnSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_PROCESS_OWNER_SCRIPT,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          POLO_AI_RUNTIME_PID: String(pid),
          POLO_AI_RUNTIME_STARTED_AT: startedAt,
        },
        timeout: 5_000,
        windowsHide: true,
      },
    )
    return result.status === 0 && result.stdout.trim() === 'owned'
  } catch {
    return false
  }
}

function isProcessAliveAndOwned(
  pid: number,
  startedAt: string,
  options?: {
    platform?: NodeJS.Platform
    windowsProcessOwner?: (pid: number, startedAt: string) => boolean
  },
): boolean {
  const platform = options?.platform ?? process.platform
  if (platform === 'win32') {
    // Windows process.kill(pid, 0) does not establish user ownership. Resolve
    // both SIDs and the target creation time through the OS. The latter rejects
    // a live same-user process that reused the stale Electron PID.
    return (options?.windowsProcessOwner ?? isWindowsProcessOwnedByCurrentUser)(pid, startedAt)
  }

  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  // Linux exposes process ownership without invoking a shell. On macOS,
  // process.kill(pid, 0) already rejects another user's process with EPERM.
  if (platform === 'linux' && typeof process.getuid === 'function') {
    try {
      return statSync(`/proc/${pid}`).uid === process.getuid()
    } catch {
      return false
    }
  }

  return true
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function recordsHaveSameIdentity(
  left: ElectronRuntimeDiscovery,
  right: ElectronRuntimeDiscovery,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.pid === right.pid
    && left.instanceId === right.instanceId
    && left.startedAt === right.startedAt
    && left.url === right.url
    && left.token === right.token
    && left.version === right.version
}

const CLEANUP_CLAIM_MARKER = '.cleanup.'

function cleanupClaimPrefix(path: string): string {
  return `.${basename(path)}${CLEANUP_CLAIM_MARKER}`
}

function fingerprintHash(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function cleanupClaimOwnerIsActive(
  claimName: string,
  prefix: string,
): boolean {
  if (!claimName.startsWith(prefix)) return true
  const [pidText, expectedFingerprint] = claimName.slice(prefix.length).split('.')
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid <= 0 || !expectedFingerprint) return true
  if (!processExists(pid)) return false
  if (expectedFingerprint === 'unknown') return true
  const actualFingerprint = getProcessInstanceFingerprint(pid)
  return actualFingerprint === null
    || fingerprintHash(actualFingerprint) === expectedFingerprint
}

function listCleanupClaims(path: string): Array<{
  path: string
  name: string
  mtimeMs: number
}> {
  const parent = dirname(path)
  const prefix = cleanupClaimPrefix(path)
  try {
    return readdirSync(parent)
      .filter(name => name.startsWith(prefix))
      .map(name => {
        const claimPath = join(parent, name)
        let mtimeMs = 0
        try {
          mtimeMs = statSync(claimPath).mtimeMs
        } catch {
          // A concurrent cleanup completed between readdir and stat.
        }
        return { path: claimPath, name, mtimeMs }
      })
  } catch {
    return []
  }
}

function restoreClaimWithoutOverwrite(claimPath: string, path: string): boolean {
  if (!existsSync(claimPath)) return existsSync(path)
  try {
    // A hard link atomically restores the claimed file only when canonical is
    // absent. Unlike rename, it can never overwrite a newer publication.
    linkSync(claimPath, path)
    removeIfPresent(claimPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || existsSync(path)) {
      // A newer canonical record supersedes this claimed record.
      removeIfPresent(claimPath)
      return true
    }
    // Preserve the claim for a later reader rather than losing the record.
    return false
  }
}

/**
 * Recover a record left in quarantine when a cleanup process exited after its
 * atomic claim. A live cleanup owner is never disturbed. When several dead
 * claims exist, the newest is restored and older claims are superseded.
 */
function recoverAbandonedCleanupClaims(path: string): void {
  const prefix = cleanupClaimPrefix(path)
  const claims = listCleanupClaims(path)
  if (claims.some(claim => cleanupClaimOwnerIsActive(claim.name, prefix))) return

  const abandoned = claims.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const claim of abandoned) {
    if (existsSync(path)) {
      removeIfPresent(claim.path)
      continue
    }
    restoreClaimWithoutOverwrite(claim.path, path)
  }
}

export interface ElectronRuntimeDiscoveryWriteResult {
  path: string
  record: ElectronRuntimeDiscovery
}

export function writeElectronRuntimeDiscovery(
  input: Omit<
    ElectronRuntimeDiscovery,
    'schemaVersion' | 'instanceId' | 'startedAt'
  > & {
    instanceId?: string
    startedAt?: string
  },
  options?: { path?: string },
): ElectronRuntimeDiscoveryWriteResult {
  const path = options?.path ?? getElectronRuntimeDiscoveryPath()
  const runtimeDir = dirname(path)
  const record: ElectronRuntimeDiscovery = {
    schemaVersion: RUNTIME_DISCOVERY_SCHEMA_VERSION,
    pid: input.pid,
    instanceId: input.instanceId ?? randomUUID(),
    url: input.url,
    token: input.token,
    version: input.version,
    startedAt: input.startedAt ?? new Date().toISOString(),
  }

  if (!isRecord(record)) {
    throw new Error('Refusing to write invalid Electron runtime discovery data')
  }

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(runtimeDir, 0o700)
  recoverAbandonedCleanupClaims(path)

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    if (process.platform !== 'win32') chmodSync(tempPath, 0o600)
    renameSync(tempPath, path)
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } finally {
    removeIfPresent(tempPath)
  }

  // The newly published canonical record supersedes any cleanup process that
  // exited while holding an older record in quarantine.
  recoverAbandonedCleanupClaims(path)
  return { path, record }
}

export function readElectronRuntimeDiscovery(options?: {
  path?: string
  expectedVersion?: string
  cleanupStale?: boolean
  platform?: NodeJS.Platform
  windowsProcessOwner?: (pid: number, startedAt: string) => boolean
}): RuntimeDiscoveryResult {
  const path = options?.path ?? getElectronRuntimeDiscoveryPath()
  recoverAbandonedCleanupClaims(path)
  if (!existsSync(path)) return { status: 'missing', path }

  const platform = options?.platform ?? process.platform
  if (platform !== 'win32' && typeof process.getuid === 'function') {
    const stats = statSync(path)
    const directoryStats = statSync(dirname(path))
    if (directoryStats.uid !== process.getuid()) {
      return { status: 'invalid', path, errorCode: 'directory_owner' }
    }
    if ((directoryStats.mode & 0o077) !== 0) {
      return { status: 'invalid', path, errorCode: 'directory_permissions' }
    }
    if (stats.uid !== process.getuid()) {
      return { status: 'invalid', path, errorCode: 'file_owner' }
    }
    if ((stats.mode & 0o077) !== 0) {
      return { status: 'invalid', path, errorCode: 'file_permissions' }
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { status: 'invalid', path, errorCode: 'invalid_json' }
  }

  if (!isRecord(parsed)) {
    return { status: 'invalid', path, errorCode: 'unsafe_schema' }
  }

  if (!isProcessAliveAndOwned(parsed.pid, parsed.startedAt, {
    platform,
    windowsProcessOwner: options?.windowsProcessOwner,
  })) {
    if (options?.cleanupStale) {
      removeElectronRuntimeDiscovery({ path, expectedRecord: parsed })
    }
    return {
      status: 'stale',
      path,
      errorCode: 'process_unavailable',
      errorParams: { pid: parsed.pid },
    }
  }

  if (options?.expectedVersion && !areMajorVersionsCompatible(parsed.version, options.expectedVersion)) {
    return {
      status: 'incompatible',
      path,
      record: parsed,
      errorCode: 'version_incompatible',
      errorParams: {
        cliVersion: options.expectedVersion,
        appVersion: parsed.version,
      },
    }
  }

  return { status: 'available', path, record: parsed }
}

export interface RuntimeDiscoveryCleanupTestHooks {
  afterClaim?: (claimPath: string) => void
}

export function removeElectronRuntimeDiscovery(options: {
  path?: string
  expectedRecord: ElectronRuntimeDiscovery
  hooks?: RuntimeDiscoveryCleanupTestHooks
}): boolean {
  const path = options?.path ?? getElectronRuntimeDiscoveryPath()
  recoverAbandonedCleanupClaims(path)
  if (!existsSync(path)) return false

  const processFingerprint = getProcessInstanceFingerprint()
  const claimOwnerFingerprint = processFingerprint
    ? fingerprintHash(processFingerprint)
    : 'unknown'
  const claimPath = join(
    dirname(path),
    `${cleanupClaimPrefix(path)}${process.pid}.${claimOwnerFingerprint}.${randomUUID()}`,
  )
  try {
    renameSync(path, claimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }

  try {
    options.hooks?.afterClaim?.(claimPath)
    let claimed: unknown
    try {
      claimed = JSON.parse(readFileSync(claimPath, 'utf8'))
    } catch {
      claimed = null
    }

    if (isRecord(claimed) && recordsHaveSameIdentity(claimed, options.expectedRecord)) {
      removeIfPresent(claimPath)
      return true
    }

    // The canonical path changed after the caller read its expected record.
    // Restore the claimed replacement only if no still-newer canonical record
    // exists; never overwrite a concurrent Electron publication.
    restoreClaimWithoutOverwrite(claimPath, path)
    return false
  } catch (error) {
    restoreClaimWithoutOverwrite(claimPath, path)
    throw error
  }
}
