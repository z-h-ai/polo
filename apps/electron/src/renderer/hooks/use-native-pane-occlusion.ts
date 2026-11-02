import * as React from 'react'

/**
 * POO-198: the right sidebar's canvas and browser surfaces are native views
 * composited ABOVE this window's DOM (Main's browser-pane-manager and canvas
 * manager own them; the renderer only mounts placeholders at their bounds).
 * Whatever the app paints over the pane — a fullscreen preview opened from the
 * conversation, a modal scrim, a dropdown or a toast crossing the pane — ends
 * up UNDER the guest page: no z-index can put DOM in front of a native view.
 *
 * So while DOM covers the pane's surfaces, this hook asks Main to take those
 * views off the window (`setEmbedOcclusion(true)`), and to bring them back at
 * their last bounds when the DOM clears. Main tracks WHY a view is off the
 * window, so a surface that unmounted for its own reasons is never resurrected
 * here.
 *
 * "DOM covers a surface" is answered geometrically instead of by tracking who
 * is open: hit-test probe points across each native surface's rect and look
 * for an element that is not the pane's own and actually paints there (visible
 * background color or image, backdrop blur). Transparent pointer guards — the
 * sash drag mask among them — don't hide the pane, so they don't count, and
 * `pointer-events: none` layers (tooltips) are skipped by the hit test itself.
 *
 * Triggers: surface geometry changes, window resize, scroll (in-place popovers
 * move), body-level portal open/close (the high-signal path for Radix and the
 * fullscreen overlays), and a slow interval as the safety net for anything
 * that appears without either.
 */

/** Probe roughly every cell of this size, capped so tall surfaces stay cheap. */
const PROBE_CELL_PX = 160
const MAX_PROBE_COLS = 4
const MAX_PROBE_ROWS = 12
/** Safety-net cadence for overlays that appear without a portal mutation. */
const RESCAN_INTERVAL_MS = 400

/** DOM placeholders that a native view is composited over (see the two mount points). */
const NATIVE_SURFACE_SELECTOR = '[data-native-surface="true"]'

/**
 * Whether a computed color actually puts pixels down. `rgba(..., 0)` and
 * `color(srgb ... / 0)` (Chromium resolves color-mix to this form) do not.
 */
function colorPaints(color: string): boolean {
  if (!color || color === 'transparent') return false
  const alpha = /\/\s*([\d.]+)\s*\)$/.exec(color) ?? /,\s*([\d.]+)\s*\)$/.exec(color)
  if (!alpha) return true
  const value = Number.parseFloat(alpha[1])
  return Number.isFinite(value) && value > 0.01
}

/** A declared background image / backdrop blur; an unset property reads as ''. */
function declaresPaint(value: string): boolean {
  return value !== '' && value !== 'none'
}

/**
 * Whether `element` or any ancestor below the app root paints. The app root
 * itself is excluded — everything in the workbench has a background, and the
 * pane never overlaps its own neighbors' layout, only floating layers.
 */
function paintsOverPane(element: Element, appRoot: Element | null, cache: Map<Element, boolean>): boolean {
  let node: Element | null = element
  while (node && node !== document.body && node !== document.documentElement && node !== appRoot) {
    const cached = cache.get(node)
    if (cached !== undefined) return cached
    let paints = false
    const style = window.getComputedStyle(node)
    paints =
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      (colorPaints(style.backgroundColor) ||
        declaresPaint(style.backgroundImage) ||
        declaresPaint(style.backdropFilter))
    cache.set(node, paints)
    if (paints) return true
    node = node.parentElement
  }
  return false
}

/** Whether any floating layer paints over one of the pane's native surfaces. */
function paneIsCovered(paneRoot: Element, appRoot: Element | null): boolean {
  const cache = new Map<Element, boolean>()
  for (const surface of Array.from(paneRoot.querySelectorAll(NATIVE_SURFACE_SELECTOR))) {
    const rect = surface.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    const cols = Math.max(1, Math.min(MAX_PROBE_COLS, Math.round(rect.width / PROBE_CELL_PX)))
    const rows = Math.max(1, Math.min(MAX_PROBE_ROWS, Math.round(rect.height / PROBE_CELL_PX)))
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = rect.left + (rect.width * (col + 0.5)) / cols
        const y = rect.top + (rect.height * (row + 0.5)) / rows
        const hit = document.elementFromPoint(x, y)
        // The pane's own DOM (the placeholder under the native view) is not a
        // cover; a layer that paints there is.
        if (!hit || paneRoot.contains(hit)) continue
        if (paintsOverPane(hit, appRoot, cache)) return true
      }
    }
  }
  return false
}

/**
 * Keep the sidebar's native views out of the way while window DOM paints over
 * them. Pass the right sidebar's root element and whether it is visible at
 * all; the hook is inert (and reports "not covered") otherwise.
 */
export function useNativePaneOcclusion(paneRootRef: React.RefObject<HTMLElement | null>, paneVisible: boolean): void {
  const frameRef = React.useRef(0)
  const intervalRef = React.useRef<number | null>(null)
  const reportedRef = React.useRef(false)

  const report = React.useCallback((occluded: boolean) => {
    if (reportedRef.current === occluded) return
    reportedRef.current = occluded
    // Either surface kind may be embedded; Main no-ops the kind that isn't.
    void window.electronAPI?.browserPane?.setEmbedOcclusion?.(occluded).catch(() => {})
    void window.electronAPI?.canvasPane?.setEmbedOcclusion?.(occluded).catch(() => {})
  }, [])

  const scan = React.useCallback(() => {
    const paneRoot = paneRootRef.current
    if (!paneRoot || !paneVisible) {
      report(false)
      return
    }
    report(paneIsCovered(paneRoot, document.getElementById('root')))
  }, [paneRootRef, paneVisible, report])

  const schedule = React.useCallback(() => {
    if (frameRef.current) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0
      scan()
    })
  }, [scan])

  React.useEffect(() => {
    if (!paneVisible) {
      report(false)
      return
    }
    const paneRoot = paneRootRef.current
    if (!paneRoot) return

    const observer = new ResizeObserver(schedule)
    observer.observe(paneRoot)
    const observeSurfaces = () => {
      for (const surface of Array.from(paneRoot.querySelectorAll(NATIVE_SURFACE_SELECTOR))) observer.observe(surface)
    }
    observeSurfaces()
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, { capture: true, passive: true })

    // Portal activity is where overlays appear: they mount outside the app
    // root, so streaming updates deep inside the workbench never trigger a scan.
    const appRoot = document.getElementById('root')
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target
        if (!(target instanceof Element) || !appRoot?.contains(target)) {
          schedule()
          return
        }
      }
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributeFilter: ['class', 'style'] })

    // Surfaces come and go with the pane's own tabs — pick up new ones and
    // rescan when the pane's subtree changes (rare; the chat is not in here).
    const paneMutations = new MutationObserver(() => {
      observeSurfaces()
      schedule()
    })
    paneMutations.observe(paneRoot, { childList: true, subtree: true })

    intervalRef.current = window.setInterval(schedule, RESCAN_INTERVAL_MS)
    schedule()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule)
      mutations.disconnect()
      paneMutations.disconnect()
      if (intervalRef.current != null) window.clearInterval(intervalRef.current)
      intervalRef.current = null
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
      report(false)
    }
  }, [paneRootRef, paneVisible, report, schedule])
}
