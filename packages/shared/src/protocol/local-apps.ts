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
 * Persistence and runtime identity for a local app.
 *
 * Legacy callers remain isolated in the original appId namespace. Catalog
 * callers must provide the complete account/organization/app tuple so one
 * device can safely retain installations for multiple signed-in accounts.
 */
export type LocalAppScope =
  | {
      kind: 'legacy'
      appId: string
    }
  | {
      kind: 'catalog'
      accountId: string
      organizationId: string
      catalogAppId: string
    }

/**
 * Every renderer-to-main lifecycle request carries an explicit identity.
 * POO-12 callers use `kind: 'legacy'`; a missing scope never falls back to it.
 */
export type LocalAppReference = LocalAppScope

export type CatalogLocalAppScope = Extract<LocalAppScope, { kind: 'catalog' }>
export type LegacyLocalAppScope = Extract<LocalAppScope, { kind: 'legacy' }>

export function createLocalAppScopeKey(scope: LocalAppScope): string {
  return scope.kind === 'catalog'
    ? JSON.stringify([
        'catalog',
        scope.accountId,
        scope.organizationId,
        scope.catalogAppId,
      ])
    : JSON.stringify(['legacy', scope.appId])
}

/** Hard ceiling enforced by the runtime manager for one complete installation. */
export const LOCAL_APP_INSTALL_OPERATION_TIMEOUT_MS = 20 * 60_000

/**
 * Transport timeout leaves cleanup headroom after the manager's own deadline.
 * The server also aborts the handler signal if this ceiling is ever reached.
 */
export const LOCAL_APP_INSTALL_RPC_TIMEOUT_MS =
  LOCAL_APP_INSTALL_OPERATION_TIMEOUT_MS + 2 * 60_000

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
  /**
   * Business identity expected in polo-app.json. It may use the full Admin
   * entity-id contract and is deliberately separate from the filesystem-safe
   * runtime app id.
   */
  expectedManifestAppId?: string
  version: string
  downloadUrl: string
  checksum: string
  sizeBytes: number
  platform: LocalAppPlatform
  arch: LocalAppArchitecture
}

export interface LocalAppCatalogReleaseFingerprint {
  version: string
  checksum: string
  sizeBytes: number
  platform: LocalAppPlatform | null
  arch: LocalAppArchitecture | null
}

export function normalizeLocalAppPermissions(
  permissions: readonly string[] | null | undefined,
): string[] {
  return [...new Set(
    (permissions ?? [])
      .map(permission => permission.trim())
      .filter(Boolean),
  )].sort()
}

export interface LocalAppCatalogInstallRequest {
  scope: CatalogLocalAppScope
  /**
   * Exact Release metadata shown in the renderer confirmation dialog. Main
   * compares it with the currently authorized Catalog before downloading.
   */
  release: LocalAppCatalogReleaseFingerprint
  /** Catalog configuration shown with the confirmation dialog. */
  appConfigVersion: string
  /** Normalized permissions shown with the confirmation dialog. */
  permissions: string[]
}

export interface LocalAppLegacyInstallRequest extends LocalAppInstallRequest {
  scope: LegacyLocalAppScope
}

export type LocalAppRpcInstallRequest =
  | LocalAppCatalogInstallRequest
  | LocalAppLegacyInstallRequest

export interface LocalAppBatchStatusRequest {
  scopes: CatalogLocalAppScope[]
}

export interface LocalAppRemoteUrlResult {
  appId: string
  scope: CatalogLocalAppScope
  url: string
}

/**
 * Catalog-provided latest release metadata. Only `version` is required so the
 * client can publish update state before it has fetched full download details.
 */
export interface LocalAppAvailableRelease {
  version: string
  downloadUrl?: string
  checksum?: string
  sizeBytes?: number
  platform?: LocalAppPlatform
  arch?: LocalAppArchitecture
}

export interface LocalAppInstallProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'preparing'
  bytesDownloaded: number
  sizeBytes: number
  percent: number
}

export interface LocalAppRuntimeStatus {
  appId: string
  scope?: LocalAppScope
  status: LocalAppLifecycleStatus
  currentVersion?: string
  runningVersion?: string
  previousVersion?: string
  url?: string
  port?: number
  pid?: number
  /** Present when an update is downloading/installing while another version is running. */
  installationStatus?: 'downloading' | 'installing'
  progress?: LocalAppInstallProgress
  availableRelease?: LocalAppAvailableRelease
  versionError?: 'invalid_semver'
  error?: LocalAppErrorPayload
}

export interface LocalAppInstalledApp {
  appId: string
  scope?: LocalAppScope
  name?: string
  currentVersion: string
  previousVersion?: string
  versions: string[]
  runtime: LocalAppRuntimeKind
  status: LocalAppLifecycleStatus
  installedAt: number
  availableRelease?: LocalAppAvailableRelease
}

export interface LocalAppStartResult {
  appId: string
  scope?: LocalAppScope
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
  | 'INSTALL_TIMEOUT'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'UNSUPPORTED_ARCHIVE'
  | 'UNSAFE_ARCHIVE'
  | 'RUNTIME_UNAVAILABLE'
  | 'DEPENDENCY_INSTALL_FAILED'
  | 'RELEASE_CHANGED'
  | 'NOT_AUTHORIZED'
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
