import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { WsRpcServer } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'

const preloadPath = process.argv[2]
const repositoryRoot = process.argv[3]
if (!preloadPath || !repositoryRoot) {
  throw new Error('Phone auth E2E preload path and repository root are required')
}

const PHONE = '13800138000'
const CODE = '123456'
const CHALLENGE_TOKEN = 'mock-provider-signed-token'
const LEGACY_IDENTIFIER = 'legacy-user'
const PASSWORD = 'password-123'

const rpcServer = new WsRpcServer({
  host: '127.0.0.1',
  port: 0,
})
const registeredPhones = new Set<string>()
let loggedIn = false
let passwordWasSet = false

rpcServer.handle(RPC_CHANNELS.admin.GET_STATUS, async () => ({
  adminUrl: 'https://admin.mock.example',
  loggedIn,
  username: loggedIn ? PHONE : null,
  displayName: null,
}))
rpcServer.handle(RPC_CHANNELS.admin.GET_AUTH_CONFIG, async () => ({
  phoneAuthEnabled: true,
}))
rpcServer.handle(
  RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE,
  async (_context, phone: string, challengeToken: string) => (
    phone === PHONE && challengeToken === CHALLENGE_TOKEN
      ? { success: true, accepted: true, expiresIn: 300, resendAfter: 2 }
      : { success: false, errorCode: 'invalid_credentials' }
  ),
)
rpcServer.handle(
  RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE,
  async (_context, phone: string, code: string) => {
    if (phone !== PHONE || code !== CODE) {
      return { success: false, errorCode: 'verification_code_invalid' }
    }
    const isNewUser = !registeredPhones.has(phone)
    registeredPhones.add(phone)
    loggedIn = true
    return {
      success: true,
      isNewUser,
      user: {
        id: 'user-phone',
        username: phone,
        displayName: null,
        role: 'user',
        groupIds: [],
      },
    }
  },
)
rpcServer.handle(
  RPC_CHANNELS.admin.SET_PASSWORD,
  async (_context, password: string) => {
    passwordWasSet = loggedIn && password === PASSWORD
    return passwordWasSet
      ? { success: true }
      : { success: false, errorCode: 'VALIDATION_ERROR' }
  },
)
rpcServer.handle(
  RPC_CHANNELS.admin.LOGIN,
  async (_context, identifier: string, password: string) => {
    const validPhonePassword = (
      identifier === PHONE && passwordWasSet && password === PASSWORD
    )
    const validLegacyPassword = (
      identifier === LEGACY_IDENTIFIER && password === PASSWORD
    )
    return validPhonePassword || validLegacyPassword
      ? {
          success: true,
          user: {
            id: validLegacyPassword ? 'user-legacy' : 'user-phone',
            username: identifier,
            displayName: null,
            role: 'user',
            groupIds: [],
          },
        }
      : { success: false, errorCode: 'INVALID_CREDENTIALS' }
  },
)

const challengeServer = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (requestUrl.pathname !== '/challenge') {
    response.writeHead(404).end()
    return
  }
  const redirectUri = requestUrl.searchParams.get('redirect_uri')
  const state = requestUrl.searchParams.get('state')
  if (!redirectUri || !state) {
    response.writeHead(400).end()
    return
  }
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set('code', CHALLENGE_TOKEN)
  callbackUrl.searchParams.set('state', state)
  response.writeHead(302, { Location: callbackUrl.toString() }).end()
})

function listenChallengeServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    challengeServer.once('error', reject)
    challengeServer.listen(0, '127.0.0.1', () => {
      const address = challengeServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Mock challenge provider did not bind to a port'))
        return
      }
      resolve(address.port)
    })
  })
}

function assertE2eResult(result: Record<string, unknown>): void {
  const successfulSteps = [
    'challenge',
    'send',
    'firstVerify',
    'setPassword',
    'secondChallenge',
    'secondSend',
    'secondVerify',
    'phonePasswordLogin',
    'legacyLogin',
  ]
  for (const step of successfulSteps) {
    const value = result[step] as { success?: boolean } | undefined
    if (value?.success !== true) {
      throw new Error(`${step} did not succeed: ${JSON.stringify(value)}`)
    }
  }

  const firstVerify = result.firstVerify as { isNewUser?: boolean }
  const secondVerify = result.secondVerify as { isNewUser?: boolean }
  if (firstVerify.isNewUser !== true || secondVerify.isNewUser !== false) {
    throw new Error('Automatic registration/new-user semantics were not preserved')
  }
}

let completed = false
const timeout = setTimeout(() => {
  if (!completed) {
    console.error('Native Electron phone auth E2E timed out')
    app.exit(1)
  }
}, 30_000)

ipcMain.once('phone-auth-e2e:result', (_event, result: Record<string, unknown>) => {
  try {
    assertE2eResult(result)
    completed = true
    clearTimeout(timeout)
    console.log('Native Electron phone auth E2E passed')
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  if (completed) app.quit()
})

app.whenReady().then(async () => {
  await rpcServer.listen()
  const challengePort = await listenChallengeServer()
  const rpcUrl = `ws://127.0.0.1:${rpcServer.port}`
  const challengeUrl = `http://127.0.0.1:${challengePort}/challenge`

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false,
      additionalArguments: [
        `--phone-auth-e2e-rpc-url=${rpcUrl}`,
        `--phone-auth-e2e-challenge-url=${challengeUrl}`,
      ],
    },
  })

  await window.loadFile(join(
    repositoryRoot,
    'apps/electron/e2e/phone-auth/renderer.html',
  ))
}).catch(error => {
  console.error(error)
  app.exit(1)
})

app.on('will-quit', () => {
  rpcServer.close()
  challengeServer.close()
})
