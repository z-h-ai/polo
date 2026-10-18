/**
 * GenUI streaming skeleton scanner (P0-2, Wave-1).
 *
 * Tolerant scanner over the PARTIAL JSON of an in-flight render_ui tool call
 * (accumulated from tool_input_delta events). It extracts component-skeleton
 * information — the "type" discriminator and "title" — and NOTHING else:
 * no business data, no cell values, no prompts. A truncated or malformed
 * payload simply yields fewer (or zero) skeletons; the scanner never throws.
 *
 * Recognition rules (deliberately conservative):
 * - Only FULLY CLOSED string key/value pairs count: `"type": "<v>"` /
 *   `"title": "<v>"` where the value's closing quote exists (escaped quotes
 *   inside the value are honored). A key whose value is still streaming is
 *   invisible.
 * - The key must sit at a KEY POSITION: the opening quote of the key is
 *   anchored directly after `{` or `,` (whitespace allowed). Inside JSON
 *   string values an embedded quote is always backslash-escaped (`\"type\"`),
 *   so the anchor can never fire on text inside a value — the classic
 *   `"detailTemplate": "call \"type\":\"form\" here"` false positive is
 *   rejected by construction.
 * - `type` must belong to the render_ui component whitelist; anything else
 *   (e.g. a column's "type": "text") is ignored.
 * - A `title` belongs to the whitelisted `type` occurrence NEAREST to it by
 *   character distance, in EITHER direction: the model-visible JSON Schema
 *   declares components as id, title, type (GenUIBase order), so a title
 *   usually PRECEDES its own component's type. A title sitting between two
 *   adjacent types can only attach to one of them — it never crosses a
 *   component boundary.
 * - Results are deduped (type+title) and returned in type-occurrence order.
 */

/**
 * Component types eligible for a skeleton preview. Kept in lockstep with
 * GenUICard's GENUI_COMPONENT_REGISTRY — genui-skeleton.test.ts asserts every
 * entry has a registered renderer, so adding a registry renderer without
 * updating this list fails the suite (and vice versa a stale entry fails).
 */
export const GENUI_SKELETON_COMPONENT_TYPES: readonly string[] = [
  'stat-card',
  'data-table',
  'alert',
  'progress',
  'action-buttons',
  'form',
  'chart',
]

/** One skeleton preview entry — component type plus optional card title. */
export interface GenUiSkeleton {
  type: string
  title?: string
}

/**
 * The render_ui tool names an ACTIVITY may carry. Session tools registered
 * through the 'session' MCP server surface as 'mcp__session__render_ui'
 * (today's Claude and Pi paths both); the bare form guards against direct
 * (non-MCP) registration. Mirrors the emission-side predicate
 * (isRenderUiToolName in the Claude event adapter) so the renderer never
 * accepts less than the emitter produces — the skeleton path and the
 * completed-card path must recognize the same set.
 */
export function isRenderUiActivityToolName(name: unknown): boolean {
  return name === 'render_ui' || name === 'mcp__session__render_ui'
}

/** Anchored, fully-closed `"type"|"title": "value"` pair at a key position. */
const KEY_VALUE_PATTERN = /[{,]\s*"(type|title)"\s*:\s*"((?:[^"\\]|\\.)*)"/g

/** Unescape a JSON string literal's inner content; falls back to the raw text. */
function unescapeJsonValue(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

interface Occurrence {
  kind: 'type' | 'title'
  value: string
  at: number
}

/** Scan all anchored, fully-closed type/title pairs in occurrence order. */
function scanOccurrences(partialJson: string): Occurrence[] {
  const occurrences: Occurrence[] = []
  KEY_VALUE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = KEY_VALUE_PATTERN.exec(partialJson)) !== null) {
    const kind = match[1] === 'type' ? 'type' : 'title'
    occurrences.push({ kind, value: unescapeJsonValue(match[2]!), at: match.index })
  }
  return occurrences
}

/**
 * Extract component skeletons from the partial render_ui JSON accumulated so
 * far. Pure, total (never throws), order-preserving, deduplicated.
 */
export function extractGenUiSkeletons(partialJson: string): GenUiSkeleton[] {
  if (!partialJson) return []

  const occurrences = scanOccurrences(partialJson)
  const typeWhitelist = new Set(GENUI_SKELETON_COMPONENT_TYPES)
  const types = occurrences
    .filter(o => o.kind === 'type' && typeWhitelist.has(o.value))
    .map(o => ({ value: o.value, at: o.at }))
  if (types.length === 0) return []

  // Assign each title to its nearest whitelisted type by character distance
  // (bidirectional, bounded by the adjacent types — never across a component).
  // Models emit components in schema field order (id, title, type), so a title
  // typically PRECEDES its own type and would be misattributed by a
  // forward-only search; a title before the first type belongs to that first
  // type, one after the last type to that last type, and a tie between the
  // two neighbours goes to the FOLLOWING type (schema-order convention).
  const titleByTypeIndex = new Map<number, string>()
  for (const occurrence of occurrences) {
    if (occurrence.kind !== 'title') continue
    let prev = -1
    let next = types.length
    for (let i = 0; i < types.length; i++) {
      if (types[i]!.at < occurrence.at) prev = i
      else {
        next = i
        break
      }
    }
    let owner: number
    if (prev === -1) owner = next
    else if (next === types.length) owner = prev
    else {
      const distPrev = occurrence.at - types[prev]!.at
      const distNext = types[next]!.at - occurrence.at
      owner = distNext <= distPrev ? next : prev
    }
    // Multiple titles resolving to one type (malformed/truncated payload):
    // keep the first, ignore the rest — skeletons are a cosmetic preview.
    if (!titleByTypeIndex.has(owner)) titleByTypeIndex.set(owner, occurrence.value)
  }

  const skeletons: GenUiSkeleton[] = []
  const seen = new Set<string>()
  types.forEach((typeOccurrence, index) => {
    const title = titleByTypeIndex.get(index)
    const dedupeKey = `${typeOccurrence.value}::${title ?? ''}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    skeletons.push(title === undefined ? { type: typeOccurrence.value } : { type: typeOccurrence.value, title })
  })

  return skeletons
}
