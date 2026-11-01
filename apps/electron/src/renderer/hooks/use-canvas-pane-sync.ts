/**
 * POO-135 验收修复 (SB-CANVAS-OUT): renderer-side wiring between Main's
 * CanvasPopupManager and the canvas-pane atoms — the canvas counterpart of
 * use-sidebar-browser-sync.
 *
 * Subscribes `canvas-pane:state-changed` and mirrors every broadcast into
 * `canvasPanePopoutAtomFamily(sessionId)`. Mounted at the AppShell layer
 * (next to useSidebarBrowserSync) so the subscription survives narrow
 * viewports and a closed sidebar slot: a system-closed popup reconciles the
 * sidebar even when no pane is rendered.
 *
 * Store discipline: writes go through useSetAtom — the CONTEXT store —
 * because the readers (RightSidebarPane / GenUiCanvasBridge under the root
 * <JotaiProvider>) resolve atoms against that same store. getDefaultStore()
 * is a DIFFERENT store in jotai v2 and its writes never reach provider-tree
 * readers. Main is the single authority on where the canvas lives — the hook
 * never writes `poppedOut` from the renderer side.
 */

import { useEffect, useRef } from 'react'
import { useStore } from 'jotai'
import { dispatchGenUiAppCanvasState } from '@polo-ai/ui/chat/GenUiAppCard'
import { rightPaneTabAtom } from '@/atoms/sidebar-browser'
import { canvasPanePopoutAtomFamily, canvasPaneAppAtomFamily } from '@/atoms/canvas-pane'

export function useCanvasPaneSync(options?: { currentSessionId?: string | null; onPresented?: () => void }): void {
  const optionsRef = useRef(options)
  optionsRef.current = options
  // The CONTEXT store (same discipline as GenUiCanvasBridge) — the per-session
  // family means writes need the store handle, not a fixed useSetAtom.
  const store = useStore()
  useEffect(() => {
    const api = window.electronAPI?.canvasPane
    if (!api?.onStateChanged || !window.electronAPI.isChannelAvailable?.('canvas-pane:detach-to-popup')) return
    return api.onStateChanged((state) => {
      if (state.closed) {
        store.set(canvasPaneAppAtomFamily(state.sessionId), null)
        store.set(canvasPanePopoutAtomFamily(state.sessionId), null)
        dispatchGenUiAppCanvasState({ sessionId: state.sessionId, appId: null })
        return
      }
      store.set(canvasPanePopoutAtomFamily(state.sessionId), { ...state })
      if (state.isVisible && !state.poppedOut && state.sessionId === optionsRef.current?.currentSessionId) {
        store.set(rightPaneTabAtom, 'canvas')
        optionsRef.current?.onPresented?.()
      }
    })
  }, [store])
}
