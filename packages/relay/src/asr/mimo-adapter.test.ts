/**
 * POL-21 MiMo FILE adapter tests. 真连 MiMo 不做（账户未充值，转写实测 402，
 * 列人工关联 M2-6）—— 上游用 mock fetch + SSE ReadableStream 对齐文档形状
 * （mimo.mi.com Speech-Recognition：input_audio Data URL / asr_options 顶层 /
 * delta.content 增量 / [DONE] 终止）。时间敏感常数全部注入缩短。
 */

import { afterAll, describe, expect, test } from 'bun:test'

import { AsrAdapterRegistry } from './adapter.ts'
import { AdminClient, RelayAuth } from '../auth.ts'
import { MIMO_ASR_ENDPOINT, MIMO_MAX_AUDIO_BYTES, MimoAsrError, MimoFileAsrAdapter, mimoAsrOptionsFromEnv, type MimoAsrErrorCode } from './mimo-adapter.ts'
import { createDefaultAsrService } from './service.ts'
import type { AsrStreamContext } from './types.ts'
import { ASR_MAX_DURATION_SEC } from './types.ts'

// ---------------------------------------------------------------------------
// Fixtures & mock upstream
// ---------------------------------------------------------------------------

const WAV_HEADER = new TextEncoder().encode('RIFF')

/** 最小可嗅探 wav（RIFF…WAVE magic + N 字节载荷，16kHz s16le 口径）。 */
function wavBytes(payloadBytes: number): Uint8Array {
  const bytes = new Uint8Array(44 + payloadBytes)
  bytes.set(WAV_HEADER, 0)
  new DataView(bytes.buffer).setUint32(4, 36 + payloadBytes, true)
  bytes.set(new TextEncoder().encode('WAVE'), 8)
  return bytes
}

function id3Bytes(): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes.set(new TextEncoder().encode('ID3'), 0)
  return bytes
}

function mp3FrameSyncBytes(): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes[0] = 0xff
  bytes[1] = 0xfb // MPEG-1 Layer III 帧同步
  return bytes
}

function sseData(json: unknown): string {
  return `data: ${JSON.stringify(json)}\n\n`
}

function deltaChunk(content: string): string {
  return sseData({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })
}

interface SseResponseOptions {
  status?: number
  /** 正常收尾前断流：流中途 error（连接重置）。 */
  failAfter?: 'error'
}

function sseResponse(lines: string[], opts: SseResponseOptions = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) controller.enqueue(encoder.encode(line))
      if (opts.failAfter === 'error') {
        // 延迟断流：error() 会清空已入队 chunk，须让前面的 chunk 先被读走。
        setTimeout(() => controller.error(new Error('connection reset')), 5)
        return
      }
      controller.close()
    },
  })
  return new Response(stream, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream' } })
}

interface CapturedRequest {
  url: string
  method?: string
  headers: Headers
  body: string
}

interface CapturingFetch {
  fetch: typeof fetch
  calls: CapturedRequest[]
}

function capturingFetch(responder: () => Response): CapturingFetch {
  const calls: CapturedRequest[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    return responder()
  }) as typeof fetch
  return { fetch: impl, calls }
}

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

function expectMimoError(error: unknown, code: MimoAsrErrorCode): void {
  expect(error).toBeInstanceOf(MimoAsrError)
  expect((error as MimoAsrError).code).toBe(code)
}

// ---------------------------------------------------------------------------
// Streaming transcription (handle 路径，partial 渐进上抛)
// ---------------------------------------------------------------------------

describe('mimo file adapter: streaming transcription', () => {
  test('multi-chunk SSE → cumulative partials with monotonic seq + final; request shape & auth header', async () => {
    const audio = wavBytes(32_000) // 1s @ 16kHz s16le
    const { fetch, calls } = capturingFetch(() =>
      sseResponse([
        deltaChunk('你'),
        deltaChunk('好'),
        ': keep-alive\n\n', // 注释行容错
        'data: not-json\n\n', // 非 JSON data 行容错
        deltaChunk('，世界'),
        'data: [DONE]\n\n',
        deltaChunk('[DONE] 之后必须被忽略'),
      ]),
    )
    const adapter = new MimoFileAsrAdapter({ apiKey: 'test-mimo-key', fetchImpl: fetch, timeoutMs: 2_000 })
    expect(adapter.isConfigured()).toBe(true)
    expect(adapter.id).toBe('mimo')
    expect(adapter.mode).toBe('FILE')
    expect(adapter.capabilities.realtimeStreaming).toBe(false)
    expect(adapter.capabilities.maxDurationSec).toBe(300)

    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(audio)
    handle.finish()
    await eventually(() => got.finals.length === 1)

    // 一次调用、只上抛一次 final、错误为零
    expect(calls.length).toBe(1)
    expect(got.errors).toEqual([])
    // delta 增量 → 累计全文快照 partial（与火山同形），seq 单调递增
    expect(got.partials.map((p) => [p.seq, p.text])).toEqual([
      [1, '你'],
      [2, '你好'],
      [3, '你好，世界'],
    ])
    expect(got.finals).toEqual(['你好，世界'])

    // 请求形状：端点/方法/鉴权头/模型/流式开关
    const req = calls[0]!
    expect(req.url).toBe(MIMO_ASR_ENDPOINT)
    expect(req.method).toBe('POST')
    expect(req.headers.get('authorization')).toBe('Bearer test-mimo-key')
    expect(req.headers.get('content-type')).toBe('application/json')
    const body = JSON.parse(req.body) as {
      model: string
      stream: boolean
      asr_options: { language: string }
      messages: Array<{ role: string; content: Array<{ type: string; input_audio: { data: string; format: string } }> }>
    }
    expect(body.model).toBe('mimo-v2.5-asr')
    expect(body.stream).toBe(true)
    expect(body.asr_options).toEqual({ language: 'auto' })
    expect(body.messages.length).toBe(1) // 仅单条音频输入
    expect(body.messages[0]!.role).toBe('user')
    const part = body.messages[0]!.content[0]!
    expect(part.type).toBe('input_audio')
    expect(part.input_audio.format).toBe('wav')
    expect(part.input_audio.data).toBe(`data:audio/wav;base64,${Buffer.from(audio).toString('base64')}`)

    // 服务端实测计量：实际上送 32044B（含 44B wav 头）/ 32000B/s
    expect(handle.meterSeconds()).toBeCloseTo(audio.length / 32_000, 6)
  }, 10_000)

  test('half-package SSE: event split across stream chunks is parsed once complete', async () => {
    const { fetch, calls } = capturingFetch(() =>
      sseResponse([
        'data: {"choices":[{"del', // 半包：事件跨 chunk 边界
        'ta":{"content":"完整"}}]}\n\ndata: [DONE]\n\n',
      ]),
    )
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await eventually(() => got.finals.length === 1)
    expect(got.partials.map((p) => p.text)).toEqual(['完整'])
    expect(got.finals).toEqual(['完整'])
    expect(calls.length).toBe(1)
  }, 10_000)

  test('non-UTF8 tolerant: multibyte char split across raw byte chunks decodes intact', async () => {
    // '世界' 的 UTF-8 字节被从多字节字符中间切开（TextDecoder stream 模式容错）。
    const bytes = new TextEncoder().encode(
      `data: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n`,
    )
    const cut = bytes.indexOf(new TextEncoder().encode('界')[0]!) + 1 // 切在 '界' 多字节字符内部
    const { fetch } = capturingFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut))
          controller.enqueue(bytes.slice(cut))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await eventually(() => got.finals.length === 1)
    expect(got.partials.map((p) => p.text)).toEqual(['世界'])
    expect(got.finals).toEqual(['世界'])
  }, 10_000)

  test('stream drop (connection reset) mid-stream → fatal upstream_error, no final (上层可 refund)', async () => {
    const { fetch } = capturingFetch(() =>
      sseResponse([deltaChunk('部分')], { failAfter: 'error' }),
    )
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await eventually(() => got.errors.length === 1)
    expect(got.errors[0]!.code).toBe('upstream_error')
    expect(got.errors[0]!.message).toContain('connection reset')
    expect(got.finals).toEqual([])
    // 断流前的 partial 已渐进上抛
    expect(got.partials.map((p) => p.text)).toEqual(['部分'])
  }, 10_000)

  test('clean close without [DONE] → upstream_error (断流语义，不猜终文本)', async () => {
    const { fetch } = capturingFetch(() => sseResponse([deltaChunk('x')])) // 无 [DONE] 即关闭
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await eventually(() => got.errors.length === 1)
    expect(got.errors[0]!.code).toBe('upstream_error')
    expect(got.errors[0]!.message).toContain('[DONE]')
    expect(got.finals).toEqual([])
  }, 10_000)

  test('402 insufficient_balance → fatal error frame with refund semantics (预扣全退)', async () => {
    const { fetch, calls } = capturingFetch(() => Response.json({ error: { message: 'insufficient_balance' } }, { status: 402 }))
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await eventually(() => got.errors.length === 1)
    // service 层对 upstream_error 回错误帧 + refund 全退 + 4501（POL-245 已测）
    expect(got.errors[0]!.code).toBe('upstream_error')
    expect(got.errors[0]!.message).toContain('402')
    expect(got.errors[0]!.message).toContain('insufficient_balance')
    expect(got.finals).toEqual([])
    expect(calls.length).toBe(1)
  }, 10_000)

  test('HTTP 500 → fatal upstream_error', async () => {
    const { fetch } = capturingFetch(() => Response.json({ error: { message: 'boom' } }, { status: 500 }))
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await eventually(() => got.errors.length === 1)
    expect(got.errors[0]!.code).toBe('upstream_error')
    expect(got.errors[0]!.message).toContain('500')
  }, 10_000)

  test('timeout (MIMO_TIMEOUT_MS) → fatal upstream_error, no retry (不重复计费)', async () => {
    // 上游挂起不响应：仅在 abort 时 reject（模拟真 fetch 对 signal 的行为）
    const impl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as typeof fetch
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: impl, timeoutMs: 30 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await eventually(() => got.errors.length === 1)
    expect(got.errors[0]!.code).toBe('upstream_error')
    expect(got.errors[0]!.message).toContain('timed out')
    expect(got.finals).toEqual([])
  }, 10_000)

  test('abort cancels the in-flight upstream call and stops callbacks', async () => {
    let aborted = false
    const impl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        }, { once: true })
      })) as typeof fetch
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: impl, timeoutMs: 5_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish() // 调用已在途
    handle.abort() // 客户端上滑取消
    await Bun.sleep(50)
    expect(aborted).toBe(true)
    expect(got.errors).toEqual([]) // abort 后不再回错误帧（计费走上层 refund）
    expect(got.finals).toEqual([])
  }, 10_000)

  test('metering: bytes/32000 with 300s cap; trailing audio dropped with a single max_duration_reached notice', () => {
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: capturingFetch(() => sseResponse(['data: [DONE]\n\n'])).fetch })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    const maxBytes = ASR_MAX_DURATION_SEC * 32_000 // 9.6MB ≤ MiMo 10MB 上限
    const big = new Uint8Array(maxBytes + 1)
    big.set(WAV_HEADER, 0)
    handle.pushAudio(big) // 单片超限 → 计量封顶
    expect(handle.meterSeconds()).toBe(ASR_MAX_DURATION_SEC)
    handle.pushAudio(new Uint8Array(32_000)) // 超顶后分片丢弃
    handle.pushAudio(new Uint8Array(32_000)) // 通知只发一次
    expect(got.errors).toEqual([
      { code: 'max_duration_reached', message: expect.stringContaining('300') },
    ])
    handle.abort()
  })

  test('boundary chunk is truncated to the 300s cap: assembled audio ≤ 9.6MB, still transcribed', async () => {
    const { fetch, calls } = capturingFetch(() => sseResponse(['data: [DONE]\n\n']))
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    const maxBytes = ASR_MAX_DURATION_SEC * 32_000
    const big = new Uint8Array(maxBytes + 1) // 9.6MB+1：正好压线的边界分片
    big.set(WAV_HEADER, 0)
    big.set(new TextEncoder().encode('WAVE'), 8)
    handle.pushAudio(big)
    handle.pushAudio(new Uint8Array(1024)) // 超顶丢弃
    expect(got.errors.map((e) => e.code)).toEqual(['max_duration_reached'])
    handle.finish()
    await eventually(() => got.finals.length === 1)
    // 上送 Data URL 恰为 maxBytes 原始字节（base64 长度 = 4×ceil(n/3)），不再触发 10MB 守卫
    const part = (JSON.parse(calls[0]!.body) as { messages: Array<{ content: Array<{ input_audio: { data: string } }> }> })
      .messages[0]!.content[0]!
    const expectedB64 = 4 * Math.ceil(maxBytes / 3)
    expect(part.input_audio.data.length).toBe('data:audio/wav;base64,'.length + expectedB64)
    expect(handle.meterSeconds()).toBe(ASR_MAX_DURATION_SEC)
    expect(got.finals).toEqual([''])
  }, 20_000)
})

// ---------------------------------------------------------------------------
// Guards & direct transcribe (interface FILE 方法)
// ---------------------------------------------------------------------------

describe('mimo file adapter: guards & transcribe()', () => {
  test('>10MB rejected before any supplier call (413 semantics)', async () => {
    const { fetch, calls } = capturingFetch(() => {
      throw new Error('supplier must not be called')
    })
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch })
    const audio = new Uint8Array(MIMO_MAX_AUDIO_BYTES + 1)
    audio.set(WAV_HEADER, 0)
    audio.set(new TextEncoder().encode('WAVE'), 8)
    try {
      await adapter.transcribe({ audio })
      throw new Error('transcribe should have rejected')
    } catch (error) {
      expectMimoError(error, 'audio_too_large')
    }
    expect(calls.length).toBe(0)
  })

  test('non wav/mp3 rejected before any supplier call (magic-byte sniff, 不信任客户端 mime)', async () => {
    const { fetch, calls } = capturingFetch(() => {
      throw new Error('supplier must not be called')
    })
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch })
    const ogg = new TextEncoder().encode('OggS..........')
    try {
      await adapter.transcribe({ audio: ogg, audioEncoding: 'ogg' })
      throw new Error('transcribe should have rejected')
    } catch (error) {
      expectMimoError(error, 'unsupported_audio_format')
    }
    expect(calls.length).toBe(0)
    // 空音频同样拒绝
    try {
      await adapter.transcribe({ audio: new Uint8Array(0) })
      throw new Error('transcribe should have rejected')
    } catch (error) {
      expectMimoError(error, 'unsupported_audio_format')
    }
    expect(calls.length).toBe(0)
  })

  test('mp3 accepted: ID3 header and frame-sync variants, audio/mpeg data URL', async () => {
    for (const mp3 of [id3Bytes(), mp3FrameSyncBytes()]) {
      const { fetch, calls } = capturingFetch(() => sseResponse([deltaChunk('好的'), 'data: [DONE]\n\n']))
      const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
      const result = await adapter.transcribe({ audio: mp3 })
      expect(result.text).toBe('好的')
      const part = (JSON.parse(calls[0]!.body) as { messages: Array<{ content: Array<{ input_audio: { data: string; format: string } }> }> }).messages[0]!.content[0]!
      expect(part.input_audio.format).toBe('mp3')
      expect(part.input_audio.data.startsWith('data:audio/mpeg;base64,')).toBe(true)
    }
  })

  test('transcribe() resolves {text, seconds=bytes/32000} without partial callbacks', async () => {
    const audio = wavBytes(64_000) // 2s
    const { fetch } = capturingFetch(() => sseResponse([deltaChunk('一段'), deltaChunk('话'), 'data: [DONE]\n\n']))
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: fetch, timeoutMs: 2_000 })
    const result = await adapter.transcribe({ audio })
    expect(result.text).toBe('一段话')
    expect(result.seconds).toBeCloseTo(audio.length / 32_000, 6)
  })

  test('missing MIMO_API_KEY → not configured; startStream reports supplier_unavailable inertly', async () => {
    const adapter = new MimoFileAsrAdapter({ apiKey: undefined })
    expect(adapter.isConfigured()).toBe(false)
    const { ctx, got } = collectingCtx()
    const handle = adapter.startStream(ctx)
    handle.pushAudio(wavBytes(3_200))
    handle.finish()
    await Bun.sleep(20)
    expect(got.errors[0]!.code).toBe('supplier_unavailable')
    expect(got.finals).toEqual([])
    expect(handle.meterSeconds()).toBe(0)
  })

  test('language option passthrough + env loading (MIMO_API_KEY / MIMO_ASR_LANGUAGE / MIMO_TIMEOUT_MS)', async () => {
    const { fetch, calls } = capturingFetch(() => sseResponse(['data: [DONE]\n\n']))
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', language: 'zh', fetchImpl: fetch, timeoutMs: 2_000 })
    await adapter.transcribe({ audio: wavBytes(3_200) })
    const body = JSON.parse(calls[0]!.body) as { asr_options: { language: string } }
    expect(body.asr_options.language).toBe('zh')

    expect(mimoAsrOptionsFromEnv({ MIMO_API_KEY: ' env-key ', MIMO_ASR_LANGUAGE: 'en', MIMO_TIMEOUT_MS: '250' })).toEqual({
      apiKey: 'env-key',
      language: 'en',
      timeoutMs: 250,
    })
    // 非法/缺省值回落 auto 与 60s
    expect(mimoAsrOptionsFromEnv({ MIMO_API_KEY: 'k', MIMO_ASR_LANGUAGE: 'fr', MIMO_TIMEOUT_MS: 'nope' })).toEqual({
      apiKey: 'k',
      language: 'auto',
      timeoutMs: 60_000,
    })
  })

  test('direct transcribe() failure surfaces typed codes (timeout)', async () => {
    const impl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as typeof fetch
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k', fetchImpl: impl, timeoutMs: 30 })
    try {
      await adapter.transcribe({ audio: wavBytes(3_200) })
      throw new Error('transcribe should have rejected')
    } catch (error) {
      expectMimoError(error, 'upstream_timeout')
    }
  })
})

// ---------------------------------------------------------------------------
// Registry & default assembly
// ---------------------------------------------------------------------------

describe('mimo registration', () => {
  test('adapter registers into the AsrAdapterRegistry under id=mimo', () => {
    const registry = new AsrAdapterRegistry()
    const adapter = new MimoFileAsrAdapter({ apiKey: 'k' })
    registry.register(adapter)
    expect(registry.get('mimo')).toBe(adapter)
    expect(registry.ids()).toContain('mimo')
  })

  test('createDefaultAsrService wires the mimo adapter from env', () => {
    const auth = new RelayAuth(
      new AdminClient({ baseUrl: 'http://127.0.0.1:1' }),
      { secret: 'wiring-test-secret-0123456789abcdef', issuer: 'polo-admin', audience: 'polo-client' },
      { authCacheTtlMs: 1_000 },
    )
    const service = createDefaultAsrService({ auth, adminBaseUrl: 'http://127.0.0.1:1', env: { MIMO_API_KEY: 'k' } })
    expect(service.registry.has('mimo')).toBe(true)
    expect(service.registry.get('mimo')?.mode).toBe('FILE')
  })

  afterAll(() => {
    // 无常驻资源：所有上游均为 mock fetch / 已关闭流。
  })
})
