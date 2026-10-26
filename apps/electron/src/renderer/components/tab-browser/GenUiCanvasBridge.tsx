/**
 * GenUiCanvasBridge - Electron-side state keeper for the right-side canvas
 * pane (POO-115).
 *
 * packages/ui's GenUiAppCard dispatches `craft:*-genui-canvas` CustomEvents
 * (it lives below this tree but cannot import renderer state without a
 * package cycle — same decoupling as the pin/publish bridges). This bridge:
 *
 * - open: writes the session's pane atom (replacing any app already in the
 *   pane — one app at a time) and broadcasts the new state, which is what
 *   every card reconciles against;
 * - close: only the app actually in the pane may close it, so a stale card
 *   for a different app cannot clobber the pane;
 * - query: freshly mounted cards replay the current state without changing
 *   it, so a remount never resurrects an inline webview the pane still holds.
 *
 * No Main/RPC involvement: the pane hosts the same session-local bundle the
 * inline card renders, in the same ephemeral partition, so there is nothing
 * new to audit or persist.
 */

import { useCallback, useEffect } from 'react'
import { useStore } from 'jotai'
import {
  GENUI_APP_CANVAS_CLOSE_EVENT,
  GENUI_APP_CANVAS_OPEN_EVENT,
  GENUI_APP_CANVAS_QUERY_EVENT,
  dispatchGenUiAppCanvasState,
  type GenUiAppCanvasCloseRequest,
  type GenUiAppCanvasOpenRequest,
  type GenUiAppCanvasQuery,
} from '@polo-ai/ui/chat/GenUiAppCard'
import { canvasPaneAppAtomFamily, canvasPanePopoutAtomFamily } from '@/atoms/canvas-pane'

export function GenUiCanvasBridge() {
  // The ambient jotai store, NOT getDefaultStore(): the app renders inside a
  // <JotaiProvider> (per-provider scope store), so AppShell's useAtomValue
  // reads the scoped store — a default-store write would land in a different
  // store and the pane would never open.
  const store = useStore()
  const handleOpen = useCallback((request: GenUiAppCanvasOpenRequest) => {
    if (!request.sessionId || !request.appId || !request.indexPath) return
    // POO-135 验收修复 (SB-CANVAS-OUT): the canvas lives in ONE surface per
    // session. An explicit open (inline card → sidebar canvas) while the
    // canvas is popped out first returns it — Main closes the popup and its
    // closed broadcast flips the popout flags; the sidebar shows the opened
    // app as soon as the pane atom is written here.
    if (store.get(canvasPanePopoutAtomFamily(request.sessionId))?.poppedOut) {
      void window.electronAPI?.canvasPane?.attachFromPopup?.(request.sessionId).catch(() => {})
    }
    store.set(canvasPaneAppAtomFamily(request.sessionId), {
      appId: request.appId,
      title: request.title,
      indexPath: request.indexPath,
      version: request.version,
    })
    dispatchGenUiAppCanvasState({ sessionId: request.sessionId, appId: request.appId })
  }, [store])

  const handleClose = useCallback((request: GenUiAppCanvasCloseRequest) => {
    if (!request.sessionId || !request.appId) return
    const current = store.get(canvasPaneAppAtomFamily(request.sessionId))
    if (!current || current.appId !== request.appId) return
    store.set(canvasPaneAppAtomFamily(request.sessionId), null)
    dispatchGenUiAppCanvasState({ sessionId: request.sessionId, appId: null })
  }, [store])

  const handleQuery = useCallback((query: GenUiAppCanvasQuery) => {
    if (!query.sessionId) return
    const current = store.get(canvasPaneAppAtomFamily(query.sessionId))
    dispatchGenUiAppCanvasState({ sessionId: query.sessionId, appId: current?.appId ?? null })
  }, [store])

  useEffect(() => {
    const listen = <T,>(type: string, handler: (detail: T) => void) => {
      const listener = (event: Event) => {
        const detail = (event as CustomEvent<T>).detail
        if (!detail || typeof detail !== 'object') return
        handler(detail)
      }
      window.addEventListener(type, listener)
      return () => window.removeEventListener(type, listener)
    }
    const unlisten = [
      listen<GenUiAppCanvasOpenRequest>(GENUI_APP_CANVAS_OPEN_EVENT, handleOpen),
      listen<GenUiAppCanvasCloseRequest>(GENUI_APP_CANVAS_CLOSE_EVENT, handleClose),
      listen<GenUiAppCanvasQuery>(GENUI_APP_CANVAS_QUERY_EVENT, handleQuery),
    ]
    return () => unlisten.forEach((fn) => fn())
  }, [handleClose, handleOpen, handleQuery])

  return null
}
