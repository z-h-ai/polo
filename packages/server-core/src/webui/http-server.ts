/**
 * Web UI HTTP handler and standalone server.
 *
 * The core logic lives in `createWebuiHandler()` which returns a web-standard
 * fetch handler `(Request) => Promise<Response>`. This handler can be:
 *
 * 1. **Embedded** — attached to the WsRpcServer's HTTPS server via the
 *    node-adapter so that HTTP and WSS share a single port.
 * 2. **Standalone** — wrapped in `Bun.serve()` via `startWebuiHttpServer()`
 *    for separate-port deployments or development.
 */

import { join, extname } from 'node:path'
import {
  validateSession,
  buildSessionCookie,
  buildLogoutCookie,
  verifyAdminJwt,
  userFromAdminJwt,
  storeAdminJwt,
  removeAdminJwtFromToken,
  sweepExpiredAdminJwtStore,
  extractSessionCookie,
  validateAdminBearerAuth,
  isPlatformMode,
  adminJwtStore,
} from './auth'
import type { PlatformServices } from '../runtime/platform'

// ---------------------------------------------------------------------------
// MIME types for static file serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.map': 'application/json',
}

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

async function readJsonOrDefault(response: Response, fallback: unknown): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return fallback
  }
}

function getForwardedValue(req: Request, key: 'proto' | 'host'): string | null {
  const forwarded = req.headers.get('forwarded')
  if (!forwarded) return null

  const match = forwarded.match(new RegExp(`${key}="?([^;,"]+)"?`, 'i'))
  return match?.[1]?.trim() || null
}

function getRequestProto(req: Request): string {
  return req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'proto')
    || new URL(req.url).protocol.replace(/:$/, '')
}

function getRequestHost(req: Request): string | null {
  return req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'host')
    || req.headers.get('host')
}

function getRequestHostname(req: Request): string {
  const host = getRequestHost(req) || new URL(req.url).host
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return host.replace(/:\d+$/, '').toLowerCase()
  }
}

function formatHostWithPort(host: string, port: number): string {
  try {
    const parsed = new URL(`http://${host}`)
    const hostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname
    return `${hostname}:${port}`
  } catch {
    const withoutPort = host.replace(/:\d+$/, '')
    return `${withoutPort}:${port}`
  }
}

export function shouldUseSecureCookies(req: Request, secureCookies?: boolean): boolean {
  if (getRequestHostname(req) === 'localhost') return false
  if (secureCookies != null) return secureCookies
  return getRequestProto(req) === 'https'
}

export interface ResolveWebSocketUrlOptions {
  publicWsUrl?: string
  wsProtocol: 'ws' | 'wss'
  wsPort: number
}

export function resolveWebSocketUrl(
  req: Request,
  { publicWsUrl, wsProtocol, wsPort }: ResolveWebSocketUrlOptions,
): string {
  if (publicWsUrl) return publicWsUrl

  const host = getRequestHost(req)
  if (host) {
    return `${wsProtocol}://${formatHostWithPort(host, wsPort)}`
  }

  return `${wsProtocol}://127.0.0.1:${wsPort}`
}

// ---------------------------------------------------------------------------
// Handler options (shared between embedded and standalone modes)
// ---------------------------------------------------------------------------

export interface WebuiHandlerOptions {
  /** Path to built web UI dist/ directory. */
  webuiDir: string
  /** Legacy server secret. Retained only for compatibility with existing handler construction. */
  secret: string
  /** Explicit Secure-cookie override. When unset, infer from the request / proxy headers. */
  secureCookies?: boolean
  /** Optional browser-facing WebSocket URL override for reverse-proxy deployments. */
  publicWsUrl?: string
  /** RPC WebSocket protocol used when building a browser-facing fallback URL. */
  wsProtocol: 'ws' | 'wss'
  /** RPC WebSocket port used when building a browser-facing fallback URL. */
  wsPort: number
  /** Health check function (injected from existing server handler). */
  getHealthCheck: () => { status: string }
  /** Logger. */
  logger: PlatformServices['logger']
  /**
   * Trusted proxy IPs/CIDRs. When set, proxy headers (x-forwarded-for, x-forwarded-proto)
   * are only trusted from these sources. When empty/unset, proxy headers are ignored
   * and 'direct' is used as the rate-limit key.
   */
  trustedProxies?: string[]
}

// ---------------------------------------------------------------------------
// Handler factory — the core request handler
// ---------------------------------------------------------------------------

export interface WebuiHandler {
  /** Web-standard fetch handler. */
  fetch: (req: Request) => Promise<Response>
  /** Call on shutdown to release timers. */
  dispose: () => void
}

/**
 * Create a web-standard fetch handler for the WebUI.
 *
 * This handler can be used directly with `Bun.serve({ fetch })`,
 * or adapted for Node's HTTP server via `nodeHttpAdapter()`.
 */
export function createWebuiHandler(options: WebuiHandlerOptions): WebuiHandler {
  const {
    webuiDir,
    secret,
    secureCookies,
    publicWsUrl,
    wsProtocol,
    wsPort,
    getHealthCheck,
    logger,
    trustedProxies,
  } = options

  if (!process.env.JWT_SECRET) {
    logger.error('[webui] JWT_SECRET is not configured; /auth/session is disabled')
  }

  const cleanupTimer = setInterval(() => {
    sweepExpiredAdminJwtStore()
  }, 120_000)

  const trustedProxySet = new Set(trustedProxies ?? [])

  /** Extract client IP — only trusts proxy headers when trustedProxies is configured. */
  function getClientIp(req: Request): string {
    if (trustedProxySet.size > 0) {
      return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? req.headers.get('x-real-ip')
        ?? 'direct'
    }
    return 'direct'
  }

  async function authenticateWebuiRequest(req: Request): Promise<Response | { sub: string }> {
    const authorization = req.headers.get('authorization')
    if (authorization) {
      const bearer = await validateAdminBearerAuth(authorization)
      if (bearer.ok) {
        return { sub: bearer.user.id }
      }
      if (bearer.error === 'token_revoked') {
        return Response.json({ error: 'token_revoked' }, { status: 401 })
      }
      if (bearer.error === 'server_configuration_error') {
        logger.error('[webui] POLO_ADMIN_API_URL is required for Bearer auth')
        return Response.json({ error: 'server_configuration_error' }, { status: 500 })
      }
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const session = await validateSession(req.headers.get('cookie'), secret, {
      adminJwtSecret: process.env.JWT_SECRET,
    })
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    return { sub: session.sub }
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const useSecureCookies = shouldUseSecureCookies(req, secureCookies)

    // ── Health endpoint (no auth) ──
    if (path === '/health') {
      const health = getHealthCheck()
      return Response.json(health, {
        status: health.status === 'ok' ? 200 : 503,
      })
    }

    // ── Login page (no auth) ──
    if (path === '/login' || path === '/login/') {
      const loginFile = Bun.file(join(webuiDir, 'login.html'))
      if (await loginFile.exists()) {
        return new Response(loginFile, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
      return new Response('Login page not found', { status: 404 })
    }

    // ── Static assets that login page needs (no auth) ──
    if (path === '/favicon.ico' || path.startsWith('/login-assets/')) {
      const file = Bun.file(join(webuiDir, path))
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'Content-Type': getMimeType(path) },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    // ── Admin JWT session endpoint (no cookie auth) ──
    if (path === '/auth/session' && req.method === 'POST') {
      const jwtSecret = process.env.JWT_SECRET
      if (!jwtSecret) {
        logger.error('[webui] JWT_SECRET is required for /auth/session')
        return Response.json({ error: 'server_configuration_error' }, { status: 500 })
      }

      let body: { token?: unknown }
      try {
        body = await req.json() as { token?: unknown }
      } catch {
        return Response.json(
          { error: 'validation_error', message: 'token field required' },
          { status: 400 },
        )
      }

      if (typeof body.token !== 'string' || body.token.trim().length === 0) {
        return Response.json(
          { error: 'validation_error', message: 'token field required' },
          { status: 400 },
        )
      }

      const payload = await verifyAdminJwt(body.token, jwtSecret)
      if (!payload) {
        return Response.json({ error: 'invalid_token' }, { status: 401 })
      }

      const user = userFromAdminJwt(payload)
      storeAdminJwt(user.id, body.token, payload.exp)

      return Response.json({ user }, {
        status: 200,
        headers: {
          'Set-Cookie': buildSessionCookie(body.token, useSecureCookies),
        },
      })
    }

    // ── Platform login endpoint (no cookie auth) ──
    // Proxies credentials to Admin and stores the returned JWT in an HttpOnly
    // cookie. The browser receives only user metadata.
    if (path === '/auth/login' && req.method === 'POST') {
      const jwtSecret = process.env.JWT_SECRET
      const adminUrl = process.env.POLO_ADMIN_API_URL
      if (!jwtSecret || !adminUrl) {
        logger.error('[webui] JWT_SECRET and POLO_ADMIN_API_URL are required for /auth/login')
        return Response.json({ error: 'server_configuration_error' }, { status: 500 })
      }

      let body: { username?: unknown; password?: unknown }
      try {
        body = await req.json() as { username?: unknown; password?: unknown }
      } catch {
        return Response.json(
          { error: 'validation_error', message: 'username and password required' },
          { status: 400 },
        )
      }

      if (typeof body.username !== 'string' || typeof body.password !== 'string') {
        return Response.json(
          { error: 'validation_error', message: 'username and password required' },
          { status: 400 },
        )
      }

      let adminRes: Response
      try {
        adminRes = await globalThis.fetch(`${adminUrl.replace(/\/+$/, '')}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: body.username, password: body.password }),
        })
      } catch {
        return Response.json(
          { error: 'network_error', message: 'Admin service unavailable' },
          { status: 503 },
        )
      }

      const retryAfter = adminRes.headers.get('Retry-After')
      if (!adminRes.ok) {
        const errorBody = await readJsonOrDefault(adminRes, { error: 'login_failed' })
        const headers = retryAfter ? { 'Retry-After': retryAfter } : undefined
        return Response.json(errorBody, { status: adminRes.status, headers })
      }

      const loginBody = await readJsonOrDefault(adminRes, {}) as {
        token?: unknown
        user?: unknown
      }
      if (typeof loginBody.token !== 'string' || loginBody.token.trim().length === 0) {
        logger.error('[webui] Admin login response did not include a token')
        return Response.json({ error: 'admin_response_error' }, { status: 502 })
      }

      const payload = await verifyAdminJwt(loginBody.token, jwtSecret)
      if (!payload) {
        logger.error('[webui] Admin login returned an invalid JWT')
        return Response.json({ error: 'invalid_token' }, { status: 502 })
      }

      const user = userFromAdminJwt(payload)
      storeAdminJwt(user.id, loginBody.token, payload.exp)

      return Response.json({ user }, {
        status: 200,
        headers: {
          'Set-Cookie': buildSessionCookie(loginBody.token, useSecureCookies),
        },
      })
    }

    if (path === '/auth/me' && req.method === 'GET') {
      const jwtSecret = process.env.JWT_SECRET
      if (!jwtSecret) {
        logger.error('[webui] JWT_SECRET is required for /auth/me')
        return Response.json({ error: 'server_configuration_error' }, { status: 500 })
      }

      const token = extractSessionCookie(req.headers.get('cookie'))
      if (!token) {
        return Response.json({ error: 'session_expired' }, { status: 401 })
      }

      const payload = await verifyAdminJwt(token, jwtSecret)
      if (!payload) {
        removeAdminJwtFromToken(token)
        return Response.json({ error: 'session_expired' }, { status: 401 })
      }

      const user = userFromAdminJwt(payload)
      storeAdminJwt(user.id, token, payload.exp)
      return Response.json({ user }, { status: 200 })
    }

    if (path === '/auth/logout' && req.method === 'POST') {
      const token = extractSessionCookie(req.headers.get('cookie'))
      if (token) removeAdminJwtFromToken(token)

      return Response.json({ success: true }, {
        status: 200,
        headers: {
          'Set-Cookie': buildLogoutCookie(useSecureCookies),
        },
      })
    }

    // ── Public pre-login config endpoint (no auth) ──
    if (path === '/api/public-config' && req.method === 'GET') {
      try {
        return Response.json({
          adminUrl: process.env.POLO_ADMIN_API_URL || null,
          platformMode: isPlatformMode(),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        logger.error(`[webui] Public config failed: ${msg}`)
        return Response.json({ error: 'internal_error' }, { status: 500 })
      }
    }

    // ── Config endpoint (requires session cookie) ──
    if (path === '/api/config' && req.method === 'GET') {
      const configSession = await authenticateWebuiRequest(req)
      if (configSession instanceof Response) return configSession
      return Response.json({
        wsUrl: resolveWebSocketUrl(req, { publicWsUrl, wsProtocol, wsPort }),
      })
    }

    // Return the default workspace ID so the webui can include it in the WS handshake
    if (path === '/api/config/workspaces' && req.method === 'GET') {
      const configSession = await authenticateWebuiRequest(req)
      if (configSession instanceof Response) return configSession
      const { getActiveWorkspace } = await import('@polo-ai/shared/config/storage')
      const active = getActiveWorkspace()
      return Response.json({
        defaultWorkspaceId: active?.id ?? null,
      })
    }

    // ── Quota status proxy (requires Admin JWT session) ──
    // Proxies GET /api/quota/status to Admin API using the stored JWT from the user's session.
    if (path === '/api/quota/status' && req.method === 'GET') {
      const quotaSession = await authenticateWebuiRequest(req)
      if (quotaSession instanceof Response) return quotaSession

      // Retrieve the stored Admin JWT for this user.
      const userId = quotaSession.sub
      const storedJwt = adminJwtStore.get(userId)
      if (!storedJwt) {
        return Response.json({ error: 'session_expired' }, { status: 401 })
      }

      const adminApiUrl = process.env.POLO_ADMIN_API_URL
      if (!adminApiUrl) {
        logger.warn('[webui] POLO_ADMIN_API_URL not configured; quota proxy unavailable')
        return Response.json({ error: 'admin_not_configured' }, { status: 503 })
      }

      try {
        const adminRes = await globalThis.fetch(`${adminApiUrl.replace(/\/+$/, '')}/api/quota/status`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${storedJwt}`,
            'Content-Type': 'application/json',
          },
        })

        if (adminRes.status === 401) {
          return Response.json({ error: 'session_expired' }, { status: 401 })
        }

        // Forward the Admin response body and status to the browser
        const body = await adminRes.text()
        return new Response(body, {
          status: adminRes.status,
          headers: { 'Content-Type': adminRes.headers.get('Content-Type') ?? 'application/json' },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[webui] Quota proxy failed: ${msg}`)
        return Response.json({ error: 'admin_unreachable' }, { status: 502 })
      }
    }

    // ── Everything below requires a valid session cookie ──
    const session = await authenticateWebuiRequest(req)

    if (session instanceof Response) {
      const accept = req.headers.get('accept') ?? ''
      if (accept.includes('text/html') || path === '/' || path === '') {
        return Response.redirect('/login', 302)
      }
      return session
    }

    // ── Serve SPA static files ──
    if (path !== '/') {
      const file = Bun.file(join(webuiDir, path))
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'Content-Type': getMimeType(path) },
        })
      }
    }

    // SPA fallback — serve index.html for all non-file routes
    const indexFile = Bun.file(join(webuiDir, 'index.html'))
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('Not Found', { status: 404 })
  }

  return {
    fetch,
    dispose: () => clearInterval(cleanupTimer),
  }
}

// ---------------------------------------------------------------------------
// Standalone server (backwards-compatible, uses Bun.serve)
// ---------------------------------------------------------------------------

export interface WebuiHttpServerOptions extends WebuiHandlerOptions {
  /** Port to bind on. Use 0 for an ephemeral port in tests. */
  port: number
}

export async function startWebuiHttpServer(
  options: WebuiHttpServerOptions,
): Promise<{ port: number, stop: () => void }> {
  const { port, logger, ...handlerOpts } = options
  const handler = createWebuiHandler({ ...handlerOpts, logger })

  const server = Bun.serve({
    port,
    fetch: handler.fetch,
  })

  const boundPort = server.port ?? port
  logger.info(`[webui] Web UI server listening on http://0.0.0.0:${boundPort}`)

  return {
    port: boundPort,
    stop: () => {
      handler.dispose()
      server.stop()
    },
  }
}
