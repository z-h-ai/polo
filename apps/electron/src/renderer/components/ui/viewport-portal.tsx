import * as React from 'react'
import { createPortal } from 'react-dom'

/**
 * POO-196 体验闭环 R-AT (adjudication 2026-11-06): viewport-anchored floating
 * layers must mount on document.body.
 *
 * Why: the focused panel carries `client-material-reading`, whose
 * `backdrop-filter: blur(24px)` (POO-105 reading material) makes the panel the
 * containing block for every `position: fixed` descendant — the same is true
 * for any ancestor with container-type/transform/filter. A `fixed` float
 * rendered inside the panel subtree then interprets its viewport coordinates
 * relative to the panel box, so composer popovers (@ mentions, slash, labels)
 * landed pinned to the panel's right edge instead of the caret.
 *
 * Portaling to body restores the viewport coordinate contract. Render-only
 * relocation: synthetic React events keep bubbling through the React tree
 * (composer keydown routing is untouched), document-level mousedown/keydown
 * listeners still fire, and the portal host is the same document the menus
 * already measured. Portal-free exceptions need an explicit coordinate
 * contract plus a real-layout regression (adjudication 防呆规范).
 */
export function ViewportPortal({ children }: { children: React.ReactNode }) {
  const [host, setHost] = React.useState<HTMLElement | null>(null)

  React.useEffect(() => {
    setHost(document.body)
  }, [])

  // No portal host yet (first render, SSR, renderToStaticMarkup tests):
  // render inline so the markup stays present. In the app this frame never
  // paints a live menu — the host is set at mount, long before any menu
  // opens (closed menus render null).
  if (!host) return <>{children}</>
  return createPortal(children, host)
}

/**
 * A viewport-anchored float must not survive a viewport or panel-layout
 * change: its stored anchor coordinates go stale the moment the window
 * resizes or a sibling panel pushes/shrinks the composer. The hook closes
 * the float instead of re-anchoring (the next input event re-anchors fresh
 * coordinates), so a detached menu can never linger over the wrong spot.
 */
export function useCloseOnViewportResize(open: boolean, onClose: () => void) {
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  React.useEffect(() => {
    if (!open) return
    const handleResize = () => onCloseRef.current()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [open])
}

/** Shared viewport geometry for the composer floats (matches the
 *  AssetMentionPopover margins; one cadence for clamping everywhere). */
export const FLOAT_VIEWPORT_MARGIN = 8

/** Horizontal clamp: anchor 10px left of the caret, but keep the float fully
 *  inside the viewport. `caretX` is the viewport-space caret x; `width` the
 *  float's outer width. */
export function clampFloatLeft(caretX: number, width: number): number {
  // No viewport (SSR / markup tests): keep the raw anchor, nothing to clamp.
  if (typeof window === 'undefined') return Math.round(caretX) - 10
  const min = FLOAT_VIEWPORT_MARGIN
  const max = Math.max(min, window.innerWidth - width - FLOAT_VIEWPORT_MARGIN)
  return Math.min(Math.max(Math.round(caretX) - 10, min), max)
}

/** Vertical clamp for bottom-anchored floats: the lower edge sits 8px above
 *  the caret, capped so the top edge cannot exit the viewport. */
export function clampFloatBottom(caretY: number, maxHeight: number): number {
  if (typeof window === 'undefined') return FLOAT_VIEWPORT_MARGIN
  const min = FLOAT_VIEWPORT_MARGIN
  const max = Math.max(min, window.innerHeight - maxHeight - FLOAT_VIEWPORT_MARGIN)
  return Math.min(Math.max(min, window.innerHeight - Math.round(caretY) + FLOAT_VIEWPORT_MARGIN), max)
}
