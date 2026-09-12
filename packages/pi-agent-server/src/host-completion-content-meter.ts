import { types } from 'node:util'
import type { AssistantMessage, AssistantMessageEvent } from '@mariozechner/pi-ai'
import { TEXT_LIMIT } from './host-completion-protocol.ts'
import { compareJsonData, createComparisonBudget, forEachOwnEnumerableDataProperty, isInertJsonDataArray, isInertJsonDataObject, readArrayElement, readArrayLength, readOwnDescriptor, readOwnEnumerableDataDescriptor } from './host-completion-json-data.ts'
// Single responsibility: map Host/Pi message semantics onto an auditable body-metering result
// (R12 §6.3). Owns typed slot identity, semantic/projection budgets, the 512KiB UTF-8 meter,
// Unicode pending-surrogate handling, tool raw/tree group bookkeeping with max-or-double
// representation strategy, the fail-fast content latch, and the immutable safe terminal snapshot
// so `finish()` never re-reads provider-controlled objects. Does not own route/credential policy,
// Pi registration, transport classification, terminal winner, usage legality or body release.

// Typed structural slot identity (R12 §6.4): discriminated segments encoded with JSON.stringify.
// Array index 0 and object property "0" are different kinds; separators, quotes, brackets,
// JSON-like text or Unicode inside property names cannot alias another slot; tool raw, parsed-tree
// and group identities are exact opaque keys — there is no startsWith group scan.
export type HostSlotSegment =
  | { kind: 'scope'; value: 'message' | 'content' }
  | { kind: 'content-index'; value: number }
  | { kind: 'block-kind'; value: string }
  | { kind: 'field'; value: string }
  | { kind: 'array-index'; value: number }
  | { kind: 'object-property'; value: string }
  | { kind: 'representation'; value: 'tool-raw' | 'tool-tree' }
export const encodeSlotKey = (segments: HostSlotSegment[]): string => JSON.stringify(segments)
export const contentPath = (index: number): HostSlotSegment[] => [{ kind: 'scope', value: 'content' }, { kind: 'content-index', value: index }]
// Canonical block fields per kind: [property, slot name]. Delta append paths and absolute block
// canonical paths share the identical segments so both dedupe into one logical slot. A Map keeps
// hostile kinds like `__proto__`/`constructor`/`toString` from hitting inherited properties —
// every unrecognised kind is an ordinary unknown block (R12 §6.4).
const CANONICAL_BLOCK_FIELDS = new Map<string, Array<[string, string]>>([
  ['text', [['text', 'text'], ['textSignature', 'textSignature']]],
  ['thinking', [['thinking', 'thinking'], ['thinkingSignature', 'thinkingSignature']]],
  ['toolCall', [['id', 'id'], ['name', 'name'], ['thoughtSignature', 'thoughtSignature'], ['arguments', 'arguments']]],
])
// Message fields carrying stream identity or accounting — never content bytes.
const MESSAGE_IDENTITY_FIELDS = new Set(['content', 'usage', 'stopReason', 'timestamp', 'api', 'provider', 'model', 'responseModel', 'responseId', 'role'])
// Semantic budget invariants (R12 §6.5): nodes count only entered string/array/non-null-object
// nodes (message root 1, actual content array 1, each block object 1, each canonical/unknown
// string/container 1; primitives are never nodes) — node 8192 allowed, the 8193rd latch-claims
// result_too_large. Depth runs from the message root at depth 0; depth 16 allowed, depth-17 entry
// latches without enumeration. projectionWork charges every inspected own enumerable object key
// and every visited array position — 65536 allowed, the 65537th latches before descriptor/value.
const NODE_BUDGET = 8192
const NODE_DEPTH_LIMIT = 16
const PROJECTION_WORK_CAP = 65_536
interface SemanticBudget { nodes: number; projectionWork: number; dead: boolean }
// Unicode pending invariant: only a delta working string holds back a trailing unpaired high
// surrogate (the next delta's low surrogate joins it into one 4-byte code point); absolute
// snapshots and terminal reconciliation pass pending=false, settling it as a 3-byte replacement
// before the 512KiB gate.
function countedBytes(value: string, pending: boolean): number {
  const last = value.charCodeAt(value.length - 1)
  return pending && last >= 0xD800 && last <= 0xDBFF ? Buffer.byteLength(value.slice(0, -1), 'utf8') : Buffer.byteLength(value, 'utf8')
}
function trieBytes(candidates: string[], cap: number): number {
  const root = new Map<number, unknown>()
  let edges = 0
  for (const candidate of candidates) {
    let node: Map<number, unknown> = root
    for (const byte of Buffer.from(candidate, 'utf8')) {
      let child = node.get(byte) as Map<number, unknown> | undefined
      if (!child) {
        child = new Map()
        node.set(byte, child)
        edges += 1
        if (edges > cap) return cap + 1
      }
      node = child
    }
  }
  return edges
}
// Immutable, provider-independent terminal snapshot: copied primitives only. `finish()` consumes
// this instead of re-reading the hostile message object (R12 §6.7).
export interface SafeTerminalSnapshot {
  text: string
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null
  responseModel: string
  model: string
}
// Usage capture taken eagerly at the `usage` yield during message projection (R9 issue 0):
// 'ok' carries validated numbers so the terminal snapshot never re-reads the provider usage
// object; 'none' means usage was absent or incomplete without a malformed value; 'latched'
// means the shared budget is dead.
type UsageCapture = { status: 'ok'; usage: NonNullable<SafeTerminalSnapshot['usage']> } | { status: 'none' } | { status: 'latched' }
export interface ContentMeter {
  onEvent(event: AssistantMessageEvent): void
  isBodyOverLimit(): boolean
  isSnapshotInconsistent(): boolean
  hasToolContent(): boolean
  snapshotTerminal(): SafeTerminalSnapshot | null
  flushPendingSurrogatesToLimit(): boolean
}
interface Slot { canonical: string; bytes: number; base: string }
interface ToolGroupState { rawSlotKey: string; treeSlotKeys: string[]; snapshotArgs: unknown }
type AddString = (segments: HostSlotSegment[], value: string) => void
export function createContentMeter(): ContentMeter {
  const slots = new Map<string, Slot>()
  const toolGroups = new Map<string, ToolGroupState>()
  let observed = 0, sawToolContent = false, inconsistent = false
  let lastDoneSnapshot: SafeTerminalSnapshot | null = null
  const latchSemantic = (budget: SemanticBudget): false => {
    budget.dead = true
    observed = TEXT_LIMIT + 1
    return false
  }
  const charge = (budget: SemanticBudget, counter: 'nodes' | 'projectionWork', cap: number): boolean => {
    if (budget.dead) return false
    budget[counter] += 1
    if (budget[counter] > cap) return latchSemantic(budget)
    return true
  }
  // Semantic walk invariant: each entered string/array/non-null-plain-object node charges one node
  // unit at its own depth (children depth+1); primitive leaves are skipped uncharged; depth-17
  // entry, Proxies and non-plain objects latch dead without enumerating contents.
  function walkSemantic(value: unknown, segments: HostSlotSegment[], depth: number, budget: SemanticBudget, add: AddString): void {
    if (budget.dead) return
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return
    if (depth > NODE_DEPTH_LIMIT) {
      latchSemantic(budget)
      return
    }
    if (!charge(budget, 'nodes', NODE_BUDGET)) return
    if (typeof value === 'string') {
      if (value.length > 0) add(segments, value)
      return
    }
    if (Array.isArray(value)) {
      if (types.isProxy(value)) {
        latchSemantic(budget)
        return
      }
      const length = readArrayLength(value)
      if (length === null) {
        latchSemantic(budget)
        return
      }
      for (let index = 0; index < length; index++) {
        if (budget.dead) return
        if (!charge(budget, 'projectionWork', PROJECTION_WORK_CAP)) return
        const element = readArrayElement(value, index)
        if (element.kind === 'missing') continue
        if (element.kind === 'unsafe') {
          latchSemantic(budget)
          return
        }
        walkSemantic(element.value, [...segments, { kind: 'array-index', value: index }], depth + 1, budget, add)
      }
      return
    }
    if (!isInertJsonDataObject(value)) {
      latchSemantic(budget)
      return
    }
    for (const [key, item] of forEachOwnEnumerableDataProperty(value, () => charge(budget, 'projectionWork', PROJECTION_WORK_CAP), () => latchSemantic(budget))) {
      if (budget.dead) return
      walkSemantic(item, [...segments, { kind: 'object-property', value: key }], depth + 1, budget, add)
    }
  }
  // Eager usage validation (R9 issue 0): the five required numbers are read and validated under
  // the shared monotonic budget at the moment `usage` is projected, so a malformed first value
  // latches before ANY later message descriptor can be enumerated. A missing key only leaves the
  // usage unset; a present-but-malformed data value latches immediately (never reinterpreted as
  // missing or zero). No later usage key is read after the first malformed value.
  function captureUsageNumbers(usageSource: object, budget: SemanticBudget, latchUnsafe: () => void): UsageCapture {
    let input: number | null = null
    let output: number | null = null
    let cacheRead: number | null = null
    let cacheWrite: number | null = null
    let totalTokens: number | null = null
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
      if (budget.dead) return { status: 'latched' }
      if (!charge(budget, 'projectionWork', PROJECTION_WORK_CAP)) return { status: 'latched' }
      const descriptor = readOwnEnumerableDataDescriptor(usageSource, key)
      if (descriptor.kind === 'unsafe') {
        latchUnsafe()
        return { status: 'latched' }
      }
      if (descriptor.kind !== 'data') continue
      const value = descriptor.value
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        latchUnsafe()
        return { status: 'latched' }
      }
      if (key === 'input') input = value
      else if (key === 'output') output = value
      else if (key === 'cacheRead') cacheRead = value
      else if (key === 'cacheWrite') cacheWrite = value
      else totalTokens = value
    }
    if (budget.dead) return { status: 'latched' }
    return input !== null && output !== null && cacheRead !== null && cacheWrite !== null && totalTokens !== null
      ? { status: 'ok', usage: { input, output, cacheRead, cacheWrite, totalTokens } }
      : { status: 'none' }
  }
  function meterMessage(message: unknown, add: AddString, budget: SemanticBudget): UsageCapture {
    if (budget.dead || message === null || typeof message !== 'object') return { status: 'none' }
    if (!isInertJsonDataObject(message)) {
      latchSemantic(budget)
      return { status: 'latched' }
    }
    if (!charge(budget, 'nodes', NODE_BUDGET)) return { status: 'latched' }
    const contentDescriptor = readOwnEnumerableDataDescriptor(message, 'content')
    if (contentDescriptor.kind === 'unsafe') {
      latchSemantic(budget)
      return { status: 'latched' }
    }
    const content = contentDescriptor.kind === 'data' ? contentDescriptor.value : null
    if (content !== null && isInertJsonDataArray(content)) {
      if (!charge(budget, 'nodes', NODE_BUDGET)) return { status: 'latched' }
      const length = readArrayLength(content)
      if (length === null) {
        latchSemantic(budget)
        return { status: 'latched' }
      }
      for (let index = 0; index < length; index++) {
        if (budget.dead) return { status: 'latched' }
        if (!charge(budget, 'projectionWork', PROJECTION_WORK_CAP)) return { status: 'latched' }
        const element = readArrayElement(content, index)
        if (element.kind === 'missing') continue
        if (element.kind === 'unsafe') {
          latchSemantic(budget)
          return { status: 'latched' }
        }
        meterBlock(element.value, index, add, budget)
      }
    } else if (content !== null) {
      // Malformed (non-array) content is metered through the semantic walker at its typed path.
      walkSemantic(content, [{ kind: 'scope', value: 'message' }, { kind: 'field', value: 'content' }], 1, budget, add)
    }
    const latchMessageProjection = (): void => {
      latchSemantic(budget)
    }
    let usageCapture: UsageCapture = { status: 'none' }
    for (const [field, value] of forEachOwnEnumerableDataProperty(message, () => charge(budget, 'projectionWork', PROJECTION_WORK_CAP), latchMessageProjection)) {
      if (budget.dead) return { status: 'latched' }
      if (field === 'content') continue
      // Outer usage fail-fast with in-place validation (R14 §6.3, R9 issue 0): the usage value
      // shape AND its five required numbers are validated at the usage yield itself, so a
      // primitive, class, array or Proxy usage — or any malformed first number — latches before
      // the generator can enumerate a later descriptor (responseModel, model, etc.).
      if (field === 'usage') {
        if (!isInertJsonDataObject(value)) {
          latchSemantic(budget)
          return { status: 'latched' }
        }
        usageCapture = captureUsageNumbers(value, budget, latchMessageProjection)
        if (usageCapture.status === 'latched') return usageCapture
        continue
      }
      // Present-but-wrong-typed provider identity data fails closed at the yield itself (R9
      // issue 1): the yielded value is the already-materialized descriptor data, so the type
      // check reads nothing new — and no later descriptor is ever enumerated after it latches.
      if ((field === 'responseModel' || field === 'model') && typeof value !== 'string') {
        latchSemantic(budget)
        return { status: 'latched' }
      }
      if (!MESSAGE_IDENTITY_FIELDS.has(field)) walkSemantic(value, [{ kind: 'scope', value: 'message' }, { kind: 'field', value: field }], 1, budget, add)
    }
    if (budget.dead) return { status: 'latched' }
    return usageCapture
  }
  function meterBlock(block: unknown, index: number, add: AddString, budget: SemanticBudget): void {
    if (budget.dead) return
    if (block === null || typeof block !== 'object') {
      walkSemantic(block, [...contentPath(index)], 2, budget, add)
      return
    }
    if (!isInertJsonDataObject(block)) {
      latchSemantic(budget)
      return
    }
    if (!charge(budget, 'nodes', NODE_BUDGET)) return
    const typeDescriptor = readOwnEnumerableDataDescriptor(block, 'type')
    // The block discriminator is only ever a descriptor-safe string; String() on a hostile value
    // is forbidden (R12 §6.4), so anything else fails closed.
    if (typeDescriptor.kind !== 'data' || typeof typeDescriptor.value !== 'string') {
      latchSemantic(budget)
      return
    }
    const blockKind = typeDescriptor.value
    const blockPath: HostSlotSegment[] = [...contentPath(index), { kind: 'block-kind', value: blockKind }]
    if (blockKind === 'toolCall') sawToolContent = true
    const canonicalFields = CANONICAL_BLOCK_FIELDS.get(blockKind)
    if (canonicalFields === undefined) {
      for (const [field, value] of forEachOwnEnumerableDataProperty(block, () => charge(budget, 'projectionWork', PROJECTION_WORK_CAP), () => latchSemantic(budget))) {
        if (budget.dead) return
        // The structural `type` discriminator is framing, not content; its value is already the
        // block-kind identity segment of every path in this block.
        if (field === 'type') continue
        walkSemantic(value, [...blockPath, { kind: 'field', value: field }], 3, budget, add)
      }
      return
    }
    for (const [property, slotName] of canonicalFields) {
      if (budget.dead) return
      const descriptor = readOwnEnumerableDataDescriptor(block, property)
      if (descriptor.kind === 'unsafe') {
        latchSemantic(budget)
        return
      }
      if (descriptor.kind === 'missing') continue
      const value = descriptor.value
      if (property === 'arguments') {
        meterToolArguments(index, value, add, budget)
        continue
      }
      // A canonical string counts as one node and is metered into its dedicated slot; a canonical
      // container enters the semantic walker; primitives are neither counted nor metered.
      if (typeof value === 'string') {
        if (charge(budget, 'nodes', NODE_BUDGET)) add([...blockPath, { kind: 'field', value: slotName }], value)
      } else if (value !== null && typeof value === 'object') {
        walkSemantic(value, [...blockPath, { kind: 'field', value: slotName }], 3, budget, add)
      }
    }
    for (const [field, value] of forEachOwnEnumerableDataProperty(block, () => charge(budget, 'projectionWork', PROJECTION_WORK_CAP), () => latchSemantic(budget))) {
      if (budget.dead) return
      if (field === 'type' || canonicalFields.some(([property]) => property === field)) continue
      walkSemantic(value, [...blockPath, { kind: 'field', value: field }], 3, budget, add)
    }
  }
  function meterToolArguments(index: number, value: unknown, add: AddString, budget: SemanticBudget): void {
    const groupPath: HostSlotSegment[] = [...contentPath(index), { kind: 'block-kind', value: 'toolCall' }]
    const groupKey = encodeSlotKey(groupPath)
    let group = toolGroups.get(groupKey)
    if (group === undefined) {
      group = {
        rawSlotKey: encodeSlotKey([...groupPath, { kind: 'representation', value: 'tool-raw' }, { kind: 'field', value: 'rawJson' }]),
        treeSlotKeys: [],
        snapshotArgs: null,
      }
      toolGroups.set(groupKey, group)
    }
    const resolvedGroup = group
    resolvedGroup.snapshotArgs = value ?? null
    const treeRoot: HostSlotSegment[] = [...groupPath, { kind: 'representation', value: 'tool-tree' }, { kind: 'field', value: 'arguments' }]
    walkSemantic(value, treeRoot, 3, budget, (segments, text) => {
      const treeKey = encodeSlotKey(segments)
      if (!resolvedGroup.treeSlotKeys.includes(treeKey)) resolvedGroup.treeSlotKeys.push(treeKey)
      add(segments, text)
    })
  }
  // Tool raw/tree reconcile invariant: the raw JSON string and the structured arguments are two
  // representations of one tool call. When the raw string parses and the bounded comparison equals
  // the snapshot, the group contributes max(raw, tree) — tree slots zeroed, raw slot carries the
  // group. Any comparison reason other than equal (budget, depth, unsafe shape or difference)
  // keeps both representations counted and latches `inconsistent`; an unparseable raw keeps both
  // counted without a mismatch mark.
  function reconcileToolGroup(group: ToolGroupState): void {
    const rawSlot = slots.get(group.rawSlotKey)
    if (rawSlot === undefined || rawSlot.canonical.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(rawSlot.canonical)
    } catch {
      return
    }
    const comparison = createComparisonBudget()
    const outcome = compareJsonData(parsed, group.snapshotArgs, 0, comparison)
    let treeBytes = 0
    for (const treeKey of group.treeSlotKeys) {
      const treeSlot = slots.get(treeKey)
      if (treeSlot === undefined) continue
      treeBytes += treeSlot.bytes
      if (outcome === 'equal') treeSlot.bytes = 0
    }
    if (outcome === 'equal') {
      const groupBytes = Math.max(rawSlot.bytes, treeBytes)
      observed -= rawSlot.bytes + treeBytes - groupBytes
      rawSlot.bytes = groupBytes
    } else {
      inconsistent = true
    }
  }
  // Immutable terminal snapshot: text blocks joined, five raw usage numbers and both model
  // identities copied through descriptor-safe reads. Any unsafe shape yields the conservative
  // empty/null variant; stream policy decides the final failure kind.
  // Immutable terminal snapshot (fail-fast, R12 §6.3): consumes the SAME projection budget as the
  // semantic walk — every content position and usage key costs projection work, every latch stops
  // all further provider reads, and a latched budget skips the snapshot entirely (the caller then
  // sees the conservative empty/null snapshot). Unsafe shapes yield the conservative empty/null
  // variant; stream policy decides the final failure kind.
  function buildTerminalSnapshot(message: unknown, budget: SemanticBudget, latchUnsafe: () => void, usageCapture: UsageCapture): SafeTerminalSnapshot {
    const snapshot: SafeTerminalSnapshot = { text: '', usage: null, responseModel: '', model: '' }
    if (budget.dead) return snapshot
    if (message === null || typeof message !== 'object' || !isInertJsonDataObject(message)) return snapshot
    const contentDescriptor = readOwnEnumerableDataDescriptor(message, 'content')
    if (contentDescriptor.kind === 'unsafe') {
      latchUnsafe()
      return snapshot
    }
    if (budget.dead) return snapshot
    const content = contentDescriptor.kind === 'data' && isInertJsonDataArray(contentDescriptor.value) ? contentDescriptor.value : null
    if (content !== null) {
      const length = readArrayLength(content)
      const parts: string[] = []
      if (length !== null) {
        for (let index = 0; index < length; index++) {
          if (budget.dead) return snapshot
          if (!charge(budget, 'projectionWork', PROJECTION_WORK_CAP)) return snapshot
          const element = readArrayElement(content, index)
          if (element.kind !== 'data' || !isInertJsonDataObject(element.value)) continue
          const typeDescriptor = readOwnEnumerableDataDescriptor(element.value, 'type')
          if (typeDescriptor.kind === 'unsafe') {
            latchUnsafe()
            return snapshot
          }
          if (budget.dead) return snapshot
          if (typeDescriptor.kind !== 'data' || typeDescriptor.value !== 'text') continue
          const textDescriptor = readOwnEnumerableDataDescriptor(element.value, 'text')
          if (textDescriptor.kind === 'unsafe') {
            latchUnsafe()
            return snapshot
          }
          if (budget.dead) return snapshot
          if (textDescriptor.kind === 'data' && typeof textDescriptor.value === 'string') parts.push(textDescriptor.value)
        }
      }
      snapshot.text = parts.join('')
    }
    // Usage numbers were validated eagerly during message projection (R9 issue 0): the captured
    // values are reused here and the provider usage object is never re-read. Capture 'none'
    // (usage absent from the enumerated keys) must still fail closed on a non-enumerable or
    // accessor usage descriptor — a present unsafe field is never disguised as absent.
    if (usageCapture.status === 'latched') return snapshot
    if (usageCapture.status === 'ok') {
      snapshot.usage = usageCapture.usage
    } else {
      const usageDescriptor = readOwnEnumerableDataDescriptor(message, 'usage')
      if (usageDescriptor.kind === 'unsafe' || usageDescriptor.kind === 'data') {
        latchUnsafe()
        return snapshot
      }
    }
    if (budget.dead) return snapshot
    // Present-but-wrong-typed provider identity data fails closed (R9 issue 1): a number, object
    // or other non-string responseModel/model value never silently disappears and never triggers
    // the optional fallback — the shared budget latches and no later descriptor is read.
    const responseModelDescriptor = readOwnEnumerableDataDescriptor(message, 'responseModel')
    if (responseModelDescriptor.kind === 'unsafe') {
      latchUnsafe()
      return snapshot
    }
    if (responseModelDescriptor.kind === 'data') {
      const responseModelValue = responseModelDescriptor.value
      if (typeof responseModelValue !== 'string') {
        latchUnsafe()
        return snapshot
      }
      snapshot.responseModel = responseModelValue
    }
    const modelDescriptor = readOwnEnumerableDataDescriptor(message, 'model')
    if (modelDescriptor.kind === 'unsafe') {
      latchUnsafe()
      return snapshot
    }
    if (modelDescriptor.kind === 'data') {
      const modelValue = modelDescriptor.value
      if (typeof modelValue !== 'string') {
        latchUnsafe()
        return snapshot
      }
      snapshot.model = modelValue
    }
    return snapshot
  }
  function meterEvent(event: AssistantMessageEvent): void {
    const batch = new Map<string, string[]>()
    const budget: SemanticBudget = { nodes: 0, projectionWork: 0, dead: false }
    const appended = new Set<string>()
    const add = (segments: HostSlotSegment[], value: string): void => {
      if (typeof value !== 'string' || value.length === 0) return
      const key = encodeSlotKey(segments)
      batch.set(key, [...(batch.get(key) ?? []), value])
    }
    const append = (segments: HostSlotSegment[], delta: string): void => {
      const key = encodeSlotKey(segments)
      const slot = slots.get(key) ?? { canonical: '', bytes: 0, base: '' }
      slot.base += delta
      slots.set(key, slot)
      batch.set(key, [...(batch.get(key) ?? []), slot.base])
      appended.add(key)
    }
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      append([...contentPath(event.contentIndex), { kind: 'block-kind', value: event.type === 'text_delta' ? 'text' : 'thinking' }, { kind: 'field', value: event.type === 'text_delta' ? 'text' : 'thinking' }], event.delta)
    } else if (event.type === 'text_end' || event.type === 'thinking_end') {
      add([...contentPath(event.contentIndex), { kind: 'block-kind', value: event.type === 'text_end' ? 'text' : 'thinking' }, { kind: 'field', value: event.type === 'text_end' ? 'text' : 'thinking' }], event.content)
    } else if (event.type === 'toolcall_delta' || event.type === 'toolcall_start') {
      if (event.type === 'toolcall_delta') append([...contentPath(event.contentIndex), { kind: 'block-kind', value: 'toolCall' }, { kind: 'representation', value: 'tool-raw' }, { kind: 'field', value: 'rawJson' }], event.delta)
      sawToolContent = true
    } else if (event.type === 'toolcall_end') {
      meterBlock(event.toolCall, event.contentIndex, add, budget)
      sawToolContent = true
    }
    const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : (event as { partial?: AssistantMessage }).partial
    const usageCapture = meterMessage(message, add, budget)
    // Fail-fast: a latched projection budget skips the snapshot entirely — no further provider
    // field reads after the first violation (R12 §6.3).
    if (event.type === 'done') {
      if (!budget.dead) {
        lastDoneSnapshot = buildTerminalSnapshot(event.message, budget, () => latchSemantic(budget), usageCapture)
        // A latch during snapshot construction (e.g., malformed usage value) invalidates the
        // terminal snapshot — the stream must not see any body from a latched event.
        if (budget.dead) lastDoneSnapshot = null
      }
    }
    if (event.type === 'done' && event.reason === 'toolUse') sawToolContent = true
    for (const [key, candidates] of batch) {
      const slot = slots.get(key) ?? { canonical: '', bytes: 0, base: '' }
      const unique = [...new Set([slot.canonical, ...candidates])]
      const longest = unique.reduce((a, b) => (b.length > a.length ? b : a))
      const forked = !unique.every((candidate) => candidate === longest || longest.startsWith(candidate))
      const next = forked ? trieBytes(unique, TEXT_LIMIT) : countedBytes(longest, appended.has(key))
      observed += next - slot.bytes
      slots.set(key, { canonical: forked ? slot.canonical : longest, bytes: next, base: slot.base })
      if (forked) inconsistent = true
    }
    for (const group of toolGroups.values()) {
      if (budget.dead) break
      reconcileToolGroup(group)
    }
  }
  return {
    onEvent(event: AssistantMessageEvent): void {
      meterEvent(event)
    },
    isBodyOverLimit(): boolean {
      return observed > TEXT_LIMIT
    },
    isSnapshotInconsistent(): boolean {
      return inconsistent
    },
    hasToolContent(): boolean {
      return sawToolContent
    },
    snapshotTerminal(): SafeTerminalSnapshot | null {
      return lastDoneSnapshot
    },
    flushPendingSurrogatesToLimit(): boolean {
      for (const slot of slots.values()) {
        const full = Buffer.byteLength(slot.canonical, 'utf8')
        if (full > slot.bytes) {
          observed += full - slot.bytes
          slot.bytes = full
        }
      }
      return observed > TEXT_LIMIT
    },
  }
}
