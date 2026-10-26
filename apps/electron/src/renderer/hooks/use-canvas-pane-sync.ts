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

import { useEffect } from 'react'
import { useStore } from 'jotai'
import { canvasPanePopoutAtomFamily } from '@/atoms/canvas-pane'

export function useCanvasPaneSync(): void {
  // The CONTEXT store (same discipline as GenUiCanvasBridge) — the per-session
  // family means writes need the store handle, not a fixed useSetAtom.
  const store = useStore()
  useEffect(() => {
    const api = window.electronAPI?.canvasPane
    if (!api?.onStateChanged || !window.electronAPI.isChannelAvailable?.('canvas-pane:detach-to-popup')) return
    return api.onStateChanged((state) => {
      store.set(canvasPanePopoutAtomFamily(state.sessionId), {
        sessionId: state.sessionId,
        poppedOut: state.poppedOut,
        isVisible: state.isVisible,
      })
    })
  }, [store])
}
