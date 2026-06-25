import * as Icons from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isMac, isWebUI } from '@/lib/platform'
import { useTabShell } from '@/context/TabShellContext'
import { HOME_TAB_ID, POLO_TAB_ID, type TabInstance } from '../../../shared/tab-browser-types'

function TabIcon({ tab }: { tab: TabInstance }) {
  if (tab.isLoading) {
    return <Icons.Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/65" strokeWidth={1.5} />
  }
  if (tab.favicon) {
    return <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0" />
  }
  if (tab.type === 'polo') {
    return <Icons.Sparkles className="h-3.5 w-3.5 text-foreground/65" strokeWidth={1.5} />
  }
  return <Icons.Globe2 className="h-3.5 w-3.5 text-foreground/65" strokeWidth={1.5} />
}

export function TabBar() {
  const { activeTab, activeTabId, activeWebAppNavigation, openTabs, activateHome, activateTab, closeTab, reorderTabs } = useTabShell()
  const trafficLightPadding = isMac && !isWebUI ? 86 : 8
  const showNavigation = activeTab.type === 'webapp'

  return (
    <div
      className="fixed left-0 right-0 top-0 z-panel flex items-center border-b border-foreground/10 bg-background/95 titlebar-drag-region"
      style={{ height: 'var(--tabbar-height)', paddingLeft: trafficLightPadding, paddingRight: 8 }}
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn('titlebar-no-drag mr-1 h-7 w-7 rounded-md', activeTabId === HOME_TAB_ID && 'bg-foreground/8')}
        onClick={activateHome}
        aria-label="Home"
      >
        <Icons.House className="h-4 w-4" strokeWidth={1.5} />
      </Button>

      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-hidden">
        {openTabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                'titlebar-no-drag flex h-8 min-w-[120px] max-w-[220px] flex-1 items-center gap-1.5 rounded-t-md border border-transparent px-2 text-xs transition-colors',
                active ? 'border-foreground/10 bg-foreground/8 text-foreground' : 'text-foreground/65 hover:bg-foreground/5',
              )}
              draggable={tab.id !== POLO_TAB_ID}
              onClick={() => activateTab(tab.id)}
              onDragStart={(event) => {
                if (tab.id === POLO_TAB_ID) return
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const draggedTabId = event.dataTransfer.getData('text/plain')
                if (draggedTabId) reorderTabs(draggedTabId, tab.id)
              }}
            >
              <TabIcon tab={tab} />
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-foreground/45 hover:bg-foreground/10 hover:text-foreground"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                <Icons.X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </div>
          )
        })}
      </div>

      {showNavigation && (
        <div className="titlebar-no-drag ml-2 flex shrink-0 items-center gap-0.5 rounded-md border border-foreground/8 bg-foreground/3 p-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md"
            disabled={!activeWebAppNavigation?.canGoBack}
            onClick={() => activeWebAppNavigation?.goBack()}
            aria-label="Back"
          >
            <Icons.ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md"
            disabled={!activeWebAppNavigation?.canGoForward}
            onClick={() => activeWebAppNavigation?.goForward()}
            aria-label="Forward"
          >
            <Icons.ChevronRight className="h-4 w-4" strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md"
            disabled={!activeWebAppNavigation}
            onClick={() => activeWebAppNavigation?.reloadOrStop()}
            aria-label={activeWebAppNavigation?.isLoading ? 'Stop loading' : 'Reload'}
          >
            {activeWebAppNavigation?.isLoading
              ? <Icons.X className="h-4 w-4" strokeWidth={1.5} />
              : <Icons.RefreshCw className="h-4 w-4" strokeWidth={1.5} />}
          </Button>
        </div>
      )}
    </div>
  )
}
