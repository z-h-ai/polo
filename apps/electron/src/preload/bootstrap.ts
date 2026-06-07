/**
 * WS-mode preload — replaces the full IPC preload (index.ts).
 *
 * Normal mode (local server):
 *   Creates a RoutedClient that routes LOCAL_ONLY channels to the local
 *   Electron server and REMOTE_ELIGIBLE channels to whichever server owns
 *   the active workspace (local or remote). Workspace switches swap the
 *   workspace client transparently.
 *
 * Thin-client mode (POLO_AI_SERVER_URL):
 *   Creates a single WsRpcClient connected to the remote server.
 *   All channels go to the remote server.
 *
 * On localhost the WS handshake completes in <1ms. The React app takes >100ms
 * to initialise, so by the time any component calls an API method, the
 * connection is established.
 */

import '@sentry/electron/preload'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import { WsRpcClient, type TransportConnectionState } from '../transport/client'
import { RoutedClient } from '../transport/routed-client'
import { buildClientApi } from '../transport/build-api'
import { CHANNEL_MAP } from '../transport/channel-map'
import {
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_BROWSER_INVOKE,
  LOCAL_CLIENT_CAPABILITIES,
} from '@polo-ai/server-core/transport'
import type { ConfirmDialogSpec, FileDialogSpec, BrowserCapabilityRequest } from '@polo-ai/server-core/transport'
import type { RpcClient } from '@polo-ai/server-core/transport'
import type { RemoteServerConfig } from '@polo-ai/core/types'
import type { ElectronAPI } from '../shared/types'

// ---------------------------------------------------------------------------
// Client interface — common surface for both RoutedClient and WsRpcClient
// ---------------------------------------------------------------------------

interface TransportClient extends RpcClient {
  isChannelAvailable(channel: string): boolean
  getConnectionState(): TransportConnectionState
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectNow(): void
}

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

const webContentsId: number = ipcRenderer.sendSync('__get-web-contents-id')
const isClientOnly = !!process.env.POLO_AI_SERVER_URL

let client: TransportClient

if (isClientOnly) {
  // ── Thin-client mode ───────────────────────────────────────────────────
  // Single WsRpcClient connected directly to the remote server.
  // No local server, no routing — all channels go to remote.

  const wsUrl = process.env.POLO_AI_SERVER_URL!
  const wsToken = process.env.POLO_AI_SERVER_TOKEN ?? ''

  // Block unencrypted ws:// to non-localhost servers — tokens would be sent in cleartext
  const parsed = new URL(wsUrl)
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol === 'ws:' && !isLocalhost) {
    throw new Error(
      `Refusing to connect to remote server over unencrypted ws://. ` +
      `Use wss:// (TLS) for non-localhost connections. ` +
      `Set POLO_AI_RPC_TLS_CERT/KEY on the server to enable TLS.`
    )
  }

  // Workspace ID is optional — if missing, renderer shows a workspace picker
  const workspaceId = process.env.POLO_AI_WORKSPACE_ID || ipcRenderer.sendSync('__get-workspace-id') || undefined

  const wsClient = new WsRpcClient(wsUrl, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
  })
  wsClient.connect()
  client = wsClient

} else {
  // ── Normal mode ────────────────────────────────────────────────────────
  // RoutedClient routes LOCAL_ONLY to local server, REMOTE_ELIGIBLE to
  // whichever server owns the workspace (local or remote).

  const wsPort: number = ipcRenderer.sendSync('__get-ws-port')
  const wsToken: string = ipcRenderer.sendSync('__get-ws-token')
  const workspaceId: string = ipcRenderer.sendSync('__get-workspace-id')

  const localClient = new WsRpcClient(`ws://127.0.0.1:${wsPort}`, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'local',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
  })

  // Check if the current workspace is remote (synchronous IPC during preload eval)
  const remoteConfig: RemoteServerConfig | null = ipcRenderer.sendSync('__get-workspace-remote-config')

  let initialWorkspaceClient: WsRpcClient
  if (remoteConfig && typeof remoteConfig.url === 'string') {
    // Workspace is remote — create a direct connection to the remote server
    initialWorkspaceClient = new WsRpcClient(remoteConfig.url, {
      token: remoteConfig.token,
      workspaceId: remoteConfig.remoteWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      tlsRejectUnauthorized: false,
    })
    initialWorkspaceClient.connect()
  } else {
    // Workspace is local — workspace client IS the local client
    initialWorkspaceClient = localClient
  }

  const routedClient = new RoutedClient(localClient, initialWorkspaceClient)

  // Set workspace ID mapping if initial workspace is remote
  if (remoteConfig) {
    routedClient.setWorkspaceMapping(workspaceId, remoteConfig.remoteWorkspaceId)
  }

  // Factory for creating remote workspace clients on switch
  routedClient.setClientFactory((remoteServer: RemoteServerConfig) => {
    return new WsRpcClient(remoteServer.url, {
      token: remoteServer.token,
      workspaceId: remoteServer.remoteWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      tlsRejectUnauthorized: false,
    })
  })

  localClient.connect()
  client = routedClient
}

// ---------------------------------------------------------------------------
// Register client-side capability handlers (server can invoke these)
// ---------------------------------------------------------------------------

client.handleCapability(CLIENT_OPEN_EXTERNAL, (url: string) => shell.openExternal(url))

client.handleCapability(CLIENT_OPEN_PATH, async (path: string) => {
  const error = await shell.openPath(path)
  return { error: error || undefined }
})

client.handleCapability(CLIENT_SHOW_IN_FOLDER, (path: string) => {
  shell.showItemInFolder(path)
})

client.handleCapability(CLIENT_CONFIRM_DIALOG, async (spec: ConfirmDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showMessageBox', spec)
})

client.handleCapability(CLIENT_OPEN_FILE_DIALOG, async (spec: FileDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showOpenDialog', spec)
})

// Browser pane invocation. The remote server packages an IBrowserPaneManager
// method call as a BrowserCapabilityRequest; we dispatch it to the local
// `BrowserPaneManager` via the `__browser:invoke` IPC channel registered in
// `apps/electron/src/main/browser-pane-manager.ts:registerCapabilityIpc()`.
client.handleCapability(CLIENT_BROWSER_INVOKE, async (req: BrowserCapabilityRequest) => {
  return await ipcRenderer.invoke('__browser:invoke', req)
})

// ---------------------------------------------------------------------------
// Build ElectronAPI proxy
// ---------------------------------------------------------------------------

const api = buildClientApi(client, CHANNEL_MAP, (ch) => client.isChannelAvailable(ch))

;(api as any).getRuntimeEnvironment = (): 'electron' | 'web' => 'electron'

// ---------------------------------------------------------------------------
// Transport connection state logging (for remote connections)
// ---------------------------------------------------------------------------

function formatTransportReason(state: TransportConnectionState): string {
  const err = state.lastError
  if (err) {
    const codePart = err.code ? ` [${err.code}]` : ''
    return `${err.kind}${codePart}: ${err.message}`
  }

  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? ` (${state.lastClose.reason})` : ''
    return `close ${state.lastClose.code}${reason}`
  }

  return 'no additional details'
}

// Log remote connection state changes to main process (visible in terminal + main.log).
// Activates whenever the workspace connection is remote (thin client or remote workspace).
client.onConnectionStateChanged((state) => {
  if (state.mode !== 'remote') return

  const emitToMain = (level: 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.send('__transport:status', {
      level,
      message,
      status: state.status,
      attempt: state.attempt,
      nextRetryInMs: state.nextRetryInMs,
      error: state.lastError,
      close: state.lastClose,
      url: state.url,
    })
  }

  if (state.status === 'connected') {
    const message = `[transport] connected to ${state.url}`
    console.info(message)
    emitToMain('info', message)
    return
  }

  if (state.status === 'reconnecting') {
    const retry = state.nextRetryInMs != null ? ` retry in ${state.nextRetryInMs}ms` : ''
    const message = `[transport] reconnecting (attempt ${state.attempt})${retry} — ${formatTransportReason(state)}`
    console.warn(message)
    emitToMain('warn', message)
    return
  }

  if (state.status === 'failed' || state.status === 'disconnected') {
    const message = `[transport] ${state.status} — ${formatTransportReason(state)}`
    console.error(message)
    emitToMain('error', message)
  }
})

// ---------------------------------------------------------------------------
// Transport state API (exposed to renderer)
// ---------------------------------------------------------------------------

;(api as any).getTransportConnectionState = async () => client.getConnectionState()
;(api as any).onTransportConnectionStateChanged = (callback: (state: TransportConnectionState) => void) => {
  return client.onConnectionStateChanged(callback)
}
;(api as any).reconnectTransport = async () => {
  client.reconnectNow()
}

// Platform auth — main process owns token exchange/storage. Renderer receives
// only success/failure metadata, never the raw Admin JWT.
;(api as ElectronAPI).authLogin = async (username: string, password: string) => {
  const result = await ipcRenderer.invoke('auth:login', username, password)
  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: { code?: string; message?: string; retryAfterSeconds?: number; statusCode?: number } }).error
    throw Object.assign(new Error(error.message ?? 'Login failed'), error)
  }
  return result
}
;(api as ElectronAPI).hasAdminSession = () => ipcRenderer.invoke('auth:hasSession')

// App lifecycle — direct IPC (not WS RPC) since it restarts the server itself
;(api as ElectronAPI).relaunchApp = () => ipcRenderer.invoke('app:relaunch')
;(api as ElectronAPI).removeWorkspace = (workspaceId: string) => ipcRenderer.invoke('workspace:remove', workspaceId)
;(api as ElectronAPI).invokeOnServer = (url: string, token: string, channel: string, ...args: any[]) =>
  ipcRenderer.invoke('server:invokeOnServer', url, token, channel, ...args)
;(api as ElectronAPI).transferSessionToWorkspace = (sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) =>
  ipcRenderer.invoke('session:transferToRemoteWorkspace', sessionId, targetWorkspaceId, sessionIndex, sessionCount)
;(api as ElectronAPI).onTransferProgress = (cb: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void) => {
  const handler = (_e: any, progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => cb(progress)
  ipcRenderer.on('transfer:progress', handler)
  return () => { ipcRenderer.removeListener('transfer:progress', handler) }
}

// System warnings — expose env-based flags set during main process startup
// (preload-only: reads env var directly, no IPC round-trip needed)
;(api as ElectronAPI).getSystemWarnings = async () => ({
  vcredistMissing: process.env.POLO_AI_VCREDIST_MISSING === '1',
  downloadUrl: process.env.POLO_AI_VCREDIST_URL,
})

// i18n: sync language changes to main process (for native menus/dialogs)
;(api as ElectronAPI).changeLanguage = (lang: string) => ipcRenderer.invoke('i18n:changeLanguage', lang)

// webUtils.getPathForFile: returns the absolute OS path of a File object obtained
// from <input type="file"> or OS drag-drop. Returns null for Files fabricated from
// Blobs (clipboard paste, web-drag) — those are content-only, no filesystem path.
;(api as ElectronAPI).getFilePath = (file: File) => {
  try {
    return webUtils.getPathForFile(file) || null
  } catch {
    return null
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
