import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@z-h-ai/shared/i18n/setupI18n'
import { createElement, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationRole,
  OrganizationSummary,
} from '../../../../shared/types'

GlobalRegistrator.register()
setupI18n()

mock.module('@polo-ai/ui', () => ({
  Spinner: () => createElement('span', { 'data-testid': 'spinner' }),
}))

mock.module('sonner', () => ({
  toast: {
    success: mock(() => {}),
  },
}))

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? createElement('div', null, children) : null,
  DialogContent: ({ children, ...props }: { children?: ReactNode }) =>
    createElement('div', props, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    createElement('p', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    createElement('header', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) =>
    createElement('h1', null, children),
}))

mock.module('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TabsContent: ({ children }: { children?: ReactNode }) =>
    createElement('section', null, children),
  TabsList: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TabsTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('button', { type: 'button' }, children),
}))

mock.module('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  SelectItem: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('button', { type: 'button' }, children),
  SelectValue: () => null,
}))

mock.module('@/components/ui/styled-dropdown', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
}))

const { act, cleanup, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { OrganizationProvider } = await import('@/context/OrganizationContext')
const { OrganizationSwitcher } = await import('../OrganizationSwitcher')
const { OrganizationManagementDialog } = await import('../OrganizationManagementDialog')
const { subscribeToAdminAuthFailures } = await import('@/lib/admin-auth-failure')

const organizationAId = '11111111-1111-4111-8111-111111111111'
const organizationBId = '12222222-2222-4222-8222-222222222222'

function organizationSummary(
  id: string,
  name: string,
  role: OrganizationRole,
): OrganizationSummary {
  return {
    id,
    type: 'creator_space',
    name,
    purpose: `${name} purpose`,
    membership: {
      id: `membership-${id}`,
      role,
      status: 'active',
    },
    memberCount: 2,
  }
}

function member(
  id: string,
  name: string,
  role: 'owner' | 'member' = 'member',
): OrganizationMember {
  return {
    id,
    role,
    status: 'active',
    joinedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    user: {
      id: `user-${id}`,
      username: name.toLowerCase().replace(/\s+/g, '-'),
      displayName: name,
    },
  }
}

function invitation(id: string, phone: string): OrganizationInvitation {
  return {
    id,
    targetPhone: phone,
    status: 'active',
    effectiveStatus: 'active',
    maxUses: 1,
    useCount: 0,
    expiresAt: '2026-08-29T00:00:00.000Z',
    createdAt: '2026-07-29T00:00:00.000Z',
  }
}

let listMembers = mock(async (_organizationId: string) => ({
  success: true as const,
  members: [member('member-default', 'Default Member')],
}))
let listInvitations = mock(async (_organizationId: string) => ({
  success: true as const,
  invitations: [invitation('invite-default', '13800138000')],
}))
type CreateInvitationResult = Awaited<
  ReturnType<Window['electronAPI']['organizationCreateInvitation']>
>
let createInvitation = mock(async (
  _organizationId: string,
  _input: { targetPhone?: string; maxUses?: number },
): Promise<CreateInvitationResult> => ({
  success: false,
  errorCode: 'NOT_IMPLEMENTED',
}))
type UpdateMemberResult =
  | { success: true }
  | { success: false; errorCode: string }
let updateMember = mock(async (
  _organizationId: string,
  _memberId: string,
  _input: { status?: 'active' | 'suspended' },
): Promise<UpdateMemberResult> => ({ success: true as const }))

function contextValue(
  role: OrganizationRole,
  activeOrganizationId = organizationAId,
  onManageOrganization = () => {},
) {
  const summaries = [
    organizationSummary(organizationAId, 'Organization A', role),
    organizationSummary(organizationBId, 'Organization B', role),
  ]
  return {
    accountId: 'account-1',
    activeOrganizationId,
    organizationSummaries: summaries,
    organizationMembershipRole: role,
    organizationContextKey: `account-1:${activeOrganizationId}`,
    contextVersion: 1,
    onSelectOrganization: () => {},
    onManageOrganization,
    onCreateOrganization: () => {},
  }
}

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

function ManagementEntryHarness({ role }: { role: OrganizationRole }) {
  const [open, setOpen] = useState(false)
  return createElement(
    OrganizationProvider,
    {
      value: contextValue(role, organizationAId, () => setOpen(true)),
      children: null,
    },
    createElement(OrganizationSwitcher),
    createElement(OrganizationManagementDialog, {
      open,
      onOpenChange: setOpen,
      onOrganizationsChanged: async () => {},
    }),
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  listMembers = mock(async () => ({
    success: true as const,
    members: [member('member-default', 'Default Member')],
  }))
  listInvitations = mock(async () => ({
    success: true as const,
    invitations: [invitation('invite-default', '13800138000')],
  }))
  createInvitation = mock(async (): Promise<CreateInvitationResult> => ({
    success: false,
    errorCode: 'NOT_IMPLEMENTED',
  }))
  updateMember = mock(async (): Promise<UpdateMemberResult> => ({ success: true as const }))
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      organizationListMembers: (...args: [string]) => listMembers(...args),
      organizationListInvitations: (...args: [string]) => listInvitations(...args),
      organizationCreateInvitation: (
        ...args: [string, { targetPhone?: string; maxUses?: number }]
      ) => createInvitation(...args),
      organizationCreateJoinLink: mock(async () => ({
        success: false as const,
        errorCode: 'NOT_IMPLEMENTED',
      })),
      organizationCancelInvitation: mock(async () => ({ success: true as const })),
      organizationRevokeJoinLink: mock(async () => ({ success: true as const })),
      organizationUpdateMember: (
        ...args: [string, string, { status?: 'active' | 'suspended' }]
      ) => updateMember(...args),
      organizationRemoveMember: mock(async () => ({ success: true as const })),
    },
  })
})

afterEach(() => {
  cleanup()
})

describe('OrganizationSwitcher management gate', () => {
  for (const role of ['owner', 'manager'] as const) {
    it(`opens management and loads data for ${role}`, async () => {
      const user = userEvent.setup({ document: window.document })
      renderWithI18n(createElement(ManagementEntryHarness, { role }))

      await user.click(screen.getByRole('button', { name: 'Manage organization' }))
      await waitFor(() => {
        expect(listMembers).toHaveBeenCalledWith(organizationAId)
        expect(listInvitations).toHaveBeenCalledWith(organizationAId)
      })
      expect(screen.getByTestId('organization-management-dialog')).toBeTruthy()
    })
  }

  it('hides management from a member and never loads protected data', () => {
    renderWithI18n(createElement(ManagementEntryHarness, { role: 'member' }))

    expect(screen.queryByRole('button', { name: 'Manage organization' })).toBeNull()
    expect(listMembers).not.toHaveBeenCalled()
    expect(listInvitations).not.toHaveBeenCalled()
  })

  it('shows a lost current organization only as a non-selectable tombstone', async () => {
    const selectOrganization = mock(() => {})
    const tombstone = {
      ...organizationSummary(organizationAId, 'Unavailable Organization', 'owner'),
      status: 'suspended' as const,
      membership: {
        ...organizationSummary(
          organizationAId,
          'Unavailable Organization',
          'owner',
        ).membership,
        status: 'removed' as const,
      },
    }
    renderWithI18n(createElement(
      OrganizationProvider,
      {
        value: {
          ...contextValue('owner'),
          activeOrganizationId: organizationAId,
          organizationSummaries: [
            tombstone,
            organizationSummary(organizationBId, 'Organization B', 'owner'),
          ],
          organizationContextKey: `account-1:${organizationAId}`,
          onSelectOrganization: selectOrganization,
        },
        children: null,
      },
      createElement(OrganizationSwitcher),
    ))

    expect(screen.getByTestId('organization-switcher').textContent)
      .toContain('Unavailable Organization')
    expect(screen.queryByRole('button', { name: 'Manage organization' }))
      .toBeNull()
    const rows = screen.getAllByTestId('organization-switcher-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Organization B')
    expect(rows[0]?.textContent).not.toContain('Unavailable Organization')

    const user = userEvent.setup({ document: window.document })
    await user.click(rows[0]!)
    expect(selectOrganization).toHaveBeenCalledWith(organizationBId)
  })
})

describe('organization management request isolation', () => {
  it('ignores late organization A responses after switching to organization B', async () => {
    type MembersResult = Awaited<ReturnType<typeof listMembers>>
    type InvitationsResult = Awaited<ReturnType<typeof listInvitations>>
    let resolveMembersA!: (value: MembersResult) => void
    let resolveMembersB!: (value: MembersResult) => void
    let resolveInvitationsA!: (value: InvitationsResult) => void
    let resolveInvitationsB!: (value: InvitationsResult) => void
    listMembers = mock((organizationId: string) => new Promise<MembersResult>(resolve => {
      if (organizationId === organizationAId) resolveMembersA = resolve
      if (organizationId === organizationBId) resolveMembersB = resolve
    }))
    listInvitations = mock((organizationId: string) => new Promise<InvitationsResult>(resolve => {
      if (organizationId === organizationAId) resolveInvitationsA = resolve
      if (organizationId === organizationBId) resolveInvitationsB = resolve
    }))

    function SwitchingHarness() {
      const [activeOrganizationId, setActiveOrganizationId] = useState(organizationAId)
      return createElement(
        OrganizationProvider,
        {
          value: contextValue('owner', activeOrganizationId),
          children: null,
        },
        createElement('button', {
          type: 'button',
          onClick: () => setActiveOrganizationId(organizationBId),
        }, 'Switch to B'),
        createElement(OrganizationManagementDialog, {
          open: true,
          onOpenChange: () => {},
          onOrganizationsChanged: async () => {},
        }),
      )
    }

    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(SwitchingHarness))
    await waitFor(() => expect(listMembers).toHaveBeenCalledWith(organizationAId))
    await user.click(screen.getByRole('button', { name: 'Switch to B' }))
    await waitFor(() => expect(listMembers).toHaveBeenCalledWith(organizationBId))

    await act(async () => {
      resolveMembersB({
        success: true,
        members: [member('member-b', 'Member B')],
      })
      resolveInvitationsB({
        success: true,
        invitations: [invitation('invite-b', '13900139000')],
      })
    })
    expect(await screen.findByText('Member B')).toBeTruthy()
    expect(screen.getByText('13900139000')).toBeTruthy()

    await act(async () => {
      resolveMembersA({
        success: true,
        members: [member('member-a', 'Member A')],
      })
      resolveInvitationsA({
        success: true,
        invitations: [invitation('invite-a', '13700137000')],
      })
    })
    expect(screen.queryByText('Member A')).toBeNull()
    expect(screen.queryByText('13700137000')).toBeNull()
    expect(screen.getByText('Member B')).toBeTruthy()
  })

  it('discards a generated invitation token when its organization scope changes', async () => {
    let resolveCreateInvitation!: (value: CreateInvitationResult) => void
    createInvitation = mock((
      _organizationId: string,
      _input: { targetPhone?: string; maxUses?: number },
    ) => new Promise<CreateInvitationResult>(resolve => {
      resolveCreateInvitation = resolve
    }))

    function SwitchingActionHarness() {
      const [activeOrganizationId, setActiveOrganizationId] = useState(organizationAId)
      return createElement(
        OrganizationProvider,
        {
          value: contextValue('owner', activeOrganizationId),
          children: null,
        },
        createElement('button', {
          type: 'button',
          onClick: () => setActiveOrganizationId(organizationBId),
        }, 'Switch action to B'),
        createElement(OrganizationManagementDialog, {
          open: true,
          onOpenChange: () => {},
          onOrganizationsChanged: async () => {},
        }),
      )
    }

    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(SwitchingActionHarness))
    const maxUsesInput = screen.getByLabelText('Max uses') as HTMLInputElement
    await user.clear(maxUsesInput)
    await user.type(maxUsesInput, '7')
    await user.type(
      screen.getByLabelText('Target phone (optional)'),
      '13600136000',
    )
    await user.click(screen.getByRole('button', { name: 'Generate link' }))
    expect(createInvitation).toHaveBeenCalledWith(organizationAId, {
      targetPhone: '13600136000',
      maxUses: 1,
    })

    await user.click(screen.getByRole('button', { name: 'Switch action to B' }))
    await waitFor(() => {
      expect(
        (screen.getByLabelText('Target phone (optional)') as HTMLInputElement).value,
      ).toBe('')
      expect((screen.getByLabelText('Max uses') as HTMLInputElement).value).toBe('1')
      expect(
        (screen.getByRole('button', { name: 'Generate link' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false)
    })

    const staleToken = 'organization-a-secret-token-abcdefghijklmnopqrstuvwxyz'
    await act(async () => {
      resolveCreateInvitation({
        success: true,
        token: staleToken,
        invitation: invitation('stale-invitation-a', '13600136000'),
      })
    })

    expect(screen.queryByDisplayValue(`poloai://join/${staleToken}`)).toBeNull()
    expect(screen.queryByTestId('organization-invite-detail')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('routes member-management auth failures through the shared login handler', async () => {
    updateMember = mock(async (): Promise<UpdateMemberResult> => ({
      success: false as const,
      errorCode: 'TOKEN_EXPIRED',
    }))

    function ManagementAuthHarness() {
      const [route, setRoute] = useState<'management' | 'phone-login'>('management')
      useEffect(() => subscribeToAdminAuthFailures(() => {
        setRoute('phone-login')
      }), [])
      return createElement(
        OrganizationProvider,
        {
          value: contextValue('owner'),
          children: null,
        },
        createElement('div', null, route),
        createElement(OrganizationManagementDialog, {
          open: true,
          onOpenChange: () => {},
          onOrganizationsChanged: async () => {},
        }),
      )
    }

    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(ManagementAuthHarness))
    await user.click(await screen.findByRole('button', { name: 'Suspend member' }))
    expect(await screen.findByText('phone-login')).toBeTruthy()
  })
})
