import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebuiHandler } from '../http-server'

const TEMP_DIRS: string[] = []
const HANDLERS: Array<{ dispose: () => void }> = []
const ORIGINAL_POLO_ADMIN_API_URL = process.env.POLO_ADMIN_API_URL
const ORIGINAL_CRAFT_WEBUI_PASSWORD = process.env.CRAFT_WEBUI_PASSWORD
const ORIGINAL_FETCH = globalThis.fetch

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
}

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'polo-bearer-auth-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

function createServer() {
  const handler = createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: 'legacy-shared-secret',
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

function setEnv(name: 'POLO_ADMIN_API_URL' | 'CRAFT_WEBUI_PASSWORD', value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function restoreEnv() {
  setEnv('POLO_ADMIN_API_URL', ORIGINAL_POLO_ADMIN_API_URL)
  setEnv('CRAFT_WEBUI_PASSWORD', ORIGINAL_CRAFT_WEBUI_PASSWORD)
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

afterEach(() => {
  restoreEnv()
  globalThis.fetch = ORIGINAL_FETCH
  mock.restore()

  while (HANDLERS.length > 0) {
    HANDLERS.pop()?.dispose()
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('WebUI Bearer Admin JWT auth', () => {
  it('allows protected HTTP requests with a valid Authorization Bearer JWT', async () => {
    setEnv('POLO_ADMIN_API_URL', 'https://admin.example.com')
    const validateFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://admin.example.com/api/auth/validate')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer valid.jwt.token')
      return jsonResponse({
        valid: true,
        user: {
          id: 'user-123',
          username: 'alice',
          displayName: 'Alice',
          role: 'admin',
          groupIds: [],
        },
        configVersion: 'cv_001',
      })
    })
    globalThis.fetch = validateFetch as unknown as typeof fetch

    const { handler, baseUrl } = createServer()
    const res = await request(handler, baseUrl, '/api/config', {
      headers: { Authorization: 'Bearer valid.jwt.token' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wsUrl: 'wss://127.0.0.1:9100' })
    expect(validateFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects missing, malformed, revoked, and legacy shared tokens', async () => {
    setEnv('POLO_ADMIN_API_URL', 'https://admin.example.com')
    const validateFetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization
      if (auth === 'Bearer revoked.jwt.token') {
        return jsonResponse({ error: 'token_revoked', message: 'revoked' }, { status: 401 })
      }
      return jsonResponse({ error: 'invalid_token' }, { status: 401 })
    })
    globalThis.fetch = validateFetch as unknown as typeof fetch

    const { handler, baseUrl } = createServer()

    const noHeader = await request(handler, baseUrl, '/api/config')
    expect(noHeader.status).toBe(401)
    expect(await noHeader.json()).toEqual({ error: 'Unauthorized' })

    const malformed = await request(handler, baseUrl, '/api/config', {
      headers: { Authorization: 'Bearer old-shared-token' },
    })
    expect(malformed.status).toBe(401)
    expect(await malformed.json()).toEqual({ error: 'Unauthorized' })

    const revoked = await request(handler, baseUrl, '/api/config', {
      headers: { Authorization: 'Bearer revoked.jwt.token' },
    })
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toEqual({ error: 'token_revoked' })

    const invalid = await request(handler, baseUrl, '/api/config', {
      headers: { Authorization: 'Bearer invalid.jwt.token' },
    })
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toEqual({ error: 'Unauthorized' })
  })

  it('does not allow the removed shared-password endpoint even when CRAFT_WEBUI_PASSWORD is set', async () => {
    setEnv('POLO_ADMIN_API_URL', 'https://admin.example.com')
    setEnv('CRAFT_WEBUI_PASSWORD', 'legacy-password')
    const { handler, baseUrl } = createServer()

    const res = await request(handler, baseUrl, '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'legacy-password' }),
    })

    expect(res.status).toBe(401)
  })
})
