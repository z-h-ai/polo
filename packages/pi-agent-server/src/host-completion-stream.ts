import type { AssistantMessage, AssistantMessageEvent } from '@mariozechner/pi-ai'
import { classifyTransportFailure, type TransportObservation } from './host-completion-policy.ts'
import { TEXT_LIMIT, type HostFailureKind, type HostResultUsage } from './host-completion-protocol.ts'
export type StreamVerdict = { kind: 'release'; status: 'completed' | 'partial'; text: string; usage: HostResultUsage }
  | { kind: 'failure'; failure: HostFailureKind; usage?: HostResultUsage }
interface Slot { canonical: string; bytes: number; base: string }
function countedBytes(value: string): number {
  const last = value.charCodeAt(value.length - 1)
  return last >= 0xD800 && last <= 0xDBFF ? Buffer.byteLength(value.slice(0, -1), 'utf8') : Buffer.byteLength(value, 'utf8')
}
function trieBytes(candidates: string[], cap: number): number {
  const root = new Map<number, unknown>()
  let edges = 0
  for (const candidate of candidates) {
    let node: Map<number, unknown> = root
    for (const byte of Buffer.from(candidate, 'utf8')) {
      let child = node.get(byte) as Map<number, unknown> | undefined
      if (!child) { child = new Map(); node.set(byte, child); if (++edges > cap) return cap + 1 }
      node = child
    }
  }
  return edges
}

function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true
  if (depth > 16 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a as object); return keys.length === Object.keys(b as object).length && keys.every((key) => key in (b as object) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1))
}

export function createHostStreamTracker(opts: {
  expectedModel: string; maxOutputTokens: number; jsonOutput: boolean; bedrock: boolean
  claim: (kind: HostFailureKind) => void
}) {
  const slots = new Map<string, Slot>()
  const lastArgs = new Map<string, unknown>()
  let observed = 0, sawToolContent = false, inconsistent = false
  let terminal: { type: 'done'; reason: string; message: AssistantMessage } | { type: 'error'; aborted: boolean } | null = null
  const fail = (failure: HostFailureKind, usage?: HostResultUsage): StreamVerdict => ({ kind: 'failure', failure, ...(usage ? { usage } : {}) })
  const classified = (observation: Readonly<TransportObservation>): HostFailureKind => classifyTransportFailure(observation, { deadlineExpired: false, providerFailed: true }) ?? 'provider_error_terminal'
  function projectTree(value: unknown, out: string[], depth: number, counter: { nodes: number }): void {
    if (depth > 16 || ++counter.nodes > 8192) { observed = TEXT_LIMIT + 1; return }
    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value)
      out.push(isArray ? `array:${value.length}` : 'object')
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) { if (!isArray) out.push(`key:${key}`); projectTree(item, out, depth + 1, counter) }
    } else out.push(`${typeof value}:${String(value)}`)
  }
  function walkBlocks(blocks: unknown[], add: (key: string, value: string) => void, toolKeys: string[]): void {
    (blocks as Array<Record<string, any>>).forEach((block, index) => {
      if (block.type === 'text') { add(`${index}|text`, block.text); add(`${index}|textsig`, block.textSignature) }
      else if (block.type === 'thinking') { add(`${index}|think`, block.thinking); add(`${index}|thinksig`, block.thinkingSignature) }
      else if (block.type === 'toolCall') {
        sawToolContent = true
        add(`${index}|toolid`, block.id); add(`${index}|toolname`, block.name); add(`${index}|toolsig`, block.thoughtSignature)
        const key = `${index}|tool`; lastArgs.set(`${key}args`, block.arguments ?? null); toolKeys.push(`${key}raw`)
        const projection: string[] = []; projectTree(block.arguments ?? null, projection, 0, { nodes: 0 })
        projection.forEach((item) => add(`${key}tree`, item))
      }
    })
  }
  function meterEvent(event: AssistantMessageEvent): void {
    const batch = new Map<string, string[]>()
    const toolKeys: string[] = []
    const add = (key: string, value: string): void => { if (typeof value === 'string' && value.length > 0) batch.set(key, [...(batch.get(key) ?? []), value]) }
    const append = (key: string, delta: string): void => {
      const slot = slots.get(key) ?? { canonical: '', bytes: 0, base: '' }
      slot.base += delta
      slots.set(key, slot)
      add(key, slot.base)
    }
    if (event.type === 'text_delta' || event.type === 'thinking_delta') append(event.type === 'text_delta' ? `${event.contentIndex}|text` : `${event.contentIndex}|think`, event.delta)
    else if (event.type === 'text_end' || event.type === 'thinking_end') add(event.type === 'text_end' ? `${event.contentIndex}|text` : `${event.contentIndex}|think`, event.content)
    else if (event.type === 'toolcall_delta' || event.type === 'toolcall_start') { if (event.type === 'toolcall_delta') append(`${event.contentIndex}|toolraw`, event.delta); sawToolContent = true }
    else if (event.type === 'toolcall_end') { walkBlocks([event.toolCall], add, toolKeys); sawToolContent = true }
    const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : (event as { partial?: AssistantMessage }).partial
    if (message && Array.isArray(message.content)) walkBlocks(message.content, add, toolKeys)
    if (event.type === 'done' && event.reason === 'toolUse') sawToolContent = true
    for (const [key, candidates] of batch) {
      const slot = slots.get(key) ?? { canonical: '', bytes: 0, base: '' }
      const unique = [...new Set([slot.canonical, ...candidates])]
      const longest = unique.reduce((a, b) => (b.length > a.length ? b : a))
      const forked = !unique.every((candidate) => candidate === longest || longest.startsWith(candidate))
      const next = forked ? trieBytes(unique, TEXT_LIMIT) : countedBytes(longest)
      observed += next - slot.bytes
      slots.set(key, { canonical: forked ? slot.canonical : longest, bytes: next, base: slot.base })
      if (forked) inconsistent = true
    }
    for (const key of toolKeys) {
      const rawSlot = slots.get(key)
      if (!rawSlot?.canonical) continue
      let parsed: unknown
      try { parsed = JSON.parse(rawSlot.canonical) } catch { continue }
      const treeSlot = slots.get(key.replace('toolraw', 'tooltree')) ?? { canonical: '', bytes: 0, base: '' }
      if (deepEqual(parsed, lastArgs.get(key.replace('toolraw', 'toolargs')))) {
        const group = Math.max(rawSlot.bytes, treeSlot.bytes)
        observed -= rawSlot.bytes + treeSlot.bytes - group
        rawSlot.bytes = group; treeSlot.bytes = 0
      } else inconsistent = true
    }
  }
  function onEvent(event: AssistantMessageEvent): void {
    meterEvent(event)
    if (observed > TEXT_LIMIT) return opts.claim('result_too_large')
    if (inconsistent) return opts.claim('unexpected_terminal')
    if (sawToolContent) return opts.claim('unexpected_terminal')
    if (terminal) return opts.claim('unexpected_terminal')
    if (event.type === 'done') terminal = { type: 'done', reason: event.reason, message: event.message }
    else if (event.type === 'error') terminal = { type: 'error', aborted: event.reason === 'aborted' }
  }
  function finish(observation: Readonly<TransportObservation>, deadlineExpired: boolean): StreamVerdict {
    if (deadlineExpired) return fail('deadline_exceeded')
    if (!terminal) return fail('unexpected_terminal')
    if (terminal.type === 'error' && terminal.aborted) return fail('provider_aborted')
    if (terminal.type === 'error' || observation.attempts !== 1) return fail(classified(observation))
    if (terminal.reason !== 'stop' && terminal.reason !== 'length') return fail('unexpected_terminal')
    const message = terminal.message
    const text = (message.content as Array<Record<string, any>>).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    if (!text.trim()) return fail('empty_text')
    const raw = message.usage as unknown as Record<string, unknown> | undefined
    const pick = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : -1)
    const rawInput = pick(raw?.input), output = pick(raw?.output), cacheRead = pick(raw?.cacheRead), cacheWrite = pick(raw?.cacheWrite), total = pick(raw?.totalTokens)
    const reportedModel = (message.responseModel?.trim() || message.model?.trim()) ?? ''
    const input = opts.bedrock ? rawInput - cacheRead - cacheWrite : rawInput
    if (Math.min(rawInput, output, cacheRead, cacheWrite, total) < 0 || input < 0 || input + cacheRead <= 0 || total !== input + output + cacheRead + cacheWrite || output > opts.maxOutputTokens) return fail('provider_usage_invalid')
    if (reportedModel !== opts.expectedModel) return fail('unexpected_terminal')
    const usage: HostResultUsage = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: total,
      reportedModel, terminalReason: terminal.reason as 'stop' | 'length', provenance: 'provider_final' }
    if (opts.jsonOutput) {
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return fail('json_object_required', usage) }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail('json_object_required', usage)
    }
    return { kind: 'release', status: terminal.reason === 'stop' ? 'completed' : 'partial', text, usage }
  }
  return { onEvent, finish }
}
