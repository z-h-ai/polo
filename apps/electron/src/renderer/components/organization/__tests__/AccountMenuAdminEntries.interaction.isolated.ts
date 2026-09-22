import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement, type ReactElement } from 'react'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { OrganizationRole, OrganizationSummary } from '../../../../shared/types'

GlobalRegistrator.register()
setupI18n()

mock.module('@/components/ui/styled-dropdown', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  StyledDropdownMenuContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  StyledDropdownMenuItem: ({
    children,
    onClick,
    ...props
  }: {
    children?: ReactNode
    onClick?: () => void
  }) => createElement('button', { type: 'button', onClick, ...props }, children),
  StyledDropdownMenuSeparator: () => createElement('hr'),
  StyledDropdownMenuSubTrigger: ({ children, ...props }: { children?: ReactNode }) =>
    createElement('div', props, children),
  StyledDropdownMenuSubContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))

const { act, cleanup, render, screen } = await import('@testing-library/react')
const { OrganizationProvider } = await import('@/context/OrganizationContext')
const { AccountMenu } = await import('../AccountMenu')

function organizationSummary(
  id: string,
  name: string,
  role: OrganizationRole,
  type: 'creator_space' | 'enterprise_workspace' = 'creator_space',
): OrganizationSummary {
  return {
    id,
    type,
    name,
    purpose: `${name} purpose`,
    membership: { id: `membership-${id}`, role, status: 'active' },
    memberCount: 2,
  }
}

function contextValue(role: OrganizationRole) {
  const summaries = [
    organizationSummary('org-active', 'Organization A', role),
    organizationSummary('org-enterprise', '北方贸易', role, 'enterprise_workspace'),
  ]
  return {
    accountId: 'account-1',
    activeOrganizationId: 'org-active',
    organizationSummaries: summaries,
    organizationMembershipRole: role,
    organizationContextKey: `account-1:org-active`,
    contextVersion: 1,
    onSelectOrganization: () => {},
    onManageOrganization: () => {},
    onCreateOrganization: () => {},
  }
}

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

function menuHarness(role: OrganizationRole, extraProps: Record<string, unknown> = {}) {
  return createElement(
    OrganizationProvider,
    { value: contextValue(role), children: null },
    createElement(AccountMenu, {
      user: { username: 'test-user', displayName: 'Test User' },
      onLogout: async () => {},
      onOpenSettings: () => {},
      ...extraProps,
    }),
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

describe('AccountMenu billing and admin entries (P-M10-MENU variants)', () => {
  it('shows billing and the admin section for an owner', async () => {
    const onOpenBilling = mock(() => {})
    const onOpenEnterpriseAdmin = mock(() => {})
    const onOpenCreatorConsole = mock(() => {})
    await act(async () => {
      renderWithI18n(
        menuHarness('owner', {
          billing: { scope: 'personal' },
          onOpenBilling,
          admin: { enterprise: { organizationName: '北方贸易' }, creatorConsole: true },
          onOpenEnterpriseAdmin,
          onOpenCreatorConsole,
        }),
      )
    })

    expect(screen.getByTestId('account-menu-billing').textContent)
      .toContain('Top up & billing')
    const adminSection = screen.getByTestId('account-menu-admin-section')
    expect(adminSection.textContent).toContain('Management')

    const enterpriseRow = screen.getByTestId('account-menu-enterprise-admin')
    expect(enterpriseRow.textContent).toContain('Enterprise admin console')
    expect(enterpriseRow.textContent).toContain('北方贸易')
    expect(enterpriseRow.textContent).toContain('Owner')

    const creatorRow = screen.getByTestId('account-menu-creator-console')
    expect(creatorRow.textContent).toContain('Creator console')
    expect(creatorRow.textContent).toContain('open in browser')

    await act(async () => {
      enterpriseRow.click()
    })
    expect(onOpenEnterpriseAdmin).toHaveBeenCalledTimes(1)
    expect(onOpenBilling).not.toHaveBeenCalled()
  })

  it('shows the admin section for a manager too', async () => {
    await act(async () => {
      renderWithI18n(
        menuHarness('manager', {
          billing: { scope: 'personal' },
          admin: { creatorConsole: true },
        }),
      )
    })
    expect(screen.getByTestId('account-menu-admin-section')).toBeTruthy()
    expect(screen.getByTestId('account-menu-creator-console')).toBeTruthy()
    expect(screen.queryByTestId('account-menu-enterprise-admin')).toBeNull()
  })

  it('omits the admin section entirely for a member (not greyed out)', async () => {
    await act(async () => {
      renderWithI18n(
        menuHarness('member', {
          billing: { scope: 'enterprise' },
          admin: { enterprise: { organizationName: '北方贸易' }, creatorConsole: true },
        }),
      )
    })
    expect(screen.queryByTestId('account-menu-admin-section')).toBeNull()
    expect(screen.queryByTestId('account-menu-enterprise-admin')).toBeNull()
    expect(screen.queryByTestId('account-menu-creator-console')).toBeNull()
    // Billing stays available without management qualification.
    expect(screen.getByTestId('account-menu-billing').textContent)
      .toContain('Top up & billing')
  })

  it('keeps the previous menu when neither billing nor admin props are passed', async () => {
    await act(async () => {
      renderWithI18n(menuHarness('owner'))
    })
    expect(screen.queryByTestId('account-menu-billing')).toBeNull()
    expect(screen.queryByTestId('account-menu-admin-section')).toBeNull()
  })

  it('fires the billing callback from the billing row', async () => {
    const onOpenBilling = mock(() => {})
    await act(async () => {
      renderWithI18n(
        menuHarness('member', { billing: { scope: 'enterprise' }, onOpenBilling }),
      )
    })
    const row = screen.getByTestId('account-menu-billing')
    await act(async () => {
      row.click()
    })
    expect(onOpenBilling).toHaveBeenCalledTimes(1)
  })
})
