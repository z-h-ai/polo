import { createHash, randomUUID } from 'crypto'
import { constants as fsConstants, createReadStream, existsSync } from 'fs'
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import {
  createServer as createHttpServer,
  get as httpGet,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'http'
import { createServer as createNetServer } from 'net'
import { arch as hostArch, platform as hostPlatform } from 'os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { LOCAL_APP_INSTALL_OPERATION_TIMEOUT_MS } from '@polo-ai/shared/protocol'
import type {
  LocalAppArchitecture,
  LocalAppAvailableRelease,
  LocalAppErrorPayload,
  LocalAppInstallProgress,
  LocalAppInstallRequest,
  LocalAppInstalledApp,
  LocalAppLifecycleStatus,
  LocalAppLogsOptions,
  LocalAppPlatform,
  LocalAppRuntimeStatus,
  LocalAppStartResult,
  LocalAppUninstallOptions,
  PoloAppManifest,
} from '@polo-ai/shared/protocol'
import { extractBundleArchive } from './archive'
import { BoundedLogWriter } from './bounded-log'
import { assertSafeRelativePath, validatePoloAppManifest } from './manifest'
import {
  createWindowsJobObjectOwner,
  createWindowsProcessTreeOwner,
  type WindowsJobObjectOwner,
  type WindowsProcessTreeOwner,
} from './process-tree'
import { asLocalAppRuntimeError, LocalAppRuntimeError } from './runtime-error'

const METADATA_SCHEMA_VERSION = 1
const DEFAULT_START_TIMEOUT_MS = 30_000
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const INSTALL_COMMAND_TIMEOUT_MS = 10 * 60_000
const STOP_GRACE_MS = 3_000
const MAX_LOG_TAIL = 10_000
const MAX_STATIC_CONCURRENT_STREAMS = 32
const MAX_STATIC_ASSET_BYTES = 256 * 1024 * 1024
const POST_HEALTH_STABILITY_MS = 50
const SHUTDOWN_FORCE_RETRY_DELAY_MS = 100
const MAX_FORCE_CLEANUP_ATTEMPTS = 2
const HEALTH_OWNERSHIP_HEADER = 'x-polo-app-health-token'
const RUNTIME_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // Windows needs these to locate core system DLLs and spawn child processes.
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
] as const

interface InstalledVersionRecord {
  manifest: PoloAppManifest
  installedAt: number
  checksum: string
}

interface AppMetadata {
  schemaVersion: 1
  appId: string
  currentVersion: string
  previousVersion?: string
  lastKnownGoodVersion?: string
  versions: Record<string, InstalledVersionRecord>
  brokenVersions?: Record<string, LocalAppErrorPayload>
  availableRelease?: LocalAppAvailableRelease
}

interface ManagedRuntime {
  appId: string
  version: string
  manifest: PoloAppManifest
  port: number
  url: string
  child?: ChildProcess
  server?: HttpServer
  healthy: boolean
  stopRequested: boolean
  stopPromise?: Promise<void>
  cleanupPromise?: Promise<void>
  managedProcess?: ManagedProcessOperation
  processTreeOwner?: WindowsJobObjectOwner | WindowsProcessTreeOwner
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  spawnError?: Error
  healthToken: string
}

type ActiveReleaseIdentity = Pick<
  LocalAppInstallRequest,
  'appId' | 'version' | 'checksum' | 'sizeBytes' | 'platform' | 'arch'
>

interface ActiveInstall {
  identity: ActiveReleaseIdentity
  controller: AbortController
  promise: Promise<LocalAppInstalledApp>
}

interface ManagedProcessOperation {
  id: string
  appId: string
  kind: 'dependency-preparation' | 'runtime'
  child: ChildProcess
  processTreeOwner?: WindowsJobObjectOwner | WindowsProcessTreeOwner
  /** False only while a Windows launch gate has not entered its Job Object. */
  processTreeOwnerAssigned?: boolean
  cleanupPromise?: Promise<void>
  lastCleanupError?: unknown
}

interface TrackedLifecycleOperation {
  appId: string
  promise: Promise<unknown>
}

const WINDOWS_JOB_GATE_SOURCE = String.raw`
const { spawn } = require('child_process')
let input = ''
let launched = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  const newline = input.indexOf('\n')
  if (newline < 0 || launched) return
  launched = true
  const payload = JSON.parse(Buffer.from(input.slice(0, newline), 'base64').toString('utf8'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  let settled = false
  child.once('error', error => {
    if (settled) return
    settled = true
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(127)
  })
  child.once('exit', (code) => {
    if (settled) return
    settled = true
    process.exit(code == null ? 1 : code)
  })
})
process.stdin.resume()
`

export interface LocalAppRuntimeLogger {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}

export interface LocalAppRuntimeManagerOptions {
  rootDir: string
  platform?: LocalAppPlatform
  arch?: LocalAppArchitecture
  uvPath?: string
  bunPath?: string
  fetch?: typeof globalThis.fetch
  baseEnvironment?: NodeJS.ProcessEnv
  logger?: LocalAppRuntimeLogger
  now?: () => number
  /** Test/embedding seam; production allocates an ephemeral localhost port. */
  portAllocator?: () => Promise<number>
  /** Test/embedding seam; production uses child_process.spawn. */
  processSpawner?: typeof spawn
  /** Test/embedding seam for Windows Job Object setup. */
  windowsJobObjectOwnerFactory?: () => Promise<WindowsJobObjectOwner>
  /** Test/embedding seam for the Windows snapshot fallback. */
  windowsProcessTreeOwnerFactory?: (rootPid: number) => WindowsProcessTreeOwner
}

const noopLogger: LocalAppRuntimeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
}

function normalizePlatform(value: unknown): LocalAppPlatform | null {
  if (typeof value !== 'string') return null
  const aliases: Record<string, LocalAppPlatform> = {
    darwin: 'darwin',
    mac: 'darwin',
    macos: 'darwin',
    win32: 'win32',
    windows: 'win32',
    linux: 'linux',
  }
  return aliases[value.toLowerCase()] ?? null
}

function normalizeArchitecture(value: unknown): LocalAppArchitecture | null {
  if (typeof value !== 'string') return null
  const aliases: Record<string, LocalAppArchitecture> = {
    arm64: 'arm64',
    aarch64: 'arm64',
    x64: 'x64',
    amd64: 'x64',
  }
  return aliases[value.toLowerCase()] ?? null
}

function normalizeChecksum(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LocalAppRuntimeError('INVALID_REQUEST', 'checksum must be a SHA-256 hex digest')
  }
  const checksum = value.toLowerCase().replace(/^sha256:/, '')
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new LocalAppRuntimeError('INVALID_REQUEST', 'checksum must be a SHA-256 hex digest')
  }
  return checksum
}

function validateRequestIdentifier(value: unknown, field: 'appId' | 'version'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.includes('\0')) {
    throw new LocalAppRuntimeError('INVALID_REQUEST', `${field} is invalid`)
  }
  const pattern = field === 'appId'
    ? /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
    : /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/
  if (!pattern.test(value) || value === '.' || value === '..') {
    throw new LocalAppRuntimeError('INVALID_REQUEST', `${field} contains unsupported characters`, { [field]: value })
  }
  return value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

export class LocalAppRuntimeManager {
  private readonly rootDir: string
  private readonly appsDir: string
  private readonly stagingDir: string
  private readonly runtimeCacheDir: string
  private readonly platform: LocalAppPlatform
  private readonly arch: LocalAppArchitecture
  private readonly uvPath?: string
  private readonly bunPath?: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly baseEnvironment: NodeJS.ProcessEnv
  private readonly logger: LocalAppRuntimeLogger
  private readonly now: () => number
  private readonly portAllocator?: () => Promise<number>
  private readonly processSpawner: typeof spawn
  private readonly windowsJobObjectOwnerFactory: () => Promise<WindowsJobObjectOwner>
  private readonly windowsProcessTreeOwnerFactory: (rootPid: number) => WindowsProcessTreeOwner
  private readonly activeInstalls = new Map<string, ActiveInstall>()
  private readonly runtimes = new Map<string, ManagedRuntime>()
  private readonly managedProcesses = new Map<string, ManagedProcessOperation>()
  private readonly startPromises = new Map<string, Promise<LocalAppStartResult>>()
  private readonly startControllers = new Map<string, AbortController>()
  private readonly lifecycleQueues = new Map<string, Promise<void>>()
  private readonly activeLifecycleOperations = new Set<TrackedLifecycleOperation>()
  private readonly statuses = new Map<string, LocalAppRuntimeStatus>()
  private readonly installationStatuses = new Map<string, {
    status: 'downloading' | 'installing'
    progress: LocalAppInstallProgress
  }>()
  private readonly logWriters = new Map<string, BoundedLogWriter>()
  private initializationPromise?: Promise<void>
  private shutdownPromise?: Promise<void>
  private shuttingDown = false

  constructor(options: LocalAppRuntimeManagerOptions) {
    this.rootDir = resolve(options.rootDir)
    this.appsDir = join(this.rootDir, 'apps')
    this.stagingDir = join(this.rootDir, 'staging')
    this.runtimeCacheDir = join(this.rootDir, 'runtime-cache')
    this.platform = options.platform
      ?? normalizePlatform(hostPlatform())
      ?? 'linux'
    this.arch = options.arch
      ?? normalizeArchitecture(hostArch())
      ?? 'x64'
    this.uvPath = options.uvPath
    this.bunPath = options.bunPath
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.baseEnvironment = { ...(options.baseEnvironment ?? process.env) }
    this.logger = options.logger ?? noopLogger
    this.now = options.now ?? Date.now
    this.portAllocator = options.portAllocator
    this.processSpawner = options.processSpawner ?? spawn
    this.windowsJobObjectOwnerFactory = options.windowsJobObjectOwnerFactory
      ?? createWindowsJobObjectOwner
    this.windowsProcessTreeOwnerFactory = options.windowsProcessTreeOwnerFactory
      ?? createWindowsProcessTreeOwner
  }

  initialize(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        await Promise.all([
          mkdir(this.appsDir, { recursive: true }),
          mkdir(this.stagingDir, { recursive: true }),
          mkdir(this.runtimeCacheDir, { recursive: true }),
        ])
        await this.removeAbandonedStagingDirectories()
      })().catch((error) => {
        this.initializationPromise = undefined
        throw error
      })
    }
    return this.initializationPromise
  }

  install(
    request: LocalAppInstallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalAppInstalledApp> {
    const validated = this.validateInstallRequest(request)
    if (this.shuttingDown) {
      return Promise.reject(new LocalAppRuntimeError('INSTALL_CANCELLED', 'Polo is shutting down'))
    }

    const existing = this.activeInstalls.get(validated.appId)
    if (existing) {
      if (this.installRequestsMatch(existing.identity, validated)) return existing.promise
      if (
        existing.identity.version === validated.version
        && existing.identity.checksum !== validated.checksum
      ) {
        return Promise.reject(new LocalAppRuntimeError(
          'CHECKSUM_MISMATCH',
          `An active install for ${validated.appId}@${validated.version} has a different checksum`,
          {
            activeChecksum: existing.identity.checksum,
            requestedChecksum: validated.checksum,
          },
        ))
      }
      return Promise.reject(new LocalAppRuntimeError(
        'INVALID_REQUEST',
        `A different release of ${validated.appId} is already being installed`,
        {
          activeRelease: existing.identity,
          requestedRelease: validated,
        },
      ))
    }

    const controller = new AbortController()
    const timeoutError = new LocalAppRuntimeError(
      'INSTALL_TIMEOUT',
      `Installation exceeded ${LOCAL_APP_INSTALL_OPERATION_TIMEOUT_MS}ms`,
    )
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      LOCAL_APP_INSTALL_OPERATION_TIMEOUT_MS,
    )
    const abortFromCaller = () => controller.abort(
      options.signal?.reason instanceof LocalAppRuntimeError
        ? options.signal.reason
        : new LocalAppRuntimeError('INSTALL_CANCELLED', 'Installation request was cancelled'),
    )
    if (options.signal?.aborted) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const promise = this.performInstall(validated, controller.signal)
      .finally(() => {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', abortFromCaller)
        const active = this.activeInstalls.get(validated.appId)
        if (active?.promise === promise) {
          this.activeInstalls.delete(validated.appId)
          this.installationStatuses.delete(validated.appId)
        }
      })
    this.activeInstalls.set(validated.appId, {
      identity: this.getReleaseIdentity(validated),
      controller,
      promise,
    })
    return promise
  }

  cancelInstall(appId: string): boolean {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const active = this.activeInstalls.get(safeAppId)
    if (!active) return false
    active.controller.abort(new LocalAppRuntimeError(
      'INSTALL_CANCELLED',
      `Installation of ${safeAppId} was cancelled`,
    ))
    return true
  }

  start(appId: string): Promise<LocalAppStartResult> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    if (this.shuttingDown) {
      return Promise.reject(new LocalAppRuntimeError('START_FAILED', 'Polo is shutting down'))
    }
    const existing = this.startPromises.get(safeAppId)
    if (existing) return existing
    return this.trackStartOperation(
      safeAppId,
      signal => this.performStart(safeAppId, signal),
    )
  }

  stop(appId: string): Promise<LocalAppRuntimeStatus> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    this.cancelStart(safeAppId, `Start of ${safeAppId} was cancelled by stop`)
    return this.enqueueLifecycle(safeAppId, () => this.performStop(safeAppId))
  }

  restart(appId: string): Promise<LocalAppStartResult> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    if (this.shuttingDown) {
      return Promise.reject(new LocalAppRuntimeError('START_FAILED', 'Polo is shutting down'))
    }
    this.cancelStart(safeAppId, `Start of ${safeAppId} was cancelled by restart`)
    return this.trackStartOperation(safeAppId, async (signal) => {
      await this.performStop(safeAppId)
      return this.performStart(safeAppId, signal)
    })
  }

  uninstall(appId: string, options: LocalAppUninstallOptions = {}): Promise<void> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const activeInstall = this.activeInstalls.get(safeAppId)
    const lifecycleOperations = [...this.activeLifecycleOperations]
      .filter(operation => operation.appId === safeAppId)
    activeInstall?.controller.abort(new LocalAppRuntimeError(
      'INSTALL_CANCELLED',
      `Installation of ${safeAppId} was cancelled by uninstall`,
    ))
    this.cancelStart(safeAppId, `Start of ${safeAppId} was cancelled by uninstall`)
    const coordinatedOperations = [
      ...(activeInstall
        ? [{
            type: 'install' as const,
            promise: activeInstall.promise as Promise<unknown>,
          }]
        : []),
      ...lifecycleOperations.map(operation => ({
        type: 'lifecycle' as const,
        promise: operation.promise,
      })),
    ]
    const enqueueUninstall = (
      operationFailures: Array<{ type: 'install' | 'lifecycle'; error: string }>,
    ) => this.enqueueLifecycle(
      safeAppId,
      () => this.performUninstall(safeAppId, options, operationFailures),
    )
    if (coordinatedOperations.length === 0) return enqueueUninstall([])
    return Promise.allSettled(coordinatedOperations.map(operation => operation.promise))
      .then((results) => {
        const operationFailures = results.flatMap((result, index) => {
          if (
            result.status === 'fulfilled'
            || !(result.reason instanceof LocalAppRuntimeError)
            || result.reason.code !== 'STOP_FAILED'
          ) {
            return []
          }
          return [{
            type: coordinatedOperations[index]!.type,
            error: this.formatError(result.reason),
          }]
        })
        return enqueueUninstall(operationFailures)
      })
  }

  private async performUninstall(
    appId: string,
    options: LocalAppUninstallOptions,
    operationFailures: Array<{ type: 'install' | 'lifecycle'; error: string }> = [],
  ): Promise<void> {
    try {
      let stopFailure: string | undefined
      try {
        await this.performStop(appId)
      } catch (error) {
        stopFailure = this.formatError(error)
        const runtime = this.runtimes.get(appId)
        if (runtime) {
          for (let attempt = 0; attempt < MAX_FORCE_CLEANUP_ATTEMPTS; attempt += 1) {
            if (attempt > 0) await delay(SHUTDOWN_FORCE_RETRY_DELAY_MS)
            try {
              await this.forceStopRuntime(runtime)
              break
            } catch {
              // The retained handles and final retry result are checked below.
            }
          }
        }
      }
      const managedProcessFailures = await this.retryManagedProcessCleanup(appId)
      const remainingManagedProcesses = [...this.managedProcesses.values()]
        .filter(operation => operation.appId === appId)
      if (
        operationFailures.length > 0
        || stopFailure
        || managedProcessFailures.length > 0
        || remainingManagedProcesses.length > 0
      ) {
        throw new LocalAppRuntimeError(
          'UNINSTALL_FAILED',
          `Could not confirm every managed process for ${appId} exited`,
          {
            operationFailures,
            ...(stopFailure ? { stopFailure } : {}),
            managedProcessFailures,
            remainingManagedProcesses: remainingManagedProcesses.map(operation => ({
              kind: operation.kind,
              pid: operation.child.pid,
            })),
          },
        )
      }
      const logWriter = this.logWriters.get(appId)
      await logWriter?.flush()
      this.logWriters.delete(appId)
      const appDir = this.getAppDir(appId)
      if (options.preserveData ?? true) {
        await Promise.all([
          rm(join(appDir, 'versions'), { recursive: true, force: true }),
          rm(join(appDir, 'metadata.json'), { force: true }),
          rm(join(appDir, 'logs'), { recursive: true, force: true }),
          rm(join(this.runtimeCacheDir, appId), { recursive: true, force: true }),
        ])
      } else {
        await Promise.all([
          rm(appDir, { recursive: true, force: true }),
          rm(join(this.runtimeCacheDir, appId), { recursive: true, force: true }),
        ])
      }
      this.statuses.set(appId, { appId, status: 'not_installed' })
    } catch (error) {
      throw asLocalAppRuntimeError(error, 'UNINSTALL_FAILED', `Failed to uninstall ${appId}`)
    }
  }

  setAvailableRelease(
    appId: string,
    release: LocalAppAvailableRelease | null,
  ): Promise<LocalAppRuntimeStatus> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const validatedRelease = release
      ? this.validateAvailableRelease(release)
      : null
    return this.enqueueLifecycle(safeAppId, async () => {
      const metadata = await this.readMetadata(safeAppId)
      if (!metadata) {
        throw new LocalAppRuntimeError('NOT_INSTALLED', `${safeAppId} is not installed`)
      }
      if (validatedRelease && validatedRelease.version !== metadata.currentVersion) {
        metadata.availableRelease = validatedRelease
      } else {
        delete metadata.availableRelease
      }
      await this.writeMetadata(metadata)
      return this.getRuntimeStatus(safeAppId)
    })
  }

  async getInstalledApps(): Promise<LocalAppInstalledApp[]> {
    await mkdir(this.appsDir, { recursive: true })
    const entries = await readdir(this.appsDir, { withFileTypes: true })
    const apps: LocalAppInstalledApp[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const metadata = await this.readMetadata(entry.name)
      if (!metadata) continue
      const current = metadata.versions[metadata.currentVersion]
      if (!current) continue
      const runtimeStatus = await this.getRuntimeStatus(metadata.appId)
      apps.push({
        appId: metadata.appId,
        ...(current.manifest.name ? { name: current.manifest.name } : {}),
        currentVersion: metadata.currentVersion,
        ...(metadata.previousVersion ? { previousVersion: metadata.previousVersion } : {}),
        versions: Object.keys(metadata.versions).sort(),
        runtime: current.manifest.runtime,
        status: runtimeStatus.status,
        installedAt: current.installedAt,
        ...(runtimeStatus.availableRelease
          ? { availableRelease: runtimeStatus.availableRelease }
          : {}),
      })
    }
    return apps.sort((left, right) => left.appId.localeCompare(right.appId))
  }

  async getRuntimeStatus(appId: string): Promise<LocalAppRuntimeStatus> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const handle = this.runtimes.get(safeAppId)
    const installation = this.installationStatuses.get(safeAppId)
    const transient = this.statuses.get(safeAppId)
    const metadata = await this.readMetadata(safeAppId)
    const availableRelease = this.getAvailableUpdate(metadata)
    if (handle) {
      if (
        transient?.status === 'broken'
        && !this.isRuntimeHandleLive(handle)
      ) {
        return {
          ...transient,
          ...(availableRelease ? { availableRelease } : {}),
        }
      }
      return {
        appId: safeAppId,
        status: handle.healthy ? 'running' : 'starting',
        currentVersion: metadata?.currentVersion,
        runningVersion: handle.version,
        url: handle.url,
        port: handle.port,
        ...(handle.child?.pid ? { pid: handle.child.pid } : {}),
        ...(availableRelease ? { availableRelease } : {}),
        ...(installation ? { installationStatus: installation.status } : {}),
        ...(installation ? { progress: installation.progress } : {}),
      }
    }
    if (installation) {
      return {
        appId: safeAppId,
        status: installation.status,
        currentVersion: metadata?.currentVersion,
        previousVersion: metadata?.previousVersion,
        progress: installation.progress,
        ...(availableRelease ? { availableRelease } : {}),
      }
    }
    if (transient?.status === 'broken') {
      return {
        ...transient,
        ...(availableRelease ? { availableRelease } : {}),
      }
    }
    if (!metadata) return { appId: safeAppId, status: 'not_installed' }
    if (availableRelease) {
      return {
        appId: safeAppId,
        status: 'update_available',
        currentVersion: metadata.currentVersion,
        previousVersion: metadata.previousVersion,
        availableRelease,
      }
    }
    if (transient?.status === 'stopped') return { ...transient }
    return {
      appId: safeAppId,
      status: 'installed',
      currentVersion: metadata.currentVersion,
      previousVersion: metadata.previousVersion,
    }
  }

  async getLogs(appId: string, options: LocalAppLogsOptions = {}): Promise<string> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const requestedTail = options.tail ?? 500
    const tail = Math.max(1, Math.min(MAX_LOG_TAIL, Math.floor(requestedTail)))
    return this.getLogWriter(safeAppId).readTail(tail)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.shutdownPromise) return this.shutdownPromise
    const shutdownPromise = this.performShutdown()
    this.shutdownPromise = shutdownPromise
    void shutdownPromise.then(
      () => {
        if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = undefined
      },
      () => {
        if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = undefined
      },
    )
    return shutdownPromise
  }

  private async performShutdown(): Promise<void> {
    const installs = [...this.activeInstalls.values()]
    const lifecycleOperations = [...this.activeLifecycleOperations]
    for (const install of installs) {
      install.controller.abort(new LocalAppRuntimeError(
        'INSTALL_CANCELLED',
        'Installation was cancelled because Polo is shutting down',
      ))
    }
    for (const [appId] of this.startControllers) {
      this.cancelStart(appId, `Start of ${appId} was cancelled because Polo is shutting down`)
    }
    const coordinatedOperations = [
      ...installs.map(install => ({
        type: 'install' as const,
        appId: install.identity.appId,
        promise: install.promise,
      })),
      ...lifecycleOperations.map(operation => ({
        type: 'lifecycle' as const,
        appId: operation.appId,
        promise: operation.promise,
      })),
    ]
    const coordinatedResults = await Promise.allSettled(
      coordinatedOperations.map(operation => operation.promise),
    )
    // Tails are intentionally fulfillment-only for queue serialization. Wait
    // for them too, while using the tracked raw promises above to retain the
    // actual rejection result for the quit decision.
    await Promise.allSettled([
      ...this.lifecycleQueues.values(),
    ])
    const operationFailures = coordinatedResults.flatMap((result, index) => {
      if (
        result.status === 'fulfilled'
        || !(result.reason instanceof LocalAppRuntimeError)
        || result.reason.code !== 'STOP_FAILED'
      ) {
        return []
      }
      const operation = coordinatedOperations[index]!
      return [{
        type: operation.type,
        appId: operation.appId,
        error: this.formatError(result.reason),
      }]
    })

    const runtimes = [...new Set(this.runtimes.values())]
    const stopResults = await Promise.allSettled(
      runtimes.map(runtime => this.stopRuntime(runtime)),
    )
    const failures: Array<{
      appId: string
      initialError: string
      forcedError?: string
    }> = []
    for (let index = 0; index < stopResults.length; index += 1) {
      const result = stopResults[index]!
      if (result.status === 'fulfilled') continue
      const runtime = runtimes[index]!
      const failure: {
        appId: string
        initialError: string
        forcedError?: string
      } = {
        appId: runtime.appId,
        initialError: this.formatError(result.reason),
      }
      failures.push(failure)
      for (let attempt = 0; attempt < MAX_FORCE_CLEANUP_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await delay(SHUTDOWN_FORCE_RETRY_DELAY_MS)
        try {
          await this.forceStopRuntime(runtime)
          break
        } catch (forceError) {
          failure.forcedError = this.formatError(forceError)
        }
      }
    }
    const managedProcessFailures = await this.retryManagedProcessCleanup()

    const flushResults = await Promise.allSettled(
      [...this.logWriters.values()].map(writer => writer.flush()),
    )
    for (const result of flushResults) {
      if (result.status === 'rejected') {
        this.logger.warn('[local-apps] failed to flush a runtime log during shutdown', result.reason)
      }
    }
    if (
      operationFailures.length > 0
      || failures.length > 0
      || managedProcessFailures.length > 0
      || this.managedProcesses.size > 0
      || this.activeLifecycleOperations.size > 0
    ) {
      throw new LocalAppRuntimeError(
        'STOP_FAILED',
        'Failed to confirm every managed local app process exited',
        {
          operationFailures,
          runtimeFailures: failures,
          managedProcessFailures,
          remainingManagedProcesses: this.managedProcesses.size,
          remainingLifecycleOperations: this.activeLifecycleOperations.size,
        },
      )
    }
  }

  private trackStartOperation(
    appId: string,
    operation: (signal: AbortSignal) => Promise<LocalAppStartResult>,
  ): Promise<LocalAppStartResult> {
    const controller = new AbortController()
    const promise = this.enqueueLifecycle(appId, () => operation(controller.signal))
      .finally(() => {
        if (this.startPromises.get(appId) === promise) this.startPromises.delete(appId)
        if (this.startControllers.get(appId) === controller) this.startControllers.delete(appId)
      })
    this.startControllers.set(appId, controller)
    this.startPromises.set(appId, promise)
    return promise
  }

  private cancelStart(appId: string, message: string): void {
    this.startControllers.get(appId)?.abort(
      new LocalAppRuntimeError('START_FAILED', message),
    )
  }

  private enqueueLifecycle<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueues.get(appId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tracked: TrackedLifecycleOperation = { appId, promise: result }
    this.activeLifecycleOperations.add(tracked)
    void result.then(
      () => this.activeLifecycleOperations.delete(tracked),
      () => this.activeLifecycleOperations.delete(tracked),
    )
    const tail = result.then(() => {}, () => {})
    this.lifecycleQueues.set(appId, tail)
    void tail.then(() => {
      if (this.lifecycleQueues.get(appId) === tail) this.lifecycleQueues.delete(appId)
    })
    return result
  }

  private async performStop(appId: string): Promise<LocalAppRuntimeStatus> {
    const handle = this.runtimes.get(appId)
    if (handle) await this.stopRuntime(handle)

    const metadata = await this.readMetadata(appId)
    const status: LocalAppRuntimeStatus = metadata
      ? {
          appId,
          status: 'stopped',
          currentVersion: metadata.currentVersion,
          previousVersion: metadata.previousVersion,
        }
      : { appId, status: 'not_installed' }
    this.statuses.set(appId, status)
    return status
  }

  private validateInstallRequest(request: LocalAppInstallRequest): LocalAppInstallRequest {
    if (!request || typeof request !== 'object') {
      throw new LocalAppRuntimeError('INVALID_REQUEST', 'install request must be an object')
    }
    const appId = validateRequestIdentifier(request.appId, 'appId')
    const version = validateRequestIdentifier(request.version, 'version')
    const platform = normalizePlatform(request.platform)
    const arch = normalizeArchitecture(request.arch)
    if (!platform) throw new LocalAppRuntimeError('INVALID_REQUEST', `Unsupported platform "${request.platform}"`)
    if (!arch) throw new LocalAppRuntimeError('INVALID_REQUEST', `Unsupported architecture "${request.arch}"`)
    if (platform !== this.platform) {
      throw new LocalAppRuntimeError(
        'PLATFORM_MISMATCH',
        `Release targets ${platform}, but this Polo installation runs on ${this.platform}`,
        { expected: this.platform, actual: platform },
      )
    }
    if (arch !== this.arch) {
      throw new LocalAppRuntimeError(
        'ARCH_MISMATCH',
        `Release targets ${arch}, but this Polo installation runs on ${this.arch}`,
        { expected: this.arch, actual: arch },
      )
    }
    if (
      typeof request.sizeBytes !== 'number'
      || !Number.isSafeInteger(request.sizeBytes)
      || request.sizeBytes <= 0
      || request.sizeBytes > MAX_DOWNLOAD_BYTES
    ) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        `sizeBytes must be between 1 and ${MAX_DOWNLOAD_BYTES}`,
      )
    }
    let downloadUrl: URL
    try {
      downloadUrl = new URL(request.downloadUrl)
    } catch {
      throw new LocalAppRuntimeError('INVALID_REQUEST', 'downloadUrl is not a valid URL')
    }
    if (downloadUrl.protocol !== 'https:' && downloadUrl.protocol !== 'http:') {
      throw new LocalAppRuntimeError('INVALID_REQUEST', 'downloadUrl must use HTTPS or HTTP')
    }
    return {
      appId,
      version,
      downloadUrl: downloadUrl.toString(),
      checksum: normalizeChecksum(request.checksum),
      sizeBytes: request.sizeBytes,
      platform,
      arch,
    }
  }

  private installRequestsMatch(
    left: ActiveReleaseIdentity,
    right: LocalAppInstallRequest,
  ): boolean {
    return left.appId === right.appId
      && left.version === right.version
      && left.checksum === right.checksum
      && left.sizeBytes === right.sizeBytes
      && left.platform === right.platform
      && left.arch === right.arch
  }

  private getReleaseIdentity(request: LocalAppInstallRequest): ActiveReleaseIdentity {
    return {
      appId: request.appId,
      version: request.version,
      checksum: request.checksum,
      sizeBytes: request.sizeBytes,
      platform: request.platform,
      arch: request.arch,
    }
  }

  private validateAvailableRelease(release: LocalAppAvailableRelease): LocalAppAvailableRelease {
    if (!release || typeof release !== 'object') {
      throw new LocalAppRuntimeError('INVALID_REQUEST', 'available release must be an object')
    }
    const version = validateRequestIdentifier(release.version, 'version')
    let downloadUrl: string | undefined
    if (release.downloadUrl !== undefined) {
      let parsedUrl: URL
      try {
        parsedUrl = new URL(release.downloadUrl)
      } catch {
        throw new LocalAppRuntimeError('INVALID_REQUEST', 'downloadUrl is not a valid URL')
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new LocalAppRuntimeError('INVALID_REQUEST', 'downloadUrl must use HTTPS or HTTP')
      }
      downloadUrl = parsedUrl.toString()
    }
    const platform = release.platform === undefined
      ? undefined
      : normalizePlatform(release.platform)
    const arch = release.arch === undefined
      ? undefined
      : normalizeArchitecture(release.arch)
    if (release.platform !== undefined && !platform) {
      throw new LocalAppRuntimeError('INVALID_REQUEST', `Unsupported platform "${release.platform}"`)
    }
    if (release.arch !== undefined && !arch) {
      throw new LocalAppRuntimeError('INVALID_REQUEST', `Unsupported architecture "${release.arch}"`)
    }
    if (
      release.sizeBytes !== undefined
      && (
        !Number.isSafeInteger(release.sizeBytes)
        || release.sizeBytes <= 0
        || release.sizeBytes > MAX_DOWNLOAD_BYTES
      )
    ) {
      throw new LocalAppRuntimeError(
        'INVALID_REQUEST',
        `sizeBytes must be between 1 and ${MAX_DOWNLOAD_BYTES}`,
      )
    }
    return {
      version,
      ...(downloadUrl ? { downloadUrl } : {}),
      ...(release.checksum !== undefined
        ? { checksum: normalizeChecksum(release.checksum) }
        : {}),
      ...(release.sizeBytes !== undefined ? { sizeBytes: release.sizeBytes } : {}),
      ...(platform ? { platform } : {}),
      ...(arch ? { arch } : {}),
    }
  }

  private getAvailableUpdate(metadata: AppMetadata | null): LocalAppAvailableRelease | undefined {
    if (
      !metadata?.availableRelease
      || metadata.availableRelease.version === metadata.currentVersion
    ) {
      return undefined
    }
    return metadata.availableRelease
  }

  private async performInstall(
    request: LocalAppInstallRequest,
    signal: AbortSignal,
  ): Promise<LocalAppInstalledApp> {
    await this.initialize()
    const existingMetadata = await this.readMetadata(request.appId)
    const existingVersion = existingMetadata?.versions[request.version]
    if (existingVersion && existingVersion.checksum !== request.checksum) {
      throw new LocalAppRuntimeError(
        'CHECKSUM_MISMATCH',
        `Installed ${request.appId}@${request.version} has a different checksum`,
        {
          installedChecksum: existingVersion.checksum,
          requestedChecksum: request.checksum,
        },
      )
    }
    if (existingVersion && await this.isInstalledVersionUsable(request.appId, request.version)) {
      const installed = (await this.getInstalledApps()).find(app => app.appId === request.appId)
      if (!installed) {
        throw new LocalAppRuntimeError('NOT_INSTALLED', `Metadata for ${request.appId} is incomplete`)
      }
      return installed
    }

    const stagingRoot = await mkdtemp(join(this.stagingDir, `${request.appId}-${request.version}-`))
    const archivePath = join(stagingRoot, 'bundle.archive')
    const extractedPath = join(stagingRoot, 'bundle')
    try {
      this.setInstallProgress(request, 'downloading', 0)
      await this.downloadBundle(request, archivePath, signal)
      this.throwIfCancelled(signal)

      this.setInstallProgress(request, 'verifying', request.sizeBytes)
      this.setInstallProgress(request, 'extracting', request.sizeBytes)
      await extractBundleArchive(archivePath, extractedPath, signal)
      this.throwIfCancelled(signal)

      const manifest = await this.loadAndValidateManifest(extractedPath)
      if (manifest.appId !== request.appId) {
        throw new LocalAppRuntimeError(
          'INVALID_MANIFEST',
          `Manifest appId "${manifest.appId}" does not match release appId "${request.appId}"`,
        )
      }
      if (manifest.version !== request.version) {
        throw new LocalAppRuntimeError(
          'INVALID_MANIFEST',
          `Manifest version "${manifest.version}" does not match release version "${request.version}"`,
        )
      }
      await this.validateRequiredFiles(extractedPath, manifest)

      this.setInstallProgress(request, 'preparing', request.sizeBytes)
      await this.prepareRuntime(request.appId, request.version, extractedPath, manifest, signal)
      this.throwIfCancelled(signal)

      const nextMetadata = await this.enqueueLifecycle(request.appId, async () => {
        this.throwIfCancelled(signal)
        const appDir = this.getAppDir(request.appId)
        const versionsDir = join(appDir, 'versions')
        const targetDir = this.getVersionDir(request.appId, request.version)
        await mkdir(versionsDir, { recursive: true })
        if (existsSync(targetDir)) await rm(targetDir, { recursive: true, force: true })
        await rename(extractedPath, targetDir)
        await mkdir(this.getDataDir(request.appId), { recursive: true })

        // Re-read inside the app lifecycle queue so a start health write cannot
        // overwrite a concurrently prepared update with stale metadata.
        const metadata = await this.readMetadata(request.appId)
        const versions = metadata?.versions ?? {}
        versions[request.version] = {
          manifest,
          installedAt: this.now(),
          checksum: request.checksum,
        }
        const priorCurrent = metadata?.currentVersion
        const previousVersion = priorCurrent && priorCurrent !== request.version
          ? priorCurrent
          : metadata?.previousVersion
        const committedMetadata: AppMetadata = {
          schemaVersion: METADATA_SCHEMA_VERSION,
          appId: request.appId,
          currentVersion: request.version,
          ...(previousVersion ? { previousVersion } : {}),
          ...(metadata?.lastKnownGoodVersion
            ? { lastKnownGoodVersion: metadata.lastKnownGoodVersion }
            : {}),
          versions,
          ...(metadata?.brokenVersions ? { brokenVersions: metadata.brokenVersions } : {}),
          ...(metadata?.availableRelease
            && metadata.availableRelease.version !== request.version
            ? { availableRelease: metadata.availableRelease }
            : {}),
        }
        await this.writeMetadata(committedMetadata)
        return committedMetadata
      })
      this.statuses.set(request.appId, {
        appId: request.appId,
        status: 'installed',
        currentVersion: request.version,
        previousVersion: nextMetadata.previousVersion,
      })
      this.appendLog(request.appId, 'system', `Installed ${request.version} (${manifest.runtime})`)
      const installed = (await this.getInstalledApps()).find(app => app.appId === request.appId)
      if (!installed) throw new LocalAppRuntimeError('NOT_INSTALLED', 'Installed metadata could not be reloaded')
      return installed
    } catch (error) {
      const cleanupFailed = error instanceof LocalAppRuntimeError
        && error.code === 'STOP_FAILED'
      const runtimeError = signal.aborted && !cleanupFailed
        ? this.getAbortError(
            signal,
            new LocalAppRuntimeError('INSTALL_CANCELLED', `Installation of ${request.appId} was cancelled`),
          )
        : asLocalAppRuntimeError(error, 'DOWNLOAD_FAILED', `Failed to install ${request.appId}`)
      const metadata = await this.readMetadata(request.appId)
      this.statuses.set(request.appId, metadata
        ? {
            appId: request.appId,
            status: 'installed',
            currentVersion: metadata.currentVersion,
            previousVersion: metadata.previousVersion,
            error: runtimeError.toJSON(),
          }
        : { appId: request.appId, status: 'broken', error: runtimeError.toJSON() })
      if (!existingVersion) {
        await rm(join(this.runtimeCacheDir, request.appId, request.version), {
          recursive: true,
          force: true,
        })
      }
      this.appendLog(request.appId, 'system', `${runtimeError.code}: ${runtimeError.message}`)
      throw runtimeError
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }

  private async downloadBundle(
    request: LocalAppInstallRequest,
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    let response: Response
    try {
      response = await this.fetchImpl(request.downloadUrl, {
        signal,
        redirect: 'follow',
      })
    } catch (error) {
      if (signal.aborted) {
        throw this.getAbortError(
          signal,
          new LocalAppRuntimeError('INSTALL_CANCELLED', 'Bundle download was cancelled'),
        )
      }
      throw new LocalAppRuntimeError(
        'DOWNLOAD_FAILED',
        `Could not download bundle: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok || !response.body) {
      throw new LocalAppRuntimeError(
        'DOWNLOAD_FAILED',
        `Bundle download returned HTTP ${response.status}`,
        { status: response.status },
      )
    }
    const advertisedSize = response.headers.get('content-length')
    if (advertisedSize && Number(advertisedSize) !== request.sizeBytes) {
      throw new LocalAppRuntimeError(
        'SIZE_MISMATCH',
        `Bundle Content-Length is ${advertisedSize}, expected ${request.sizeBytes}`,
      )
    }

    const output = await open(destination, 'wx')
    const hash = createHash('sha256')
    let downloaded = 0
    try {
      for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        this.throwIfCancelled(signal)
        const chunk = Buffer.from(rawChunk)
        downloaded += chunk.length
        if (downloaded > request.sizeBytes) {
          throw new LocalAppRuntimeError(
            'SIZE_MISMATCH',
            `Bundle exceeds declared size ${request.sizeBytes}`,
          )
        }
        hash.update(chunk)
        await output.write(chunk)
        this.setInstallProgress(request, 'downloading', downloaded)
      }
    } finally {
      await output.close()
    }
    if (downloaded !== request.sizeBytes) {
      throw new LocalAppRuntimeError(
        'SIZE_MISMATCH',
        `Downloaded ${downloaded} bytes, expected ${request.sizeBytes}`,
      )
    }
    const checksum = hash.digest('hex')
    if (checksum !== request.checksum) {
      throw new LocalAppRuntimeError(
        'CHECKSUM_MISMATCH',
        `Bundle checksum did not match release metadata`,
        { expected: request.checksum, actual: checksum },
      )
    }
  }

  private setInstallProgress(
    request: LocalAppInstallRequest,
    phase: LocalAppInstallProgress['phase'],
    bytesDownloaded: number,
  ): void {
    const progress: LocalAppInstallProgress = {
      phase,
      bytesDownloaded,
      sizeBytes: request.sizeBytes,
      percent: Math.min(100, Math.round((bytesDownloaded / request.sizeBytes) * 100)),
    }
    this.installationStatuses.set(request.appId, {
      status: phase === 'downloading' ? 'downloading' : 'installing',
      progress,
    })
  }

  private async loadAndValidateManifest(bundleDir: string): Promise<PoloAppManifest> {
    const manifestPath = join(bundleDir, 'polo-app.json')
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LocalAppRuntimeError('INVALID_MANIFEST', 'Bundle is missing top-level polo-app.json')
      }
      throw new LocalAppRuntimeError(
        'INVALID_MANIFEST',
        `polo-app.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return validatePoloAppManifest(raw, { platform: this.platform, arch: this.arch })
  }

  private async validateRequiredFiles(bundleDir: string, manifest: PoloAppManifest): Promise<void> {
    const entryPath = this.resolveBundlePath(bundleDir, manifest.entry[0]!, 'entry[0]')
    let entryStat
    try {
      entryStat = await stat(entryPath)
    } catch {
      throw new LocalAppRuntimeError(
        'INVALID_MANIFEST',
        `Manifest entry does not exist: ${manifest.entry[0]}`,
      )
    }
    if (manifest.runtime === 'static') {
      if (!entryStat.isDirectory() && !entryStat.isFile()) {
        throw new LocalAppRuntimeError('INVALID_MANIFEST', 'Static entry must be a file or directory')
      }
      const serviceEntry = entryStat.isDirectory()
        ? join(entryPath, 'index.html')
        : entryPath
      try {
        const serviceEntryStat = await stat(serviceEntry)
        if (!serviceEntryStat.isFile()) throw new Error('not a file')
        await access(serviceEntry, fsConstants.R_OK)
      } catch {
        throw new LocalAppRuntimeError(
          'INVALID_MANIFEST',
          entryStat.isDirectory()
            ? `Static entry directory must contain a readable index.html: ${manifest.entry[0]}`
            : `Static entry file is not readable: ${manifest.entry[0]}`,
        )
      }
      return
    }
    if (!entryStat.isFile()) {
      throw new LocalAppRuntimeError('INVALID_MANIFEST', `${manifest.runtime} entry must be a file`)
    }
    if (manifest.runtime === 'python') {
      await this.requireBundleFile(bundleDir, 'pyproject.toml')
      await this.requireBundleFile(bundleDir, 'uv.lock')
    }
  }

  private async requireBundleFile(bundleDir: string, relativePath: string): Promise<void> {
    try {
      const fileStat = await stat(join(bundleDir, relativePath))
      if (!fileStat.isFile()) throw new Error('not a file')
    } catch {
      throw new LocalAppRuntimeError(
        'INVALID_MANIFEST',
        `Bundle is missing required file ${relativePath}`,
      )
    }
  }

  private async prepareRuntime(
    appId: string,
    version: string,
    bundleDir: string,
    manifest: PoloAppManifest,
    signal: AbortSignal,
  ): Promise<void> {
    if (manifest.runtime === 'static') return
    if (manifest.runtime === 'python') {
      const uv = await this.requireRuntimeExecutable(this.uvPath, 'uv')
      const env = this.buildRuntimeEnvironment(appId, version, bundleDir, 0)
      await this.runInstallCommand(
        appId,
        uv,
        ['sync', '--frozen', '--no-dev', '--no-install-project', '--project', bundleDir],
        bundleDir,
        env,
        signal,
      )
      return
    }

    const packageJson = join(bundleDir, 'package.json')
    if (!existsSync(packageJson) || existsSync(join(bundleDir, 'node_modules'))) return
    if (!existsSync(join(bundleDir, 'bun.lock')) && !existsSync(join(bundleDir, 'bun.lockb'))) {
      throw new LocalAppRuntimeError(
        'INVALID_MANIFEST',
        'JS bundle with package.json must include bun.lock/bun.lockb or prepared node_modules',
      )
    }
    const bun = await this.requireRuntimeExecutable(this.bunPath, 'Bun')
    const env = this.buildRuntimeEnvironment(appId, version, bundleDir, 0)
    await this.runInstallCommand(
      appId,
      bun,
      ['install', '--frozen-lockfile', '--production', '--cwd', bundleDir],
      bundleDir,
      env,
      signal,
    )
  }

  private async runInstallCommand(
    appId: string,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<void> {
    this.appendLog(appId, 'system', `Preparing dependencies with ${basename(command)}`)
    const managedProcess = await this.spawnManagedCommand(
      appId,
      'dependency-preparation',
      command,
      args,
      cwd,
      env,
    )
    const { child } = managedProcess
    this.captureChildOutput(appId, child)

    type InstallProcessOutcome =
      | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
      | { kind: 'error'; error: Error }
      | { kind: 'abort' }
      | { kind: 'timeout' }
    const processOutcome = new Promise<InstallProcessOutcome>((resolveOutcome) => {
      child.once('error', error => resolveOutcome({ kind: 'error', error }))
      child.once('exit', (code, exitSignal) =>
        resolveOutcome({ kind: 'exit', code, signal: exitSignal }))
    })
    let abortListener: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const interruption = new Promise<InstallProcessOutcome>((resolveInterruption) => {
      abortListener = () => resolveInterruption({ kind: 'abort' })
      if (signal.aborted) abortListener()
      else signal.addEventListener('abort', abortListener, { once: true })
      timeout = setTimeout(
        () => resolveInterruption({ kind: 'timeout' }),
        INSTALL_COMMAND_TIMEOUT_MS,
      )
    })
    const outcome = await Promise.race([processOutcome, interruption])
    if (timeout) clearTimeout(timeout)
    if (abortListener) signal.removeEventListener('abort', abortListener)

    try {
      // Dependency installers are allowed only one managed process tree. Reap
      // the complete tree even after the root exits successfully, since package
      // managers may otherwise leave daemon descendants behind.
      await this.cleanupManagedProcess(managedProcess)
    } catch (error) {
      throw new LocalAppRuntimeError(
        'STOP_FAILED',
        `Could not confirm dependency preparation for ${appId} fully exited`,
        {
          pid: child.pid,
          cause: this.formatError(error),
          outcome: outcome.kind,
        },
      )
    }

    if (outcome.kind === 'abort' || outcome.kind === 'timeout') {
      if (outcome.kind === 'abort') {
        throw this.getAbortError(
          signal,
          new LocalAppRuntimeError('INSTALL_CANCELLED', 'Dependency preparation was cancelled'),
        )
      }
      throw new LocalAppRuntimeError(
        'DEPENDENCY_INSTALL_FAILED',
        `Dependency preparation exceeded ${INSTALL_COMMAND_TIMEOUT_MS}ms`,
      )
    }
    if (outcome.kind === 'error') {
      throw new LocalAppRuntimeError(
        'RUNTIME_UNAVAILABLE',
        `Could not launch ${basename(command)}: ${outcome.error.message}`,
      )
    }
    if (outcome.code !== 0) {
      throw new LocalAppRuntimeError(
        'DEPENDENCY_INSTALL_FAILED',
        `Dependency preparation exited with code ${outcome.code ?? 'null'}`,
        { signal: outcome.signal },
      )
    }
  }

  private async performStart(appId: string, signal: AbortSignal): Promise<LocalAppStartResult> {
    this.throwIfStartCancelled(signal, appId)
    const running = this.runtimes.get(appId)
    if (running) {
      const healthUrl = `http://127.0.0.1:${running.port}${running.manifest.healthcheck}`
      if (
        running.healthy
        && this.isRuntimeHandleLive(running)
        && !running.cleanupPromise
        && (await this.probeOwnedHealthcheck(healthUrl, running.healthToken)).kind === 'healthy'
        && this.runtimes.get(appId) === running
        && this.isRuntimeHandleLive(running)
      ) {
        this.throwIfStartCancelled(signal, appId)
        return {
          appId,
          version: running.version,
          url: running.url,
          port: running.port,
        }
      }
      await running.cleanupPromise?.catch(() => {})
      await this.stopRuntime(running)
      if (this.runtimes.get(appId) === running) this.runtimes.delete(appId)
      this.throwIfStartCancelled(signal, appId)
    }
    const metadata = await this.readMetadata(appId)
    if (!metadata || !metadata.versions[metadata.currentVersion]) {
      throw new LocalAppRuntimeError('NOT_INSTALLED', `${appId} is not installed`)
    }

    const requestedVersion = metadata.currentVersion
    try {
      return await this.startVersion(metadata, requestedVersion, signal)
    } catch (error) {
      const primaryError = asLocalAppRuntimeError(error, 'START_FAILED', `Failed to start ${appId}`)
      if (this.shuttingDown || signal.aborted) {
        this.statuses.set(appId, {
          appId,
          status: 'stopped',
          currentVersion: requestedVersion,
        })
        throw signal.aborted
          ? this.getAbortError(signal, primaryError)
          : primaryError
      }
      if (primaryError.code === 'PORT_UNAVAILABLE') {
        this.statuses.set(appId, {
          appId,
          status: 'stopped',
          currentVersion: requestedVersion,
          error: primaryError.toJSON(),
        })
        throw primaryError
      }
      await this.markVersionBroken(metadata, requestedVersion, primaryError)
      const fallbackVersion = metadata.lastKnownGoodVersion
      if (
        !fallbackVersion
        || fallbackVersion === requestedVersion
        || !metadata.versions[fallbackVersion]
        || Boolean(metadata.brokenVersions?.[fallbackVersion])
      ) {
        this.statuses.set(appId, {
          appId,
          status: 'broken',
          currentVersion: requestedVersion,
          error: primaryError.toJSON(),
        })
        throw primaryError
      }

      this.appendLog(appId, 'system', `Start failed for ${requestedVersion}; rolling back to ${fallbackVersion}`)
      metadata.currentVersion = fallbackVersion
      metadata.previousVersion = requestedVersion
      await this.writeMetadata(metadata)
      try {
        const result = await this.startVersion(metadata, fallbackVersion, signal)
        return { ...result, rolledBackFrom: requestedVersion }
      } catch (fallbackError) {
        const rollbackError = asLocalAppRuntimeError(
          fallbackError,
          'START_FAILED',
          `Rollback version ${fallbackVersion} also failed`,
        )
        await this.markVersionBroken(metadata, fallbackVersion, rollbackError)
        const combined = new LocalAppRuntimeError(
          'START_FAILED',
          `Failed to start ${requestedVersion}; rollback to ${fallbackVersion} also failed`,
          { primary: primaryError.toJSON(), rollback: rollbackError.toJSON() },
        )
        this.statuses.set(appId, {
          appId,
          status: 'broken',
          currentVersion: fallbackVersion,
          error: combined.toJSON(),
        })
        throw combined
      }
    }
  }

  private async startVersion(
    metadata: AppMetadata,
    version: string,
    signal: AbortSignal,
  ): Promise<LocalAppStartResult> {
    if (this.shuttingDown) {
      throw new LocalAppRuntimeError('START_FAILED', `Start of ${metadata.appId} was cancelled during shutdown`)
    }
    this.throwIfStartCancelled(signal, metadata.appId)
    const record = metadata.versions[version]
    if (!record) throw new LocalAppRuntimeError('NOT_INSTALLED', `Version ${version} is not installed`)
    const { manifest } = record
    const versionDir = this.getVersionDir(metadata.appId, version)
    await this.validateRequiredFiles(versionDir, manifest)
    await mkdir(this.getDataDir(metadata.appId), { recursive: true })
    this.statuses.set(metadata.appId, {
      appId: metadata.appId,
      status: 'starting',
      currentVersion: metadata.currentVersion,
      runningVersion: version,
    })

    let handle: ManagedRuntime
    if (manifest.runtime === 'static') {
      handle = await this.startStaticRuntime(metadata.appId, version, versionDir, manifest)
    } else {
      handle = await this.startProcessRuntime(metadata.appId, version, versionDir, manifest)
    }
    this.runtimes.set(metadata.appId, handle)
    try {
      await this.waitForHealthcheck(
        handle,
        manifest.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        signal,
      )
      // Let a root that exits immediately after answering health surface its
      // exit event before we publish a usable URL.
      if (handle.child) {
        await Promise.race([
          handle.exitPromise.then(() => {}),
          delay(POST_HEALTH_STABILITY_MS),
        ])
      }
      this.assertRuntimeHandleCurrentAndLive(handle)
      metadata.lastKnownGoodVersion = version
      if (metadata.brokenVersions?.[version]) {
        delete metadata.brokenVersions[version]
        if (Object.keys(metadata.brokenVersions).length === 0) delete metadata.brokenVersions
      }
      await this.writeMetadata(metadata)
      this.assertRuntimeHandleCurrentAndLive(handle)
      handle.healthy = true
    } catch (error) {
      await this.stopRuntime(handle)
      throw error
    }
    this.assertRuntimeHandleCurrentAndLive(handle)
    this.statuses.set(metadata.appId, {
      appId: metadata.appId,
      status: 'running',
      currentVersion: metadata.currentVersion,
      runningVersion: version,
      url: handle.url,
      port: handle.port,
      ...(handle.child?.pid ? { pid: handle.child.pid } : {}),
    })
    this.appendLog(metadata.appId, 'system', `Healthy at ${handle.url}`)
    return {
      appId: metadata.appId,
      version,
      url: handle.url,
      port: handle.port,
    }
  }

  private isRuntimeHandleLive(handle: ManagedRuntime): boolean {
    if (handle.stopRequested || handle.cleanupPromise || handle.spawnError) return false
    if (handle.server) return handle.server.listening
    return Boolean(
      handle.child
      && handle.child.exitCode == null
      && handle.child.signalCode == null
      && !handle.child.killed,
    )
  }

  private assertRuntimeHandleCurrentAndLive(handle: ManagedRuntime): void {
    if (
      this.runtimes.get(handle.appId) !== handle
      || !this.isRuntimeHandleLive(handle)
    ) {
      throw new LocalAppRuntimeError(
        'PROCESS_CRASHED',
        `${handle.appId} exited while its healthy start was being committed`,
        { version: handle.version },
      )
    }
  }

  private async startProcessRuntime(
    appId: string,
    version: string,
    versionDir: string,
    manifest: PoloAppManifest,
  ): Promise<ManagedRuntime> {
    const port = await this.allocatePort()
    await this.assertPortAvailable(port)
    const healthToken = randomUUID().replaceAll('-', '')
    const executable = manifest.runtime === 'python'
      ? await this.requireRuntimeExecutable(this.uvPath, 'uv')
      : await this.requireRuntimeExecutable(this.bunPath, 'Bun')
    const entryPath = this.resolveBundlePath(versionDir, manifest.entry[0]!, 'entry[0]')
    const args = manifest.runtime === 'python'
      ? [
          'run',
          '--offline',
          '--frozen',
          '--no-sync',
          '--project',
          versionDir,
          'python',
          entryPath,
          ...manifest.entry.slice(1),
        ]
      : [entryPath, ...manifest.entry.slice(1)]
    const managedProcess = await this.spawnManagedCommand(
      appId,
      'runtime',
      executable,
      args,
      versionDir,
      this.buildRuntimeEnvironment(appId, version, versionDir, port, healthToken),
    )
    const { child, processTreeOwner } = managedProcess
    this.captureChildOutput(appId, child)

    let resolveExit!: (outcome: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      resolveExit = resolvePromise
    })
    const handle: ManagedRuntime = {
      appId,
      version,
      manifest,
      port,
      url: this.buildAppUrl(port, manifest.webPath),
      child,
      managedProcess,
      processTreeOwner,
      healthy: false,
      stopRequested: false,
      exitPromise,
      healthToken,
    }
    child.once('error', (error) => {
      handle.spawnError = error
    })
    child.once('exit', (code, signal) => {
      resolveExit({ code, signal })
      if (handle.stopRequested) return
      handle.cleanupPromise = this.cleanupManagedProcess(managedProcess)
        .then(() => {
          if (this.runtimes.get(appId) === handle) this.runtimes.delete(appId)
        })
        .catch((error) => {
          this.logger.warn(`[local-apps] failed to reap descendants after ${appId} exited`, error)
          throw error
        })
      void handle.cleanupPromise.catch(() => {})
      const runtimeError = new LocalAppRuntimeError(
        'PROCESS_CRASHED',
        `${appId} exited unexpectedly with code ${code ?? 'null'}`,
        { version, code, signal },
      )
      this.statuses.set(appId, {
        appId,
        status: 'broken',
        currentVersion: version,
        error: runtimeError.toJSON(),
      })
      this.appendLog(appId, 'system', `${runtimeError.code}: ${runtimeError.message}`)
    })
    this.appendLog(appId, 'system', `Starting ${version} on port ${port}`)
    return handle
  }

  private async spawnManagedCommand(
    appId: string,
    kind: ManagedProcessOperation['kind'],
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<ManagedProcessOperation> {
    if (this.platform !== 'win32') {
      const child = this.processSpawner(command, args, {
        cwd,
        env,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return this.registerManagedProcess(appId, kind, child)
    }

    let owner: WindowsJobObjectOwner
    try {
      owner = await this.windowsJobObjectOwnerFactory()
    } catch (error) {
      throw new LocalAppRuntimeError(
        'RUNTIME_UNAVAILABLE',
        'Windows Job Object support could not be initialized',
        { cause: error instanceof Error ? error.message : String(error) },
      )
    }
    const child = this.processSpawner(process.execPath, ['-e', WINDOWS_JOB_GATE_SOURCE], {
      cwd,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Register the gate before any fallible initialization. From this point on,
    // shutdown/uninstall can always find the gate and retry owner-confirmed
    // cleanup, even when Job assignment or stdin delivery fails.
    const managedProcess = this.registerManagedProcess(
      appId,
      kind,
      child,
      owner,
      false,
    )
    try {
      if (!child.pid || !child.stdin) {
        throw new Error('Windows managed process gate has no PID or stdin')
      }
      // The gate cannot create the target until this assignment succeeds.
      // Every later descendant therefore inherits this Job Object.
      owner.assignProcess(child.pid)
      managedProcess.processTreeOwnerAssigned = true
      owner.setSnapshotFallback(this.windowsProcessTreeOwnerFactory(child.pid))
      const payload = Buffer.from(JSON.stringify({ command, args, cwd }), 'utf8')
        .toString('base64')
      await new Promise<void>((resolveWrite, rejectWrite) => {
        const stdin = child.stdin!
        const cleanupListeners = () => {
          stdin.removeListener('error', onError)
          stdin.removeListener('finish', onFinish)
        }
        const onError = (error: Error) => {
          cleanupListeners()
          rejectWrite(error)
        }
        const onFinish = () => {
          cleanupListeners()
          resolveWrite()
        }
        stdin.once('error', onError)
        stdin.once('finish', onFinish)
        try {
          stdin.end(`${payload}\n`)
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)))
        }
      })
    } catch (error) {
      try {
        await this.cleanupManagedProcess(managedProcess)
      } catch (cleanupError) {
        throw new LocalAppRuntimeError(
          'STOP_FAILED',
          'Windows managed process initialization failed and its process tree could not be confirmed stopped',
          {
            appId,
            kind,
            pid: child.pid,
            cause: error instanceof Error ? error.message : String(error),
            cleanupError: this.formatError(cleanupError),
          },
        )
      }
      throw new LocalAppRuntimeError(
        'RUNTIME_UNAVAILABLE',
        'Windows managed process could not be initialized',
        { cause: error instanceof Error ? error.message : String(error) },
      )
    }
    return managedProcess
  }

  private async startStaticRuntime(
    appId: string,
    version: string,
    versionDir: string,
    manifest: PoloAppManifest,
  ): Promise<ManagedRuntime> {
    const entryPath = this.resolveBundlePath(versionDir, manifest.entry[0]!, 'entry[0]')
    const entryStat = await stat(entryPath)
    const staticRoot = entryStat.isDirectory() ? entryPath : dirname(entryPath)
    const fallbackFile = entryStat.isDirectory() ? join(entryPath, 'index.html') : entryPath
    const streamState = { active: 0 }
    const healthToken = randomUUID().replaceAll('-', '')
    const server = createHttpServer((request, response) => {
      void this.handleStaticRequest(request, response, {
        staticRoot,
        fallbackFile,
        healthcheck: manifest.healthcheck,
        webPath: manifest.webPath,
        streamState,
        healthToken,
      }).catch((error) => {
        if (!response.headersSent) {
          response.statusCode = 500
          response.setHeader('content-type', 'text/plain; charset=utf-8')
          response.end('Internal server error')
        } else {
          response.destroy()
        }
        this.appendLog(appId, 'stderr', error instanceof Error ? error.message : String(error))
      })
    })
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      server.once('error', rejectPort)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          rejectPort(new LocalAppRuntimeError('PORT_UNAVAILABLE', 'Static server did not receive a TCP port'))
          return
        }
        resolvePort(address.port)
      })
    }).catch((error) => {
      throw asLocalAppRuntimeError(error, 'PORT_UNAVAILABLE', 'Could not allocate a local port')
    })

    const exitPromise = new Promise<{ code: null; signal: null }>((resolveExit) => {
      server.once('close', () => resolveExit({ code: null, signal: null }))
    })
    const handle: ManagedRuntime = {
      appId,
      version,
      manifest,
      port,
      url: this.buildAppUrl(port, manifest.webPath),
      server,
      healthy: false,
      stopRequested: false,
      exitPromise,
      healthToken,
    }
    this.appendLog(appId, 'system', `Starting static ${version} on port ${port}`)
    return handle
  }

  private async handleStaticRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: {
      staticRoot: string
      fallbackFile: string
      healthcheck: string
      webPath: string
      streamState: { active: number }
      healthToken: string
    },
  ): Promise<void> {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendStaticText(response, method, 405, 'Method not allowed', { allow: 'GET, HEAD' })
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      this.sendStaticText(response, method, 400, 'Bad request')
      return
    }
    const healthPath = new URL(options.healthcheck, 'http://127.0.0.1').pathname
    const webPath = new URL(options.webPath, 'http://127.0.0.1').pathname
    // Polo owns the static listener directly, so every response can carry the
    // per-start ownership proof (including healthcheck === webPath).
    response.setHeader(HEALTH_OWNERSHIP_HEADER, options.healthToken)
    if (pathname === healthPath && healthPath !== webPath) {
      this.sendStaticText(response, method, 200, '{"ok":true}', {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      return
    }

    const mountPath = new URL(options.webPath, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
    if (mountPath !== '/' && pathname !== mountPath && !pathname.startsWith(`${mountPath}/`)) {
      this.sendStaticText(response, method, 404, 'Not found')
      return
    }
    const relativeUrlPath = mountPath === '/'
      ? pathname.slice(1)
      : pathname.slice(mountPath.length).replace(/^\/+/, '')
    if (relativeUrlPath.split('/').includes('..') || relativeUrlPath.includes('\0')) {
      this.sendStaticText(response, method, 403, 'Forbidden')
      return
    }

    const candidate = resolve(options.staticRoot, relativeUrlPath || 'index.html')
    const rootPrefix = options.staticRoot.endsWith(sep) ? options.staticRoot : `${options.staticRoot}${sep}`
    if (candidate !== options.staticRoot && !candidate.startsWith(rootPrefix)) {
      this.sendStaticText(response, method, 403, 'Forbidden')
      return
    }
    let selected = candidate
    let selectedStat
    try {
      const candidateStat = await stat(selected)
      if (candidateStat.isDirectory()) selected = join(selected, 'index.html')
      selectedStat = await stat(selected)
      if (!selectedStat.isFile()) throw new Error('not a file')
    } catch {
      selected = options.fallbackFile
      try {
        selectedStat = await stat(selected)
        if (!selectedStat.isFile()) throw new Error('not a file')
      } catch {
        this.sendStaticText(response, method, 404, 'Not found')
        return
      }
    }
    if (selectedStat.size > MAX_STATIC_ASSET_BYTES) {
      this.sendStaticText(response, method, 413, 'Static asset is too large')
      return
    }

    const requestedRange = request.headers.range
    const range = requestedRange
      ? this.parseStaticRange(requestedRange, selectedStat.size)
      : undefined
    if (range === null) {
      this.sendStaticText(response, method, 416, 'Range not satisfiable', {
        'content-range': `bytes */${selectedStat.size}`,
        'accept-ranges': 'bytes',
      })
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, selectedStat.size - 1)
    const contentLength = selectedStat.size === 0 ? 0 : end - start + 1
    const status = range ? 206 : 200
    if (
      method !== 'HEAD'
      && selectedStat.size > 0
      && options.streamState.active >= MAX_STATIC_CONCURRENT_STREAMS
    ) {
      this.sendStaticText(response, method, 503, 'Static server is busy', { 'retry-after': '1' })
      return
    }
    response.statusCode = status
    response.setHeader(
      'content-type',
      CONTENT_TYPES[extname(selected).toLowerCase()] ?? 'application/octet-stream',
    )
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader(
      'cache-control',
      selected.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    )
    response.setHeader('accept-ranges', 'bytes')
    response.setHeader('content-length', String(contentLength))
    if (range) response.setHeader('content-range', `bytes ${start}-${end}/${selectedStat.size}`)
    if (method === 'HEAD' || selectedStat.size === 0) {
      response.end()
      return
    }

    options.streamState.active += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      options.streamState.active -= 1
    }
    response.once('finish', release)
    const stream = createReadStream(selected, { start, end })
    response.once('close', () => {
      release()
      stream.destroy()
    })
    stream.once('error', () => {
      release()
      if (response.headersSent) response.destroy()
      else {
        this.sendStaticText(response, method, 500, 'Static asset could not be read')
      }
    })
    stream.pipe(response)
  }

  private sendStaticText(
    response: ServerResponse,
    method: string,
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): void {
    response.statusCode = status
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
    if (!response.hasHeader('content-type')) {
      response.setHeader('content-type', 'text/plain; charset=utf-8')
    }
    response.setHeader('content-length', String(Buffer.byteLength(body)))
    response.end(method === 'HEAD' ? undefined : body)
  }

  private parseStaticRange(
    header: string,
    size: number,
  ): { start: number; end: number } | null {
    if (size <= 0 || !header.startsWith('bytes=') || header.includes(',')) return null
    const match = /^bytes=(\d*)-(\d*)$/.exec(header)
    if (!match || (!match[1] && !match[2])) return null
    if (!match[1]) {
      const suffixLength = Number(match[2])
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
      return { start: Math.max(0, size - suffixLength), end: size - 1 }
    }
    const start = Number(match[1])
    const requestedEnd = match[2] ? Number(match[2]) : size - 1
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(requestedEnd)
      || start < 0
      || start >= size
      || requestedEnd < start
    ) {
      return null
    }
    return { start, end: Math.min(requestedEnd, size - 1) }
  }

  private async waitForHealthcheck(
    handle: ManagedRuntime,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = this.now() + timeoutMs
    const healthUrl = `http://127.0.0.1:${handle.port}${handle.manifest.healthcheck}`
    let ownershipProven = false
    while (this.now() < deadline) {
      if (handle.stopRequested || this.shuttingDown) {
        throw new LocalAppRuntimeError('START_FAILED', `Start of ${handle.appId} was cancelled`)
      }
      this.throwIfStartCancelled(signal, handle.appId)
      if (handle.spawnError) {
        throw new LocalAppRuntimeError(
          'START_FAILED',
          `Runtime could not be launched: ${handle.spawnError.message}`,
        )
      }
      if (handle.child?.exitCode != null || handle.child?.signalCode != null) {
        if (await this.isPortInUse(handle.port)) {
          throw new LocalAppRuntimeError(
            'PORT_UNAVAILABLE',
            `Port ${handle.port} was claimed by another listener before ${handle.appId} became healthy`,
            { port: handle.port, healthUrl },
          )
        }
        throw new LocalAppRuntimeError(
          'PROCESS_CRASHED',
          `${handle.appId} exited before its health check succeeded`,
          { exitCode: handle.child.exitCode, signal: handle.child.signalCode },
        )
      }
      const healthProbe = await this.probeOwnedHealthcheck(healthUrl, handle.healthToken)
      if (healthProbe.kind === 'foreign') {
        throw new LocalAppRuntimeError(
          'PORT_UNAVAILABLE',
          `Port ${handle.port} responded without the ownership challenge for ${handle.appId}`,
          {
            port: handle.port,
            healthUrl,
            statusCode: healthProbe.statusCode,
          },
        )
      }
      if (healthProbe.kind === 'healthy' || healthProbe.kind === 'owned_unhealthy') {
        ownershipProven = true
      }
      if (healthProbe.kind === 'healthy') {
        if (handle.manifest.runtime !== 'static') return
        const webProbe = await this.probeOwnedHealthcheck(handle.url, handle.healthToken)
        if (webProbe.kind === 'foreign') {
          throw new LocalAppRuntimeError(
            'PORT_UNAVAILABLE',
            `Static port ${handle.port} failed its ownership challenge`,
            { port: handle.port, url: handle.url },
          )
        }
        if (webProbe.kind === 'healthy') return
      }
      await delay(200)
    }
    if (!ownershipProven && await this.isPortInUse(handle.port)) {
      throw new LocalAppRuntimeError(
        'PORT_UNAVAILABLE',
        `Port ${handle.port} is occupied but ${handle.appId} did not prove ownership`,
        { port: handle.port, healthUrl },
      )
    }
    throw new LocalAppRuntimeError(
      'START_TIMEOUT',
      `${handle.appId} did not pass ${handle.manifest.healthcheck} within ${timeoutMs}ms`,
      { healthUrl, timeoutMs },
    )
  }

  private probeOwnedHealthcheck(
    url: string,
    healthToken: string,
  ): Promise<{
    kind: 'healthy' | 'owned_unhealthy' | 'foreign' | 'unreachable'
    statusCode?: number
  }> {
    return new Promise(resolveHealth => {
      let settled = false
      const settle = (
        result: {
          kind: 'healthy' | 'owned_unhealthy' | 'foreign' | 'unreachable'
          statusCode?: number
        },
      ) => {
        if (settled) return
        settled = true
        resolveHealth(result)
      }
      const request = httpGet(url, { timeout: 1_000 }, response => {
        response.resume()
        const statusCode = response.statusCode
        const presentedToken = response.headers[HEALTH_OWNERSHIP_HEADER]
        const ownsPort = presentedToken === healthToken
        if (!ownsPort) {
          settle({ kind: 'foreign', ...(statusCode ? { statusCode } : {}) })
          return
        }
        settle({
          kind: statusCode && statusCode >= 200 && statusCode < 400
            ? 'healthy'
            : 'owned_unhealthy',
          ...(statusCode ? { statusCode } : {}),
        })
      })
      request.once('timeout', () => {
        request.destroy()
        settle({ kind: 'unreachable' })
      })
      request.once('error', () => settle({ kind: 'unreachable' }))
    })
  }

  private registerManagedProcess(
    appId: string,
    kind: ManagedProcessOperation['kind'],
    child: ChildProcess,
    processTreeOwner?: WindowsJobObjectOwner | WindowsProcessTreeOwner,
    processTreeOwnerAssigned?: boolean,
  ): ManagedProcessOperation {
    const operation: ManagedProcessOperation = {
      id: randomUUID(),
      appId,
      kind,
      child,
      processTreeOwner,
      processTreeOwnerAssigned,
    }
    this.managedProcesses.set(operation.id, operation)
    return operation
  }

  private cleanupManagedProcess(
    operation: ManagedProcessOperation,
    force = false,
  ): Promise<void> {
    if (operation.cleanupPromise) return operation.cleanupPromise
    const cleanupPromise: Promise<void> = this.terminateManagedProcess(operation, force)
      .then(() => {
        delete operation.lastCleanupError
        if (this.managedProcesses.get(operation.id) === operation) {
          this.managedProcesses.delete(operation.id)
        }
      })
      .catch((error) => {
        operation.lastCleanupError = error
        throw error
      })
      .finally(() => {
        if (operation.cleanupPromise === cleanupPromise) {
          operation.cleanupPromise = undefined
        }
      })
    operation.cleanupPromise = cleanupPromise
    return cleanupPromise
  }

  private async terminateManagedProcess(
    operation: ManagedProcessOperation,
    force: boolean,
  ): Promise<void> {
    if (
      operation.processTreeOwner
      && operation.processTreeOwnerAssigned === false
    ) {
      await this.terminateUnassignedWindowsGate(operation, force)
      return
    }
    if (force) {
      await this.forceTerminateManagedProcess(operation)
      return
    }
    await this.killProcessTree(operation.child, operation.processTreeOwner)
  }

  private async terminateUnassignedWindowsGate(
    operation: ManagedProcessOperation,
    force: boolean,
  ): Promise<void> {
    let ownerError: unknown
    let gateError: unknown
    try {
      await operation.processTreeOwner!.terminate()
    } catch (error) {
      ownerError = error
    }
    try {
      if (force) await this.forceKillProcessTree(operation.child)
      else await this.killProcessTree(operation.child)
    } catch (error) {
      gateError = error
    }
    if (ownerError || gateError) {
      throw new LocalAppRuntimeError(
        'STOP_FAILED',
        `Unassigned Windows ${operation.kind} gate ${operation.child.pid ?? 'unknown'} could not be fully cleaned up`,
        {
          ...(ownerError ? { ownerError: this.formatError(ownerError) } : {}),
          ...(gateError ? { gateError: this.formatError(gateError) } : {}),
        },
      )
    }
  }

  private async forceTerminateManagedProcess(
    operation: ManagedProcessOperation,
  ): Promise<void> {
    if (operation.processTreeOwner) {
      try {
        await this.killProcessTree(operation.child, operation.processTreeOwner)
        return
      } catch (ownerError) {
        let forceError: unknown
        try {
          await this.forceKillProcessTree(operation.child)
        } catch (error) {
          forceError = error
        }
        // A PID-based fallback cannot prove that descendants of an already
        // exited Windows root are gone. Keep the owner registered so its Job
        // Object/snapshot confirmation can be retried.
        throw new LocalAppRuntimeError(
          'STOP_FAILED',
          `Managed ${operation.kind} process tree ${operation.child.pid ?? 'unknown'} lacks owner-confirmed cleanup`,
          {
            ownerError: this.formatError(ownerError),
            ...(forceError ? { forceError: this.formatError(forceError) } : {}),
          },
        )
      }
    }
    await this.forceKillProcessTree(operation.child)
  }

  private async retryManagedProcessCleanup(
    appId?: string,
  ): Promise<Array<{
    appId: string
    kind: ManagedProcessOperation['kind']
    pid?: number
    attempts: number
    error: string
  }>> {
    const operations = [...this.managedProcesses.values()]
      .filter(operation => appId === undefined || operation.appId === appId)
    const results = await Promise.all(operations.map(async (operation) => {
      let attempts = 0
      let lastError = operation.lastCleanupError
      while (
        attempts < MAX_FORCE_CLEANUP_ATTEMPTS
        && this.managedProcesses.get(operation.id) === operation
      ) {
        attempts += 1
        if (attempts > 1) await delay(SHUTDOWN_FORCE_RETRY_DELAY_MS)
        try {
          await this.cleanupManagedProcess(operation, true)
        } catch (error) {
          lastError = error
        }
      }
      if (this.managedProcesses.get(operation.id) !== operation) return null
      return {
        appId: operation.appId,
        kind: operation.kind,
        ...(operation.child.pid ? { pid: operation.child.pid } : {}),
        attempts,
        error: this.formatError(lastError),
      }
    }))
    return results.filter((result): result is NonNullable<typeof result> => result !== null)
  }

  private stopRuntime(handle: ManagedRuntime): Promise<void> {
    if (handle.stopPromise) return handle.stopPromise
    const stopPromise = (async () => {
      handle.stopRequested = true
      if (handle.server) {
        await new Promise<void>((resolveClose) => {
          handle.server!.close(() => resolveClose())
          handle.server!.closeAllConnections?.()
        })
      }
      if (handle.cleanupPromise) {
        await handle.cleanupPromise
      } else if (
        handle.child
        && (
          handle.processTreeOwner
          || (handle.child.exitCode == null && handle.child.signalCode == null)
        )
      ) {
        if (handle.managedProcess) {
          await this.cleanupManagedProcess(handle.managedProcess)
        } else {
          await this.killProcessTree(handle.child, handle.processTreeOwner)
        }
      }
      if (this.runtimes.get(handle.appId) === handle) this.runtimes.delete(handle.appId)
      this.appendLog(handle.appId, 'system', `Stopped ${handle.version}`)
    })()
    const trackedStopPromise = stopPromise.catch((error) => {
      if (handle.stopPromise === trackedStopPromise) handle.stopPromise = undefined
      throw asLocalAppRuntimeError(
        error,
        'STOP_FAILED',
        `Failed to stop ${handle.appId}`,
      )
    })
    handle.stopPromise = trackedStopPromise
    return trackedStopPromise
  }

  private async forceStopRuntime(handle: ManagedRuntime): Promise<void> {
    handle.stopRequested = true
    if (handle.server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        handle.server!.close(error => {
          if (error) rejectClose(error)
          else resolveClose()
        })
        handle.server!.closeAllConnections?.()
      })
    }
    if (handle.cleanupPromise) {
      await handle.cleanupPromise.catch(() => {})
      handle.cleanupPromise = undefined
    }
    if (handle.managedProcess) {
      await this.cleanupManagedProcess(handle.managedProcess, true)
    } else if (handle.child) {
      await this.forceKillProcessTree(handle.child)
    }
    if (this.runtimes.get(handle.appId) === handle) this.runtimes.delete(handle.appId)
    this.appendLog(handle.appId, 'system', `Force-stopped ${handle.version}`)
  }

  private async forceKillProcessTree(child: ChildProcess): Promise<void> {
    const pid = child.pid
    if (!pid) return
    if (this.platform === 'win32') {
      if (child.exitCode != null || child.signalCode != null) return
      await new Promise<void>((resolveKill) => {
        const killer = this.processSpawner('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => resolveKill())
        killer.once('exit', () => resolveKill())
      })
      if (!await this.waitForChildExit(child, 1_000)) {
        throw new LocalAppRuntimeError(
          'STOP_FAILED',
          `Windows process tree ${pid} survived forced taskkill`,
        )
      }
      return
    }

    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process exited between the checks.
      }
    }
    const [rootKilled, groupKilled] = await Promise.all([
      this.waitForChildExit(child, 1_000),
      this.waitForProcessGroupExit(pid, 1_000),
    ])
    if (!rootKilled || !groupKilled) {
      throw new LocalAppRuntimeError(
        'STOP_FAILED',
        `Process tree ${pid} survived forced SIGKILL`,
      )
    }
  }

  private async killProcessTree(
    child: ChildProcess,
    processTreeOwner?: WindowsJobObjectOwner | WindowsProcessTreeOwner,
  ): Promise<void> {
    const pid = child.pid
    if (processTreeOwner) {
      try {
        await processTreeOwner.terminate()
      } catch (error) {
        throw new LocalAppRuntimeError(
          'STOP_FAILED',
          `Windows process tree ${pid ?? 'unknown'} could not be fully terminated`,
          { cause: error instanceof Error ? error.message : String(error) },
        )
      }
      if (!pid) return
      if (!await this.waitForChildExit(child, 1_000)) {
        throw new LocalAppRuntimeError(
          'STOP_FAILED',
          `Windows managed process ${pid} did not exit after its Job Object closed`,
        )
      }
      return
    }
    if (!pid) return
    if (this.platform === 'win32') {
      if (child.exitCode != null || child.signalCode != null) return
      await new Promise<void>((resolveKill) => {
        const killer = this.processSpawner('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => resolveKill())
        killer.once('exit', () => resolveKill())
      })
      if (!await this.waitForChildExit(child, 1_000)) {
        throw new LocalAppRuntimeError('STOP_FAILED', `Process tree ${pid} did not exit after taskkill`)
      }
      return
    }

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // The process exited between the checks.
        }
      }
    }
    signalGroup('SIGTERM')
    const [rootExited, groupExited] = await Promise.all([
      this.waitForChildExit(child, STOP_GRACE_MS),
      this.waitForProcessGroupExit(pid, STOP_GRACE_MS),
    ])
    if (!rootExited || !groupExited) {
      signalGroup('SIGKILL')
      const [rootKilled, groupKilled] = await Promise.all([
        this.waitForChildExit(child, 1_000),
        this.waitForProcessGroupExit(pid, 1_000),
      ])
      if (!rootKilled || !groupKilled) {
        throw new LocalAppRuntimeError('STOP_FAILED', `Process tree ${pid} did not exit after SIGKILL`)
      }
    }
  }

  private waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
    const isAlive = () => {
      try {
        process.kill(-processGroupId, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
      }
    }
    if (!isAlive()) return Promise.resolve(true)
    return new Promise(resolveExit => {
      const deadline = Date.now() + timeoutMs
      const poll = () => {
        if (!isAlive()) {
          resolveExit(true)
          return
        }
        if (Date.now() >= deadline) {
          resolveExit(false)
          return
        }
        setTimeout(poll, 25)
      }
      setTimeout(poll, 25)
    })
  }

  private waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true)
    return new Promise(resolveExit => {
      const timeout = setTimeout(() => {
        child.removeListener('exit', onExit)
        resolveExit(false)
      }, timeoutMs)
      const onExit = () => {
        clearTimeout(timeout)
        resolveExit(true)
      }
      child.once('exit', onExit)
    })
  }

  private captureChildOutput(appId: string, child: ChildProcess): void {
    const capture = (source: 'stdout' | 'stderr', chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line) this.appendLog(appId, source, line)
      }
    }
    child.stdout?.on('data', chunk => capture('stdout', chunk))
    child.stderr?.on('data', chunk => capture('stderr', chunk))
  }

  private appendLog(
    appId: string,
    source: 'stdout' | 'stderr' | 'system',
    message: string,
  ): void {
    this.getLogWriter(appId).append(source, message)
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`
    return String(error)
  }

  private getLogWriter(appId: string): BoundedLogWriter {
    let writer = this.logWriters.get(appId)
    if (!writer) {
      writer = new BoundedLogWriter({
        path: this.getLogPath(appId),
        now: this.now,
        onError: error =>
          this.logger.warn(`[local-apps] failed to write bounded log for ${appId}`, error),
      })
      this.logWriters.set(appId, writer)
    }
    return writer
  }

  private async allocatePort(): Promise<number> {
    if (this.portAllocator) {
      const port = await this.portAllocator()
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new LocalAppRuntimeError(
          'PORT_UNAVAILABLE',
          `Port allocator returned an invalid port: ${String(port)}`,
        )
      }
      return port
    }
    return new Promise<number>((resolvePort, rejectPort) => {
      const server = createNetServer()
      server.unref()
      server.once('error', error => rejectPort(new LocalAppRuntimeError(
        'PORT_UNAVAILABLE',
        `Could not allocate a localhost port: ${error.message}`,
      )))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          rejectPort(new LocalAppRuntimeError('PORT_UNAVAILABLE', 'Could not determine allocated port'))
          return
        }
        const port = address.port
        server.close(error => {
          if (error) rejectPort(new LocalAppRuntimeError('PORT_UNAVAILABLE', error.message))
          else resolvePort(port)
        })
      })
    })
  }

  private async assertPortAvailable(port: number): Promise<void> {
    if (!await this.isPortInUse(port)) return
    throw new LocalAppRuntimeError(
      'PORT_UNAVAILABLE',
      `Localhost port ${port} is already in use`,
      { port },
    )
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise(resolveCheck => {
      const server = createNetServer()
      let settled = false
      const settle = (inUse: boolean) => {
        if (settled) return
        settled = true
        resolveCheck(inUse)
      }
      server.unref()
      server.once('error', () => settle(true))
      server.listen(port, '127.0.0.1', () => {
        server.close(error => settle(Boolean(error)))
      })
    })
  }

  private buildRuntimeEnvironment(
    appId: string,
    version: string,
    versionDir: string,
    port: number,
    healthToken?: string,
  ): NodeJS.ProcessEnv {
    const cacheDir = join(this.runtimeCacheDir, appId, version)
    const environment: NodeJS.ProcessEnv = {}
    for (const key of RUNTIME_ENV_ALLOWLIST) {
      const value = this.readBaseEnvironmentValue(key)
      if (value !== undefined) environment[key] = value
    }
    return {
      ...environment,
      PORT: String(port),
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      POLO_APP_ID: appId,
      POLO_APP_VERSION: version,
      POLO_APP_DATA_DIR: this.getDataDir(appId),
      POLO_APP_BUNDLE_DIR: versionDir,
      ...(healthToken ? { POLO_APP_HEALTH_TOKEN: healthToken } : {}),
      UV_PROJECT_ENVIRONMENT: join(cacheDir, 'python-venv'),
      UV_CACHE_DIR: join(cacheDir, 'uv-cache'),
      UV_NO_CONFIG: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONUTF8: '1',
      BUN_INSTALL_CACHE_DIR: join(cacheDir, 'bun-cache'),
    }
  }

  private readBaseEnvironmentValue(key: string): string | undefined {
    if (this.baseEnvironment[key] !== undefined) return this.baseEnvironment[key]
    if (this.platform !== 'win32') return undefined
    const match = Object.keys(this.baseEnvironment)
      .find(candidate => candidate.toLowerCase() === key.toLowerCase())
    return match ? this.baseEnvironment[match] : undefined
  }

  private async requireRuntimeExecutable(value: string | undefined, label: string): Promise<string> {
    if (!value) {
      throw new LocalAppRuntimeError(
        'RUNTIME_UNAVAILABLE',
        `${label} runtime is not bundled with this Polo installation`,
      )
    }
    if (isAbsolute(value)) {
      try {
        await access(value)
      } catch {
        throw new LocalAppRuntimeError(
          'RUNTIME_UNAVAILABLE',
          `${label} runtime is missing at ${value}`,
        )
      }
    }
    return value
  }

  private buildAppUrl(port: number, webPath: string): string {
    return new URL(webPath, `http://127.0.0.1:${port}`).toString()
  }

  private resolveBundlePath(bundleDir: string, relativePath: string, field: string): string {
    const safePath = assertSafeRelativePath(relativePath, field)
    const absolute = resolve(bundleDir, safePath)
    const rootPrefix = bundleDir.endsWith(sep) ? bundleDir : `${bundleDir}${sep}`
    if (!absolute.startsWith(rootPrefix)) {
      throw new LocalAppRuntimeError('INVALID_MANIFEST', `${field} escapes the bundle`)
    }
    return absolute
  }

  private async isInstalledVersionUsable(appId: string, version: string): Promise<boolean> {
    try {
      const manifest = await this.loadAndValidateManifest(this.getVersionDir(appId, version))
      await this.validateRequiredFiles(this.getVersionDir(appId, version), manifest)
      return manifest.appId === appId && manifest.version === version
    } catch {
      return false
    }
  }

  private async markVersionBroken(
    metadata: AppMetadata,
    version: string,
    error: LocalAppRuntimeError,
  ): Promise<void> {
    metadata.brokenVersions = {
      ...(metadata.brokenVersions ?? {}),
      [version]: error.toJSON(),
    }
    if (metadata.lastKnownGoodVersion === version) {
      delete metadata.lastKnownGoodVersion
    }
    await this.writeMetadata(metadata)
    this.appendLog(metadata.appId, 'system', `${error.code}: ${error.message}`)
  }

  private async readMetadata(appId: string): Promise<AppMetadata | null> {
    try {
      const raw = JSON.parse(await readFile(this.getMetadataPath(appId), 'utf8')) as AppMetadata
      if (
        raw.schemaVersion !== METADATA_SCHEMA_VERSION
        || raw.appId !== appId
        || typeof raw.currentVersion !== 'string'
        || !raw.versions
        || typeof raw.versions !== 'object'
      ) {
        this.logger.warn(`[local-apps] invalid metadata for ${appId}`)
        return null
      }
      return raw
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`[local-apps] failed to read metadata for ${appId}`, error)
      }
      return null
    }
  }

  private async writeMetadata(metadata: AppMetadata): Promise<void> {
    const appDir = this.getAppDir(metadata.appId)
    await mkdir(appDir, { recursive: true })
    const metadataPath = this.getMetadataPath(metadata.appId)
    const temporaryPath = join(appDir, `.metadata-${randomUUID()}.tmp`)
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, metadataPath)
  }

  private async removeAbandonedStagingDirectories(): Promise<void> {
    const entries = await readdir(this.stagingDir, { withFileTypes: true })
    await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .map(entry => rm(join(this.stagingDir, entry.name), { recursive: true, force: true })))
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw this.getAbortError(
        signal,
        new LocalAppRuntimeError('INSTALL_CANCELLED', 'Installation was cancelled'),
      )
    }
  }

  private throwIfStartCancelled(signal: AbortSignal, appId: string): void {
    if (signal.aborted) {
      throw this.getAbortError(
        signal,
        new LocalAppRuntimeError('START_FAILED', `Start of ${appId} was cancelled`),
      )
    }
  }

  private getAbortError(
    signal: AbortSignal,
    fallback: LocalAppRuntimeError,
  ): LocalAppRuntimeError {
    return signal.reason instanceof LocalAppRuntimeError
      ? signal.reason
      : fallback
  }

  private getAppDir(appId: string): string {
    return join(this.appsDir, appId)
  }

  private getVersionDir(appId: string, version: string): string {
    return join(this.getAppDir(appId), 'versions', version)
  }

  private getDataDir(appId: string): string {
    return join(this.getAppDir(appId), 'data')
  }

  private getMetadataPath(appId: string): string {
    return join(this.getAppDir(appId), 'metadata.json')
  }

  private getLogPath(appId: string): string {
    return join(this.getAppDir(appId), 'logs', 'runtime.log')
  }
}
