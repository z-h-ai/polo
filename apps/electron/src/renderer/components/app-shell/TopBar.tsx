/**
 * TopBar - Global workbench bar above every Polo shell surface (frozen
 * POO-41 `.workbench-bar` semantics).
 *
 * Layout: [Brand lockup] [Home tab] ... [Runtime] [ProductSpace switcher] [Notifications] [Account]
 *
 * Fixed below the tab browser bar, 64px tall. Rendered once per shell via a
 * portal from AppShell so it stays visible on the Home view too — the single
 * ProductSpace switcher entry point lives here (REQ-001).
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Icons from "lucide-react"
import { useAtomValue } from "jotai"
import { sessionMetaMapAtom } from "@/atoms/sessions"
import { useOptionalAppShellContext } from "@/context/AppShellContext"
import { useOptionalProductSpaceContext } from "@/context/ProductSpaceContext"
import { useTabShell } from "@/context/TabShellContext"
import { useTheme } from "@/context/ThemeContext"
import { useNavigation } from "@/contexts/NavigationContext"
import { cn } from "@/lib/utils"
import { getSessionTitle } from "@/utils/session"
import type { ExecutionSummary, ExecutionStatus } from "@polo-ai/shared/product-spaces"
import {
  Check,
  ChevronRight,
  LogOut,
  Settings,
  SunMoon,
  UserRound,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ProductSpaceSwitcher } from "@/components/product-space/ProductSpaceSwitcher"

const MAX_NOTIFICATION_ITEMS = 6

const RUNTIME_REFRESH_INTERVAL_MS = 5000

/** POO-41 active-execution semantics: preparing/running/waiting/stopping.
    Terminal `stopped`/`failed` executions are never counted. */
const ACTIVE_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "preparing",
  "running",
  "waiting_for_network",
  "stopping",
])

/** A registry snapshot is only consumable while its owning scope tuple is
    still the active ProductSpace scope (trusted-boundary ownership). */
interface OwnedExecutionSnapshot {
  ownerAccountId: string
  ownerProductSpaceId: string
  executions: ExecutionSummary[]
}

function snapshotBelongsToActiveScope(
  snapshot: OwnedExecutionSnapshot | null,
  accountId: string | null,
  activeProductSpaceId: string | null,
): snapshot is OwnedExecutionSnapshot {
  return Boolean(
    snapshot
    && accountId
    && activeProductSpaceId
    && snapshot.ownerAccountId === accountId
    && snapshot.ownerProductSpaceId === activeProductSpaceId,
  )
}

export function TopBar() {
  const { t } = useTranslation()
  const appShell = useOptionalAppShellContext()
  const productSpace = useOptionalProductSpaceContext()
  const { activeTab, openTabs, activateHome, activateTab } = useTabShell()
  const { resolvedMode, setMode } = useTheme()
  const { navigateToSession } = useNavigation()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const isHome = activeTab.type === "home"

  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])
  const [ownedSnapshot, setOwnedSnapshot] = useState<OwnedExecutionSnapshot | null>(null)
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false)
  const accountId = productSpace?.accountId ?? null
  const activeProductSpaceId = productSpace?.activeProductSpaceId ?? null

  // Trusted ProductSpace active-execution registry: the count and the runtime
  // dialog read ONLY from productSpaceListActiveExecutions (never from the
  // Catalog). The snapshot is owned by the (accountId, activeProductSpaceId)
  // tuple: a scope change clears it immediately and publishes nothing until
  // THIS scope's own successful response arrives. Requests are single-flight
  // (the next one is scheduled only after the previous settles) and carry a
  // monotonic generation, so a slow or stale response can never overwrite a
  // newer same-scope snapshot.
  useEffect(() => {
    setOwnedSnapshot(null)
    setSelectedExecutionId(null)
    if (!accountId || !activeProductSpaceId) {
      return
    }
    let disposed = false
    let timer: number | undefined
    let generation = 0
    const refresh = async () => {
      const requestGeneration = ++generation
      try {
        const result = await window.electronAPI.productSpaceListActiveExecutions(
          accountId,
          activeProductSpaceId,
        )
        if (disposed || requestGeneration !== generation) return
        if (result.success) {
          setOwnedSnapshot({
            ownerAccountId: accountId,
            ownerProductSpaceId: activeProductSpaceId,
            executions: result.executions,
          })
        }
        // A failed same-scope call keeps the previously owned snapshot; a new
        // scope has none, so it keeps rendering the honest empty state.
      } catch {
        // Transient registry failures keep the previous same-scope snapshot.
      }
    }
    const scheduleNext = () => {
      timer = window.setTimeout(() => {
        void refresh().finally(scheduleNext)
      }, RUNTIME_REFRESH_INTERVAL_MS)
    }
    void refresh().finally(scheduleNext)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [accountId, activeProductSpaceId])

  const activeExecutions = useMemo(() => {
    if (!snapshotBelongsToActiveScope(ownedSnapshot, accountId, activeProductSpaceId)) {
      return []
    }
    return ownedSnapshot.executions.filter((execution) => ACTIVE_EXECUTION_STATUSES.has(execution.status))
  }, [ownedSnapshot, accountId, activeProductSpaceId])
  const runningCount = activeExecutions.length
  const selectedExecution = useMemo(() => (
    selectedExecutionId
      ? activeExecutions.find((execution) => execution.executionId === selectedExecutionId) ?? null
      : null
  ), [activeExecutions, selectedExecutionId])
  const unreadSessions = useMemo(() => (
    sessionMetas
      .filter((meta) => meta.hasUnread)
      .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
  ), [sessionMetas])
  const visibleUnreadSessions = unreadSessions.slice(0, MAX_NOTIFICATION_ITEMS)

  const user = appShell?.currentAdminUser ?? null
  const userLabel = user?.displayName || user?.username || ""
  const userInitial = userLabel.trim().charAt(0)

  const openPoloTab = openTabs.find((tab) => tab.type === "polo")

  const openSessionFromNotification = (sessionId: string) => {
    if (openPoloTab) activateTab(openPoloTab.id)
    navigateToSession(sessionId)
  }

  return (
    <div
      data-testid="workbench-topbar"
      className="fixed left-0 right-0 z-panel flex items-center gap-[12px] border-b border-border/60 bg-background/92 px-[28px] backdrop-blur-[18px] titlebar-drag-region max-md:gap-1.5 max-md:px-3"
      style={{ top: 'var(--tabbar-height)', height: 'var(--topbar-height)' }}
    >
      {/* === LEFT: Brand lockup + Home tab === */}
      <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-[12px] max-md:gap-1.5">
        <button
          type="button"
          data-testid="topbar-brand"
          onClick={activateHome}
          aria-label={t("topbar.brand.home")}
          className="titlebar-no-drag flex min-w-[82px] items-center gap-[9px] rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-w-[34px]"
        >
          <span className="grid size-[26px] flex-none place-items-center rounded-[8px] bg-foreground text-[13px] font-extrabold text-background">
            P
          </span>
          <span className="text-[14px] font-bold tracking-[-0.03em] text-foreground max-md:hidden">
            Polo
          </span>
        </button>

        <button
          type="button"
          data-testid="topbar-home-tab"
          onClick={activateHome}
          aria-label={t("topbar.home")}
          aria-current={isHome ? "page" : undefined}
          className={cn(
            "titlebar-no-drag inline-flex h-[36px] flex-none items-center justify-center gap-[8px] rounded-[9px] px-[12px] text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:w-9 max-md:px-0",
            isHome
              ? "bg-background text-foreground shadow-minimal"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          <Icons.House className="size-[17px] flex-none" strokeWidth={1.7} />
          <span className="max-md:hidden">{t("topbar.home")}</span>
        </button>
      </div>

      {/* === RIGHT: Runtime + Space control + Notifications + Account === */}
      <div className="pointer-events-auto flex flex-none items-center gap-[8px] max-md:gap-1">
        <Dialog open={runtimeDialogOpen} onOpenChange={(open) => {
          setRuntimeDialogOpen(open)
          if (!open) setSelectedExecutionId(null)
        }}>
          <DialogTrigger asChild>
            <button
              type="button"
              data-testid="topbar-runtime"
              aria-label={t("topbar.runtime.label")}
              aria-haspopup="dialog"
              className="titlebar-no-drag flex h-[34px] items-center gap-[7px] rounded-[9px] px-[9px] text-[12px] font-medium text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "size-[7px] flex-none rounded-full",
                  runningCount > 0
                    ? "bg-success ring-[3px] ring-success/15"
                    : "bg-foreground/40",
                )}
              />
              <span className="whitespace-nowrap [@media(max-width:1080px)]:hidden">
                {runningCount > 0
                  ? t("topbar.runtime.running", { count: runningCount })
                  : t("topbar.runtime.none")}
              </span>
            </button>
          </DialogTrigger>
          <DialogContent aria-label={t("topbar.runtime.label")} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("topbar.runtime.label")}</DialogTitle>
              <DialogDescription>
                {runningCount > 0
                  ? t("topbar.runtime.running", { count: runningCount })
                  : t("topbar.runtime.none")}
              </DialogDescription>
            </DialogHeader>
            {activeExecutions.length === 0 ? (
              <div className="rounded-lg border border-foreground/10 px-3 py-4 text-center text-[13px] text-muted-foreground">
                {t("topbar.runtime.none")}
              </div>
            ) : (
              <div className="max-h-[320px] space-y-1.5 overflow-y-auto" role="listbox" aria-label={t("topbar.runtime.label")}>
                {activeExecutions.map((execution) => {
                  const selected = execution.executionId === selectedExecutionId
                  return (
                    <button
                      key={execution.executionId}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => setSelectedExecutionId(
                        selected ? null : execution.executionId,
                      )}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-[9px] border px-3 py-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "border-accent/40 bg-accent/8"
                          : "border-transparent hover:bg-foreground/4",
                      )}
                    >
                      <span className="size-[7px] flex-none rounded-full bg-success" />
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {execution.name}
                      </span>
                      <span className="flex-none text-[11px] text-muted-foreground">
                        {t(`productSpace.exec.status.${execution.status}`)}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {selectedExecution && (
              <div className="space-y-1 rounded-lg border border-border/60 bg-foreground/3 p-3 text-[12px]">
                <p className="truncate font-medium text-foreground">{selectedExecution.name}</p>
                <p className="text-muted-foreground">
                  {t("topbar.runtime.status")}: {t(`productSpace.exec.status.${selectedExecution.status}`)}
                </p>
                {selectedExecution.errorCode && (
                  <p className="break-all text-muted-foreground">
                    {t("topbar.runtime.errorCode")}: {selectedExecution.errorCode}
                  </p>
                )}
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  {selectedExecution.executionId}
                </p>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <ProductSpaceSwitcher />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="topbar-notifications"
              aria-label={t("topbar.notifications.label")}
              className="titlebar-no-drag relative grid size-[32px] place-items-center rounded-[8px] text-foreground/50 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icons.Bell className="size-4" strokeWidth={1.7} />
              {unreadSessions.length > 0 && (
                <span className="absolute right-[6px] top-[6px] size-[5px] rounded-full border border-background bg-workbench-info" />
              )}
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-56">
            {visibleUnreadSessions.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                {t("topbar.notifications.empty")}
              </div>
            ) : (
              visibleUnreadSessions.map((meta) => (
                <StyledDropdownMenuItem
                  key={meta.id}
                  onClick={() => openSessionFromNotification(meta.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{getSessionTitle(meta)}</span>
                  {visibleUnreadSessions.length > 1 && (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                </StyledDropdownMenuItem>
              ))
            )}
          </StyledDropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="topbar-account"
              aria-label={t("topbar.account.label")}
              className="titlebar-no-drag ml-[3px] grid size-[28px] place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {userInitial || <UserRound className="size-3.5" strokeWidth={1.7} />}
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-56">
            {user && (
              <div className="truncate px-2 py-1.5 text-[12px]">
                <span className="font-medium text-foreground">{userLabel}</span>
                {user.displayName && user.username ? (
                  <span className="text-muted-foreground"> · {user.username}</span>
                ) : null}
              </div>
            )}
            {appShell && (
              <>
                <StyledDropdownMenuItem onClick={appShell.onOpenStoredUserPreferences}>
                  <UserRound className="h-3.5 w-3.5" />
                  {t("topbar.account.preferences")}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem onClick={appShell.onOpenSettings}>
                  <Settings className="h-3.5 w-3.5" />
                  {t("menu.settings")}
                </StyledDropdownMenuItem>
                {appShell.workspaces.length > 0 && (
                  <DropdownMenuSub>
                    <StyledDropdownMenuSubTrigger>
                      <Icons.Building2 className="h-3.5 w-3.5" />
                      <span className="flex-1">{t("topbar.account.workspaces")}</span>
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent minWidth="min-w-48">
                      {appShell.workspaces.map((workspace) => {
                        const active = workspace.id === appShell.activeWorkspaceId
                        return (
                          <StyledDropdownMenuItem
                            key={workspace.id}
                            disabled={active}
                            onClick={() => { void appShell.onSelectWorkspace(workspace.id) }}
                          >
                            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                            {active && <Check className="h-3.5 w-3.5" />}
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <StyledDropdownMenuSeparator />
              </>
            )}
            <StyledDropdownMenuItem
              onClick={() => setMode(resolvedMode === "dark" ? "light" : "dark")}
            >
              <SunMoon className="h-3.5 w-3.5" />
              {t("topbar.account.toggleTheme")}
            </StyledDropdownMenuItem>
            {user && appShell?.onAdminLogout && (
              <>
                <StyledDropdownMenuSeparator />
                <StyledDropdownMenuItem onClick={() => { void appShell.onAdminLogout?.() }}>
                  <LogOut className="h-3.5 w-3.5" />
                  {t("topbar.account.logout")}
                </StyledDropdownMenuItem>
              </>
            )}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
