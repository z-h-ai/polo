/**
 * Pure helpers for the floating latest-user-message Recap (POO-111).
 *
 * Kept separate from `ChatDisplay.tsx` / `useUserMessageRecap.ts` so the
 * selection, preview and geometry rules can be unit-tested without React
 * or a DOM. The hook owns scheduling; `ChatDisplay.tsx` owns wiring.
 *
 * Preview semantics deliberately mirror what `UserMessageBubble` renders:
 * badge-marked ranges are replaced by their displayed label (context badges
 * hide the raw content behind `collapsedLabel`), so the Recap never leaks
 * hidden system wrapping. It only re-uses existing visible semantics — it
 * does not re-parse or re-implement the bubble's rendering pipeline.
 */

import type { Turn, UserTurn } from '@polo-ai/ui'
import type { Message } from '../../../shared/types'

/** Attribute marking the subtree that belongs to the currently rendered session. */
export const RECAP_SESSION_ATTRIBUTE = 'data-recap-session'

/** Tailwind spacing unit (1 step = 0.25rem = 4px) used by CHAT_LAYOUT classes. */
const TAILWIND_SPACING_STEP_PX = 4

// ============================================================================
// Target selection
// ============================================================================

/** The latest *sent* user turn plus its index inside the full turn list. */
export interface RecapUserTurn {
  turn: UserTurn
  index: number
}

/**
 * Select the turn the Recap points at: the latest user message that is
 * neither pending (optimistic, not acked) nor queued. Pending/queued
 * messages must not replace the last sent message, and interleaved
 * system/error/auth-request/assistant turns must not hide the user turn —
 * so the scan walks the full list backwards instead of a bounded tail.
 */
export function selectLatestSentUserTurn(turns: Turn[]): RecapUserTurn | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (!turn || turn.type !== 'user') continue
    if (turn.message.isPending || turn.message.isQueued) continue
    return { turn, index }
  }
  return null
}

// ============================================================================
// Preview text
// ============================================================================

type ContentBadge = NonNullable<Message['badges']>[number]

function isEditRequestBadge(badge: ContentBadge): boolean {
  return badge.type === 'context' && !!badge.rawText?.includes('<edit_request>')
}

/**
 * Replace badge-marked ranges the same way `UserMessageBubble` displays them:
 * - edit_request context badges are stripped entirely (rendered as a chip above the bubble)
 * - context badges collapse the hidden range to `collapsedLabel || label`
 * - every other badge shows its `label` in place of the raw text (e.g. `@source`)
 *
 * Kept labels are space-padded so they stay separate words when the result
 * is folded to one line — whitespace itself is not normalized here; callers
 * run `collapseRecapWhitespace`.
 */
export function resolveVisibleUserText(content: string, badges: ContentBadge[] | undefined): string {
  if (!badges || badges.length === 0) return content

  let text = content
  // Replace from the end so earlier offsets stay valid; the end tie-break
  // keeps overlapping ranges (never seen in production) replacing
  // deterministically, longest first.
  const sorted = [...badges].sort((a, b) => (b.start - a.start) || (b.end - a.end))
  for (const badge of sorted) {
    const replacement = isEditRequestBadge(badge)
      ? ''
      : badge.type === 'context'
        ? (badge.collapsedLabel || badge.label)
        : badge.label
    text = text.slice(0, badge.start) + ` ${replacement} ` + text.slice(badge.end)
  }
  return text
}

/** Collapse all whitespace (incl. newlines) so the Recap stays one line. */
export function collapseRecapWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Upper bound for the native tooltip, matching the follow-up chip precedent. */
export const RECAP_TITLE_MAX_LENGTH = 260

/**
 * Cap the tooltip so a very long message cannot produce a huge native title
 * (same limit pattern as `truncateForChipTooltip` for follow-up chips).
 * The on-screen Recap pill keeps its own truncation via CSS.
 */
export function truncateRecapTitle(text: string, maxLength = RECAP_TITLE_MAX_LENGTH): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

export type RecapPreviewSource =
  | { kind: 'text'; text: string }
  | { kind: 'attachments'; names: string[] }
  | { kind: 'empty' }

/**
 * Describe the Recap preview for a message using only visible semantics.
 * Callers map `attachments` (single name shown verbatim, otherwise a
 * localized "{{count}} attachments" label) and `empty` (localized
 * "your latest message" fallback) to `t()` — no i18n in pure code.
 */
export function resolveRecapPreview(message: Message): RecapPreviewSource {
  const text = collapseRecapWhitespace(resolveVisibleUserText(message.content, message.badges))
  if (text) return { kind: 'text', text }

  const names = (message.attachments ?? []).map(a => a.name).filter((name): name is string => !!name)
  if (names.length > 0) return { kind: 'attachments', names }

  return { kind: 'empty' }
}

// ============================================================================
// Geometry
// ============================================================================

/**
 * The Recap only appears once the target message has scrolled out *entirely*
 * — judged by its bottom edge, so a long message that is still partially
 * visible stays hidden (no duplicate/occlusion next to the real message).
 */
export function isRecapTargetScrolledOut(
  targetRect: { top: number; bottom: number },
  viewportTop: number,
): boolean {
  return targetRect.bottom <= viewportTop
}

/**
 * `scrollTop` that lands the target's top `offsetPx` below the viewport top.
 * Measured from live rects relative to the real viewport (multi-panel safe),
 * clamped at 0.
 */
export function computeRecapScrollTop(params: {
  targetTop: number
  viewportTop: number
  scrollTop: number
  offsetPx: number
}): number {
  return Math.max(0, params.targetTop - params.viewportTop + params.scrollTop - params.offsetPx)
}

/** Parse the top padding (in px) out of Tailwind spacing classes (`p*-{step}`). */
export function tailwindPaddingTopPx(...classes: Array<string | undefined>): number {
  let total = 0
  for (const candidate of classes) {
    if (!candidate) continue
    for (const token of candidate.split(/\s+/)) {
      const match = /^(?:p|py|pt)-(\d+(?:\.\d+)?)$/.exec(token)
      if (!match) continue
      total += Number.parseFloat(match[1]!) * TAILWIND_SPACING_STEP_PX
    }
  }
  return total
}

/**
 * During session switches AnimatePresence keeps the previous session's nodes
 * mounted for the exit duration; branched sessions can even share message ids.
 * A recap element only counts when it lives inside the rendered session's
 * subtree, so stale exit nodes never get measured.
 */
export function isElementInRecapScope(element: Element, sessionId: string): boolean {
  return element.closest(`[${RECAP_SESSION_ATTRIBUTE}]`)?.getAttribute(RECAP_SESSION_ATTRIBUTE) === sessionId
}

// ============================================================================
// Sticky-bottom scroll gate
// ============================================================================

/** Injectable timer so the debounce race is unit-testable without fake timers. */
export interface DeferredTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export function createWindowDeferredTimer(): DeferredTimer {
  return {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

export interface StickyBottomScrollGate {
  schedule(run: () => void): void
  cancel(): void
}

/**
 * Debounced sticky-bottom auto-scroll with a fire-time sticky re-check.
 *
 * This is the POO-111 race fix: the callback used to run unconditionally
 * once scheduled, so a Recap click that unstuck the bottom (and scrolled to
 * the target) could still be yanked back by a 200ms-old resize debounce.
 * Stickiness is now re-checked when the timer fires — after the click
 * already set it false — and the pending scroll is dropped.
 */
export function createStickyBottomScrollGate(options: {
  isSticky: () => boolean
  delayMs?: number
  timer?: DeferredTimer
}): StickyBottomScrollGate {
  const delayMs = options.delayMs ?? 200
  const timer = options.timer ?? createWindowDeferredTimer()
  let handle: unknown = null

  return {
    cancel() {
      if (handle === null) return
      timer.clear(handle)
      handle = null
    },
    schedule(run) {
      this.cancel()
      handle = timer.set(() => {
        handle = null
        if (!options.isSticky()) return
        run()
      }, delayMs)
    },
  }
}
