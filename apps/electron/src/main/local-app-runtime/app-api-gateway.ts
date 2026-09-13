import { createServer, type Server, type ServerResponse } from 'node:http'
import type {
  AppApiStableErrorCode,
} from '@polo-ai/shared/product-spaces'
import { LOCAL_APP_API_CONTRACT_VERSION } from '@polo-ai/shared/product-spaces'
import type { CapabilityRecord } from './app-api-capabilities'

export type AppApiRoute =
  | '/run/start'
  | '/ai/query'
  | '/run/finish'
  | '/result/report'
  | '/file/report'

const ROUTE_BODY_LIMITS: Record<AppApiRoute, number> = {
  '/run/start': 4 * 1024,
  '/run/finish': 4 * 1024,
  '/result/report': 64 * 1024,
  '/file/report': 64 * 1024,
  '/ai/query': 2 * 1024 * 1024,
}

export const APP_API_ERROR_STATUS: Record<AppApiStableErrorCode, number> = {
  invalid_request: 400,
  capability_invalid: 401,
  route_not_found: 404,
  method_not_allowed: 405,
  request_too_large: 413,
  unsupported_media_type: 415,
  request_in_progress: 409,
  idempotency_conflict: 409,
  run_state_conflict: 409,
  run_finalized: 409,
  insufficient_credit: 409,
  request_cancelled: 499,
  host_auth_failed: 502,
  host_failed: 502,
  host_configuration_unavailable: 503,
  metering_unconfirmed: 503,
  sink_unavailable: 503,
  shutting_down: 503,
  response_cache_full: 503,
  host_timed_out: 504,
  no_output: 200,
}

export interface AppApiGatewayDelegate {
  handle(
    route: AppApiRoute,
    body: Record<string, unknown>,
    capability: CapabilityRecord,
    signal: AbortSignal,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }>
}

export interface AppApiGatewayOptions {
  delegate: AppApiGatewayDelegate
  verifyToken: (token: unknown, now: number) => CapabilityRecord | null
  now?: () => number
}

/**
 * Single Electron-owned 127.0.0.1 loopback gateway for local-app-api.v1.
 * Owns only transport hardening and stable error mapping — never business
 * state. Fails closed: until `start()` resolves, no platform boundary exists
 * and no App process may be spawned against it.
 */
export class AppApiGateway {
  private server?: Server
  private port?: number
  private closed = false

  constructor(private readonly options: AppApiGatewayOptions) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/local-app-api/v1`
  }

  get boundPort(): number | undefined {
    return this.port
  }

  /** Binds IPv4 127.0.0.1 on an ephemeral port only. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve()
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) {
          this.sendError(response, 'host_failed')
        } else {
          response.destroy()
        }
      })
    })
    this.server = server
    server.on('error', () => {
      this.server = undefined
      this.port = undefined
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('gateway did not receive a TCP port'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const server = this.server
    this.server = undefined
    this.port = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }

  private async handle(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    const fail = (code: AppApiStableErrorCode, hard = false) => {
      if (hard) {
        this.sendError(response, code)
        response.once('finish', () => request.destroy())
        if (response.writableEnded) request.destroy()
        return
      }
      this.sendError(response, code)
    }
    if (this.closed || !this.port) return fail('shutting_down')
    if (request.headers.origin !== undefined) return fail('invalid_request')
    if (request.method !== 'POST') return fail('method_not_allowed')
    if (request.headers.host !== `127.0.0.1:${this.port}`) return fail('invalid_request')
    const rawUrl = request.url ?? '/'
    if (rawUrl.includes('?') || rawUrl.includes('#')) return fail('invalid_request')
    const contractPrefix = '/local-app-api/v1'
    let pathname: string
    try {
      pathname = new URL(rawUrl, 'http://127.0.0.1').pathname
    } catch {
      return fail('invalid_request')
    }
    if (!pathname.startsWith(contractPrefix)) return fail('route_not_found')
    const route = pathname.slice(contractPrefix.length).replace(/\/+$/, '') as AppApiRoute
    const limit = ROUTE_BODY_LIMITS[route]
    if (limit === undefined) return fail('route_not_found')
    const authorization = request.headers.authorization
    if (Array.isArray(authorization)) return fail('invalid_request')
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      return fail('capability_invalid')
    }
    const capability = this.options.verifyToken(
      authorization.slice('Bearer '.length),
      (this.options.now ?? Date.now)(),
    )
    if (!capability) return fail('capability_invalid')
    const contentType = request.headers['content-type']
    if (
      contentType !== 'application/json'
      && contentType !== 'application/json; charset=utf-8'
    ) {
      return fail('unsupported_media_type')
    }
    const body = await this.readBody(request, limit)
    if (body === null) return fail('request_too_large', true)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return fail('invalid_request')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid_request')
    }
    const controller = new AbortController()
    request.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    const outcome = await this.options.delegate.handle(
      route,
      parsed as Record<string, unknown>,
      capability,
      controller.signal,
    )
    if (outcome.errorCode !== undefined) {
      this.sendError(response, outcome.errorCode)
      return
    }
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({
      contractVersion: LOCAL_APP_API_CONTRACT_VERSION,
      ok: true,
      data: outcome.data ?? null,
    }))
  }

  private readBody(request: import('node:http').IncomingMessage, limit: number): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const settle = (value: string | null) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          // Stop buffering immediately; drain the remainder so the hardened
          // 413 response can still be delivered before the socket dies.
          request.removeAllListeners('data')
          request.resume()
          settle(null)
          return
        }
        chunks.push(chunk)
      })
      request.once('end', () => settle(Buffer.concat(chunks).toString('utf8')))
      request.once('error', () => settle(null))
    })
  }

  private sendError(response: ServerResponse, code: AppApiStableErrorCode): void {
    if (response.headersSent || response.writableEnded || response.destroyed) return
    response.statusCode = APP_API_ERROR_STATUS[code]
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({
      contractVersion: LOCAL_APP_API_CONTRACT_VERSION,
      ok: false,
      error: { code },
    }))
  }
}
