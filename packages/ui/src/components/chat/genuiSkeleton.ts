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
 * - Each recognized `type` pairs with the nearest `title` occurring AFTER it,
 *   bounded by the next recognized `type` occurrence — a title can never leak
 *   across components.
 * - Results are deduped (type+title) and returned in occurrence order.
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
  const typePositions = occurrences
    .filter(o => o.kind === 'type' && typeWhitelist.has(o.value))
    .map(o => ({ value: o.value, at: o.at }))

  const skeletons: GenUiSkeleton[] = []
  const seen = new Set<string>()

  typePositions.forEach((typeOccurrence, index) => {
    // Pair window: from this type's position up to the next recognized type
    // (or end of input) — the nearest title inside the window belongs to this
    // component; a title BEFORE the type (schema field order is id, title,
    // type) simply yields no preview title, never a wrong one.
    const windowStart = typeOccurrence.at
    const windowEnd = index + 1 < typePositions.length ? typePositions[index + 1]!.at : partialJson.length
    const title = occurrences.find(
      o => o.kind === 'title' && o.at > windowStart && o.at < windowEnd,
    )?.value

    const dedupeKey = `${typeOccurrence.value}::${title ?? ''}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    skeletons.push(title === undefined ? { type: typeOccurrence.value } : { type: typeOccurrence.value, title })
  })

  return skeletons
}
