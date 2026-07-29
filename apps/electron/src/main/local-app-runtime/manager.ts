import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import {
  access,
  appendFile,
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
import { createServer as createHttpServer, get as httpGet, type Server as HttpServer } from 'http'
import { createServer as createNetServer } from 'net'
import { arch as hostArch, platform as hostPlatform } from 'os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type {
  LocalAppArchitecture,
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
import { assertSafeRelativePath, validatePoloAppManifest } from './manifest'
import { asLocalAppRuntimeError, LocalAppRuntimeError } from './runtime-error'

const METADATA_SCHEMA_VERSION = 1
const DEFAULT_START_TIMEOUT_MS = 30_000
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const INSTALL_COMMAND_TIMEOUT_MS = 10 * 60_000
const STOP_GRACE_MS = 3_000
const MAX_LOG_TAIL = 10_000

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
  versions: Record<string, InstalledVersionRecord>
  brokenVersions?: Record<string, LocalAppErrorPayload>
}

interface ManagedRuntime {
  appId: string
  version: string
  manifest: PoloAppManifest
  port: number
  url: string
  child?: ChildProcess
  server?: HttpServer
  stopRequested: boolean
  stopPromise?: Promise<void>
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  spawnError?: Error
}

interface ActiveInstall {
  version: string
  controller: AbortController
  promise: Promise<LocalAppInstalledApp>
}

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
  logger?: LocalAppRuntimeLogger
  now?: () => number
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
  private readonly logger: LocalAppRuntimeLogger
  private readonly now: () => number
  private readonly activeInstalls = new Map<string, ActiveInstall>()
  private readonly runtimes = new Map<string, ManagedRuntime>()
  private readonly startPromises = new Map<string, Promise<LocalAppStartResult>>()
  private readonly statuses = new Map<string, LocalAppRuntimeStatus>()
  private readonly logWriteQueues = new Map<string, Promise<void>>()
  private initializationPromise?: Promise<void>
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
    this.logger = options.logger ?? noopLogger
    this.now = options.now ?? Date.now
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

  install(request: LocalAppInstallRequest): Promise<LocalAppInstalledApp> {
    const validated = this.validateInstallRequest(request)
    if (this.shuttingDown) {
      return Promise.reject(new LocalAppRuntimeError('INSTALL_CANCELLED', 'Polo is shutting down'))
    }

    const existing = this.activeInstalls.get(validated.appId)
    if (existing) {
      if (existing.version === validated.version) return existing.promise
      return Promise.reject(new LocalAppRuntimeError(
        'INVALID_REQUEST',
        `Another version of ${validated.appId} is already being installed`,
        { activeVersion: existing.version, requestedVersion: validated.version },
      ))
    }

    const controller = new AbortController()
    const promise = this.performInstall(validated, controller.signal)
      .finally(() => {
        const active = this.activeInstalls.get(validated.appId)
        if (active?.promise === promise) this.activeInstalls.delete(validated.appId)
      })
    this.activeInstalls.set(validated.appId, {
      version: validated.version,
      controller,
      promise,
    })
    return promise
  }

  cancelInstall(appId: string): boolean {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const active = this.activeInstalls.get(safeAppId)
    if (!active) return false
    active.controller.abort()
    return true
  }

  start(appId: string): Promise<LocalAppStartResult> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    if (this.shuttingDown) {
      return Promise.reject(new LocalAppRuntimeError('START_FAILED', 'Polo is shutting down'))
    }
    const existing = this.startPromises.get(safeAppId)
    if (existing) return existing

    const promise = this.performStart(safeAppId).finally(() => {
      if (this.startPromises.get(safeAppId) === promise) this.startPromises.delete(safeAppId)
    })
    this.startPromises.set(safeAppId, promise)
    return promise
  }

  async stop(appId: string): Promise<LocalAppRuntimeStatus> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const handle = this.runtimes.get(safeAppId)
    if (handle) await this.stopRuntime(handle)

    const metadata = await this.readMetadata(safeAppId)
    const status: LocalAppRuntimeStatus = metadata
      ? {
          appId: safeAppId,
          status: 'stopped',
          currentVersion: metadata.currentVersion,
          previousVersion: metadata.previousVersion,
        }
      : { appId: safeAppId, status: 'not_installed' }
    this.statuses.set(safeAppId, status)
    return status
  }

  async restart(appId: string): Promise<LocalAppStartResult> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    await this.stop(safeAppId)
    return this.start(safeAppId)
  }

  async uninstall(appId: string, options: LocalAppUninstallOptions = {}): Promise<void> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const activeInstall = this.activeInstalls.get(safeAppId)
    if (activeInstall) {
      activeInstall.controller.abort()
      await activeInstall.promise.catch(() => {})
    }
    try {
      await this.stop(safeAppId)
      const appDir = this.getAppDir(safeAppId)
      if (options.preserveData ?? true) {
        await Promise.all([
          rm(join(appDir, 'versions'), { recursive: true, force: true }),
          rm(join(appDir, 'metadata.json'), { force: true }),
          rm(join(appDir, 'logs'), { recursive: true, force: true }),
          rm(join(this.runtimeCacheDir, safeAppId), { recursive: true, force: true }),
        ])
      } else {
        await Promise.all([
          rm(appDir, { recursive: true, force: true }),
          rm(join(this.runtimeCacheDir, safeAppId), { recursive: true, force: true }),
        ])
      }
      this.statuses.set(safeAppId, { appId: safeAppId, status: 'not_installed' })
    } catch (error) {
      throw asLocalAppRuntimeError(error, 'UNINSTALL_FAILED', `Failed to uninstall ${safeAppId}`)
    }
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
      })
    }
    return apps.sort((left, right) => left.appId.localeCompare(right.appId))
  }

  async getRuntimeStatus(appId: string): Promise<LocalAppRuntimeStatus> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    const handle = this.runtimes.get(safeAppId)
    if (handle) {
      return {
        appId: safeAppId,
        status: this.statuses.get(safeAppId)?.status === 'starting' ? 'starting' : 'running',
        currentVersion: (await this.readMetadata(safeAppId))?.currentVersion,
        runningVersion: handle.version,
        url: handle.url,
        port: handle.port,
        ...(handle.child?.pid ? { pid: handle.child.pid } : {}),
      }
    }
    const transient = this.statuses.get(safeAppId)
    if (transient && ['downloading', 'installing', 'broken', 'stopped'].includes(transient.status)) {
      return { ...transient }
    }
    const metadata = await this.readMetadata(safeAppId)
    if (!metadata) return { appId: safeAppId, status: 'not_installed' }
    return {
      appId: safeAppId,
      status: 'installed',
      currentVersion: metadata.currentVersion,
      previousVersion: metadata.previousVersion,
    }
  }

  async getLogs(appId: string, options: LocalAppLogsOptions = {}): Promise<string> {
    const safeAppId = validateRequestIdentifier(appId, 'appId')
    await this.logWriteQueues.get(safeAppId)
    let content: string
    try {
      content = await readFile(this.getLogPath(safeAppId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
    const requestedTail = options.tail ?? 500
    const tail = Math.max(1, Math.min(MAX_LOG_TAIL, Math.floor(requestedTail)))
    const lines = content.split(/\r?\n/)
    return lines.slice(Math.max(0, lines.length - tail - 1)).join('\n')
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const install of this.activeInstalls.values()) install.controller.abort()
    await Promise.allSettled([
      ...[...this.runtimes.values()].map(runtime => this.stopRuntime(runtime)),
      ...this.startPromises.values(),
      ...[...this.activeInstalls.values()].map(install => install.promise),
    ])
    await Promise.allSettled([...this.runtimes.values()].map(runtime => this.stopRuntime(runtime)))
    await Promise.allSettled(this.logWriteQueues.values())
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

  private async performInstall(
    request: LocalAppInstallRequest,
    signal: AbortSignal,
  ): Promise<LocalAppInstalledApp> {
    await this.initialize()
    const existingMetadata = await this.readMetadata(request.appId)
    const existingVersion = existingMetadata?.versions[request.version]
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
      await extractBundleArchive(archivePath, extractedPath)
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

      const appDir = this.getAppDir(request.appId)
      const versionsDir = join(appDir, 'versions')
      const targetDir = this.getVersionDir(request.appId, request.version)
      await mkdir(versionsDir, { recursive: true })
      if (existsSync(targetDir)) await rm(targetDir, { recursive: true, force: true })
      await rename(extractedPath, targetDir)
      await mkdir(this.getDataDir(request.appId), { recursive: true })

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
      const nextMetadata: AppMetadata = {
        schemaVersion: METADATA_SCHEMA_VERSION,
        appId: request.appId,
        currentVersion: request.version,
        ...(previousVersion ? { previousVersion } : {}),
        versions,
        ...(metadata?.brokenVersions ? { brokenVersions: metadata.brokenVersions } : {}),
      }
      await this.writeMetadata(nextMetadata)
      this.statuses.set(request.appId, {
        appId: request.appId,
        status: 'installed',
        currentVersion: request.version,
        previousVersion: nextMetadata.previousVersion,
      })
      await this.appendLog(request.appId, 'system', `Installed ${request.version} (${manifest.runtime})`)
      const installed = (await this.getInstalledApps()).find(app => app.appId === request.appId)
      if (!installed) throw new LocalAppRuntimeError('NOT_INSTALLED', 'Installed metadata could not be reloaded')
      return installed
    } catch (error) {
      const runtimeError = signal.aborted
        ? new LocalAppRuntimeError('INSTALL_CANCELLED', `Installation of ${request.appId} was cancelled`)
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
      await this.appendLog(request.appId, 'system', `${runtimeError.code}: ${runtimeError.message}`)
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
      if (signal.aborted) throw new LocalAppRuntimeError('INSTALL_CANCELLED', 'Bundle download was cancelled')
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
    this.statuses.set(request.appId, {
      appId: request.appId,
      status: phase === 'downloading' ? 'downloading' : 'installing',
      currentVersion: undefined,
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
    await this.appendLog(appId, 'system', `Preparing dependencies with ${basename(command)}`)
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.captureChildOutput(appId, child)

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        void this.killProcessTree(child).catch(error =>
          this.logger.warn(`[local-apps] failed to terminate dependency installer for ${appId}`, error))
        rejectExit(new LocalAppRuntimeError(
          'DEPENDENCY_INSTALL_FAILED',
          `Dependency preparation exceeded ${INSTALL_COMMAND_TIMEOUT_MS}ms`,
        ))
      }, INSTALL_COMMAND_TIMEOUT_MS)
      const abort = () => {
        void this.killProcessTree(child).catch(error =>
          this.logger.warn(`[local-apps] failed to cancel dependency installer for ${appId}`, error))
        rejectExit(new LocalAppRuntimeError('INSTALL_CANCELLED', 'Dependency preparation was cancelled'))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', (error) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        rejectExit(new LocalAppRuntimeError(
          'RUNTIME_UNAVAILABLE',
          `Could not launch ${basename(command)}: ${error.message}`,
        ))
      })
      child.once('exit', (code, exitSignal) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        resolveExit({ code, signal: exitSignal })
      })
    })
    if (outcome.code !== 0) {
      throw new LocalAppRuntimeError(
        'DEPENDENCY_INSTALL_FAILED',
        `Dependency preparation exited with code ${outcome.code ?? 'null'}`,
        { signal: outcome.signal },
      )
    }
  }

  private async performStart(appId: string): Promise<LocalAppStartResult> {
    const running = this.runtimes.get(appId)
    if (running) {
      return {
        appId,
        version: running.version,
        url: running.url,
        port: running.port,
      }
    }
    const metadata = await this.readMetadata(appId)
    if (!metadata || !metadata.versions[metadata.currentVersion]) {
      throw new LocalAppRuntimeError('NOT_INSTALLED', `${appId} is not installed`)
    }

    const requestedVersion = metadata.currentVersion
    try {
      return await this.startVersion(metadata, requestedVersion)
    } catch (error) {
      const primaryError = asLocalAppRuntimeError(error, 'START_FAILED', `Failed to start ${appId}`)
      if (this.shuttingDown) {
        this.statuses.set(appId, {
          appId,
          status: 'stopped',
          currentVersion: requestedVersion,
        })
        throw primaryError
      }
      await this.markVersionBroken(metadata, requestedVersion, primaryError)
      const fallbackVersion = metadata.previousVersion
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

      await this.appendLog(appId, 'system', `Start failed for ${requestedVersion}; rolling back to ${fallbackVersion}`)
      metadata.currentVersion = fallbackVersion
      metadata.previousVersion = requestedVersion
      await this.writeMetadata(metadata)
      try {
        const result = await this.startVersion(metadata, fallbackVersion)
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

  private async startVersion(metadata: AppMetadata, version: string): Promise<LocalAppStartResult> {
    if (this.shuttingDown) {
      throw new LocalAppRuntimeError('START_FAILED', `Start of ${metadata.appId} was cancelled during shutdown`)
    }
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
      await this.waitForHealthcheck(handle, manifest.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
    } catch (error) {
      await this.stopRuntime(handle)
      throw error
    }
    this.statuses.set(metadata.appId, {
      appId: metadata.appId,
      status: 'running',
      currentVersion: metadata.currentVersion,
      runningVersion: version,
      url: handle.url,
      port: handle.port,
      ...(handle.child?.pid ? { pid: handle.child.pid } : {}),
    })
    await this.appendLog(metadata.appId, 'system', `Healthy at ${handle.url}`)
    return {
      appId: metadata.appId,
      version,
      url: handle.url,
      port: handle.port,
    }
  }

  private async startProcessRuntime(
    appId: string,
    version: string,
    versionDir: string,
    manifest: PoloAppManifest,
  ): Promise<ManagedRuntime> {
    const port = await this.allocatePort()
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
    const child = spawn(executable, args, {
      cwd: versionDir,
      env: this.buildRuntimeEnvironment(appId, version, versionDir, port),
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
      stopRequested: false,
      exitPromise,
    }
    child.once('error', (error) => {
      handle.spawnError = error
    })
    child.once('exit', (code, signal) => {
      resolveExit({ code, signal })
      if (this.runtimes.get(appId) === handle) this.runtimes.delete(appId)
      if (handle.stopRequested) return
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
      void this.appendLog(appId, 'system', `${runtimeError.code}: ${runtimeError.message}`)
    })
    await this.appendLog(appId, 'system', `Starting ${version} on port ${port}`)
    return handle
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
    const server = createHttpServer((request, response) => {
      void this.handleStaticRequest(request.url ?? '/', request.method ?? 'GET', {
        staticRoot,
        fallbackFile,
        healthcheck: manifest.healthcheck,
        webPath: manifest.webPath,
      }).then((result) => {
        response.statusCode = result.status
        for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value)
        if (request.method === 'HEAD') response.end()
        else response.end(result.body)
      }).catch((error) => {
        response.statusCode = 500
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.end('Internal server error')
        void this.appendLog(appId, 'stderr', error instanceof Error ? error.message : String(error))
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
      stopRequested: false,
      exitPromise,
    }
    await this.appendLog(appId, 'system', `Starting static ${version} on port ${port}`)
    return handle
  }

  private async handleStaticRequest(
    rawUrl: string,
    method: string,
    options: { staticRoot: string; fallbackFile: string; healthcheck: string; webPath: string },
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer | string }> {
    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405, headers: { allow: 'GET, HEAD' }, body: 'Method not allowed' }
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname)
    } catch {
      return { status: 400, headers: {}, body: 'Bad request' }
    }
    if (pathname === new URL(options.healthcheck, 'http://127.0.0.1').pathname) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        body: '{"ok":true}',
      }
    }

    const mountPath = new URL(options.webPath, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
    if (mountPath !== '/' && pathname !== mountPath && !pathname.startsWith(`${mountPath}/`)) {
      return { status: 404, headers: {}, body: 'Not found' }
    }
    const relativeUrlPath = mountPath === '/'
      ? pathname.slice(1)
      : pathname.slice(mountPath.length).replace(/^\/+/, '')
    if (relativeUrlPath.split('/').includes('..') || relativeUrlPath.includes('\0')) {
      return { status: 403, headers: {}, body: 'Forbidden' }
    }

    const candidate = resolve(options.staticRoot, relativeUrlPath || 'index.html')
    const rootPrefix = options.staticRoot.endsWith(sep) ? options.staticRoot : `${options.staticRoot}${sep}`
    if (candidate !== options.staticRoot && !candidate.startsWith(rootPrefix)) {
      return { status: 403, headers: {}, body: 'Forbidden' }
    }
    let selected = candidate
    try {
      const candidateStat = await stat(selected)
      if (candidateStat.isDirectory()) selected = join(selected, 'index.html')
      const selectedStat = await stat(selected)
      if (!selectedStat.isFile()) throw new Error('not a file')
    } catch {
      selected = options.fallbackFile
    }
    try {
      const body = await readFile(selected)
      return {
        status: 200,
        headers: {
          'content-type': CONTENT_TYPES[extname(selected).toLowerCase()] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'cache-control': selected.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
        },
        body,
      }
    } catch {
      return { status: 404, headers: {}, body: 'Not found' }
    }
  }

  private async waitForHealthcheck(handle: ManagedRuntime, timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs
    const healthUrl = `http://127.0.0.1:${handle.port}${handle.manifest.healthcheck}`
    while (this.now() < deadline) {
      if (handle.stopRequested || this.shuttingDown) {
        throw new LocalAppRuntimeError('START_FAILED', `Start of ${handle.appId} was cancelled`)
      }
      if (handle.spawnError) {
        throw new LocalAppRuntimeError(
          'START_FAILED',
          `Runtime could not be launched: ${handle.spawnError.message}`,
        )
      }
      if (handle.child?.exitCode != null || handle.child?.signalCode != null) {
        throw new LocalAppRuntimeError(
          'PROCESS_CRASHED',
          `${handle.appId} exited before its health check succeeded`,
          { exitCode: handle.child.exitCode, signal: handle.child.signalCode },
        )
      }
      if (await this.isHealthy(healthUrl)) return
      await delay(200)
    }
    throw new LocalAppRuntimeError(
      'START_TIMEOUT',
      `${handle.appId} did not pass ${handle.manifest.healthcheck} within ${timeoutMs}ms`,
      { healthUrl, timeoutMs },
    )
  }

  private isHealthy(url: string): Promise<boolean> {
    return new Promise(resolveHealth => {
      const request = httpGet(url, { timeout: 1_000 }, response => {
        response.resume()
        resolveHealth(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400))
      })
      request.once('timeout', () => {
        request.destroy()
        resolveHealth(false)
      })
      request.once('error', () => resolveHealth(false))
    })
  }

  private stopRuntime(handle: ManagedRuntime): Promise<void> {
    if (handle.stopPromise) return handle.stopPromise
    handle.stopPromise = (async () => {
      handle.stopRequested = true
      if (handle.server) {
        await new Promise<void>((resolveClose) => {
          handle.server!.close(() => resolveClose())
          handle.server!.closeAllConnections?.()
        })
      }
      if (handle.child && handle.child.exitCode == null && handle.child.signalCode == null) {
        await this.killProcessTree(handle.child)
      }
      if (this.runtimes.get(handle.appId) === handle) this.runtimes.delete(handle.appId)
      await this.appendLog(handle.appId, 'system', `Stopped ${handle.version}`)
    })()
    return handle.stopPromise
  }

  private async killProcessTree(child: ChildProcess): Promise<void> {
    const pid = child.pid
    if (!pid || child.exitCode != null || child.signalCode != null) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolveKill) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
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
    const exited = await this.waitForChildExit(child, STOP_GRACE_MS)
    if (!exited) {
      signalGroup('SIGKILL')
      if (!await this.waitForChildExit(child, 1_000)) {
        throw new LocalAppRuntimeError('STOP_FAILED', `Process tree ${pid} did not exit after SIGKILL`)
      }
    }
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
        if (line) void this.appendLog(appId, source, line)
      }
    }
    child.stdout?.on('data', chunk => capture('stdout', chunk))
    child.stderr?.on('data', chunk => capture('stderr', chunk))
  }

  private appendLog(appId: string, source: 'stdout' | 'stderr' | 'system', message: string): Promise<void> {
    const safeMessage = message.replaceAll('\0', '').replace(/\r?\n/g, '\n')
    const line = `[${new Date(this.now()).toISOString()}] [${source}] ${safeMessage}\n`
    const previous = this.logWriteQueues.get(appId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.getLogPath(appId)), { recursive: true })
        await appendFile(this.getLogPath(appId), line, 'utf8')
      })
      .catch((error) => {
        this.logger.warn(`[local-apps] failed to append log for ${appId}`, error)
      })
    this.logWriteQueues.set(appId, next)
    return next
  }

  private async allocatePort(): Promise<number> {
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

  private buildRuntimeEnvironment(
    appId: string,
    version: string,
    versionDir: string,
    port: number,
  ): NodeJS.ProcessEnv {
    const cacheDir = join(this.runtimeCacheDir, appId, version)
    return {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      POLO_APP_ID: appId,
      POLO_APP_VERSION: version,
      POLO_APP_DATA_DIR: this.getDataDir(appId),
      POLO_APP_BUNDLE_DIR: versionDir,
      UV_PROJECT_ENVIRONMENT: join(cacheDir, 'python-venv'),
      UV_CACHE_DIR: join(cacheDir, 'uv-cache'),
      BUN_INSTALL_CACHE_DIR: join(cacheDir, 'bun-cache'),
    }
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
    await this.writeMetadata(metadata)
    await this.appendLog(metadata.appId, 'system', `${error.code}: ${error.message}`)
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
      throw new LocalAppRuntimeError('INSTALL_CANCELLED', 'Installation was cancelled')
    }
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
