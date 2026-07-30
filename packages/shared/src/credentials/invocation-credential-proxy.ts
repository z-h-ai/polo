import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
])

export interface InvocationCredentialProxyTarget {
  upstreamBaseUrl: string
  /**
   * Generic providers keep their SDK-selected credential header and replace
   * the opaque capability with this value.
   */
  credential?: string
  /**
   * Providers with a fixed auth contract can strip every child credential
   * header and inject the exact upstream headers here.
   */
  headers?: Record<string, string>
}

export interface InvocationCredentialProxy {
  readonly url: string
  readonly capability: string
  updateTarget(target: InvocationCredentialProxyTarget): void
  close(): Promise<void>
}

export interface InvocationCredentialProxyOptions {
  /**
   * Some provider SDKs parse non-secret routing claims from their auth value
   * before sending a request. Callers may supply an opaque, short-lived alias
   * with the required shape while keeping the real credential in the runtime.
   */
  capability?: string
}

function normalizeTarget(target: InvocationCredentialProxyTarget): InvocationCredentialProxyTarget {
  const upstream = new URL(target.upstreamBaseUrl)
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('Credential proxy upstream must use http or https')
  }
  return {
    upstreamBaseUrl: upstream.toString(),
    credential: target.credential,
    headers: target.headers ? { ...target.headers } : undefined,
  }
}

function capabilityWasPresented(request: IncomingMessage, capability: string): boolean {
  return Object.values(request.headers).some(value => {
    if (Array.isArray(value)) return value.some(item => item.includes(capability))
    return typeof value === 'string' && value.includes(capability)
  })
}

function resolveUpstreamUrl(baseUrl: string, requestUrl: string): URL {
  const base = new URL(baseUrl)
  const incoming = new URL(requestUrl, 'http://127.0.0.1')
  const basePath = base.pathname.replace(/\/+$/, '')
  const incomingPath = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`
  base.pathname = basePath && basePath !== '/' && !incomingPath.startsWith(`${basePath}/`) && incomingPath !== basePath
    ? `${basePath}${incomingPath}`
    : incomingPath
  base.search = incoming.search
  base.hash = ''
  return base
}

function buildUpstreamHeaders(
  request: IncomingMessage,
  capability: string,
  target: InvocationCredentialProxyTarget,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName)) continue
    const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue]
    for (const raw of values) {
      if (target.headers && CREDENTIAL_HEADERS.has(lowerName)) continue
      let value = raw
      if (!raw.includes(capability)) {
        value = raw
      } else if (target.credential) {
        value = raw.split(capability).join(target.credential)
      } else {
        continue
      }
      const previous = headers[name]
      headers[name] = previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous.map(String), value]
          : [String(previous), value]
    }
  }
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing]
    }
    headers[name] = value
  }
  return headers
}

function requestUpstream(
  upstreamUrl: URL,
  incoming: IncomingMessage,
  headers: OutgoingHttpHeaders,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
      upstreamUrl,
      { method: incoming.method, headers },
      resolve,
    )
    request.once('error', reject)
    incoming.once('aborted', () => request.destroy())
    incoming.pipe(request)
  })
}

async function proxyResponse(upstream: IncomingMessage, response: ServerResponse): Promise<void> {
  const headers: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value
    }
  }
  response.writeHead(upstream.statusCode || 502, headers)
  for await (const chunk of upstream) {
    if (!response.write(chunk)) {
      await new Promise<void>(resolve => response.once('drain', resolve))
    }
  }
  response.end()
}

export async function startInvocationCredentialProxy(
  initialTarget: InvocationCredentialProxyTarget,
  options: InvocationCredentialProxyOptions = {},
): Promise<InvocationCredentialProxy> {
  let target = normalizeTarget(initialTarget)
  const capability = options.capability || `polo-cap-${randomBytes(32).toString('base64url')}`
  if (capability.length < 32 || /[\r\n]/.test(capability)) {
    throw new Error('Credential proxy capability must be an opaque value of at least 32 characters')
  }
  let closed = false

  const server = createServer(async (request, response) => {
    if (
      closed
      || !capabilityWasPresented(request, capability)
    ) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Unauthorized')
      return
    }
    try {
      const upstreamUrl = resolveUpstreamUrl(target.upstreamBaseUrl, request.url || '/')
      const upstream = await requestUpstream(
        upstreamUrl,
        request,
        buildUpstreamHeaders(request, capability, target),
      )
      await proxyResponse(upstream, response)
    } catch {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      response.end('Credential proxy upstream request failed')
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Credential proxy did not bind a loopback TCP port')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    capability,
    updateTarget(nextTarget) {
      if (closed) throw new Error('Credential proxy is closed')
      target = normalizeTarget(nextTarget)
    },
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
