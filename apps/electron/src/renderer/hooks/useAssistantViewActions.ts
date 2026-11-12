import { useCallback, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { useAction } from '@/actions'
import { useTabShell } from '@/context/TabShellContext'
import { committedSpaceKindAtom } from '@/atoms/tab-browser'
import { POLO_APP_DEFINITION } from '../../shared/tab-browser-types'

/**
 * One handler pair for menu, native menu and action-registry shortcuts.
 *
 * POO-209: the sidebar/focus controls also live INSIDE the assistant surface
 * now (POO-202 chat-header buttons, POO-205 project tabs are assistant
 * workspaces). Surfacing the Polo app unconditionally used to re-route the
 * active tab from a project conversation — in a committed enterprise space
 * the POO-205 C4 guard then snapped it to Home, so the control literally
 * navigated the user to the home page instead of toggling. The surface hand-off
 * stays only for entries fired while NO assistant surface is on screen
 * (Home/webapp tabs); an enterprise space has no Polo tab to surface at all,
 * so there the toggle just applies to the (hidden or next) assistant surface.
 */
export function useAssistantViewActions(toggleSidebar: () => void, toggleFocusMode: () => void) {
  const { openApp, activeTab } = useTabShell()
  const committedSpaceKind = useAtomValue(committedSpaceKindAtom)
  const isAssistantSurfaceActive = activeTab.type === 'polo' || activeTab.type === 'project'
  const surfaceAssistant = !isAssistantSurfaceActive && committedSpaceKind !== 'enterprise'
  const sidebarAction = useCallback(() => {
    if (surfaceAssistant) openApp(POLO_APP_DEFINITION)
    toggleSidebar()
  }, [openApp, surfaceAssistant, toggleSidebar])
  const focusAction = useCallback(() => {
    if (surfaceAssistant) openApp(POLO_APP_DEFINITION)
    toggleFocusMode()
  }, [openApp, surfaceAssistant, toggleFocusMode])
  useAction('view.toggleSidebar', sidebarAction)
  useAction('view.toggleFocusMode', focusAction)
  useEffect(() => {
    const sidebar = window.electronAPI.onMenuToggleSidebar?.(sidebarAction)
    const focus = window.electronAPI.onMenuToggleFocusMode?.(focusAction)
    return () => { sidebar?.(); focus?.() }
  }, [sidebarAction, focusAction])
}
