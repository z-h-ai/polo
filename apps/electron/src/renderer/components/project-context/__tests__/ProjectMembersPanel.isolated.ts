import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import type {
  ClientColleagueOptionsResponse,
  ClientCollaborationRosterResponse,
  ClientCreateInvitationResponse,
  ClientInvitationEntry,
  ClientMemberRole,
} from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * POO-196 R3 ProjectMembersPanel (adjudication D15 C-UI: the migration
 * target of the retired ProjectMembersDialog.isolated.ts). The valid invite/
 * recovery semantics survive (single-target compose validation, replay-by
 * held-key, path-only link resolution, in-place retry, 403-as-lost-access)
 * on the NEW host: an adaptive push/drawer panel whose overview is the
 * shared roster surface, whose add-member page is a multi-select that sends
 * NOTHING before its confirm, and whose Esc hierarchy walks sub-pages back
 * before ever closing the panel.
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

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ProjectMembersPanel } = await import('../ProjectMembersPanel')
const { useCollaborationRoster } = await import('../useCollaborationRoster')

const INVITE_URL = 'https://admin.example.com/invite/pm-invite-1'
const SCOPE = { accountId: 'account-1', productSpaceId: 'space-1' }

const INVITATION: ClientInvitationEntry = {
  invitationId: 'inv-1',
  status: 'active',
  maskedPhone: '138****0000',
  maskedEmail: null,
  expiresAt: '2026-11-09T00:00:00.000Z',
  createdAt: '2026-11-02T00:00:00.000Z',
  acceptedAt: null,
}

interface RosterMemberFixture {
  userId: string
  displayName: string | null
  role: ClientMemberRole
  isSelf?: boolean
}

function rosterResponse(options: {
  viewerRole?: ClientMemberRole
  totalActiveMembers?: number | null
  members?: RosterMemberFixture[]
  enterpriseName?: string | null
} = {}): ClientCollaborationRosterResponse {
  return {
    productSpaceId: SCOPE.productSpaceId,
    enterpriseName: options.enterpriseName ?? '华东区销售资料库',
    viewerRole: options.viewerRole ?? 'owner',
    totalActiveMembers: options.totalActiveMembers ?? (options.members?.length ?? 2),
    members: (options.members ?? [
      { userId: 'u-1', displayName: '李明', role: 'owner', isSelf: true },
      { userId: 'u-2', displayName: '王芳', role: 'member' },
    ]).map(member => ({ ...member, isSelf: member.isSelf ?? false, avatarUrl: null })),
    nextCursor: null,
  }
}

const COLLEAGUES: ClientColleagueOptionsResponse = {
  sourceState: 'available',
  source: { enterpriseId: 'ent-1', name: '华东区销售资料库' },
  members: [
    { userId: 'c-1', displayName: '赵强', avatarUrl: null, projectState: 'available' },
    { userId: 'c-2', displayName: '钱敏', avatarUrl: null, projectState: 'joined' },
    { userId: 'c-3', displayName: '孙丽', avatarUrl: null, projectState: 'pending' },
    { userId: 'c-4', displayName: '周刚', avatarUrl: null, projectState: 'available' },
  ],
  nextCursor: null,
}

interface Harness {
  rosterCalls: Array<Record<string, unknown>>
  managementRosterCalls: Array<Record<string, unknown>>
  invitationsCalls: Array<Record<string, unknown>>
  targetedInviteCalls: Array<Record<string, unknown>>
  colleagueCalls: Array<Record<string, unknown>>
  colleagueInviteCalls: Array<Record<string, unknown>>
  colleagueQueryCalls: Array<Record<string, unknown>>
  clipboard: string[]
  adminStatusCalls: number
}

function makeHarness(options: {
  roster?: (input: Record<string, unknown>) => ClientCollaborationRosterResponse
  rosterError?: { code: string }
  colleagues?: () => ClientColleagueOptionsResponse
  /** Thrown for the FIRST colleague invite of this userId, answered by
   * `colleagueInviteResponse` afterwards (replay path). */
  colleagueInviteError?: (userId: string) => Error | undefined
  colleagueInviteResponse?: (userId: string) => Record<string, unknown>
  targetedInviteError?: Error
  targetedInviteResponse?: Record<string, unknown>
  adminStatus?: () => Promise<{ adminUrl: string | null }>
} = {}): Harness {
  const harness: Harness = {
    rosterCalls: [],
    managementRosterCalls: [],
    invitationsCalls: [],
    targetedInviteCalls: [],
    colleagueCalls: [],
    colleagueInviteCalls: [],
    colleagueQueryCalls: [],
    clipboard: [],
    adminStatusCalls: 0,
  }
  const pmError = (code: string) => Object.assign(new Error(code), { code })
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListCollaborationRoster: async (input: Record<string, unknown>) => {
        harness.rosterCalls.push(input)
        if (options.rosterError) throw pmError(options.rosterError.code)
        return options.roster ? options.roster(input) : rosterResponse()
      },
      pmListProjectMembers: async (input: Record<string, unknown>) => {
        harness.managementRosterCalls.push(input)
        // The management roster response also carries the deployment's email
        // capability (X2-9 precondition of the secondary compose).
        const viewerRole = options.roster ? options.roster({}).viewerRole : 'owner'
        return {
          productSpaceId: SCOPE.productSpaceId,
          enterpriseName: '华东区销售资料库',
          viewerRole,
          emailDeliveryAvailable: true,
          members: [],
          nextCursor: null,
        }
      },
      pmListProjectInvitations: async (input: Record<string, unknown>) => {
        harness.invitationsCalls.push(input)
        return {
          productSpaceId: SCOPE.productSpaceId,
          viewerRole: 'owner',
          invitations: [INVITATION],
          nextCursor: null,
        }
      },
      pmCreateProjectInvitation: async (input: Record<string, unknown>) => {
        harness.targetedInviteCalls.push(input)
        if (options.targetedInviteError && harness.targetedInviteCalls.length === 1) throw options.targetedInviteError
        if (options.targetedInviteResponse) return options.targetedInviteResponse as ClientCreateInvitationResponse
        return { result: 'created', invitation: INVITATION, invitationUrl: INVITE_URL }
      },
      pmListColleagueOptions: async (input: Record<string, unknown>) => {
        harness.colleagueCalls.push(input)
        return options.colleagues ? options.colleagues() : COLLEAGUES
      },
      pmCreateColleagueInvitation: async (input: Record<string, unknown>) => {
        const command = input.command as { targetUserId: string }
        harness.colleagueInviteCalls.push(input)
        const thrown = options.colleagueInviteError?.(command.targetUserId)
        if (thrown) throw thrown
        if (options.colleagueInviteResponse) return options.colleagueInviteResponse(command.targetUserId)
        return {
          result: 'created',
          invitation: { ...INVITATION, invitationId: `inv-${command.targetUserId}` },
          invitationUrl: INVITE_URL,
        }
      },
      pmQueryColleagueInvitation: async (input: Record<string, unknown>) => {
        harness.colleagueQueryCalls.push(input)
        return { state: 'unknown' }
      },
      ...(options.adminStatus
        ? {
            adminGetStatus: async () => {
              harness.adminStatusCalls += 1
              return options.adminStatus!()
            },
          }
        : {}),
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

interface PanelHostProps {
  open?: boolean
  mode?: 'push' | 'drawer'
  viewerRole?: ClientMemberRole
  onClose: () => void
  onOpenEnterpriseManagement: () => void
}

/** The production wiring shape: the host owns ONE collaboration-roster
 * controller and passes it to the panel (the header entry reads the same). */
function PanelHost(props: PanelHostProps) {
  const roster = useCollaborationRoster(SCOPE)
  const { viewerRole, open = true, mode = 'push', onClose, onOpenEnterpriseManagement } = props
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ProjectMembersPanel, {
      open,
      mode,
      scope: SCOPE,
      projectName: '华东区销售资料库',
      viewerRole: viewerRole ?? 'owner',
      assertedEnterpriseId: 'ent-1',
      roster,
      onClose,
      onOpenEnterpriseManagement,
    }),
  ) as ReactElement
}

async function renderPanel(options: Parameters<typeof makeHarness>[0] & {
  mode?: 'push' | 'drawer'
  viewerRole?: ClientMemberRole
  open?: boolean
} = {}) {
  const harness = makeHarness(options)
  const onClose = mock(() => {})
  const onOpenEnterpriseManagement = mock(() => {})
  const view = render(createElement(PanelHost, {
    open: options.open ?? true,
    mode: options.mode ?? 'push',
    viewerRole: options.viewerRole,
    onClose,
    onOpenEnterpriseManagement,
  }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { harness, onClose, onOpenEnterpriseManagement, ...view }
}

function selectColleague(userId: string) {
  const rows = Array.from(document.querySelectorAll('[data-testid="project-colleagues-row"]'))
  const target = rows.find(row => row.getAttribute('data-user-id') === userId)
  if (!target) throw new Error(`colleague row ${userId} not found`)
  const button = target.querySelector('button')
  if (!button) throw new Error(`colleague row ${userId} has no toggle`)
  fireEvent.click(button)
}

/** Swaps the colleague directory for the no-source body, then forces a
 * reload through the directory search (the hook's scope stays committed). */
async function degradeDirectoryToNoSource() {
  ;(window.electronAPI as unknown as Record<string, unknown>).pmListColleagueOptions = async () => ({
    sourceState: 'none',
    source: null,
    members: [],
    nextCursor: null,
  })
  fireEvent.change(screen.getByTestId('project-colleagues-search'), { target: { value: 'x' } })
  fireEvent.click(await screen.findByTestId('project-members-direct-invite'))
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(cleanup)

describe('ProjectMembersPanel (POO-196 R3 D15 C-UI)', () => {
  it('push host: non-modal panel with the shared roster, server count, 我 marker and ids', async () => {
    const { harness } = await renderPanel({ mode: 'push' })

    const panel = screen.getByTestId('project-members-panel')
    expect(panel.getAttribute('data-mode')).toBe('push')
    // Non-modal: no dialog semantics in push, no backdrop.
    expect(panel.getAttribute('role')).toBeNull()
    expect(screen.queryByTestId('project-members-backdrop')).toBeNull()

    expect(screen.getByTestId('project-members-title').textContent).toContain('华东区销售资料库')
    const rows = await screen.findAllByTestId('project-members-roster-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-user-id')).toBe('u-1')
    expect(rows[0]!.getAttribute('data-member-role')).toBe('owner')
    expect(rows[0]!.textContent).toContain('负责人')
    expect(rows[0]!.textContent).toContain('我')
    // The count is the SERVER's unfiltered total (never the loaded-row count).
    expect(screen.getByTestId('project-members-roster-count').textContent).toContain('2 位成员')
    expect(harness.rosterCalls[0]).toMatchObject({ accountId: 'account-1', productSpaceId: 'space-1' })
  })

  it('drawer host: real modal semantics (role=dialog, aria-modal, backdrop closes)', async () => {
    const { onClose } = await renderPanel({ mode: 'drawer' })

    const panel = screen.getByTestId('project-members-panel')
    expect(panel.getAttribute('data-mode')).toBe('drawer')
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByTestId('project-members-backdrop')).toBeTruthy()
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('roster search passes q through to the server and shows the no-match face', async () => {
    const { harness } = await renderPanel({
      mode: 'push',
      roster: input => input.q
        ? rosterResponse({ totalActiveMembers: 2, members: [] })
        : rosterResponse(),
    })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.change(screen.getByTestId('project-members-search'), { target: { value: '不存在' } })
    await waitFor(() => {
      const last = harness.rosterCalls[harness.rosterCalls.length - 1]!
      expect(last.q).toBe('不存在')
    })
    expect((await screen.findByTestId('project-members-roster-empty')).textContent).toContain('没有匹配的成员')
    // The unknown-total discipline: a filtered page never fabricates a 0.
    expect(screen.getByTestId('project-members-roster-count').textContent).toContain('2 位成员')
  })

  it('a plain member reads the SAME roster with NO management affordances', async () => {
    const { harness } = await renderPanel({
      viewerRole: 'member',
      roster: () => rosterResponse({ viewerRole: 'member' }),
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    const rows = await screen.findAllByTestId('project-members-roster-row')
    expect(rows).toHaveLength(2)
    // No compose, no records, no management handoff — the member surface is
    // the roster itself (D11: 不再期待联系 Owner 提示替代名册).
    expect(screen.queryByTestId('project-members-invite-action')).toBeNull()
    expect(screen.queryByTestId('project-members-open-management')).toBeNull()
    expect(screen.queryByTestId('project-members-invitations-entry')).toBeNull()
    // The management reads never happen for a plain member.
    expect(harness.managementRosterCalls).toHaveLength(0)
    expect(harness.invitationsCalls).toHaveLength(0)
  })

  it('a roster 403 is a lost-access state with retry, never cached rows', async () => {
    await renderPanel({ rosterError: { code: 'forbidden' } })

    const error = await screen.findByTestId('project-members-roster-error')
    expect(error.textContent).toContain('你已不再有此项目的成员权限')
    expect(screen.queryByTestId('project-members-roster-row')).toBeNull()
    // The count falls back to unknown — no fabricated number next to an error.
    expect(screen.queryByTestId('project-members-roster-count')).toBeNull()
    // Lost access removes every management affordance.
    expect(screen.queryByTestId('project-members-invite-action')).toBeNull()
    expect(screen.queryByTestId('project-members-open-management')).toBeNull()
    expect(screen.getByTestId('project-members-roster-retry')).toBeTruthy()
  })

  it('X2-7: a failed first roster page offers an in-place retry that recovers the rows', async () => {
    const options: Parameters<typeof makeHarness>[0] = { rosterError: { code: 'pm_service_unavailable' } }
    const { harness } = await renderPanel(options)
    expect(await screen.findByTestId('project-members-roster-error')).toBeTruthy()
    expect(screen.queryByTestId('project-members-roster-row')).toBeNull()

    delete options.rosterError
    fireEvent.click(screen.getByTestId('project-members-roster-retry'))
    await screen.findAllByTestId('project-members-roster-row')
    expect(harness.rosterCalls.length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByTestId('project-members-roster-error')).toBeNull()
  })

  it('the directory page multi-selects WITHOUT sending: writes happen only on 邀请 N 人', async () => {
    const { harness } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    expect(await screen.findByTestId('project-colleagues-page')).toBeTruthy()
    expect(screen.getByTestId('project-colleagues-page').textContent).toContain('从「华东区销售资料库」选择同事')
    expect(harness.colleagueInviteCalls).toHaveLength(0)

    // joined/pending rows carry their server state and CANNOT be selected.
    const joined = document.querySelector('[data-testid="project-colleagues-row"][data-user-id="c-2"]')
    expect(joined!.textContent).toContain('已加入')
    expect(joined!.querySelector('button')).toBeNull()
    const pending = document.querySelector('[data-testid="project-colleagues-row"][data-user-id="c-3"]')
    expect(pending!.textContent).toContain('待接受邀请')
    expect(pending!.querySelector('button')).toBeNull()

    selectColleague('c-1')
    selectColleague('c-4')
    expect(screen.getByTestId('project-colleagues-selected').textContent).toContain('已选 2 人')
    expect(harness.colleagueInviteCalls).toHaveLength(0)

    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(2))
    const targets = harness.colleagueInviteCalls.map(call => (call.command as Record<string, string>).targetUserId)
    expect(targets).toEqual(['c-1', 'c-4'])
    expect((harness.colleagueInviteCalls[0]!.command as Record<string, string>).sourceEnterpriseId).toBe('ent-1')

    const result = await screen.findByTestId('project-members-invite-result')
    expect(result.getAttribute('data-scope')).toBe('colleagues')
    expect(result.textContent).toContain('已创建邀请，待对方接受')
    expect(result.getAttribute('data-created')).toBe('true')
    const resultRows = result.querySelectorAll('[data-user-id]')
    expect(resultRows.length).toBeGreaterThanOrEqual(2)
  })

  it('a partial colleague failure keeps per-object results and retry re-sends ONLY the failed one', async () => {
    const { harness } = await renderPanel({
      mode: 'push',
      // c-4 hits a DEFINITE failure (already a member) on the first attempt.
      colleagueInviteError: userId => userId === 'c-4'
        ? Object.assign(new Error('target_already_member'), { code: 'target_already_member' })
        : undefined,
    })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    selectColleague('c-1')
    selectColleague('c-4')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    const result = await screen.findByTestId('project-members-invite-result')
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(2))
    // Per-object truth: c-1 created, c-4's definite failure stays visible.
    expect(result.textContent).toContain('对方已是本项目成员')

    fireEvent.click(screen.getByTestId('project-members-result-back'))
    // Back on the select view, the unresolved work stays visible with 仅重试失败项.
    expect(await screen.findByTestId('project-colleagues-retry-failed')).toBeTruthy()
    // The retry now succeeds.
    ;(window.electronAPI as unknown as Record<string, unknown>).pmCreateColleagueInvitation = async (input: Record<string, unknown>) => {
      harness.colleagueInviteCalls.push(input)
      return { result: 'created', invitation: INVITATION, invitationUrl: INVITE_URL }
    }
    fireEvent.click(screen.getByTestId('project-colleagues-retry-failed'))
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(3))
    const retryTargets = harness.colleagueInviteCalls.map(call => (call.command as Record<string, string>).targetUserId)
    // c-1 was settled — it is NEVER re-sent; only the failed c-4 retries.
    expect(retryTargets.filter(target => target === 'c-1')).toHaveLength(1)
    expect(retryTargets.filter(target => target === 'c-4')).toHaveLength(2)
  })

  it('the per-object recovery query resolves an unresolved object via its held key', async () => {
    const { harness } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    selectColleague('c-1')
    // Transport-style loss: the key is KEPT (unresolved, replayable).
    ;(window.electronAPI as unknown as Record<string, unknown>).pmCreateColleagueInvitation = async (input: Record<string, unknown>) => {
      harness.colleagueInviteCalls.push(input)
      throw new Error('fixture transport dropped')
    }
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await screen.findByTestId('project-members-invite-result')
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(1))

    fireEvent.click(screen.getByTestId('project-colleagues-query-result'))
    await waitFor(() => expect(harness.colleagueQueryCalls).toHaveLength(1))
    expect(harness.colleagueQueryCalls[0]!.createRequestKey)
      .toBe((harness.colleagueInviteCalls[0]!.command as Record<string, string>).createRequestKey)
  })

  it('Esc walks sub-pages back to the roster and only the overview Esc closes (never the chat double-Esc)', async () => {
    const { onClose } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')

    // Sub-page Esc: back to overview, panel stays open.
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    fireEvent.keyDown(screen.getByTestId('project-members-panel'), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('project-members-roster')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()

    // Overview Esc: closes the panel — stopped propagation keeps the chat
    // double-Esc interrupt out of the picture (asserted by the prevented
    // default; the host focus return is ChatPage's contract).
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    screen.getByTestId('project-members-panel').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the secondary targeted compose validates, creates, and copies the absolute link', async () => {
    const { harness } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    // The secondary path rides the no-source degradation of this fixture.
    await degradeDirectoryToNoSource()

    expect(screen.getByTestId('project-members-compose')).toBeTruthy()
    // Empty target: local rejection, no request leaves the renderer.
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(screen.getByTestId('project-members-compose').textContent).toContain('请填写手机号或邮箱'))
    expect(harness.targetedInviteCalls).toHaveLength(0)

    // Malformed target: still local.
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: 'abc@@x' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(screen.getByTestId('project-members-compose').textContent).toContain('格式看起来不对'))
    expect(harness.targetedInviteCalls).toHaveLength(0)

    // A valid email creates the invitation and lands on the result step.
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: 'wang@example.com' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(harness.targetedInviteCalls).toHaveLength(1))
    expect(harness.targetedInviteCalls[0]!.command).toMatchObject({ targetEmail: 'wang@example.com' })

    const result = await screen.findByTestId('project-members-invite-result')
    expect(result.getAttribute('data-result')).toBe('created')
    fireEvent.click(screen.getByTestId('project-members-copy-link'))
    await waitFor(() => expect(harness.clipboard).toEqual([INVITE_URL]))
    expect(screen.getByTestId('project-members-copy-link').textContent).toContain('已复制')

    // Back to the roster; the link dies with the step.
    fireEvent.click(screen.getByTestId('project-members-result-back'))
    expect(screen.getByTestId('project-members-roster')).toBeTruthy()
    expect(screen.queryByTestId('project-members-copy-link')).toBeNull()
  })

  it('S2-ENG-3: an unresolved targeted failure keeps the request key; the retry replays it', async () => {
    const replayed = { result: 'replayed', invitation: INVITATION, invitationUrl: INVITE_URL }
    const { harness } = await renderPanel({
      mode: 'push',
      targetedInviteError: new Error('fixture transport dropped mid-request'),
      targetedInviteResponse: replayed,
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    await degradeDirectoryToNoSource()
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: '13800000000' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    await waitFor(() => expect(harness.targetedInviteCalls).toHaveLength(1))
    expect(screen.getByTestId('project-members-compose').textContent).toContain('邀请创建失败')
    const heldKey = (harness.targetedInviteCalls[0]!.command as Record<string, string>).createRequestKey

    fireEvent.submit(document.getElementById('project-invite-form')!)
    const result = await screen.findByTestId('project-members-invite-result')
    expect(result.getAttribute('data-result')).toBe('replayed')
    expect((harness.targetedInviteCalls[1]!.command as Record<string, string>).createRequestKey).toBe(heldKey)
    fireEvent.click(screen.getByTestId('project-members-copy-link'))
    await waitFor(() => expect(harness.clipboard).toEqual([INVITE_URL]))
  })

  it('E2-2: a path-only invitation link copies as the absolute https link under the trusted admin origin', async () => {
    const { harness } = await renderPanel({
      mode: 'push',
      targetedInviteResponse: { result: 'created', invitation: INVITATION, invitationUrl: '/invite/pm-invite-1' },
      adminStatus: async () => ({ adminUrl: 'https://admin.example.com' }),
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    await degradeDirectoryToNoSource()
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: '13800000000' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)
    expect(await screen.findByTestId('project-members-invite-result')).toBeTruthy()

    fireEvent.click(screen.getByTestId('project-members-copy-link'))
    await waitFor(() => expect(harness.clipboard).toEqual(['https://admin.example.com/invite/pm-invite-1']))
    expect(harness.adminStatusCalls).toBe(1)
  })

  it('a non-created targeted outcome reports itself without a link to copy, with the management handoff', async () => {
    const { onOpenEnterpriseManagement } = await renderPanel({
      mode: 'push',
      targetedInviteResponse: { result: 'credential_unrecoverable', invitation: INVITATION },
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    await degradeDirectoryToNoSource()
    fireEvent.change(screen.getByTestId('project-members-invite-target'), { target: { value: '13800000000' } })
    fireEvent.submit(document.getElementById('project-invite-form')!)

    expect(await screen.findByTestId('project-members-invite-unrecoverable')).toBeTruthy()
    expect(screen.queryByTestId('project-members-copy-link')).toBeNull()
    fireEvent.click(screen.getByTestId('project-members-result-management'))
    expect(onOpenEnterpriseManagement).toHaveBeenCalledTimes(1)
  })

  it('the invitation records page lists the targeted invitation history', async () => {
    const { harness } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')

    fireEvent.click(screen.getByTestId('project-members-invitations-entry'))
    const list = await screen.findByTestId('project-members-invitations')
    const rows = list.querySelectorAll('[data-testid="project-members-invitation-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.getAttribute('data-invitation-status')).toBe('active')
    expect(rows[0]!.textContent).toContain('待接受')
    expect(harness.invitationsCalls.length).toBeGreaterThanOrEqual(1)

    // Esc walks the records page back to the roster.
    fireEvent.keyDown(screen.getByTestId('project-members-panel'), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('project-members-roster')).toBeTruthy())
  })

  it('a mode switch keeps the search query and the panel state (no remount, no refetch storm)', async () => {
    const { harness, rerender } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.change(screen.getByTestId('project-members-search'), { target: { value: '王' } })
    await waitFor(() => {
      const last = harness.rosterCalls[harness.rosterCalls.length - 1]!
      expect(last.q).toBe('王')
    })
    const callsAfterSearch = harness.rosterCalls.length

    rerender(createElement(PanelHost, {
      open: true,
      mode: 'drawer',
      onClose: () => {},
      onOpenEnterpriseManagement: () => {},
    }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(screen.getByTestId('project-members-panel').getAttribute('data-mode')).toBe('drawer')
    // The search term survives the switch (D8: 形态切换保留搜索).
    expect((screen.getByTestId('project-members-search') as HTMLInputElement).value).toBe('王')
    expect(harness.rosterCalls.length).toBe(callsAfterSearch)
  })

  it('the drawer traps Tab focus inside the panel', async () => {
    await renderPanel({ mode: 'drawer' })
    await screen.findAllByTestId('project-members-roster-row')

    const panel = screen.getByTestId('project-members-panel')
    const buttons = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled])'))
    const last = buttons[buttons.length - 1]!
    last.focus()
    expect(panel.contains(document.activeElement)).toBe(true)

    // Tab from the LAST focusable wraps to the FIRST — focus never escapes.
    fireEvent.keyDown(panel, { key: 'Tab' })
    expect(panel.contains(document.activeElement)).toBe(true)

    // Shift+Tab from the FIRST focusable wraps to the LAST.
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true })
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('closed renders nothing', async () => {
    await renderPanel({ open: false })
    expect(screen.queryByTestId('project-members-panel')).toBeNull()
  })
})
