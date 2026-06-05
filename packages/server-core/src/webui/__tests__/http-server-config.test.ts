import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebuiHandler } from '../http-server'

const SECRET = 'test-server-secret'
const PASSWORD = 'test-password'
const TEMP_DIRS: string[] = []
const HANDLERS: Array<{ dispose: () => void }> = []
const ORIGINAL_ADMIN_API_URL = process.env.ADMIN_API_URL
const ORIGINAL_PLATFORM_ANTHROPIC_API_KEY = process.env.PLATFORM_ANTHROPIC_API_KEY
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'polo-webui-config-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

async function createServer() {
  const handler = createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: SECRET,
    password: PASSWORD,
    wsProtocol: 'wss',
    wsPort: 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger,
  })

  HANDLERS.push(handler)

  return {
    handler,
    baseUrl: 'http://127.0.0.1:3100',
  }
}

function request(
  handler: { fetch: (req: Request) => Promise<Response> },
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return handler.fetch(new Request(`${baseUrl}${path}`, init))
}

function setEnv(name: 'ADMIN_API_URL' | 'PLATFORM_ANTHROPIC_API_KEY' | 'JWT_SECRET', value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function restoreEnv() {
  setEnv('ADMIN_API_URL', ORIGINAL_ADMIN_API_URL)
  setEnv('PLATFORM_ANTHROPIC_API_KEY', ORIGINAL_PLATFORM_ANTHROPIC_API_KEY)
  setEnv('JWT_SECRET', ORIGINAL_JWT_SECRET)
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}

afterEach(() => {
  restoreEnv()

  while (HANDLERS.length > 0) {
    HANDLERS.pop()?.dispose()
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('webui config endpoints', () => {
  it('returns public admin config without a session cookie', async () => {
    setEnv('ADMIN_API_URL', 'http://localhost:3001')
    setEnv('PLATFORM_ANTHROPIC_API_KEY', 'test-platform-key')
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/public-config')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      adminUrl: 'http://localhost:3001',
      platformMode: true,
    })
  })

  it('returns null adminUrl and disabled platform mode when env vars are unset', async () => {
    setEnv('ADMIN_API_URL', undefined)
    setEnv('PLATFORM_ANTHROPIC_API_KEY', undefined)
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/public-config')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      adminUrl: null,
      platformMode: false,
    })
  })

  it('does not require ADMIN_API_URL when platform mode is disabled', async () => {
    setEnv('ADMIN_API_URL', undefined)
    setEnv('PLATFORM_ANTHROPIC_API_KEY', undefined)
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/public-config')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      adminUrl: null,
      platformMode: false,
    })
  })

  it('does not leak configured secret values in public config', async () => {
    setEnv('ADMIN_API_URL', 'http://localhost:3001')
    setEnv('PLATFORM_ANTHROPIC_API_KEY', 'platform-secret-value')
    setEnv('JWT_SECRET', 'jwt-secret-value')
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/public-config')
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).not.toContain('platform-secret-value')
    expect(body).not.toContain('jwt-secret-value')
  })

  it('keeps /api/config protected without a session cookie', async () => {
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/config')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('keeps /api/config returning only wsUrl with a valid session cookie', async () => {
    const { handler, baseUrl } = await createServer()

    const authRes = await request(handler, baseUrl, '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await request(handler, baseUrl, '/api/config', {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://127.0.0.1:9100',
    })
  })
})
