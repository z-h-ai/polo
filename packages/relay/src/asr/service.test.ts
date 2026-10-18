/**
 * POL-20 /asr pipeline integration tests: handshake+能力下发、STREAM partial
 * 转发、计费 prehold→settle 流程、409/422 关闭码、中断/取消 refund、能力配置
 * 60s 缓存。polo-admin（鉴权 + 计费三端点）用 Bun.serve mock，契约对齐
 * main@c3257421；上游 adapter 用确定性 mock。时间敏感常数全部注入缩短。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'

import { AsrAdapterRegistry } from './adapter.ts'
import { AdminClient, RelayAuth } from '../auth.ts'
import { VoiceBillingClient } from './billing.ts'
import { AsrCapabilityService, type AsrSupplierConfig } from './capabilities.ts'
import { MockAsrAdapter } from './mock-adapter.ts'
import { AsrService } from './service.ts'
import type { AsrAdapter, AsrRateCard, AsrServerFrame } from './types.ts'
import type { RelayConfig } from '../config.ts'
import { startRelayServer, type RelayServerHandle } from '../server.ts'

const SECRET_A = 'relay-asr-test-secret-0123456789abcdef'
const PREHOLD_CREDITS = 10

// ---------------------------------------------------------------------------
// Mock polo-admin: /api/auth/validate + /api/billing/voice/*
// ---------------------------------------------------------------------------

interface SettleCall {
  preholdId: string
  action: 'settle' | 'refund'
  actualSeconds?: number
}

interface MockAdmin {
  url: string
  counts: { validate: number; quote: number; prehold: number }
  settleCalls: SettleCall[]
  approve(token: string, userId: string): void
  stop(): void
}

function startMockAdmin(): MockAdmin {
  const approved = new Map<string, string>()
  const counts = { validate: 0, quote: 0, prehold: 0 }
  const settleCalls: SettleCall[] = []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const userId = approved.get(token)

      if (url.pathname === '/api/auth/validate' && req.method === 'POST') {
        counts.validate++
        if (!userId) return Response.json({ error: 'unauthorized', message: 'unauthorized' }, { status: 401 })
        return Response.json({ valid: true, user: { id: userId } })
      }

      if (url.pathname === '/api/billing/voice/quote' && req.method === 'POST') {
        counts.quote++
        const body = (await req.json()) as { supplier: string; seconds: number }
        if (body.supplier === 'mimo') {
          return Response.json({ error: 'voice_not_quotable', message: 'no price configured' }, { status: 422 })
        }
        return Response.json({
          supplier: body.supplier,
          seconds: body.seconds,
          credits: PREHOLD_CREDITS,
          quoted: true,
          pricePerHourCny: 4.5,
          markupPermille: 1300,
        })
      }

      if (url.pathname === '/api/billing/voice/prehold' && req.method === 'POST') {
        counts.prehold++
        const body = (await req.json()) as { preholdId: string; supplier: string; seconds?: number }
        if (!userId) return Response.json({ error: 'unauthorized', message: 'unauthorized' }, { status: 401 })
        if (body.supplier === 'mimo') {
          return Response.json({ error: 'voice_not_quotable', message: 'no price configured' }, { status: 422 })
        }
        if (userId === 'poor-user') {
          return Response.json(
            { error: 'voice_insufficient_balance', message: 'Insufficient voice credits to start recognition', details: { required: PREHOLD_CREDITS, balance: 0 } },
            { status: 409 },
          )
        }
        return Response.json({
          preholdId: body.preholdId,
          userId,
          supplier: body.supplier,
          status: 'PENDING',
          preholdSeconds: body.seconds ?? 60,
          preholdCredits: PREHOLD_CREDITS,
          settleSeconds: null,
          settleCredits: null,
          balanceAfter: 990,
          idempotentReplay: false,
        })
      }

      if (url.pathname === '/api/billing/voice/settle' && req.method === 'POST') {
        const body = (await req.json()) as { preholdId: string; action: 'settle' | 'refund'; actualSeconds?: number }
        settleCalls.push({ ...body })
        return Response.json({
          preholdId: body.preholdId,
          userId: userId ?? 'unknown',
          supplier: 'mock',
          status: body.action === 'refund' ? 'REFUNDED' : 'SETTLED',
          preholdSeconds: 60,
          preholdCredits: PREHOLD_CREDITS,
          settleSeconds: body.action === 'refund' ? 0 : (body.actualSeconds ?? 0),
          settleCredits: body.action === 'refund' ? 0 : 1,
          balanceAfter: 1000,
          idempotentReplay: false,
        })
      }

      return Response.json({ error: 'not_found', message: 'not_found' }, { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    settleCalls,
    approve: (token, userId) => approved.set(token, userId),
    stop: () => server.stop(true),
  }
}

// ---------------------------------------------------------------------------
// Relay + AsrService harness
// ---------------------------------------------------------------------------

function supplierConfig(): AsrSupplierConfig {
  const card: AsrRateCard = { pricePerHourCny: 4.5, pricePerRequestCny: null, markupPermille: 1300, mock: true }
  return {
    defaultSupplier: 'mock',
    suppliers: {
      mock: { supplier: 'mock', mode: 'STREAM', rateCard: card },
      mimo: { supplier: 'mimo', mode: 'FILE', rateCard: { pricePerHourCny: null, pricePerRequestCny: null, markupPermille: 1300, mock: false } },
    },
  }
}

function mockAdapter(): MockAsrAdapter {
  return new MockAsrAdapter({ partialScript: ['partial-one', 'partial-two', 'partial-three', 'partial-four'], finalText: 'final-text' })
}

interface Harness {
  admin: MockAdmin
  relay: RelayServerHandle
  configLoadCount(): number
  stop(): void
}

function startHarness(opts: { preholdSeconds?: number; finalWaitMs?: number; cacheTtlMs?: number; maxSessionWallMs?: number } = {}): Harness {
  const admin = startMockAdmin()
  let loads = 0
  const auth = new RelayAuth(
    new AdminClient({ baseUrl: admin.url }),
    { secret: SECRET_A, issuer: 'polo-admin', audience: 'polo-client' },
    { authCacheTtlMs: 60_000 },
  )
  const registry = new AsrAdapterRegistry()
  const streamAdapter: AsrAdapter = mockAdapter()
  registry.register(streamAdapter)
  registry.register(new MockAsrAdapter({ id: 'mimo', mode: 'FILE', realtimeStreaming: false }))
  const asr = new AsrService({
    auth,
    registry,
    capabilities: new AsrCapabilityService({
      load: () => {
        loads += 1
        return supplierConfig()
      },
    }, opts.cacheTtlMs ?? 60_000),
    billing: new VoiceBillingClient({ baseUrl: admin.url }),
    logger: () => {},
    preholdSeconds: opts.preholdSeconds ?? 60,
    finalWaitMs: opts.finalWaitMs ?? 1_000,
    maxSessionWallMs: opts.maxSessionWallMs,
  })
  const config: RelayConfig = {
    port: 0,
    jwtSecret: SECRET_A,
    adminBaseUrl: admin.url,
    jwtIssuer: 'polo-admin',
    jwtAudience: 'polo-client',
    maxMsgPerSec: 20,
    offlineQueueTtlMs: 300_000,
    offlineQueueMaxPerMac: 200,
    authCacheTtlMs: 60_000,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 60_000,
    maxPayloadBytes: 1_048_576,
  }
  const relay = startRelayServer({ config, logger: () => {}, auth, asr })
  return {
    admin,
    relay,
    configLoadCount: () => loads,
    stop: () => {
      relay.stop()
      admin.stop()
    },
  }
}

async function signToken(sub: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return await new SignJWT({ role: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('polo-admin')
    .setAudience('polo-client')
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3_600)
    .sign(new TextEncoder().encode(SECRET_A))
}

function asrUrl(port: number, token: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ token, ...query })
  return `ws://127.0.0.1:${port}/asr?${params.toString()}`
}

/** 10ms of 16kHz s16le mono audio = 320 bytes. */
const AUDIO_CHUNK = new Uint8Array(320)

function audioFrame(index: number): string {
  const bytes = new Uint8Array(320)
  bytes.fill(index)
  return JSON.stringify({ type: 'audio', data: Buffer.from(bytes).toString('base64') })
}

interface FrameClient {
  opened: Promise<void>
  closed: Promise<{ code: number; reason: string }>
  frames: AsrServerFrame[]
  waitFor(match: (frame: AsrServerFrame) => boolean, timeoutMs?: number): Promise<AsrServerFrame>
  sendText(text: string): void
  sendBinary(bytes: Uint8Array): void
  close(): void
}

function connect(url: string): FrameClient {
  const ws = new WebSocket(url)
  const frames: AsrServerFrame[] = []
  const waiters: Array<{ match: (f: AsrServerFrame) => boolean; resolve: (f: AsrServerFrame) => void; timer: ReturnType<typeof setTimeout> }> = []
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => resolve()
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason ?? '' })
  })
  ws.onmessage = (ev) => {
    try {
      const frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as AsrServerFrame
      const idx = waiters.findIndex((w) => {
        try { return w.match(frame) } catch { return false }
      })
      if (idx >= 0) {
        const waiter = waiters.splice(idx, 1)[0]!
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
        return
      }
      frames.push(frame)
    } catch {
      // non-JSON frame
    }
  }
  ws.onerror = () => {}
  return {
    opened,
    closed,
    frames,
    waitFor(match, timeoutMs = 2_000) {
      const buffered = frames.find((f) => {
        try { return match(f) } catch { return false }
      })
      if (buffered) {
        const i = frames.indexOf(buffered)
        frames.splice(i, 1)
        return Promise.resolve(buffered)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error('timeout waiting for frame'))
        }, timeoutMs)
        waiters.push({ match, resolve, timer })
      })
    },
    sendText: (text) => ws.send(text),
    sendBinary: (bytes) => ws.send(bytes),
    close: () => ws.close(),
  }
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error('eventually: condition not met')
}

async function expectNotOpened(client: FrameClient, withinMs = 500): Promise<boolean> {
  const opened = await Promise.race([
    client.opened.then(() => true as const),
    Bun.sleep(withinMs).then(() => false as const),
  ])
  return !opened
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/asr handshake & billing gate', () => {
  const cleanup: Array<() => void> = []
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }
  afterAll(() => {
    for (const fn of cleanup) fn()
  })

  test('ready frame carries supplier capabilities + rateCard; prehold billed 60s', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-asr' }))
    await client.opened
    const ready = (await client.waitFor((f) => f.type === 'asr_ready')) as Extract<AsrServerFrame, { type: 'asr_ready' }>
    expect(ready.supplier).toBe('mock')
    expect(ready.mode).toBe('STREAM')
    expect(ready.realtimeStreaming).toBe(true)
    expect(ready.maxDurationSec).toBe(300)
    expect(Array.isArray(ready.languages)).toBe(true)
    expect(ready.rateCard).toEqual({ pricePerHourCny: 4.5, pricePerRequestCny: null, markupPermille: 1300, mock: true })
    expect(ready.preholdSeconds).toBe(60)
    expect(ready.preholdCredits).toBe(PREHOLD_CREDITS)
    expect(typeof ready.preholdId).toBe('string')
    expect(h.admin.counts.quote).toBe(1)
    expect(h.admin.counts.prehold).toBe(1)

    // end without audio → 0 秒全退
    client.sendText(JSON.stringify({ type: 'end' }))
    const closed = await client.closed
    expect(closed.code).toBe(1000)
    await eventually(() => h.admin.settleCalls.length === 1)
    expect(h.admin.settleCalls[0]).toMatchObject({ action: 'refund' })
  }, 15_000)

  test('invalid token → HTTP 401, no upgrade, no billing calls', async () => {
    const h = track(startHarness())
    const client = connect(asrUrl(h.relay.port, 'not-a-jwt'))
    expect(await expectNotOpened(client)).toBe(true)
    expect(h.admin.counts.prehold).toBe(0)
  }, 10_000)

  test('unknown supplier → explicit supplier_unknown error frame + close 4404', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')
    const client = connect(asrUrl(h.relay.port, token, { supplier: 'ghost' }))
    await client.opened
    const err = await client.waitFor((f) => f.type === 'asr_error') as Extract<AsrServerFrame, { type: 'asr_error' }>
    expect(err.code).toBe('supplier_unknown')
    expect(err.message).toContain('ghost')
    const closed = await client.closed
    expect(closed.code).toBe(4404)
    expect(h.admin.counts.quote).toBe(0)
  }, 10_000)

  test('prehold 409 voice_insufficient_balance → error frame + close 4402', async () => {
    const h = track(startHarness())
    const token = await signToken('poor-user')
    h.admin.approve(token, 'poor-user')
    const client = connect(asrUrl(h.relay.port, token))
    await client.opened
    const err = await client.waitFor((f) => f.type === 'asr_error') as Extract<AsrServerFrame, { type: 'asr_error' }>
    expect(err.code).toBe('insufficient_balance')
    const closed = await client.closed
    expect(closed.code).toBe(4402)
    expect(closed.reason).toBe('insufficient_balance')
    // 余额不足发生在 prehold：无账可结，不触发 settle。
    await Bun.sleep(100)
    expect(h.admin.settleCalls.length).toBe(0)
  }, 10_000)

  test('quote 422 voice_not_quotable → error frame + close 4403', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')
    const client = connect(asrUrl(h.relay.port, token, { supplier: 'mimo' }))
    await client.opened
    const err = await client.waitFor((f) => f.type === 'asr_error') as Extract<AsrServerFrame, { type: 'asr_error' }>
    expect(err.code).toBe('not_quotable')
    const closed = await client.closed
    expect(closed.code).toBe(4403)
    expect(h.admin.counts.prehold).toBe(0)
  }, 10_000)

  test('supplier config is cached (TTL 60s): two connections, one source load', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')
    for (const deviceId of ['phone-c1', 'phone-c2']) {
      const client = connect(asrUrl(h.relay.port, token, { deviceId }))
      await client.waitFor((f) => f.type === 'asr_ready')
      client.close()
    }
    expect(h.configLoadCount()).toBe(1)
    expect(h.admin.counts.prehold).toBe(2)
  }, 10_000)
})

describe('/asr STREAM partial forwarding & settle', () => {
  const cleanup: Array<() => void> = []
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }
  afterAll(() => {
    for (const fn of cleanup) fn()
  })

  test('audio chunks → partial 按序转发 (base64 text + raw binary) → final → settle(实测秒)', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-stream' }))
    await client.opened
    const ready = (await client.waitFor((f) => f.type === 'asr_ready')) as Extract<AsrServerFrame, { type: 'asr_ready' }>

    client.sendText(audioFrame(1))
    client.sendText(audioFrame(2))
    client.sendBinary(AUDIO_CHUNK)
    client.sendText(audioFrame(3))

    const partials: Array<{ text: string; seq: number }> = []
    for (let i = 0; i < 4; i++) {
      const frame = (await client.waitFor((f) => f.type === 'asr_partial')) as Extract<AsrServerFrame, { type: 'asr_partial' }>
      partials.push({ text: frame.text, seq: frame.seq })
    }
    expect(partials.map((p) => p.seq)).toEqual([1, 2, 3, 4])
    expect(partials.map((p) => p.text)).toEqual(['partial-one', 'partial-two', 'partial-three', 'partial-four'])

    client.sendText(JSON.stringify({ type: 'end' }))
    const final = (await client.waitFor((f) => f.type === 'asr_final')) as Extract<AsrServerFrame, { type: 'asr_final' }>
    expect(final.text).toBe('final-text')
    // 4 × 320B / 32000B/s = 40ms 服务端实测
    expect(final.seconds).toBeCloseTo(0.04, 6)

    const closed = await client.closed
    expect(closed.code).toBe(1000)
    await eventually(() => h.admin.settleCalls.length === 1)
    expect(h.admin.settleCalls[0]).toMatchObject({
      preholdId: ready.preholdId,
      action: 'settle',
      actualSeconds: 0.04,
    })
  }, 15_000)

  test('client cancel → adapter aborted, refund 全退, close 1000', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-cancel' }))
    await client.opened
    await client.waitFor((f) => f.type === 'asr_ready')
    client.sendText(audioFrame(1))
    client.sendText(JSON.stringify({ type: 'cancel' }))
    const closed = await client.closed
    expect(closed.code).toBe(1000)
    expect(closed.reason).toBe('cancelled')
    await eventually(() => h.admin.settleCalls.length === 1)
    expect(h.admin.settleCalls[0]!.action).toBe('refund')
  }, 10_000)
})

describe('/asr interruption & edge cases', () => {
  const cleanup: Array<() => void> = []
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }
  afterAll(() => {
    for (const fn of cleanup) fn()
  })

  test('abrupt close after audio → settle by server-measured seconds', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-drop' }))
    await client.opened
    await client.waitFor((f) => f.type === 'asr_ready')
    client.sendText(audioFrame(1))
    await client.waitFor((f) => f.type === 'asr_partial')
    client.close()
    await eventually(() => h.admin.settleCalls.length === 1)
    expect(h.admin.settleCalls[0]).toMatchObject({ action: 'settle', actualSeconds: 0.01 })
  }, 10_000)

  test('abrupt close with no audio (0 秒) → refund 全退', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-drop0' }))
    await client.opened
    await client.waitFor((f) => f.type === 'asr_ready')
    client.close()
    await eventually(() => h.admin.settleCalls.length === 1)
    expect(h.admin.settleCalls[0]!.action).toBe('refund')
  }, 10_000)

  test('frames before ready are rejected with not_ready, no billing impact', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-early' }))
    await client.opened
    client.sendText(JSON.stringify({ type: 'end' }))
    const err = await client.waitFor((f) => f.type === 'asr_error') as Extract<AsrServerFrame, { type: 'asr_error' }>
    expect(err.code).toBe('not_ready')
    // 会话随后仍能正常握手完成
    const ready = await client.waitFor((f) => f.type === 'asr_ready')
    expect(ready.type).toBe('asr_ready')
    client.close()
    await eventually(() => h.admin.settleCalls.length === 1)
  }, 10_000)

  test('pre-ready frame flood is rate limited (close 4008), incl. binary frames', async () => {
    const h = track(startHarness())
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-flood' }))
    await client.opened
    for (let i = 0; i < 30; i++) client.sendBinary(AUDIO_CHUNK)
    const closed = await client.closed
    expect(closed.code).toBe(4008)
    expect(closed.reason).toBe('rate_limited')
    await Bun.sleep(50)
    expect(h.admin.settleCalls.length).toBe(0)
  }, 10_000)

  test('wall-clock guard: session past wall limit settles measured seconds + close 4502 session_timeout', async () => {
    const h = track(startHarness({ maxSessionWallMs: 120 }))
    const token = await signToken('user-1')
    h.admin.approve(token, 'user-1')

    const client = connect(asrUrl(h.relay.port, token, { deviceId: 'phone-wall' }))
    await client.opened
    await client.waitFor((f) => f.type === 'asr_ready')
    client.sendText(audioFrame(1)) // 10ms 实测音频；此后客户端挂死不发 end

    const err = await client.waitFor((f) => f.type === 'asr_error' && f.code === 'session_timeout') as Extract<AsrServerFrame, { type: 'asr_error' }>
    expect(err.code).toBe('session_timeout')
    const closed = await client.closed
    expect(closed.code).toBe(4502)
    expect(closed.reason).toBe('session_timeout')
    await eventually(() => h.admin.settleCalls.length === 1)
    // 墙钟超限不等于全退：按服务端实测秒结算（settle 补扣语义由 admin 承接）
    expect(h.admin.settleCalls[0]).toMatchObject({ action: 'settle', actualSeconds: 0.01 })
  }, 10_000)
})
