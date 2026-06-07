import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SignJWT } from 'jose'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adminJwtStore, clearAdminJwtStore } from '../auth'
import { createWebuiHandler } from '../http-server'

const HANDLER_SECRET = 'legacy-webui-secret'
const JWT_SECRET = 'admin-jwt-secret'
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET
const ORIGINAL_POLO_ADMIN_API_URL = process.env.POLO_ADMIN_API_URL
const TEMP_DIRS: string[] = []
const HANDLERS: Array<{ dispose: () => void }> = []

function setEnv(name: 'JWT_SECRET' | 'POLO_ADMIN_API_URL', value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function restoreEnv() {
  setEnv('JWT_SECRET', ORIGINAL_JWT_SECRET)
  setEnv('POLO_ADMIN_API_URL', ORIGINAL_POLO_ADMIN_API_URL)
}

function createLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'polo-auth-login-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

function createServer() {
  const handler = createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: HANDLER_SECRET,
    wsProtocol: 'wss',
    wsPort: 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger: createLogger() as any,
  })
  HANDLERS.push(handler)
  return { handler, baseUrl: 'https://polo.example.com' }
}

function request(
  handler: { fetch: (req: Request) => Promise<Response> },
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return handler.fetch(new Request(`${baseUrl}${path}`, init))
}

async function signAdminJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ username: 'alice', role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-123')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(JWT_SECRET))
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

afterEach(() => {
  restoreEnv()
  clearAdminJwtStore()
  mock.restore()

  while (HANDLERS.length > 0) HANDLERS.pop()?.dispose()
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('POST /auth/login', () => {
  it('proxies credentials to Admin, stores the token in an HttpOnly cookie, and returns only the user', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('POLO_ADMIN_API_URL', 'https://admin.example.com')
    const token = await signAdminJwt()
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
      expect(url).toBe('https://admin.example.com/api/auth/login')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({ username: 'alice', password: 'secret' })
      return jsonResponse({ token, user: { id: 'user-123', username: 'alice', role: 'admin' } })
    }) as typeof fetch)
    const { handler, baseUrl } = createServer()

    const res = await request(handler, baseUrl, '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret' }),
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: 'user-123', username: 'alice', role: 'admin' },
    })
    expect(res.headers.get('set-cookie')).toContain(`polo_ai_session=${token}`)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect(adminJwtStore.get('user-123')).toBe(token)
  })

  it('forwards Admin login errors without setting a session cookie', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('POLO_ADMIN_API_URL', 'https://admin.example.com')
    spyOn(globalThis, 'fetch').mockImplementation((async () =>
      jsonResponse({ error: 'rate_limited', message: 'Too many attempts' }, 429, { 'Retry-After': '30' })) as unknown as typeof fetch)
    const { handler, baseUrl } = createServer()

    const res = await request(handler, baseUrl, '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'bad' }),
    })

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.json()).toEqual({ error: 'rate_limited', message: 'Too many attempts' })
  })
})
