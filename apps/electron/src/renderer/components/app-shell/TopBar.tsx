import { useClientWorkbenchStyle, clientWorkbenchFocusClassName, clientWorkbenchMenuClassName } from '@/components/ui/client-workbench'
/**
 * TopBar - The single global workbench bar (frozen POO-41 `.workbench-bar`
 * semantics, unified with the tab strip per the POO-70 hifi prototype).
 *
 * Layout: [traffic-light inset] [Polo brand mark (static, POO-117)] [Home tab + web tabs] [web nav] ... [Runtime] [current ProductSpace identity] [Notifications] [Account]
 *
 * POO-117: the logo no longer hosts a menu — the former AppMenu entries moved
 * into the avatar dropdown (`WorkbenchAccountMenu`), and the in-app quit item
 * was dropped. The brand mark is decorative and its corner stays drag region.
 *
 * P70-NAV-01: this bar is the ONLY top navigation — the opened app tabs, the
 * current ProductSpace identity and the account menu live here, and there is no
 * second app/skill/circle row. Circles are reached from the personal home
 * content area (ClientPageContext routes), never from a bar tab.
 *
 * P70-NAV-03: the bottom hairline is not unconditional — it responds only to
 * the current page's registered MAIN scroll container and starts hidden
 * (ClientPageContext). Web app tabs keep the frozen POO-41 always-on border.
 *
 * Fixed to the top of the window, 64px tall, always visible across shell
 * surfaces (Home view and web app tabs included). Rendered by TabShell inside
 * the hydration gate so a stale previous-scope bar can never surface before
 * the new scope's own tabs hydrate (Review R33 fail-closed boundary).
 */

import { useInsertionEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import * as Icons from "lucide-react"
import { useAtomValue } from "jotai"
import { sessionMetaMapAtom } from "@/atoms/sessions"
import { useOptionalAppShellContext } from "@/context/AppShellContext"
import { useOptionalClientPage } from "@/context/ClientPageContext"
import { useOptionalProductSpaceContext } from "@/context/ProductSpaceContext"
import { useAdminPaymentHandoff } from "@/hooks/useAdminPaymentHandoff"
import { useTabShell } from "@/context/TabShellContext"
import { navigate, routes } from "@/lib/navigate"
import { cn } from "@/lib/utils"
import { isMac, isWebUI } from "@/lib/platform"
import { requestNewMainWindow } from "@/lib/new-window-request"
import { createEnterpriseWorkflowUrl } from "@/lib/enterprise-workflow-url"
import { getSessionTitle } from "@/utils/session"
import { ChevronRight, UserRound } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-dropdown"
import { CurrentProductSpaceLabel } from "@/components/product-space/ProductSpaceSwitcher"
import { PoloAiSymbol } from "../icons/PoloAiSymbol"
import { WorkbenchAccountMenu } from "../app-menu/WorkbenchAccountMenu"
import { POLO_TAB_ID, type TabInstance } from "../../../shared/tab-browser-types"
import poloAppIcon from "../../../../resources/icon.png"

const MAX_NOTIFICATION_ITEMS = 6

function TabIcon({ tab }: { tab: TabInstance }) {
  if (tab.isLoading) {
    return <Icons.Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/65" strokeWidth={1.5} />
  }
  if (tab.favicon) {
    return <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0" />
  }
  if (tab.type === "polo") {
    return <img src={poloAppIcon} alt="" className="h-3.5 w-3.5 shrink-0 object-contain" />
  }
  if (tab.type === "knowledge-base") {
    return <Icons.Library className="h-3.5 w-3.5 text-foreground/65" strokeWidth={1.5} />
  }
  return <Icons.Globe2 className="h-3.5 w-3.5 text-foreground/65" strokeWidth={1.5} />
}

export function TopBar() {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const appShell = useOptionalAppShellContext()
  const productSpace = useOptionalProductSpaceContext()
  const {
    activeTab,
    activeTabId,
    activeWebAppNavigation,
    openTabs,
    activateHome,
    activateTab,
    closeTab,
    reorderTabs,
  } = useTabShell()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  // POO107-01: the TopBar runtime count and its execution dialog are removed.
  // The active-execution registry itself stays — space switching (PC-F06) and
  // the App close confirmation still consume it.
  // Payment handoff state lives HERE, not in the dropdown content: the bar is
  // mounted for the whole app lifetime while Radix unmounts the menu on close,
  // and both the one-handoff-at-a-time guard and the visible-scope mirror must
  // survive close/reopen (a remount would drop delayed handoffs and re-mint
  // tickets).
  // POO-119: the same lifetime argument applies to the enterprise-console
  // entries — their click-time lease check must read a mirror that is updated
  // for the WHOLE bar lifetime, not a per-open menu mount. The PAYMENT
  // mirror/in-flight refs moved to useAdminPaymentHandoff (journey #1: the
  // chat banner's 「去充值」 mints tickets under the SAME fences); the
  // enterprise console keeps its own bar-lifetime mirror here.
  const { canOpenPayment, openPayment } = useAdminPaymentHandoff()
  const visibleProductSpaceRef = useRef(productSpace)
  useInsertionEffect(() => {
    visibleProductSpaceRef.current = productSpace
    return () => { visibleProductSpaceRef.current = null }
  }, [productSpace])

  // POO-119 ENTMENU-01/02: the enterprise admin console and creator center
  // live in the account menu, gated to enterprise spaces whose role may manage
  // (owner/manager — ENTMENU-03 keeps members out, ENTMENU-04 keeps personal
  // spaces out). A mid-switch scope never offers the entries.
  const activeSpace = productSpace?.activeProductSpace
  const canOpenEnterpriseWorkflows = Boolean(
    productSpace && !productSpace.pendingSwitch
    && activeSpace?.kind === 'enterprise'
    && (activeSpace.role === 'owner' || activeSpace.role === 'manager'),
  )
  // One console handoff at a time, mirroring openPayment.
  const enterpriseWorkflowInFlight = useRef(false)
  const openEnterpriseWorkflow = async (workflow: 'members' | 'publishing') => {
    const scope = visibleProductSpaceRef.current
    if (!scope || scope.pendingSwitch || enterpriseWorkflowInFlight.current) return
    const space = scope.activeProductSpace
    // ENTMENU-05 fail-closed: re-derive the right to act from the live scope —
    // a stale render (menu opened before a space/account change) never opens.
    if (space.kind !== 'enterprise' || (space.role !== 'owner' && space.role !== 'manager')) return
    const clickLease = {
      accountId: scope.accountId,
      activeProductSpaceId: scope.activeProductSpaceId,
      contextKey: scope.productSpaceContextKey,
      contextVersion: scope.contextVersion,
      enterpriseId: space.enterpriseId,
    }
    enterpriseWorkflowInFlight.current = true
    try {
      const status = await window.electronAPI.adminGetStatus()
      const live = visibleProductSpaceRef.current
      const leaseAlive = live
        && live.accountId === clickLease.accountId
        && live.activeProductSpaceId === clickLease.activeProductSpaceId
        && live.productSpaceContextKey === clickLease.contextKey
        && live.contextVersion === clickLease.contextVersion
        && !live.pendingSwitch
      // The admin session must still belong to the account that clicked, and
      // the trusted admin origin must exist — never open a guessed host.
      if (!leaseAlive || !status.loggedIn || !status.adminUrl || status.userId !== clickLease.accountId) {
        toast.error(t('topbar.account.enterpriseOpenFailed'), { description: t('homeApps.errors.staleContext') })
        return
      }
      await window.electronAPI.openUrl(createEnterpriseWorkflowUrl(status.adminUrl, clickLease.enterpriseId, workflow))
    } catch {
      toast.error(t('topbar.account.enterpriseOpenFailed'))
    } finally {
      enterpriseWorkflowInFlight.current = false
    }
  }

  const isHome = activeTab.type === "home"
  const showNavigation = activeTab.type === "webapp"
  const trafficLightInset = isMac && !isWebUI ? 86 : 8

  // P70-NAV-03 header hairline: the bar's bottom border responds ONLY to the
  // current page's registered MAIN scroll container (ClientPageContext) and
  // starts hidden. Assistant-internal scrollers never register, so opening
  // the Polo tab can never show the hairline. Web app tabs keep the frozen
  // POO-41 always-on border (their scroller lives inside the webview and is
  // out of this contract's scope); the narrow-window guard below the shell
  // replaces the whole bar, so mobile stays out of scope as well.
  const clientPage = useOptionalClientPage()
  const showHeaderLine = showNavigation
    ? true
    : (clientPage?.isHeaderLineVisible ?? false)

  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])

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
    // The bar lives above NavigationProvider (inside TabShell), so the click
    // routes through the global navigate event the NavigationContext listens
    // for instead of the hook.
    navigate(routes.view.allSessions(sessionId))
  }

  return (
    <div
      data-testid="app-topbar"
      className={cn(
        clientWorkbenchFocusClassName,
        // POO-105 材质作用域内 Header 与底板同层同色、任何滚动状态不显示细线
        // （.client-material-bar 覆盖背景/模糊/边线）；未标记宿主保持原分层。
        "fixed left-0 right-0 top-0 z-panel flex items-center gap-[12px] bg-background/92 backdrop-blur-[18px] titlebar-drag-region client-material-bar max-md:gap-1.5",
        // The hairline keeps its 1px slot in both states so the bar never
        // changes height when the main scroller crosses the top edge.
        showHeaderLine ? "border-b border-border" : "border-b border-transparent",
      )}
      style={{ ...workbenchStyle, height: "var(--topbar-height)", paddingLeft: trafficLightInset, paddingRight: 8 }}
    >
      {/* === LEFT: static Polo AI brand mark (POO-117 P117-01) ===
          The logo is decorative — no button semantics, no dropdown. Every
          former entry now lives in the avatar menu (WorkbenchAccountMenu).
          pointer-events-none lets the corner stay part of the titlebar drag
          region owned by the bar container. */}
      <div aria-hidden data-testid="topbar-brand-mark" className="pointer-events-none flex flex-none select-none items-center pl-[2px]">
        <PoloAiSymbol className="h-4 text-accent" />
      </div>

      {/* === Tabs: Home tab + open web tabs === */}
      <nav
        aria-label={t("topbar.tabs.ariaLabel")}
        className="pointer-events-auto flex h-full min-w-0 flex-1 items-center gap-[4px] overflow-x-auto [scrollbar-width:none] max-md:gap-1"
      >
        <button
          type="button"
          data-testid="topbar-home-tab"
          onClick={activateHome}
          aria-label={t("topbar.home")}
          aria-current={isHome ? "page" : undefined}
          className={cn(
            "titlebar-no-drag inline-flex h-[36px] flex-none items-center justify-center gap-[8px] rounded-[9px] px-[12px] text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:w-9 max-md:px-0",
            isHome
              ? "bg-background text-foreground shadow-minimal client-material-card"
              : "text-muted-foreground hover:bg-foreground/5 client-material-fg-hover hover:text-foreground client-material-fg-secondary",
          )}
        >
          <Icons.House className="size-[17px] flex-none" strokeWidth={1.7} />
          <span className="max-md:hidden">{t("topbar.home")}</span>
        </button>

        {openTabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                "titlebar-no-drag inline-flex h-[36px] min-w-[98px] max-w-[190px] flex-none items-center gap-[6px] rounded-[9px] px-[10px] text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:min-w-[96px] max-md:max-w-[140px]",
                active
                  ? "bg-background font-medium text-foreground shadow-minimal client-material-card"
                  : "text-muted-foreground hover:bg-foreground/5 client-material-fg-hover hover:text-foreground client-material-fg-secondary",
              )}
              draggable={tab.id !== POLO_TAB_ID}
              onClick={() => activateTab(tab.id)}
              onDragStart={(event) => {
                if (tab.id === POLO_TAB_ID) return
                event.dataTransfer.setData("text/plain", tab.id)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const draggedTabId = event.dataTransfer.getData("text/plain")
                if (draggedTabId) reorderTabs(draggedTabId, tab.id)
              }}
            >
              <TabIcon tab={tab} />
              <span className="min-w-0 flex-1 truncate whitespace-nowrap">{tab.title}</span>
              {/* POO-104: the assistant is a permanent entry — no close
                  control, so a mis-click next door can never yank the
                  workbench back to Home. Regular webapp tabs keep theirs.
                  POO-105: close control carries the material fg contract. */}
              {tab.id !== POLO_TAB_ID && (
                <button
                  type="button"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-foreground/45 hover:bg-foreground/10 client-material-fg-hover hover:text-foreground client-material-fg-muted"
                  aria-label={t("topbar.tabs.close", { title: tab.title })}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  <Icons.X className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              )}
            </div>
          )
        })}
      </nav>

      {/* === Web app navigation (only while a web app tab is active) === */}
      {showNavigation && (
        <div className="pointer-events-auto titlebar-no-drag flex flex-none items-center gap-0.5 rounded-md border border-foreground/8 bg-foreground/3 p-0.5">
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-md text-foreground/70 outline-none hover:bg-foreground/5 client-material-fg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 client-material-fg-secondary client-material-action"
            disabled={!activeWebAppNavigation?.canGoBack}
            onClick={() => activeWebAppNavigation?.goBack()}
            aria-label={t("topbar.nav.back")}
          >
            <Icons.ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-md text-foreground/70 outline-none hover:bg-foreground/5 client-material-fg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 client-material-fg-secondary client-material-action"
            disabled={!activeWebAppNavigation?.canGoForward}
            onClick={() => activeWebAppNavigation?.goForward()}
            aria-label={t("topbar.nav.forward")}
          >
            <Icons.ChevronRight className="h-4 w-4" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-md text-foreground/70 outline-none hover:bg-foreground/5 client-material-fg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 client-material-fg-secondary client-material-action"
            disabled={!activeWebAppNavigation}
            onClick={() => activeWebAppNavigation?.reloadOrStop()}
            aria-label={activeWebAppNavigation?.isLoading ? t("topbar.nav.stop") : t("topbar.nav.reload")}
          >
            {activeWebAppNavigation?.isLoading
              ? <Icons.X className="h-4 w-4" strokeWidth={1.5} />
              : <Icons.RefreshCw className="h-4 w-4" strokeWidth={1.5} />}
          </button>
        </div>
      )}

      {/* === RIGHT: Space control + Notifications + Account === */}
      <div className="pointer-events-auto flex flex-none items-center gap-[8px] max-md:gap-1">
        <CurrentProductSpaceLabel />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="topbar-notifications"
              aria-label={t("topbar.notifications.label")}
              className="titlebar-no-drag relative grid size-[32px] place-items-center rounded-[8px] text-foreground/50 outline-none hover:bg-foreground/5 client-material-fg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring client-material-fg-muted"
            >
              <Icons.Bell className="size-4" strokeWidth={1.7} />
              {unreadSessions.length > 0 && (
                <span className="absolute right-[6px] top-[6px] size-[5px] rounded-full border border-background bg-workbench-info" />
              )}
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent style={workbenchStyle} className={clientWorkbenchMenuClassName + " w-[min(294px,calc(100vw-24px))]"} align="end" minWidth="min-w-0">
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
          <StyledDropdownMenuContent style={workbenchStyle} className={clientWorkbenchMenuClassName + " w-[min(294px,calc(100vw-24px))]"} align="end" minWidth="min-w-0">
            {/* POO-117 P117-02/P117-03: the single workbench menu — account
                entries plus the migrated app menu, in one place. The bar sits
                above NavigationProvider, so new chat routes through the global
                navigate() event (same contract as openSessionFromNotification). */}
            <WorkbenchAccountMenu
              onNewChat={() => navigate(routes.action.newSession())}
              onNewWindow={() => { void requestNewMainWindow() }}
              canOpenPayment={canOpenPayment ?? undefined}
              onOpenPayment={() => { void openPayment() }}
              canOpenEnterpriseWorkflows={canOpenEnterpriseWorkflows}
              onOpenEnterpriseWorkflow={(workflow) => { void openEnterpriseWorkflow(workflow) }}
            />
          </StyledDropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
