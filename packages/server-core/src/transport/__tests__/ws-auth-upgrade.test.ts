import { afterEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { SignJWT } from 'jose'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from '@polo-ai/shared/protocol'
import { WsRpcServer, type WsAuthContext } from '../server'
import type { RequestContext } from '../types'
import { extractSessionCookie, verifyAdminJwt } from '../../webui/auth'

const JWT_SECRET = 'jwt-secret-for-ws-upgrade-tests'
const WRONG_JWT_SECRET = 'wrong-jwt-secret-for-ws-upgrade-tests'
const SERVER_TOKEN = 'server-token-with-enough-entropy'

type ConnectedInfo = {
  clientId: string
  userId: string | null
  username: string
  role: string
  jwt: string | null
}

const openSockets: WebSocket[] = []
const servers: WsRpcServer[] = []

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }
  for (const server of servers.splice(0)) {
    server.close()
  }
})

async function signAdminJwt(opts: {
  userId: string
  username: string
  role?: string
  secret?: string
  expiresInSeconds?: number
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const key = new TextEncoder().encode(opts.secret ?? JWT_SECRET)
  return new SignJWT({
    sub: opts.userId,
    username: opts.username,
    role: opts.role ?? 'user',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresInSeconds ?? 3600))
    .sign(key)
}

function createUpgradeAuthServer(onClientConnected?: (info: ConnectedInfo) => void): WsRpcServer {
  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (token) => token === SERVER_TOKEN,
    validateBearerToken: async (jwt): Promise<WsAuthContext | null> => {
      const payload = await verifyAdminJwt(jwt, JWT_SECRET)
      if (!payload) return null

      return {
        userId: payload.sub,
        username: payload.username,
        role: payload.role,
        jwt,
      }
    },
    validateSessionCookie: async (cookieHeader): Promise<WsAuthContext | null> => {
      const jwt = extractSessionCookie(cookieHeader)
      if (!jwt) return null

      const payload = await verifyAdminJwt(jwt, JWT_SECRET)
      if (!payload) return null

      return {
        userId: payload.sub,
        username: payload.username,
        role: payload.role,
        jwt,
      }
    },
    onClientConnected: onClientConnected as any,
    serverId: 'test',
  })
  servers.push(server)
  return server
}

function createLegacyAuthServer(): WsRpcServer {
  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (token) => token === SERVER_TOKEN,
    serverId: 'test',
  })
  servers.push(server)
  return server
}

async function connectAndHandshake(opts: {
  server: WsRpcServer
  headers?: Record<string, string>
  handshake?: Record<string, unknown>
}): Promise<{ ws: WebSocket; ack: Record<string, any> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${opts.server.port}`, {
    headers: opts.headers,
  })
  openSockets.push(ws)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Handshake timeout'))
    }, 3000)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: '1.1',
        workspaceId: 'ws-1',
        ...opts.handshake,
      }))
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        clearTimeout(timeout)
        resolve({ ws, ack: msg })
      } else if (msg.type === 'error') {
        clearTimeout(timeout)
        reject(new Error(msg.error?.message ?? 'handshake error'))
      }
    })

    ws.on('close', (code, reason) => {
      clearTimeout(timeout)
      reject(new Error(`closed ${code} ${reason.toString()}`))
    })

    ws.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function invokeRpc(ws: WebSocket, channel: string, ...args: unknown[]): Promise<Record<string, any>> {
  const id = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`RPC timeout: ${channel}`))
    }, 3000)

    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString())
      if (msg.id !== id) return

      clearTimeout(timeout)
      ws.off('message', onMessage)
      if (msg.type === 'error') {
        reject(new Error(msg.error?.message ?? 'rpc error'))
        return
      }
      resolve(msg)
    }

    ws.on('message', onMessage)
    ws.send(JSON.stringify({
      id,
      type: 'request',
      channel,
      args,
    }))
  })
}

async function expectUpgradeRejected(server: WsRpcServer, headers?: Record<string, string>): Promise<void> {
  const statusCode = await new Promise<number>((resolve, reject) => {
    const socket = netConnect(server.port, '127.0.0.1', () => {
      const requestHeaders: Record<string, string> = {
        Host: `127.0.0.1:${server.port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      }
      const lines = [
        'GET / HTTP/1.1',
        ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('upgrade rejection timeout'))
    }, 3000)

    socket.on('data', (chunk) => {
      clearTimeout(timeout)
      socket.destroy()
      const firstLine = chunk.toString('utf8').split(/\r?\n/)[0] ?? ''
      const match = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)
      resolve(match ? Number(match[1]) : 0)
    })

    socket.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })

  expect(statusCode).toBe(401)
}

describe('WsRpcServer upgrade authentication', () => {
  it('accepts a valid polo_ai_session cookie and exposes user identity on connection and ack', async () => {
    const connected: ConnectedInfo[] = []
    const server = createUpgradeAuthServer((info) => connected.push(info))
    const handlerContexts: RequestContext[] = []
    server.handle('test:get-context', (ctx) => {
      handlerContexts.push(ctx)
      return {
        userId: ctx.userId,
        username: ctx.username,
        userRole: ctx.userRole,
        userJwt: ctx.userJwt,
      }
    })
    await server.listen()

    const jwt = await signAdminJwt({ userId: 'user-1', username: 'alice', role: 'admin' })
    const { ws, ack } = await connectAndHandshake({
      server,
      headers: { Cookie: `polo_ai_session=${jwt}` },
    })
    const response = await invokeRpc(ws, 'test:get-context')

    expect(ack.clientId).toBeTruthy()
    expect(ack.userId).toBe('user-1')
    expect(ack.username).toBe('alice')
    expect(connected).toHaveLength(1)
    expect(connected[0]).toMatchObject({
      userId: 'user-1',
      username: 'alice',
      role: 'admin',
      jwt,
    })
    expect(response.result).toEqual({
      userId: 'user-1',
      username: 'alice',
      userRole: 'admin',
      userJwt: jwt,
    })
    expect(handlerContexts[0]?.userId).toBe('user-1')
    expect(handlerContexts[0]?.userJwt).toBe(jwt)
  })

  it('parses polo_ai_session from a multi-cookie header and gives cookie auth priority', async () => {
    const server = createUpgradeAuthServer()
    await server.listen()

    const jwt = await signAdminJwt({ userId: 'user-2', username: 'bob' })
    const { ack } = await connectAndHandshake({
      server,
      headers: {
        Cookie: `other=x; polo_ai_session=${jwt}; foo=bar`,
        'x-server-token': SERVER_TOKEN,
      },
    })

    expect(ack.userId).toBe('user-2')
    expect(ack.username).toBe('bob')
  })

  it('accepts a valid Authorization Bearer JWT in the upgrade headers', async () => {
    const connected: ConnectedInfo[] = []
    const server = createUpgradeAuthServer((info) => connected.push(info))
    server.handle('test:get-context', (ctx) => ({
      userId: ctx.userId,
      username: ctx.username,
      userRole: ctx.userRole,
      userJwt: ctx.userJwt,
    }))
    await server.listen()

    const jwt = await signAdminJwt({ userId: 'user-bearer', username: 'bea', role: 'admin' })
    const { ws, ack } = await connectAndHandshake({
      server,
      headers: { Authorization: `Bearer ${jwt}` },
    })
    const response = await invokeRpc(ws, 'test:get-context')

    expect(ack.clientId).toBeTruthy()
    expect(ack.userId).toBe('user-bearer')
    expect(ack.username).toBe('bea')
    expect(connected[0]).toMatchObject({
      userId: 'user-bearer',
      username: 'bea',
      role: 'admin',
      jwt,
    })
    expect(response.result).toEqual({
      userId: 'user-bearer',
      username: 'bea',
      userRole: 'admin',
      userJwt: jwt,
    })
  })

  it('rejects the removed x-server-token upgrade fallback', async () => {
    const server = createUpgradeAuthServer()
    await server.listen()

    await expectUpgradeRejected(server, { 'x-server-token': SERVER_TOKEN })
  })

  it('rejects unauthenticated or invalid upgrade requests with 401', async () => {
    const server = createUpgradeAuthServer()
    await server.listen()

    const expired = await signAdminJwt({ userId: 'expired', username: 'old', expiresInSeconds: -30 })
    const wrongSecret = await signAdminJwt({
      userId: 'wrong-secret',
      username: 'mallory',
      secret: WRONG_JWT_SECRET,
    })

    await expectUpgradeRejected(server)
    await expectUpgradeRejected(server, { Cookie: `polo_ai_session=${expired}` })
    await expectUpgradeRejected(server, { Cookie: `polo_ai_session=${wrongSecret}` })
    await expectUpgradeRejected(server, { 'x-server-token': 'wrong-token' })
  })

  it('accepts simplified and old-format handshakes after upgrade auth succeeds', async () => {
    const server = createUpgradeAuthServer()
    await server.listen()

    const jwt = await signAdminJwt({ userId: 'user-3', username: 'carol' })
    const simplified = await connectAndHandshake({
      server,
      headers: { Cookie: `polo_ai_session=${jwt}` },
      handshake: { workspaceId: 'ws-1' },
    })
    const oldFormat = await connectAndHandshake({
      server,
      headers: { Cookie: `polo_ai_session=${jwt}` },
      handshake: { token: SERVER_TOKEN, workspaceId: 'ws-1' },
    })

    expect(simplified.ack.clientId).toBeTruthy()
    expect(simplified.ack.userId).toBe('user-3')
    expect(simplified.ack.username).toBe('carol')
    expect(oldFormat.ack.clientId).toBeTruthy()
    expect(oldFormat.ack.userId).toBe('user-3')
    expect(oldFormat.ack.username).toBe('carol')
  })

  it('continues to accept legacy handshake token auth when upgrade session auth is not configured', async () => {
    const server = createLegacyAuthServer()
    await server.listen()

    const { ack } = await connectAndHandshake({
      server,
      handshake: {
        protocolVersion: PROTOCOL_VERSION,
        token: SERVER_TOKEN,
      },
    })

    expect(ack.clientId).toBeTruthy()
  })

  it('does not reuse reconnect state for a different authenticated user', async () => {
    const server = createUpgradeAuthServer()
    await server.listen()

    const jwtA = await signAdminJwt({ userId: 'same-workspace-a', username: 'alice' })
    const jwtB = await signAdminJwt({ userId: 'same-workspace-b', username: 'bob' })
    const first = await connectAndHandshake({
      server,
      headers: { Cookie: `polo_ai_session=${jwtA}` },
      handshake: { workspaceId: 'ws-identity' },
    })
    first.ws.close()

    await new Promise(resolve => setTimeout(resolve, 50))

    const reconnectAsOtherUser = await connectAndHandshake({
      server,
      headers: { Cookie: `polo_ai_session=${jwtB}` },
      handshake: {
        workspaceId: 'ws-identity',
        reconnectClientId: first.ack.clientId,
        lastSeq: 0,
      },
    })

    expect(reconnectAsOtherUser.ack.reconnected).toBeUndefined()
    expect(reconnectAsOtherUser.ack.clientId).not.toBe(first.ack.clientId)
    expect(reconnectAsOtherUser.ack.userId).toBe('same-workspace-b')
  })

  it('reuses reconnect state for the same authenticated user', async () => {
    const server = createUpgradeAuthServer()
    await server.listen()

    const jwt = await signAdminJwt({ userId: 'same-user', username: 'alice' })
    const first = await connectAndHandshake({
      server,
      headers: { Cookie: `polo_ai_session=${jwt}` },
      handshake: { workspaceId: 'ws-identity' },
    })
    first.ws.close()

    await new Promise(resolve => setTimeout(resolve, 50))

    const reconnect = await connectAndHandshake({
      server,
      headers: { Cookie: `polo_ai_session=${jwt}` },
      handshake: {
        workspaceId: 'ws-identity',
        reconnectClientId: first.ack.clientId,
        lastSeq: 0,
      },
    })

    expect(reconnect.ack.reconnected).toBe(true)
    expect(reconnect.ack.clientId).toBe(first.ack.clientId)
    expect(reconnect.ack.userId).toBe('same-user')
  })
})
