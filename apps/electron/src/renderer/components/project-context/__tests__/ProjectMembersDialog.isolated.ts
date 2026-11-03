import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type {
  ClientInvitationEntry,
  ClientMemberEntry,
  ClientMemberRosterResponse,
} from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * POO-196 追加轮 ProjectMembersDialog (isolated happy-dom render, same
 * pattern as ShareToProjectDialog.isolated.ts): the role-shaped surfaces
 * (a plain member reads NOTHING, an owner/manager reads roster + invitation
 * records), the invite compose step inside the dialog, the copyable link that
 * lives only in the result step, and the 403 landing that CLEARS the panel
 * instead of falling back to the previous cache.
 */

mock.module('@/components/ui/client-workbench', () => ({
  clientWorkbenchFocusClassName: '',
  clientWorkbenchDialogClassName: '',
  clientWorkbenchOverlayClassName: '',
  clientWorkbenchMenuClassName: '',
  clientWorkbenchPrimaryClassName: '',
  clientWorkbenchButtonClassName: '',
  clientWorkbenchDestructiveClassName: '',
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ProjectMembersDialog } = await import('../ProjectMembersDialog')

const INVITE_URL = 'https://admin.example.com/invite/pm-invite-1'

const ROSTER: ClientMemberRosterResponse = {
  productSpaceId: 'space-1',
  enterpriseName: '华东区销售资料库',
  viewerRole: 'owner',
  members: [
    { membershipId: 'm-1', userId: 'u-1', displayName: '李明', role: 'owner' },
    { membershipId: 'm-2', userId: 'u-2', displayName: '王芳', role: 'member' },
  ] as unknown as ClientMemberEntry[],
  nextCursor: null,
}

const INVITATION: ClientInvitationEntry = {
  invitationId: 'inv-1',
  status: 'active',
  maskedPhone: '138****0000',
  maskedEmail: null,
  expiresAt: '2026-11-09T00:00:00.000Z',
  createdAt: '2026-11-02T00:00:00.000Z',
  acceptedAt: null,
}

interface Harness {
  membersCalls: Array<Record<string, unknown>>
  invitationsCalls: Array<Record<string, unknown>>
  inviteCalls: Array<Record<string, unknown>>
  clipboard: string[]
}

function makeHarness(options: {
  membersResponse?: () => ClientMemberRosterResponse
  membersError?: { code: string }
  invitationsError?: { code: string }
  /** S2-ENG-3: the FIRST invite call throws this (transport-style), later
   * calls answer with `inviteResponse` — the replay path. */
  inviteError?: Error
  inviteResponse?: Record<string, unknown>
} = {}): Harness {
  const harness: Harness = {
    membersCalls: [],
    invitationsCalls: [],
    inviteCalls: [],
    clipboard: [],
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListProjectMembers: async (input: Record<string, unknown>) => {
        harness.membersCalls.push(input)
        if (options.membersError) {
          throw Object.assign(new Error(options.membersError.code), { code: options.membersError.code })
        }
        return options.membersResponse ? options.membersResponse() : ROSTER
      },
      pmListProjectInvitations: async (input: Record<string, unknown>) => {
        harness.invitationsCalls.push(input)
        if (options.invitationsError) {
          throw Object.assign(new Error(options.invitationsError.code), { code: options.invitationsError.code })
        }
        return {
          productSpaceId: 'space-1',
          viewerRole: 'owner',
          invitations: [INVITATION],
          nextCursor: null,
        }
      },
      pmCreateProjectInvitation: async (input: Record<string, unknown>) => {
        harness.inviteCalls.push(input)
        if (options.inviteError && harness.inviteCalls.length === 1) throw options.inviteError
        if (options.inviteResponse) return options.inviteResponse
        return {
          result: 'created',
          invitation: INVITATION,
          invitationUrl: INVITE_URL,
        }
      },
    },
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        harness.clipboard.push(text)
      },
    },
  })
  return harness
}

function renderMembers(options: Parameters<typeof makeHarness>[0] & { viewerRole?: 'owner' | 'manager' | 'member' } = {}) {
  const harness = makeHarness(options)
  const onOpenChange = mock(() => {})
  const onOpenEnterpriseManagement = mock(() => {})
  const Dialog = ProjectMembersDialog as unknown as (props: Record<string, unknown>) => ReactElement
  render(createElement(
    I18nextProvider,
    { i18n },
    createElement(Dialog, {
      open: true,
      onOpenChange,
      scope: { accountId: 'account-1', productSpaceId: 'space-1' },
      projectName: '华东区销售资料库',
      viewerRole: options.viewerRole ?? 'owner',
      onOpenEnterpriseManagement,
    }),
  ))
  return { harness, onOpenChange, onOpenEnterpriseManagement }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(cleanup)

describe('ProjectMembersDialog (POO-196 追加轮 D-C)', () => {
  it('a plain member reads NOTHING: no management call, own role only', async () => {
    const { harness } = renderMembers({ viewerRole: 'member' })

    await screen.findByTestId('project-members-member-surface')
    expect(screen.getByTestId('project-members-your-role').textContent).toContain('成员')
    expect(screen.getByTestId('project-members-contact-owner').textContent).toContain('请联系项目负责人')

    // The admin 403 stays the authority — the client never even asks.
    expect(harness.membersCalls).toHaveLength(0)
    expect(harness.invitationsCalls).toHaveLength(0)
    expect(screen.queryByTestId('project-members-roster')).toBeNull()
    expect(screen.queryByTestId('project-members-invite-action')).toBeNull()
    expect(screen.getByTestId('project-members-close').textContent).toBe('关闭')
  })

  it('an owner surface reads the roster and the invitation records, read-only', async () => {
    const { harness } = renderMembers({ viewerRole: 'owner' })

    const rows = await screen.findAllByTestId('project-members-roster-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-member-role')).toBe('owner')
    expect(rows[0]!.textContent).toContain('负责人')
    expect(rows[1]!.getAttribute('data-member-role')).toBe('member')
    expect(screen.getByTestId('project-members-roster-count').textContent).toContain('2 位成员')

    const invitations = await screen.findAllByTestId('project-members-invitation-row')
    expect(invitations).toHaveLength(1)
    expect(invitations[0]!.getAttribute('data-invitation-status')).toBe('active')
    expect(invitations[0]!.textContent).toContain('待接受')

    expect(harness.membersCalls).toEqual([{ accountId: 'account-1', productSpaceId: 'space-1' }])
    // Read-only here: role changes live in the enterprise management surface.
    expect(screen.getByTestId('project-members-open-management').textContent).toContain('前往企业管理')
    for (const row of rows) {
      expect(row.querySelectorAll('button')).toHaveLength(0)
    }
  })

  it('compose validates the single target, creates the invitation, and copies the link', async () => {
    const { harness } = renderMembers({ viewerRole: 'owner' })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    expect(screen.getByTestId('project-members-compose')).toBeTruthy()

    // Empty target: local rejection, no request leaves the renderer.
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(screen.getByTestId('project-members-compose').textContent).toContain('请填写手机号或邮箱'))
    expect(harness.inviteCalls).toHaveLength(0)

    // Malformed target: still local.
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: 'abc@@x' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(screen.getByTestId('project-members-compose').textContent).toContain('格式看起来不对'))
    expect(harness.inviteCalls).toHaveLength(0)

    // A valid email creates the invitation and lands on the result step.
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: 'wang@example.com' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(harness.inviteCalls).toHaveLength(1))
    expect(harness.inviteCalls[0]!.command).toMatchObject({ targetEmail: 'wang@example.com' })
    expect((harness.inviteCalls[0]!.command as Record<string, string>).createRequestKey).toMatch(/^pm-invite-/)

    const result = await screen.findByTestId('project-members-invite-result')
    expect(result.getAttribute('data-result')).toBe('created')
    fireEvent.click(screen.getByTestId('project-members-copy-link'))
    await waitFor(() => expect(harness.clipboard).toEqual([INVITE_URL]))
    expect(screen.getByTestId('project-members-copy-link').textContent).toContain('已复制')

    // Back to the roster; the link dies with the step.
    fireEvent.click(screen.getByTestId('project-members-result-back'))
    expect(screen.getByTestId('project-members-manage-surface')).toBeTruthy()
    expect(screen.queryByTestId('project-members-copy-link')).toBeNull()
  })

  it('a non-created outcome reports itself without a link to copy', async () => {
    renderMembers({
      viewerRole: 'owner',
      inviteResponse: {
        result: 'credential_unrecoverable',
        invitation: INVITATION,
      },
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: '13800000000' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)

    expect(await screen.findByTestId('project-members-invite-unrecoverable')).toBeTruthy()
    expect(screen.queryByTestId('project-members-copy-link')).toBeNull()
  })

  it('Escape inside compose closes the STEP, never the dialog', async () => {
    const { onOpenChange } = renderMembers({ viewerRole: 'owner' })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: '13800000000' } })

    fireEvent.keyDown(screen.getByTestId('project-members-dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('project-members-manage-surface')).toBeTruthy())
    expect(screen.queryByTestId('project-members-compose')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('Escape on the result page also closes the STEP (link dies), never the dialog', async () => {
    const { harness, onOpenChange } = renderMembers({ viewerRole: 'owner' })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: '13800000000' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    expect(await screen.findByTestId('project-members-invite-result')).toBeTruthy()

    fireEvent.keyDown(screen.getByTestId('project-members-dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('project-members-manage-surface')).toBeTruthy())
    // The unshared link dies with the step; the dialog itself stays open.
    expect(screen.queryByTestId('project-members-copy-link')).toBeNull()
    expect(harness.clipboard).toHaveLength(0)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('an admin 403 CLEARS the panel and degrades to the member surface, never the cache', async () => {
    renderMembers({ viewerRole: 'owner', membersError: { code: 'forbidden' } })

    const error = await screen.findByTestId('project-members-manage-error')
    expect(error.textContent).toContain('你已不再有此项目的成员权限')
    // The data is gone and the surface is the member one — no roster, no
    // compose entry survives the lost role.
    expect(screen.getByTestId('project-members-member-surface')).toBeTruthy()
    expect(screen.queryByTestId('project-members-roster')).toBeNull()
    expect(screen.queryByTestId('project-members-invitation-row')).toBeNull()
    expect(screen.queryByTestId('project-members-invite-action')).toBeNull()
  })

  // S2-ENG-3 (consensus #6): a LOST response keeps the request key of THIS
  // compose — the user's explicit retry replays the SAME key and the server
  // hands back the still-valid link, which copies as an absolute https URL.
  it('S2-ENG-3: an unresolved failure keeps the request key; the explicit retry replays and brings the link back', async () => {
    const replayed = { result: 'replayed', invitation: INVITATION, invitationUrl: INVITE_URL }
    const { harness } = renderMembers({
      viewerRole: 'owner',
      inviteError: new Error('fixture transport dropped mid-request'),
      inviteResponse: replayed,
    })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: '13800000000' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(harness.inviteCalls).toHaveLength(1))
    // The failure stays in compose with a visible message — no invented
    // result page, no silent resend.
    expect(screen.getByTestId('project-members-compose')).toBeTruthy()
    expect(screen.getByTestId('project-members-compose').textContent).toContain('邀请创建失败')
    const heldKey = (harness.inviteCalls[0]!.command as Record<string, string>).createRequestKey

    // Explicit retry of the SAME target → the SAME key → the replayed
    // result page with the link.
    fireEvent.submit(document.getElementById('project-invite-form')!)
    const result = await screen.findByTestId('project-members-invite-result')
    expect(result.getAttribute('data-result')).toBe('replayed')
    expect((harness.inviteCalls[1]!.command as Record<string, string>).createRequestKey).toBe(heldKey)
    fireEvent.click(screen.getByTestId('project-members-copy-link'))
    await waitFor(() => expect(harness.clipboard).toEqual([INVITE_URL]))
  })

  // X2-9 (consensus #14): a deployment without invitation email delivery
  // composes phone-only — the placeholder says so BEFORE any input, and an
  // email target is rejected locally with zero requests.
  it('X2-9: without email delivery the compose guides phone-only and rejects an email target locally', async () => {
    const { harness } = renderMembers({
      viewerRole: 'owner',
      membersResponse: () => ({ ...ROSTER, emailDeliveryAvailable: false }),
    })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    const placeholder = screen.getByTestId('project-members-invite-target').getAttribute('placeholder') ?? ''
    expect(placeholder).toContain('手机号')

    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: 'wang@example.com' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(screen.getByTestId('project-members-compose').textContent).toContain('邮箱邀请暂时不可用'))
    expect(harness.inviteCalls).toHaveLength(0)
  })

  // X2-7 (consensus #12): a failed FIRST roster page offers an in-place
  // retry; clearing the fault and pressing it recovers the rows.
  it('X2-7: a failed first roster page offers an in-place retry that recovers the rows', async () => {
    // 传引用而非展开拷贝：重试前清除 fault 靠同一对象的 delete 生效。
    const options: Parameters<typeof makeHarness>[0] & { viewerRole?: 'owner' } = {
      viewerRole: 'owner',
      membersError: { code: 'pm_service_unavailable' },
    }
    const { harness } = renderMembers(options)
    const errorRow = await screen.findByTestId('project-members-roster-error')
    expect(errorRow.textContent.length).toBeGreaterThan(0)
    expect(screen.getByTestId('project-members-roster-retry')).toBeTruthy()
    expect(screen.queryByTestId('project-members-roster-row')).toBeNull()

    // The fault clears (fixture-side) — the in-place retry recovers.
    delete options.membersError
    fireEvent.click(screen.getByTestId('project-members-roster-retry'))
    await screen.findAllByTestId('project-members-roster-row')
    expect(harness.membersCalls.length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByTestId('project-members-roster-error')).toBeNull()
  })
})
