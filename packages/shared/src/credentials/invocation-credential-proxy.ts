import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash, randomBytes } from 'node:crypto'
import { ManagedBillingObservation, newManagedHostRequestId, readManagedRequest, type ManagedBillingHooks, type ManagedBillingLease } from './managed-billing-observation'
import { parseProviderCorrelation } from '../admin/provider-observation'

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
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
])

const REDACTION = Buffer.from('[REDACTED]')

export interface InvocationCredentialHeader {
  name: string
  format: 'raw' | 'bearer'
}

export interface InvocationCredentialProxyTarget {
  upstreamBaseUrl: string
  /**
   * The only child request header locations in which the capability is
   * accepted. Credentials are replaced as a whole value, never as a substring.
   */
  credentialHeaders: readonly InvocationCredentialHeader[]
  /**
   * Generic providers keep their SDK-selected credential header and replace
   * the exact opaque capability value with this credential.
   */
  credential?: string
  /**
   * Providers with a fixed auth contract strip child credential headers and
   * inject these exact upstream headers.
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
  billing?: ManagedBillingHooks
  /**
   * Some provider SDKs parse non-secret routing claims from their auth value
   * before sending a request. Callers may supply an opaque, short-lived alias
   * with the required shape while keeping the real credential in the runtime.
   */
  capability?: string
}

function normalizeTarget(
  target: InvocationCredentialProxyTarget,
): InvocationCredentialProxyTarget {
  const upstream = new URL(target.upstreamBaseUrl)
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('Credential proxy upstream must use http or https')
  }
  const credentialHeaders = target.credentialHeaders.map((header) => {
    const name = header.name.trim().toLowerCase()
    if (!name || !CREDENTIAL_HEADERS.has(name)) {
      throw new Error(`Unsupported credential proxy header: ${header.name}`)
    }
    return { name, format: header.format }
  })
  if (credentialHeaders.length === 0) {
    throw new Error('Credential proxy requires at least one explicit credential header')
  }
  const headers = target.headers ? { ...target.headers } : undefined
  for (const name of Object.keys(headers ?? {})) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Unsupported upstream credential header: ${name}`)
    }
  }
  return {
    upstreamBaseUrl: upstream.toString(),
    credentialHeaders,
    credential: target.credential,
    headers,
  }
}

function formatCredential(header: InvocationCredentialHeader, value: string): string {
  return header.format === 'bearer' ? `Bearer ${value}` : value
}

function headerValues(request: IncomingMessage, name: string): string[] {
  const value = request.headers[name]
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value : []
}

function capabilityWasPresented(
  request: IncomingMessage,
  capability: string,
  credentialHeaders: readonly InvocationCredentialHeader[],
): boolean {
  return credentialHeaders.some((header) => {
    const expected = formatCredential(header, capability)
    return headerValues(request, header.name).some((value) => value === expected)
  })
}

function resolveUpstreamUrl(baseUrl: string, requestUrl: string): URL {
  const base = new URL(baseUrl)
  const incoming = new URL(requestUrl, 'http://127.0.0.1')
  const basePath = base.pathname.replace(/\/+$/, '')
  const incomingPath = incoming.pathname.startsWith('/')
    ? incoming.pathname
    : `/${incoming.pathname}`
  base.pathname =
    basePath
    && basePath !== '/'
    && !incomingPath.startsWith(`${basePath}/`)
    && incomingPath !== basePath
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
    if (
      HOP_BY_HOP_HEADERS.has(lowerName)
      || CREDENTIAL_HEADERS.has(lowerName)
      || lowerName === 'content-length'
      || lowerName === 'accept-encoding'
      || lowerName === 'x-polo-request-id'
    ) {
      continue
    }
    const values = Array.isArray(rawValue)
      ? rawValue
      : rawValue === undefined
        ? []
        : [rawValue]
    if (values.length > 0) headers[name] = values.join(', ')
  }

  if (target.credential) {
    for (const credentialHeader of target.credentialHeaders) {
      const expected = formatCredential(credentialHeader, capability)
      if (
        headerValues(request, credentialHeader.name).some(
          (value) => value === expected,
        )
      ) {
        headers[credentialHeader.name] = formatCredential(
          credentialHeader,
          target.credential,
        )
      }
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
  body?: Buffer,
  downstream?: ServerResponse,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
      upstreamUrl,
      { method: incoming.method, headers },
      resolve,
    )
    request.once('error', reject)
    const cancel = () => { if (!downstream?.writableEnded) request.destroy(new Error('Original downstream closed')) }
    downstream?.once('close', cancel)
    const downstreamSocket = incoming.socket
    downstreamSocket?.once('close', cancel)
    request.once('close', () => { downstream?.off('close', cancel); downstreamSocket?.off('close', cancel) })
    if (downstream?.destroyed) { cancel(); return }
    incoming.once('aborted', () => request.destroy())
    if (body) request.end(body)
    else incoming.pipe(request)
  })
}

function credentialSecrets(target: InvocationCredentialProxyTarget): Buffer[] {
  const secrets = new Set<string>()
  if (target.credential) secrets.add(target.credential)
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) continue
    secrets.add(value)
    const match = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)
    if (match?.[1]) secrets.add(match[1])
  }
  return [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((secret) => Buffer.from(secret))
}

function redactString(value: string, secrets: readonly Buffer[]): string {
  let redacted = value
  for (const secret of secrets) {
    redacted = redacted.split(secret.toString()).join(REDACTION.toString())
  }
  return redacted
}

class StreamingCredentialRedactor {
  private pending = Buffer.alloc(0)
  private readonly maxSecretLength: number

  constructor(private readonly secrets: readonly Buffer[]) {
    this.maxSecretLength = Math.max(0, ...secrets.map((secret) => secret.length))
  }

  transform(chunk: Buffer, final = false): Buffer {
    if (this.secrets.length === 0) return chunk
    this.pending = Buffer.concat([this.pending, chunk])
    const emitUntil = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.maxSecretLength + 1)
    if (emitUntil === 0) return Buffer.alloc(0)

    const output: Buffer[] = []
    let cursor = 0
    while (cursor < emitUntil) {
      let matchOffset = -1
      let matchSecret: Buffer | undefined
      for (const secret of this.secrets) {
        const offset = this.pending.indexOf(secret, cursor)
        if (offset < 0 || offset >= emitUntil) continue
        if (matchOffset < 0 || offset < matchOffset) {
          matchOffset = offset
          matchSecret = secret
        }
      }
      if (matchOffset < 0 || !matchSecret) {
        output.push(this.pending.subarray(cursor, emitUntil))
        cursor = emitUntil
        break
      }
      if (matchOffset > cursor) {
        output.push(this.pending.subarray(cursor, matchOffset))
      }
      output.push(REDACTION)
      cursor = matchOffset + matchSecret.length
    }
    this.pending = this.pending.subarray(cursor)
    return Buffer.concat(output)
  }
}

async function proxyResponse(
  upstream: IncomingMessage,
  response: ServerResponse,
  secrets: readonly Buffer[],
  observation?: ManagedBillingObservation,
  complete?: () => Promise<void>,
): Promise<void> {
  const contentEncoding = upstream.headers['content-encoding']
  if (
    secrets.length > 0
    && typeof contentEncoding === 'string'
    && contentEncoding.toLowerCase() !== 'identity'
  ) {
    upstream.resume()
    response.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
    })
    response.end('Credential proxy rejected an encoded upstream response')
    return
  }
  response.statusCode = upstream.statusCode || 502
  for (const [name, value] of Object.entries(upstream.headers)) {
    const lowerName = name.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(lowerName)
      || CREDENTIAL_HEADERS.has(lowerName)
      || lowerName === 'content-length'
      || lowerName === 'x-polo-request-id'
      || value === undefined
    ) {
      continue
    }
    response.setHeader(
      name,
      Array.isArray(value)
        ? value.map((item) => redactString(item, secrets))
        : redactString(value, secrets),
    )
  }

  const redactor = new StreamingCredentialRedactor(secrets)
  for await (const chunk of upstream) {
    if (response.destroyed) throw new Error('Original downstream closed')
    observation?.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const safe = redactor.transform(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    )
    if (safe.length > 0 && !response.write(safe)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed) }
        const drained = () => { cleanup(); resolve() }
        const closed = () => { cleanup(); reject(new Error('Original downstream closed')) }
        const failed = (error: Error) => { cleanup(); reject(error) }
        response.once('drain', drained); response.once('close', closed); response.once('error', failed)
        if (response.destroyed) closed()
      })
    }
  }
  const final = redactor.transform(Buffer.alloc(0), true)
  observation?.push(Buffer.alloc(0), true)
  await complete?.()
  if (final.length > 0) response.write(final)
  response.end()
}

export async function startInvocationCredentialProxy(
  initialTarget: InvocationCredentialProxyTarget,
  options: InvocationCredentialProxyOptions = {},
): Promise<InvocationCredentialProxy> {
  let target = normalizeTarget(initialTarget)
  const capability =
    options.capability || `polo-cap-${randomBytes(32).toString('base64url')}`
  if (capability.length < 32 || /[\r\n]/.test(capability)) {
    throw new Error(
      'Credential proxy capability must be an opaque value of at least 32 characters',
    )
  }
  let closed = false

  const server = createServer(async (request, response) => {
    let lease: ManagedBillingLease | undefined
    let observation: ManagedBillingObservation | undefined
    let completed = false
    let privateCorrelation: string | undefined
    const complete = async (ended: boolean) => {
      if (!lease || completed) return
      completed = true
      await lease.complete(observation?.result(ended) ?? { inputTokens: 0, outputTokens: 0, providerObservation: { version: 1, state: 'missing' }, outputDisposition: 'unknown', terminalReason: 'transport_not_observed' })
    }
    const targetSnapshot = normalizeTarget(target)
    if (
      closed
      || !capabilityWasPresented(
        request,
        capability,
        targetSnapshot.credentialHeaders,
      )
    ) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Unauthorized')
      return
    }
    try {
      const upstreamUrl = resolveUpstreamUrl(
        targetSnapshot.upstreamBaseUrl,
        request.url || '/',
      )
      let body: Buffer | undefined
      let requestedModel: string | undefined
      const headers = buildUpstreamHeaders(request, capability, targetSnapshot)
      if (options.billing) {
        const parsed = await readManagedRequest(request, upstreamUrl)
        body = parsed.body
        requestedModel = parsed.model
        if (!targetSnapshot.credential) throw new Error('Managed upstream credential is unavailable')
        lease = await options.billing.beforeSend({ model: parsed.model, hostRequestId: newManagedHostRequestId(), transportBaseUrl: targetSnapshot.upstreamBaseUrl.replace(/\/$/, ''), credentialFingerprint: createHash('sha256').update(targetSnapshot.credential).digest('hex') })
        const correlation = parseProviderCorrelation(lease.providerCorrelation)
        if (!correlation) throw new Error('Managed admission correlation is invalid')
        lease.assertCurrent()
        if (request.aborted || response.destroyed) throw new Error('Managed request was cancelled before send')
        headers[correlation.header] = correlation.nonce
        privateCorrelation = correlation.nonce
      }
      const upstream = await requestUpstream(
        upstreamUrl,
        request,
        headers,
        body,
        response,
      )
      if (lease) observation = new ManagedBillingObservation(upstream, requestedModel)
      // Disposing/cancelling the child stops original transport, without
      // losing its already-admitted receipt or automatically resending it.
      const abortUpstream = () => { if (!response.writableEnded) upstream.destroy() }
      response.once('close', abortUpstream)
      const secrets = [...credentialSecrets(targetSnapshot), ...(privateCorrelation ? [Buffer.from(privateCorrelation)] : [])]
      try { await proxyResponse(upstream, response, secrets, observation, () => complete(true)) }
      finally { response.off('close', abortUpstream); await complete(false) }
    } catch {
      await complete(false).catch(() => {})
      if (!response.headersSent) {
        response.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
        })
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
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections?.()
      })
    },
  }
}
