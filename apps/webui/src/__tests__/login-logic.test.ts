/**
 * Unit tests for login page logic.
 *
 * Tests the login flow functions in isolation using mocked fetch responses.
 * Covers AC1-AC4 of the login page acceptance criteria.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  checkExistingSession,
  fetchPublicConfig,
  performPlatformLogin,
  fetchPostLoginConfig,
  type LoginError,
} from '../login-logic'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>

function mockFetch(handler: FetchMock) {
  return spyOn(globalThis, 'fetch').mockImplementation(handler as typeof fetch)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// checkExistingSession
// ---------------------------------------------------------------------------

describe('checkExistingSession', () => {
  it('returns { authenticated: true } when /auth/me returns 200', async () => {
    mockFetch(async (url) => {
      expect(url).toBe('/auth/me')
      return jsonResponse({ user: { id: 'u1', username: 'alice', role: 'user' } })
    })

    const result = await checkExistingSession()
    expect(result).toEqual({ authenticated: true })
  })

  it('returns { authenticated: false } when /auth/me returns 401', async () => {
    mockFetch(async () => jsonResponse({ error: 'session_expired' }, 401))

    const result = await checkExistingSession()
    expect(result).toEqual({ authenticated: false })
  })

  it('returns { authenticated: false } on network error', async () => {
    mockFetch(async () => { throw new Error('Network failure') })

    const result = await checkExistingSession()
    expect(result).toEqual({ authenticated: false })
  })
})

// ---------------------------------------------------------------------------
// fetchPublicConfig
// ---------------------------------------------------------------------------

describe('fetchPublicConfig', () => {
  it('returns adminUrl and platformMode from /api/public-config', async () => {
    mockFetch(async (url) => {
      expect(url).toBe('/api/public-config')
      return jsonResponse({ adminUrl: 'http://admin.example.com', platformMode: true })
    })

    const result = await fetchPublicConfig()
    expect(result).toEqual({ adminUrl: 'http://admin.example.com', platformMode: true })
  })

  it('returns null adminUrl and false platformMode when server returns them as null/false', async () => {
    mockFetch(async () => jsonResponse({ adminUrl: null, platformMode: false }))

    const result = await fetchPublicConfig()
    expect(result).toEqual({ adminUrl: null, platformMode: false })
  })

  it('throws on network error', async () => {
    mockFetch(async () => { throw new Error('Network failure') })

    await expect(fetchPublicConfig()).rejects.toThrow('Service temporarily unavailable')
  })

  it('throws on non-OK response', async () => {
    mockFetch(async () => new Response('Internal error', { status: 500 }))

    await expect(fetchPublicConfig()).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// performPlatformLogin
// ---------------------------------------------------------------------------

describe('performPlatformLogin', () => {
  it('posts credentials to /auth/login and returns user without exposing a token', async () => {
    mockFetch(async (url, init) => {
      expect(url).toBe('/auth/login')
      expect((init as RequestInit).method).toBe('POST')
      expect((init as RequestInit).credentials).toBe('same-origin')
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body).toEqual({ username: 'alice', password: 'secret' })
      return jsonResponse({ user: { id: 'u1', username: 'alice', role: 'admin' } })
    })

    const result = await performPlatformLogin('alice', 'secret')
    expect(result).toEqual({ user: { id: 'u1', username: 'alice', role: 'admin' } })
    expect('token' in result).toBe(false)
  })

  it('throws LoginError with code invalid_credentials on 401', async () => {
    mockFetch(async () => jsonResponse({ error: 'invalid_credentials' }, 401))

    const err = await performPlatformLogin('alice', 'wrong')
      .catch(e => e) as LoginError
    expect(err.code).toBe('invalid_credentials')
    expect(err.message).toBe('用户名或密码错误')
  })

  it('throws LoginError with code account_disabled on 403', async () => {
    mockFetch(async () => jsonResponse({ error: 'account_disabled' }, 403))

    const err = await performPlatformLogin('alice', 'pw')
      .catch(e => e) as LoginError
    expect(err.code).toBe('account_disabled')
    expect(err.message).toBe('账号已被禁用，请联系管理员')
  })

  it('throws LoginError with code rate_limited and retryAfterSeconds on 429', async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    }))

    const err = await performPlatformLogin('alice', 'pw')
      .catch(e => e) as LoginError
    expect(err.code).toBe('rate_limited')
    expect(err.retryAfterSeconds).toBe(30)
    expect(err.message).toBe('请 30 秒后再试')
  })

  it('throws LoginError with code network_error on fetch failure', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED') })

    const err = await performPlatformLogin('alice', 'pw')
      .catch(e => e) as LoginError
    expect(err.code).toBe('network_error')
    expect(err.message).toBe('无法连接服务器，请检查网络连接')
  })
})

// ---------------------------------------------------------------------------
// fetchPostLoginConfig
// ---------------------------------------------------------------------------

describe('fetchPostLoginConfig', () => {
  it('returns wsUrl from /api/config after successful session', async () => {
    mockFetch(async (url) => {
      expect(url).toBe('/api/config')
      return jsonResponse({ wsUrl: 'wss://polo.example.com/ws' })
    })

    const result = await fetchPostLoginConfig()
    expect(result).toEqual({ wsUrl: 'wss://polo.example.com/ws' })
  })

  it('throws on network error', async () => {
    mockFetch(async () => { throw new Error('Network failure') })

    await expect(fetchPostLoginConfig()).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Redirect URL preservation (AC4)
// ---------------------------------------------------------------------------

describe('redirect URL handling', () => {
  it('extractRedirectUrl extracts redirect param from URL', async () => {
    const { extractRedirectUrl } = await import('../login-logic')
    const url = new URL('http://polo.example.com/login?redirect=%2Fworkspace%2F123')
    expect(extractRedirectUrl(url)).toBe('/workspace/123')
  })

  it('extractRedirectUrl returns "/" when no redirect param', async () => {
    const { extractRedirectUrl } = await import('../login-logic')
    const url = new URL('http://polo.example.com/login')
    expect(extractRedirectUrl(url)).toBe('/')
  })

  it('extractRedirectUrl returns "/" for empty redirect param', async () => {
    const { extractRedirectUrl } = await import('../login-logic')
    const url = new URL('http://polo.example.com/login?redirect=')
    expect(extractRedirectUrl(url)).toBe('/')
  })
})
