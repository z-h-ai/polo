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

import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import * as Icons from "lucide-react"
import { useAtomValue } from "jotai"
import { sessionMetaMapAtom } from "@/atoms/sessions"
import { useOptionalAppShellContext } from "@/context/AppShellContext"
import { useTabShell } from "@/context/TabShellContext"
import { useTheme } from "@/context/ThemeContext"
import { useNavigation } from "@/contexts/NavigationContext"
import { cn } from "@/lib/utils"
import { getSessionTitle } from "@/utils/session"
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
import { ProductSpaceSwitcher } from "@/components/product-space/ProductSpaceSwitcher"

const MAX_NOTIFICATION_ITEMS = 6

export function TopBar() {
  const { t } = useTranslation()
  const appShell = useOptionalAppShellContext()
  const { activeTab, openTabs, activateHome, activateTab } = useTabShell()
  const { resolvedMode, setMode } = useTheme()
  const { navigateToSession } = useNavigation()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const isHome = activeTab.type === "home"

  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])
  const runningCount =
    sessionMetas.filter((meta) => meta.isProcessing).length
    + openTabs.filter((tab) => tab.type === "webapp").length
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
      className="fixed left-0 right-0 z-panel flex items-center gap-3 border-b border-border/60 bg-background/92 px-[28px] backdrop-blur-[18px] titlebar-drag-region max-md:gap-1.5 max-md:px-3"
      style={{ top: 'var(--tabbar-height)', height: 'var(--topbar-height)' }}
    >
      {/* === LEFT: Brand lockup + Home tab === */}
      <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-3 max-md:gap-1.5">
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
          className="titlebar-no-drag inline-flex h-9 flex-none items-center justify-center gap-[9px] rounded-[9px] bg-background px-3 text-[12px] font-semibold text-foreground shadow-minimal outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring max-md:w-9 max-md:px-0"
        >
          <Icons.House className="size-[17px] flex-none" strokeWidth={1.7} />
          <span className="max-md:hidden">{t("topbar.home")}</span>
        </button>
      </div>

      {/* === RIGHT: Runtime + Space control + Notifications + Account === */}
      <div className="pointer-events-auto flex flex-none items-center gap-2 max-md:gap-1">
        <button
          type="button"
          data-testid="topbar-runtime"
          onClick={activateHome}
          aria-label={t("topbar.runtime.label")}
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
          <span className="whitespace-nowrap max-md:hidden">
            {runningCount > 0
              ? t("topbar.runtime.running", { count: runningCount })
              : t("topbar.runtime.none")}
          </span>
        </button>

        <ProductSpaceSwitcher />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="topbar-notifications"
              aria-label={t("topbar.notifications.label")}
              className="titlebar-no-drag relative grid size-8 place-items-center rounded-[8px] text-foreground/50 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
              className="titlebar-no-drag ml-[3px] grid size-7 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
