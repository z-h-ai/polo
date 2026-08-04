import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { Workspace } from '@polo-ai/core/types'
import { getCredentialManager } from '@z-h-ai/shared/credentials'
import type { HandlerDeps } from '@polo-ai/server-core/handlers'
import { registerCoreRpcHandlers } from '@polo-ai/server-core/handlers/rpc'
import { registerLocalAppHandlers } from '../../src/main/handlers/local-apps'
import { shutdownLocalAppRuntime } from '../../src/main/local-app-runtime'
import { WsRpcServer } from '@polo-ai/server-core/transport'

const preloadPath = process.argv[2]
const rendererHtmlPath = process.argv[3]
const bundlePath = process.argv[4]
const checksum = process.argv[5]
const sizeBytes = Number(process.argv[6])
const configDirectory = process.env.POLO_AI_CONFIG_DIR
if (!preloadPath || !rendererHtmlPath || !bundlePath || !checksum || !sizeBytes || !configDirectory) {
  throw new Error('Release v0.12 Electron E2E configuration is incomplete')
}

const accountId = 'release-v012-user'
const organizationId = 'release-v012-organization'
const localAppId = 'release-v012-static'
const remoteAppId = 'release-v012-remote'
const releaseId = 'release-v012-static-v1'
const accessToken = 'release-v012-access-token-000000000000'
const refreshToken = 'release-v012-refresh-token-00000000000'
const workspace: Workspace = {
  id: 'release-v012-workspace',
  name: 'Release v0.12 E2E',
  slug: 'release-v012-e2e',
  rootPath: join(configDirectory, 'workspace'),
  createdAt: Date.now(),
}
const rpcServer = new WsRpcServer({ host: '127.0.0.1', port: 0 })
const requests: string[] = []
let adminServer: Server | null = null
let adminBaseUrl = ''
let window: BrowserWindow | null = null
let completed = false

const user = {
  id: accountId,
  username: 'release-v012',
  displayName: 'Release v0.12 E2E',
  role: 'user',
  groupIds: [],
}
const organization = {
  id: organizationId,
  type: 'enterprise_workspace',
  name: 'Release v0.12 Organization',
  purpose: 'Exercise POO-13, POO-12, and POL-51 together',
  visibility: 'private',
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const membership = {
  id: 'release-v012-membership',
  organizationId,
  userId: accountId,
  role: 'owner',
  status: 'active',
  joinedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function json(response: import('node:http').ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function startAdminServer(): Promise<void> {
  const bundle = readFileSync(bundlePath!)
  adminServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(`${request.method} ${url.pathname}${url.search}`)
    if (url.pathname === '/api/auth/validate') {
      json(response, { valid: true, user, configVersion: 'release-v012-auth-1' })
      return
    }
    if (url.pathname === '/api/llm-connections') {
      json(response, { connections: [], defaultConnection: null })
      return
    }
    if (url.pathname === '/api/me/organizations') {
      json(response, { organizations: [{ ...organization, membership, memberCount: 1 }] })
      return
    }
    if (url.pathname === `/api/organizations/${organizationId}/apps`) {
      json(response, {
        appConfigVersion: 12,
        apps: [{
          id: remoteAppId,
          organizationId,
          name: 'Release Remote App',
          description: 'Remote URL catalog fixture',
          creatorName: 'Release E2E',
          deliveryMode: 'remote_url',
          remoteUrl: `${adminBaseUrl}/remote-app`,
          sortOrder: 1,
        }, {
          id: localAppId,
          organizationId,
          name: 'Release Static App',
          description: 'Static local bundle catalog fixture',
          creatorName: 'Release E2E',
          deliveryMode: 'local_bundle',
          currentRelease: {
            id: releaseId,
            version: '1.0.0',
            runtime: 'static',
            checksum: `sha256:${checksum}`,
            sizeBytes,
            platform: 'any',
            arch: 'any',
          },
          permissions: [],
          sortOrder: 2,
        }],
      })
      return
    }
    if (
      request.method === 'POST'
      && url.pathname === `/api/organizations/${organizationId}/apps/${localAppId}/releases/${releaseId}/download`
    ) {
      json(response, {
        releaseId,
        downloadUrl: `${adminBaseUrl}/download/static-v1.tar.gz?grant=e2e`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        checksum: `sha256:${checksum}`,
        sizeBytes,
        runtime: 'static',
        platform: 'any',
        arch: 'any',
      })
      return
    }
    if (url.pathname === '/download/static-v1.tar.gz') {
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': String(bundle.length),
      })
      response.end(bundle)
      return
    }
    if (url.pathname === '/remote-app') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<h1>release-v012-remote-ready</h1>')
      return
    }
    json(response, { error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  })
  await new Promise<void>((resolve, reject) => {
    adminServer!.once('error', reject)
    adminServer!.listen(0, '127.0.0.1', resolve)
  })
  const address = adminServer.address()
  if (!address || typeof address === 'string') throw new Error('Mock Admin has no port')
  adminBaseUrl = `http://127.0.0.1:${address.port}`
  const configPath = join(configDirectory!, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  config.adminUrl = adminBaseUrl
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function safeMethodProxy(overrides: Record<string, unknown>): object {
  return new Proxy(overrides, {
    get(target, property) {
      if (typeof property === 'string' && property in target) return target[property]
      return () => undefined
    },
  })
}

function handlerDependencies(): HandlerDeps {
  const logger = {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    debug: () => {},
  }
  return {
    sessionManager: safeMethodProxy({
      waitForInit: async () => {},
      getWorkspaces: () => [workspace],
      getSessions: () => [],
      getUnreadSummary: () => ({ totalUnread: 0, byWorkspace: {} }),
      setupConfigWatcher: () => {},
      clearActiveViewingSession: () => {},
      getSessionPermissionModeState: async () => ({ mode: 'ask', modeVersion: 0 }),
    }),
    oauthFlowStore: safeMethodProxy({}),
    windowManager: safeMethodProxy({
      getWorkspaceForWindow: () => workspace.id,
      updateWindowWorkspace: () => true,
      registerWindow: () => {},
      getWindowByWebContentsId: () => window,
      getAllWindowsForWorkspace: () => window ? [window] : [],
    }),
    browserPaneManager: safeMethodProxy({ listInstances: () => [], getInstances: () => [] }),
    platform: {
      appRootPath: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      appVersion: '0.12.0-e2e',
      isDebugMode: true,
      logger,
      systemDarkMode: () => false,
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    },
  } as unknown as HandlerDeps
}

function installBootstrapIpc(): void {
  ipcMain.on('__get-web-contents-id', event => { event.returnValue = event.sender.id })
  ipcMain.on('__get-ws-port', event => { event.returnValue = rpcServer.port })
  ipcMain.on('__get-ws-token', event => { event.returnValue = '' })
  ipcMain.on('__get-workspace-id', event => { event.returnValue = workspace.id })
  ipcMain.on('__get-workspace-remote-config', event => { event.returnValue = null })
  ipcMain.handle('__dialog:showMessageBox', async () => ({ response: 0, checkboxChecked: false }))
  ipcMain.handle('__dialog:showOpenDialog', async () => ({ canceled: true, filePaths: [] }))
  ipcMain.handle('__browser:invoke', async () => null)
}

async function evaluate<T>(source: string): Promise<T> {
  if (!window) throw new Error('Release v0.12 window is unavailable')
  return window.webContents.executeJavaScript(source, true) as Promise<T>
}

async function waitFor(description: string, source: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(source)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function click(selector: string): Promise<void> {
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ${selector}');
    element.click();
  })()`)
}

async function run(): Promise<void> {
  app.setPath('userData', join(configDirectory!, 'electron-user-data'))
  await startAdminServer()
  await getCredentialManager().setAdminTokens({
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 3_600_000,
    userId: accountId,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    groupIds: [],
  })
  registerCoreRpcHandlers(rpcServer, handlerDependencies())
  registerLocalAppHandlers(rpcServer)
  await rpcServer.listen()
  installBootstrapIpc()
  window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false,
    },
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.warn('[production-renderer]', message)
  })
  await window.loadFile(rendererHtmlPath!)

  await waitFor('production home', `Boolean(document.querySelector('[data-testid="home-app-hub"]'))`)
  await waitFor('organization catalog', `Boolean(document.querySelector('[data-testid="organization-app-${localAppId}"]'))`)
  await waitFor('remote catalog app', `Boolean(document.querySelector('[data-testid="organization-app-${remoteAppId}"]'))`)

  await click(`[data-testid="organization-app-action-${localAppId}"]`)
  await waitFor('install confirmation', `Boolean(document.querySelector('[role="dialog"]'))`)
  await evaluate(`window.electronAPI.localApps.install({
    scope: {
      kind: 'catalog', accountId: ${JSON.stringify(accountId)},
      organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
    },
    release: {
      version: '1.0.0', runtime: 'static', checksum: ${JSON.stringify(checksum)},
      sizeBytes: ${sizeBytes}, platform: null, arch: null
    },
    appConfigVersion: '12',
    permissions: []
  })`)
  await waitFor('installed local app', `(async () => {
    const status = await window.electronAPI.localApps.getRuntimeStatus({
      kind: 'catalog', accountId: ${JSON.stringify(accountId)},
      organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
    });
    return status.status === 'installed' || status.status === 'stopped';
  })()`, 90_000)

  await evaluate(`window.electronAPI.localApps.start({
    kind: 'catalog', accountId: ${JSON.stringify(accountId)},
    organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
  })`)
  await waitFor('running local app', `(async () => {
    const status = await window.electronAPI.localApps.getRuntimeStatus({
      kind: 'catalog', accountId: ${JSON.stringify(accountId)},
      organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
    });
    return status.status === 'running';
  })()`)
  const runtimeEvidence = await evaluate<{ status: string; url?: string }>(`(async () => {
    const scope = {
      kind: 'catalog', accountId: ${JSON.stringify(accountId)},
      organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
    };
    const status = await window.electronAPI.localApps.getRuntimeStatus(scope);
    const body = await (await fetch(status.url)).text();
    if (!body.includes('release-v012-static-ready')) throw new Error('Static bundle body mismatch');
    return { status: status.status, url: status.url };
  })()`)

  const remote = await evaluate<{ url: string }>(`window.electronAPI.localApps.resolveRemoteUrl({
    kind: 'catalog', accountId: ${JSON.stringify(accountId)},
    organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(remoteAppId)}
  })`)
  if (remote.url !== `${adminBaseUrl}/remote-app`) throw new Error('Remote URL catalog resolution mismatch')

  const stopped = await evaluate<{ status: string }>(`window.electronAPI.localApps.stop({
    kind: 'catalog', accountId: ${JSON.stringify(accountId)},
    organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
  })`)
  if (stopped.status !== 'stopped') throw new Error(`Unexpected stopped state ${stopped.status}`)
  await evaluate(`window.electronAPI.localApps.uninstall({
    kind: 'catalog', accountId: ${JSON.stringify(accountId)},
    organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
  }, { preserveData: false })`)
  const uninstalled = await evaluate<{ status: string }>(`window.electronAPI.localApps.getRuntimeStatus({
    kind: 'catalog', accountId: ${JSON.stringify(accountId)},
    organizationId: ${JSON.stringify(organizationId)}, catalogAppId: ${JSON.stringify(localAppId)}
  })`)
  if (uninstalled.status !== 'not_installed') {
    throw new Error(`Unexpected uninstall state ${uninstalled.status}`)
  }

  const requiredRequests = [
    `GET /api/organizations/${organizationId}/apps`,
    `POST /api/organizations/${organizationId}/apps/${localAppId}/releases/${releaseId}/download`,
    'GET /download/static-v1.tar.gz?grant=e2e',
  ]
  for (const expected of requiredRequests) {
    if (!requests.some(request => request.startsWith(expected))) {
      throw new Error(`Missing Admin contract request: ${expected}`)
    }
  }

  completed = true
  console.log(JSON.stringify({
    event: 'native_release_v012_e2e_pass',
    rendererEntry: 'apps/electron/dist/renderer/index.html',
    scenarios: [
      'authenticated-organization-restore',
      'home-personal-and-organization-sections',
      'POL-52-numeric-catalog-version-normalization',
      'remote-url-catalog-resolution',
      'short-lived-release-download-grant',
      'sha256-prefix-normalization',
      'any-platform-and-arch-normalization',
      'static-bundle-install-confirmation-and-production-preload',
      'static-bundle-start-and-health',
      'static-bundle-stop',
      'static-bundle-uninstall-with-data-removal',
    ],
    requests,
    runtimeEvidence,
  }))
  app.quit()
}

const timeout = setTimeout(() => {
  if (!completed) {
    console.error('Release v0.12 Electron E2E timed out')
    app.exit(1)
  }
}, 180_000)

app.whenReady().then(run).catch(error => {
  console.error(error)
  app.exit(1)
})

app.on('will-quit', event => {
  clearTimeout(timeout)
  event.preventDefault()
  Promise.resolve()
    .then(() => shutdownLocalAppRuntime())
    .then(() => new Promise<void>(resolve => adminServer?.close(() => resolve()) ?? resolve()))
    .finally(() => {
      rpcServer.close()
      app.exit(0)
    })
})
