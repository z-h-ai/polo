/**
 * CanvasPane - the right-side expanded canvas for GenUI apps (POO-115).
 *
 * One per session, rendered by AppShell outside PanelStackContainer (the
 * right sidebar stays OUTSIDE that container, by its own contract): header
 * (app name + version + close) over the app's webview, with a drag sash on
 * its left edge (25%–70% of the shell row, remembered per session). The pane
 * springs open from the seam on mount; while the sash is down a window-wide
 * drag mask keeps every guest webview from swallowing the drag's mousemove.
 *
 * The webview is the same carrier contract as the inline card — same
 * ephemeral `genui-app-<sessionId>` partition, same bundle file, same
 * UiCardRegistry registration via the shared useGenUiGuestWebview hook — so
 * Main's gate treats it identically. Closing (the only collapse entry point)
 * unmounts the webview; the inline card restores itself from the bridge's
 * state broadcast. `craft:focus-genui-canvas` (from the card's placeholder
 * strip) flashes the focus ring — a way-finding aid, nothing else.
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { AppWindow, ExternalLink, X } from 'lucide-react'
import {
  GENUI_APP_CANVAS_FOCUS_EVENT,
  GENUI_SESSION_ID_PATTERN,
  buildGenUiAppSrc,
  createMountNonce,
  dispatchGenUiAppCanvasClose,
  getGenUiAppPartition,
  useGenUiGuestWebview,
  type GenUiAppCanvasFocusRequest,
} from '@polo-ai/ui/chat/GenUiAppCard'
import { cn } from '@/lib/utils'
import {
  PANEL_EDGE_INSET,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
} from './panel-constants'
import {
  CANVAS_PANE_MAX_RATIO,
  CANVAS_PANE_MIN_RATIO,
  canvasPaneRatioFromPointer,
  clampCanvasPaneRatio,
  canvasPaneAppAtomFamily,
  canvasPanePopoutAtomFamily,
  canvasPaneWidthAtomFamily,
  type CanvasPaneApp,
} from '@/atoms/canvas-pane'

/** One focus-flash highlight, long enough to be caught by an aiming eye. */
const FOCUS_FLASH_MS = 900
/** Keyboard nudge per ArrowLeft/ArrowRight on the sash. */
const KEYBOARD_RATIO_STEP = 0.025
/** Spring for programmatic width changes — matches PanelStackContainer's panels. */
const CANVAS_PANE_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }
/** Reduced-motion fallback: same short tween CompactPanelTransition uses. */
const CANVAS_PANE_REDUCED_TWEEN = { type: 'tween' as const, duration: 0.12 }

interface CanvasPaneProps {
  sessionId: string
  app: CanvasPaneApp
  /**
   * Rect of the shell flex row the pane's width ratio is measured against
   * (AppShell's shellRef) — dragging converts pointer x into a ratio of it.
   */
  getLayoutRect: () => DOMRect | null
}

/**
 * POO-135: the canvas card WITHOUT the pane shell (motion width, sash, drag
 * mask) — the card body + its own little header. Extracted so the unified
 * right sidebar (RightSidebarPane) can host the very same card under its
 * canvas tab while the standalone CanvasPane keeps its exact prior behavior.
 *
 * POO-135 验收修复 (SB-CANVAS-OUT): an optional `onPopOut` renders a
 * 「弹出为独立窗口」 header entry (canvas affordance in the card's own header —
 * the locked header rule only constrains browser entries). The popup carrier
 * passes nothing: there the header ✕ already means「收回」.
 */
export function CanvasPaneCard({ nativeGuest = false, ...props }: { sessionId: string; app: CanvasPaneApp; onPopOut?: () => void; headerActions?: React.ReactNode; nativeGuest?: boolean }) {
  return nativeGuest ? <CanvasGuestCard {...props} /> : <NativeCanvasSurface sessionId={props.sessionId} app={props.app} />
}

/** The carrier renderer and its guest stay alive in Main across surface changes. */
function NativeCanvasSurface({ sessionId, app }: { sessionId: string; app: CanvasPaneApp }) {
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const presentation = useAtomValue(canvasPanePopoutAtomFamily(sessionId))
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let disposed = false, pending = false, blocked = false
    let lastBounds = ''
    const sync = () => {
      if (disposed || pending || blocked) return
      const rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const key = JSON.stringify(bounds)
      if (key === lastBounds) return
      lastBounds = key
      pending = true
      void window.electronAPI.canvasPane.embed(sessionId, app, bounds).then(() => {
        pending = false
        if (!disposed) sync() // Coalesce animation resize events while the request was pending.
      }).catch(() => {
        pending = false
        blocked = true // A failed target waits for the user's explicit Retry attempt.
        if (!disposed) setFailed(true)
      })
    }
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    window.addEventListener('resize', sync)
    sync()
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('resize', sync)
      void window.electronAPI.canvasPane.unembed(sessionId).catch(() => {})
    }
  }, [sessionId, app.appId, app.indexPath, attempt])
  return <div ref={ref} data-testid="native-canvas-surface" className="h-full w-full min-h-0">{(failed || presentation?.loadFailed) && <div role="alert" className="p-4 text-xs text-muted-foreground"><p>{t('genui.app.loadError')}</p><button type="button" onClick={() => { setFailed(false); setAttempt(n => n + 1) }} className="mt-2 rounded border px-2 py-1">{t('common.retry')}</button></div>}</div>
}

function CanvasGuestCard({ sessionId, app, onPopOut, headerActions }: {
  sessionId: string
  app: CanvasPaneApp
  onPopOut?: () => void
  headerActions?: React.ReactNode
}) {
  const { t } = useTranslation()
  const webviewRef = React.useRef<HTMLElement | null>(null)
  const [focusing, setFocusing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Per-mount card id (POO-103), same scheme as the inline card — the pane's
  // guest is its own UiCardRegistry entry, not a shadow of the card's.
  const cardId = useMemo(() => `${app.appId}-canvas-${attempt}-${createMountNonce()}`, [app.appId, attempt])
  const partition = useMemo(() => getGenUiAppPartition(sessionId), [sessionId])
  const registration = useMemo(
    () => (GENUI_SESSION_ID_PATTERN.test(sessionId) ? { sessionId, cardId } : null),
    [cardId, sessionId],
  )
  const src = useMemo(() => {
    const base = buildGenUiAppSrc(app.indexPath, '')
    if (!registration) return base
    const params = new URLSearchParams({ poloCard: cardId, poloSession: sessionId })
    return `${base}?${params.toString()}`
  }, [app.indexPath, cardId, registration, sessionId])

  useGenUiGuestWebview({
    webviewRef,
    src,
    partition,
    registration,
    onLoadFailed: useCallback(() => setLoadFailed(true), []),
  })

  const handleClose = useCallback(() => {
    dispatchGenUiAppCanvasClose({ sessionId, appId: app.appId })
  }, [app.appId, sessionId])

  // Placeholder → "show in canvas": flash the focus ring for this very app.
  const focusTimerRef = useRef<number | null>(null)
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<GenUiAppCanvasFocusRequest>).detail
      if (!detail || detail.sessionId !== sessionId || detail.appId !== app.appId) return
      setFocusing(true)
      if (focusTimerRef.current != null) window.clearTimeout(focusTimerRef.current)
      focusTimerRef.current = window.setTimeout(() => setFocusing(false), FOCUS_FLASH_MS)
    }
    window.addEventListener(GENUI_APP_CANVAS_FOCUS_EVENT, listener)
    return () => {
      window.removeEventListener(GENUI_APP_CANVAS_FOCUS_EVENT, listener)
      if (focusTimerRef.current != null) window.clearTimeout(focusTimerRef.current)
    }
  }, [app.appId, sessionId])

  return (
    <div
      className={cn(
        'h-full w-full min-w-0 flex flex-col overflow-hidden rounded-[8px] border bg-background transition-shadow',
        focusing ? 'ring-2 ring-accent/60 border-accent/60' : '',
      )}
    >
      <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-1.5 shrink-0">
        <AppWindow className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
        <span className="text-[12px] text-muted-foreground font-medium truncate flex-1 min-w-0">{app.title}</span>
        {typeof app.version === 'number' && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/80 tabular-nums">
            {t('genui.app.version', { version: app.version })}
          </span>
        )}
        {headerActions}
        {onPopOut && (
          <button
            type="button"
            data-testid="canvas-card-popout"
            title={t('browserPane.sidebar.detach')}
            onClick={onPopOut}
            className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={handleClose}
          title={t('genui.app.closeCanvas')}
          className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {loadFailed ? (
        <div role="alert" className="flex-1 flex flex-col gap-2 items-center justify-center text-[12px] text-muted-foreground/70">
          {t('genui.app.loadError')}
          <button type="button" className="rounded border px-2 py-1" onClick={() => { setLoadFailed(false); setAttempt(value => value + 1) }}>{t('common.retry')}</button>
        </div>
      ) : (
        <webview
          ref={webviewRef as React.RefObject<HTMLElement>}
          src={src}
          partition={partition}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          className="w-full flex-1 min-h-0 bg-white"
        />
      )}
    </div>
  )
}

export function CanvasPane({ sessionId, app, getLayoutRect }: CanvasPaneProps) {
  const { t } = useTranslation()
  const [widthRatio, setWidthRatio] = useAtom(
    useMemo(() => canvasPaneWidthAtomFamily(sessionId), [sessionId]),
  )
  const appAtom = useAtomValue(useMemo(() => canvasPaneAppAtomFamily(sessionId), [sessionId]))
  const [isDragging, setIsDragging] = useState(false)
  // Focus flash for the sash highlight (the card body flashes its own ring
  // inside CanvasPaneCard); both listen to the same broadcast independently.
  const [focusing, setFocusing] = useState(false)
  const reduceMotion = useReducedMotion()

  // Placeholder → "show in canvas": flash the sash ring for this very app.
  const focusTimerRef = useRef<number | null>(null)
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<GenUiAppCanvasFocusRequest>).detail
      if (!detail || detail.sessionId !== sessionId || detail.appId !== app.appId) return
      setFocusing(true)
      if (focusTimerRef.current != null) window.clearTimeout(focusTimerRef.current)
      focusTimerRef.current = window.setTimeout(() => setFocusing(false), FOCUS_FLASH_MS)
    }
    window.addEventListener(GENUI_APP_CANVAS_FOCUS_EVENT, listener)
    return () => {
      window.removeEventListener(GENUI_APP_CANVAS_FOCUS_EVENT, listener)
      if (focusTimerRef.current != null) window.clearTimeout(focusTimerRef.current)
    }
  }, [app.appId, sessionId])

  // Sash drag: pointer x → ratio of the shell row, clamped to the pane band.
  // Measured against the row's *content* box: the pane's % width resolves
  // against rect.width minus the row's right edge inset, so the border box
  // would leave the sash a few pixels shy of the pointer. The inset is read
  // from the row's computed style rather than assumed, so the basis stays
  // exact if the row's styling ever changes.
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const measureRowInset = useCallback(() => {
    const row = rootRef.current?.parentElement
    if (!row) return PANEL_EDGE_INSET
    const pad = Number.parseFloat(window.getComputedStyle(row).paddingRight)
    return Number.isFinite(pad) ? pad : PANEL_EDGE_INSET
  }, [])

  useEffect(() => {
    if (!isDragging) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const inset = measureRowInset()
    const startRect = getLayoutRect()
    const innerWidth = startRect ? Math.max(startRect.width - inset, 1) : 1
    const onMove = (event: MouseEvent) => {
      const rect = getLayoutRect()
      if (!rect) return
      setWidthRatio(canvasPaneRatioFromPointer(rect.right, inset, innerWidth, event.clientX))
    }
    // blur/pointercancel: a release outside the window (alt-tab, stray gesture)
    // never delivers mouseup — without these the drag mask would stay up.
    const onUp = () => setIsDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [getLayoutRect, isDragging, measureRowInset, setWidthRatio])

  const handleSashKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? KEYBOARD_RATIO_STEP : -KEYBOARD_RATIO_STEP
    setWidthRatio(clampCanvasPaneRatio(widthRatio + step))
  }, [setWidthRatio, widthRatio])

  // The pane atom this component renders from was set by the bridge for this
  // exact app; if it has since been replaced, AppShell re-renders with the
  // new app before this stale instance could stay visible.
  if (!appAtom || appAtom.appId !== app.appId) return null

  return (
    <motion.div
      ref={rootRef}
      className="relative flex items-stretch shrink-0"
      // The pane sweeps open from the seam on mount (canvas open, session
      // switch back to a pane session); width tracks the dragged ratio
      // instantly and springs only for programmatic changes (open, keyboard
      // nudge) — same rule as PanelStackContainer's panels.
      initial={{ width: '0%' }}
      animate={{ width: `${widthRatio * 100}%` }}
      transition={
        isDragging
          ? { duration: 0 }
          : reduceMotion
            ? CANVAS_PANE_REDUCED_TWEEN
            : CANVAS_PANE_SPRING
      }
      data-canvas-pane={app.appId}
    >
      {/* Drag mask: keeps the hit-test in this document while the sash is
          down. Without it a shrink drag drifts onto a guest <webview>, which
          swallows window mousemove and freezes the sash — the "only grows,
          never shrinks" bug. The pane's own mask is not enough: shrinking can
          cross OTHER live inline webviews in the chat area, so the mask spans
          the whole window via a portal and outlives no drag (unmounts on
          up/blur/cancel, so a frozen drag cannot leave it stuck). */}
      {isDragging &&
        createPortal(
          <div
            className="fixed inset-0 z-panel cursor-col-resize"
            data-canvas-pane-drag-mask="true"
            aria-hidden="true"
          />,
          document.body,
        )}
      {/* Resize sash straddling the panel gap on the pane's left edge. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('genui.app.canvasResize')}
        aria-valuenow={Math.round(widthRatio * 100)}
        aria-valuemin={Math.round(CANVAS_PANE_MIN_RATIO * 100)}
        aria-valuemax={Math.round(CANVAS_PANE_MAX_RATIO * 100)}
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault()
          // Adopt the pointer immediately so grabbing the sash mid-open-
          // animation does not jump to the spring's in-flight width on the
          // first tracked move (duration: 0 takes over from wherever we are).
          const rect = getLayoutRect()
          if (rect) {
            const inset = measureRowInset()
            setWidthRatio(
              canvasPaneRatioFromPointer(rect.right, inset, Math.max(rect.width - inset, 1), e.clientX),
            )
          }
          setIsDragging(true)
        }}
        onKeyDown={handleSashKeyDown}
        className="absolute top-0 bottom-0 z-panel cursor-col-resize flex justify-center outline-none"
        style={{ left: -PANEL_SASH_HALF_HIT_WIDTH, width: PANEL_SASH_HIT_WIDTH }}
      >
        <div
          className={cn(
            'h-full rounded-full transition-colors',
            isDragging || focusing ? 'bg-accent' : 'bg-transparent hover:bg-accent/40',
          )}
          style={{ width: PANEL_SASH_LINE_WIDTH }}
        />
      </div>
      <CanvasPaneCard sessionId={sessionId} app={app} />
    </motion.div>
  )
}
