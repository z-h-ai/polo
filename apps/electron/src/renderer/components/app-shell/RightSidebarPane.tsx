/** One sidebar shell for files, pages and trusted canvases. Popup and hidden
 * instances keep their native contents in Main while this surface releases its width. */

import { MIN_CHAT_WIDTH } from "./right-pane-layout"
import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  ExternalLink,
  Globe,
  LayoutGrid,
  RotateCw,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { BrowserInstanceInfo } from '../../../shared/types'
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
  canvasPanePopoutAtomFamily,
  canvasPaneRatioFromPointer,
  clampCanvasPaneRatio,
  canvasPaneWidthAtomFamily,
  type CanvasPaneApp,
} from '@/atoms/canvas-pane'
import { CanvasPaneCard } from './CanvasPane'
import {
  activeElementPickingAtom,
  resolvePickTargetSessionId,
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} from '@/atoms/sidebar-browser'
import { useRightPanePresentation } from '@/hooks/use-right-pane-presentation'
import { sessionMetaMapAtom } from '@/atoms/sessions'

/** Fallback width-atom key when only the browser slot is open (no session canvas key). */
export const SIDEBAR_ONLY_WIDTH_KEY = 'sidebar-browser-only'
/** Keyboard nudge per ArrowLeft/ArrowRight on the sash — same as CanvasPane. */
const KEYBOARD_RATIO_STEP = 0.025
const CANVAS_PANE_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }
const CANVAS_PANE_REDUCED_TWEEN = { type: 'tween' as const, duration: 0.12 }

interface RightSidebarPaneProps {
  /** Width-atom key — the session id when a canvas exists, else the fallback. */
  visible?: boolean
  filePreviewVisible?: boolean
  filePreview?: React.ReactNode
  layoutKey: string
  canvasSessionId: string | null
  canvasApp: CanvasPaneApp | null
  /**
   * Rect of the shell flex row the pane's width ratio is measured against
   * (AppShell's shellRef) — dragging converts pointer x into a ratio of it.
   */
  getLayoutRect: () => DOMRect | null
  currentSessionId: string | null
  activeWorkspaceId: string | null
  remoteWorkspaceId: string | null
  onSelectSession: (sessionId: string) => void
  /**
   * POO-135 r1: terminate from the AppShell-resident sync hook — the hook
   * lives above the pane so its event subscriptions survive narrow viewports
   * and a closed sidebar slot.
   */
  onTerminate: (instance: BrowserInstanceInfo) => Promise<void>
}

export function RightSidebarPane({
  visible = true,
  filePreviewVisible = true,
  filePreview,
  layoutKey,
  canvasSessionId,
  canvasApp: suppliedCanvasApp,
  getLayoutRect,
  currentSessionId,
  activeWorkspaceId,
  remoteWorkspaceId,
  onSelectSession,
  onTerminate,
}: RightSidebarPaneProps) {
  const { t } = useTranslation()
  const [widthRatio, setWidthRatio] = useAtom(
    useMemo(() => canvasPaneWidthAtomFamily(layoutKey || SIDEBAR_ONLY_WIDTH_KEY), [layoutKey]),
  )
  const [isDragging, setIsDragging] = useState(false)
  const reduceMotion = useReducedMotion()

  const canvasPresentation = useAtomValue(useMemo(() => canvasPanePopoutAtomFamily(canvasSessionId ?? ''), [canvasSessionId]))
  const canvasApp = suppliedCanvasApp && !canvasPresentation?.poppedOut && canvasPresentation?.isVisible !== false ? suppliedCanvasApp : null
  const presentation = useRightPanePresentation({ currentSessionId, activeWorkspaceId, remoteWorkspaceId, fileVisible: Boolean(filePreview && filePreviewVisible), canvasVisible: Boolean(canvasApp) })
  const { browserSlotOpen } = presentation
  const storedTab = useAtomValue(rightPaneTabAtom)
  const browserReachable = browserSlotOpen && Boolean(presentation.instance)
  const paneVisible = visible && presentation.hasRightPane

  // The pane exists when either content kind is open; with only one kind open
  // it always shows that kind regardless of the stored tab.
  const effectiveTab = canvasApp && browserReachable ? storedTab : browserReachable ? 'browser' : 'canvas'

  // The ambient jotai store (the <JotaiProvider> context store), NOT
  // getDefaultStore() — a default-store write lands in a different store and
  // the useAtomValue readers above would never see it (POO-135 r3). Same
  // discipline as GenUiCanvasBridge.
  const store = useStore()

  /** POO-135 r1: leaving the browser content (tab/instance switch) disarms an
   * active picker — the page-side picking never silently re-points. */
  const disarmArmedPicker = useCallback(() => {
    const picking = store.get(activeElementPickingAtom)
    if (!picking) return
    store.set(activeElementPickingAtom, null)
    void window.electronAPI?.browserPane?.setElementPicking?.(picking.instanceId, false).catch(() => {})
  }, [store])

  const handleTabSwitch = useCallback((tab: 'canvas' | 'browser') => {
    disarmArmedPicker()
    if (tab === 'browser') store.set(sidebarBrowserOpenAtom, true)
    store.set(rightPaneTabAtom, tab)
  }, [disarmArmedPicker, store])

  // POO-135 验收修复 (SB-CANVAS-OUT): canvas popout controls. Main owns the
  // window and broadcasts the reconciling state; the sidebar only requests.
  const handleCanvasDetach = useCallback(() => {
    if (!canvasSessionId || !canvasApp) return
    void window.electronAPI?.canvasPane?.detachToPopup?.(canvasSessionId, {
      appId: canvasApp.appId,
      title: canvasApp.title,
      indexPath: canvasApp.indexPath,
      version: canvasApp.version,
    }).catch(() => {
      toast.error(t('toast.failedToDetachCanvas'))
    })
  }, [canvasApp, canvasSessionId, t])

  // Sash drag: pointer x → ratio of the shell row — same contract as
  // CanvasPane (content-box basis; see the measurement comment there).
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

  return (
    <motion.div
      ref={rootRef}
      className="relative flex items-stretch shrink-0"
      initial={{ width: '0%' }}
      animate={{ width: paneVisible ? `${widthRatio * 100}%` : '0%' }}
      style={{ visibility: paneVisible ? undefined : 'hidden', overflow: paneVisible ? undefined : 'hidden', maxWidth: paneVisible ? `calc(100% - ${MIN_CHAT_WIDTH}px)` : undefined }}
      transition={
        isDragging
          ? { duration: 0 }
          : reduceMotion
            ? CANVAS_PANE_REDUCED_TWEEN
            : CANVAS_PANE_SPRING
      }
      data-right-sidebar-pane="true"
    >
      {isDragging &&
        createPortal(
          <div
            className="fixed inset-0 z-panel cursor-col-resize"
            data-right-sidebar-drag-mask="true"
            aria-hidden="true"
          />,
          document.body,
        )}
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
            isDragging ? 'bg-accent' : 'bg-transparent hover:bg-accent/40',
          )}
          style={{ width: PANEL_SASH_LINE_WIDTH }}
        />
      </div>
      <div className="h-full w-full min-w-0 flex flex-col overflow-hidden rounded-[8px] border bg-background">
        {!(filePreview && filePreviewVisible) && canvasApp && browserReachable && (
          <RightPaneTabs tab={effectiveTab} onSwitch={handleTabSwitch} />
        )}
        {filePreview && <div hidden={!filePreviewVisible} className="flex-1 min-h-0 h-full">{filePreview}</div>}
        {filePreview && filePreviewVisible ? null : effectiveTab === 'canvas' && canvasApp && canvasSessionId ? (
          <CanvasPaneCard sessionId={canvasSessionId} app={canvasApp} onPopOut={handleCanvasDetach} />
        ) : browserSlotOpen ? (
          <SidebarBrowserSection
            currentSessionId={currentSessionId}
            instances={presentation.instances}
            instance={presentation.instance}
            onSelectSession={onSelectSession}
            onTerminate={onTerminate}
            onSwitchAway={disarmArmedPicker}
          />
        ) : null}
      </div>
    </motion.div>
  )
}

/** Layer 1 tab strip — only rendered when BOTH content kinds are open. */
function RightPaneTabs({ tab, onSwitch }: { tab: 'canvas' | 'browser'; onSwitch: (tab: 'canvas' | 'browser') => void }) {
  const { t } = useTranslation()
  return (
    <div
      className="px-2 py-1.5 bg-muted/50 border-b flex items-center gap-1 shrink-0"
      data-testid="right-pane-tabs"
    >
      <button
        type="button"
        data-testid="right-pane-tab-canvas"
        aria-pressed={tab === 'canvas'}
        onClick={() => onSwitch('canvas')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors',
          tab === 'canvas'
            ? 'bg-background text-foreground shadow-minimal'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        {t('browserPane.sidebar.tabs.canvas')}
      </button>
      <button
        type="button"
        data-testid="right-pane-tab-browser"
        aria-pressed={tab === 'browser'}
        onClick={() => onSwitch('browser')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors',
          tab === 'browser'
            ? 'bg-background text-foreground shadow-minimal'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Globe className="w-3.5 h-3.5" />
        {t('browserPane.sidebar.tabs.browser')}
      </button>
    </div>
  )
}

interface SidebarBrowserSectionProps {
  currentSessionId: string | null
  instances: BrowserInstanceInfo[]
  instance: BrowserInstanceInfo | null
  onSelectSession: (sessionId: string) => void
  onTerminate: (instance: BrowserInstanceInfo) => Promise<void>
  /** POO-135 r1: disarm an armed picker before the shown instance changes. */
  onSwitchAway: () => void
}

/** The browser slot: layer-2 header over the embedded container / placeholder / empty state. */
function SidebarBrowserSection({
  currentSessionId,
  instances: visible,
  instance,
  onSelectSession,
  onTerminate,
  onSwitchAway,
}: SidebarBrowserSectionProps) {
  const { t } = useTranslation()
  const setSelectedId = useSetAtom(sidebarBrowserInstanceIdAtom)
  const picking = useAtomValue(activeElementPickingAtom)
  const sessionMetas = useAtomValue(sessionMetaMapAtom)

  const targetSessionId = resolvePickTargetSessionId(instance, currentSessionId)
  const isPicking = Boolean(instance && picking?.instanceId === instance.id)

  // The ambient jotai store (the <JotaiProvider> context store), NOT
  // getDefaultStore() — the useAtomValue readers in RightSidebarPane scope to
  // the provider store, so a default-store write would be invisible there
  // (POO-135 r3).
  const store = useStore()

  const handleCreate = useCallback(async () => {
    const api = window.electronAPI?.browserPane
    if (!api) return
    try {
      // Spec v0.7 suggested behavior 5: a manual create stays workspace-
      // visible and is NOT bound to the current session (no forced isolation).
      const id = await api.create({ show: false })
      store.set(sidebarBrowserOpenAtom, true)
      store.set(sidebarBrowserInstanceIdAtom, id)
      await api.embed(id)
    } catch {
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [store, t])

  const handleDetach = useCallback(async (id: string) => {
    // r3 (spec 28): detaching cancels an armed picker — the popup hosts a
    // fresh webview and must not inherit a live picking session.
    onSwitchAway()
    try {
      await window.electronAPI?.browserPane?.detachToPopup?.(id)
      store.set(sidebarBrowserOpenAtom, false)
    } catch {
      toast.error(t('toast.failedToDetachBrowser'))
    }
  }, [onSwitchAway, store, t])

  /** POO-135 r1 (spec suggested behavior 4): hide without destroying — the
   * instance object, its page and its history all stay alive in Main. */
  const handleHide = useCallback(async (id: string) => {
    onSwitchAway()
    try {
      await window.electronAPI?.browserPane?.unembed?.(id)
    } catch {
      // Main also unhooks the view when the container unmounts.
    }
    store.set(sidebarBrowserOpenAtom, false)
    store.set(rightPaneTabAtom, 'canvas')
    toast.info(t('browserPane.sidebar.hiddenToast'), {
      duration: 8000,
      action: {
        label: t('browserPane.sidebar.show'),
        onClick: () => {
          store.set(sidebarBrowserOpenAtom, true)
          store.set(rightPaneTabAtom, 'browser')
        },
      },
    })
  }, [onSwitchAway, store, t])

  if (instance?.hostMode === 'popup') return null

  if (!instance) {
    return <SidebarBrowserEmptyState onCreate={handleCreate} />
  }

  const ownershipTitle = instance.ownerSessionId
    ? t('browserPane.sidebar.ownershipTitle', {
        session: sessionMetas.get(instance.ownerSessionId)?.name ?? t('browserPane.sidebar.thisSession'),
      })
    : t('browserPane.sidebar.workspaceTitle')

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="sidebar-browser-section">
      {/* Layer 1: window ops + ownership title. */}
      <div className="px-2 py-1.5 bg-muted/50 border-b flex items-center gap-1.5 shrink-0">
        <Globe className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
        <span
          className="text-[12px] text-muted-foreground font-medium truncate flex-1 min-w-0"
          data-testid="sidebar-browser-title"
        >
          {ownershipTitle}
        </span>
        {visible.length > 1 && (
          <select
            aria-label={t('browserPane.sidebar.selectInstance')}
            data-testid="sidebar-browser-instance-select"
            value={instance.id}
            onChange={(e) => {
              // POO-135 r1: switching instances disarms the armed picker —
              // the page-side picking never silently re-points.
              onSwitchAway()
              setSelectedId(e.target.value)
            }}
            className="shrink-0 max-w-[110px] rounded-[6px] border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground-80 outline-none"
          >
            {visible.map((item) => (
              <option key={item.id} value={item.id}>
                {item.ownerSessionId ? t('browserPane.sidebar.thisSession') : t('browserPane.sidebar.workspaceTitle')}
                {' · '}
                {item.id}
              </option>
            ))}
          </select>
        )}
          <button
            type="button"
            data-testid="sidebar-browser-detach"
            title={t('browserPane.sidebar.detach')}
            onClick={() => void handleDetach(instance.id)}
            className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        <button
          type="button"
          data-testid="sidebar-browser-hide"
          title={t('browserPane.sidebar.hide')}
          onClick={() => void handleHide(instance.id)}
          className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Layer 2: navigation + element picking — embedded only. A popped-out
          browser's single active surface is the popup window; the slot keeps a
          read-only status bar with a show-window entry (spec: one active
          location). */}
      <BrowserNavLayer instance={instance} targetSessionId={targetSessionId} currentSessionId={currentSessionId} isPicking={isPicking} />
      <EmbeddedBrowserContainer instanceId={instance.id} />
    </div>
  )
}

interface BrowserNavLayerProps {
  instance: BrowserInstanceInfo
  targetSessionId: string | null
  /** Session selected right now — the picking origin when arming. */
  currentSessionId: string | null
  isPicking: boolean
}

/** Layer 2: back / forward / reload, URL entry, and the element-picking entry. */
function BrowserNavLayer({ instance, targetSessionId, currentSessionId, isPicking }: BrowserNavLayerProps) {
  const { t } = useTranslation()
  const [urlDraft, setUrlDraft] = useState(instance.url ?? '')
  const navigatingRef = useRef(false)
  // The ambient jotai store (the <JotaiProvider> context store), NOT
  // getDefaultStore() — the picking readers scope to the provider store
  // (POO-135 r3).
  const store = useStore()

  // Follow navigations the user made inside the page (link clicks, redirects).
  useEffect(() => {
    if (!navigatingRef.current) setUrlDraft(instance.url ?? '')
  }, [instance.url])

  const navigate = useCallback(async (raw: string) => {
    const api = window.electronAPI?.browserPane
    if (!api) return
    const trimmed = raw.trim()
    if (!trimmed) return
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    navigatingRef.current = true
    try {
      await api.navigate(instance.id, url)
      setUrlDraft(url)
    } catch {
      toast.error(t('toast.failedToNavigateBrowser'))
    } finally {
      navigatingRef.current = false
    }
  }, [instance.id, t])

  const togglePicking = useCallback(async () => {
    const api = window.electronAPI?.browserPane
    if (!api?.setElementPicking || !targetSessionId) return
    if (isPicking) {
      store.set(activeElementPickingAtom, null)
      try {
        await api.setElementPicking(instance.id, false)
      } catch {
        // Main clears its own armed state on failure; nothing to toast.
      }
      return
    }
    store.set(activeElementPickingAtom, {
      instanceId: instance.id,
      targetSessionId,
      originSessionId: currentSessionId ?? '',
    })
    try {
      await api.setElementPicking(instance.id, true, { targetSessionId })
    } catch {
      store.set(activeElementPickingAtom, null)
      toast.error(t('browserPane.elementPicker.startFailed'))
    }
  }, [currentSessionId, instance.id, isPicking, store, targetSessionId, t])

  return (
    <div
      className="px-2 py-1.5 border-b bg-background/60 flex items-center gap-1 shrink-0"
      data-testid="sidebar-browser-nav-layer"
    >
      <button
        type="button"
        aria-label={t('browserPane.sidebar.back')}
        disabled={!instance.canGoBack}
        onClick={() => void window.electronAPI?.browserPane?.goBack?.(instance.id)}
        className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('browserPane.sidebar.forward')}
        disabled={!instance.canGoForward}
        onClick={() => void window.electronAPI?.browserPane?.goForward?.(instance.id)}
        className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <ArrowRight className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('browserPane.sidebar.reload')}
        onClick={() => window.electronAPI?.browserPane?.reload?.(instance.id)}
        className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <RotateCw className="w-3.5 h-3.5" />
      </button>
      <input
        value={urlDraft}
        onChange={(e) => setUrlDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void navigate(urlDraft)
        }}
        placeholder={t('browserPane.sidebar.urlPlaceholder')}
        aria-label={t('browserPane.sidebar.urlPlaceholder')}
        data-testid="sidebar-browser-url-input"
        spellCheck={false}
        className="min-w-0 flex-1 rounded-[6px] border border-border bg-background px-2 py-1 text-[12px] text-foreground-80 outline-none focus:border-accent/60"
      />
      <button
        type="button"
        data-testid="sidebar-browser-pick-element"
        aria-pressed={isPicking}
        disabled={!targetSessionId}
        title={
          !targetSessionId
            ? t('browserPane.sidebar.noTargetSession')
            : isPicking
              ? t('browserPane.sidebar.pickingActive')
              : t('browserPane.sidebar.pickElement')
        }
        onClick={() => void togglePicking()}
        className={cn(
          'shrink-0 inline-flex items-center gap-1 rounded-[6px] px-1.5 py-1 text-[11px] font-medium transition-colors',
          isPicking
            ? 'bg-accent text-background hover:bg-accent/90'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          !targetSessionId && 'opacity-40 pointer-events-none',
        )}
      >
        <Crosshair className="w-3.5 h-3.5" />
        {t('browserPane.sidebar.pickElement')}
      </button>
    </div>
  )
}

/**
 * POO-135 r1: read-only status bar shown while the browser is popped out —
 * the popup window is the single active surface; the slot offers showing it.
 */

/**
 * The embedded browser container: a purely visual mount point. The actual
 * WebContentsView lives in Main, layered over this window at the bounds we
 * report — ResizeObserver keeps those bounds tracking the pane (open/close
 * animation included).
 *
 * POO-135 r1: on unmount the view is detached in Main (unembed) — every
 * route off this container (tab switch, narrow viewport, session switch,
 * hide) must stop the native view from covering window content.
 */
function EmbeddedBrowserContainer({ instanceId }: { instanceId: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const report = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      void window.electronAPI?.browserPane?.setEmbedBounds?.(
        instanceId,
        {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      ).catch(() => {})
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      void window.electronAPI?.browserPane?.unembed?.(instanceId).catch(() => {})
    }
  }, [instanceId])

  return (
    <div className="flex-1 min-h-0 p-2">
      <div
        ref={containerRef}
        data-testid="sidebar-browser-embedded-container"
        className="h-full w-full rounded-[6px] border border-border bg-surface"
      />
    </div>
  )
}

function SidebarBrowserEmptyState({ onCreate }: { onCreate: () => Promise<void> }) {
  const { t } = useTranslation()
  return (
    <div
      className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="sidebar-browser-empty-state"
    >
      <Globe className="w-5 h-5 text-muted-foreground/60" />
      <div className="text-[13px] font-medium text-foreground-80">{t('browserPane.sidebar.emptyTitle')}</div>
      <div className="max-w-[240px] text-[12px] text-muted-foreground">{t('browserPane.sidebar.emptyBody')}</div>
      <button
        type="button"
        data-testid="sidebar-browser-create"
        onClick={() => void onCreate()}
        className="mt-1 inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-background px-2.5 py-1 text-[12px] text-foreground-80 transition-colors hover:border-foreground/20 hover:text-foreground"
      >
        <Globe className="w-3.5 h-3.5" />
        {t('browserPane.sidebar.emptyAction')}
      </button>
    </div>
  )
}
