import { afterEach, describe, expect, it } from 'bun:test'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  startInvocationCredentialProxy,
  type InvocationCredentialProxy,
} from '../invocation-credential-proxy.ts'

const proxies: InvocationCredentialProxy[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('upstream did not bind')
  return `http://127.0.0.1:${address.port}/v1`
}

async function requestProxy(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf-8'),
        headers: response.headers,
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

describe('invocation credential proxy', () => {
  it('keeps the real credential in the runtime and injects it upstream', async () => {
    const realSecret = 'sk-real-runtime-only-secret'
    let upstreamAuthorization = ''
    let upstreamPath = ''
    const upstream = await startUpstream((request, response) => {
      upstreamAuthorization = String(request.headers.authorization || '')
      upstreamPath = request.url || ''
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n')
      response.end('data: done\n\n')
    })
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      headers: { Authorization: `Bearer ${realSecret}` },
      credentialHeaders: [{ name: 'x-api-key', format: 'raw' }],
    })
    proxies.push(proxy)

    expect(proxy.capability).not.toContain(realSecret)
    const response = await requestProxy(
      `${proxy.url}/messages?stream=true`,
      { 'x-api-key': proxy.capability },
    )

    expect(response.status).toBe(200)
    expect(response.body).toBe('data: first\n\ndata: done\n\n')
    expect(upstreamAuthorization).toBe(`Bearer ${realSecret}`)
    expect(upstreamPath).toBe('/v1/messages?stream=true')
  })

  it('rejects callers without the opaque capability', async () => {
    const upstream = await startUpstream((_request, response) => response.end('unexpected'))
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      credential: 'real-secret',
      credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
    })
    proxies.push(proxy)

    const response = await requestProxy(`${proxy.url}/messages`)
    expect(response.status).toBe(401)
  })

  it('replaces provider-selected credential headers without exposing the secret', async () => {
    let upstreamKey = ''
    const upstream = await startUpstream((request, response) => {
      upstreamKey = String(request.headers['x-goog-api-key'] || '')
      response.end('ok')
    })
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      credential: 'google-real-secret',
      credentialHeaders: [{ name: 'x-goog-api-key', format: 'raw' }],
    })
    proxies.push(proxy)

    const response = await requestProxy(
      `${proxy.url}/models`,
      { 'x-goog-api-key': proxy.capability },
    )
    expect(response.body).toBe('ok')
    expect(upstreamKey).toBe('google-real-secret')
  })

  it('supports provider-shaped opaque capabilities without forwarding them upstream', async () => {
    const shapedCapability = [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from('{"routing_claim":"local-only"}').toString('base64url'),
      crypto.randomUUID().replaceAll('-', ''),
    ].join('.')
    let upstreamAuthorization = ''
    const upstream = await startUpstream((request, response) => {
      upstreamAuthorization = String(request.headers.authorization || '')
      response.end('ok')
    })
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      credential: 'real-provider-token',
      credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
    }, {
      capability: shapedCapability,
    })
    proxies.push(proxy)

    const response = await requestProxy(`${proxy.url}/models`, {
      Authorization: `Bearer ${shapedCapability}`,
    })
    expect(response.status).toBe(200)
    expect(upstreamAuthorization).toBe('Bearer real-provider-token')
    expect(upstreamAuthorization).not.toContain(shapedCapability)
  })

  it('rejects capability substrings outside the dedicated exact credential header', async () => {
    let upstreamRequests = 0
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests++
      response.end('unexpected')
    })
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      credential: 'real-secret',
      credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
    })
    proxies.push(proxy)

    const invalidHeaders: Array<Record<string, string>> = [
      { 'x-echo': proxy.capability },
      { authorization: `prefix-${proxy.capability}` },
      { authorization: `Bearer ${proxy.capability}-suffix` },
    ]
    for (const headers of invalidHeaders) {
      const response = await requestProxy(`${proxy.url}/models`, headers)
      expect(response.status).toBe(401)
    }
    expect(upstreamRequests).toBe(0)
  })

  it('never substitutes credentials in unrelated headers', async () => {
    let upstreamEcho = ''
    const upstream = await startUpstream((request, response) => {
      upstreamEcho = String(request.headers['x-echo'] || '')
      response.end('ok')
    })
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      credential: 'real-provider-secret',
      credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
    })
    proxies.push(proxy)

    const response = await requestProxy(`${proxy.url}/models`, {
      authorization: `Bearer ${proxy.capability}`,
      'x-echo': `opaque-${proxy.capability}-value`,
    })
    expect(response.status).toBe(200)
    expect(upstreamEcho).toBe(`opaque-${proxy.capability}-value`)
    expect(upstreamEcho).not.toContain('real-provider-secret')
  })

  it('redacts reflected credentials across response headers and stream chunks', async () => {
    const apiKey = 'sk-real-reflected-api-key'
    const oauthToken = 'oauth-real-reflected-token'
    const upstream = await startUpstream((_request, response) => {
      const body = `visible:${apiKey}:${oauthToken}:done`
      response.writeHead(200, {
        authorization: `Bearer ${oauthToken}`,
        'x-reflection': `prefix-${apiKey}-suffix-${oauthToken}`,
        'content-length': String(Buffer.byteLength(body)),
      })
      response.write(`visible:${apiKey.slice(0, 9)}`)
      response.write(apiKey.slice(9))
      response.write(`:${oauthToken.slice(0, 11)}`)
      response.end(`${oauthToken.slice(11)}:done`)
    })
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      headers: {
        'x-api-key': apiKey,
        authorization: `Bearer ${oauthToken}`,
      },
      credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
    })
    proxies.push(proxy)

    const response = await requestProxy(`${proxy.url}/messages`, {
      authorization: `Bearer ${proxy.capability}`,
    })
    const visibleSurface = JSON.stringify(response)
    expect(response.status).toBe(200)
    expect(response.body).toContain('[REDACTED]')
    expect(response.headers.authorization).toBeUndefined()
    expect(response.headers['content-length']).toBeUndefined()
    expect(visibleSurface).not.toContain(apiKey)
    expect(visibleSurface).not.toContain(oauthToken)
    expect(visibleSurface).not.toContain('Bearer oauth-real')
  })

  it('fails closed on encoded responses that cannot be inspected for credential reflection', async () => {
    const realSecret = 'encoded-real-secret'
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' })
      response.end(realSecret)
    })
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstream,
      credential: realSecret,
      credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
    })
    proxies.push(proxy)

    const response = await requestProxy(`${proxy.url}/models`, {
      authorization: `Bearer ${proxy.capability}`,
    })
    expect(response.status).toBe(502)
    expect(JSON.stringify(response)).not.toContain(realSecret)
  })
})
