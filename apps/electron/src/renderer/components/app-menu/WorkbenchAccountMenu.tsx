import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Icons from "lucide-react"
import { isMac } from "@/lib/platform"
import { useActionLabel, useOptionalActionRegistry } from "@/actions"
import { useOptionalAppShellContext } from "@/context/AppShellContext"
import { useOptionalTheme } from "@/context/ThemeContext"
import { useTabShell } from "@/context/TabShellContext"
import { navigate, routes } from "@/lib/navigate"
import {
  DropdownMenuSub,
  DropdownMenuShortcut,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import { ProductSpaceSwitcher } from "@/components/product-space/ProductSpaceSwitcher"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import {
  EDIT_MENU,
  VIEW_MENU,
  WINDOW_MENU,
  ROOT_MENU,
  HELP_LINKS,
  DEBUG_MENU,
  getShortcutDisplay,
} from "../../../shared/menu-schema"
import type { MenuItem } from "../../../shared/menu-schema"

/**
 * POO-117 P117-02/P117-03 — the single workbench menu, rendered inside the
 * TopBar avatar dropdown. Absorbs the former Polo-logo menu (new chat/window,
 * Edit/View/Window, Help, Debug) next to the existing account entries
 * (summary, settings, payment, space, theme, logout) and drops both the
 * "App operations" framing and the in-app "Quit Polo AI" item — OS-level quit
 * and the window close button stay the exit paths.
 *
 * Menu leaves stay wired to `shared/menu-schema.ts` so the desktop renderer
 * and the macOS native menu keep one definition source.
 */

type MenuActionHandlers = {
  toggleFocusMode?: () => void
  toggleSidebar?: () => void
}

export interface WorkbenchAccountMenuProps {
  onNewChat: () => void
  onNewWindow: () => void
  /**
   * Payment stays TopBar-owned (POO-117): the handoff in-flight guard and the
   * visible-scope mirror must outlive this component, which Radix unmounts
   * every time the dropdown closes — per-mount state there would drop a
   * delayed handoff and re-mint tickets across close/reopen.
   */
  canOpenPayment?: boolean
  onOpenPayment?: () => void
}

const roleHandlers: Record<string, () => void> = {
  undo: () => window.electronAPI.menuUndo(),
  redo: () => window.electronAPI.menuRedo(),
  cut: () => window.electronAPI.menuCut(),
  copy: () => window.electronAPI.menuCopy(),
  paste: () => window.electronAPI.menuPaste(),
  selectAll: () => window.electronAPI.menuSelectAll(),
  zoomIn: () => window.electronAPI.menuZoomIn(),
  zoomOut: () => window.electronAPI.menuZoomOut(),
  resetZoom: () => window.electronAPI.menuZoomReset(),
  minimize: () => window.electronAPI.menuMinimize(),
  zoom: () => window.electronAPI.menuMaximize(),
}

const debugHandlers: Record<string, () => void> = {
  checkForUpdates: () => window.electronAPI.checkForUpdates(),
  installUpdate: () => window.electronAPI.installUpdate(),
  toggleDevTools: () => window.electronAPI.menuToggleDevTools(),
}

function getIcon(name: string): React.ComponentType<{ className?: string }> | null {
  const IconComponent = Icons[name as keyof typeof Icons] as React.ComponentType<{ className?: string }> | undefined
  return IconComponent ?? null
}

function renderSubmenuItem(
  item: MenuItem,
  index: number,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  if (item.type === 'separator') {
    return <StyledDropdownMenuSeparator key={`sep-${index}`} />
  }

  if (item.type === 'url') {
    const Icon = getIcon(item.icon)
    return (
      <StyledDropdownMenuItem key={item.id} onClick={() => window.electronAPI.openUrl(item.url)}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
      </StyledDropdownMenuItem>
    )
  }

  const Icon = getIcon(item.icon)
  const shortcut = getShortcutDisplay(item, isMac)

  if (item.type === 'role') {
    const handler = roleHandlers[item.role]
    const safeHandler = handler ?? (() => {
      console.warn(`[WorkbenchAccountMenu] No handler registered for role: ${item.role}`)
    })
    return (
      <StyledDropdownMenuItem key={item.role} onClick={safeHandler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  if (item.type === 'action') {
    const handler = item.id === 'toggleFocusMode'
      ? actionHandlers.toggleFocusMode
      : item.id === 'toggleSidebar'
        ? actionHandlers.toggleSidebar
        : undefined
    return (
      <StyledDropdownMenuItem key={item.id} onClick={handler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  return null
}

function renderMenuSection(
  section: typeof EDIT_MENU,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  const Icon = getIcon(section.icon)
  return (
    <DropdownMenuSub>
      <StyledDropdownMenuSubTrigger>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(section.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {section.items.map((item, index) => renderSubmenuItem(item, index, actionHandlers, t))}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * Renders the Debug submenu by mapping over `DEBUG_MENU.items`. The three actions
 * that drive it (`checkForUpdates`, `installUpdate`, `toggleDevTools`) all live on
 * `window.electronAPI` directly and never traverse the menu IPC channels.
 */
function renderDebugSubmenu(t: (key: string) => string): React.ReactNode {
  const SectionIcon = getIcon(DEBUG_MENU.icon)
  return (
    <DropdownMenuSub>
      <StyledDropdownMenuSubTrigger>
        {SectionIcon && <SectionIcon className="h-3.5 w-3.5" />}
        {t(DEBUG_MENU.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {DEBUG_MENU.items.map((item, index) => {
          if (item.type === 'separator') {
            return <StyledDropdownMenuSeparator key={`sep-${index}`} />
          }
          if (item.type !== 'action') return null
          const Icon = getIcon(item.icon)
          const shortcut = isMac ? item.shortcutDisplayMac : item.shortcutDisplayOther
          const handler = debugHandlers[item.id]
          if (!handler) {
            console.warn(`[WorkbenchAccountMenu] No debug handler for id: ${item.id}`)
            return null
          }
          return (
            <StyledDropdownMenuItem key={item.id} onClick={handler}>
              {Icon && <Icon className="h-3.5 w-3.5" />}
              {t(item.labelKey)}
              {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
          )
        })}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function WorkbenchAccountMenu({ onNewChat, onNewWindow, canOpenPayment, onOpenPayment }: WorkbenchAccountMenuProps) {
  const { t } = useTranslation()
  const appShell = useOptionalAppShellContext()
  const theme = useOptionalTheme()
  const actionRegistry = useOptionalActionRegistry()
  const { openTabs, activateTab } = useTabShell()
  const [isDebugMode, setIsDebugMode] = useState(false)

  useEffect(() => {
    window.electronAPI.isDebugMode().then(setIsDebugMode)
  }, [])

  // R8 navigation boundary: settings pages are Polo-scope routes rendered
  // inside the Polo tab. Firing the navigation from this menu while another
  // tab is active would change no visible surface, so activate the carrier
  // first (no-op when the tab was closed).
  const openPoloTab = openTabs.find((tab) => tab.type === "polo")
  const openPoloScoped = (request: () => void) => {
    if (openPoloTab) activateTab(openPoloTab.id)
    request()
  }

  const user = appShell?.currentAdminUser ?? null
  const userLabel = user?.displayName || user?.username || ""

  const newChatHotkey = useActionLabel('app.newChat').hotkey
  const newWindowHotkey = useActionLabel('app.newWindow').hotkey
  const keyboardShortcutsHotkey = useActionLabel('app.keyboardShortcuts').hotkey

  const actionHandlers: MenuActionHandlers = {
    toggleFocusMode: actionRegistry ? () => actionRegistry.execute('view.toggleFocusMode') : undefined,
    toggleSidebar: actionRegistry ? () => actionRegistry.execute('view.toggleSidebar') : undefined,
  }

  return (
    <>
      {user && (
        <div className="truncate px-2 py-1.5 text-[12px]">
          <span className="font-medium text-foreground">{userLabel}</span>
          {user.displayName && user.username ? (
            <span className="text-muted-foreground"> · {user.username}</span>
          ) : null}
        </div>
      )}
      {appShell && (
        <StyledDropdownMenuItem onClick={() => openPoloScoped(appShell.onOpenSettings)}>
          <Icons.Settings className="h-3.5 w-3.5" />
          {t("menu.settings")}
        </StyledDropdownMenuItem>
      )}
      {canOpenPayment && (
        <StyledDropdownMenuItem data-testid="topbar-payment" onClick={() => onOpenPayment?.()}>
          <Icons.Coins className="h-4 w-4" />
          {t("topbar.account.payment")}
        </StyledDropdownMenuItem>
      )}
      <ProductSpaceSwitcher />
      {theme && (
        <StyledDropdownMenuItem
          onClick={() => theme.setMode(theme.resolvedMode === "dark" ? "light" : "dark")}
        >
          <SunMoonIcon />
          {t("topbar.account.toggleTheme")}
        </StyledDropdownMenuItem>
      )}

      <StyledDropdownMenuSeparator />

      {/* POO-117 P117-02: the migrated app menu, grouped under "Polo AI".
          No in-app quit entry — OS quit / window close remain the exit paths. */}
      <DropdownMenuSub>
        <StyledDropdownMenuSubTrigger>
          <Icons.Sparkles className="h-3.5 w-3.5" />
          {t("menu.poloAiGroup")}
        </StyledDropdownMenuSubTrigger>
        <StyledDropdownMenuSubContent>
          <StyledDropdownMenuItem onClick={onNewChat} data-testid="menu-new-chat">
            <SquarePenRounded className="h-3.5 w-3.5" />
            {t(ROOT_MENU.newChat.labelKey)}
            {newChatHotkey && <DropdownMenuShortcut className="pl-6">{newChatHotkey}</DropdownMenuShortcut>}
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onClick={onNewWindow} data-testid="menu-new-window">
            <Icons.AppWindow className="h-3.5 w-3.5" />
            {t(ROOT_MENU.newWindow.labelKey)}
            {newWindowHotkey && <DropdownMenuShortcut className="pl-6">{newWindowHotkey}</DropdownMenuShortcut>}
          </StyledDropdownMenuItem>

          <StyledDropdownMenuSeparator />

          {renderMenuSection(EDIT_MENU, actionHandlers, t)}
          {renderMenuSection(VIEW_MENU, actionHandlers, t)}
          {renderMenuSection(WINDOW_MENU, actionHandlers, t)}
        </StyledDropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <StyledDropdownMenuSubTrigger>
          <Icons.HelpCircle className="h-3.5 w-3.5" />
          {t("menu.help")}
        </StyledDropdownMenuSubTrigger>
        <StyledDropdownMenuSubContent>
          {HELP_LINKS.map((link) => {
            const Icon = getIcon(link.icon)
            return (
              <StyledDropdownMenuItem
                key={link.id}
                onClick={() => window.electronAPI.openUrl(link.url)}
              >
                {Icon && <Icon className="h-3.5 w-3.5" />}
                {t(link.labelKey)}
                <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
              </StyledDropdownMenuItem>
            )
          })}
          <StyledDropdownMenuItem
            onClick={() => openPoloScoped(() => navigate(routes.view.settings('shortcuts')))}
          >
            <Icons.Keyboard className="h-3.5 w-3.5" />
            {t(ROOT_MENU.keyboardShortcuts.labelKey)}
            {keyboardShortcutsHotkey && <DropdownMenuShortcut className="pl-6">{keyboardShortcutsHotkey}</DropdownMenuShortcut>}
          </StyledDropdownMenuItem>
        </StyledDropdownMenuSubContent>
      </DropdownMenuSub>

      {isDebugMode && renderDebugSubmenu(t)}

      {user && appShell?.onAdminLogout && (
        <>
          <StyledDropdownMenuSeparator />
          <StyledDropdownMenuItem onClick={() => { void appShell.onAdminLogout?.() }}>
            <Icons.LogOut className="h-3.5 w-3.5" />
            {t("topbar.account.logout")}
          </StyledDropdownMenuItem>
        </>
      )}
    </>
  )
}

/** Theme-toggle icon kept tiny — lucide `SunMoon` mirrors the previous item. */
function SunMoonIcon() {
  return <Icons.SunMoon className="h-3.5 w-3.5" />
}
