import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

GlobalRegistrator.register()
setupI18n()
let themeMode: 'light' | 'dark' = 'light'
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => ({ resolvedMode: themeMode, setMode: () => {} }) }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: {} }))
mock.module('jotai', () => ({ useAtomValue: () => new Map() }))
const selectLocalWorkspace = mock(() => {})
mock.module('@/context/AppShellContext', () => ({ useOptionalAppShellContext: () => ({
  currentAdminUser: { displayName: '本账号', username: 'member' },
  workspaces: [{ id: 'local-project', name: '本地项目目录' }], activeWorkspaceId: 'local-project',
  onSelectWorkspace: selectLocalWorkspace, onOpenSettings: () => {}, onOpenStoredUserPreferences: () => {},
}) }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/TabShellContext', () => ({ useTabShell: () => ({
  activeTab: { type: 'home' }, activeTabId: 'home', openTabs: [], activateHome: () => {},
  activateTab: () => {}, closeTab: () => {}, reorderTabs: () => {},
}) }))
const { render, screen, cleanup, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { TopBar } = await import('../TopBar')

const personal = { id: 'personal', kind: 'personal', name: '我的空间', accessMode: 'active', payer: { kind: 'account' } } as ProductSpaceSummary
const enterprise = { id: 'enterprise', kind: 'enterprise', enterpriseId: 'org-a', name: '合法企业', accessMode: 'active', role: 'member', payer: { kind: 'enterprise', enterpriseId: 'org-a' } } as ProductSpaceSummary
const restricted = { ...enterprise, id: 'restricted', enterpriseId: 'org-b', name: '受限企业', accessMode: 'read_only', restrictionCode: 'billing_restricted' } as ProductSpaceSummary
const select = mock(() => {})
function tree(active: ProductSpaceSummary, productSpaces = [personal, enterprise, restricted]) {
  // All execution reads stay on the real current account/space tuple.
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    productSpaceListActiveExecutions: async () => ({ success: true, executions: [] }),
  } })
  return createElement(I18nextProvider, { i18n }, createElement(ProductSpaceProvider, {
    children: createElement(TopBar),
    value: {
      accountId: 'account-a', activeProductSpaceId: active.id, activeProductSpace: active,
      personalProductSpaceId: personal.id, productSpaces, allProductSpaces: productSpaces,
      productSpaceContextKey: JSON.stringify(['product-space', 1, 'account-a', active.id]), contextVersion: 1,
      pendingSwitch: null, onSelectProductSpace: select, onRefreshProductSpaces: () => {},
      onConfirmStopAndSwitch: () => {}, onRetryFailedStops: () => {}, onCancelSwitch: () => {},
      onStopSwitchExecution: () => {}, onRetryTargetLoad: () => {}, onDismissTargetAccessLost: () => {},
    },
  }))
}
afterEach(() => { cleanup(); select.mockClear(); selectLocalWorkspace.mockClear(); themeMode = 'light' })

async function openSpaces() {
  const user = userEvent.setup()
  await user.click(screen.getByTestId('topbar-account'))
  await user.click(await screen.findByTestId('product-space-switcher'))
  await waitFor(() => expect(screen.getAllByTestId('product-space-item')).toHaveLength(3))
  return user
}

describe('TopBar real account-menu ProductSpace entry', () => {
  it('shows static current identity and only the avatar submenu switches real ProductSpaces', async () => {
    await i18n.changeLanguage('zh-Hans')
    render(tree(personal))
    const label = screen.getByTestId('product-space-current-label')
    expect(label.textContent).toBe('我的空间')
    expect(label.tagName).toBe('DIV')
    expect(label.querySelector('button')).toBeNull()
    expect(screen.queryByTestId('product-space-switcher')).toBeNull()
    const user = await openSpaces()
    expect(screen.queryByText('本地项目目录')).toBeNull()
    const rows = screen.getAllByTestId('product-space-item')
    expect(rows.map(row => row.getAttribute('data-space-kind'))).toEqual(['personal', 'enterprise', 'enterprise'])
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(rows[0]!.getAttribute('data-disabled')).not.toBeNull()
    expect(rows[2]!.getAttribute('data-restricted')).toBe('true')
    expect(rows[2]!.textContent).toContain('受限')
    const submenu = rows[0]!.closest('[role=menu]') as HTMLElement
    expect(submenu.style.getPropertyValue('--info')).toBe('#3275d8')
    expect(submenu.style.getPropertyValue('--muted-foreground')).toBe('var(--fg-50)')
    rows[1]!.focus()
    await user.keyboard('{Enter}')
    expect(select).toHaveBeenCalledWith('enterprise')
    expect(selectLocalWorkspace).not.toHaveBeenCalled()
  })

  it('reopening after a context change shows current active/restricted identity and fresh list', async () => {
    const view = render(tree(personal))
    const user = await openSpaces()
    await user.keyboard('{Escape}{Escape}')
    view.rerender(tree(restricted))
    expect(screen.getByTestId('product-space-current-label').textContent).toContain('受限企业')
    await openSpaces()
    const rows = screen.getAllByTestId('product-space-item')
    expect(rows[0]!.getAttribute('data-disabled')).toBeNull()
    expect(rows[2]!.getAttribute('data-active')).toBe('true')
    await user.click(rows[0]!)
    expect(select).toHaveBeenCalledWith('personal')
    expect(selectLocalWorkspace).not.toHaveBeenCalled()
  })
  it('leaves dark renderer tokens intact on header and owned portal roots', async () => {
    themeMode = 'dark'
    render(tree(personal))
    expect(screen.getByTestId('app-topbar').style.getPropertyValue('--background')).toBe('')
    await openSpaces()
    const menu = screen.getAllByTestId('product-space-item')[0]!.closest('[role=menu]') as HTMLElement
    expect(menu.style.getPropertyValue('--accent')).toBe('')
    expect(menu.style.getPropertyValue('--font-sans')).toBe('')
  })

})
