/**
 * Tests for GET /api/quota/status proxy endpoint.
 *
 * AC6: Server-side proxy endpoint
 * - Polo AI server exposes GET /api/quota/status (authenticated by polo_ai_session cookie)
 * - Server extracts userId from cookie JWT, looks up stored JWT from in-memory map
 * - Server forwards to Admin GET /api/quota/status with Authorization: Bearer <stored-jwt>
 * - Server returns Admin response to browser (or error if Admin unreachable)
 * - 401 from Admin → server returns 401 to browser (session expired)
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebuiHandler } from '../http-server'
import { adminJwtStore, clearAdminJwtStore } from '../auth'

const HANDLER_SECRET = 'legacy-webui-secret'
const JWT_SECRET = 'admin-jwt-secret'
const TEMP_DIRS: string[] = []
const HANDLERS: Array<{ dispose: () => void }> = []
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET
const ORIGINAL_ADMIN_API_URL = process.env.ADMIN_API_URL

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'polo-quota-proxy-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

function setEnv(name: 'JWT_SECRET' | 'ADMIN_API_URL', value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function restoreEnv() {
  setEnv('JWT_SECRET', ORIGINAL_JWT_SECRET)
  setEnv('ADMIN_API_URL', ORIGINAL_ADMIN_API_URL)
}

async function signAdminJwt(overrides?: {
  sub?: string
  username?: string
  role?: string
  exp?: number
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const key = new TextEncoder().encode(JWT_SECRET)
  return new SignJWT({
    username: overrides?.username ?? 'alice',
    role: overrides?.role ?? 'user',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(overrides?.sub ?? 'user-123')
    .setIssuedAt(now)
    .setExpirationTime(overrides?.exp ?? now + 3600)
    .sign(key)
}

async function createServer() {
  const handler = createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: HANDLER_SECRET,
    wsProtocol: 'wss',
    wsPort: 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger,
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

const SAMPLE_QUOTA_STATUS = {
  userId: 'user-123',
  period: '2026-06',
  limit: 1_000_000,
  used: 154_000,
  remaining: 846_000,
  usageBreakdown: [{ model: 'claude-3-5-sonnet', tokens: 154_000 }],
}

describe('GET /api/quota/status', () => {
  it('returns 401 when no session cookie is provided', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('ADMIN_API_URL', 'http://admin.example.com')
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/api/quota/status')

    expect(res.status).toBe(401)
  })

  it('returns 401 when legacy password session is used (no stored Admin JWT)', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('ADMIN_API_URL', 'http://admin.example.com')
    const { handler, baseUrl } = await createServer()

    // Use a legacy password-based session (via /api/auth) — these sessions have
    // sub='webui' and no stored Admin JWT in adminJwtStore.
    const authRes = await request(handler, baseUrl, '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: HANDLER_SECRET }),
    })
    const setCookie = authRes.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    const cookie = setCookie!.split(';')[0]!

    const res = await request(handler, baseUrl, '/api/quota/status', {
      headers: { cookie },
    })

    expect(res.status).toBe(401)
  })

  it('proxies to Admin GET /api/quota/status with the stored JWT as Bearer token', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('ADMIN_API_URL', 'http://admin.example.com')
    const { handler, baseUrl } = await createServer()

    // Set up session: POST /auth/session to store JWT
    const adminToken = await signAdminJwt({ sub: 'user-123' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    })
    const cookie = sessionRes.headers.get('set-cookie')!.split(';')[0]!

    // Verify stored JWT is set
    expect(adminJwtStore.get('user-123')).toBe(adminToken)

    // Track the outgoing request to Admin
    let capturedRequest: Request | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = new Request(input as string, init)
      return new Response(JSON.stringify(SAMPLE_QUOTA_STATUS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    try {
      const res = await request(handler, baseUrl, '/api/quota/status', {
        headers: { cookie },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(SAMPLE_QUOTA_STATUS)

      // Verify the outgoing request was correctly formed
      expect(capturedRequest).toBeDefined()
      expect(capturedRequest!.url).toBe('http://admin.example.com/api/quota/status')
      expect(capturedRequest!.headers.get('authorization')).toBe(`Bearer ${adminToken}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns 401 to browser when Admin returns 401 (JWT expired)', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('ADMIN_API_URL', 'http://admin.example.com')
    const { handler, baseUrl } = await createServer()

    const adminToken = await signAdminJwt({ sub: 'user-123' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    })
    const cookie = sessionRes.headers.get('set-cookie')!.split(';')[0]!

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    try {
      const res = await request(handler, baseUrl, '/api/quota/status', {
        headers: { cookie },
      })
      expect(res.status).toBe(401)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns 503 when ADMIN_API_URL is not set', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('ADMIN_API_URL', undefined)
    const { handler, baseUrl } = await createServer()

    const adminToken = await signAdminJwt({ sub: 'user-123' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    })
    const cookie = sessionRes.headers.get('set-cookie')!.split(';')[0]!

    const res = await request(handler, baseUrl, '/api/quota/status', {
      headers: { cookie },
    })

    expect(res.status).toBe(503)
  })

  it('returns 502 when Admin is unreachable (network error)', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('ADMIN_API_URL', 'http://admin.example.com')
    const { handler, baseUrl } = await createServer()

    const adminToken = await signAdminJwt({ sub: 'user-123' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    })
    const cookie = sessionRes.headers.get('set-cookie')!.split(';')[0]!

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED')
    }

    try {
      const res = await request(handler, baseUrl, '/api/quota/status', {
        headers: { cookie },
      })
      expect(res.status).toBe(502)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forwards non-401 Admin error status to browser', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('ADMIN_API_URL', 'http://admin.example.com')
    const { handler, baseUrl } = await createServer()

    const adminToken = await signAdminJwt({ sub: 'user-123' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    })
    const cookie = sessionRes.headers.get('set-cookie')!.split(';')[0]!

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response('Internal Server Error', { status: 500 })
    }

    try {
      const res = await request(handler, baseUrl, '/api/quota/status', {
        headers: { cookie },
      })
      expect(res.status).toBe(500)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
