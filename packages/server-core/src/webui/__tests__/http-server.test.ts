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
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'polo-webui-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

async function createServer(overrides?: {
  secureCookies?: boolean
  publicWsUrl?: string
  wsProtocol?: 'ws' | 'wss'
  wsPort?: number
}) {
  const handler = createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: SECRET,
    secureCookies: overrides?.secureCookies,
    publicWsUrl: overrides?.publicWsUrl,
    wsProtocol: overrides?.wsProtocol ?? 'wss',
    wsPort: overrides?.wsPort ?? 9100,
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

function setJwtSecret(value: string | undefined) {
  if (value === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = value
}

async function signAdminJwt(): Promise<string> {
  const key = new TextEncoder().encode(JWT_SECRET)
  return new SignJWT({ username: 'alice', role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-123')
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .sign(key)
}

async function createSession(
  handler: { fetch: (req: Request) => Promise<Response> },
  baseUrl: string,
  headers?: Record<string, string>,
): Promise<Response> {
  setJwtSecret(JWT_SECRET)
  const token = await signAdminJwt()
  return request(handler, baseUrl, '/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify({ token }),
  })
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}

afterEach(() => {
  setJwtSecret(ORIGINAL_JWT_SECRET)
  clearAdminJwtStore()

  while (HANDLERS.length > 0) {
    HANDLERS.pop()?.dispose()
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('startWebuiHttpServer', () => {
  it('allows plain-http Admin JWT session setup even when the RPC transport is wss', async () => {
    const { handler, baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await createSession(handler, baseUrl)

    expect(authRes.status).toBe(200)
    const setCookie = authRes.headers.get('set-cookie')
    expect(setCookie).toContain('polo_ai_session=')
    expect(setCookie).not.toContain('Secure')

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

  it('rejects the removed shared-password auth endpoint', async () => {
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    })

    expect(res.status).toBe(401)
  })

  it('honors an explicit secure-cookie override', async () => {
    const { handler, baseUrl } = await createServer({ secureCookies: true, wsProtocol: 'ws', wsPort: 9100 })

    const res = await createSession(handler, baseUrl)

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('infers secure cookies from proxy https headers when no override is set', async () => {
    const { handler, baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const res = await createSession(handler, baseUrl, {
      'X-Forwarded-Proto': 'https',
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('derives a browser-facing websocket URL from forwarded public host headers', async () => {
    const { handler, baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await createSession(handler, baseUrl, {
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'polo.example.com:3100',
    })

    const configRes = await request(handler, baseUrl, '/api/config', {
      headers: {
        cookie: extractSessionCookie(authRes),
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'polo.example.com:3100',
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://polo.example.com:9100',
    })
  })

  it('returns an explicit public websocket URL override from /api/config', async () => {
    const { handler, baseUrl } = await createServer({
      publicWsUrl: 'wss://polo.example.com/ws',
      wsProtocol: 'wss',
      wsPort: 9100,
    })

    const authRes = await createSession(handler, baseUrl)

    const configRes = await request(handler, baseUrl, '/api/config', {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://polo.example.com/ws',
    })
  })
})
