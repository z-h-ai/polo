import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()

const { render, screen, cleanup } = await import('@testing-library/react')
const { LeftSidebar } = await import('../LeftSidebar')
type SidebarUserMenuConfig = import('../LeftSidebar').SidebarUserMenuConfig

const links = [
  {
    id: 'nav:settings',
    title: 'Settings',
    icon: createElement('span'),
    variant: 'ghost' as const,
  },
]

const fullUserMenu: SidebarUserMenuConfig = {
  user: { username: 'admin_user', displayName: 'Admin' },
  onSettings: () => {},
  onLogout: async () => {},
}

afterEach(() => {
  cleanup()
})

/**
 * POO-103: the bottom-left avatar/user menu is removed from the assistant
 * shell — AppShell no longer passes `userMenu`, so the trigger must never
 * render. The SidebarUserMenu component itself is kept (unused-prop contract)
 * and must still render when a host explicitly provides a config.
 */
describe('LeftSidebar user menu (POO-103 N1 fix)', () => {
  it('does not render the bottom-left user menu when AppShell omits userMenu', () => {
    render(createElement(I18nextProvider, { i18n }, createElement(LeftSidebar, {
      isCollapsed: false,
      links,
    })))
    expect(screen.queryByTestId('sidebar-user-menu-trigger')).toBeNull()
  })

  it('does not render the bottom-left user menu for an explicit null config', () => {
    render(createElement(I18nextProvider, { i18n }, createElement(LeftSidebar, {
      isCollapsed: false,
      links,
      userMenu: null,
    })))
    expect(screen.queryByTestId('sidebar-user-menu-trigger')).toBeNull()
  })

  it('keeps SidebarUserMenu renderable when a host passes a config', () => {
    render(createElement(I18nextProvider, { i18n }, createElement(LeftSidebar, {
      isCollapsed: false,
      links,
      userMenu: fullUserMenu,
    })))
    expect(screen.getByTestId('sidebar-user-menu-trigger')).toBeTruthy()
  })
})
