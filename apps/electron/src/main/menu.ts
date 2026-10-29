import { Menu, app, shell, BrowserWindow, dialog } from 'electron'
import { i18n } from '@polo-ai/shared/i18n'
import { RPC_CHANNELS, type BroadcastEventMap } from '../shared/types'
import type { NewWindowRequestSource } from '../shared/types'
import { EDIT_MENU, VIEW_MENU, WINDOW_MENU } from '../shared/menu-schema'
import type { MenuItem } from '../shared/menu-schema'
import type { WindowManager } from './window-manager'
import { createMainWindowWithOutcome } from './new-window-launch'
import type { EventSink } from '@polo-ai/server-core/transport'
import { mainLog, isDebugMode } from './logger'
import { runTerminalCommandDialog } from './terminal-command-dialog'
import { getTerminalIntegrationErrorMessage, getTerminalIntegrationStatusMessage } from '../shared/terminal-integration'

type ClientResolver = (webContentsId: number) => string | undefined

// Store references for rebuilding menu
let cachedWindowManager: WindowManager | null = null
let cachedEventSink: EventSink | null = null
let cachedClientResolver: ClientResolver | null = null
let terminalCommandDialog: Promise<void> | null = null

function openTerminalCommandDialog(): Promise<void> {
  if (terminalCommandDialog) return terminalCommandDialog
  terminalCommandDialog = runTerminalCommandDialog({
    terminalOptions: {
      platform: process.platform,
      homeDir: process.env.POLO_AI_TERMINAL_HOME,
      shell: process.env.SHELL,
      resourcesPath: process.resourcesPath,
      appExecutable: process.execPath,
      appVersion: app.getVersion(),
    },
    copy: {
      title: i18n.t('dialog.terminalCommand.title'),
      description: i18n.t('dialog.terminalCommand.description'),
      enableDetail: i18n.t('dialog.terminalCommand.enableDetail'),
      enable: i18n.t('settings.terminalFeatures.install'),
      repair: i18n.t('settings.terminalFeatures.repair'),
      disable: i18n.t('settings.terminalFeatures.uninstall'),
      close: i18n.t('common.close'),
      retry: i18n.t('common.retry'),
      newTerminal: i18n.t('settings.terminalFeatures.newTerminalHint'),
      failedTitle: i18n.t('dialog.terminalCommand.failedTitle'),
    },
    showMessageBox: options => dialog.showMessageBox(options),
    formatStatus: status => getTerminalIntegrationStatusMessage(status, i18n.t),
    formatError: error => getTerminalIntegrationErrorMessage(error, i18n.t),
    logError: error => mainLog.error('[terminal-command] failed', error),
  }).finally(() => { terminalCommandDialog = null })
  return terminalCommandDialog
}

/**
 * Creates and sets the application menu for macOS.
 * Includes only relevant items for the Polo AI app.
 *
 * Call rebuildMenu() when update state changes to refresh the menu.
 */
export function createApplicationMenu(windowManager: WindowManager, sink?: EventSink, resolver?: ClientResolver): void {
  cachedWindowManager = windowManager
  cachedEventSink = sink ?? null
  cachedClientResolver = resolver ?? null
  installWebviewMenuShortcutForwarding()
  rebuildMenu()
}

/**
 * Set the event sink and client resolver after server creation.
 * Called separately from createApplicationMenu since the server may not exist at menu init time.
 */
export function setMenuEventSink(sink: EventSink, resolver: ClientResolver): void {
  cachedEventSink = sink
  cachedClientResolver = resolver
}

/**
 * Rebuilds the application menu with current update state.
 * Call this when update availability changes.
 *
 * On Windows/Linux: Menu is hidden - all functionality is in the Polo AI logo menu.
 * On macOS: Native menu is required by Apple guidelines, so we keep it synced.
 */
export async function rebuildMenu(): Promise<void> {
  if (!cachedWindowManager) return

  const windowManager = cachedWindowManager
  const isMac = process.platform === 'darwin'

  // On Windows/Linux, hide the native menu entirely: the TopBar avatar menu
  // (WorkbenchAccountMenu, POO-117) is the cross-platform application menu, so
  // a native menu bar would only duplicate it. macOS keeps the native menu
  // because Apple guidelines require it; both surfaces run the same handlers
  // via the menu broadcast channels.
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }

  // Get current update state
  const { getUpdateInfo, installUpdate, checkForUpdates } = await import('./auto-update')
  const updateInfo = getUpdateInfo()
  const updateReady = updateInfo.available && updateInfo.downloadState === 'ready'

  // Build the update menu item based on state
  const updateMenuItem: Electron.MenuItemConstructorOptions = updateReady
    ? {
        label: i18n.t("menu.installUpdateVersion", { version: updateInfo.latestVersion }),
        click: async () => {
          await installUpdate()
        }
      }
    : {
        label: i18n.t("menu.checkForUpdatesEllipsis"),
        click: async () => {
          await checkForUpdates({ autoDownload: true })
        }
      }

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: 'Polo AI',
      submenu: [
        { role: 'about' as const, label: i18n.t('menu.aboutPoloAi') },
        updateMenuItem,
        { type: 'separator' as const },
        {
          label: i18n.t("menu.settings"),
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,  // Action registry handles the keyboard shortcut
          click: () => sendToRenderer(RPC_CHANNELS.menu.OPEN_SETTINGS)
        },
        { type: 'separator' as const },
        { role: 'hide' as const, label: i18n.t('menu.hidePoloAi') },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: i18n.t('menu.quitPoloAi') }
      ]
    }] : []),

    // File menu
    {
      label: i18n.t("menu.file"),
      submenu: [
        {
          label: i18n.t("menu.newChat"),
          accelerator: 'CmdOrCtrl+N',
          registerAccelerator: false,  // Action registry handles the keyboard shortcut
          click: () => sendToRenderer(RPC_CHANNELS.menu.NEW_CHAT)
        },
        {
          label: i18n.t("menu.newWindow"),
          accelerator: 'CmdOrCtrl+Shift+N',
          registerAccelerator: false,  // Action registry handles the keyboard shortcut
          click: () => { void openNewMainWindowFromMain('native_menu') }
        },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },

    // Edit menu (from shared schema)
    {
      label: i18n.t(EDIT_MENU.labelKey),
      submenu: EDIT_MENU.items.map(toElectronMenuItem),
    },

    // View menu (from shared schema + dev-only items)
    {
      label: i18n.t(VIEW_MENU.labelKey),
      submenu: [
        ...VIEW_MENU.items.map(toElectronMenuItem),
        // Dev tools — available in dev mode or when started with --debug
        ...(!app.isPackaged || isDebugMode ? [
          { type: 'separator' as const },
          ...(!app.isPackaged ? [
            {
              label: i18n.t("menu.reload"),
              accelerator: 'CmdOrCtrl+R',
              click: (_menuItem: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
                const browserWindow = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow()
                if (!browserWindow) return
                const views = browserWindow.getBrowserViews()
                if (views.length > 0) {
                  views[0].webContents.reload()
                } else {
                  browserWindow.webContents.reload()
                }
              }
            },
            {
              label: i18n.t("menu.forceReload"),
              accelerator: 'CmdOrCtrl+Shift+R',
              click: (_menuItem: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
                const browserWindow = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow()
                if (!browserWindow) return
                const views = browserWindow.getBrowserViews()
                if (views.length > 0) {
                  views[0].webContents.reloadIgnoringCache()
                } else {
                  browserWindow.webContents.reloadIgnoringCache()
                }
              }
            },
          ] : []),
          { role: 'toggleDevTools' as const },
        ] : [])
      ]
    },

    // Window menu (from shared schema + macOS-specific items)
    {
      label: i18n.t(WINDOW_MENU.labelKey),
      submenu: [
        ...WINDOW_MENU.items.map(toElectronMenuItem),
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const }
        ] : [])
      ]
    },

    // Debug menu (development only)
    ...(!app.isPackaged ? [{
      label: i18n.t("menu.debug"),
      submenu: [
        {
          label: i18n.t("menu.checkForUpdates"),
          click: async () => {
            const { checkForUpdates } = await import('./auto-update')
            const info = await checkForUpdates({ autoDownload: true })
            mainLog.info('[debug-menu] Update check result:', info)
          }
        },
        {
          label: i18n.t("menu.installUpdate"),
          click: async () => {
            const { installUpdate } = await import('./auto-update')
            try {
              await installUpdate()
            } catch (err) {
              mainLog.error('[debug-menu] Install failed:', err)
            }
          }
        },
        { type: 'separator' as const },
        {
          label: i18n.t("menu.resetToDefaults"),
          click: async () => {
            const { dialog } = await import('electron')
            await dialog.showMessageBox({
              type: 'info',
              message: i18n.t("menu.resetToDefaultsTitle"),
              detail: i18n.t("menu.resetToDefaultsDetail"),
              buttons: [i18n.t("common.ok")]
            })
          }
        }
      ]
    }] : []),

    // Help menu
    {
      label: i18n.t("menu.help"),
      submenu: [
        ...(app.isPackaged ? [{
          label: i18n.t('menu.terminalCommand'),
          click: () => { void openTerminalCommandDialog() },
        }] : []),
        {
          label: i18n.t("menu.helpAndDocs"),
          click: () => shell.openExternal('https://app.polo.z-h-ai.com/docs')
        },
        {
          label: i18n.t("menu.keyboardShortcuts"),
          accelerator: 'CmdOrCtrl+/',
          registerAccelerator: false,  // Action registry handles the keyboard shortcut
          click: () => sendToRenderer(RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS)
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

/** Menu channels that are main→renderer push events in BroadcastEventMap */
type MenuBroadcastChannel = Extract<keyof BroadcastEventMap, `menu:${string}`>

/**
 * Sends an event to the focused renderer window via the RPC event sink.
 */
function sendToRenderer(channel: MenuBroadcastChannel): void {
  if (!cachedEventSink || !cachedClientResolver) return
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    const clientId = cachedClientResolver(win.webContents.id)
    if (clientId) {
      cachedEventSink(channel, { to: 'client', clientId })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// New main window (POO-117 P117-05/P117-07)
//
// File > New Window and the webview ⌘⇧N forwarder used to no-op silently when
// the focused window had no workspace mapping. Both now share the outcome-
// checked launcher; a failure is pushed back to the ORIGINATING window's
// renderer so the user always gets visible feedback, never a dead click.
// ─────────────────────────────────────────────────────────────────────────────

async function openNewMainWindowFromMain(source: NewWindowRequestSource): Promise<void> {
  const windowManager = cachedWindowManager
  const originWindow = BrowserWindow.getFocusedWindow()
  const originClientId = originWindow && !originWindow.isDestroyed() && cachedClientResolver
    ? cachedClientResolver(originWindow.webContents.id) ?? null
    : null
  const result = windowManager
    ? await windowManager.createNewMainWindow(originWindow?.webContents.id ?? -1, source)
    : await createMainWindowWithOutcome({ createWindow: null, waitForWorkbenchReady: async () => false, log: mainLog }, { source })
  if (result.ok || !originClientId || !cachedEventSink) return
  cachedEventSink(
    RPC_CHANNELS.menu.NEW_WINDOW_FAILED,
    { to: 'client', clientId: originClientId },
    result.reason ?? 'create_failed',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Webview menu-shortcut forwarding (F7)
//
// The menu accelerators below are declared with `registerAccelerator: false`:
// the renderer action registry owns the keyboard side via its capture-phase
// window keydown listener. But when focus is inside a <webview> guest, the
// keydown never reaches the host renderer, so those shortcuts go dead. The
// main process forwards the same six combos from the guest's
// before-input-event to the host renderer (newWindow stays in main — it needs
// WindowManager access).
// ─────────────────────────────────────────────────────────────────────────────

/** Structural subset of Electron's `Input` payload from before-input-event. */
export interface WebviewShortcutInput {
  type: string
  key: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** The menu action a forwarded webview shortcut should trigger. */
export type WebviewMenuShortcutAction =
  | 'newChat'
  | 'newWindow'
  | 'openSettings'
  | 'toggleFocusMode'
  | 'toggleSidebar'
  | 'keyboardShortcuts'

/**
 * Pure matcher for the six renderer-owned menu accelerators. CmdOrCtrl
 * semantics: meta on macOS, control on Windows/Linux — the opposite cmd/ctrl
 * modifier, alt, or an unexpected shift disqualifies the combo. Only keyDown
 * events match (keyUp/rawKeyDown must not re-trigger an action).
 */
export function matchWebviewMenuShortcut(input: WebviewShortcutInput): WebviewMenuShortcutAction | null {
  if (input.type !== 'keyDown') return null
  const isMac = process.platform === 'darwin'
  const mod = isMac ? input.meta : input.control
  const foreignMod = isMac ? input.control : input.meta
  if (!mod || foreignMod || input.alt) return null
  const key = input.key.toLowerCase()
  if (input.shift) return key === 'n' ? 'newWindow' : null
  switch (key) {
    case 'n': return 'newChat'
    case ',': return 'openSettings'
    case '.': return 'toggleFocusMode'
    case 'b': return 'toggleSidebar'
    case '/': return 'keyboardShortcuts'
    default: return null
  }
}

let webviewShortcutForwardingInstalled = false

/** Broadcast channel for each forwarded action (newWindow is handled in main). */
const WEBVIEW_SHORTCUT_CHANNELS: Record<Exclude<WebviewMenuShortcutAction, 'newWindow'>, MenuBroadcastChannel> = {
  newChat: RPC_CHANNELS.menu.NEW_CHAT,
  openSettings: RPC_CHANNELS.menu.OPEN_SETTINGS,
  toggleFocusMode: RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE,
  toggleSidebar: RPC_CHANNELS.menu.TOGGLE_SIDEBAR,
  keyboardShortcuts: RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS,
}

/**
 * Installs the webview before-input-event listener exactly once (module-level
 * flag guards double registration). Called from createApplicationMenu(); safe
 * to call repeatedly.
 */
function installWebviewMenuShortcutForwarding(): void {
  if (webviewShortcutForwardingInstalled) return
  webviewShortcutForwardingInstalled = true
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('before-input-event', (event, input) => {
      const action = matchWebviewMenuShortcut(input)
      if (!action) return
      // Swallow the keystroke so the guest page never also reacts to it.
      event.preventDefault()
      if (action === 'newWindow') {
        // Same outcome-checked path as the File > New Window click; failures
        // are surfaced in the originating window instead of dropping silently.
        void openNewMainWindowFromMain('webview_shortcut')
        return
      }
      sendToRenderer(WEBVIEW_SHORTCUT_CHANNELS[action])
    })
  })
}

/**
 * Converts a MenuItem from the shared schema to Electron MenuItemConstructorOptions.
 */
function toElectronMenuItem(item: MenuItem): Electron.MenuItemConstructorOptions {
  if (item.type === 'separator') {
    return { type: 'separator' }
  }

  if (item.type === 'role') {
    // Use Electron's built-in role - it handles accelerators automatically
    return { role: item.role as Electron.MenuItemConstructorOptions['role'] }
  }

  if (item.type === 'action') {
    return {
      label: i18n.t(item.labelKey),
      accelerator: item.shortcut,
      registerAccelerator: false,  // Action registry handles the keyboard shortcut
      click: () => sendToRenderer(item.ipcChannel as MenuBroadcastChannel),
    }
  }

  // Should never reach here
  return { type: 'separator' }
}
