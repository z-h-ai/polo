import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const RUNTIME_DISCOVERY_SCHEMA_VERSION = 1

export interface ElectronRuntimeDiscovery {
  schemaVersion: typeof RUNTIME_DISCOVERY_SCHEMA_VERSION
  pid: number
  url: string
  token: string
  version: string
  startedAt: string
}

export type RuntimeDiscoveryResult =
  | { status: 'available'; record: ElectronRuntimeDiscovery; path: string }
  | { status: 'missing'; path: string }
  | { status: 'stale'; path: string; reason: string }
  | { status: 'invalid'; path: string; reason: string }
  | { status: 'incompatible'; path: string; reason: string; record: ElectronRuntimeDiscovery }

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
    && typeof record.url === 'string'
    && isLoopbackWebSocketUrl(record.url)
    && typeof record.token === 'string'
    && record.token.length >= 16
    && typeof record.version === 'string'
    && getMajorVersion(record.version) !== null
    && typeof record.startedAt === 'string'
    && !Number.isNaN(Date.parse(record.startedAt))
}

function isProcessAliveAndOwned(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  // Linux exposes process ownership without invoking a shell. On macOS,
  // process.kill(pid, 0) already rejects another user's process with EPERM.
  if (process.platform === 'linux' && typeof process.getuid === 'function') {
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

export function writeElectronRuntimeDiscovery(
  input: Omit<ElectronRuntimeDiscovery, 'schemaVersion' | 'startedAt'> & { startedAt?: string },
  options?: { path?: string },
): string {
  const path = options?.path ?? getElectronRuntimeDiscoveryPath()
  const runtimeDir = dirname(path)
  const record: ElectronRuntimeDiscovery = {
    schemaVersion: RUNTIME_DISCOVERY_SCHEMA_VERSION,
    pid: input.pid,
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

  const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
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

  return path
}

export function readElectronRuntimeDiscovery(options?: {
  path?: string
  expectedVersion?: string
  cleanupStale?: boolean
}): RuntimeDiscoveryResult {
  const path = options?.path ?? getElectronRuntimeDiscoveryPath()
  if (!existsSync(path)) return { status: 'missing', path }

  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    const stats = statSync(path)
    const directoryStats = statSync(dirname(path))
    if (directoryStats.uid !== process.getuid()) {
      return { status: 'invalid', path, reason: 'Runtime directory is not owned by the current user' }
    }
    if ((directoryStats.mode & 0o077) !== 0) {
      return { status: 'invalid', path, reason: 'Runtime directory permissions must be 0700' }
    }
    if (stats.uid !== process.getuid()) {
      return { status: 'invalid', path, reason: 'Runtime file is not owned by the current user' }
    }
    if ((stats.mode & 0o077) !== 0) {
      return { status: 'invalid', path, reason: 'Runtime file permissions must be 0600' }
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { status: 'invalid', path, reason: 'Runtime file is not valid JSON' }
  }

  if (!isRecord(parsed)) {
    return { status: 'invalid', path, reason: 'Runtime file has an unsupported or unsafe schema' }
  }

  if (!isProcessAliveAndOwned(parsed.pid)) {
    if (options?.cleanupStale) {
      removeElectronRuntimeDiscovery({ path, expectedPid: parsed.pid })
    }
    return { status: 'stale', path, reason: `Electron process ${parsed.pid} is not running` }
  }

  if (options?.expectedVersion && !areMajorVersionsCompatible(parsed.version, options.expectedVersion)) {
    return {
      status: 'incompatible',
      path,
      record: parsed,
      reason: `Polo CLI ${options.expectedVersion} is not compatible with Polo App ${parsed.version}`,
    }
  }

  return { status: 'available', path, record: parsed }
}

export function removeElectronRuntimeDiscovery(options?: {
  path?: string
  expectedPid?: number
}): boolean {
  const path = options?.path ?? getElectronRuntimeDiscoveryPath()
  if (!existsSync(path)) return false

  if (options?.expectedPid !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ElectronRuntimeDiscovery>
      if (parsed.pid !== options.expectedPid) return false
    } catch {
      return false
    }
  }

  removeIfPresent(path)
  return true
}
