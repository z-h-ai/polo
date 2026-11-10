import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  PmAddProjectMembersInputSchema,
  PmListProjectMembersInputSchema,
  PmRemoveProjectMemberInputSchema,
  PmUpdateProjectMemberInputSchema,
} from '@polo-ai/shared/protocol'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'

/**
 * POO-205 project members PANEL (isolated happy-dom render; rewritten from
 * the POO-196 R3 invitation surface — Spec Q10: members ⊆ the organization
 * roster, invitations RETIRED). Proven contracts:
 *
 * - the overview reads `pm:listProjectMembers` (full snapshot, no paging),
 *   renders role badges + 「我」+ the server count;
 * - a plain member sees NO management affordances; a forbidden read is the
 *   real lost-access face (P10);
 * - 添加成员 reads `pm:listOrganizationColleagues`, hides colleagues who are
 *   ALREADY project members, picks ONE batch role and submits ONE
 *   `pm:addProjectMembers` command whose response REPLACES the list;
 * - per-row role change rides `pm:updateProjectMember`, removal is an
 *   explicit confirm step riding `pm:removeProjectMember`, and the wire's
 *   `prj_last_owner` surfaces as the action error instead of a silent no-op.
 */

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
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
const { I18nextProvider } = await import('react-i18next')
const { ProjectMembersPanel } = await import('../ProjectMembersPanel')

const SCOPE = {
  accountId: 'account-a',
  productSpaceId: 'space-org',
  organizationEnterpriseId: 'ent-org',
  projectId: 'pj-1',
}

function member(accountId: string, name: string, role: 'owner' | 'manager' | 'member') {
  return { accountId, displayName: name, role, createdAt: '2026-11-08T00:00:00.000Z' }
}

interface Harness {
  listCalls: Array<Record<string, unknown>>
  addCalls: Array<Record<string, unknown>>
  updateCalls: Array<Record<string, unknown>>
  removeCalls: Array<Record<string, unknown>>
  colleagueCalls: Array<Record<string, unknown>>
  listScript: Array<Record<string, unknown> | Error>
  listResponses: Array<Record<string, unknown>>
  addResponse: Record<string, unknown> | Error
  updateResponse: Record<string, unknown> | Error
  removeResponse: Record<string, unknown> | Error
  removeError: { code: string } | null
}

function makeHarness(options: {
  members?: Array<Record<string, unknown>>
  colleagues?: Array<Record<string, unknown>>
  viewer?: 'owner' | 'member'
} = {}): Harness {
  const harness: Harness = {
    listCalls: [],
    addCalls: [],
    updateCalls: [],
    removeCalls: [],
    colleagueCalls: [],
    listScript: [],
    listResponses: [],
    addResponse: {},
    updateResponse: {},
    removeResponse: {},
    removeError: null,
  }
  const baseMembers = options.members ?? [
    // The acting account's own row is the OWNER — the list is the live
    // authority for the management affordances.
    member(SCOPE.accountId, '李明', 'owner'),
    member('owner-1', '王芳', 'member'),
  ]
  harness.listResponses.push({
    contractVersion: 'poo205-contract-r1',
    projectId: SCOPE.projectId,
    members: baseMembers,
  })
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListProjectMembers: async (input: Record<string, unknown>) => {
        harness.listCalls.push(input)
        // The wire schemas are .strict(): a UI-only key leaking into the
        // scope (the old viewerRoleHint spread) must fail HERE, before the
        // panel can pass against a laxer mock than the real transport.
        PmListProjectMembersInputSchema.parse(input)
        const scripted = harness.listScript.shift()
        if (scripted instanceof Error) throw scripted
        if (scripted) return scripted
        if (harness.listResponses.length > 1) return harness.listResponses.shift()
        return harness.listResponses[0]
      },
      pmListOrganizationColleagues: async (input: Record<string, unknown>) => {
        harness.colleagueCalls.push(input)
        return {
          contractVersion: 'poo205-contract-r1',
          organizationEnterpriseId: SCOPE.organizationEnterpriseId,
          colleagues: options.colleagues ?? [
            { accountId: 'colleague-1', displayName: '赵六', organizationRole: 'member' },
            { accountId: SCOPE.accountId, displayName: '李明', organizationRole: 'member' },
            { accountId: 'owner-1', displayName: '王芳', organizationRole: 'owner' },
          ],
        }
      },
      pmAddProjectMembers: async (input: Record<string, unknown>) => {
        harness.addCalls.push(input)
        PmAddProjectMembersInputSchema.parse(input)
        if (harness.addResponse instanceof Error) throw harness.addResponse
        const command = input.command as { accountIds: string[]; role: string }
        return {
          contractVersion: 'poo205-contract-r1',
          projectId: SCOPE.projectId,
          members: [
            ...(harness.listResponses[0].members as Array<Record<string, unknown>>),
            ...command.accountIds.map(id => member(id, id === 'colleague-1' ? '赵六' : id, command.role as 'member')),
          ],
        }
      },
      pmUpdateProjectMember: async (input: Record<string, unknown>) => {
        harness.updateCalls.push(input)
        PmUpdateProjectMemberInputSchema.parse(input)
        if (harness.updateResponse instanceof Error) throw harness.updateResponse
        return {
          contractVersion: 'poo205-contract-r1',
          member: member(String(input.targetAccountId), '王芳', input.role as 'manager'),
        }
      },
      pmRemoveProjectMember: async (input: Record<string, unknown>) => {
        harness.removeCalls.push(input)
        PmRemoveProjectMemberInputSchema.parse(input)
        if (harness.removeError) throw Object.assign(new Error(harness.removeError.code), { code: harness.removeError.code })
        return { ok: true }
      },
    },
  })
  return harness
}

function fakeRoster(viewerRole: 'owner' | 'manager' | 'member' | null) {
  return {
    scopeKey: 'test',
    query: '',
    members: [],
    allMembers: [],
    totalActiveMembers: null,
    viewerRole,
    enterpriseName: null,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    errorKey: null,
    search: () => {},
    loadMore: () => {},
    retry: () => {},
  }
}

function renderPanel(options: Parameters<typeof makeHarness>[0] & {
  open?: boolean
  viewerRole?: 'owner' | 'manager' | 'member' | null
  harness?: Harness
} = {}) {
  const harness = options.harness ?? makeHarness(options)
  const onClose = mock(() => {})
  const view = render(createElement(I18nextProvider, { i18n }, createElement(ProjectMembersPanel, {
    open: options.open ?? true,
    mode: 'push',
    scope: SCOPE,
    projectName: '华东区资料库',
    roster: fakeRoster(options.viewerRole ?? 'owner'),
    onClose,
  }) as unknown as React.ReactElement) as unknown as React.ReactElement)
  return { harness, onClose, view }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(cleanup)

describe('ProjectMembersPanel (POO-205, Spec Q10)', () => {
  it('overview: the project member list renders role badges, 「我」and the server count; nothing of the retired invitation surface survives', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2))

    expect(screen.getByTestId('project-members-roster-count').textContent).toContain('2')
    const rows = screen.getAllByTestId('project-members-roster-row')
    expect(rows[0]?.getAttribute('data-member-role')).toBe('owner')
    expect(screen.getByTestId('project-members-roster-me').textContent).toBe('我')
    // Management affordances for the owner.
    expect(screen.getByTestId('project-members-invite-action')).toBeTruthy()
    expect(screen.getAllByTestId('project-members-row-manage')).toHaveLength(1) // own row has none
    // The retired invitation surface never reappears.
    expect(screen.queryByTestId('project-members-invitations-entry')).toBeNull()
    expect(screen.queryByTestId('project-members-open-management')).toBeNull()
    expect(document.querySelectorAll('[data-testid="project-members-copy-link"]')).toHaveLength(0)
  })

  it('a plain member sees the same roster with NO management affordances', async () => {
    renderPanel({
      viewerRole: 'member',
      members: [member('owner-1', '王芳', 'owner'), member(SCOPE.accountId, '李明', 'member')],
    })
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2))

    expect(screen.queryByTestId('project-members-invite-action')).toBeNull()
    expect(screen.queryByTestId('project-members-row-manage')).toBeNull()
  })

  it('a forbidden member-list read is the real lost-access face, never a success path', async () => {
    const harness = makeHarness()
    harness.listScript.push(Object.assign(new Error('forbidden'), { code: 'prj_forbidden' }))
    renderPanel({ harness })
    await waitFor(() => expect(screen.getByTestId('project-members-roster-error')).toBeTruthy())

    expect(screen.getByTestId('project-members-roster-error').textContent).toContain('不再有此项目的成员权限')
    expect(screen.queryByTestId('project-members-invite-action')).toBeNull()
  })

  it('添加成员: colleagues load per the org scope, already-members hide, and ONE batch command adds the picked role', async () => {
    const harness = renderPanel()
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2))

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await waitFor(() => expect(screen.getByTestId('project-colleagues-page')).toBeTruthy())
    expect(harness.harness.colleagueCalls[0]).toMatchObject({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      organizationEnterpriseId: SCOPE.organizationEnterpriseId,
    })

    // 王芳/李明 are already project members — only 赵六 is selectable.
    const rows = screen.getAllByTestId('project-colleagues-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-account-id')).toBe('colleague-1')

    fireEvent.click(screen.getByTestId('project-colleagues-row-toggle'))
    expect(screen.getByTestId('project-colleagues-selected').textContent).toContain('1')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))

    await waitFor(() => expect(harness.harness.addCalls).toHaveLength(1))
    expect(harness.harness.addCalls[0]).toEqual({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      organizationEnterpriseId: SCOPE.organizationEnterpriseId,
      projectId: SCOPE.projectId,
      command: { accountIds: ['colleague-1'], role: 'member' },
    })

    // The response IS the fresh list: back on the overview with 3 rows.
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(3))
  })

  it('a rejected add surfaces the wire copy in place and keeps the selection page', async () => {
    const harness = renderPanel()
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2))

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await waitFor(() => expect(screen.getByTestId('project-colleagues-page')).toBeTruthy())
    fireEvent.click(screen.getByTestId('project-colleagues-row-toggle'))

    harness.harness.addResponse = Object.assign(new Error('not in org'), { code: 'prj_member_not_in_organization' })
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))

    expect(await screen.findByTestId('project-colleagues-compose-error')).toBeTruthy()
    expect(screen.getByTestId('project-colleagues-compose-error').textContent).toContain('不是本组织成员')
    // The page stays on the directory (selection preserved for a corrected retry).
    expect(screen.getByTestId('project-colleagues-page')).toBeTruthy()
  })

  it('role change rides pm:updateProjectMember and updates the row from the answer', async () => {
    const harness = renderPanel()
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2))

    fireEvent.click(screen.getAllByTestId('project-members-row-manage')[0]!)
    const menu = await screen.findByTestId('project-members-role-menu')
    expect(menu.getAttribute('data-account-id')).toBe('owner-1')

    fireEvent.click(menu.querySelector('[data-role="manager"]') as HTMLElement)
    await waitFor(() => expect(harness.harness.updateCalls).toHaveLength(1))
    expect(harness.harness.updateCalls[0]).toEqual({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      organizationEnterpriseId: SCOPE.organizationEnterpriseId,
      projectId: SCOPE.projectId,
      targetAccountId: 'owner-1',
      role: 'manager',
    })
    await waitFor(() => {
      const row = screen.getAllByTestId('project-members-roster-row')
        .find(candidate => candidate.getAttribute('data-account-id') === 'owner-1')!
      expect(row.getAttribute('data-member-role')).toBe('manager')
    })
  })

  it('removal is an explicit confirm step riding pm:removeProjectMember; the fresh list re-reads', async () => {
    const harness = renderPanel()
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2))

    fireEvent.click(screen.getAllByTestId('project-members-row-manage')[0]!)
    await screen.findByTestId('project-members-role-menu')
    fireEvent.click(screen.getByTestId('project-members-remove-option'))

    const confirm = await screen.findByTestId('project-members-remove-confirm')
    expect(confirm.textContent).toContain('王芳')

    fireEvent.click(screen.getByTestId('project-members-remove-confirm-action'))
    await waitFor(() => expect(harness.harness.removeCalls).toHaveLength(1))
    expect(harness.harness.removeCalls[0]).toEqual({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      organizationEnterpriseId: SCOPE.organizationEnterpriseId,
      projectId: SCOPE.projectId,
      targetAccountId: 'owner-1',
    })
    // removeProjectMember answers a bare {ok} → the panel re-reads the list.
    await waitFor(() => expect(harness.harness.listCalls).toHaveLength(2))
  })

  it('prj_last_owner surfaces as the action error instead of a silent no-op', async () => {
    const harness = renderPanel()
    await waitFor(() => expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2))

    fireEvent.click(screen.getAllByTestId('project-members-row-manage')[0]!)
    await screen.findByTestId('project-members-role-menu')
    fireEvent.click(screen.getByTestId('project-members-remove-option'))
    await screen.findByTestId('project-members-remove-confirm')

    harness.harness.removeError = { code: 'prj_last_owner' }
    fireEvent.click(screen.getByTestId('project-members-remove-confirm-action'))

    await waitFor(() => expect(screen.getByTestId('project-members-action-error')).toBeTruthy())
    expect(screen.getByTestId('project-members-action-error').textContent).toContain('最后一位负责人')
    // The member stayed: no re-read was needed and none happened beyond the first.
    expect(screen.getAllByTestId('project-members-roster-row')).toHaveLength(2)
  })
})
