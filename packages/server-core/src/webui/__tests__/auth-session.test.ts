import { afterEach, describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adminJwtStore, clearAdminJwtStore, validateSession } from '../auth'
import { createWebuiHandler } from '../http-server'

const HANDLER_SECRET = 'legacy-webui-secret'
const JWT_SECRET = 'admin-jwt-secret'
const OTHER_SECRET = 'other-jwt-secret'
const TEMP_DIRS: string[] = []
const HANDLERS: Array<{ dispose: () => void }> = []
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET
const ORIGINAL_SECURE_COOKIE = process.env.POLO_AI_WEBUI_SECURE_COOKIE

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    errorMessages: [] as string[],
    error(message: string) {
      this.errorMessages.push(message)
    },
    debug: () => {},
  }
}

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'polo-auth-session-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

function setEnv(name: 'JWT_SECRET' | 'POLO_AI_WEBUI_SECURE_COOKIE', value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function restoreEnv() {
  setEnv('JWT_SECRET', ORIGINAL_JWT_SECRET)
  setEnv('POLO_AI_WEBUI_SECURE_COOKIE', ORIGINAL_SECURE_COOKIE)
}

async function createServer(overrides?: {
  baseUrl?: string
  secureCookies?: boolean
  logger?: ReturnType<typeof createLogger>
}) {
  const logger = overrides?.logger ?? createLogger()
  const handler = createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: HANDLER_SECRET,
    secureCookies: overrides?.secureCookies,
    wsProtocol: 'wss',
    wsPort: 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger: logger as any,
  })

  HANDLERS.push(handler)

  return {
    handler,
    logger,
    baseUrl: overrides?.baseUrl ?? 'https://polo.example.com',
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

async function signAdminJwt(overrides?: {
  secret?: string
  sub?: string
  username?: string
  role?: string
  exp?: number
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const key = new TextEncoder().encode(overrides?.secret ?? JWT_SECRET)

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

function cookiePair(res: Response): string {
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

describe('POST /auth/session', () => {
  it('accepts a valid Admin-signed JWT, sets a session cookie, returns the user, and stores the JWT', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()
    const token = await signAdminJwt({ sub: 'user-abc', username: 'alice', role: 'admin' })

    const res = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: 'user-abc', username: 'alice', role: 'admin' },
    })
    expect(res.headers.get('set-cookie')).toContain(`polo_ai_session=${token}`)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect(res.headers.get('set-cookie')).toContain('Secure')
    expect(res.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect(res.headers.get('set-cookie')).toContain('Path=/')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=86400')
    expect(adminJwtStore.get('user-abc')).toBe(token)
  })

  it('omits the Secure cookie flag when secure cookies are disabled', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    setEnv('POLO_AI_WEBUI_SECURE_COOKIE', 'false')
    const { handler, baseUrl } = await createServer({ secureCookies: true })
    const token = await signAdminJwt()

    const res = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).not.toContain('Secure')
  })

  it('omits the Secure cookie flag for localhost requests', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer({ baseUrl: 'https://localhost:3100' })
    const token = await signAdminJwt()

    const res = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).not.toContain('Secure')
  })

  it('rejects missing and empty tokens', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()

    for (const body of [{}, { token: '' }]) {
      const res = await request(handler, baseUrl, '/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: 'validation_error',
        message: 'token field required',
      })
    }
  })

  it('rejects malformed, differently signed, tampered, and expired JWTs', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()
    const validToken = await signAdminJwt()
    const parts = validToken.split('.')
    const tamperedToken = [
      parts[0],
      Buffer.from(JSON.stringify({ sub: 'attacker', username: 'alice', role: 'admin' })).toString('base64url'),
      parts[2],
    ].join('.')
    const invalidTokens = [
      'not.a.jwt',
      await signAdminJwt({ secret: OTHER_SECRET }),
      tamperedToken,
      await signAdminJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    ]

    for (const token of invalidTokens) {
      const res = await request(handler, baseUrl, '/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'invalid_token' })
    }
  })

  it('returns a server configuration error when JWT_SECRET is missing', async () => {
    setEnv('JWT_SECRET', undefined)
    const logger = createLogger()
    const { handler, baseUrl } = await createServer({ logger })
    const token = await signAdminJwt()

    const res = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'server_configuration_error' })
    expect(logger.errorMessages.join('\n')).toContain('JWT_SECRET')
  })
})

describe('GET /auth/me', () => {
  it('returns the current user for a valid session cookie', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()
    const token = await signAdminJwt({ sub: 'user-abc', username: 'alice', role: 'admin' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    const res = await request(handler, baseUrl, '/auth/me', {
      headers: { cookie: cookiePair(sessionRes) },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: 'user-abc', username: 'alice', role: 'admin' },
    })
  })

  it('rejects missing and expired session cookies', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()
    const expiredToken = await signAdminJwt({ exp: Math.floor(Date.now() / 1000) - 60 })

    for (const init of [undefined, { headers: { cookie: `polo_ai_session=${expiredToken}` } }]) {
      const res = await request(handler, baseUrl, '/auth/me', init)

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'session_expired' })
    }
  })
})

describe('Admin JWT session compatibility', () => {
  it('allows protected config and SPA static access with an Admin JWT session cookie', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()
    const token = await signAdminJwt({ sub: 'user-abc', username: 'alice', role: 'admin' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const cookie = cookiePair(sessionRes)

    const configRes = await request(handler, baseUrl, '/api/config', {
      headers: { cookie },
    })
    const spaRes = await request(handler, baseUrl, '/', {
      headers: { cookie, accept: 'text/html' },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://127.0.0.1:9100',
    })
    expect(spaRes.status).toBe(200)
    expect(await spaRes.text()).toContain('app')
  })

  it('lets the shared session validator accept Admin JWT cookies for WebSocket upgrade auth', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const token = await signAdminJwt({ sub: 'user-abc', username: 'alice', role: 'admin' })

    const session = await validateSession(`polo_ai_session=${token}`, HANDLER_SECRET, {
      adminJwtSecret: JWT_SECRET,
    })

    expect(session).toEqual({
      sub: 'user-abc',
      username: 'alice',
      role: 'admin',
      iat: expect.any(Number),
      exp: expect.any(Number),
    })
  })
})

describe('POST /auth/logout', () => {
  it('clears the cookie and removes the stored JWT for a valid session', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()
    const token = await signAdminJwt({ sub: 'user-abc' })
    const sessionRes = await request(handler, baseUrl, '/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(adminJwtStore.get('user-abc')).toBe(token)

    const res = await request(handler, baseUrl, '/auth/logout', {
      method: 'POST',
      headers: { cookie: cookiePair(sessionRes) },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(res.headers.get('set-cookie')).toContain('polo_ai_session=')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect(res.headers.get('set-cookie')).toContain('Secure')
    expect(res.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect(res.headers.get('set-cookie')).toContain('Path=/')
    expect(adminJwtStore.has('user-abc')).toBe(false)
  })

  it('is idempotent without a session cookie', async () => {
    setEnv('JWT_SECRET', JWT_SECRET)
    const { handler, baseUrl } = await createServer()

    const res = await request(handler, baseUrl, '/auth/logout', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})
