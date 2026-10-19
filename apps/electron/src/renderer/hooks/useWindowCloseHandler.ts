import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useModalRegistry } from '@/context/ModalContext'
import { useDismissibleLayerRegistry } from '@/context/DismissibleLayerContext'
import { panelStackAtom, closePanelAtom, focusedPanelIdAtom } from '@/atoms/panel-stack'
import { activeTabIdAtom } from '@/atoms/tab-browser'
import { POLO_TAB_ID } from '../../shared/tab-browser-types'
import type { WindowCloseRequest } from '../../shared/types'

interface WindowCloseHandlerOptions {
  /**
   * POO-104: enable only on surfaces that mount the TabShellProvider (the
   * main app shell). With the permanent assistant tab active, a bare
   * Cmd/Ctrl+W close request must NOT destroy the window — only the layered
   * dismissals below still apply. Explicit sources (`window-button`, quit)
   * and `unknown` keep their existing semantics, and surfaces without the
   * tab shell (auth/onboarding screens) pass nothing so a stale tab atom can
   * never swallow a legitimate close.
   */
  assistantTabGuard?: boolean
}

/**
 * Hook to handle window close requests with source-aware behavior.
 *
 * - `window-button` closes the window directly.
 * - `keyboard-shortcut` (Cmd/Ctrl+W) uses layered dismissal:
 *   1. Close top modal
 *   2. Else close focused panel
 *   3. Else close window (unless the assistant guard consumes it, see
 *      `assistantTabGuard`)
 * - `unknown` follows layered dismissal as a safe fallback.
 *
 * The main process starts a fallback timeout on each close request.
 * cancelCloseWindow() clears it (window stays open).
 * confirmCloseWindow() clears it and destroys the window.
 *
 * This hook should be called once at the app root level.
 */
export function useWindowCloseHandler({ assistantTabGuard = false }: WindowCloseHandlerOptions = {}) {
  const { hasOpenLayers, closeTop } = useDismissibleLayerRegistry()
  const { hasOpenModals, closeTopModal } = useModalRegistry()
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const closePanel = useSetAtom(closePanelAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)

  useEffect(() => {
    const cleanup = window.electronAPI.onCloseRequested((request: WindowCloseRequest) => {
      if (request.source === 'window-button') {
        window.electronAPI.confirmCloseWindow()
        return
      }

      if (hasOpenLayers()) {
        closeTop()
        window.electronAPI.cancelCloseWindow()
        return
      }

      // Backward-compatible fallback for legacy modals not yet migrated.
      if (hasOpenModals()) {
        closeTopModal()
        window.electronAPI.cancelCloseWindow()
        return
      }

      // Close the focused panel (or last if no focus tracked)
      const target = focusedPanelId
        ? panelStack.find(p => p.id === focusedPanelId)
        : panelStack[panelStack.length - 1]
      if (target) {
        closePanel(target.id)
        window.electronAPI.cancelCloseWindow()
        return
      }

      // POO-104: the assistant tab is permanent — a plain Cmd/Ctrl+W with the
      // assistant active must keep the window (and the assistant) open. Scoped
      // to the keyboard source: explicit window-button/menu/quit paths and the
      // defensive 'unknown' fallback keep their legacy semantics. The cancel
      // ack also clears the main process's 3s force-close fallback.
      if (assistantTabGuard && activeTabId === POLO_TAB_ID && request.source === 'keyboard-shortcut') {
        window.electronAPI.cancelCloseWindow()
        return
      }

      // No panels, no modals — close the window
      window.electronAPI.confirmCloseWindow()
    })

    return cleanup
  }, [hasOpenLayers, closeTop, hasOpenModals, closeTopModal, panelStack, focusedPanelId, closePanel, assistantTabGuard, activeTabId])
}
