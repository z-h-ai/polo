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
  onSelectWorkspace: selectLocalWorkspace, onOpenSettings: () => {},
}) }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/TabShellContext', () => ({ useTabShell: () => ({
  activeTab: { type: 'home' }, activeTabId: 'home', openTabs: [], activateHome: () => {},
  activateTab: () => {}, closeTab: () => {}, reorderTabs: () => {},
}) }))
// POO-117: the account menu is the real WorkbenchAccountMenu (the payment and
// ProductSpace entries under test now live inside it). Hotkey labels come from
// the action registry, which needs the App-level provider this reduced tree
// omits — stub the reads instead of growing the fixture.
mock.module('@/actions', () => ({
  useActionLabel: () => ({ label: '', hotkey: null }),
  useOptionalActionRegistry: () => null,
}))
const { render, screen, cleanup, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { TopBar } = await import('../TopBar')

const personal = { id: 'personal', kind: 'personal', name: '我的空间', accessMode: 'active', payer: { kind: 'account' } } as ProductSpaceSummary
const enterprise = { id: 'enterprise', kind: 'enterprise', enterpriseId: 'org-a', name: '合法企业', accessMode: 'active', role: 'member', payer: { kind: 'enterprise', enterpriseId: 'org-a' } } as ProductSpaceSummary
const restricted = { ...enterprise, id: 'restricted', enterpriseId: 'org-b', name: '受限企业', accessMode: 'read_only', restrictionCode: 'billing_restricted' } as ProductSpaceSummary
const select = mock(() => {})
// POO-112: the handoff now opens the static /pay/handoff landing route with
// the single-use ticket in the URL fragment — never the gated consumption
// page that used to demand a browser login.
const handoffUrl = 'https://admin.example.com/pay/handoff#ticket=' + 'A'.repeat(43)
const paymentHandoff = mock(async () => ({ success: true, accountId: 'account-a', productSpaceId: 'personal', url: handoffUrl }))
const openPaymentUrl = mock(async (_url: string) => {})
function tree(active: ProductSpaceSummary, productSpaces = [personal, enterprise, restricted]) {
  // All execution reads stay on the real current account/space tuple.
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    productSpaceListActiveExecutions: async () => ({ success: true, executions: [] }),
    adminPaymentHandoff: paymentHandoff, openUrl: openPaymentUrl,
    isDebugMode: async () => false,
  } })
  return createElement(I18nextProvider, { i18n }, createElement(ProductSpaceProvider, {
    children: createElement(TopBar),
    value: {
      accountId: 'account-a', membershipListVerified: true, activeProductSpaceId: active.id, activeProductSpace: active,
      personalProductSpaceId: personal.id, productSpaces, allProductSpaces: productSpaces,
      productSpaceContextKey: JSON.stringify(['product-space', 1, 'account-a', active.id]), contextVersion: 1,
      pendingSwitch: null, onSelectProductSpace: select, onRefreshProductSpaces: () => {},
      onConfirmStopAndSwitch: () => {}, onRetryFailedStops: () => {}, onCancelSwitch: () => {},
      onStopSwitchExecution: () => {}, onRetryTargetLoad: () => {}, onDismissTargetAccessLost: () => {},
    },
  }))
}
afterEach(() => { cleanup(); select.mockClear(); selectLocalWorkspace.mockClear(); themeMode = 'light'; paymentHandoff.mockClear(); openPaymentUrl.mockClear() })

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
    // Review #6: the muted alias binds to the §13.14 material muted value.
    expect(submenu.style.getPropertyValue('--muted-foreground')).toBe('var(--client-material-fg-muted)')
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


describe('Account payment entry', () => {
  it('opens the main-authorized personal payment page only after a click', async () => {
    render(tree(personal))
    const user = userEvent.setup()
    await user.click(screen.getByTestId('topbar-account'))
    expect(paymentHandoff).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('topbar-payment'))
    await waitFor(() => expect(openPaymentUrl).toHaveBeenCalledWith(handoffUrl))
  })
  it('mints at most one handoff while a click is still in flight', async () => {
    // A second click during the first handoff must not mint a competing
    // ticket: issuance supersedes the outstanding ticket for the same
    // session+space, which would break the handoff the user already has.
    let releaseHandoff!: (value: { success: boolean, accountId: string, productSpaceId: string, url: string }) => void
    paymentHandoff.mockImplementationOnce(() => new Promise(resolve => { releaseHandoff = resolve }))
    render(tree(personal))
    const user = userEvent.setup()
    await user.click(screen.getByTestId('topbar-account'))
    await user.click(screen.getByTestId('topbar-payment'))
    // The first click closes the account menu; the impatient second click
    // re-opens it and fires again while the first handoff is still in flight.
    await user.click(screen.getByTestId('topbar-account'))
    await user.click(await screen.findByTestId('topbar-payment'))
    await waitFor(() => expect(releaseHandoff).toBeDefined())
    expect(paymentHandoff).toHaveBeenCalledTimes(1)
    releaseHandoff({ success: true, accountId: 'account-a', productSpaceId: 'personal', url: handoffUrl })
    await waitFor(() => expect(openPaymentUrl).toHaveBeenCalledWith(handoffUrl))
    expect(openPaymentUrl).toHaveBeenCalledTimes(1)
  })
  it('hides financial entry from enterprise members even if another enterprise is owned', async () => {
    const owner = { ...enterprise, id: 'other', role: 'owner' } as ProductSpaceSummary
    render(tree(enterprise, [personal, enterprise, owner]))
    await userEvent.setup().click(screen.getByTestId('topbar-account'))
    expect(screen.queryByTestId('topbar-payment')).toBeNull()
    expect(paymentHandoff).not.toHaveBeenCalled()
  })
})


it('drops a delayed browser handoff when the visible account space changes', async () => {
  let resolveHandoff!: (value: any) => void
  paymentHandoff.mockImplementationOnce(() => new Promise(resolve => { resolveHandoff = resolve }))
  const view = render(tree(personal))
  const user = userEvent.setup()
  await user.click(screen.getByTestId('topbar-account'))
  await user.click(screen.getByTestId('topbar-payment'))
  await waitFor(() => expect(resolveHandoff).toBeDefined())
  view.rerender(tree(enterprise))
  resolveHandoff({ success: true, accountId: 'account-a', productSpaceId: personal.id, url: handoffUrl })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(openPaymentUrl).not.toHaveBeenCalled()
})
