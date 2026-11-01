import { useAtomValue, useStore } from 'jotai'
import { Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { browserInstancesAtom } from '@/atoms/browser-pane'
import { filterSidebarBrowserInstances, rightPaneTabAtom, sidebarBrowserInstanceIdAtom, sidebarBrowserOpenAtom } from '@/atoms/sidebar-browser'
import { useAppShellContext } from '@/context/AppShellContext'
import type { CanvasPaneApp } from '@/atoms/canvas-pane'

/** Recovery stays in the existing panel-header control slot, without reserving a sidebar. */
export function RightPaneMenu({ sessionId, activeWorkspaceId, remoteWorkspaceId, canvasApp }: {
  sessionId: string | null; activeWorkspaceId: string | null; remoteWorkspaceId: string | null; canvasApp: CanvasPaneApp | null
}) {
  const { t } = useTranslation()
  const store = useStore()
  const context = useAppShellContext()
  const all = useAtomValue(browserInstancesAtom)
  const instances = filterSidebarBrowserInstances(all, sessionId, activeWorkspaceId, remoteWorkspaceId)
  if (!instances.length && !canvasApp && !context.filePreviewTitle) return null
  const embed = async (id: string) => {
    context.onHideFilePreview?.()
    await window.electronAPI.browserPane.embed(id)
    store.set(sidebarBrowserInstanceIdAtom, id)
    store.set(sidebarBrowserOpenAtom, true)
    store.set(rightPaneTabAtom, 'browser')
  }
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" title={t('browserPane.sidebar.tabs.browser')} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted" data-testid="right-pane-menu"><Globe className="h-4 w-4" /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {context.filePreviewTitle && <><DropdownMenuItem onSelect={context.onShowFilePreview}>{context.filePreviewTitle}</DropdownMenuItem><DropdownMenuItem onSelect={context.onCloseFilePreview}>{t('common.close')}</DropdownMenuItem><DropdownMenuSeparator /></>}
      {instances.map(i => <div key={i.id}>
        <DropdownMenuItem onSelect={() => { context.onHideFilePreview?.(); void window.electronAPI.browserPane.focus(i.id) }}>{i.title || i.url}</DropdownMenuItem>
        {i.hostMode === 'popup' && <DropdownMenuItem onSelect={() => { void embed(i.id) }}>{t('browserPane.sidebar.embed')}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => { void window.electronAPI.browserPane.destroy(i.id) }}>{t('browserPane.sidebar.terminate')}</DropdownMenuItem>
      </div>)}
      {canvasApp && sessionId && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { context.onHideFilePreview?.(); void window.electronAPI.canvasPane.focus(sessionId) }}>{canvasApp.title}</DropdownMenuItem><DropdownMenuItem onSelect={() => { context.onHideFilePreview?.(); store.set(rightPaneTabAtom, 'canvas'); void window.electronAPI.canvasPane.attachFromPopup(sessionId) }}>{t('browserPane.sidebar.embed')}</DropdownMenuItem><DropdownMenuItem onSelect={() => { void window.electronAPI.canvasPane.destroy(sessionId) }}>{t('common.close')}</DropdownMenuItem></>}
    </DropdownMenuContent>
  </DropdownMenu>
}
