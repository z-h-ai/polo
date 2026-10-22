/**
 * CanvasPane - the right-side expanded canvas for GenUI apps (POO-115).
 *
 * One per session, rendered by AppShell outside PanelStackContainer (the
 * right sidebar stays OUTSIDE that container, by its own contract): header
 * (app name + version + close) over the app's webview, with a drag sash on
 * its left edge (25%–70% of the shell row, remembered per session).
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
import { useAtom, useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { AppWindow, X } from 'lucide-react'
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
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
} from './panel-constants'
import {
  CANVAS_PANE_MAX_RATIO,
  CANVAS_PANE_MIN_RATIO,
  clampCanvasPaneRatio,
  canvasPaneAppAtomFamily,
  canvasPaneWidthAtomFamily,
  type CanvasPaneApp,
} from '@/atoms/canvas-pane'

/** One focus-flash highlight, long enough to be caught by an aiming eye. */
const FOCUS_FLASH_MS = 900
/** Keyboard nudge per ArrowLeft/ArrowRight on the sash. */
const KEYBOARD_RATIO_STEP = 0.025

interface CanvasPaneProps {
  sessionId: string
  app: CanvasPaneApp
  /**
   * Rect of the shell flex row the pane's width ratio is measured against
   * (AppShell's shellRef) — dragging converts pointer x into a ratio of it.
   */
  getLayoutRect: () => DOMRect | null
}

export function CanvasPane({ sessionId, app, getLayoutRect }: CanvasPaneProps) {
  const { t } = useTranslation()
  const webviewRef = React.useRef<HTMLElement | null>(null)
  const [widthRatio, setWidthRatio] = useAtom(
    useMemo(() => canvasPaneWidthAtomFamily(sessionId), [sessionId]),
  )
  const appAtom = useAtomValue(useMemo(() => canvasPaneAppAtomFamily(sessionId), [sessionId]))
  const [isDragging, setIsDragging] = useState(false)
  const [focusing, setFocusing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  // Per-mount card id (POO-103), same scheme as the inline card — the pane's
  // guest is its own UiCardRegistry entry, not a shadow of the card's.
  const cardId = useMemo(() => `${app.appId}-canvas-${createMountNonce()}`, [app.appId])
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

  // Sash drag: pointer x → ratio of the shell row, clamped to the pane band.
  useEffect(() => {
    if (!isDragging) return
    const onMove = (event: MouseEvent) => {
      const rect = getLayoutRect()
      if (!rect || rect.width <= 0) return
      setWidthRatio(clampCanvasPaneRatio((rect.right - event.clientX) / rect.width))
    }
    const onUp = () => setIsDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [getLayoutRect, isDragging, setWidthRatio])

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
    <div
      className="relative flex items-stretch shrink-0"
      style={{ width: `${widthRatio * 100}%` }}
      data-canvas-pane={app.appId}
    >
      {/* Resize sash straddling the panel gap on the pane's left edge. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('genui.app.canvasResize')}
        aria-valuenow={Math.round(widthRatio * 100)}
        aria-valuemin={Math.round(CANVAS_PANE_MIN_RATIO * 100)}
        aria-valuemax={Math.round(CANVAS_PANE_MAX_RATIO * 100)}
        tabIndex={0}
        onMouseDown={(e) => { e.preventDefault(); setIsDragging(true) }}
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
          <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground/70">
            {t('genui.app.loadError')}
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
    </div>
  )
}
