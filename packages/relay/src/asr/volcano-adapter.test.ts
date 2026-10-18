/**
 * POL-20 volcano STREAM adapter tests. 真连火山不做（需注入密钥，列人工）——
 * 上游用 Bun.serve mock WS，按火山二进制协议形状回帧，逐字节验证编解码。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'

import { MockAsrAdapter } from './mock-adapter.ts'
import { AsrAdapterRegistry } from './adapter.ts'
import type { AsrStreamContext } from './types.ts'
import {
  VolcanoStreamAsrAdapter,
  decodeVolcanoServerFrame,
  encodeVolcanoAudioChunk,
  encodeVolcanoFullClientRequest,
} from './volcano-adapter.ts'

// ---------------------------------------------------------------------------
// Frame codec (unit)
// ---------------------------------------------------------------------------

function fullServerResponse(json: unknown, opts: { flags?: number; gzip?: boolean } = {}): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(json))
  const compression = opts.gzip ? 0b0001 : 0b0000
  const compressed = opts.gzip ? new Uint8Array(gzipSync(payload)) : payload
  const flags = opts.flags ?? 0
  const withSeq = (flags & 0b0001) !== 0
  const seqBlock = withSeq ? new Uint8Array(8) : new Uint8Array(0)
  if (withSeq) {
    // [u32 seq-size][i32 seq]
    new DataView(seqBlock.buffer).setUint32(0, 4, false)
    new DataView(seqBlock.buffer).setInt32(4, 1, false)
  }
  const out = new Uint8Array(4 + seqBlock.length + 4 + compressed.length)
  out[0] = 0x11
  out[1] = (0b1001 << 4) | flags
  out[2] = (0b0001 << 4) | compression
  out[3] = 0x00
  out.set(seqBlock, 4)
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4 + seqBlock.length, compressed.length, false)
  out.set(compressed, 8 + seqBlock.length)
  return out
}

function errorServerResponse(code: number, message: string): Uint8Array {
  const payload = new TextEncoder().encode(message)
  const out = new Uint8Array(4 + 4 + 4 + payload.length)
  out[0] = 0x11
  out[1] = (0b1111 << 4) | 0
  out[2] = (0b0001 << 4) | 0
  new DataView(out.buffer).setUint32(4, code, false)
  new DataView(out.buffer).setUint32(8, payload.length, false)
  out.set(payload, 12)
  return out
}

describe('volcano binary framing', () => {
  test('full client request: v1 header + JSON payload with size prefix', () => {
    const bytes = encodeVolcanoFullClientRequest({ request: { model_name: 'bigmodel' } })
    expect(bytes[0]).toBe(0x11)
    expect(bytes[1]).toBe(0x10) // full client request, no flags
    expect(bytes[2]).toBe(0x10) // JSON serialization, no compression
    expect(bytes[3]).toBe(0x00)
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false)
    expect(size).toBe(bytes.length - 8)
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(8)))).toEqual({ request: { model_name: 'bigmodel' } })
  })

  test('audio chunk: raw serialization, last-frame flag variant', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    const plain = encodeVolcanoAudioChunk(pcm, false)
    expect(plain[1]).toBe(0x20)
    expect(plain[2]).toBe(0xf0) // serialization none, no compression
    expect(new DataView(plain.buffer).getUint32(4, false)).toBe(4)
    expect([...plain.subarray(8)]).toEqual([1, 2, 3, 4])

    const last = encodeVolcanoAudioChunk(new Uint8Array(0), true)
    expect(last[1]).toBe(0x22) // last-frame no-sequence flag
  })

  test('decode full server response: plain, gzip, sequence-prefix variants', () => {
    const plain = decodeVolcanoServerFrame(fullServerResponse({ result: { text: '你' } }))
    expect(plain).toEqual({ kind: 'result', json: { result: { text: '你' } }, final: false })

    const gzipped = decodeVolcanoServerFrame(fullServerResponse({ result: { text: '好' } }, { gzip: true }))
    expect(gzipped).toEqual({ kind: 'result', json: { result: { text: '好' } }, final: false })

    const withSeq = decodeVolcanoServerFrame(
      fullServerResponse({ result: { text: '世界' } }, { flags: 0b0001 }),
    )
    expect(withSeq).toMatchObject({ kind: 'result', final: false })

    const last = decodeVolcanoServerFrame(fullServerResponse({ result: { text: '完' } }, { flags: 0b0010 }))
    expect(last).toMatchObject({ kind: 'result', final: true })
  })

  test('decode error server response: code + message', () => {
    const decoded = decodeVolcanoServerFrame(errorServerResponse(45000001, 'quota exceeded'))
    expect(decoded).toEqual({ kind: 'error', code: 45000001, message: 'quota exceeded' })
  })

  test('garbage / truncated frames decode to null', () => {
    expect(decodeVolcanoServerFrame(new Uint8Array([0x11]))).toBeNull()
    expect(decodeVolcanoServerFrame(new Uint8Array([0x11, 0x20, 0xf0, 0x00]))).toBeNull()
  })

  test('truncated error-frame body decodes to null without throwing (no RangeError in onmessage)', () => {
    // header says 0b1111 error, body shorter than [u32 code][u32 size]
    const shortHeaderOnly = new Uint8Array([0x11, 0xf0, 0xf0, 0x00, 0x01])
    expect(() => decodeVolcanoServerFrame(shortHeaderOnly)).not.toThrow()
    expect(decodeVolcanoServerFrame(shortHeaderOnly)).toBeNull()
    // code 完整、size 字段被截断（8~11 字节）
    const sizeTruncated = new Uint8Array([0x11, 0xf0, 0xf0, 0x00, 0, 0, 0, 1, 0x7f, 0xff])
    expect(() => decodeVolcanoServerFrame(sizeTruncated)).not.toThrow()
    expect(decodeVolcanoServerFrame(sizeTruncated)).toBeNull()
    // 声明 size 超出实际载荷 → null（超帧防御）
    const oversized = new Uint8Array([0x11, 0xf0, 0xf0, 0x00, 0, 0, 0, 1, 0, 0, 0xff, 0xff, 0x61])
    expect(decodeVolcanoServerFrame(oversized)).toBeNull()
    // 坏 magic / 未知 messageType → null
    expect(decodeVolcanoServerFrame(new Uint8Array([0x11, 0x50, 0xf0, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
    // seq 前缀声明的 full server response 被截断 → null
    const truncatedSeq = new Uint8Array([0x11, 0x91, 0x10, 0x00, 0, 0, 0, 4, 0, 0, 0, 1])
    expect(decodeVolcanoServerFrame(truncatedSeq)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Mock upstream WS speaking the volcano framing
// ---------------------------------------------------------------------------

interface UpstreamEvents {
  headers: Record<string, string>
  audioChunks: number
  lastFrame: boolean
  config: unknown | null
}

interface UpstreamHandle {
  url: string
  events: UpstreamEvents
  /** When set, the next audio chunk triggers an error frame instead of a result. */
  failNextWithError: boolean
  /** When true, upstream closes right after the last audio frame without a final result. */
  dropBeforeFinal: boolean
  stop(): void
}

function startVolcanoUpstream(): UpstreamHandle {
  const events: UpstreamEvents = { headers: {}, audioChunks: 0, lastFrame: false, config: null }
  const state: UpstreamHandle = {
    url: '',
    events,
    failNextWithError: false,
    dropBeforeFinal: false,
    stop: () => server.stop(true),
  }

  const sendResult = (ws: { send(data: Uint8Array): void }, json: unknown): void => {
    ws.send(fullServerResponse(json))
  }

  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname !== '/upstream') {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      for (const [key, value] of req.headers.entries()) {
        events.headers[key] = value
      }
      const upgraded = server.upgrade(req)
      if (!upgraded) return Response.json({ error: 'upgrade_failed' }, { status: 400 })
      return undefined
    },
    websocket: {
      message(ws, raw) {
        if (typeof raw === 'string') return
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
        const messageType = (view.getUint8(1) >> 4) & 0x0f
        const flags = view.getUint8(1) & 0x0f
        if (messageType === 0b0001) {
          const size = view.getUint32(4, false)
          events.config = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + size)))
          sendResult(ws, { result: { text: '' } })
          return
        }
        if (messageType === 0b0010) {
          if (state.failNextWithError) {
            state.failNextWithError = false
            ws.send(errorServerResponse(45000001, 'quota exceeded'))
            return
          }
          events.audioChunks += 1
          if (flags === 0b0010) {
            events.lastFrame = true
            if (state.dropBeforeFinal) {
              ws.close()
              return
            }
            sendResult(ws, { result: { text: '最终文本', is_final: true } })
            return
          }
          sendResult(ws, { result: { text: `文本${events.audioChunks}` } })
        }
      },
    },
  })
  state.url = `ws://127.0.0.1:${server.port}/upstream`
  return state
}

// ---------------------------------------------------------------------------
// Adapter behavior
// ---------------------------------------------------------------------------

interface Collected {
  partials: Array<{ text: string; seq: number }>
  finals: string[]
  errors: Array<{ code: string; message: string }>
}

function collectingCtx(): { ctx: AsrStreamContext; got: Collected } {
  const got: Collected = { partials: [], finals: [], errors: [] }
  return {
    got,
    ctx: {
      userId: 'user-1',
      onPartial: (p) => got.partials.push(p),
      onFinal: (text) => got.finals.push(text),
      onError: (code, message) => got.errors.push({ code, message }),
    },
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

describe('volcano stream adapter', () => {
  const cleanup: Array<() => void> = []
  afterAll(() => {
    for (const fn of cleanup) fn()
  })
  const track = <T extends { stop(): void }>(x: T): T => {
    cleanup.push(() => x.stop())
    return x
  }

  test('auth headers + config frame + partial forwarding + final + metering', async () => {
    const upstream = track(startVolcanoUpstream())
    const adapter = new VolcanoStreamAsrAdapter({
      appId: 'test-appid',
      accessToken: 'test-access-token',
      resourceId: 'volcengine.stream.asr',
      endpoint: upstream.url,
    })
    expect(adapter.isConfigured()).toBe(true)

    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    const chunk = new Uint8Array(320) // 10ms of 16kHz s16le audio
    handle.pushAudio(chunk)
    handle.pushAudio(chunk)
    await eventually(() => upstream.events.audioChunks === 2)
    handle.finish()
    await eventually(() => got.finals.length === 1)

    expect(upstream.events.headers['x-api-app-key']).toBe('test-appid')
    expect(upstream.events.headers['x-api-access-key']).toBe('test-access-token')
    expect(upstream.events.headers['x-api-resource-id']).toBe('volcengine.stream.asr')
    expect(upstream.events.config).toMatchObject({
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel' },
    })
    expect(upstream.events.lastFrame).toBe(true)

    // partial 按序转发，seq 单调递增
    expect(got.partials.map((p) => p.text)).toEqual(['文本1', '文本2'])
    expect(got.partials.map((p) => p.seq)).toEqual([1, 2])
    expect(got.finals).toEqual(['最终文本'])
    expect(got.errors).toEqual([])

    // 服务端实测计量：2 × 320B / 32000B/s = 20ms
    expect(handle.meterSeconds()).toBeCloseTo(0.02, 6)
    handle.abort()
  }, 10_000)

  test('upstream error frame → ctx.onError upstream_error', async () => {
    const upstream = track(startVolcanoUpstream())
    upstream.failNextWithError = true
    const adapter = new VolcanoStreamAsrAdapter({ appId: 'a', accessToken: 'b', endpoint: upstream.url })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(new Uint8Array(320))
    await eventually(() => got.errors.length === 1)
    expect(got.errors[0]!.code).toBe('upstream_error')
    expect(got.errors[0]!.message).toContain('45000001')
    handle.abort()
  }, 10_000)

  test('upstream closed before final → ctx.onError upstream_error', async () => {
    const upstream = track(startVolcanoUpstream())
    upstream.dropBeforeFinal = true
    const adapter = new VolcanoStreamAsrAdapter({ appId: 'a', accessToken: 'b', endpoint: upstream.url })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(new Uint8Array(320))
    await eventually(() => upstream.events.audioChunks === 1)
    handle.finish() // last 帧到达后上游直接断连，不给 final
    await eventually(() => got.errors.length === 1)
    expect(got.errors[0]!.code).toBe('upstream_error')
    expect(got.finals).toEqual([])
    handle.abort()
  }, 10_000)

  test('missing credentials → not configured, inert stream reports supplier_unavailable', async () => {
    const adapter = new VolcanoStreamAsrAdapter({ appId: undefined, accessToken: undefined })
    expect(adapter.isConfigured()).toBe(false)
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(new Uint8Array(320))
    handle.finish()
    await Bun.sleep(20)
    expect(got.errors[0]!.code).toBe('supplier_unavailable')
    expect(got.finals).toEqual([])
    expect(handle.meterSeconds()).toBe(0)
  }, 10_000)

  test('unreachable upstream → ctx.onError upstream_error (connect failure)', async () => {
    const adapter = new VolcanoStreamAsrAdapter({ appId: 'a', accessToken: 'b', endpoint: 'ws://127.0.0.1:1/upstream' })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    await eventually(() => got.errors.length === 1)
    expect(got.errors[0]!.code).toBe('upstream_error')
    handle.abort()
  }, 10_000)

  test('FILE method: interface exists but volcengine is STREAM-only (MiMo=POL-21)', async () => {
    const adapter = new VolcanoStreamAsrAdapter({ appId: 'a', accessToken: 'b' })
    expect(typeof adapter.transcribe).toBe('function')
    try {
      await adapter.transcribe({ audio: new Uint8Array(320) })
      throw new Error('transcribe should have rejected')
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('file_not_supported')
    }
  }, 10_000)
})

describe('mock adapter (determinism + FILE method)', () => {
  test('fixed partial sequence, final, byte-based metering', () => {
    const adapter = new MockAsrAdapter({ partialScript: ['一', '一二', '一二三'], finalText: '一二三四' })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    for (let i = 0; i < 3; i++) handle.pushAudio(new Uint8Array(3200)) // 100ms each
    handle.finish()
    expect(got.partials.map((p) => [p.seq, p.text])).toEqual([
      [1, '一'],
      [2, '一二'],
      [3, '一二三'],
    ])
    expect(got.finals).toEqual(['一二三四'])
    expect(handle.meterSeconds()).toBeCloseTo(0.3, 6)
  })

  test('FILE transcribe resolves deterministically', async () => {
    const adapter = new MockAsrAdapter()
    expect(typeof adapter.transcribe).toBe('function')
    const result = await adapter.transcribe({ audio: new Uint8Array(32000) })
    expect(result.text).toBe('你好，世界')
    expect(result.seconds).toBeCloseTo(1, 6)
  })
})

describe('adapter registry', () => {
  test('unknown supplier resolves to undefined (service turns it into an explicit error frame)', () => {
    const registry = new AsrAdapterRegistry()
    const adapter = new MockAsrAdapter()
    registry.register(adapter)
    expect(registry.get('mock')).toBe(adapter)
    expect(registry.get('ghost')).toBeUndefined()
    expect(registry.ids()).toEqual(['mock'])
  })
})
