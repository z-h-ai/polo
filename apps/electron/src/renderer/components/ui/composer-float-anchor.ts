/**
 * composer-float-anchor — shared viewport anchor for the composer floats
 * (@ mention menu, slash command menu).
 *
 * Coordinate contract (see viewport-portal.tsx): the returned { x, y } are
 * VIEWPORT coordinates of the caret's top edge; the float clamps them with
 * clampFloatLeft/clampFloatBottom and renders inside a ViewportPortal mounted
 * on document.body. The focused panel's backdrop-filter makes it the fixed
 * containing block, so these coordinates must never be interpreted inside the
 * panel subtree.
 *
 * Anchor resolution:
 * 1. Primary — the real caret measurement from RichTextInputHandle
 *    getCaretRect() (viewport-space DOMRect of the collapsed selection).
 * 2. Fallback — measurement unavailable (no selection, zero-size rect, or a
 *    bare stub without getCaretRect): anchor to the rich-text input CONTAINER
 *    itself (its getBoundingClientRect), so the float can never land outside
 *    the composer, and estimate the caret row from the element's ACTUAL
 *    computed line-height instead of a hardcoded pixel guess — the editor
 *    carries `lineHeight: 1.25` over `text-sm`, so a hardcoded 20px drifted
 *    the estimate on long multi-line (CJK) text. The estimate is also clamped
 *    inside the container box for the same "never outside the composer" rule.
 *
 * Extracted so mention-menu and slash-command-menu share ONE fallback cadence
 * (both hooks previously carried drift-prone copies of this logic).
 */

/** Structural subset of RichTextInputHandle the float anchors need. */
export interface ComposerFloatInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  /** Underlying editable element, when the handle exposes it (RichTextInputHandle does). */
  element?: Element | null
}

/** Line-height fallback for environments without computed styles (tests/SSR). */
const FALLBACK_LINE_HEIGHT_PX = 20

/** CSS `line-height: normal` ≈ 1.2 × font-size across our target engines. */
const NORMAL_LINE_HEIGHT_FACTOR = 1.2

function readLineHeightPx(element: Element | null | undefined): number {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return FALLBACK_LINE_HEIGHT_PX
  }
  const style = window.getComputedStyle(element)
  const lineHeight = parseFloat(style.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
  const fontSize = parseFloat(style.fontSize)
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * NORMAL_LINE_HEIGHT_FACTOR
  return FALLBACK_LINE_HEIGHT_PX
}

/** True when a DOMRect carries no layout information (detached/never-attached node). */
function isEmptyRect(rect: DOMRect | null | undefined): boolean {
  return !rect
    || (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0)
}

/**
 * Resolve the viewport-space caret anchor for a composer float, or null when
 * nothing measurable exists this frame (the float keeps its last anchor).
 */
export function resolveComposerFloatAnchor(
  input: ComposerFloatInputElement | null | undefined,
  textBeforeCursor: string,
): { x: number; y: number } | null {
  if (!input) return null

  // 1. Primary: the real caret measurement (already viewport coordinates).
  const caretRect = input.getCaretRect?.()
  if (caretRect && caretRect.x > 0) {
    return { x: caretRect.x, y: caretRect.y }
  }

  // 2. Fallback: anchor to the input container itself — the float is clamped
  //    to the viewport later, but the anchor here is bounded by the composer
  //    box so a long multi-line text can never push it outside the input.
  const rect = input.getBoundingClientRect()
  if (isEmptyRect(rect)) return null

  const lineHeight = readLineHeightPx(input.element)
  const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
  // (lines + 1) × line-height estimates the caret's BOTTOM edge on line N;
  // clamped into the container so the anchor stays within the input box.
  const estimatedY = rect.top + (linesBeforeCursor + 1) * lineHeight
  return {
    x: rect.left,
    y: Math.min(Math.max(estimatedY, rect.top), rect.bottom),
  }
}
