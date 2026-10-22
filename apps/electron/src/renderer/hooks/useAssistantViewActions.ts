import { useCallback, useEffect } from 'react'
import { useAction } from '@/actions'
import { useTabShell } from '@/context/TabShellContext'
import { POLO_APP_DEFINITION } from '../../shared/tab-browser-types'

/** One handler pair for menu, native menu and action-registry shortcuts. */
export function useAssistantViewActions(toggleSidebar: () => void, toggleFocusMode: () => void) {
  const { openApp } = useTabShell()
  const sidebarAction = useCallback(() => {
    openApp(POLO_APP_DEFINITION)
    toggleSidebar()
  }, [openApp, toggleSidebar])
  const focusAction = useCallback(() => {
    openApp(POLO_APP_DEFINITION)
    toggleFocusMode()
  }, [openApp, toggleFocusMode])
  useAction('view.toggleSidebar', sidebarAction)
  useAction('view.toggleFocusMode', focusAction)
  useEffect(() => {
    const sidebar = window.electronAPI.onMenuToggleSidebar?.(sidebarAction)
    const focus = window.electronAPI.onMenuToggleFocusMode?.(focusAction)
    return () => { sidebar?.(); focus?.() }
  }, [sidebarAction, focusAction])
}
