import { app, BrowserWindow, ipcMain, net } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '@polo-ai/core/types'
import { getCredentialManager } from '@z-h-ai/shared/credentials'
import type { HandlerDeps } from '@polo-ai/server-core/handlers'
import { registerCoreRpcHandlers } from '@polo-ai/server-core/handlers/rpc'
import { WsRpcServer } from '@polo-ai/server-core/transport'

const preloadPath = process.argv[2]
const rendererHtmlPath = process.argv[3]
const providerBaseUrl = process.argv[4]
const providerBearerToken = process.argv[5]
const phone = process.argv[6]
const legacyIdentifier = process.argv[7]
const legacyPassword = process.argv[8]
const adminBaseUrl = process.argv[9]
const configDirectory = process.env.POLO_AI_CONFIG_DIR

if (
  !preloadPath
  || !rendererHtmlPath
  || !providerBaseUrl
  || !providerBearerToken
  || !phone
  || !legacyIdentifier
  || !legacyPassword
  || !adminBaseUrl
  || !configDirectory
) {
  throw new Error('Phone auth E2E runtime configuration is incomplete')
}

const password = 'phone-password-123'
const e2eUserAgent = `polo-phone-auth-e2e/${phone}`
const runtimeFetch = globalThis.fetch
const logoutHttpStatuses: number[] = []
const authConfigHttpStatuses: number[] = []
const revokedValidateStatuses: number[] = []
const revokedRefreshStatuses: number[] = []
globalThis.fetch = (async (input, init = {}) => {
  const headers = new Headers(init.headers)
  headers.set('User-Agent', e2eUserAgent)
  const response = await runtimeFetch(input, { ...init, headers })
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
  const pathname = new URL(requestUrl).pathname
  if (pathname === '/api/auth/logout') {
    logoutHttpStatuses.push(response.status)
  }
  if (pathname === '/api/auth/config') {
    authConfigHttpStatuses.push(response.status)
  }
  return response
}) as typeof globalThis.fetch
const workspace: Workspace = {
  id: 'phone-auth-e2e-workspace',
  name: 'Phone Auth E2E',
  slug: 'phone-auth-e2e',
  rootPath: join(configDirectory, 'workspace'),
  createdAt: Date.now(),
}
const rpcServer = new WsRpcServer({ host: '127.0.0.1', port: 0 })
const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: () => {},
}

let window: BrowserWindow | null = null
let completed = false

function safeMethodProxy(overrides: Record<string, unknown>): object {
  return new Proxy(overrides, {
    get(target, property) {
      if (typeof property === 'string' && property in target) {
        return target[property]
      }
      return () => undefined
    },
  })
}

function createHandlerDependencies(): HandlerDeps {
  const sessionManager = safeMethodProxy({
    waitForInit: async () => {},
    getWorkspaces: () => [workspace],
    getSessions: () => [],
    getUnreadSummary: () => ({
      totalUnread: 0,
      byWorkspace: {},
    }),
    setupConfigWatcher: () => {},
    clearActiveViewingSession: () => {},
    getSessionPermissionModeState: async () => ({
      mode: 'ask',
      modeVersion: 0,
    }),
  })
  const windowManager = safeMethodProxy({
    getWorkspaceForWindow: () => workspace.id,
    updateWindowWorkspace: () => true,
    registerWindow: () => {},
    getWindowByWebContentsId: () => window,
    getAllWindowsForWorkspace: () => window ? [window] : [],
  })
  const browserPaneManager = safeMethodProxy({
    listInstances: () => [],
    getInstances: () => [],
  })

  return {
    sessionManager,
    oauthFlowStore: safeMethodProxy({}),
    windowManager,
    browserPaneManager,
    platform: {
      appRootPath: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      appVersion: '0.0.0-phone-auth-e2e',
      isDebugMode: true,
      logger,
      systemDarkMode: () => false,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  } as unknown as HandlerDeps
}

function installBootstrapIpc(): void {
  ipcMain.on('__get-web-contents-id', event => {
    event.returnValue = event.sender.id
  })
  ipcMain.on('__get-ws-port', event => {
    event.returnValue = rpcServer.port
  })
  ipcMain.on('__get-ws-token', event => {
    event.returnValue = ''
  })
  ipcMain.on('__get-workspace-id', event => {
    event.returnValue = workspace.id
  })
  ipcMain.on('__get-workspace-remote-config', event => {
    event.returnValue = null
  })
  ipcMain.handle('__phone-auth-e2e:open-external', async (_event, url: string) => {
    console.log('[phone-auth-e2e] following browser redirect')
    const response = await net.fetch(url, { redirect: 'follow' })
    await response.text()
    if (!response.ok) {
      throw new Error(`Phone auth challenge browser returned ${response.status}`)
    }
    console.log('[phone-auth-e2e] browser redirect completed')
  })
  ipcMain.handle('__dialog:showMessageBox', async () => ({
    response: 0,
    checkboxChecked: false,
  }))
  ipcMain.handle('__dialog:showOpenDialog', async () => ({
    canceled: true,
    filePaths: [],
  }))
  ipcMain.handle('__browser:invoke', async () => null)
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function evaluate<T>(source: string): Promise<T> {
  if (!window) throw new Error('Phone auth E2E window is unavailable')
  return window.webContents.executeJavaScript(source, true) as Promise<T>
}

async function waitForSelector(selector: string): Promise<void> {
  await waitFor(selector, () => evaluate<boolean>(
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
  ))
}

async function fill(selector: string, value: string): Promise<void> {
  await evaluate(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement)) throw new Error('Input not found');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `)
}

async function fillTextarea(selector: string, value: string): Promise<void> {
  await evaluate(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLTextAreaElement)) throw new Error('Textarea not found');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      ).set;
      setter.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `)
}

async function click(selector: string): Promise<void> {
  await evaluate(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Element not found');
      element.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerType: 'mouse'
      }));
      element.click();
    })()
  `)
}

async function submit(selector: string): Promise<void> {
  await evaluate(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLFormElement)) throw new Error('Form not found');
      element.requestSubmit();
    })()
  `)
}

async function fetchLatestCode(): Promise<string> {
  const url = new URL('/sms/latest', providerBaseUrl)
  url.searchParams.set('phone', `+86${phone}`)
  let code = ''
  await waitFor('mock SMS code', async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${providerBearerToken}` },
    })
    if (!response.ok) return false
    const body = await response.json() as { code?: string }
    code = body.code ?? ''
    return /^\d{6}$/.test(code)
  })
  return code
}

async function waitForOnboardingLogin(): Promise<void> {
  await waitForSelector('[data-testid="onboarding-wizard"]')
  await waitForSelector('#phone-auth-phone')
}

async function runPhoneLogin(): Promise<void> {
  await waitForOnboardingLogin()
  await fill('#phone-auth-phone', phone)
  await click('[data-testid="phone-auth-consent"]')
  await waitFor('enabled send-code button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="phone-auth-send-code"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="phone-auth-entry"]')
  await waitForSelector('#phone-auth-code')
  const code = await fetchLatestCode()
  await fill('#phone-auth-code', code)
  await waitFor('enabled verification button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="phone-auth-continue"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="phone-auth-verify"]')
  await waitForSelector('[data-testid="onboarding-complete-finish"]')
}

async function finishOnboarding(): Promise<void> {
  await click('[data-testid="onboarding-complete-finish"]')
  await waitFor('organization onboarding or application shell', () => evaluate<boolean>(
    `Boolean(
      document.querySelector('[data-testid="organization-onboarding-page"]')
      || document.querySelector('[data-testid="sidebar-user-menu-trigger"]')
    )`,
  ))
  const needsOrganization = await evaluate<boolean>(
    `Boolean(document.querySelector('[data-testid="organization-onboarding-page"]'))`,
  )
  if (needsOrganization) {
    await waitForSelector('[data-testid="organization-name-input"]')
    await fill('[data-testid="organization-name-input"]', `Phone E2E ${phone}`)
    await fillTextarea(
      '[data-testid="organization-purpose-input"]',
      'Validate the POO-8 to POO-13 release handoff',
    )
    await click('[data-testid="organization-create-submit"]')
  }
  await waitForSelector('[data-testid="sidebar-user-menu-trigger"]')
}

async function openAccountSecurity(): Promise<void> {
  await click('[data-testid="sidebar-user-menu-trigger"]')
  await waitForSelector('[data-testid="sidebar-user-menu-settings"]')
  await click('[data-testid="sidebar-user-menu-settings"]')
  await waitForSelector('[data-testid="settings-item-account-security"]')
  await click('[data-testid="settings-item-account-security"]')
  await waitForSelector('[data-testid="account-security-settings-page"]')
  await waitForSelector('[data-testid="account-security-password-form"]')
}

async function setPassword(): Promise<void> {
  await fill('#account-password', password)
  await fill('#account-password-confirmation', password)
  await waitFor('enabled set-password button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="account-security-password-form"] button[type="submit"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="account-security-password-form"]')
  await waitFor('password setting success', () => evaluate<boolean>(
    `(() => {
      const password = document.querySelector('#account-password');
      const confirmation = document.querySelector('#account-password-confirmation');
      const message = document.querySelector(
        '[data-testid="account-security-password-form"] p[role="status"]'
      );
      return password instanceof HTMLInputElement
        && confirmation instanceof HTMLInputElement
        && password.value === ''
        && confirmation.value === ''
        && Boolean(message);
    })()`,
  ))
}

async function logoutThroughProductionUi(): Promise<void> {
  const tokens = await getCredentialManager().getAdminTokens()
  if (!tokens) {
    throw new Error('Production logout started without persisted Admin credentials')
  }
  const logoutCountBefore = logoutHttpStatuses.length
  const authConfigCountBefore = authConfigHttpStatuses.length
  await click('[data-testid="sidebar-user-menu-trigger"]')
  await waitForSelector('[data-testid="sidebar-user-menu-logout"]')
  await click('[data-testid="sidebar-user-menu-logout"]')
  await waitForOnboardingLogin()
  if (await getCredentialManager().getAdminTokens()) {
    throw new Error('Production logout did not clear encrypted Admin credentials')
  }

  const newLogoutStatuses = logoutHttpStatuses.slice(logoutCountBefore)
  if (newLogoutStatuses.length !== 1 || newLogoutStatuses[0] !== 200) {
    throw new Error(
      `Expected one successful POL-53 logout response, received ${JSON.stringify(newLogoutStatuses)}`,
    )
  }
  const newAuthConfigStatuses = authConfigHttpStatuses.slice(authConfigCountBefore)
  if (newAuthConfigStatuses.length !== 1 || newAuthConfigStatuses[0] !== 200) {
    throw new Error(
      'Expected relogin to rediscover phone auth config exactly once, received '
      + JSON.stringify(newAuthConfigStatuses),
    )
  }

  const [validateResponse, refreshResponse] = await Promise.all([
    runtimeFetch(`${adminBaseUrl}/api/auth/validate`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
        'User-Agent': e2eUserAgent,
      },
    }),
    runtimeFetch(`${adminBaseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': e2eUserAgent,
      },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    }),
  ])
  revokedValidateStatuses.push(validateResponse.status)
  revokedRefreshStatuses.push(refreshResponse.status)
  if (validateResponse.status !== 401 || refreshResponse.status !== 401) {
    throw new Error(
      'POL-53 logout did not revoke the prior session and refresh token: '
      + JSON.stringify({
        validateStatus: validateResponse.status,
        refreshStatus: refreshResponse.status,
      }),
    )
  }
}

async function runPasswordLogin(identifier: string, loginPassword: string): Promise<void> {
  await waitForOnboardingLogin()
  await click('[data-testid="admin-login-method-password"]')
  await waitForSelector('[data-testid="admin-password-login-form"]')
  await fill('#admin-identifier', identifier)
  await fill('#admin-password', loginPassword)
  await waitFor('enabled password login button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="admin-password-login-form"] button[type="submit"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="admin-password-login-form"]')
  await waitForSelector('[data-testid="onboarding-complete-finish"]')
}

async function assertEncryptedCredentials(expectedUsername?: string): Promise<void> {
  const manager = getCredentialManager()
  const tokens = await manager.getAdminTokens()
  if (!tokens) throw new Error('Existing credential persistence did not store Admin tokens')
  if (expectedUsername && tokens.username !== expectedUsername) {
    throw new Error(`Expected persisted username ${expectedUsername}, received ${tokens.username}`)
  }

  const credentialPath = join(configDirectory!, 'credentials.enc')
  const encrypted = readFileSync(credentialPath)
  if (!encrypted.subarray(0, 8).equals(Buffer.from('POLOAI1\0'))) {
    throw new Error('Admin credentials were not written through encrypted credential storage')
  }
  for (const secret of [tokens.accessToken, tokens.refreshToken, phone]) {
    if (encrypted.includes(Buffer.from(secret))) {
      throw new Error('Credential file contains plaintext authentication material')
    }
  }
}

async function run(): Promise<void> {
  registerCoreRpcHandlers(rpcServer, createHandlerDependencies())
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
  await window.loadFile(rendererHtmlPath)

  await runPhoneLogin()
  await assertEncryptedCredentials()
  await finishOnboarding()
  await openAccountSecurity()
  await setPassword()

  await logoutThroughProductionUi()
  // POL-53 enforces the real resendAfter=60 contract for this phone.
  await new Promise(resolve => setTimeout(resolve, 61_000))
  await runPhoneLogin()
  await assertEncryptedCredentials()
  await finishOnboarding()

  await logoutThroughProductionUi()
  await runPasswordLogin(phone, password)
  await assertEncryptedCredentials()
  await finishOnboarding()

  await logoutThroughProductionUi()
  await runPasswordLogin(legacyIdentifier, legacyPassword)
  await assertEncryptedCredentials(legacyIdentifier)
  await finishOnboarding()
  await logoutThroughProductionUi()

  if (
    authConfigHttpStatuses.length !== 5
    || authConfigHttpStatuses.some(status => status !== 200)
  ) {
    throw new Error(
      'Expected initial discovery plus one successful auth config rediscovery per relogin, received '
      + JSON.stringify(authConfigHttpStatuses),
    )
  }

  completed = true
  console.log(JSON.stringify({
    event: 'native_phone_auth_e2e_pass',
    rendererEntry: 'apps/electron/dist/renderer/index.html',
    productionUi: [
      'App',
      'useOnboarding',
      'OnboardingWizard',
      'AccountSecuritySettingsPage',
      'SidebarUserMenu.logout',
    ],
    adminChain: [
      'production-renderer',
      'production-preload',
      'local-only-rpc',
      'server-core-handler',
      'admin-client',
      'POL-53',
      'polo_admin_test',
      'encrypted-credentials',
    ],
    scenarios: [
      'send-code',
      'auto-register',
      'first-login-organization-create',
      'returning-login-organization-restore',
      'account-security-navigation',
      'set-password',
      'real-logout',
      'relogin-auth-config-rediscovery',
      'returning-phone-code-login',
      'phone-password-login',
      'legacy-username-login',
      'logout-http-200',
      'revoked-access-token',
      'revoked-refresh-token',
    ],
    logoutEvidence: {
      expectedCount: 4,
      statuses: logoutHttpStatuses,
      revokedValidateStatuses,
      revokedRefreshStatuses,
    },
    authConfigEvidence: {
      expectedCount: 5,
      statuses: authConfigHttpStatuses,
    },
  }))
  app.quit()
}

const timeout = setTimeout(() => {
  if (!completed) {
    console.error('Native Electron phone auth E2E timed out')
    app.exit(1)
  }
}, 240_000)

app.whenReady().then(run).catch(error => {
  console.error(error)
  app.exit(1)
})

app.on('will-quit', () => {
  clearTimeout(timeout)
  rpcServer.close()
})
