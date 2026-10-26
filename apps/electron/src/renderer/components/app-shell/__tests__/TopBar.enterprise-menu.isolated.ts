import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { AdminStatusResult } from '../../../../shared/types'

GlobalRegistrator.register()
setupI18n()
let themeMode: 'light' | 'dark' = 'light'
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => ({ resolvedMode: themeMode, setMode: () => {} }) }))
mock.module('@/atoms/sessions', () => ({ sessionMetaMapAtom: {} }))
mock.module('jotai', () => ({ useAtomValue: () => new Map() }))
const selectLocalWorkspace = mock(() => {})
mock.module('@/context/AppShellContext', () => ({ useOptionalAppShellContext: () => ({
  currentAdminUser: { displayName: '本账号', username: 'owner' },
  workspaces: [{ id: 'local-project', name: '本地项目目录' }], activeWorkspaceId: 'local-project',
  onSelectWorkspace: selectLocalWorkspace, onOpenSettings: () => {},
}) }))
mock.module('@/context/ClientPageContext', () => ({ useOptionalClientPage: () => ({ isHeaderLineVisible: false }) }))
mock.module('@/context/TabShellContext', () => ({ useTabShell: () => ({
  activeTab: { type: 'home' }, activeTabId: 'home', openTabs: [], activateHome: () => {},
  activateTab: () => {}, closeTab: () => {}, reorderTabs: () => {},
}) }))
mock.module('@/actions', () => ({
  useActionLabel: () => ({ label: '', hotkey: null }),
  useOptionalActionRegistry: () => null,
}))
// POO-119: collect the fail-closed toast instead of letting it leak into output.
const toastError = mock((_message: string, _options?: unknown) => {})
mock.module('sonner', () => ({ toast: { error: toastError, success: () => {} } }))

const { render, screen, cleanup, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { TopBar } = await import('../TopBar')

const personal = { id: 'personal', kind: 'personal', name: '我的空间', accessMode: 'active', payer: { kind: 'account' } } as ProductSpaceSummary
const member = { id: 'enterprise', kind: 'enterprise', enterpriseId: 'org-a', name: '成员企业', accessMode: 'active', role: 'member', payer: { kind: 'enterprise', enterpriseId: 'org-a' } } as ProductSpaceSummary
const owner = { ...member, id: 'owned', name: '我的企业', role: 'owner' } as ProductSpaceSummary
const manager = { ...member, id: 'managed', name: '受管企业', role: 'manager' } as ProductSpaceSummary

// The admin console is trusted-origin only: the handoff always targets the
// origin reported by the main process, never a renderer-provided host.
const openUrl = mock(async (_url: string) => {})
// Full AdminStatusResult fixture (types.ts:497): adminUrl is optional string —
// a logged-out main process simply omits it, it is never null.
const adminStatus = (partial: Partial<AdminStatusResult> = {}): AdminStatusResult => ({
  adminUrl: 'https://admin.example.com',
  loggedIn: true,
  userId: 'account-a',
  username: null,
  displayName: null,
  ...partial,
})
const adminGetStatus = mock(async () => adminStatus())

function tree(active: ProductSpaceSummary, productSpaces = [personal, member, owner]) {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    productSpaceListActiveExecutions: async () => ({ success: true, executions: [] }),
    adminGetStatus, openUrl, isDebugMode: async () => false,
  } })
  return createElement(I18nextProvider, { i18n }, createElement(ProductSpaceProvider, {
    children: createElement(TopBar),
    value: {
      accountId: 'account-a', membershipListVerified: true, activeProductSpaceId: active.id, activeProductSpace: active,
      personalProductSpaceId: personal.id, productSpaces, allProductSpaces: productSpaces,
      productSpaceContextKey: JSON.stringify(['product-space', 1, 'account-a', active.id]), contextVersion: 1,
      pendingSwitch: null, onSelectProductSpace: () => {}, onRefreshProductSpaces: () => {},
      onConfirmStopAndSwitch: () => {}, onRetryFailedStops: () => {}, onCancelSwitch: () => {},
      onStopSwitchExecution: () => {}, onRetryTargetLoad: () => {}, onDismissTargetAccessLost: () => {},
    },
  }))
}

afterEach(() => {
  cleanup()
  selectLocalWorkspace.mockClear()
  themeMode = 'light'
  openUrl.mockClear()
  adminGetStatus.mockClear()
  toastError.mockClear()
})

async function openAccountMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByTestId('topbar-account'))
  return user
}

describe('POO-119 enterprise consoles in the account menu', () => {
  it('offers the member console to an owner and opens it on the trusted admin origin (ENTMENU-01)', async () => {
    await i18n.changeLanguage('zh-Hans')
    render(tree(owner))
    const user = await openAccountMenu()
    expect(screen.getByTestId('topbar-enterprise-admin')).toBeTruthy()
    expect(screen.getByTestId('topbar-creator-center')).toBeTruthy()
    await user.click(screen.getByTestId('topbar-enterprise-admin'))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://admin.example.com/enterprise/org-a/members'))
    // The admin-session lease check must have run before any handoff.
    expect(adminGetStatus).toHaveBeenCalledTimes(1)
  })

  it('scopes the creator center to the active organization (ENTMENU-02)', async () => {
    render(tree(owner))
    const user = await openAccountMenu()
    await user.click(screen.getByTestId('topbar-creator-center'))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://admin.example.com/organization-apps?organizationId=org-a'))
  })

  it('still offers the consoles to a manager (ENTMENU-01 keeps managers in)', async () => {
    render(tree(manager))
    const user = await openAccountMenu()
    expect(screen.getByTestId('topbar-enterprise-admin')).toBeTruthy()
    await user.click(screen.getByTestId('topbar-enterprise-admin'))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://admin.example.com/enterprise/org-a/members'))
  })

  it('hides both entries from members and from personal spaces (ENTMENU-03/04)', async () => {
    const view = render(tree(member))
    const user = await openAccountMenu()
    expect(screen.queryByTestId('topbar-enterprise-admin')).toBeNull()
    expect(screen.queryByTestId('topbar-creator-center')).toBeNull()
    await user.keyboard('{Escape}')
    view.unmount()
    render(tree(personal))
    await openAccountMenu()
    expect(screen.queryByTestId('topbar-enterprise-admin')).toBeNull()
    expect(screen.queryByTestId('topbar-creator-center')).toBeNull()
    expect(adminGetStatus).not.toHaveBeenCalled()
  })

  it('refuses the handoff when the admin session is gone (ENTMENU-05)', async () => {
    // Logged out: no adminUrl at all (the contract's optional string is
    // omitted, never null) and no owning user.
    adminGetStatus.mockImplementationOnce(async () => adminStatus({ loggedIn: false, adminUrl: undefined, userId: null }))
    render(tree(owner))
    const user = await openAccountMenu()
    await user.click(screen.getByTestId('topbar-enterprise-admin'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('drops the handoff when the visible space changed between click and admin check (ENTMENU-05)', async () => {
    let releaseStatus!: (value: AdminStatusResult) => void
    adminGetStatus.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
    const view = render(tree(owner))
    const user = await openAccountMenu()
    await user.click(screen.getByTestId('topbar-enterprise-admin'))
    await waitFor(() => expect(releaseStatus).toBeDefined())
    // The user switched to the personal space while the lease check ran —
    // the click lease is dead, so the (still valid) admin session must not
    // open a console for the abandoned enterprise.
    view.rerender(tree(personal))
    releaseStatus(adminStatus())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(openUrl).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })

  it('refuses the handoff when the admin session belongs to another account (ENTMENU-05)', async () => {
    adminGetStatus.mockImplementationOnce(async () => adminStatus({ userId: 'account-b' }))
    render(tree(owner))
    const user = await openAccountMenu()
    await user.click(screen.getByTestId('topbar-creator-center'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(openUrl).not.toHaveBeenCalled()
  })
})
