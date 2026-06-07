import { afterEach, describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebuiHandler } from '../http-server'
import { clearAdminJwtStore } from '../auth'

const SECRET = 'test-server-secret'
const JWT_SECRET = 'admin-jwt-secret'
const TEMP_DIRS: string[] = []
const HANDLERS: Array<{ dispose: () => void }> = []
const ORIGINAL_POLO_ADMIN_API_URL = process.env.POLO_ADMIN_API_URL
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

function setEnv(name: 'POLO_ADMIN_API_URL' | 'PLATFORM_ANTHROPIC_API_KEY' | 'JWT_SECRET', value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function restoreEnv() {
  setEnv('POLO_ADMIN_API_URL', ORIGINAL_POLO_ADMIN_API_URL)
  setEnv('PLATFORM_ANTHROPIC_API_KEY', ORIGINAL_PLATFORM_ANTHROPIC_API_KEY)
  setEnv('JWT_SECRET', ORIGINAL_JWT_SECRET)
}

async function signAdminJwt(): Promise<string> {
  const key = new TextEncoder().encode(JWT_SECRET)
  return new SignJWT({ username: 'alice', role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-123')
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .sign(key)
}

async function createSessionCookie(handler: { fetch: (req: Request) => Promise<Response> }, baseUrl: string): Promise<string> {
  setEnv('JWT_SECRET', JWT_SECRET)
  const token = await signAdminJwt()
  const res = await request(handler, baseUrl, '/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}

afterEach(() => {
  restoreEnv()
  clearAdminJwtStore()

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
    setEnv('POLO_ADMIN_API_URL', 'http://localhost:3001')
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
    setEnv('POLO_ADMIN_API_URL', undefined)
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
    setEnv('POLO_ADMIN_API_URL', 'http://localhost:3001')
    setEnv('PLATFORM_ANTHROPIC_API_KEY', 'platform-secret-value')
    setEnv('JWT_SECRET', 'jwt-secret-value')
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/public-config')
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).not.toContain('platform-secret-value')
    expect(body).not.toContain('jwt-secret-value')
  })

  it('keeps /api/config protected without auth', async () => {
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/config')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('keeps /api/config returning only wsUrl with a valid Admin JWT session cookie', async () => {
    const { handler, baseUrl } = await createServer()
    const cookie = await createSessionCookie(handler, baseUrl)

    const configRes = await request(handler, baseUrl, '/api/config', {
      headers: { cookie },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://127.0.0.1:9100',
    })
  })
})
