import { app, BrowserWindow, ipcMain, net } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WsRpcServer } from '@polo-ai/server-core/transport'
import { registerAdminHandlers } from '@polo-ai/server-core/handlers/rpc/admin'
import type { HandlerDeps } from '@polo-ai/server-core/handlers'
import { getCredentialManager } from '@polo-ai/shared/credentials'

const preloadPath = process.argv[2]
const rendererHtmlPath = process.argv[3]
const providerBaseUrl = process.argv[4]
const providerBearerToken = process.argv[5]
const phone = process.argv[6]
const configDirectory = process.env.POLO_AI_CONFIG_DIR

if (
  !preloadPath
  || !rendererHtmlPath
  || !providerBaseUrl
  || !providerBearerToken
  || !phone
  || !configDirectory
) {
  throw new Error('Phone auth E2E runtime configuration is incomplete')
}
const credentialDirectory = configDirectory

const password = 'phone-password-123'
const legacyIdentifier = 'alice'
const legacyPassword = 'alice-password-123'
const rpcServer = new WsRpcServer({ host: '127.0.0.1', port: 0 })
const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: () => {},
}

registerAdminHandlers(rpcServer, {
  platform: {
    appRootPath: process.cwd(),
    resourcesPath: process.cwd(),
    isPackaged: false,
    appVersion: '0.0.0-phone-auth-e2e',
    isDebugMode: true,
    logger,
    imageProcessor: {
      getMetadata: async () => null,
      process: async () => Buffer.from(''),
    },
  },
} as unknown as HandlerDeps)

let window: BrowserWindow | null = null
let completed = false

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
    event.returnValue = 'phone-auth-e2e'
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
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
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

async function click(selector: string): Promise<void> {
  await evaluate(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Element not found');
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

async function runPhoneLogin(expectedNewUser: boolean): Promise<void> {
  await waitForSelector('#phone-auth-phone')
  await fill('#phone-auth-phone', phone)
  await click('[data-testid="phone-auth-consent"]')
  await waitFor('enabled send-code button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="phone-auth-send-code"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="phone-auth-entry"]')
  try {
    await waitForSelector('#phone-auth-code')
  } catch (error) {
    const snapshot = await evaluate<Record<string, unknown>>(`
      (() => {
        const phoneInput = document.querySelector('#phone-auth-phone');
        const consent = document.querySelector('[data-testid="phone-auth-consent"]');
        const send = document.querySelector('[data-testid="phone-auth-send-code"]');
        return {
          stage: document.querySelector('#phone-auth-e2e-root')?.getAttribute('data-stage'),
          phoneLength: phoneInput instanceof HTMLInputElement ? phoneInput.value.length : null,
          consented: consent instanceof HTMLInputElement ? consent.checked : null,
          sendDisabled: send instanceof HTMLButtonElement ? send.disabled : null,
          alert: document.querySelector('[role="alert"]')?.textContent ?? null,
        };
      })()
    `)
    throw new Error(`Phone send did not advance: ${JSON.stringify(snapshot)}`, {
      cause: error,
    })
  }
  const code = await fetchLatestCode()
  await fill('#phone-auth-code', code)
  await waitFor('enabled verification button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="phone-auth-continue"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="phone-auth-verify"]')
  await waitForSelector('[data-testid="account-security-password-form"]')
  const actualNewUser = await evaluate<string>('document.body.dataset.lastPhoneNewUser')
  if (actualNewUser !== String(expectedNewUser)) {
    throw new Error(
      `Expected isNewUser=${expectedNewUser}, received ${actualNewUser}`,
    )
  }
}

async function showLogin(): Promise<void> {
  await evaluate('window.phoneAuthE2e.showLogin()')
  await waitForSelector('[data-testid="admin-login-method-password"]')
}

async function runPasswordLogin(identifier: string, loginPassword: string): Promise<void> {
  await showLogin()
  await click('[data-testid="admin-login-method-password"]')
  await waitForSelector('[data-testid="admin-password-login-form"]')
  await fill('#admin-identifier', identifier)
  await fill('#admin-password', loginPassword)
  await waitFor('enabled password login button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="admin-password-login-form"] button[type="submit"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="admin-password-login-form"]')
  await waitFor('password login completion', () => evaluate<boolean>(
    `document.querySelector('#phone-auth-e2e-root')?.getAttribute('data-stage') === 'complete'`,
  ))
  const completedIdentifier = await evaluate<string>(
    `document.querySelector('#phone-auth-e2e-root')?.getAttribute('data-last-identifier') ?? ''`,
  )
  if (completedIdentifier !== identifier) {
    throw new Error(`Password login completed for unexpected identifier: ${completedIdentifier}`)
  }
}

async function assertEncryptedCredentials(expectedUsername?: string): Promise<void> {
  const manager = getCredentialManager()
  const tokens = await manager.getAdminTokens()
  if (!tokens) throw new Error('Existing credential persistence did not store Admin tokens')
  if (expectedUsername && tokens.username !== expectedUsername) {
    throw new Error(`Expected persisted username ${expectedUsername}, received ${tokens.username}`)
  }

  const credentialPath = join(credentialDirectory, 'credentials.enc')
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
  await rpcServer.listen()
  installBootstrapIpc()

  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false,
    },
  })
  await window.loadFile(rendererHtmlPath)

  await runPhoneLogin(true)
  await assertEncryptedCredentials()

  await fill('#account-password', password)
  await fill('#account-password-confirmation', password)
  await waitFor('enabled set-password button', () => evaluate<boolean>(
    `document.querySelector('[data-testid="account-security-password-form"] button[type="submit"]')?.hasAttribute('disabled') === false`,
  ))
  await submit('[data-testid="account-security-password-form"]')
  await waitFor('password setting success', () => evaluate<boolean>(
    `Boolean(document.querySelector('[data-testid="account-security-password-form"] [role="status"]'))`,
  ))

  const resendAfter = await evaluate<number>(
    `Number(document.body.dataset.phoneAuthResendAfter ?? 60)`,
  )
  if (!Number.isFinite(resendAfter) || resendAfter < 1 || resendAfter > 300) {
    throw new Error(`Invalid POL-53 resendAfter value: ${resendAfter}`)
  }
  await new Promise(resolve => setTimeout(resolve, (resendAfter + 1) * 1000))

  await showLogin()
  await runPhoneLogin(false)
  await assertEncryptedCredentials()

  await runPasswordLogin(phone, password)
  await runPasswordLogin(legacyIdentifier, legacyPassword)
  await assertEncryptedCredentials(legacyIdentifier)

  completed = true
  console.log(JSON.stringify({
    event: 'native_phone_auth_e2e_pass',
    adminChain: [
      'renderer',
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
      'set-password',
      'returning-phone-code-login',
      'phone-password-login',
      'legacy-username-login',
    ],
  }))
  app.quit()
}

const timeout = setTimeout(() => {
  if (!completed) {
    console.error('Native Electron phone auth E2E timed out')
    app.exit(1)
  }
}, 180_000)

app.whenReady().then(run).catch(error => {
  console.error(error)
  app.exit(1)
})

app.on('will-quit', () => {
  clearTimeout(timeout)
  rpcServer.close()
})
