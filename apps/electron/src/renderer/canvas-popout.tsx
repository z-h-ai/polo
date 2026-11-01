/**
 * Canvas Popout — standalone-window carrier for a popped-out canvas app
 * (POO-135 验收修复, SB-CANVAS-OUT).
 *
 * Main's CanvasPopupManager opens an 880×720 BrowserWindow pointed at this
 * entry with `?sessionId=…&app=<encoded CanvasPaneApp>`. The page mounts the
 * SAME CanvasPaneCard the right sidebar hosts — same ephemeral
 * `genui-app-<sessionId>` partition, same bundle src, same UiCardRegistry
 * registration (GenUiCardRegistryBridge forwards the card's CustomEvents to
 * Main through the shared bootstrap preload) — so the popup is just another
 * carrier of the one logical canvas.
 *
 * The persistent carrier contains the original guest. Its ✕ hides the current
 * surface; only an explicit return moves it into the sidebar.
 */

import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { useTranslation } from 'react-i18next'
import {
  GENUI_APP_CANVAS_CLOSE_EVENT,
  type GenUiAppCanvasCloseRequest,
} from '@polo-ai/ui/chat/GenUiAppCard'
import { GenUiCardRegistryBridge } from './components/tab-browser/GenUiCardRegistryBridge'
import { CanvasPaneCard } from './components/app-shell/CanvasPane'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './components/ui/dropdown-menu'
import { MoreHorizontal } from 'lucide-react'
import type { CanvasPaneApp } from '../shared/types'
import './index.css'

// i18n before any React rendering — same explicit resolution as main.tsx:
// the stored choice first (localStorage is shared per-origin with the main
// window in both dev and packaged builds), then the POO-41 product default.
setupI18n([initReactI18next])
const STORED_LANGUAGE_KEY = 'i18nextLng'
// eslint-disable-next-line polo-ai/no-localstorage -- i18next language cache key; also written by AppearanceSettingsPage on explicit change
const storedLanguage = window.localStorage.getItem(STORED_LANGUAGE_KEY)
void i18n.changeLanguage(storedLanguage ?? 'zh-Hans')

/** Keep the OS theme class in sync after first paint (system-mode changes). */
function useSyncThemeClass(): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      let mode: string | null = null
      try {
        // eslint-disable-next-line polo-ai/no-localstorage -- same craft-theme payload ThemeContext persists
        const raw = window.localStorage.getItem('craft-theme')
        if (raw) {
          const stored = JSON.parse(raw)
          if (stored && typeof stored.mode === 'string') mode = stored.mode
        }
      } catch { /* fall through to system preference */ }
      const dark = mode === 'dark' || ((mode === null || mode === 'system') && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.classList.toggle('light', !dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
}

interface PopoutPayload {
  sessionId: string
  app: CanvasPaneApp
}

function parsePopoutPayload(): PopoutPayload | null {
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('sessionId')
  const rawApp = params.get('app')
  if (!sessionId || !rawApp) return null
  try {
    const app = JSON.parse(rawApp) as CanvasPaneApp
    if (
      typeof app !== 'object' || app === null ||
      typeof app.appId !== 'string' || !app.appId ||
      typeof app.title !== 'string' ||
      typeof app.indexPath !== 'string' || !app.indexPath
    ) return null
    return { sessionId, app }
  } catch {
    return null
  }
}

function PopoutFallback({ messageKey }: { messageKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="h-full w-full flex items-center justify-center text-[13px] text-muted-foreground/70">
      {t(messageKey)}
    </div>
  )
}

function CanvasPopoutApp() {
  useSyncThemeClass()
  // The payload is fixed per window — parse once, defensively (Main always
  // sends a well-formed pair; a corrupted handoff degrades to a message).
  const [poppedOut, setPoppedOut] = useState(false)
  const [payload] = useState<PopoutPayload | null>(parsePopoutPayload)
  const { t } = useTranslation()
  const app = useMemo(() => payload?.app ?? null, [payload])

  useEffect(() => {
    if (!payload) return
    const off = window.electronAPI.canvasPane.onStateChanged(state => { if (state.sessionId === payload.sessionId) setPoppedOut(state.poppedOut) })
    // The card header ✕ hides this surface and preserves the existing instance.
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<GenUiAppCanvasCloseRequest>).detail
      if (!detail || detail.sessionId !== payload.sessionId) return
      void window.electronAPI?.canvasPane?.hide(payload.sessionId)
    }
    window.addEventListener(GENUI_APP_CANVAS_CLOSE_EVENT, listener)
    return () => { off(); window.removeEventListener(GENUI_APP_CANVAS_CLOSE_EVENT, listener) }
  }, [payload])

  if (!payload || !app) return <PopoutFallback messageKey="genui.app.loadError" />
  return (
    <div className="h-screen w-screen p-0 relative">
      <GenUiCardRegistryBridge />
      <CanvasPaneCard nativeGuest sessionId={payload.sessionId} app={app} onPopOut={poppedOut ? undefined : () => { void window.electronAPI.canvasPane.detachToPopup(payload.sessionId, app) }} headerActions={
        <DropdownMenu><DropdownMenuTrigger asChild><button type="button" title={t('common.more')} className="p-1 text-muted-foreground hover:bg-muted rounded"><MoreHorizontal className="w-3.5 h-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end">
          {poppedOut && <DropdownMenuItem onSelect={() => { void window.electronAPI.canvasPane.attachFromPopup(payload.sessionId) }}>{t('browserPane.sidebar.embed')}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => { void window.electronAPI.canvasPane.destroy(payload.sessionId) }}>{t('common.close')}</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      } />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CanvasPopoutApp />
  </React.StrictMode>,
)
