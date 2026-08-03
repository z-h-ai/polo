import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@z-h-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

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

const organizationId = '11111111-1111-4111-8111-111111111111'
const ownerMembershipId = '21111111-1111-4111-8111-111111111111'
const memberMembershipId = '22222222-2222-4222-8222-222222222222'

let organizationRole: 'owner' | 'manager' = 'manager'
let managedMemberStatus: 'active' | 'suspended' = 'active'

mock.module('@/context/OrganizationContext', () => ({
  useOrganizationContext: () => ({
    accountId: 'account-1',
    activeOrganizationId: organizationId,
    organizationSummaries: [{
      id: organizationId,
      type: 'creator_space',
      name: 'Studio',
      purpose: 'Publish apps',
      membership: {
        id: ownerMembershipId,
        role: organizationRole,
        status: 'active',
      },
      memberCount: 2,
    }],
    organizationMembershipRole: organizationRole,
    organizationContextKey: `account-1:${organizationId}`,
    contextVersion: 1,
    onSelectOrganization: mock(() => {}),
    onManageOrganization: mock(() => {}),
    onCreateOrganization: mock(() => {}),
  }),
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { OrganizationOnboarding } = await import('../OrganizationOnboarding')
const { OrganizationManagementDialog } = await import('../OrganizationManagementDialog')

type OnboardingProps = ComponentProps<typeof OrganizationOnboarding>

const organization = {
  id: organizationId,
  type: 'creator_space' as const,
  name: 'Studio',
  purpose: 'Publish apps',
}

const baseOnboardingProps: OnboardingProps = {
  flowState: 'create',
  organizations: [],
  joinPreview: null,
  error: null,
  onCreate: mock(async () => {}),
  onAcceptJoin: mock(async () => {}),
  onDismissJoin: mock(() => {}),
  onSelect: mock(() => {}),
  onShowCreate: mock(() => {}),
  onShowSelect: mock(() => {}),
  onRetry: mock(() => {}),
}

let listMembers = mock(async (_organizationId: string) => ({
  success: true as const,
  members: [
    {
      id: ownerMembershipId,
      role: 'owner' as const,
      status: 'active' as const,
      joinedAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      user: {
        id: 'user-owner',
        username: 'owner',
        displayName: 'Owner User',
      },
    },
    {
      id: memberMembershipId,
      role: 'member' as const,
      status: managedMemberStatus,
      joinedAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      user: {
        id: 'user-member',
        username: 'member',
        displayName: 'Member User',
      },
    },
  ],
}))

let listInvitations = mock(async (_organizationId: string) => ({
  success: true as const,
  invitations: [{
    id: '31111111-1111-4111-8111-111111111111',
    targetPhone: '13700137000',
    status: 'active',
    effectiveStatus: 'active' as const,
    maxUses: 1,
    useCount: 0,
    expiresAt: '2026-08-29T00:00:00.000Z',
    createdAt: '2026-07-29T00:00:00.000Z',
  }],
}))

let createInvitation = mock(async (
  _organizationId: string,
  _input: { targetPhone?: string; maxUses?: number },
) => ({
  success: true as const,
  token: 'invitation-token-1234567890',
  invitation: (await listInvitations(organizationId)).invitations[0],
}))

let createJoinLink = mock(async (
  _organizationId: string,
  _input: { expiresAt?: string | null; maxUses?: number | null },
) => ({
  success: true as const,
  token: 'public-token-1234567890',
  joinLink: {
    id: '41111111-1111-4111-8111-111111111111',
    status: 'active',
    maxUses: null,
    useCount: 0,
    expiresAt: null,
  },
}))

let cancelInvitation = mock(async (_organizationId: string, _invitationId: string) => ({
  success: true as const,
}))
let removeMember = mock(async (_organizationId: string, _memberId: string) => ({
  success: true as const,
}))
type UpdateMemberResult =
  | { success: true }
  | { success: false; errorCode: string }
let updateMember = mock(async (
  _organizationId: string,
  _memberId: string,
  input: {
    role?: 'manager' | 'member'
    status?: 'active' | 'suspended'
  },
): Promise<UpdateMemberResult> => {
  if (input.status) managedMemberStatus = input.status
  return { success: true as const }
})

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  organizationRole = 'manager'
  managedMemberStatus = 'active'
  updateMember = mock(async (
    _organizationId: string,
    _memberId: string,
    input: {
      role?: 'manager' | 'member'
      status?: 'active' | 'suspended'
    },
  ): Promise<UpdateMemberResult> => {
    if (input.status) managedMemberStatus = input.status
    return { success: true as const }
  })
  listMembers.mockClear()
  listInvitations.mockClear()
  createInvitation.mockClear()
  createJoinLink.mockClear()
  cancelInvitation.mockClear()
  removeMember.mockClear()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      organizationListMembers: (...args: [string]) => listMembers(...args),
      organizationListInvitations: (...args: [string]) => listInvitations(...args),
      organizationCreateInvitation: (
        ...args: [string, { targetPhone?: string; maxUses?: number }]
      ) => createInvitation(...args),
      organizationCreateJoinLink: (
        ...args: [string, { expiresAt?: string | null; maxUses?: number | null }]
      ) => createJoinLink(...args),
      organizationCancelInvitation: (...args: [string, string]) =>
        cancelInvitation(...args),
      organizationRevokeJoinLink: mock(async () => ({ success: true as const })),
      organizationUpdateMember: (
        ...args: [string, string, {
          role?: 'manager' | 'member'
          status?: 'active' | 'suspended'
        }]
      ) => updateMember(...args),
      organizationRemoveMember: (...args: [string, string]) => removeMember(...args),
    },
  })
})

afterEach(() => {
  cleanup()
})

describe('organization onboarding rendered interactions', () => {
  it('submits a trimmed creation once, preserves the form on failure, and reuses its idempotency key', async () => {
    let rejectFirst!: (reason: Error) => void
    const onCreate = mock((input: Parameters<OnboardingProps['onCreate']>[0]) => {
      if (onCreate.mock.calls.length === 1) {
        return new Promise((_, reject) => {
          rejectFirst = reject
        })
      }
      return Promise.resolve(input)
    })
    const user = userEvent.setup({ document: window.document })

    renderWithI18n(createElement(OrganizationOnboarding, {
      ...baseOnboardingProps,
      onCreate,
    }))

    const submit = screen.getByTestId('organization-create-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: /Business workspace/ }))
    fireEvent.change(screen.getByTestId('organization-name-input'), {
      target: { value: '  Acme Labs  ' },
    })
    fireEvent.change(screen.getByTestId('organization-purpose-input'), {
      target: { value: '  Internal automation  ' },
    })

    await user.click(submit)
    fireEvent.click(submit)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      type: 'enterprise_workspace',
      name: 'Acme Labs',
      purpose: 'Internal automation',
    })
    const firstIdempotencyKey = onCreate.mock.calls[0][0].idempotencyKey
    expect(firstIdempotencyKey.length).toBeGreaterThan(10)
    expect((screen.getByTestId('organization-name-input') as HTMLInputElement).disabled).toBe(true)

    rejectFirst(new Error('request failed'))
    await waitFor(() => expect(submit.disabled).toBe(false))
    expect((screen.getByTestId('organization-name-input') as HTMLInputElement).value)
      .toBe('  Acme Labs  ')
    expect((screen.getByTestId('organization-purpose-input') as HTMLTextAreaElement).value)
      .toBe('  Internal automation  ')

    await user.click(submit)
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2))
    expect(onCreate.mock.calls[1][0].idempotencyKey).toBe(firstIdempotencyKey)
  })

  it('keeps the creation idempotency key when the selected type is clicked during a lost response', async () => {
    let rejectLostResponse!: (reason: Error) => void
    const onCreate = mock((input: Parameters<OnboardingProps['onCreate']>[0]) => {
      if (onCreate.mock.calls.length === 1) {
        return new Promise((_, reject) => {
          rejectLostResponse = reject
        })
      }
      return Promise.resolve(input)
    })
    const user = userEvent.setup({ document: window.document })

    renderWithI18n(createElement(OrganizationOnboarding, {
      ...baseOnboardingProps,
      onCreate,
    }))

    fireEvent.change(screen.getByTestId('organization-name-input'), {
      target: { value: 'Creator Studio' },
    })
    fireEvent.change(screen.getByTestId('organization-purpose-input'), {
      target: { value: 'Publish creator apps' },
    })
    const selectedType = screen.getByRole('button', {
      name: /Creator space/,
    }) as HTMLButtonElement
    const submit = screen.getByTestId('organization-create-submit') as HTMLButtonElement

    await user.click(submit)
    expect(onCreate).toHaveBeenCalledTimes(1)
    const firstIdempotencyKey = onCreate.mock.calls[0][0].idempotencyKey
    expect(selectedType.disabled).toBe(true)

    fireEvent.click(selectedType)
    expect(onCreate).toHaveBeenCalledTimes(1)

    rejectLostResponse(new Error('response lost after server commit'))
    await waitFor(() => expect(submit.disabled).toBe(false))
    await user.click(submit)
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2))

    expect(onCreate.mock.calls[1][0]).toEqual(onCreate.mock.calls[0][0])
    expect(onCreate.mock.calls[1][0].idempotencyKey).toBe(firstIdempotencyKey)
  })

  it('shows invitation context, blocks duplicate acceptance, and disables invalid invitations', async () => {
    let resolveAccept!: () => void
    const onAcceptJoin = mock(() => new Promise<void>(resolve => {
      resolveAccept = resolve
    }))
    const user = userEvent.setup({ document: window.document })
    const joinPreview = {
      organization,
      join: {
        kind: 'join_link' as const,
        effectiveStatus: 'active' as const,
        expiresAt: null,
        usesRemaining: null,
        requiresPhoneMatch: false,
      },
    }

    const rendered = renderWithI18n(createElement(OrganizationOnboarding, {
      ...baseOnboardingProps,
      flowState: 'join',
      joinPreview,
      onAcceptJoin,
    }))

    expect(screen.getByText('Studio')).toBeTruthy()
    expect(screen.getByText('Creator space')).toBeTruthy()
    expect(screen.getByText('Public join link')).toBeTruthy()
    expect(screen.getByText('No')).toBeTruthy()
    const accept = screen.getByTestId('organization-join-accept') as HTMLButtonElement
    await user.click(accept)
    fireEvent.click(accept)
    expect(onAcceptJoin).toHaveBeenCalledTimes(1)
    expect(accept.disabled).toBe(true)

    resolveAccept()
    await waitFor(() => expect(accept.disabled).toBe(false))

    rendered.rerender(createElement(I18nextProvider, { i18n }, createElement(
      OrganizationOnboarding,
      {
        ...baseOnboardingProps,
        flowState: 'join',
        joinPreview: {
          ...joinPreview,
          join: {
            ...joinPreview.join,
            effectiveStatus: 'expired',
          },
        },
        onAcceptJoin,
      },
    )))
    expect(screen.getByText('Expired')).toBeTruthy()
    expect((screen.getByTestId('organization-join-accept') as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('localizes unknown errors with a safe fallback', async () => {
    await i18n.changeLanguage('zh-Hans')
    renderWithI18n(createElement(OrganizationOnboarding, {
      ...baseOnboardingProps,
      error: {
        code: 'unknown_server_code',
      },
    }))

    expect(screen.getByRole('alert').textContent).toContain('组织请求失败，请重试。')
  })
})

describe('organization management rendered interactions', () => {
  it('lets a Manager view members and invitations, create links, and cancel invitations', async () => {
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(OrganizationManagementDialog, {
      open: true,
      onOpenChange: mock(() => {}),
      onOrganizationsChanged: mock(async () => {}),
    }))

    await waitFor(() => {
      expect(listMembers).toHaveBeenCalledWith(organizationId)
      expect(listInvitations).toHaveBeenCalledWith(organizationId)
    })
    expect(await screen.findByText('Member User')).toBeTruthy()
    expect(screen.getByText(/member · Active/)).toBeTruthy()
    expect(screen.getByText('13700137000')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove member' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Suspend member' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore member' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Target phone (optional)'), {
      target: { value: '13600136000' },
    })
    await user.click(screen.getByRole('button', { name: 'Generate link' }))
    await waitFor(() => {
      expect(createInvitation).toHaveBeenCalledWith(organizationId, {
        targetPhone: '13600136000',
        maxUses: 1,
      })
    })
    expect(await screen.findByTestId('organization-invite-detail')).toBeTruthy()

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(cancelInvitation).toHaveBeenCalledWith(
        organizationId,
        '31111111-1111-4111-8111-111111111111',
      )
    })

    await waitFor(() => {
      expect((screen.getByRole('button', {
        name: 'Create public join link',
      }) as HTMLButtonElement).disabled).toBe(false)
    })
    await user.click(screen.getByRole('button', { name: 'Create public join link' }))
    await waitFor(() => {
      expect(createJoinLink).toHaveBeenCalledWith(organizationId, {
        expiresAt: null,
        maxUses: null,
      })
    })
  })

  it('lets only an Owner suspend, restore, and remove another member', async () => {
    organizationRole = 'owner'
    const onOrganizationsChanged = mock(async () => {})
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(OrganizationManagementDialog, {
      open: true,
      onOpenChange: mock(() => {}),
      onOrganizationsChanged,
    }))

    const suspend = await screen.findByRole('button', { name: 'Suspend member' })
    await user.click(suspend)
    await waitFor(() => {
      expect(updateMember).toHaveBeenCalledWith(
        organizationId,
        memberMembershipId,
        { status: 'suspended' },
      )
      expect(screen.getByRole('button', { name: 'Restore member' })).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Restore member' }))
    await waitFor(() => {
      expect(updateMember).toHaveBeenCalledWith(
        organizationId,
        memberMembershipId,
        { status: 'active' },
      )
      expect(screen.getByRole('button', { name: 'Suspend member' })).toBeTruthy()
    })

    const remove = screen.getByRole('button', { name: 'Remove member' })
    await user.click(remove)
    await waitFor(() => {
      expect(removeMember).toHaveBeenCalledWith(organizationId, memberMembershipId)
      expect(onOrganizationsChanged).toHaveBeenCalledTimes(1)
    })
  })

  it('shows the server reason when suspending a member fails', async () => {
    organizationRole = 'owner'
    updateMember = mock(async (): Promise<UpdateMemberResult> => ({
      success: false as const,
      errorCode: 'FORBIDDEN',
    }))
    const user = userEvent.setup({ document: window.document })
    renderWithI18n(createElement(OrganizationManagementDialog, {
      open: true,
      onOpenChange: mock(() => {}),
      onOrganizationsChanged: mock(async () => {}),
    }))

    await user.click(await screen.findByRole('button', { name: 'Suspend member' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You do not have permission to perform this action.',
    )
    expect(screen.getByRole('button', { name: 'Suspend member' })).toBeTruthy()
  })
})
