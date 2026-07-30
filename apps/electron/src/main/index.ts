// Load user's shell environment first (before other imports that may use env)
// This ensures tools like Homebrew, nvm, etc. are available to the agent
import { loadShellEnv } from './shell-env'
loadShellEnv()

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { hostname, homedir } from 'os'
import * as Sentry from '@sentry/electron/main'

// Initialize Sentry error tracking as early as possible after app import.
// Only enabled in production (packaged) builds to avoid noise during development.
// DSN is baked in at build time via esbuild --define (same pattern as OAuth secrets).
//
// NOTE: Source map upload is intentionally disabled. Stack traces in Sentry will show
// bundled/minified code. To enable source map upload in the future:
//   1. Add SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT to CI secrets
//   2. Re-enable the @sentry/vite-plugin in vite.config.ts (handles renderer maps)
//   3. Add @sentry/esbuild-plugin to scripts/electron-build-main.ts (handles main process maps)
Sentry.init({
  dsn: process.env.SENTRY_ELECTRON_INGEST_URL,
  environment: app.isPackaged ? 'production' : 'development',
  release: app.getVersion(),
  // Enabled whenever the ingest URL is available — works in both production (baked via CI)
  // and development (injected via .env / 1Password). Filter by environment in Sentry dashboard.
  enabled: !!process.env.SENTRY_ELECTRON_INGEST_URL,

  // Scrub sensitive data before sending to Sentry.
  // Removes authorization headers, API keys/tokens, and credential-like values.
  beforeSend(event) {
    // Scrub request headers (authorization, cookies)
    if (event.request?.headers) {
      const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key']
      for (const header of sensitiveHeaders) {
        if (event.request.headers[header]) {
          event.request.headers[header] = '[REDACTED]'
        }
      }
    }

    // Scrub breadcrumb data that may contain sensitive values
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.data) {
          for (const key of Object.keys(breadcrumb.data)) {
            const lowerKey = key.toLowerCase()
            if (lowerKey.includes('token') || lowerKey.includes('key') ||
                lowerKey.includes('secret') || lowerKey.includes('password') ||
                lowerKey.includes('credential') || lowerKey.includes('auth')) {
              breadcrumb.data[key] = '[REDACTED]'
            }
          }
        }
      }
    }

    return event
  },
})

// Initialize i18n for main process (menus, dialogs, etc.)
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
setupI18n()

// Set anonymous machine ID for Sentry user tracking (no PII — just a hash).
// Uses hostname + homedir to produce a stable per-machine identifier.
const machineId = createHash('sha256').update(hostname() + homedir()).digest('hex').slice(0, 16)
Sentry.setUser({ id: machineId })

import { join, delimiter } from 'path'
import { existsSync, readFileSync } from 'fs'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@polo-ai/server-core/sessions'
import { registerAllRpcHandlers } from './handlers/index'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@polo-ai/server-core/handlers/rpc'
import type { PlatformServices } from '../runtime/platform'
import { createElectronPlatform } from './platform'
import type { HandlerDeps } from './handlers/handler-deps'
import { bootstrapServer, releaseServerLock } from '@polo-ai/server-core/bootstrap'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@polo-ai/messaging-gateway'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import { initModelRefreshService, getModelRefreshService, setFetcherPlatform } from '@polo-ai/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@polo-ai/server-core/services'
import { createApplicationMenu } from './menu'
import { WindowManager } from './window-manager'
import { loadWindowState, saveWindowState } from './window-state'
import {
  addWorkspace,
  getWorkspaces,
  getWorkspaceByNameOrId,
  initializeStoredConfigIfMissing,
} from '@polo-ai/shared/config'
import { getDefaultWorkspacesDir } from '@polo-ai/shared/workspaces'
import { initializeDocs } from '@polo-ai/shared/docs'
import { initializeReleaseNotes } from '@polo-ai/shared/release-notes'
import { ensureDefaultPermissions } from '@polo-ai/shared/agent/permissions-config'
import { ensureToolIcons, ensurePresetThemes } from '@polo-ai/shared/config'
import { setBundledAssetsRoot } from '@polo-ai/shared/utils'
import { initializeBackendHostRuntime } from '@polo-ai/shared/agent/backend'
import { setPowerShellValidatorRoot } from '@polo-ai/shared/agent'
import { handleDeepLink } from './deep-link'
import { describeDeepLinkForLog, describeUrlForLog } from './deep-link-log'
import { findDeepLinkArgument } from './deep-link-argv'
import { getDeepLinkCallbackBridge } from './deep-link-callback-bridge'
import { BrowserPaneManager } from './browser-pane-manager'
import { OAuthFlowStore } from '@polo-ai/shared/auth'
import { registerThumbnailScheme, registerThumbnailHandler } from './thumbnail-protocol'
import log, { isDebugMode, mainLog, getLogFilePath, getMessagingGatewayLogFilePath, messagingGatewayLog } from './logger'
import { setPerfEnabled, enableDebug } from '@polo-ai/shared/utils'
import { registerPiModelResolver } from '@polo-ai/shared/config'
import { getPiModelsForAuthProvider, getAllPiModels } from '@polo-ai/shared/config'
import { initNotificationService, initBadgeIcon, initInstanceBadge, updateBadgeCount } from './notifications'
import { checkForUpdatesOnLaunch, setAutoUpdateEventSink, isUpdating, setBeforeUpdateQuitHook } from './auto-update'
import { WsRpcClient, type EventSink } from '@polo-ai/server-core/transport'
import { validateGitBashPath, checkVCRedistInstalled } from '@polo-ai/server-core/services'
import { hasLocalAppRuntimeManager, shutdownLocalAppRuntime } from './local-app-runtime'
import { resolveBundledBunPath } from './local-app-runtime/runtime-paths'
import {
  removeElectronRuntimeDiscovery,
  writeElectronRuntimeDiscovery,
  type ElectronRuntimeDiscoveryWriteResult,
} from '@polo-ai/shared/runtime-discovery'
import {
  BeforeQuitCleanupCoordinator,
  canQuitAfterLocalAppShutdown,
} from './local-app-runtime/quit-guard'
import {
  getTerminalIntegrationStatus,
  installTerminalIntegration,
  setTerminalSetupDismissed,
  toTerminalIntegrationErrorPayload,
  uninstallTerminalIntegration,
  type TerminalIntegrationOptions,
} from './terminal-integration'
import {
  executeTerminalIntegrationCommand,
  parseTerminalIntegrationCommand,
} from './terminal-integration-command'
import { runTerminalOnboarding } from './terminal-onboarding'
import { runNonCriticalTerminalOnboarding } from './startup-continuation'
import { TERMINAL_INTEGRATION_ERROR_KEYS } from '../shared/terminal-integration'
import type {
  TerminalIntegrationOperation,
  TerminalIntegrationResult,
} from '../shared/types'

// Initialize electron-log for renderer process support
log.initialize()

// Enable debug/perf in dev mode (running from source)
if (isDebugMode) {
  process.env.POLO_AI_DEBUG = '1'
  enableDebug()
  setPerfEnabled(true)
}

// Bundle CLI tools: resolve platform-specific uv binary and wrapper scripts.
// These are available to all agent Bash sessions via POLO_AI_UV, POLO_AI_SCRIPTS env vars
// and PATH prepend. uv auto-downloads Python 3.12 on first use (~5s, then cached).
{
  // In packaged app: resources are at process.resourcesPath/app/resources/
  // In dev: resources are at __dirname/../resources/ (sibling of dist/)
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(__dirname, '..')
  const platformKey = `${process.platform}-${process.arch}`
  const uvPlatformDir = join(resourcesBase, 'resources', 'bin', platformKey)
  const uvBinary = join(uvPlatformDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const binDir = join(resourcesBase, 'resources', 'bin')
  const scriptsDir = join(resourcesBase, 'resources', 'scripts')

  const bundledUvExists = existsSync(uvBinary)
  const fallbackUv = bundledUvExists ? null : 'uv'

  // Runtime resolver hints for shared session tools
  process.env.POLO_AI_IS_PACKAGED = app.isPackaged ? '1' : '0'
  process.env.POLO_AI_RESOURCES_BASE = resourcesBase
  process.env.POLO_AI_APP_ROOT = app.isPackaged ? app.getAppPath() : process.cwd()

  process.env.POLO_AI_UV = bundledUvExists ? uvBinary : (fallbackUv ?? uvBinary)

  // Bun runtime (packaged builds should prefer bundled runtime over PATH)
  const bunBinary = resolveBundledBunPath({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    appResourcesBase: resourcesBase,
  })
  if (existsSync(bunBinary)) {
    process.env.POLO_AI_BUN = bunBinary
  } else if (!app.isPackaged) {
    process.env.POLO_AI_BUN = process.env.POLO_AI_BUN || 'bun'
  }

  process.env.POLO_AI_SCRIPTS = scriptsDir
  process.env.POLO_AI_COMMANDS_ENTRY = app.isPackaged
    ? join(app.getAppPath(), 'dist', 'cli', 'polo-cli.js')
    : join(process.cwd(), 'apps', 'cli', 'src', 'index.ts')
  process.env.POLO_AI_CLI_ENTRY = app.isPackaged
    ? join(app.getAppPath(), 'dist', 'cli', 'polo-cli.js')
    : join(process.cwd(), 'apps', 'cli', 'src', 'index.ts')
  process.env.POLO_AI_SERVER_ENTRY = app.isPackaged
    ? join(app.getAppPath(), 'dist', 'server', 'polo-server.js')
    : join(process.cwd(), 'packages', 'server', 'src', 'index.ts')
  process.env.POLO_AI_DESKTOP_EXECUTABLE = process.execPath
  if (process.platform === 'darwin') {
    process.env.POLO_AI_DESKTOP_APP = join(process.resourcesPath, '..', '..')
  }
  process.env.POLO_AI_COMMANDS_DOC_PATH = app.isPackaged
    ? join(resourcesBase, 'resources', 'docs', 'polo-ai.md')
    : join(process.cwd(), 'apps', 'electron', 'resources', 'docs', 'polo-ai.md')
  process.env.POLO_AI_CLI_DOC_PATH = process.env.POLO_AI_COMMANDS_DOC_PATH
  process.env.POLO_AI_AGENT_VERSION = app.getVersion()
  // Prepend both generic wrappers dir and platform uv dir:
  // - binDir exposes wrapper commands (pdf-tool, docx-tool, ...)
  // - uvPlatformDir exposes raw `uv` for direct shell usage / debugging
  process.env.PATH = `${binDir}${delimiter}${uvPlatformDir}${delimiter}${process.env.PATH}`

  if (!bundledUvExists) {
    mainLog.warn('Bundled uv binary missing, CLI document tools may fail unless uv is available on PATH.', {
      expectedUvPath: uvBinary,
      usingPoloAiUv: process.env.POLO_AI_UV,
    })
  }

  if (isDebugMode) {
    mainLog.info('CLI tools configured:', { uvBinary: process.env.POLO_AI_UV, binDir, scriptsDir, bundledUvExists })
  }
}

// Windows and AppImage launchers enter here for terminal commands. Run the
// packaged CLI with the embedded Bun runtime without initializing any windows.
const poloCliArgIndex = process.argv.indexOf('--polo-cli')
if (poloCliArgIndex >= 0) {
  const bun = process.env.POLO_AI_BUN
  const entry = process.env.POLO_AI_CLI_ENTRY
  if (!bun || !entry || !existsSync(bun) || !existsSync(entry)) {
    process.stderr.write(`Error: ${i18n.t('cli.terminalFilesMissing')}\n`)
    process.exit(1)
  }
  const result = spawnSync(bun, ['run', entry, ...process.argv.slice(poloCliArgIndex + 1)], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  })
  process.exit(result.status ?? 1)
}

// Register Pi model resolver so llm-connections.ts can resolve Pi models
// without importing @mariozechner/pi-ai (which breaks the Vite renderer build)
registerPiModelResolver((piAuthProvider) =>
  piAuthProvider ? getPiModelsForAuthProvider(piAuthProvider) : getAllPiModels()
)

// Custom URL scheme for deeplinks (e.g., poloai://auth-complete)
// Supports multi-instance dev: POLO_AI_DEEPLINK_SCHEME env var (poloai1, poloai2, etc.)
const DEEPLINK_SCHEME = process.env.POLO_AI_DEEPLINK_SCHEME || 'poloai'

let windowManager: WindowManager | null = null
let sessionManager: SessionManager | null = null
let browserPaneManager: BrowserPaneManager | null = null
let oauthFlowStore: OAuthFlowStore | null = null
let moduleSink: EventSink | null = null
let moduleClientResolver: ((webContentsId: number) => string | undefined) | null = null
let adminResumeValidationInFlight: Promise<void> | null = null
const electronRuntimeInstance = {
  instanceId: randomUUID(),
  startedAt: new Date().toISOString(),
}
let publishedElectronRuntime: ElectronRuntimeDiscoveryWriteResult | null = null

const ADMIN_REAUTH_REQUIRED_CHANNEL = 'admin:reauthRequired'

// Messaging gateway: the bootstrap handle is created once sessionManager is
// available (inside createHandlerDeps) and populated with the WS publisher
// after bootstrapServer resolves. Both hosts (Electron + standalone) wire
// through createMessagingBootstrap — do not construct MessagingGatewayRegistry
// directly.
let messagingHandle: MessagingBootstrapHandle | null = null

function terminalIntegrationOptions(): TerminalIntegrationOptions {
  return {
    platform: process.platform,
    homeDir: process.env.POLO_AI_TERMINAL_HOME,
    shell: process.env.SHELL,
    resourcesPath: process.resourcesPath,
    appExecutable: process.execPath,
    appVersion: app.getVersion(),
  }
}

function terminalIntegrationIpcResult(
  operation: TerminalIntegrationOperation,
  run: () => ReturnType<typeof getTerminalIntegrationStatus>,
): TerminalIntegrationResult {
  try {
    return { success: true, status: run() }
  } catch (error) {
    mainLog.error(`[terminal-integration] ${operation} failed`, error)
    return {
      success: false,
      ...toTerminalIntegrationErrorPayload(error, operation),
    }
  }
}

function terminalSetupCopy() {
  return {
    conflictTitle: i18n.t('dialog.terminalSetup.conflictTitle'),
    conflictMessage: i18n.t('dialog.terminalSetup.conflictMessage'),
    conflictDetail: i18n.t('dialog.terminalSetup.conflictDetail'),
    setupTitle: i18n.t('dialog.terminalSetup.setupTitle'),
    setupDetail: i18n.t('dialog.terminalSetup.setupDetail'),
    completeNow: i18n.t('dialog.terminalSetup.completeNow'),
    notNow: i18n.t('dialog.terminalSetup.notNow'),
    completeTitle: i18n.t('dialog.terminalSetup.completeTitle'),
    completeMessage: i18n.t('dialog.terminalSetup.completeMessage'),
    newTerminal: i18n.t('dialog.terminalSetup.newTerminal'),
    failedTitle: i18n.t('dialog.terminalSetup.failedTitle'),
    failedMessage: i18n.t('dialog.terminalSetup.failedMessage'),
    skippedTitle: i18n.t('dialog.terminalSetup.skippedTitle'),
    skippedMessage: i18n.t('dialog.terminalSetup.skippedMessage'),
    skippedDetail: i18n.t('dialog.terminalSetup.skippedDetail'),
    retry: i18n.t('common.retry'),
    ok: i18n.t('common.ok'),
    done: i18n.t('common.done'),
  }
}

function electronLocaleToSupportedLanguage(locale: string): string {
  const base = locale.toLowerCase().split(/[-_]/)[0]
  if (base === 'zh') return 'zh-Hans'
  if (['de', 'en', 'es', 'hu', 'ja', 'pl'].includes(base)) return base
  return 'en'
}

async function validateAdminSessionAfterResume(args: {
  protocol: 'ws' | 'wss'
  port: number
  token: string
  tlsRejectUnauthorized: boolean
}): Promise<void> {
  if (adminResumeValidationInFlight) {
    return adminResumeValidationInFlight
  }

  adminResumeValidationInFlight = (async () => {
    const client = new WsRpcClient(`${args.protocol}://127.0.0.1:${args.port}`, {
      token: args.token,
      autoReconnect: false,
      mode: 'local',
      tlsRejectUnauthorized: args.tlsRejectUnauthorized,
      requestTimeout: 15_000,
      connectTimeout: 10_000,
    })

    try {
      const validation = await client.invoke(RPC_CHANNELS.admin.VALIDATE)
      if (!validation?.loggedIn) {
        const authState = await client.invoke(RPC_CHANNELS.onboarding.GET_AUTH_STATE).catch(() => null)
        if (authState?.setupNeeds?.needsAdminLogin) {
          moduleSink?.(ADMIN_REAUTH_REQUIRED_CHANNEL, { to: 'all' }, validation ?? { loggedIn: false })
        }
      }
    } catch (error) {
      mainLog.warn('[Admin] resume validation failed:', error instanceof Error ? error.message : String(error))
      const authState = await client.invoke(RPC_CHANNELS.onboarding.GET_AUTH_STATE).catch(() => null)
      if (authState?.setupNeeds?.needsAdminLogin) {
        moduleSink?.(ADMIN_REAUTH_REQUIRED_CHANNEL, { to: 'all' }, { loggedIn: false })
      }
    } finally {
      client.destroy()
      adminResumeValidationInFlight = null
    }
  })()

  return adminResumeValidationInFlight
}

// Store pending deep link if app not ready yet (cold start)
let pendingDeepLink: string | null = null
const terminalIntegrationCommand = parseTerminalIntegrationCommand(process.argv)

// Set app name early (before app.whenReady) to ensure correct macOS menu bar title
// Supports multi-instance dev: POLO_AI_APP_NAME env var (e.g., "Polo AI [1]")
app.setName(process.env.POLO_AI_APP_NAME || 'Polo AI')

// Register as default protocol client for poloai:// URLs
// This must be done before app.whenReady() on some platforms
if (process.defaultApp) {
  // Development mode: need to pass the app path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [process.argv[1]])
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
}

// Apply network proxy settings early (Node-level only — Electron sessions require app.whenReady)
import { applyConfiguredProxySettings } from './network-proxy'
void applyConfiguredProxySettings()

// Accept self-signed / untrusted certificates when connecting to a user-configured remote server.
// Only bypasses cert validation for the exact POLO_AI_SERVER_URL origin — all other connections
// use standard certificate verification. Without this, wss:// to self-signed servers fails with
// ERR_CERT_AUTHORITY_INVALID because Chromium's WebSocket rejects untrusted certs.
//
// Electron's certificate-error always reports URLs with https:// scheme, so we normalize
// wss:// → https:// (and ws:// → http://) to ensure origins compare correctly.
function normalizeOriginForCert(urlStr: string): string {
  const u = new URL(urlStr)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

if (process.env.POLO_AI_SERVER_URL) {
  let serverOrigin: string | undefined
  try {
    serverOrigin = normalizeOriginForCert(process.env.POLO_AI_SERVER_URL)
  } catch {
    // Invalid URL — will fail later during connection, no need to handle here
  }
  if (serverOrigin) {
    app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
      try {
        if (normalizeOriginForCert(url) === serverOrigin) {
          event.preventDefault()
          callback(true)
          return
        }
      } catch {
        // URL parse failure — fall through to default rejection
      }
      callback(false)
    })
  }
}

// Register thumbnail:// custom protocol for file preview thumbnails in the sidebar.
// Must happen before app.whenReady() — Electron requires early scheme registration.
registerThumbnailScheme()

// Handle deeplink on macOS (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault()
  mainLog.info('Received deeplink', describeDeepLinkForLog(url))

  if (windowManager) {
    handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(() => {
      mainLog.error('Failed to handle deep link', describeDeepLinkForLog(url))
    })
  } else {
    // App not ready - store for later
    pendingDeepLink = url
  }
})

// Handle deeplink on Windows/Linux (single instance check)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  if (process.platform !== 'darwin') {
    const initialUrl = findDeepLinkArgument(process.argv, DEEPLINK_SCHEME)
    if (initialUrl) {
      mainLog.info('Received deeplink from initial argv', describeDeepLinkForLog(initialUrl))
      pendingDeepLink = initialUrl
    }
  }

  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    // On Windows/Linux, the deeplink is in commandLine
    const url = findDeepLinkArgument(commandLine, DEEPLINK_SCHEME)
    if (url && windowManager) {
      mainLog.info('Received deeplink from second instance', describeDeepLinkForLog(url))
      handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(() => {
        mainLog.error('Failed to handle deep link', describeDeepLinkForLog(url))
      })
    } else if (windowManager) {
      // No deep link - just focus the first window
      const windows = windowManager.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0].window
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    }
  })
}

// Helper to create initial windows on startup
async function createInitialWindows(): Promise<void> {
  if (!windowManager) return

  // Load saved window state
  const savedState = loadWindowState()
  let workspaces = getWorkspaces()

  // If no workspaces exist, create default "My Workspace" on first run
  if (workspaces.length === 0) {
    // Ensure config file exists (addWorkspace requires it)
    initializeStoredConfigIfMissing({
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    })
    const defaultPath = join(getDefaultWorkspacesDir(), 'my-workspace')
    addWorkspace({ rootPath: defaultPath, name: 'My Workspace' })
    workspaces = getWorkspaces() // Refresh after creation
    mainLog.info('Created default workspace on first run')
  }

  const validWorkspaceIds = workspaces.map(ws => ws.id)

  if (savedState?.windows.length) {
    // Restore windows from saved state
    let restoredCount = 0

    for (const saved of savedState.windows) {
      // Skip invalid workspaces
      if (!validWorkspaceIds.includes(saved.workspaceId)) continue

      // Restore main window with focused mode if it was saved
      mainLog.info(
        `Restoring window: workspaceId=${saved.workspaceId}, focused=${saved.focused ?? false}`,
        describeUrlForLog(saved.url ?? 'none'),
      )
      const win = windowManager.createWindow({
        workspaceId: saved.workspaceId,
        focused: saved.focused,
        restoreUrl: saved.url,
      })
      win.setBounds(saved.bounds)

      restoredCount++
    }

    if (restoredCount > 0) {
      mainLog.info(`Restored ${restoredCount} window(s) from saved state`)
      return
    }
  }

  // Default: open window for first workspace
  windowManager.createWindow({ workspaceId: workspaces[0].id })
  mainLog.info(`Created window for first workspace: ${workspaces[0].name}`)
}

app.whenReady().then(async () => {
  if (terminalIntegrationCommand) {
    try {
      const status = executeTerminalIntegrationCommand(
        terminalIntegrationCommand,
        terminalIntegrationOptions(),
      )
      process.stdout.write(`${JSON.stringify(status)}\n`)
      app.exit(0)
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      app.exit(1)
    }
    return
  }

  await i18n.changeLanguage(electronLocaleToSupportedLanguage(app.getLocale()))

  // Export packaged state as env var so logger.ts (and headless Bun) don't need 'electron'
  process.env.POLO_AI_IS_PACKAGED = app.isPackaged ? 'true' : 'false'

  // Register bundled assets root so all seeding functions can find their files
  // (docs, permissions, themes, tool-icons resolve via getBundledAssetsDir)
  setBundledAssetsRoot(__dirname)

  // Initialize backend runtime bootstrapping (Codex vendor root, Claude SDK runtime paths).
  initializeBackendHostRuntime({
    hostRuntime: {
      appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })

  // Register PowerShell validator root so it can find the bundled parser script
  // (Windows only: validates PowerShell commands in Explore mode using AST analysis)
  setPowerShellValidatorRoot(join(__dirname, 'resources'))

  // Initialize bundled docs
  initializeDocs()

  // Initialize bundled release notes
  initializeReleaseNotes()

  // Ensure default permissions file exists (copies bundled default.json on first run)
  ensureDefaultPermissions()

  // Seed tool icons to ~/.polo-ai/tool-icons/ (copies bundled SVGs on first run)
  ensureToolIcons()

  // Seed preset themes to ~/.polo-ai/themes/ (copies bundled theme JSONs on first run)
  ensurePresetThemes()

  // Register thumbnail:// protocol handler (scheme was registered earlier, before app.whenReady)
  registerThumbnailHandler()

  // Re-apply proxy settings now that Electron sessions are available
  // (first call before app.whenReady only configured Node-level proxy)
  await applyConfiguredProxySettings()

  // Note: electron-updater handles pending updates internally via autoInstallOnAppQuit

  // Application menu is created after windowManager initialization (see below)

  // Set dock icon on macOS (required for dev mode, bundled apps use Info.plist)
  if (process.platform === 'darwin' && app.dock) {
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const dockIconPath = [
      join(__dirname, 'resources/icon.png'),
      join(__dirname, '../resources/icon.png'),
    ].find(p => existsSync(p))

    if (dockIconPath) {
      app.dock.setIcon(dockIconPath)
      // Initialize badge icon for canvas-based badge overlay
      initBadgeIcon(dockIconPath)
    }

    // Multi-instance dev: show instance number badge on dock icon
    // POLO_AI_INSTANCE_NUMBER is set by detect-instance.sh for numbered folders
    const instanceNum = process.env.POLO_AI_INSTANCE_NUMBER
    if (instanceNum) {
      const num = parseInt(instanceNum, 10)
      if (!isNaN(num) && num > 0) {
        initInstanceBadge(num)
      }
    }
  }

  try {
    // Initialize window manager
    windowManager = new WindowManager()

    // Deep-link action results may only come from the app's own renderer
    // windows — embedded browser-pane pages must not be able to forge acks.
    const wm = windowManager
    getDeepLinkCallbackBridge().setTrustedSenderCheck(
      (wcId) => wm.getWindowByWebContentsId(wcId) != null
    )

    // Create the application menu (needs windowManager for New Window action)
    createApplicationMenu(windowManager)

    // When POLO_AI_SERVER_URL is set, this Electron instance is a thin client —
    // it only creates windows whose preload connects to the remote server.
    // Skip server-side initialization (SessionManager, model refresh, platform injection).
    const isClientOnly = !!process.env.POLO_AI_SERVER_URL
    const isHeadless = !!process.env.POLO_AI_HEADLESS

    if (isClientOnly) {
      mainLog.info(`Client-only mode: POLO_AI_SERVER_URL=${process.env.POLO_AI_SERVER_URL} (server initialization skipped)`)
    }

    // Initialize notification service (always — triggered by server push events)
    initNotificationService(windowManager)

    // Initialize browser pane manager (always — even in headless, for deps wiring)
    browserPaneManager = new BrowserPaneManager()
    browserPaneManager.setWindowManager(windowManager)
    browserPaneManager.registerToolbarIpc()
    browserPaneManager.registerCapabilityIpc()

    // Build real PlatformServices from Electron APIs
    const platform: PlatformServices = createElectronPlatform({
      app,
      nativeImage,
      shell,
      nativeTheme,
      logger: log,
      isDebugMode,
      getLogFilePath,
      captureError: (err) => Sentry.captureException(err),
    })

    // Bootstrap IPC handlers — preload uses sendSync for window-local details
    ipcMain.on('__get-web-contents-id', (e) => {
      e.returnValue = e.sender.id
    })
    ipcMain.on('__get-workspace-id', (e) => {
      e.returnValue = windowManager?.getWorkspaceForWindow(e.sender.id) ?? ''
    })

    // Transport diagnostics bridge — preload reports remote WS connection state changes
    // so failures are visible in terminal/main.log (not only renderer console).
    ipcMain.on('__transport:status', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        level?: 'info' | 'warn' | 'error'
        message?: string
        status?: string
        attempt?: number
        nextRetryInMs?: number
        error?: unknown
        close?: unknown
        url?: string
      }

      const level = p.level ?? 'info'
      const message = p.message ?? '[transport] status update'
      const context = {
        status: p.status,
        attempt: p.attempt,
        nextRetryInMs: p.nextRetryInMs,
        error: p.error,
        close: p.close,
        url: p.url,
      }

      if (level === 'error') {
        mainLog.error(message, context)
      } else if (level === 'warn') {
        mainLog.warn(message, context)
      } else {
        mainLog.info(message, context)
      }
    })

    // Dialog bridge — preload capability handlers use ipcRenderer.invoke to
    // call main-process-only dialog APIs (dialog, BrowserWindow).
    ipcMain.handle('__dialog:showMessageBox', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showMessageBox(win, spec)
      return { response: result.response }
    })
    ipcMain.handle('__dialog:showOpenDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, spec)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })
    ipcMain.handle('terminal-integration:get-status', () =>
      terminalIntegrationIpcResult('status', () =>
        getTerminalIntegrationStatus(terminalIntegrationOptions())))
    ipcMain.handle('terminal-integration:install', () =>
      terminalIntegrationIpcResult('install', () => {
        const result = installTerminalIntegration(terminalIntegrationOptions())
        setTerminalSetupDismissed(terminalIntegrationOptions(), false)
        return result
      }))
    ipcMain.handle('terminal-integration:uninstall', () =>
      terminalIntegrationIpcResult('uninstall', () => {
        const result = uninstallTerminalIntegration(terminalIntegrationOptions())
        setTerminalSetupDismissed(terminalIntegrationOptions(), true)
        return result
      }))

    if (!isClientOnly) {
      // Restore persisted Git Bash path on Windows (must happen before any SDK subprocess spawn)
      if (process.platform === 'win32') {
        const { getGitBashPath, clearGitBashPath } = await import('@polo-ai/shared/config')
        const gitBashPath = getGitBashPath()
        if (gitBashPath) {
          const validation = await validateGitBashPath(gitBashPath)
          if (validation.valid) {
            process.env.CLAUDE_CODE_GIT_BASH_PATH = validation.path
          } else {
            clearGitBashPath()
            delete process.env.CLAUDE_CODE_GIT_BASH_PATH
            mainLog.warn(`Cleared invalid persisted Git Bash path: ${gitBashPath}`)
          }
        }
      }

      // Check for VC++ Redistributable on Windows (required by onnxruntime / markitdown).
      // Without it, document conversion tools (PDF, PPTX, DOCX, XLSX) crash with DLL errors.
      // Sets env var so renderer can show an actionable toast with install button.
      if (process.platform === 'win32') {
        const vcCheck = checkVCRedistInstalled()
        if (!vcCheck.installed) {
          mainLog.warn('[vcredist]', vcCheck.message)
          process.env.POLO_AI_VCREDIST_MISSING = '1'
          if (vcCheck.downloadUrl) {
            process.env.POLO_AI_VCREDIST_URL = vcCheck.downloadUrl
          }
        } else if (isDebugMode) {
          mainLog.info('[vcredist]', vcCheck.message)
        }
      }

      // Pre-import power manager (async import needed for applyPlatformToSubsystems)
      const { onSessionStarted, onSessionStopped } = await import('./power-manager')

      // Client ID tracking for Electron IPC bridge (webContentsId → clientId)
      const clientMap = new Map<number, string>()
      const resolveClientId = (wcId: number) => clientMap.get(wcId)

      // Read embedded server config (Server settings page)
      const { getServerConfig } = await import('@polo-ai/shared/config')
      const embeddedServerConfig = getServerConfig()
      const serverModeEnabled = embeddedServerConfig.enabled && !isClientOnly

      // Derive host/port/token from server config (or env overrides)
      const serverToken = serverModeEnabled && embeddedServerConfig.token
        ? embeddedServerConfig.token
        : randomUUID()
      const rpcHost = process.env.POLO_AI_RPC_HOST
        ?? (serverModeEnabled ? '0.0.0.0' : '127.0.0.1')
      const rpcPort = process.env.POLO_AI_RPC_PORT
        ? parseInt(process.env.POLO_AI_RPC_PORT, 10)
        : (serverModeEnabled ? embeddedServerConfig.port : 0)

      // Load TLS certificates if configured
      let tls: import('@polo-ai/server-core/transport').WsRpcTlsOptions | undefined
      if (serverModeEnabled && embeddedServerConfig.tlsCertPath && embeddedServerConfig.tlsKeyPath) {
        try {
          tls = {
            cert: readFileSync(embeddedServerConfig.tlsCertPath),
            key: readFileSync(embeddedServerConfig.tlsKeyPath),
          }
          mainLog.info('[server-mode] TLS enabled')
        } catch (err) {
          mainLog.error('[server-mode] Failed to load TLS certificates:', err)
        }
      }

      if (serverModeEnabled) {
        mainLog.info(`[server-mode] Enabled — binding ${rpcHost}:${rpcPort}${tls ? ' (TLS)' : ''}`)
      }

      // Bootstrap the WS RPC server via shared bootstrap function.
      const instance = await bootstrapServer<SessionManager, HandlerDeps>({
        serverToken,
        rpcHost,
        rpcPort,
        tls,
        bundledAssetsRoot: __dirname,
        serverId: 'local',
        serverVersion: app.getVersion(),
        platformFactory: () => platform,
        applyPlatformToSubsystems: (p) => {
          setFetcherPlatform(p)
          setSessionPlatform(p)
          setSessionRuntimeHooks({
            updateBadgeCount,
            onSessionStarted,
            onSessionStopped,
            captureException: (error, context) => {
              Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
                tags: {
                  ...(context?.errorSource ? { errorSource: context.errorSource } : {}),
                  ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
                },
              })
            },
          })
          setSearchPlatform(p)
          setImageProcessor(p.imageProcessor)
        },
        createSessionManager: () => {
          const sm = new SessionManager()
          sm.setBrowserPaneManager(browserPaneManager!)
          return sm
        },
        bindRpcServer: (sm, server) => sm.setRpcServer(server),
        createHandlerDeps: ({ sessionManager: sm, platform: p, oauthFlowStore: ofs }) => {
          // The messaging handle is built here because it needs sessionManager.
          // The WS publisher is attached after bootstrapServer resolves (via
          // handle.setPublisher) because wsServer isn't available yet.
          messagingHandle = createMessagingBootstrap({
            sessionManager: sm,
            credentialManager: getCredentialManager(),
            getMessagingDir: (wsId: string) =>
              join(homedir(), '.polo-ai', 'workspaces', wsId, 'messaging'),
            getLegacyMessagingDir: (wsId: string) => {
              const ws = getWorkspaces().find((w) => w.id === wsId)
              return ws ? join(ws.rootPath, 'messaging') : undefined
            },
            // Route messaging diagnostics through the dedicated messaging log
            // at ~/.polo-ai/logs/messaging-gateway.log.
            logger: messagingGatewayLog,
            // WhatsApp worker runs under Electron's embedded Node via
            // ELECTRON_RUN_AS_NODE (WhatsAppAdapter defaults nodeBin to
            // process.execPath). In dev we resolve worker.cjs from the
            // monorepo; in packaged builds it's shipped via extraResources
            // (see apps/electron/electron-builder.yml).
            whatsapp: {
              workerEntry: app.isPackaged
                ? join(process.resourcesPath, 'messaging-whatsapp-worker', 'worker.cjs')
                : join(process.cwd(), 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
              pairingMode: 'qr',
            },
          })
          return {
            sessionManager: sm,
            platform: p,
            windowManager: windowManager ?? undefined,
            browserPaneManager: browserPaneManager ?? undefined,
            oauthFlowStore: ofs,
            messagingRegistry: messagingHandle.registry,
          }
        },
        // Headless: register only core handlers (no GUI handlers for browser, settings, etc.)
        // GUI: register all handlers (core + GUI)
        registerAllRpcHandlers: isHeadless
          ? (server, deps, serverCtx) => registerCoreRpcHandlers(server, deps, serverCtx)
          : registerAllRpcHandlers,
        setSessionEventSink: (sm, sink) => sm.setEventSink(getDeepLinkCallbackBridge().wrapEventSink(sink)),
        initializeSessionManager: (sm) => sm.initialize(),
        initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
          const { getCredentialManager } = await import('@polo-ai/shared/credentials')
          const manager = getCredentialManager()
          const [apiKey, oauth] = await Promise.all([
            manager.getLlmApiKey(slug).catch(() => null),
            manager.getLlmOAuth(slug).catch(() => null),
          ])
          return {
            apiKey: apiKey ?? undefined,
            oauthAccessToken: oauth?.accessToken,
            oauthRefreshToken: oauth?.refreshToken,
            oauthIdToken: oauth?.idToken,
          }
        }),
        onClientConnected: ({ clientId, webContentsId }) => {
          if (webContentsId != null) clientMap.set(webContentsId, clientId)
        },
        cleanupClientResources: (clientId) => {
          for (const [wcId, cId] of clientMap) {
            if (cId === clientId) { clientMap.delete(wcId); break }
          }
          cleanupSessionFileWatchForClient(clientId)
        },
      })

      try {
        publishedElectronRuntime = writeElectronRuntimeDiscovery({
          pid: process.pid,
          url: `${instance.protocol}://127.0.0.1:${instance.port}`,
          token: instance.token,
          version: app.getVersion(),
          ...electronRuntimeInstance,
        })
        mainLog.info('[runtime-discovery] Local Electron endpoint published', {
          path: publishedElectronRuntime.path,
          pid: process.pid,
          version: app.getVersion(),
        })
      } catch (error) {
        mainLog.error(
          '[runtime-discovery] Failed to publish local endpoint:',
          error instanceof Error ? error.message : String(error),
        )
      }

      // Capture module-level references for before-quit cleanup and deep-link handlers
      sessionManager = instance.sessionManager
      oauthFlowStore = instance.oauthFlowStore
      moduleSink = instance.wsServer.push.bind(instance.wsServer)
      moduleClientResolver = resolveClientId

      powerMonitor.on('resume', () => {
        void validateAdminSessionAfterResume({
          protocol: instance.protocol,
          port: instance.port,
          token: instance.token,
          tlsRejectUnauthorized: !tls,
        })
      })

      // -----------------------------------------------------------------------
      // Messaging Gateway — attach the WS publisher, init local workspaces,
      // install the fan-out event sink. The handle was created inside
      // createHandlerDeps so the registry could be wired into HandlerDeps.
      // -----------------------------------------------------------------------
      try {
        if (!messagingHandle) {
          throw new Error('Messaging handle was not constructed in createHandlerDeps')
        }

        messagingHandle.setPublisher(instance.wsServer.push.bind(instance.wsServer))

        // Skip remote-owned workspaces — messaging runs on the remote server.
        const localWorkspaceIds = getWorkspaces()
          .filter((ws) => !ws.remoteServer)
          .map((ws) => ws.id)
        await messagingHandle.initializeWorkspaces(localWorkspaceIds)

        // Compose fan-out event sink: RPC push + messaging gateway dispatch.
        // Always install — this lets workspaces enable messaging at runtime
        // without a process restart.
        const baseSink = instance.wsServer.push.bind(instance.wsServer)
        instance.sessionManager.setEventSink(getDeepLinkCallbackBridge().wrapEventSink(messagingHandle.wrapSink(baseSink)))
        if (messagingHandle.registry.size > 0) {
          mainLog.info(`[messaging] Fan-out sink active for ${messagingHandle.registry.size} workspace(s)`)
        }
      } catch (err) {
        mainLog.error('[messaging] Gateway initialization failed:', err)
      }

      // IPC handlers — preload uses sendSync to get WS connection details

      // Remove workspace from config (cleanup stale entries)
      ipcMain.handle('workspace:remove', async (_event, workspaceId: string) => {
        const { removeWorkspace: remove } = await import('@polo-ai/shared/config')
        return remove(workspaceId)
      })

      // Cross-server RPC — invoke a channel on an arbitrary remote server
      ipcMain.handle('server:invokeOnServer', async (_event, url: string, token: string, channel: string, ...args: unknown[]) => {
        const { connectToRemote } = await import('./handlers/workspace')
        const { client, error } = await connectToRemote(url, token)
        if (!client) throw new Error(error ?? 'Connection failed')
        try {
          return await client.invoke(channel, ...args)
        } finally {
          client.destroy()
        }
      })

      // Transfer session to another workspace — orchestrated in main process
      // so large bundles can be moved directly between owning servers.
      ipcMain.handle('session:transferToRemoteWorkspace', async (_event, sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
        const idx = sessionIndex ?? 0
        const count = sessionCount ?? 1
        const { getWorkspaceByNameOrId } = await import('@polo-ai/shared/config')
        const { connectToRemote } = await import('./handlers/workspace')
        const { CHUNKED_TRANSFER_THRESHOLD, getChunkCount, invokeChunked, prepareChunkedPayload } = await import('./chunked-rpc')

        const targetWorkspace = getWorkspaceByNameOrId(targetWorkspaceId)
        if (!targetWorkspace?.remoteServer) throw new Error(`Workspace ${targetWorkspaceId} has no remote server`)
        if (!sessionManager) throw new Error('Session manager not initialized')

        const sourceWorkspaceLocalId = windowManager?.getWorkspaceForWindow(_event.sender.id)
        if (!sourceWorkspaceLocalId) throw new Error('Unable to resolve source workspace for transfer')

        const sourceWorkspace = getWorkspaceByNameOrId(sourceWorkspaceLocalId)
        if (!sourceWorkspace) throw new Error(`Source workspace ${sourceWorkspaceLocalId} not found`)

        let bundle: any = null

        if (sourceWorkspace.remoteServer) {
          const { url: sourceUrl, token: sourceToken, remoteWorkspaceId: sourceRemoteWorkspaceId } = sourceWorkspace.remoteServer
          console.log(`[Transfer] Exporting remote-owned session ${sessionId} from workspace ${sourceRemoteWorkspaceId}...`)
          const { client: sourceClient, error: sourceError } = await connectToRemote(sourceUrl, sourceToken, sourceRemoteWorkspaceId)
          if (!sourceClient) throw new Error(sourceError ?? 'Connection failed to source remote server')

          try {
            bundle = await sourceClient.invoke('sessions:export', sessionId)
            if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

            try {
              console.log('[Transfer] Generating conversation summary on source server...')
              const transferPayload = await sourceClient.invoke('sessions:exportRemoteTransfer', sessionId)
              if (transferPayload?.summary && bundle.session?.header) {
                ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
                ;(bundle.session.header as any).transferredSessionSummaryApplied = false
                console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
              }
            } catch (err) {
              console.warn('[Transfer] Source-server summary generation failed:', err)
            }
          } finally {
            sourceClient.destroy()
          }
        } else {
          console.log(`[Transfer] Exporting local-owned session ${sessionId} from workspace ${sourceWorkspace.id}...`)
          bundle = await sessionManager.exportSession(sessionId, sourceWorkspace.id)
          if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

          try {
            console.log('[Transfer] Generating conversation summary...')
            const transferPayload = await sessionManager.exportRemoteSessionTransfer(sessionId, sourceWorkspace.id)
            if (transferPayload?.summary && bundle.session?.header) {
              ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
              ;(bundle.session.header as any).transferredSessionSummaryApplied = false
              console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
            }
          } catch (err) {
            console.warn('[Transfer] Summary generation failed:', err)
          }
        }

        console.log(`[Transfer] Export complete: ${bundle.session?.messages?.length ?? 0} messages, ${bundle.files?.length ?? 0} files`)

        const { url, token, remoteWorkspaceId } = targetWorkspace.remoteServer
        console.log(`[Transfer] Connecting to target remote server: ${url}`)
        const { client, error } = await connectToRemote(url, token, remoteWorkspaceId)
        if (!client) throw new Error(error ?? 'Connection failed to target remote server')
        console.log('[Transfer] Connected to target remote server')

        try {
          const preparedBundle = prepareChunkedPayload(bundle)
          const payloadSize = preparedBundle.bytes.length
          const payloadMB = (payloadSize / (1024 * 1024)).toFixed(1)

          const emitProgress = (chunkSent: number, chunkTotal: number) => {
            try { _event.sender.send('transfer:progress', { sessionIndex: idx, sessionCount: count, chunkSent, chunkTotal }) } catch { /* renderer may be gone */ }
          }

          if (payloadSize < CHUNKED_TRANSFER_THRESHOLD) {
            console.log(`[Transfer] Bundle size: ${payloadMB}MB (< 5MB threshold) → using direct RPC`)
            emitProgress(0, 1)
            const result = await client.invoke('sessions:import', remoteWorkspaceId, bundle, 'fork')
            emitProgress(1, 1)
            return result
          }

          const chunkCount = getChunkCount(payloadSize)
          console.log(`[Transfer] Bundle size: ${payloadMB}MB (>= 5MB threshold) → using chunked transfer (${chunkCount} chunks)`)
          return await invokeChunked(
            client,
            'sessions:import',
            [remoteWorkspaceId, bundle, 'fork'],
            1,
            emitProgress,
            preparedBundle,
          )
        } finally {
          client.destroy()
        }
      })

      // App relaunch (for server config changes — NOT an update install)
      ipcMain.handle('app:relaunch', () => {
        app.relaunch()
        app.exit(0)
      })

      // Language change: sync from renderer to main process and rebuild native menu
      ipcMain.handle('i18n:changeLanguage', async (_event, lang: string) => {
        i18n.changeLanguage(lang)
        const { rebuildMenu } = await import('./menu')
        await rebuildMenu()
      })

      ipcMain.on('__get-ws-port', (e) => {
        e.returnValue = instance.port
      })
      ipcMain.on('__get-ws-token', (e) => {
        e.returnValue = instance.token
      })
      ipcMain.on('__get-workspace-remote-config', (e) => {
        const wsId = windowManager?.getWorkspaceForWindow(e.sender.id)
        if (!wsId) { e.returnValue = null; return }
        const ws = getWorkspaceByNameOrId(wsId)
        e.returnValue = ws?.remoteServer ?? null
      })

      // Server config RPC handlers (LOCAL_ONLY — Electron-specific)
      const runningServerState = {
        host: rpcHost,
        port: instance.port,
        tls: !!tls,
        token: serverToken,
        enabled: serverModeEnabled,
      }

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => {
        const { getServerConfig: getConfig } = await import('@polo-ai/shared/config')
        return getConfig()
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async (_ctx: unknown, config: unknown) => {
        const { setServerConfig: setConfig } = await import('@polo-ai/shared/config')
        const cfg = config as import('@polo-ai/shared/config/server-config').ServerConfig
        // Validate port range
        if (cfg.port < 1024 || cfg.port > 65535) {
          throw new Error(`Port must be between 1024 and 65535, got ${cfg.port}`)
        }
        // Validate cert/key files exist if provided
        if (cfg.tlsCertPath && !existsSync(cfg.tlsCertPath)) {
          throw new Error(`Certificate file not found: ${cfg.tlsCertPath}`)
        }
        if (cfg.tlsKeyPath && !existsSync(cfg.tlsKeyPath)) {
          throw new Error(`Private key file not found: ${cfg.tlsKeyPath}`)
        }
        setConfig(cfg)
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => {
        const { getServerConfig: getConfig } = await import('@polo-ai/shared/config')
        const saved = getConfig()
        const protocol = runningServerState.tls ? 'wss' : 'ws'

        // Determine display host (LAN IP if bound to 0.0.0.0)
        let displayHost = runningServerState.host
        if (displayHost === '0.0.0.0' || displayHost === '::') {
          const os = await import('os')
          const nets = os.networkInterfaces()
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] ?? []) {
              if (net.family === 'IPv4' && !net.internal) {
                displayHost = net.address
                break
              }
            }
            if (displayHost !== '0.0.0.0' && displayHost !== '::') break
          }
        }

        // Only compare port/tls/token when at least one side has server mode enabled.
        // When both are disabled, the running port is random — comparing it to the
        // saved default (9100) would always produce a false "restart required" banner.
        const needsRestart = saved.enabled !== runningServerState.enabled
          || ((saved.enabled || runningServerState.enabled) && (
            saved.port !== runningServerState.port
            || (!!saved.tlsCertPath) !== runningServerState.tls
            || (saved.token ?? '') !== runningServerState.token
          ))

        return {
          running: true,
          host: runningServerState.host,
          port: runningServerState.port,
          tls: runningServerState.tls,
          url: `${protocol}://${displayHost}:${runningServerState.port}`,
          token: runningServerState.token,
          needsRestart,
          insecureWarning: isInsecureBind,
        }
      })

      // TLS enforcement — warn when server mode binds to a network address without TLS
      // Mirrors the hard guard in packages/server/src/index.ts but warns instead of blocking,
      // since the user explicitly enabled server mode via UI (may be on a trusted LAN).
      const isInsecureBind = serverModeEnabled && !tls
        && !['127.0.0.1', 'localhost', '::1'].includes(rpcHost)
      if (isInsecureBind) {
        mainLog.warn(
          '[server-mode] WARNING: Listening on a network address without TLS. ' +
          'Auth tokens will be sent in cleartext. ' +
          'Configure TLS certificates in Settings > Server.'
        )
      }

      // Wire EventSink to Electron-specific services
      // Must happen BEFORE createInitialWindows() so event handlers use WS from the start
      windowManager.setRpcEventSink(moduleSink!, resolveClientId)
      const { setMenuEventSink } = await import('./menu')
      setMenuEventSink(moduleSink!, resolveClientId)
      const { setNotificationEventSink } = await import('./notifications')
      setNotificationEventSink(moduleSink!, resolveClientId)

      // Headless: print connection details
      if (isHeadless) {
        console.log(`POLO_AI_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
        console.log(`POLO_AI_SERVER_TOKEN=${instance.token}`)
      }
    }

    // Create initial windows (restores from saved state or opens first workspace)
    // In headless mode the server runs without any UI — skip window creation.
    if (!isHeadless) {
      await createInitialWindows()

      if (app.isPackaged && process.platform === 'darwin') {
        const terminalOptions = terminalIntegrationOptions()
        const setupCopy = terminalSetupCopy()
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        await runNonCriticalTerminalOnboarding(
          () => runTerminalOnboarding({
            terminalOptions,
            copy: setupCopy,
            showMessageBox: (options) => dialog.showMessageBox(win, options),
            formatError: error => i18n.t(
              TERMINAL_INTEGRATION_ERROR_KEYS[error.errorCode],
              error.errorParams,
            ),
            logError: error => mainLog.error(
              '[terminal-integration] onboarding failed',
              error,
            ),
          }),
          error => mainLog.error(
            '[terminal-integration] unexpected onboarding failure',
            error,
          ),
        )
      }
    }

    // Run credential health check at startup to detect issues early
    // (corruption, machine migration, missing credentials for default connection)
    // Skip in thin-client mode — credentials are managed by the remote server.
    if (!isClientOnly) {
      try {
        const { getCredentialManager } = await import('@polo-ai/shared/credentials')
        const credentialManager = getCredentialManager()
        const health = await credentialManager.checkHealth()
        if (!health.healthy) {
          mainLog.warn('Credential health check failed:', health.issues)
          // Issues will be displayed in Settings → AI when user navigates there
        }
      } catch (err) {
        mainLog.error('Credential health check error:', err)
      }
    }

    // Initialize power manager (loads setting, must happen after config is available)
    // Non-critical — powerSaveBlocker may not work on headless/xvfb setups
    try {
      const { initPowerManager } = await import('./power-manager')
      await initPowerManager()
    } catch (err) {
      mainLog.warn('[power] Power manager init failed (non-critical):', err instanceof Error ? err.message : err)
    }

    // Set Sentry context tags for error grouping (no PII — just config classification).
    // Runs after init so config and auth state are available.
    // Derives values from the default LLM connection instead of legacy config fields.
    try {
      const { getLlmConnection, getDefaultLlmConnection } = await import('@polo-ai/shared/config')
      const workspaces = getWorkspaces()
      const defaultConnSlug = getDefaultLlmConnection()
      const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null
      Sentry.setTag('authType', defaultConn?.authType ?? 'unknown')
      Sentry.setTag('providerType', defaultConn?.providerType ?? 'unknown')
      Sentry.setTag('hasCustomEndpoint', String(!!defaultConn?.baseUrl))
      Sentry.setTag('model', defaultConn?.defaultModel ?? 'default')
      Sentry.setTag('workspaceCount', String(workspaces.length))
    } catch (err) {
      mainLog.warn('Failed to set Sentry context tags:', err)
    }

    // Initialize auto-update (check immediately on launch)
    // Skip in dev mode to avoid replacing /Applications app and launching it instead
    if (moduleSink) setAutoUpdateEventSink(moduleSink)
    // Snapshot multi-window state BEFORE quitAndInstall. electron-updater
    // (Squirrel.Mac) destroys BrowserWindows between quitAndInstall and
    // before-quit firing; saving from before-quit alone would overwrite
    // window-state.json with an empty array.
    setBeforeUpdateQuitHook(() => captureAndSaveWindowState('pre-update'))
    if (app.isPackaged) {
      checkForUpdatesOnLaunch().catch(err => {
        mainLog.error('[auto-update] Launch check failed:', err)
      })
    } else {
      mainLog.info('[auto-update] Skipping auto-update in dev mode')
    }

    // Process pending deep link from cold start
    if (pendingDeepLink) {
      mainLog.info('Processing pending deep link', describeDeepLinkForLog(pendingDeepLink))
      await handleDeepLink(pendingDeepLink, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined)
      pendingDeepLink = null
    }

    mainLog.info('App initialized successfully')
    if (isDebugMode) {
      mainLog.info('Debug mode enabled - logs at:', getLogFilePath())
    }
    mainLog.info('Messaging gateway log path:', getMessagingGatewayLogFilePath())
  } catch (error) {
    mainLog.error('Failed to initialize app:', error instanceof Error ? error.message : error, (error as any)?.stack)
    // Continue anyway - the app will show errors in the UI
  }

  // macOS: Re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
      // Open first workspace or last focused
      const workspaces = getWorkspaces()
      if (workspaces.length > 0) {
        const savedState = loadWindowState()
        const wsId = savedState?.lastFocusedWorkspaceId || workspaces[0].id
        // Verify workspace still exists
        if (workspaces.some(ws => ws.id === wsId)) {
          windowManager.createWindow({ workspaceId: wsId })
        } else {
          windowManager.createWindow({ workspaceId: workspaces[0].id })
        }
      }
    }
  })
})

app.on('window-all-closed', () => {
  if (process.env.POLO_AI_HEADLESS) return  // headless server stays alive
  // On macOS, apps typically stay active until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

const beforeQuitCleanup = new BeforeQuitCleanupCoordinator()

/**
 * Capture the current multi-window state and persist it to disk.
 * Called from two sites:
 *   - before-quit (normal quit path, reason='before-quit')
 *   - installUpdate hook (auto-update path, reason='pre-update'), because
 *     electron-updater destroys BrowserWindows between quitAndInstall and
 *     before-quit firing — by the time before-quit runs, getWindowStates()
 *     returns an empty array and would clobber the on-disk state.
 * Returns the number of windows saved, or -1 if windowManager isn't ready.
 */
function captureAndSaveWindowState(reason: 'before-quit' | 'pre-update'): number {
  if (!windowManager) return -1
  const windows = windowManager.getWindowStates()
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const lastFocusedWorkspaceId = focusedWindow
    ? windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
    : undefined
  saveWindowState({ windows, lastFocusedWorkspaceId })
  mainLog.info('[window-state] saved', { windowCount: windows.length, reason })
  return windows.length
}

// Save window state and clean up resources before quitting.
app.on('before-quit', (event) => {
  if (beforeQuitCleanup.isExitAllowed()) return
  const mustStopLocalApps = hasLocalAppRuntimeManager()
  if (!sessionManager && !mustStopLocalApps) {
    windowManager?.setAppQuitting(true)
    return
  }

  const attempt = beforeQuitCleanup.begin(event, async () => {
    // Ensure Cmd+Q/app quit bypasses layered window close interception (Cmd+W behavior).
    windowManager?.setAppQuitting(true)

    if (windowManager) {
      const windows = windowManager.getWindowStates()
      // Empty-snapshot guard: during update-quit, electron-updater has already
      // destroyed all BrowserWindows by the time before-quit fires. The pre-update
      // hook already saved the real state — don't let this late save overwrite it.
      if (windows.length === 0 && isUpdating()) {
        mainLog.warn('[window-state] skip save: empty snapshot during update-quit (pre-update snapshot wins)')
      } else {
        captureAndSaveWindowState('before-quit')
      }
      // Diagnostic correlation with installUpdate's [update-flow] log.
      mainLog.info('[update-flow] before-quit save', {
        windowCount: windows.length,
        electronWindowCount: BrowserWindow.getAllWindows().length,
        isUpdating: isUpdating(),
        reason: isUpdating() ? 'update-quit' : 'user-quit',
      })
    }

    if (mustStopLocalApps) {
      const canQuit = await canQuitAfterLocalAppShutdown(
        shutdownLocalAppRuntime,
        {
          info: message => mainLog.info(message),
          error: (message, error) => mainLog.error(message, error),
        },
      )
      if (!canQuit) {
        windowManager?.setAppQuitting(false)
        mainLog.error('Quit cancelled because local app runtimes were not fully stopped')
        return false
      }
    }

    // Flush all pending session writes before quitting
    if (sessionManager) {
      try {
        await sessionManager.flushAllSessions()
        mainLog.info('Flushed all pending session writes')
      } catch (error) {
        mainLog.error('Failed to flush sessions:', error)
      }
      // Clean up SessionManager resources (file watchers, timers, etc.)
      sessionManager.cleanup()

      // Clean up browser pane instances
      if (browserPaneManager) {
        browserPaneManager.destroyAll()
      }

      // Clean up OAuth flow store (stop periodic cleanup timer)
      if (oauthFlowStore) {
        oauthFlowStore.dispose()
      }

      // Stop all model refresh timers
      getModelRefreshService().stopAll()

      // Stop messaging gateways so the WhatsApp worker subprocess exits cleanly.
      if (messagingHandle) {
        try {
          await messagingHandle.dispose()
        } catch (err) {
          mainLog.error('[messaging] dispose failed:', err)
        }
      }

      // Clean up power manager (release power blocker)
      const { cleanup: cleanupPowerManager } = await import('./power-manager')
      cleanupPowerManager()

      // Release the server lock file so the next launch doesn't see a stale PID.
      // This must happen regardless of the exit path (normal quit or update quit).
      releaseServerLock()
      if (publishedElectronRuntime) {
        removeElectronRuntimeDiscovery({
          path: publishedElectronRuntime.path,
          expectedRecord: publishedElectronRuntime.record,
        })
        publishedElectronRuntime = null
      }
    }

    return true
  })
  if (!attempt.started || !attempt.promise) return

  void attempt.promise.then((canExit) => {
    if (!canExit) return
    // If update is in progress, let electron-updater handle the quit flow.
    // Force exit breaks the NSIS installer on Windows.
    if (isUpdating()) {
      mainLog.info('Update in progress, letting electron-updater handle quit')
      app.quit()
    } else {
      app.exit(0)
    }
  }).catch((error) => {
    windowManager?.setAppQuitting(false)
    mainLog.error('Quit preparation failed:', error)
  })
})

// Handle uncaught exceptions — forward to Sentry explicitly since registering
// a custom handler can interfere with @sentry/electron's automatic capture.
process.on('uncaughtException', (error) => {
  mainLog.error('Uncaught exception:', error)
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason, promise) => {
  mainLog.error('Unhandled rejection at:', promise, 'reason:', reason)
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
})

// Last-resort synchronous cleanup for initialization failures and forced exits.
process.on('exit', () => {
  if (!publishedElectronRuntime) return
  removeElectronRuntimeDiscovery({
    path: publishedElectronRuntime.path,
    expectedRecord: publishedElectronRuntime.record,
  })
  publishedElectronRuntime = null
})
