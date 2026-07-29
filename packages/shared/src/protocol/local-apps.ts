export type LocalAppRuntimeKind = 'static' | 'python' | 'js'

export type LocalAppPlatform = 'darwin' | 'win32' | 'linux'
export type LocalAppArchitecture = 'arm64' | 'x64'

export type LocalAppLifecycleStatus =
  | 'not_installed'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'broken'
  | 'update_available'

/**
 * The on-disk `polo-app.json` contract.
 *
 * `entry` is deliberately an argv array. The runtime manager invokes the
 * bundled runtime directly and never evaluates a shell command.
 */
export interface PoloAppManifest {
  schemaVersion: 1
  appId: string
  version: string
  name?: string
  runtime: LocalAppRuntimeKind
  entry: string[]
  healthcheck: string
  webPath: string
  permissions: string[]
  platforms?: LocalAppPlatform[]
  architectures?: LocalAppArchitecture[]
  startTimeoutMs?: number
}

export interface LocalAppInstallRequest {
  appId: string
  version: string
  downloadUrl: string
  checksum: string
  sizeBytes: number
  platform: LocalAppPlatform
  arch: LocalAppArchitecture
}

export interface LocalAppInstallProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'preparing'
  bytesDownloaded: number
  sizeBytes: number
  percent: number
}

export interface LocalAppRuntimeStatus {
  appId: string
  status: LocalAppLifecycleStatus
  currentVersion?: string
  runningVersion?: string
  previousVersion?: string
  url?: string
  port?: number
  pid?: number
  progress?: LocalAppInstallProgress
  error?: LocalAppErrorPayload
}

export interface LocalAppInstalledApp {
  appId: string
  name?: string
  currentVersion: string
  previousVersion?: string
  versions: string[]
  runtime: LocalAppRuntimeKind
  status: LocalAppLifecycleStatus
  installedAt: number
}

export interface LocalAppStartResult {
  appId: string
  version: string
  url: string
  port: number
  rolledBackFrom?: string
}

export interface LocalAppLogsOptions {
  tail?: number
}

export interface LocalAppUninstallOptions {
  preserveData?: boolean
}

export type LocalAppErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_MANIFEST'
  | 'PLATFORM_MISMATCH'
  | 'ARCH_MISMATCH'
  | 'DOWNLOAD_FAILED'
  | 'INSTALL_CANCELLED'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'UNSUPPORTED_ARCHIVE'
  | 'UNSAFE_ARCHIVE'
  | 'RUNTIME_UNAVAILABLE'
  | 'DEPENDENCY_INSTALL_FAILED'
  | 'NOT_INSTALLED'
  | 'START_FAILED'
  | 'START_TIMEOUT'
  | 'PORT_UNAVAILABLE'
  | 'PROCESS_CRASHED'
  | 'STOP_FAILED'
  | 'UNINSTALL_FAILED'

export interface LocalAppErrorPayload {
  code: LocalAppErrorCode
  message: string
  details?: Record<string, unknown>
}
