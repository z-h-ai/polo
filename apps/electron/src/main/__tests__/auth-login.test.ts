import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AccountDisabledError,
  InvalidCredentialsError,
  NetworkError,
  RateLimitedError,
} from '@polo-ai/shared/auth'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const TEST_USER_DATA_DIR = '/tmp/polo-ai-test-user-data'
const TEST_SESSION_FILE = join(TEST_USER_DATA_DIR, 'auth', 'admin-session.json')

mock.module('electron', () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      ipcHandlers.set(channel, handler)
    },
  },
  BrowserView: class {},
  BrowserWindow: class {},
  app: {
    getPath: () => TEST_USER_DATA_DIR,
  },
  nativeTheme: { shouldUseDarkColors: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  },
  session: {},
  shell: { openExternal: async () => {} },
}))

const sampleUser = {
  id: 'user-1',
  username: 'zhangsan',
  displayName: 'Zhang San',
  role: 'admin',
  groupIds: [],
}

describe('Electron auth login IPC', () => {
  beforeEach(async () => {
    ipcHandlers.clear()
    await rm(TEST_USER_DATA_DIR, { recursive: true, force: true })
  })

  it('handles auth:login by proxying Admin login, storing the token outside the renderer, and returning only user metadata', async () => {
    const { registerElectronAuthHandlers } = await import('../auth')

    registerElectronAuthHandlers({
      adminApiClient: {
        login: async (username: string, password: string) => {
          expect(username).toBe('zhangsan')
          expect(password).toBe('pass')
          return { token: 'admin.jwt.secret', user: sampleUser }
        },
      },
    })

    const handler = ipcHandlers.get('auth:login')
    expect(handler).toBeDefined()

    const result = await handler!({}, 'zhangsan', 'pass')

    expect(result).toEqual({ user: sampleUser })
    expect('token' in (result as Record<string, unknown>)).toBe(false)

    const storedSession = await readFile(TEST_SESSION_FILE, 'utf8')
    expect(storedSession).toContain('"encryptedToken"')
    expect(storedSession).toContain(Buffer.from('encrypted:admin.jwt.secret').toString('base64'))
    expect(storedSession).not.toContain('admin.jwt.secret')
  })

  it.each([
    [
      new InvalidCredentialsError(401, { error: 'invalid_credentials' }),
      { code: 'invalid_credentials', statusCode: 401 },
    ],
    [
      new AccountDisabledError(403, { error: 'account_disabled' }),
      { code: 'account_disabled', statusCode: 403 },
    ],
    [
      new RateLimitedError(429, { error: 'rate_limited' }, 30),
      { code: 'rate_limited', statusCode: 429, retryAfterSeconds: 30 },
    ],
    [
      new NetworkError('Admin API unavailable'),
      { code: 'network_error' },
    ],
  ])('maps Admin login error variants for renderer LoginPage handling', async (adminError, expected) => {
    const { registerElectronAuthHandlers } = await import('../auth')

    registerElectronAuthHandlers({
      adminApiClient: {
        login: async () => {
          throw adminError
        },
      },
      tokenStore: {
        save: async () => {
          throw new Error('token should not be stored on failed login')
        },
      },
    })

    const handler = ipcHandlers.get('auth:login')
    expect(handler).toBeDefined()

    const result = await handler!({}, 'zhangsan', 'bad-pass')
    expect(result).toMatchObject({ error: expected })
    expect(result).not.toHaveProperty('token')
    expect((result as { error: Record<string, unknown> }).error).not.toHaveProperty('token')
  })
})
