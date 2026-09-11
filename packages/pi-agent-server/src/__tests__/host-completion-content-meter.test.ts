import { describe, expect, it } from 'bun:test'
import { createContentMeter, encodeSlotKey, type SafeTerminalSnapshot } from '../host-completion-content-meter.ts'
import type { AssistantMessage, AssistantMessageEvent } from '@mariozechner/pi-ai'
import { TEXT_LIMIT } from '../host-completion-protocol.ts'

function assistantMessage(content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): AssistantMessage {
  return { role: 'assistant', content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'stop', timestamp: 0, ...extra } as unknown as AssistantMessage
}
const GOOD_USAGE = { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9 }
function finalMessage(text: string, extra: Record<string, unknown> = {}): AssistantMessage {
  return assistantMessage([{ type: 'text', text }], { usage: GOOD_USAGE, model: 'm', ...extra })
}
interface MeterProbe { over: boolean; inconsistent: boolean; tool: boolean }
interface MeterHarness {
  meter: ReturnType<typeof createContentMeter>
  probe: () => MeterProbe
  delta: (contentIndex: number, text: string) => AssistantMessageEvent
  thinkDelta: (contentIndex: number, text: string) => AssistantMessageEvent
  end: (contentIndex: number, text: string) => AssistantMessageEvent
  done: (reason: 'stop' | 'length' | 'toolUse', message: AssistantMessage) => AssistantMessageEvent
  error: (reason: 'aborted' | 'error', message: AssistantMessage) => AssistantMessageEvent
  finish: () => SafeTerminalSnapshot | null
}
function meterHarness(): MeterHarness {
  const meter = createContentMeter()
  const probe = (): MeterProbe => ({ over: meter.isBodyOverLimit(), inconsistent: meter.isSnapshotInconsistent(), tool: meter.hasToolContent() })
  return {
    probe,
    meter,
    delta: (contentIndex, text) => ({ type: 'text_delta', contentIndex, delta: text, partial: assistantMessage([]) }) as AssistantMessageEvent,
    thinkDelta: (contentIndex, text) => ({ type: 'thinking_delta', contentIndex, delta: text, partial: assistantMessage([]) }) as AssistantMessageEvent,
    end: (contentIndex, text) => ({ type: 'text_end', contentIndex, content: text, partial: assistantMessage([]) }) as AssistantMessageEvent,
    done: (reason, message) => ({ type: 'done', reason, message }) as AssistantMessageEvent,
    error: (reason, message) => ({ type: 'error', reason, error: message }) as AssistantMessageEvent,
    finish: () => {
      meter.flushPendingSurrogatesToLimit()
      return meter.snapshotTerminal()
    },
  }
}
describe('content meter: dedup and the 512KiB gate', () => {
  it('counts delta and end of the same logical string exactly once, even at 400KiB each', () => {
    const h = meterHarness()
    const body = 'a'.repeat(400_000)
    h.meter.onEvent(h.delta(0, body))
    h.meter.onEvent(h.end(0, body))
    h.meter.onEvent(h.done('stop', finalMessage(body)))
    expect(h.probe().over).toBe(false)
    expect(h.finish()?.text).toBe(body)
  })
  it('passes exactly 512KiB and latches the gate on the first byte over', () => {
    const exact = meterHarness()
    const body = 'a'.repeat(TEXT_LIMIT)
    exact.meter.onEvent(exact.delta(0, body))
    exact.meter.onEvent(exact.done('stop', finalMessage(body)))
    expect(exact.probe()).toMatchObject({ over: false, inconsistent: false, tool: false })
    expect(exact.finish()?.text).toBe(body)
    const over = meterHarness()
    over.meter.onEvent(over.delta(0, body + 'x'))
    expect(over.probe()).toMatchObject({ over: true })
    expect(over.finish()).toBeNull()
  })
  it('counts UTF-8 bytes, not JS characters, across multi-byte chunks', () => {
    const over = meterHarness()
    over.meter.onEvent(over.delta(0, '字'.repeat(174_763)))
    expect(over.probe()).toMatchObject({ over: true })
    const under = meterHarness()
    const body = '字'.repeat(174_762) + 'a'
    under.meter.onEvent(under.delta(0, body))
    under.meter.onEvent(under.done('stop', finalMessage(body)))
    expect(under.finish()?.text).toBe(body)
  })
  it('keeps a surrogate pair split across deltas intact and flushes the unpaired tail as a replacement', () => {
    const atLimit = meterHarness()
    const full = 'a'.repeat(524_284) + '\uD83D\uDE00'
    atLimit.meter.onEvent(atLimit.delta(0, 'a'.repeat(524_284) + '\uD83D'))
    expect(atLimit.probe()).toMatchObject({ over: false })
    atLimit.meter.onEvent(atLimit.delta(0, '\uDE00'))
    expect(atLimit.probe()).toMatchObject({ over: false })
    atLimit.meter.onEvent(atLimit.done('stop', finalMessage(full)))
    expect(atLimit.finish()?.text).toBe(full)
    const over = meterHarness()
    over.meter.onEvent(over.delta(0, 'a'.repeat(524_285) + '\uD83D'))
    expect(over.probe()).toMatchObject({ over: false })
    over.meter.onEvent(over.delta(0, '\uDE00'))
    expect(over.probe()).toMatchObject({ over: true })
    const orphan = meterHarness()
    const held = 'y'.repeat(524_286) + '\uD83D'
    orphan.meter.onEvent(orphan.thinkDelta(0, held))
    orphan.meter.onEvent(orphan.delta(1, 'ab'))
    expect(orphan.probe()).toMatchObject({ over: false })
    expect(orphan.meter.flushPendingSurrogatesToLimit()).toBe(true)
  })
  it('charges the union of forked paths and latches the inconsistent flag without choosing a side', () => {
    const h = meterHarness()
    h.meter.onEvent(h.end(0, 'A'))
    h.meter.onEvent(h.end(0, 'B'))
    expect(h.probe()).toMatchObject({ inconsistent: true })
    const boundary = meterHarness()
    boundary.meter.onEvent(boundary.end(0, 'a'.repeat(TEXT_LIMIT)))
    expect(boundary.probe()).toMatchObject({ over: false })
    boundary.meter.onEvent(boundary.end(0, 'b'))
    expect(boundary.probe()).toMatchObject({ over: true })
  })
  it('treats a prefix extension as one growing string, not a second charge', () => {
    const h = meterHarness()
    h.meter.onEvent(h.end(0, 'a'.repeat(400_000)))
    h.meter.onEvent(h.end(0, 'a'.repeat(400_001)))
    h.meter.onEvent(h.done('stop', finalMessage('a'.repeat(400_001))))
    expect(h.finish()?.text).toBe('a'.repeat(400_001))
  })
  it('adds text and thinking slots jointly across content kinds', () => {
    const over = meterHarness()
    over.meter.onEvent(over.thinkDelta(0, 'a'.repeat(300_000)))
    over.meter.onEvent(over.delta(1, 'b'.repeat(300_000)))
    expect(over.probe()).toMatchObject({ over: true })
    const atLimit = meterHarness()
    atLimit.meter.onEvent(atLimit.thinkDelta(0, 'a'.repeat(262_144)))
    atLimit.meter.onEvent(atLimit.delta(1, 'b'.repeat(262_144)))
    const joined = assistantMessage([{ type: 'thinking', thinking: 'a'.repeat(262_144) }, { type: 'text', text: 'b'.repeat(262_144) }], { usage: GOOD_USAGE, model: 'm' })
    atLimit.meter.onEvent(atLimit.done('stop', joined))
    expect(atLimit.finish()?.text).toBe('b'.repeat(262_144))
  })
  it('counts final-only text and thinking signatures carried by the done message', () => {
    const h = meterHarness()
    const message = assistantMessage([{ type: 'text', text: 'hi', textSignature: 'x'.repeat(TEXT_LIMIT + 1) }], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.done('stop', message))
    expect(h.probe()).toMatchObject({ over: true })
    const small = meterHarness()
    small.meter.onEvent(small.done('stop', finalMessage('hi', { responseModel: 'm' })))
    expect(small.probe()).toMatchObject({ over: false, inconsistent: false, tool: false })
  })
})
describe('content meter: tool representations', () => {
  it('charges consistent tool raw JSON and its parsed projection as max, not sum', () => {
    const h = meterHarness()
    const value = 'x'.repeat(400_000)
    const raw = `{"k":"${value}"}`
    h.meter.onEvent({ type: 'toolcall_delta', contentIndex: 0, delta: raw, partial: assistantMessage([]) } as AssistantMessageEvent)
    const message = assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: { k: value } }], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.done('toolUse', message))
    expect(h.probe()).toMatchObject({ inconsistent: false, over: false, tool: true })
  })
  it('flags a parseable raw tool stream that disagrees with the final parsed arguments', () => {
    const h = meterHarness()
    h.meter.onEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"k":1}', partial: assistantMessage([]) } as AssistantMessageEvent)
    const message = assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: { k: 2 } }], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.done('toolUse', message))
    expect(h.probe()).toMatchObject({ inconsistent: true })
    expect(h.probe()).not.toMatchObject({ over: true })
  })
  it('keeps two tool calls at different content indices in separate reconciliation groups', () => {
    const h = meterHarness()
    h.meter.onEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"a":1}', partial: assistantMessage([]) } as AssistantMessageEvent)
    h.meter.onEvent({ type: 'toolcall_delta', contentIndex: 1, delta: '{"b":2}', partial: assistantMessage([]) } as AssistantMessageEvent)
    const message = assistantMessage([
      { type: 'toolCall', id: 't1', name: 'f', arguments: { a: 1 } },
      { type: 'toolCall', id: 't2', name: 'g', arguments: { b: 2 } },
    ], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.done('toolUse', message))
    expect(h.probe()).toMatchObject({ inconsistent: false, over: false, tool: true })
  })
  it('lets walker overflow on a huge toolCall beat the tool rejection as result_too_large', () => {
    const h = meterHarness()
    const message = assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: { k: 'x'.repeat(TEXT_LIMIT + 1) } }], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.done('toolUse', message))
    expect(h.probe()).toMatchObject({ over: true, tool: true })
  })
  it('charges the aggregate parsed tool tree across field paths before the tool rejection', () => {
    const h = meterHarness()
    const args = { a: 'x'.repeat(300_000), b: { c: 'y'.repeat(300_000) } }
    const message = assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: args }], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.done('toolUse', message))
    expect(h.probe()).toMatchObject({ over: true })
    expect(h.probe().inconsistent).toBe(false)
  })
})
describe('content meter: typed structural identity', () => {
  it('encodes array index 0 and object property "0" as different slot identities', () => {
    expect(encodeSlotKey([{ kind: 'array-index', value: 0 }])).not.toBe(encodeSlotKey([{ kind: 'object-property', value: '0' }]))
    expect(encodeSlotKey([{ kind: 'scope', value: 'message' }, { kind: 'field', value: 'a' }, { kind: 'object-property', value: 'b' }])).not.toBe(encodeSlotKey([{ kind: 'scope', value: 'message' }, { kind: 'field', value: 'a.b' }]))
  })
  it('meters array-index and object-property paths as distinct slots end to end', () => {
    // Each representation alone stays under the gate...
    const alone = meterHarness()
    const payload = 'x'.repeat(300_000)
    alone.meter.onEvent(alone.done('stop', assistantMessage([{ type: 'providerBlock', payload: [payload] }], { usage: GOOD_USAGE, model: 'm' })))
    expect(alone.probe()).toMatchObject({ over: false })
    // ...but the same identical payload under array-index 0 AND object property "0" must occupy
    // two distinct slots: 2x300KiB latches result_too_large, while an alias would dedupe to 300KiB.
    const both = meterHarness()
    const identical = 'x'.repeat(300_000)
    const combined = assistantMessage([{ type: 'providerBlock', payload: [identical], extra: { '0': identical } }], { usage: GOOD_USAGE, model: 'm' })
    both.meter.onEvent(both.done('stop', combined))
    expect(both.probe()).toMatchObject({ over: true })
  })
  it('keeps adversarial property names, separators, and Unicode in distinct slots', () => {
    const h = meterHarness()
    const payload = 'x'.repeat(200_000)
    const message = assistantMessage([{ type: 'text', text: 'ok' }], { usage: GOOD_USAGE, model: 'm' })
    message.a = { b: payload }
    ;(message as Record<string, unknown>)['a.b'] = payload
    ;(message as Record<string, unknown>)['a|b'] = payload
    ;(message as Record<string, unknown>)['a:b'] = payload
    ;(message as Record<string, unknown>)['["a"]["b"]'] = payload
    ;(message as Record<string, unknown>)['信号.x'] = payload
    h.meter.onEvent(h.done('stop', message))
    expect(h.probe()).toMatchObject({ over: true })
    const single = meterHarness()
    const lone = assistantMessage([{ type: 'text', text: 'ok' }], { usage: GOOD_USAGE, model: 'm' })
    lone.a = { b: payload }
    single.meter.onEvent(single.done('stop', lone))
    expect(single.probe()).toMatchObject({ over: false })
  })
  it('keeps the same content index across different block kinds in distinct slots', () => {
    const h = meterHarness()
    const payload = 'x'.repeat(300_000)
    const message = assistantMessage([{ type: 'text', text: payload }, { type: 'thinking', thinking: payload }], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.delta(0, payload.slice(0, 1000)))
    h.meter.onEvent(h.done('stop', message))
    expect(h.probe()).toMatchObject({ over: true })
  })
})
describe('content meter: hostile block kinds and bounded snapshots', () => {
  it('treats hostile block kinds as ordinary unknown blocks without throwing or coercion', () => {
    const h = meterHarness()
    const kinds = ['__proto__', 'constructor', 'toString', 'a|b', '信号', 'hasOwnProperty']
    const blocks = kinds.map((kind, index) => ({ type: kind, [`v${index}`]: `x${index}` }))
    h.meter.onEvent(h.done('stop', assistantMessage(blocks, { usage: GOOD_USAGE, model: 'm' })))
    expect(h.probe()).toMatchObject({ over: false, inconsistent: false })
    expect(() => h.finish()).not.toThrow()
    expect(h.finish()?.text).toBe('')
    // An oversized hostile-kind block still latches the gate through the unknown-block walker.
    const over = meterHarness()
    const overBlocks = kinds.map((kind) => ({ type: kind, v: 'x'.repeat(120_000) }))
    over.meter.onEvent(over.done('stop', assistantMessage(overBlocks, { usage: GOOD_USAGE, model: 'm' })))
    expect(over.probe()).toMatchObject({ over: true })
  })
  it('skips the terminal snapshot once the projection budget is latched by huge sparse content', () => {
    let accessorCalls = 0
    const h = meterHarness()
    const content: unknown[] = new Array(70_000)
    content[0] = { type: 'text', text: 'x' }
    Object.defineProperty(content, 66_000, { get() { accessorCalls += 1; return { type: 'text', text: 'late' } }, enumerable: true })
    const message = assistantMessage([], { usage: GOOD_USAGE, model: 'm' })
    ;(message as { content: unknown }).content = content
    h.meter.onEvent(h.done('stop', message))
    expect(h.probe()).toMatchObject({ over: true })
    // The latched projection budget skips the terminal snapshot entirely: no second traversal and
    // no read of the late accessor beyond the latch point.
    expect(h.meter.snapshotTerminal()).toBeNull()
    expect(accessorCalls).toBe(0)
  })
  it('adopts the conservative double representation on pair exhaustion and hits result_too_large first', () => {
    const equal = meterHarness()
    const equalArgs = { big: 'x'.repeat(300_000), items: Array.from({ length: 8189 }, (_, i) => i) }
    equal.meter.onEvent({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify({ big: 'x'.repeat(300_000), items: Array.from({ length: 8189 }, (_, i) => i) }), partial: assistantMessage([]) } as AssistantMessageEvent)
    equal.meter.onEvent(equal.done('toolUse', assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: equalArgs }], { usage: GOOD_USAGE, model: 'm' })))
    expect(equal.probe()).toMatchObject({ over: false, inconsistent: false, tool: true })
    const exhausted = meterHarness()
    const exhaustArgs = { big: 'x'.repeat(300_000), items: Array.from({ length: 8190 }, (_, i) => i) }
    exhausted.meter.onEvent({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify({ big: 'x'.repeat(300_000), items: Array.from({ length: 8190 }, (_, i) => i) }), partial: assistantMessage([]) } as AssistantMessageEvent)
    exhausted.meter.onEvent(exhausted.done('toolUse', assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: exhaustArgs }], { usage: GOOD_USAGE, model: 'm' })))
    expect(exhausted.probe()).toMatchObject({ over: true, inconsistent: true })
  })
  it('adopts the conservative double representation on key exhaustion and hits result_too_large first', () => {
    const h = meterHarness()
    const args: Record<string, string> = {}
    for (let i = 0; i < 8193; i++) args[`k${i}`] = `v${'x'.repeat(40)}`
    const raw = JSON.stringify(args)
    h.meter.onEvent({ type: 'toolcall_delta', contentIndex: 0, delta: raw, partial: assistantMessage([]) } as AssistantMessageEvent)
    const message = assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: args }], { usage: GOOD_USAGE, model: 'm' })
    h.meter.onEvent(h.done('toolUse', message))
    // The node/projection budget latches during the tree walk, so result_too_large is the FIRST
    // outcome — the conservative double representation (raw + partial tree) is what pushes the
    // observed bytes over the gate; tool rejection can never mask it.
    expect(h.probe()).toMatchObject({ over: true })
  })
})
describe('content meter: terminal descriptor fail-fast and JSON-data domain', () => {
  it('treats non-enumerable canonical fields as absent and never releases their content', () => {
    const h = meterHarness()
    const block: Record<string, unknown> = { type: 'text' }
    Object.defineProperty(block, 'text', { value: 'SECRET', enumerable: false })
    const message = assistantMessage([block], { usage: GOOD_USAGE, model: 'm' })
    Object.defineProperty(message, 'model', { value: 'm', enumerable: false })
    h.meter.onEvent(h.done('stop', message))
    // The non-enumerable canonical text is domain-external: the meter latches fail-closed, so the
    // secret content can never be released (no text, no snapshot, result_too_large).
    expect(h.probe()).toMatchObject({ over: true })
    expect(h.meter.snapshotTerminal()).toBeNull()
    // No body ever exists for the stream to release: the secret content stays unmeasured and dead.
    expect(h.finish()).toBeNull()
  })
  it('latches on the first unsafe terminal descriptor and stops all later descriptor or value reads', () => {
    let usageAccessorCalls = 0
    let lateUsageAccessorCalls = 0
    let modelAccessorCalls = 0
    const h = meterHarness()
    // content boundary: the second block's text is an accessor — its descriptor is inspected after
    // the first block was metered fine, and the accessor must never be invoked.
    let firstBlockTextRead = false
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'text', get text() { firstBlockTextRead = true; return 'late' } },
    ]
    const usage: Record<string, unknown> = { input: 5 }
    Object.defineProperty(usage, 'output', { get() { usageAccessorCalls += 1; return 4 }, enumerable: true })
    Object.defineProperty(usage, 'cacheRead', { get() { lateUsageAccessorCalls += 1; return 0 }, enumerable: true })
    const message = assistantMessage(blocks, { model: 'm' })
    ;(message as { usage: unknown }).usage = usage
    Object.defineProperty(message, 'responseModel', { get() { modelAccessorCalls += 1; return 'r' }, enumerable: true })
    Object.defineProperty(message, 'model', { get() { modelAccessorCalls += 1; return 'm' }, enumerable: true })
    h.meter.onEvent(h.done('stop', message))
    // content/type/text boundary: the accessor-backed text latched before its value was read, so
    // the snapshot is skipped entirely and no stream body can exist.
    expect(firstBlockTextRead).toBe(false)
    expect(h.probe()).toMatchObject({ over: true })
    expect(h.finish()).toBeNull()
    // usage boundary: input consumed as data, the accessor latched, later usage keys untouched.
    expect(usageAccessorCalls).toBe(0)
    expect(lateUsageAccessorCalls).toBe(0)
    // responseModel/model boundary: neither accessor invoked after the earlier latch.
    expect(modelAccessorCalls).toBe(0)
  })
})
describe('content meter: exact semantic boundaries and fail-closed reads', () => {
  it('allows exactly 8192 semantic nodes and latches on the 8193rd', () => {
    const atLimit = meterHarness()
    const blocks = Array.from({ length: 8188 }, () => ({ type: 'w' }))
    blocks.push({ type: 'text', text: 'ok' })
    atLimit.meter.onEvent(atLimit.done('stop', assistantMessage(blocks, { usage: GOOD_USAGE, model: 'm' })))
    expect(atLimit.probe()).toMatchObject({ over: false })
    expect(atLimit.finish()?.text).toBe('ok')
    const over = meterHarness()
    const overBlocks = Array.from({ length: 8189 }, () => ({ type: 'w' }))
    overBlocks.push({ type: 'text', text: 'ok' })
    over.meter.onEvent(over.done('stop', assistantMessage(overBlocks, { usage: GOOD_USAGE, model: 'm' })))
    expect(over.probe()).toMatchObject({ over: true })
  })
  it('allows depth-16 containers and fails closed on depth-17 entry without enumerating them', () => {
    const nested = (levels: number): Record<string, unknown> => {
      let inner: Record<string, unknown> = { leaf: 'v' }
      for (let i = 0; i < levels; i++) inner = { nested: inner }
      return inner
    }
    const allowed = meterHarness()
    allowed.meter.onEvent(allowed.done('stop', assistantMessage([{ type: 'text', text: 'ok' }, { type: 'providerBlock', deep: nested(12) }], { usage: GOOD_USAGE, model: 'm' })))
    expect(allowed.probe()).toMatchObject({ over: false })
    expect(allowed.finish()?.text).toBe('ok')
    const latched = meterHarness()
    latched.meter.onEvent(latched.done('stop', assistantMessage([{ type: 'text', text: 'ok' }, { type: 'providerBlock', deep: nested(13) }], { usage: GOOD_USAGE, model: 'm' })))
    expect(latched.probe()).toMatchObject({ over: true })
  })
  it('latches the projection cap on primitive-heavy objects without counting primitive nodes', () => {
    const h = meterHarness()
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 70_000; i++) wide[`k${i}`] = i
    h.meter.onEvent(h.done('stop', assistantMessage([{ type: 'providerBlock', wide }], { usage: GOOD_USAGE, model: 'm' })))
    expect(h.probe()).toMatchObject({ over: true })
    const sparse = meterHarness()
    const narrow: Record<string, unknown> = {}
    for (let i = 0; i < 8192; i++) narrow[`k${i}`] = i
    sparse.meter.onEvent(sparse.done('stop', assistantMessage([{ type: 'providerBlock', narrow }], { usage: GOOD_USAGE, model: 'm' })))
    expect(sparse.probe()).toMatchObject({ over: false })
  })
  it('stops enumeration after the first violation and never invokes later accessors or Proxy traps', () => {
    let getterCalls = 0
    const h = meterHarness()
    const block: Record<string, unknown> = { type: 'providerBlock', big: 'x'.repeat(TEXT_LIMIT + 1) }
    Object.defineProperty(block, 'later', { get() { getterCalls += 1; return 1 }, enumerable: true })
    h.meter.onEvent(h.done('stop', assistantMessage([block], { usage: GOOD_USAGE, model: 'm' })))
    expect(h.probe()).toMatchObject({ over: true })
    expect(getterCalls).toBe(0)
    let accessorCalls = 0
    const accessorOnly = meterHarness()
    const accBlock: Record<string, unknown> = { type: 'providerBlock' }
    Object.defineProperty(accBlock, 'acc', { get() { accessorCalls += 1; return 'zz' }, enumerable: true })
    accessorOnly.meter.onEvent(accessorOnly.done('stop', assistantMessage([accBlock], { usage: GOOD_USAGE, model: 'm' })))
    expect(accessorOnly.probe()).toMatchObject({ over: true })
    expect(accessorCalls).toBe(0)
    let trapCalls = 0
    const hostile = meterHarness()
    const target = { inner: 'x'.repeat(TEXT_LIMIT + 1) }
    const proxy = new Proxy(target, {
      get: (t, key) => { trapCalls += 1; return Reflect.get(t, key) },
      has: (t, key) => { trapCalls += 1; return Reflect.has(t, key) },
      getPrototypeOf: (t) => { trapCalls += 1; return Object.getPrototypeOf(t) },
      ownKeys: (t) => { trapCalls += 1; return Reflect.ownKeys(t) },
      getOwnPropertyDescriptor: (t, key) => { trapCalls += 1; return Reflect.getOwnPropertyDescriptor(t, key) },
    })
    hostile.meter.onEvent(hostile.done('stop', assistantMessage([{ type: 'providerBlock', hostile: proxy }], { usage: GOOD_USAGE, model: 'm' })))
    expect(hostile.probe()).toMatchObject({ over: true })
    expect(trapCalls).toBe(0)
  })
  it('meters malformed non-array content through the semantic walker', () => {
    const h = meterHarness()
    const message = assistantMessage([], { usage: GOOD_USAGE, model: 'm' })
    ;(message as { content: unknown }).content = 'z'.repeat(TEXT_LIMIT + 1)
    h.meter.onEvent(h.done('stop', message))
    expect(h.probe()).toMatchObject({ over: true })
    const small = meterHarness()
    const smallMessage = assistantMessage([], { usage: GOOD_USAGE, model: 'm' })
    ;(smallMessage as { content: unknown }).content = 'just a string'
    small.meter.onEvent(small.done('stop', smallMessage))
    expect(small.probe()).toMatchObject({ over: false })
    expect(small.finish()?.text).toBe('')
  })
  it('builds the immutable terminal snapshot from safe reads and never re-reads the message', () => {
    const h = meterHarness()
    const usage = { ...GOOD_USAGE }
    const message = assistantMessage([{ type: 'text', text: 'hello' }], { usage, model: 'm', responseModel: 'm-final' })
    h.meter.onEvent(h.delta(0, 'hello'))
    h.meter.onEvent(h.done('stop', message))
    const snapshot = h.finish()
    expect(snapshot).toMatchObject({ text: 'hello', responseModel: 'm-final', model: 'm' })
    expect(snapshot?.usage).toEqual(GOOD_USAGE)
    // Mutating the provider message afterwards cannot change the immutable snapshot.
    message.usage = { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 999 }
    ;(message.content as Array<Record<string, unknown>>)[0].text = 'MUTATED'
    expect(snapshot?.text).toBe('hello')
    expect(snapshot?.usage).toEqual(GOOD_USAGE)
    // An accessor-backed usage field fails the snapshot conservative and never calls the getter.
    let getterCalls = 0
    const accessorMessage = assistantMessage([{ type: 'text', text: 'ok' }], { model: 'm' })
    const accessorUsage: Record<string, unknown> = {}
    Object.defineProperty(accessorUsage, 'input', { get() { getterCalls += 1; return 5 }, enumerable: true })
    ;(accessorMessage as { usage: unknown }).usage = accessorUsage
    const accessorMeter = meterHarness()
    accessorMeter.meter.onEvent(accessorMeter.done('stop', accessorMessage))
    expect(accessorMeter.finish()?.usage).toBeNull()
    expect(getterCalls).toBe(0)
  })
})
