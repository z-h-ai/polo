/**
 * POL-11 integration tests for the relay server. The admin backend is mocked
 * with a plain Bun.serve HTTP server (no real admin / DB), mirroring the
 * polo-admin contract at main@deb31d86:
 * - POST /api/auth/validate   (Bearer → {valid:true,user:{id}} | 401 {error,message})
 * - GET  /api/devices/check-access?macDeviceId=… (Bearer → {allowed} | 401)
 * Time-sensitive behaviors (queue TTL, auth cache, heartbeat) run with
 * shortened constants instead of fake timers.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { RelayAuth, AdminClient } from '../auth.ts'
import { SignJWT, UnsecuredJWT } from 'jose'
import type { RelayConfig } from '../config.ts'
import { startRelayServer, type RelayServerHandle } from '../server.ts'

const SECRET_A = 'relay-test-secret-a-0123456789abcdef'
const SECRET_B = 'relay-test-secret-b-0123456789abcdef'

// ---------------------------------------------------------------------------
// Mock polo-admin
// ---------------------------------------------------------------------------

interface MockAdmin {
  url: string
  counts: { validate: number; checkAccess: number }
  approve(token: string, userId: string): void
  revoke(token: string): void
  setAccess(userId: string, macDeviceId: string, allowed: boolean): void
  stop(): void
}

function startMockAdmin(): MockAdmin {
  const approved = new Map<string, string>()
  const revoked = new Set<string>()
  const access = new Map<string, boolean>()
  const counts = { validate: 0, checkAccess: 0 }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')

      if (url.pathname === '/api/auth/validate' && req.method === 'POST') {
        counts.validate++
        const userId = approved.get(token)
        if (!userId || revoked.has(token)) {
          return Response.json({ error: 'unauthorized', message: 'unauthorized' }, { status: 401 })
        }
        return Response.json({
          valid: true,
          user: { id: userId, username: 'tester', displayName: 'Tester', role: 'user', groupIds: [] },
          configVersion: 'test',
        })
      }

      if (url.pathname === '/api/devices/check-access' && req.method === 'GET') {
        counts.checkAccess++
        const userId = approved.get(token)
        if (!userId || revoked.has(token)) {
          return Response.json({ error: 'unauthorized', message: 'unauthorized' }, { status: 401 })
        }
        const allowed = access.get(`${userId}:${url.searchParams.get('macDeviceId') ?? ''}`) ?? false
        return Response.json({ allowed })
      }

      return Response.json({ error: 'not_found', message: 'not_found' }, { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    approve: (token, userId) => approved.set(token, userId),
    revoke: (token) => revoked.add(token),
    setAccess: (userId, macDeviceId, allowed) => access.set(`${userId}:${macDeviceId}`, allowed),
    stop: () => server.stop(true),
  }
}

// ---------------------------------------------------------------------------
// Relay harness
// ---------------------------------------------------------------------------

function baseConfig(adminUrl: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    jwtSecret: SECRET_A,
    adminBaseUrl: adminUrl,
    jwtIssuer: 'polo-admin',
    jwtAudience: 'polo-client',
    maxMsgPerSec: 20,
    offlineQueueTtlMs: 300_000,
    offlineQueueMaxPerMac: 200,
    authCacheTtlMs: 60_000,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 60_000,
    maxPayloadBytes: 1_048_576,
    ...overrides,
  }
}

function startRelay(admin: MockAdmin, overrides: Partial<RelayConfig> = {}): RelayServerHandle {
  return startRelayServer({ config: baseConfig(admin.url, overrides), logger: () => {} })
}

async function signToken(
  secret: string,
  opts: { sub?: string; expiresIn?: number } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return await new SignJWT({ role: 'user', username: 'tester' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('polo-admin')
    .setAudience('polo-client')
    .setSubject(opts.sub ?? 'user-1')
    .setIssuedAt(nowSec)
    .setExpirationTime(opts.expiresIn ?? nowSec + 3_600)
    .sign(new TextEncoder().encode(secret))
}

function wsUrl(port: number, token: string, side: 'phone' | 'mac', deviceId: string): string {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&side=${side}&deviceId=${encodeURIComponent(deviceId)}`
}

function envelope(from: string, to: string, seq: number): string {
  return JSON.stringify({ v: 1, from, to, kind: 'rpc', payload: { seq, blob: `m${seq}` } })
}

// ---------------------------------------------------------------------------
// WS test client
// ---------------------------------------------------------------------------

interface Received {
  kind?: string
  from?: string
  to?: string
  payload?: { type?: string; reason?: string; peer?: string; seq?: number }
  queuedAt?: number
}

class Inbox {
  private items: string[] = []
  private waiters: Array<{ match: (v: Received) => boolean; resolve: (s: string) => void; timer: ReturnType<typeof setTimeout> }> = []

  push(text: string): void {
    const idx = this.waiters.findIndex((w) => {
      try {
        return w.match(JSON.parse(text) as Received)
      } catch {
        return false
      }
    })
    if (idx >= 0) {
      const waiter = this.waiters[idx]!
      this.waiters.splice(idx, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(text)
      return
    }
    this.items.push(text)
  }

  wait(match: (v: Received) => boolean, timeoutMs = 2_000): Promise<string> {
    const buffered = this.items.findIndex((t) => {
      try {
        return match(JSON.parse(t) as Received)
      } catch {
        return false
      }
    })
    if (buffered >= 0) return Promise.resolve(this.items.splice(buffered, 1)[0]!)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer)
        reject(new Error('timeout waiting for message'))
      }, timeoutMs)
      this.waiters.push({ match, resolve, timer })
    })
  }
}

interface TestClient {
  opened: Promise<void>
  closed: Promise<{ code: number; reason: string }>
  inbox: Inbox
  send(text: string): void
  close(): void
}

function connectClient(url: string, opts: { autoPong?: boolean } = {}): TestClient {
  const ws = new WebSocket(url)
  const inbox = new Inbox()
  let onOpened: () => void = () => {}
  let onClosed: (v: { code: number; reason: string }) => void = () => {}
  const opened = new Promise<void>((resolve) => {
    onOpened = resolve
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    onClosed = resolve
  })
  ws.onopen = () => onOpened()
  ws.onmessage = (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
    if (opts.autoPong) {
      try {
        const parsed = JSON.parse(text) as { type?: string }
        if (parsed.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
      } catch {
        // ignore non-JSON
      }
    }
    inbox.push(text)
  }
  ws.onclose = (ev) => onClosed({ code: ev.code, reason: ev.reason ?? '' })
  ws.onerror = () => {}
  return {
    opened,
    closed,
    inbox,
    send: (text) => ws.send(text),
    close: () => ws.close(),
  }
}

async function expectNotOpened(client: TestClient, withinMs = 500): Promise<boolean> {
  const opened = await Promise.race([
    client.opened.then(() => true as const),
    Bun.sleep(withinMs).then(() => false as const),
  ])
  return !opened
}

/** Polls a condition until it holds (async server-side bookkeeping settles). */
async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(10)
  }
  if (!check()) throw new Error('eventually: condition not met')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay handshake auth', () => {
  const cleanup: Array<() => void> = []
  afterAll(() => {
    for (const fn of cleanup) fn()
  })
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }

  test('valid token connects on both sides (mac proves device binding)', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-1', true)

    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-1'))
    await phone.opened
    const mac = connectClient(wsUrl(relay.port, token, 'mac', 'mac-1'))
    await mac.opened
    phone.close()
    mac.close()
  }, 10_000)

  test('garbage token → no upgrade, one introspection attempt', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const client = connectClient(wsUrl(relay.port, 'not-a-jwt', 'phone', 'phone-1'))
    expect(await expectNotOpened(client)).toBe(true)
    expect(admin.counts.validate).toBe(1)
  }, 10_000)

  test('locally-unverifiable token (other secret) → introspection vouches it in', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_B, { sub: 'user-9' })
    admin.approve(token, 'user-9')

    const client = connectClient(wsUrl(relay.port, token, 'phone', 'phone-9'))
    await client.opened
    expect(admin.counts.validate).toBe(1)
    client.close()
  }, 10_000)

  test('expired token rejected when introspection also says invalid', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const expired = await signToken(SECRET_A, { expiresIn: Math.floor(Date.now() / 1000) - 60 })
    const client = connectClient(wsUrl(relay.port, expired, 'phone', 'phone-1'))
    expect(await expectNotOpened(client)).toBe(true)
    expect(admin.counts.validate).toBe(1)
  }, 10_000)

  test('mac handshake without device binding → 403, no upgrade', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    // no setAccess → binding check fails
    const client = connectClient(wsUrl(relay.port, token, 'mac', 'mac-none'))
    expect(await expectNotOpened(client)).toBe(true)
    expect(admin.counts.checkAccess).toBe(1)
  }, 10_000)

  test('handshake without side/deviceId → rejected', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const client = connectClient(`ws://127.0.0.1:${relay.port}/ws`)
    expect(await expectNotOpened(client)).toBe(true)
  }, 10_000)

  test('alg=none (unsecured) JWT → rejected, no upgrade', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const noneToken = new UnsecuredJWT({ sub: 'user-1', role: 'user' })
      .setIssuer('polo-admin')
      .setAudience('polo-client')
      .setIssuedAt()
      .setExpirationTime('1h')
      .encode()
    const client = connectClient(wsUrl(relay.port, noneToken, 'phone', 'phone-none'))
    expect(await expectNotOpened(client)).toBe(true)
    // The relay still asked the authoritative admin once; the mock does not
    // vouch for an unsecured token either (a real admin rejects the signature).
    expect(admin.counts.validate).toBe(1)
  }, 10_000)

  test('handshake with Authorization header (no token query param) connects', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')

    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.port}/ws?side=phone&deviceId=${encodeURIComponent('phone-hdr')}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onclose = () => reject(new Error('closed instead of opening'))
      ws.onerror = () => {}
    })
    await opened
    ws.close()
  }, 10_000)
})

describe('relay routing', () => {
  const cleanup: Array<() => void> = []
  afterAll(() => {
    for (const fn of cleanup) fn()
  })
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }

  test('phone→mac and mac→phone deliver directly; check-access cached 60s', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-r', true)

    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-r'))
    await phone.opened
    const mac = connectClient(wsUrl(relay.port, token, 'mac', 'mac-r'))
    await mac.opened

    phone.send(envelope('phone:phone-r', 'mac:mac-r', 1))
    const atMac = JSON.parse(await mac.inbox.wait((v) => v.payload?.seq === 1)) as Received
    expect(atMac.from).toBe('phone:phone-r')
    expect(atMac.to).toBe('mac:mac-r')

    mac.send(envelope('mac:mac-r', 'phone:phone-r', 2))
    const atPhone = JSON.parse(await phone.inbox.wait((v) => v.payload?.seq === 2)) as Received
    expect(atPhone.from).toBe('mac:mac-r')

    // Both phone→mac sends reuse the access cache warmed by the mac handshake
    // (same userId:macDeviceId key) — no extra admin call per message.
    phone.send(envelope('phone:phone-r', 'mac:mac-r', 3))
    await mac.inbox.wait((v) => v.payload?.seq === 3)
    expect(admin.counts.checkAccess).toBe(1)
  }, 10_000)

  test('mac→offline phone gets an immediate phone_offline receipt', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-off', true)

    const mac = connectClient(wsUrl(relay.port, token, 'mac', 'mac-off'))
    await mac.opened

    mac.send(envelope('mac:mac-off', 'phone:ghost', 7))
    const receipt = JSON.parse(await mac.inbox.wait((v) => v.payload?.type === 'delivery_failed')) as Received
    expect(receipt.from).toBe('relay')
    expect(receipt.payload?.reason).toBe('phone_offline')
  }, 10_000)

  test('other user’s phone cannot send to a mac it is not bound to (not_allowed)', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const ownerToken = await signToken(SECRET_A, { sub: 'user-1' })
    const otherToken = await signToken(SECRET_A, { sub: 'user-2' })
    admin.approve(ownerToken, 'user-1')
    admin.approve(otherToken, 'user-2')
    admin.setAccess('user-1', 'mac-shared', true)

    const mac = connectClient(wsUrl(relay.port, ownerToken, 'mac', 'mac-shared'))
    await mac.opened
    const intruder = connectClient(wsUrl(relay.port, otherToken, 'phone', 'phone-2'))
    await intruder.opened

    intruder.send(envelope('phone:phone-2', 'mac:mac-shared', 1))
    const receipt = JSON.parse(await intruder.inbox.wait((v) => v.payload?.type === 'delivery_failed')) as Received
    expect(receipt.payload?.reason).toBe('not_allowed')
    // The legitimate path is untouched.
    mac.close()
    intruder.close()
  }, 10_000)

  test('spoofed `from` persona → close 4403', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-s', true)
    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-s'))
    await phone.opened

    phone.send(envelope('phone:someone-else', 'mac:mac-s', 1))
    const closed = await phone.closed
    expect(closed.code).toBe(4403)
  }, 10_000)

  test('check-access 401 (revoked session) → close 4401', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-x'))
    await phone.opened

    admin.revoke(token)
    phone.send(envelope('phone:phone-x', 'mac:anything', 1))
    const closed = await phone.closed
    expect(closed.code).toBe(4401)
  }, 10_000)

  test('rate limit exceeded → close 4008', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin, { maxMsgPerSec: 5 }))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-rl'))
    await phone.opened

    for (let i = 1; i <= 10; i++) {
      phone.send(envelope('phone:phone-rl', 'mac:mac-rl', i))
    }
    const closed = await phone.closed
    expect(closed.code).toBe(4008)
  }, 10_000)

  test('same user reconnecting on the same persona replaces the old connection (4009)', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')

    const first = connectClient(wsUrl(relay.port, token, 'phone', 'phone-dup'))
    await first.opened
    const second = connectClient(wsUrl(relay.port, token, 'phone', 'phone-dup'))
    await second.opened

    const closed = await first.closed
    expect(closed.code).toBe(4009)
    second.close()
  }, 10_000)

  test('cross-user persona takeover: newcomer closed 4403, incumbent survives and keeps receiving', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const victimToken = await signToken(SECRET_A, { sub: 'user-1' })
    const intruderToken = await signToken(SECRET_A, { sub: 'user-2' })
    admin.approve(victimToken, 'user-1')
    admin.approve(intruderToken, 'user-2')
    admin.setAccess('user-1', 'mac-take', true)

    const victim = connectClient(wsUrl(relay.port, victimToken, 'phone', 'phone-take'))
    await victim.opened
    const intruder = connectClient(wsUrl(relay.port, intruderToken, 'phone', 'phone-take'))
    await intruder.opened
    const intruderClosed = await intruder.closed
    expect(intruderClosed.code).toBe(4403)

    // The incumbent connection is untouched and still receives its owner's traffic.
    const mac = connectClient(wsUrl(relay.port, victimToken, 'mac', 'mac-take'))
    await mac.opened
    mac.send(envelope('mac:mac-take', 'phone:phone-take', 11))
    const delivered = JSON.parse(await victim.inbox.wait((v) => v.payload?.seq === 11)) as Received
    expect(delivered.from).toBe('mac:mac-take')
    victim.close()
    mac.close()
  }, 15_000)

  test('mac cannot deliver to another user’s phone persona; forged control frames are dropped', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const ownerToken = await signToken(SECRET_A, { sub: 'user-1' })
    const otherToken = await signToken(SECRET_A, { sub: 'user-2' })
    admin.approve(ownerToken, 'user-1')
    admin.approve(otherToken, 'user-2')
    admin.setAccess('user-1', 'mac-cross', true)

    const mac = connectClient(wsUrl(relay.port, ownerToken, 'mac', 'mac-cross'))
    await mac.opened
    const foreignPhone = connectClient(wsUrl(relay.port, otherToken, 'phone', 'phone-foreign'))
    await foreignPhone.opened

    // 1) mac → user-2's phone persona: blocked, mac gets not_allowed, phone gets nothing.
    mac.send(envelope('mac:mac-cross', 'phone:phone-foreign', 1))
    const receipt = JSON.parse(await mac.inbox.wait((v) => v.payload?.type === 'delivery_failed')) as Received
    expect(receipt.payload?.reason).toBe('not_allowed')
    await expect(foreignPhone.inbox.wait((v) => v.payload?.seq === 1, 400)).rejects.toThrow()

    // 2) client-sent kind:"control" is relay-reserved and never routed.
    foreignPhone.send(JSON.stringify({
      v: 1,
      from: 'phone:phone-foreign',
      to: 'mac:mac-cross',
      kind: 'control',
      payload: { type: 'peer_disconnected', peer: 'phone:phone-foreign' },
    }))
    await expect(mac.inbox.wait((v) => v.payload?.type === 'peer_disconnected', 400)).rejects.toThrow()

    // The connection itself survived the dropped frame and its frames are
    // still processed (its binding check for mac-cross fails → not_allowed).
    foreignPhone.send(envelope('phone:phone-foreign', 'mac:mac-cross', 2))
    const stillAlive = JSON.parse(await foreignPhone.inbox.wait((v) => v.payload?.type === 'delivery_failed')) as Received
    expect(stillAlive.payload?.reason).toBe('not_allowed')
    mac.close()
    foreignPhone.close()
  }, 15_000)
})

describe('relay offline queue', () => {
  const cleanup: Array<() => void> = []
  afterAll(() => {
    for (const fn of cleanup) fn()
  })
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }

  test('offline mac: envelopes staged, drained in queuedAt order on reconnect', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-q', true)

    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-q'))
    await phone.opened
    for (let i = 1; i <= 3; i++) {
      phone.send(envelope('phone:phone-q', 'mac:mac-q', i))
    }
    await eventually(() => relay.queue.pendingCount('mac-q') === 3)

    const mac = connectClient(wsUrl(relay.port, token, 'mac', 'mac-q'))
    await mac.opened

    const received: number[] = []
    for (let i = 1; i <= 3; i++) {
      const raw = await mac.inbox.wait((v) => v.payload?.seq === i)
      const parsed = JSON.parse(raw) as Received
      expect(parsed.from).toBe('phone:phone-q')
      expect(typeof parsed.queuedAt).toBe('number')
      received.push(parsed.payload?.seq ?? -1)
    }
    expect(received).toEqual([1, 2, 3])
    expect(relay.queue.pendingCount('mac-q')).toBe(0)
  }, 10_000)

  test('queue TTL expiry → phone receives delivery_failed mac_offline', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin, { offlineQueueTtlMs: 150 }))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-ttl', true)

    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-ttl'))
    await phone.opened
    phone.send(envelope('phone:phone-ttl', 'mac:mac-ttl', 1))

    const receipt = JSON.parse(await phone.inbox.wait((v) => v.payload?.type === 'delivery_failed', 3_000)) as Received
    expect(receipt.payload?.reason).toBe('mac_offline')
    expect(relay.queue.pendingCount('mac-ttl')).toBe(0)
  }, 10_000)

  test('per-mac queue cap → overflow reports queue_full', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin, { offlineQueueMaxPerMac: 2 }))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-cap', true)

    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-cap'))
    await phone.opened
    for (let i = 1; i <= 3; i++) {
      phone.send(envelope('phone:phone-cap', 'mac:mac-cap', i))
    }
    const receipt = JSON.parse(await phone.inbox.wait((v) => v.payload?.type === 'delivery_failed')) as Received
    expect(receipt.payload?.reason).toBe('queue_full')
    expect(relay.queue.pendingCount('mac-cap')).toBe(2)
  }, 10_000)
})

describe('relay heartbeat & session revocation', () => {
  const cleanup: Array<() => void> = []
  afterAll(() => {
    for (const fn of cleanup) fn()
  })
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }

  test('silent client is terminated after timeout; mac peer gets peer_disconnected', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin, { heartbeatIntervalMs: 60, heartbeatTimeoutMs: 250 }))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')
    admin.setAccess('user-1', 'mac-hb', true)

    const mac = connectClient(wsUrl(relay.port, token, 'mac', 'mac-hb'), { autoPong: true })
    await mac.opened
    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-hb'), { autoPong: false })
    await phone.opened

    // Establish them as peers, then let the phone go silent (never pongs).
    phone.send(envelope('phone:phone-hb', 'mac:mac-hb', 1))
    await mac.inbox.wait((v) => v.payload?.seq === 1)

    const phoneClosed = await phone.closed
    expect(phoneClosed.code).toBeGreaterThanOrEqual(1000)

    const notice = JSON.parse(await mac.inbox.wait((v) => v.payload?.type === 'peer_disconnected', 3_000)) as Received
    expect(notice.payload?.peer).toBe('phone:phone-hb')

    // The ponging mac survives.
    const macStillOpen = await Promise.race([
      mac.closed.then(() => false as const),
      Bun.sleep(400).then(() => true as const),
    ])
    expect(macStillOpen).toBe(true)
  }, 15_000)

  test('mid-session revocation propagates within auth-cache TTL → close 4401', async () => {
    const admin = track(startMockAdmin())
    const relay = track(startRelay(admin, { heartbeatIntervalMs: 60, authCacheTtlMs: 150 }))
    const token = await signToken(SECRET_A)
    admin.approve(token, 'user-1')

    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-rv'))
    await phone.opened
    expect(admin.counts.validate).toBe(1)

    admin.revoke(token)
    const closed = await phone.closed
    expect(closed.code).toBe(4401)
    // Introspection refreshed (cache TTL elapsed) rather than trusting the stale entry.
    expect(admin.counts.validate).toBeGreaterThanOrEqual(2)
  }, 15_000)
})

describe('relay degraded mode (admin unreachable)', () => {
  const deadAdminUrl = 'http://admin.test'
  const cleanup: Array<() => void> = []
  afterAll(() => {
    for (const fn of cleanup) fn()
  })
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }

  test('valid local token connects while admin is down; routing fails closed (access_check_failed)', async () => {
    // Deterministically unreachable admin: every fetch rejects, exactly like a
    // network outage (avoids depending on sandbox proxy behavior).
    const deadAdmin = new AdminClient({
      baseUrl: 'http://admin.test',
      fetchImpl: (async () => {
        throw new Error('admin down')
      }) as unknown as typeof fetch,
    })
    const relay = track(startRelayServer({ config: baseConfig(deadAdminUrl), adminClient: deadAdmin, logger: () => {} }))
    const token = await signToken(SECRET_A)

    // Degraded handshake: local HS256 verification carries the phone in.
    const phone = connectClient(wsUrl(relay.port, token, 'phone', 'phone-dg'))
    await phone.opened

    // Garbage tokens still fail (degraded mode never relaxes signature checks).
    const garbage = connectClient(wsUrl(relay.port, 'garbage-token', 'phone', 'phone-dg2'))
    expect(await expectNotOpened(garbage)).toBe(true)

    // A Mac cannot prove its binding while admin is down → 403, no upgrade.
    const mac = connectClient(wsUrl(relay.port, token, 'mac', 'mac-dg'))
    expect(await expectNotOpened(mac)).toBe(true)

    // phone→mac routing: the binding check is unreachable → fail closed with a receipt.
    phone.send(envelope('phone:phone-dg', 'mac:mac-dg', 1))
    const receipt = JSON.parse(await phone.inbox.wait((v) => v.payload?.type === 'delivery_failed', 3_000)) as Received
    expect(receipt.payload?.reason).toBe('access_check_failed')
    phone.close()
  }, 15_000)
})

describe('relay auth degraded semantics (unit)', () => {
  function authWith(fetchBehavior: () => Promise<Response>): RelayAuth {
    const fetchImpl = (async () => fetchBehavior()) as unknown as typeof fetch
    const admin = new AdminClient({ baseUrl: 'http://admin.test', fetchImpl })
    return new RelayAuth(admin, { secret: SECRET_A, issuer: 'polo-admin', audience: 'polo-client' }, { authCacheTtlMs: 60_000 })
  }

  test('degraded (admin-unreachable) acceptance is never cached', async () => {
    let adminUp = false
    const auth = authWith(async () => {
      if (!adminUp) throw new Error('admin down')
      return Response.json({ valid: false }, { status: 200 })
    })
    const token = await signToken(SECRET_A)

    const degraded = await auth.authenticate(token)
    expect(degraded.ok).toBe(true)
    if (degraded.ok) expect(degraded.degraded).toBe(true)

    // Admin comes back and declares the token invalid: had the degraded
    // acceptance been cached, this would still pass authentication.
    adminUp = true
    expect((await auth.authenticate(token)).ok).toBe(false)
  })

  test('admin unreachable + locally invalid token → rejected (no degraded bypass)', async () => {
    const auth = authWith(async () => {
      throw new Error('admin down')
    })
    const foreign = await signToken(SECRET_B)
    expect((await auth.authenticate(foreign)).ok).toBe(false)
  })
})
