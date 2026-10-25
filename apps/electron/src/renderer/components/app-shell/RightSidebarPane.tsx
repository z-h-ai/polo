/**
 * POO-135: the unified right sidebar — canvas apps and the browser pane share
 * ONE container (the pane shell CanvasPane owned: motion width, drag sash,
 * window-wide drag mask). Both kinds of content can be open at once; the
 * two-layer header switches between them:
 *
 * - layer 1 (window ops + title): canvas/browser tabs, the browser's
 *   ownership title (加入：<会话名>), instance switcher, pop-out / return,
 *   terminate. Canvas keeps its own card header (unchanged behavior).
 * - layer 2 (navigation + picking): back/forward/reload, URL entry, and the
 *   「选择网页元素」 entry — the sidebar never gains a header-entry browser
 *   create button (locked spec); creation happens here only via the pane's
 *   own empty state, mirroring the existing entry points.
 *
 * A browser popped out to a standalone window shows a placeholder card in the
 * slot (「已在独立窗口中打开」+ 收回); system-closing that popup returns the
 * browser here (use-sidebar-browser-sync). Narrow viewports keep the existing
 * compact single-column rule (the whole right sidebar, canvas included, is
 * hidden by AppShell's isAutoCompact).
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { getDefaultStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  ExternalLink,
  Globe,
  LayoutGrid,
  PictureInPicture2,
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
  canvasPaneRatioFromPointer,
  clampCanvasPaneRatio,
  canvasPaneWidthAtomFamily,
  type CanvasPaneApp,
} from '@/atoms/canvas-pane'
import { CanvasPaneCard } from './CanvasPane'
import {
  activeElementPickingAtom,
  filterSidebarBrowserInstances,
  resolvePickTargetSessionId,
  resolveSidebarBrowserInstance,
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} from '@/atoms/sidebar-browser'
import { browserInstancesMapAtom } from '@/atoms/browser-pane'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { useSidebarBrowserSync } from '@/hooks/use-sidebar-browser-sync'

/** Fallback width-atom key when only the browser slot is open (no session canvas key). */
export const SIDEBAR_ONLY_WIDTH_KEY = 'sidebar-browser-only'
/** Keyboard nudge per ArrowLeft/ArrowRight on the sash — same as CanvasPane. */
const KEYBOARD_RATIO_STEP = 0.025
const CANVAS_PANE_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }
const CANVAS_PANE_REDUCED_TWEEN = { type: 'tween' as const, duration: 0.12 }

interface RightSidebarPaneProps {
  /** Width-atom key — the session id when a canvas exists, else the fallback. */
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
}

export function RightSidebarPane({
  layoutKey,
  canvasSessionId,
  canvasApp,
  getLayoutRect,
  currentSessionId,
  activeWorkspaceId,
  remoteWorkspaceId,
  onSelectSession,
}: RightSidebarPaneProps) {
  const { t } = useTranslation()
  const [widthRatio, setWidthRatio] = useAtom(
    useMemo(() => canvasPaneWidthAtomFamily(layoutKey || SIDEBAR_ONLY_WIDTH_KEY), [layoutKey]),
  )
  const [isDragging, setIsDragging] = useState(false)
  const reduceMotion = useReducedMotion()

  const browserSlotOpen = useAtomValue(sidebarBrowserOpenAtom)
  const storedTab = useAtomValue(rightPaneTabAtom)

  // The pane exists when either content kind is open; with only one kind open
  // it always shows that kind regardless of the stored tab.
  const effectiveTab = canvasApp && browserSlotOpen ? storedTab : browserSlotOpen ? 'browser' : 'canvas'

  const { terminateBrowser } = useSidebarBrowserSync({
    currentSessionId,
    activeWorkspaceId,
    remoteWorkspaceId,
    onSelectSession,
  })

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
      animate={{ width: `${widthRatio * 100}%` }}
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
        {canvasApp && browserSlotOpen && (
          <RightPaneTabs tab={effectiveTab} />
        )}
        {effectiveTab === 'canvas' && canvasApp && canvasSessionId ? (
          <CanvasPaneCard sessionId={canvasSessionId} app={canvasApp} />
        ) : (
          <SidebarBrowserSection
            currentSessionId={currentSessionId}
            activeWorkspaceId={activeWorkspaceId}
            remoteWorkspaceId={remoteWorkspaceId}
            onSelectSession={onSelectSession}
            onTerminate={terminateBrowser}
          />
        )}
      </div>
    </motion.div>
  )
}

/** Layer 1 tab strip — only rendered when BOTH content kinds are open. */
function RightPaneTabs({ tab }: { tab: 'canvas' | 'browser' }) {
  const { t } = useTranslation()
  const setTab = useSetAtom(rightPaneTabAtom)
  return (
    <div
      className="px-2 py-1.5 bg-muted/50 border-b flex items-center gap-1 shrink-0"
      data-testid="right-pane-tabs"
    >
      <button
        type="button"
        data-testid="right-pane-tab-canvas"
        aria-pressed={tab === 'canvas'}
        onClick={() => setTab('canvas')}
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
        onClick={() => setTab('browser')}
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
  activeWorkspaceId: string | null
  remoteWorkspaceId: string | null
  onSelectSession: (sessionId: string) => void
  onTerminate: (instance: BrowserInstanceInfo) => Promise<void>
}

/** The browser slot: layer-2 header over the embedded container / placeholder / empty state. */
function SidebarBrowserSection({
  currentSessionId,
  activeWorkspaceId,
  remoteWorkspaceId,
  onSelectSession,
  onTerminate,
}: SidebarBrowserSectionProps) {
  const { t } = useTranslation()
  const allInstances = useAtomValue(browserInstancesMapAtom)
  const selectedId = useAtomValue(sidebarBrowserInstanceIdAtom)
  const setSelectedId = useSetAtom(sidebarBrowserInstanceIdAtom)
  const picking = useAtomValue(activeElementPickingAtom)
  const sessionMetas = useAtomValue(sessionMetaMapAtom)

  const visible = useMemo(
    () =>
      filterSidebarBrowserInstances(
        Array.from(allInstances.values()),
        currentSessionId,
        activeWorkspaceId,
        remoteWorkspaceId,
      ),
    [allInstances, currentSessionId, activeWorkspaceId, remoteWorkspaceId],
  )
  const instance = resolveSidebarBrowserInstance(visible, selectedId)
  const targetSessionId = resolvePickTargetSessionId(instance, currentSessionId)
  const isPicking = Boolean(instance && picking?.instanceId === instance.id)

  const handleCreate = useCallback(async () => {
    const api = window.electronAPI?.browserPane
    if (!api) return
    try {
      // Same creation source as an in-chat session browser: bound to the
      // current session so ownership isolation applies from birth.
      const id = await api.create({ show: false, bindToSessionId: currentSessionId ?? undefined })
      const store = getDefaultStore()
      store.set(sidebarBrowserOpenAtom, true)
      store.set(sidebarBrowserInstanceIdAtom, id)
      await api.embed(id)
    } catch {
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [currentSessionId, t])

  const handleEmbed = useCallback(async (id: string) => {
    try {
      await window.electronAPI?.browserPane?.embed?.(id)
    } catch {
      toast.error(t('toast.failedToEmbedBrowser'))
    }
  }, [t])

  const handleDetach = useCallback(async (id: string) => {
    try {
      await window.electronAPI?.browserPane?.detachToPopup?.(id)
    } catch {
      toast.error(t('toast.failedToDetachBrowser'))
    }
  }, [t])

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
            onChange={(e) => setSelectedId(e.target.value)}
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
        {instance.hostMode === 'popup' ? (
          <button
            type="button"
            data-testid="sidebar-browser-embed"
            title={t('browserPane.sidebar.embed')}
            onClick={() => void handleEmbed(instance.id)}
            className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <PictureInPicture2 className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            type="button"
            data-testid="sidebar-browser-detach"
            title={t('browserPane.sidebar.detach')}
            onClick={() => void handleDetach(instance.id)}
            className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          data-testid="sidebar-browser-terminate"
          title={t('browserPane.sidebar.terminate')}
          onClick={() => void onTerminate(instance)}
          className="shrink-0 inline-flex items-center justify-center rounded-[6px] p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Layer 2: navigation + element picking. */}
      <BrowserNavLayer
        instance={instance}
        targetSessionId={targetSessionId}
        currentSessionId={currentSessionId}
        isPicking={isPicking}
      />

      {instance.hostMode === 'popup' ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-4 text-center" data-testid="sidebar-browser-popup-placeholder">
          <ExternalLink className="w-5 h-5 text-muted-foreground/60" />
          <div className="text-[13px] font-medium text-foreground-80">
            {t('browserPane.sidebar.popupTitle')}
          </div>
          <div className="max-w-[260px] text-[12px] text-muted-foreground">
            {t('browserPane.sidebar.popupBody')}
          </div>
          <button
            type="button"
            onClick={() => void handleEmbed(instance.id)}
            className="mt-1 inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-background px-2.5 py-1 text-[12px] text-foreground-80 transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            <PictureInPicture2 className="w-3.5 h-3.5" />
            {t('browserPane.sidebar.embed')}
          </button>
        </div>
      ) : (
        <EmbeddedBrowserContainer instanceId={instance.id} />
      )}
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
    const store = getDefaultStore()
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
  }, [currentSessionId, instance.id, isPicking, targetSessionId, t])

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
 * The embedded browser container: a purely visual mount point. The actual
 * WebContentsView lives in Main, layered over this window at the bounds we
 * report — ResizeObserver keeps those bounds tracking the pane (open/close
 * animation included).
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
