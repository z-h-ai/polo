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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf-8'),
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
})
