import { useState } from 'react'
import * as Icons from 'lucide-react'
import poloAppIcon from '../../../../resources/icon.png'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isMac, isWebUI } from '@/lib/platform'
import { useTabShell } from '@/context/TabShellContext'
import { navigate, routes } from '@/lib/navigate'
import { AccountMenu, type AccountMenuUser } from '@/components/organization/AccountMenu'
import { SpaceIndicator } from '@/components/organization/SpaceIndicator'
import {
  HOME_TAB_ID,
  POLO_TAB_ID,
  type TabInstance,
} from '../../../shared/tab-browser-types'
import {
  runningTasksForTab,
  useAppRuntimeTasks,
  type RuntimeTask,
} from './AppRuntimeTasksContext'
import { AppCloseDialog } from './AppCloseDialog'
import { RuntimeCenter } from './RuntimeCenter'

function TabIcon({ tab }: { tab: TabInstance }) {
  if (tab.isLoading) {
    return <Icons.Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/65" strokeWidth={1.5} />
  }
  if (tab.favicon) {
    return <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0" />
  }
  if (tab.type === 'polo') {
    return <img src={poloAppIcon} alt="" className="h-3.5 w-3.5 shrink-0 object-contain" />
  }
  return <Icons.Globe2 className="h-3.5 w-3.5 text-foreground/65" strokeWidth={1.5} />
}

/**
 * Close glyph drawn as two lines centered in a 24×24 hit area (prototype R8):
 * the × stays optically centered regardless of stroke rendering.
 */
function TabCloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
      <path
        d="M8.46 8.46 15.54 15.54M15.54 8.46 8.46 15.54"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

interface TabBarProps {
  account?: {
    user: AccountMenuUser | null
    onLogout: () => void | Promise<void>
    /** Playground/preview: render with the account menu expanded. */
    defaultOpen?: boolean
  } | null
}

export function TabBar({ account }: TabBarProps) {
  const { t } = useTranslation()
  const { activeTab, activeTabId, activeWebAppNavigation, openTabs, activateHome, activateTab, closeTab, reorderTabs } = useTabShell()
  const runtime = useAppRuntimeTasks()
  const [closeGuard, setCloseGuard] = useState<{
    tab: TabInstance
    tasks: RuntimeTask[]
  } | null>(null)
  const trafficLightPadding = isMac && !isWebUI ? 86 : 8
  const showNavigation = activeTab.type === 'webapp'

  const openPoloSettings = () => {
    const poloTab = openTabs.find(tab => tab.type === 'polo')
    if (poloTab) activateTab(poloTab.id)
    navigate(routes.view.settings())
  }

  // D-PC-07 M04 收口：SDK 有未结束后台任务时，关闭先走三选项确认
  //（取消 / 后台继续 / 停止并关闭）；普通标签仍直接关闭。
  const requestCloseTab = (tab: TabInstance) => {
    const blockingTasks = runningTasksForTab(runtime.tasks, tab)
    if (blockingTasks.length === 0) {
      closeTab(tab.id)
      return
    }
    setCloseGuard({ tab, tasks: blockingTasks })
  }

  const stopGuardedTasks = async (tasks: RuntimeTask[]) => {
    const failed: RuntimeTask[] = []
    for (const task of tasks) {
      try {
        await runtime.stopTask(task.id)
      } catch {
        failed.push(task)
      }
    }
    return failed
  }

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

      {/* Fill the titlebar so tabs align to its bottom edge instead of being
          vertically centered with a visible gap above the TopBar. */}
      <div className="flex h-full min-w-0 flex-1 items-end gap-1 overflow-hidden">
        {openTabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                'titlebar-no-drag flex h-8 min-w-[120px] max-w-[220px] flex-1 items-center gap-1.5 rounded-t-md border border-transparent px-2 text-xs transition-colors',
                active
                  ? 'relative z-[1] -mb-px border-foreground/10 border-b-transparent bg-foreground/8 text-foreground'
                  : 'text-foreground/65 hover:bg-foreground/5',
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
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-foreground/45 hover:bg-foreground/10 hover:text-foreground"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  requestCloseTab(tab)
                }}
              >
                <TabCloseIcon />
              </button>
            </div>
          )
        })}
      </div>

      {/* 运行 pill（P-M04-BACKGROUND）：后台任务的持续入口，点击打开运行
          状态中心。数据由 AppRuntimeTasksProvider 提供（接线点，见台单）。 */}
      {runtime.runningCount > 0 && (
        <button
          type="button"
          data-testid="runtime-pill"
          className={cn(
            'titlebar-no-drag ml-2 flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
            runtime.runtimeCenterOpen
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-foreground/10 bg-foreground/5 text-foreground/70 hover:bg-foreground/10 hover:text-foreground',
          )}
          onClick={runtime.toggleRuntimeCenter}
        >
          <Icons.LoaderCircle
            className="size-3.5 animate-spin"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {t('appContainer.runtime.pill', { count: runtime.runningCount })}
        </button>
      )}
      {runtime.runtimeCenterOpen && (
        <div
          className="fixed z-panel"
          style={{ top: 'calc(var(--tabbar-height) + 6px)', right: 8 }}
          data-testid="runtime-center-popover"
        >
          <RuntimeCenter
            tasks={runtime.tasks}
            onStopTask={runtime.stopTask}
            onOpenTask={runtime.openTask ?? undefined}
            onClose={runtime.closeRuntimeCenter}
          />
        </div>
      )}

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

      {/* Current space (passive) + account menu: prototype R9 — the top bar
          shows the active space and all switching happens in the avatar menu. */}
      <div className="titlebar-no-drag ml-auto flex shrink-0 items-center gap-1 pl-2">
        <SpaceIndicator />
        {account && (
          <AccountMenu
            user={account.user}
            onLogout={account.onLogout}
            onOpenSettings={openPoloSettings}
            defaultOpen={account.defaultOpen}
          />
        )}
      </div>

      {/* 关闭三选项（P-M04-CLOSE-ACTIVE）：有未结束后台任务时拦截 closeTab。 */}
      <AppCloseDialog
        open={closeGuard !== null}
        appName={closeGuard?.tab.title ?? ''}
        tasks={closeGuard?.tasks ?? []}
        onCancel={() => setCloseGuard(null)}
        onBackgroundContinue={() => {
          if (closeGuard) closeTab(closeGuard.tab.id)
          setCloseGuard(null)
        }}
        onStopTasks={stopGuardedTasks}
        onTerminateSucceeded={() => {
          if (closeGuard) closeTab(closeGuard.tab.id)
          setCloseGuard(null)
        }}
      />
    </div>
  )
}
