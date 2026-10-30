import { useAtomValue } from 'jotai'
import { browserInstancesMapAtom } from '../atoms/browser-pane'
import { filterSidebarBrowserInstances, resolveSidebarBrowserInstance, sidebarBrowserInstanceIdAtom, sidebarBrowserOpenAtom } from '../atoms/sidebar-browser'

interface RightPanePresentationOptions {
  currentSessionId: string | null
  activeWorkspaceId: string | null
  remoteWorkspaceId: string | null
  fileVisible: boolean
  canvasVisible: boolean
}

/** Shared by the shell's geometry and the sidebar's actual content. */
export function useRightPanePresentation(options: RightPanePresentationOptions) {
  const open = useAtomValue(sidebarBrowserOpenAtom)
  const selectedId = useAtomValue(sidebarBrowserInstanceIdAtom)
  const all = useAtomValue(browserInstancesMapAtom)
  const instances = filterSidebarBrowserInstances(Array.from(all.values()), options.currentSessionId, options.activeWorkspaceId, options.remoteWorkspaceId)
  const instance = resolveSidebarBrowserInstance(instances, selectedId)
  // A non-null selection is an intent for that exact resource. Filtering it
  // out must not manufacture an empty slot or select another chat's fallback.
  // Null selection retains the explicitly opened empty/manual browser surface.
  const selectionAvailable = selectedId === null || instances.some(item => item.id === selectedId)
  const browserSlotOpen = Boolean(open && selectionAvailable && instance?.hostMode !== 'popup')
  return {
    browserSlotOpen,
    instance,
    instances,
    hasRightPane: Boolean(options.fileVisible || options.canvasVisible || browserSlotOpen),
  }
}
