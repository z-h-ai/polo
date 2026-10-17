/**
 * GenUI ui-event loop (POO-103): strict URL parsing, the six-step host
 * validation (§7.2) including the cross-card impersonation rejection, rate
 * limiting, payloadSrc confinement, and the widgetState processing
 * (modelContext truncation + one-shot queue, privateState push, ack/error
 * delivery over the real DeepLinkCallbackBridge posting path).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

mock.module('electron', () => ({
  ipcMain: { on: () => {}, off: () => {} },
  webContents: { fromId: () => undefined },
}))
mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  // Same shape as webview-genui-partition.isolated.ts: bun shares one module
  // registry per test run, so whichever mock wins must satisfy every importer
  // (webview-security needs windowLog; the ui-event chain needs mainLog).
  return { mainLog: stubLog, windowLog: stubLog }
})

const { DeepLinkCallbackBridge } = await import('../deep-link-callback-bridge')
const { UiCardRegistry } = await import('../ui-card-registry')
const { UiEventRateLimiter } = await import('../genui-ui-event')
const {
  GENUI_MODEL_CONTEXT_MAX_BYTES,
  GENUI_UI_EVENT_MAX_PAYLOAD_BYTES,
  GENUI_UI_EVENT_RATE_LIMIT,
} = await import('@polo-ai/shared/protocol')
const {
  __resetGenUiUiEventForTests,
  handleUiEventUrl,
  parseUiEventDeepLink,
  setGenUiUiEventDeps,
  validateUiEvent,
} = await import('../genui-ui-event')

interface FakeWebContents {
  url: string
  messages: Array<{ payload: Record<string, unknown>; origin: string }>
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(script: string): Promise<void>
}

function createWebContents(url = 'file:///tmp/app/index.html'): FakeWebContents {
  return {
    url,
    messages: [],
    isDestroyed: () => false,
    getURL: () => url,
    async executeJavaScript(script: string) {
      const match = /^window\.postMessage\((.*), ("(?:[^"\\]|\\.)*")\)$/.exec(script)
      if (!match) throw new Error(`Unexpected script: ${script}`)
      this.messages.push({ payload: JSON.parse(match[1]!), origin: JSON.parse(match[2]!) })
    },
  }
}

const CARD_ID = 'card-a'
const SESSION_ID = 'session-a'

function buildUiEventUrl(overrides: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams({
    cardId: CARD_ID,
    eventId: 'evt-1',
    type: 'button-click',
    callbackId: 'callback-12345',
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined) as Array<[string, string]>),
  })
  return `poloai://action/ui-event/${SESSION_ID}?${params.toString()}`
}

describe('parseUiEventDeepLink', () => {
  it('accepts a well-formed ui-event URL', () => {
    const result = parseUiEventDeepLink(buildUiEventUrl())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.parsed.sessionId).toBe(SESSION_ID)
      expect(result.parsed.cardId).toBe(CARD_ID)
      expect(result.parsed.type).toBe('button-click')
    }
  })

  it('rejects non-poloai, non-action, and wrong-path URLs', () => {
    expect(parseUiEventDeepLink('https://action/ui-event/x?cardId=c').ok).toBe(false)
    expect(parseUiEventDeepLink('poloai://other/ui-event/x?cardId=c').ok).toBe(false)
    expect(parseUiEventDeepLink('poloai://action/send-message/x').ok).toBe(false)
    expect(parseUiEventDeepLink('poloai://action/ui-event').ok).toBe(false)
  })

  it('rejects a malformed session id in the path', () => {
    const result = parseUiEventDeepLink('poloai://action/ui-event/../escape?cardId=c&eventId=e&type=submit&callbackId=callback-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_payload')
  })

  it('rejects unknown and duplicated parameters', () => {
    const unknown = parseUiEventDeepLink(`${buildUiEventUrl()}&runTool=bash`)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.message).toContain('Unknown ui-event parameter')

    const duplicated = parseUiEventDeepLink(`${buildUiEventUrl()}&type=submit`)
    expect(duplicated.ok).toBe(false)
    if (!duplicated.ok) expect(duplicated.message).toContain('Duplicate')
  })

  it('rejects malformed cardId/eventId/type/callbackId', () => {
    expect(parseUiEventDeepLink(buildUiEventUrl({ cardId: 'bad id' })).ok).toBe(false)
    expect(parseUiEventDeepLink(buildUiEventUrl({ eventId: 'bad id!' })).ok).toBe(false)
    const badType = parseUiEventDeepLink(buildUiEventUrl({ type: 'run-tool' }))
    expect(badType.ok).toBe(false)
    if (!badType.ok) expect(badType.code).toBe('invalid_payload')
    expect(parseUiEventDeepLink(buildUiEventUrl({ callbackId: 'short' })).ok).toBe(false)
  })

  it('rejects payload + payloadSrc together and oversized inline payloads', () => {
    const both = parseUiEventDeepLink(buildUiEventUrl({ payload: '{}', payloadSrc: 'x.json' }))
    expect(both.ok).toBe(false)
    if (!both.ok) expect(both.code).toBe('invalid_payload')

    const big = 'x'.repeat(GENUI_UI_EVENT_MAX_PAYLOAD_BYTES + 1)
    const oversized = parseUiEventDeepLink(buildUiEventUrl({ payload: `{"s":"${big}"}` }))
    expect(oversized.ok).toBe(false)
    if (!oversized.ok) expect(oversized.code).toBe('payload_too_large')
  })
})

describe('validateUiEvent — the six §7.2 steps', () => {
  let clock: number
  let registry: InstanceType<typeof UiCardRegistry>
  let rateLimiter: InstanceType<typeof UiEventRateLimiter>
  let liveSessions: Set<string>
  let rootDir: string
  let dataDir: string

  function ctx() {
    return {
      registry,
      hasLiveSession: (sessionId: string) => liveSessions.has(sessionId),
      resolveSessionDataPath: (sessionId: string) => (liveSessions.has(sessionId) ? dataDir : null),
      rateLimiter,
    }
  }

  function parsedPayload(payload?: string) {
    const result = parseUiEventDeepLink(buildUiEventUrl(payload !== undefined ? { payload } : {}))
    if (!result.ok) throw new Error(`fixture parse failed: ${result.message}`)
    return result.parsed
  }

  beforeEach(() => {
    clock = 1_000_000
    registry = new UiCardRegistry({ now: () => clock })
    rateLimiter = new UiEventRateLimiter({ now: () => clock })
    liveSessions = new Set([SESSION_ID])
    rootDir = mkdtempSync(join(tmpdir(), 'genui-ui-event-'))
    dataDir = resolve(rootDir, 'data')
    mkdirSync(dataDir, { recursive: true })
    // Guest 101 renders card-a of session-a (declaring the ui-event bridge).
    registry.noteGuestAttached({
      guestWebContentsId: 101,
      hostWebContentsId: 1,
      sessionId: SESSION_ID,
      partition: `genui-app-${SESSION_ID}`,
      capabilities: ['ui-event'],
    })
    registry.registerCard({ sessionId: SESSION_ID, cardId: CARD_ID, guestWebContentsId: 101, hostWebContentsId: 1 })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('step 1: dead session → session_not_found', () => {
    liveSessions.delete(SESSION_ID)
    const verdict = validateUiEvent(parsedPayload(), 101, ctx())
    expect(verdict).toMatchObject({ ok: false, code: 'session_not_found' })
  })

  it('step 2: unregistered card in a session with other cards → card_not_registered; empty session → session_not_found', () => {
    const unknownCard = parseUiEventDeepLink(buildUiEventUrl({ cardId: 'card-zzz' }))
    if (!unknownCard.ok) throw new Error(unknownCard.message)
    // The session HAS registered cards (card-a), so the card is the problem.
    expect(validateUiEvent(unknownCard.parsed, 101, ctx())).toMatchObject({ ok: false, code: 'card_not_registered' })
    // With the registry emptied, the same event reads as a dead session.
    registry.clearSession(SESSION_ID)
    expect(validateUiEvent(unknownCard.parsed, 101, ctx())).toMatchObject({ ok: false, code: 'session_not_found' })
  })

  it('step 3 (CORE): cross-card impersonation — cardId belongs to card-a, sender is card-b’s guest → not_authorized', () => {
    // card-b renders in a DIFFERENT guest (102) of the SAME session.
    registry.noteGuestAttached({
      guestWebContentsId: 102,
      hostWebContentsId: 1,
      sessionId: SESSION_ID,
      partition: `genui-app-${SESSION_ID}`,
      capabilities: ['ui-event'],
    })
    registry.registerCard({ sessionId: SESSION_ID, cardId: 'card-b', guestWebContentsId: 102, hostWebContentsId: 1 })

    // Guest 102 (card-b) sends an event quoting cardId=card-a.
    const verdict = validateUiEvent(parsedPayload(), 102, ctx())
    expect(verdict).toMatchObject({ ok: false, code: 'not_authorized' })

    // The honest direction still passes.
    expect(validateUiEvent(parsedPayload(), 101, ctx()).ok).toBe(true)
  })

  it('step 4: a P1-style card without the ui-event declaration → capability_denied', () => {
    registry.noteGuestAttached({
      guestWebContentsId: 103,
      hostWebContentsId: 1,
      sessionId: SESSION_ID,
      partition: `genui-app-${SESSION_ID}`,
      capabilities: [],
    })
    registry.registerCard({ sessionId: SESSION_ID, cardId: 'card-p1', guestWebContentsId: 103, hostWebContentsId: 1 })
    const result = parseUiEventDeepLink(buildUiEventUrl({ cardId: 'card-p1' }))
    if (!result.ok) throw new Error(result.message)
    expect(validateUiEvent(result.parsed, 103, ctx())).toMatchObject({ ok: false, code: 'capability_denied' })
  })

  it('step 5: non-JSON / non-object payload → invalid_payload', () => {
    expect(validateUiEvent(parsedPayload('not-json'), 101, ctx())).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(validateUiEvent(parsedPayload('[1,2]'), 101, ctx())).toMatchObject({ ok: false, code: 'invalid_payload' })
  })

  it('step 5: inline payload at the cap passes; above the cap the parser rejects with payload_too_large', () => {
    const fit = `{"a":"${'x'.repeat(GENUI_UI_EVENT_MAX_PAYLOAD_BYTES - 10)}"}`
    expect(Buffer.byteLength(fit, 'utf8')).toBeLessThanOrEqual(GENUI_UI_EVENT_MAX_PAYLOAD_BYTES)
    expect(validateUiEvent(parsedPayload(fit), 101, ctx()).ok).toBe(true)

    const overflow = `{"a":"${'x'.repeat(GENUI_UI_EVENT_MAX_PAYLOAD_BYTES)}"}`
    const parsed = parseUiEventDeepLink(buildUiEventUrl({ payload: overflow }))
    expect(parsed).toMatchObject({ ok: false, code: 'payload_too_large' })
  })

  it('step 5: payloadSrc inside the session data/ dir is read; escaping it is rejected', () => {
    writeFileSync(resolve(dataDir, 'state.json'), '{"ok":true}')
    const inside = parseUiEventDeepLink(buildUiEventUrl({ payloadSrc: 'state.json' }))
    if (!inside.ok) throw new Error(inside.message)
    expect(validateUiEvent(inside.parsed, 101, ctx())).toMatchObject({ ok: true, payload: { ok: true } })

    const outsideFile = resolve(rootDir, 'outside.json')
    writeFileSync(outsideFile, '{"steal":true}')
    const outside = parseUiEventDeepLink(buildUiEventUrl({ payloadSrc: outsideFile }))
    if (!outside.ok) throw new Error(outside.message)
    expect(validateUiEvent(outside.parsed, 101, ctx())).toMatchObject({ ok: false, code: 'invalid_payload' })

    // Symlink escape: realpath containment must catch the walk-out.
    const secretDir = resolve(rootDir, 'secret')
    mkdirSync(secretDir)
    writeFileSync(resolve(secretDir, 'secret.json'), '{"secret":true}')
    symlinkSync(secretDir, resolve(dataDir, 'link'))
    const linked = parseUiEventDeepLink(buildUiEventUrl({ payloadSrc: 'link/secret.json' }))
    if (!linked.ok) throw new Error(linked.message)
    expect(validateUiEvent(linked.parsed, 101, ctx())).toMatchObject({ ok: false, code: 'invalid_payload' })

    // Missing file → invalid_payload.
    const missing = parseUiEventDeepLink(buildUiEventUrl({ payloadSrc: 'nope.json' }))
    if (!missing.ok) throw new Error(missing.message)
    expect(validateUiEvent(missing.parsed, 101, ctx())).toMatchObject({ ok: false, code: 'invalid_payload' })
  })

  it('step 5: an oversized payloadSrc file → payload_too_large', () => {
    const bigPath = resolve(dataDir, 'big.json')
    writeFileSync(bigPath, JSON.stringify({ blob: 'x'.repeat(1024 * 1024) }))
    const result = parseUiEventDeepLink(buildUiEventUrl({ payloadSrc: 'big.json' }))
    if (!result.ok) throw new Error(result.message)
    expect(validateUiEvent(result.parsed, 101, ctx())).toMatchObject({ ok: false, code: 'payload_too_large' })
  })

  it('step 6: the 11th event inside the sliding window → rate_limited', () => {
    const parsed = parsedPayload()
    for (let index = 0; index < GENUI_UI_EVENT_RATE_LIMIT; index += 1) {
      clock += 10 // 10ms apart — all inside the 1s window.
      expect(validateUiEvent(parsed, 101, ctx()).ok).toBe(true)
    }
    clock += 10
    expect(validateUiEvent(parsed, 101, ctx())).toMatchObject({ ok: false, code: 'rate_limited' })
    // After the window drains, events flow again.
    clock += 2000
    expect(validateUiEvent(parsed, 101, ctx()).ok).toBe(true)
  })
})

describe('handleUiEventUrl — delivery over the bridge', () => {
  let clock: number
  let registry: InstanceType<typeof UiCardRegistry>
  let bridge: InstanceType<typeof DeepLinkCallbackBridge>
  let guest101: FakeWebContents
  let guest102: FakeWebContents
  let queued: Array<{ sessionId: string; cardId: string; context: string }>
  let rootDir: string
  let dataDir: string

  function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 5))
  }

  beforeEach(async () => {
    clock = 2_000_000
    registry = new UiCardRegistry({ now: () => clock })
    guest101 = createWebContents()
    guest102 = createWebContents()
    const fakes = new Map<number, FakeWebContents>([[101, guest101], [102, guest102]])
    bridge = new DeepLinkCallbackBridge({
      registerIpc: false,
      now: () => clock,
      getWebContentsById: id => fakes.get(id),
    })
    queued = []
    rootDir = mkdtempSync(join(tmpdir(), 'genui-ui-event-delivery-'))
    dataDir = resolve(rootDir, 'data')
    mkdirSync(dataDir, { recursive: true })

    registry.noteGuestAttached({
      guestWebContentsId: 101,
      hostWebContentsId: 1,
      sessionId: SESSION_ID,
      partition: `genui-app-${SESSION_ID}`,
      capabilities: ['ui-event'],
    })
    registry.registerCard({ sessionId: SESSION_ID, cardId: CARD_ID, guestWebContentsId: 101, hostWebContentsId: 1 })

    setGenUiUiEventDeps({
      registry,
      bridge: bridge as unknown as import('../deep-link-callback-bridge').DeepLinkCallbackBridge,
      hasLiveSession: sessionId => sessionId === SESSION_ID,
      queueGenUiModelContext: (sessionId, entry) => {
        queued.push({ sessionId, ...entry })
        return true
      },
      resolveSessionDataPath: () => dataDir,
    })
  })

  afterEach(async () => {
    setGenUiUiEventDeps(null)
    __resetGenUiUiEventForTests()
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('accepts a valid event: ack + privateState ui_state go to the sender only, modelContext queued truncated', async () => {
    const longContext = '状态'.repeat(1200) // 7200 bytes of CJK > 2KB cap
    handleUiEventUrl(
      buildUiEventUrl({
        payload: JSON.stringify({ modelContext: longContext, privateState: { selected: [1, 2] }, extra: 'ignored' }),
        type: 'value-change',
      }),
      101,
    )
    await flush()

    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ sessionId: SESSION_ID, cardId: CARD_ID })
    expect(Buffer.byteLength(queued[0]!.context, 'utf8')).toBeLessThanOrEqual(GENUI_MODEL_CONTEXT_MAX_BYTES)

    expect(guest101.messages).toHaveLength(2)
    const uiState = guest101.messages.find(message => message.payload.type === 'poloai:event')
    expect(uiState).toBeDefined()
    expect(uiState!.payload.event).toMatchObject({
      type: 'ui_state',
      sessionId: SESSION_ID,
      cardId: CARD_ID,
      state: { selected: [1, 2] },
      modelContextTruncated: true,
    })
    const ack = guest101.messages.find(message => message.payload.type === 'poloai:ack')
    expect(ack).toBeDefined()
    expect(ack!.payload.result).toMatchObject({ sessionId: SESSION_ID, eventId: 'evt-1' })

    // The sibling guest receives nothing.
    expect(guest102.messages).toHaveLength(0)
  })

  it('a rejected event reports the §7.3 error code on the poloai:error channel', async () => {
    handleUiEventUrl(buildUiEventUrl({ cardId: 'card-unknown' }), 101)
    await flush()
    const error = guest101.messages.find(message => message.payload.type === 'poloai:error')
    expect(error).toBeDefined()
    expect(error!.payload.error).toMatchObject({ code: 'card_not_registered' })
  })

  it('cross-card impersonation through the full handler: sender 102 quoting card-a → not_authorized, nothing queued', async () => {
    registry.noteGuestAttached({
      guestWebContentsId: 102,
      hostWebContentsId: 1,
      sessionId: SESSION_ID,
      partition: `genui-app-${SESSION_ID}`,
      capabilities: ['ui-event'],
    })
    registry.registerCard({ sessionId: SESSION_ID, cardId: 'card-b', guestWebContentsId: 102, hostWebContentsId: 1 })

    handleUiEventUrl(buildUiEventUrl({ cardId: CARD_ID, payload: '{"modelContext":"steal"}' }), 102)
    await flush()

    const error = guest102.messages.find(message => message.payload.type === 'poloai:error')
    expect(error).toBeDefined()
    expect(error!.payload.error).toMatchObject({ code: 'not_authorized' })
    expect(queued).toHaveLength(0)
    expect(guest101.messages).toHaveLength(0)
  })

  it('an accepted event binds the callback to the session: later session events reach the card', async () => {
    handleUiEventUrl(buildUiEventUrl(), 101)
    await flush()

    bridge.handleSessionEvent({ type: 'text_complete', sessionId: SESSION_ID, text: 'done' } as never)
    await flush()

    const turnEvent = guest101.messages.filter(message => message.payload.type === 'poloai:event')
    expect(turnEvent.length).toBeGreaterThanOrEqual(1)
    expect(turnEvent.at(-1)!.payload.event).toMatchObject({ type: 'text_complete', sessionId: SESSION_ID })
  })

  it('rate limiting trips through the full handler (burst above 10/s, one reused callbackId per card)', async () => {
    let rateLimited = false
    let acked = 0
    for (let index = 0; index < GENUI_UI_EVENT_RATE_LIMIT + 4; index += 1) {
      handleUiEventUrl(
        // The app contract: ONE callbackId per card, reused across events —
        // registerCallback refreshes it in place instead of burning a new
        // per-page slot. Only eventId rotates.
        buildUiEventUrl({ eventId: `evt-${index}` }),
        101,
      )
      await flush()
    }
    for (const message of guest101.messages) {
      if (message.payload.type === 'poloai:ack') acked += 1
      if (message.payload.type === 'poloai:error') {
        const error = message.payload.error as { code?: string }
        if (error?.code === 'rate_limited') rateLimited = true
      }
    }
    expect(rateLimited).toBe(true)
    expect(acked).toBe(GENUI_UI_EVENT_RATE_LIMIT)
  })

  it('an unusable URL without a valid callbackId is dropped silently', async () => {
    handleUiEventUrl('poloai://action/ui-event/x?cardId=c&eventId=e&type=submit&callbackId=bad', 101)
    await flush()
    expect(guest101.messages).toHaveLength(0)
  })
})
