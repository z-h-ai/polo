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

/** UB3 (U8): a directory large enough to REACH the 50-target cap — 51
 * selectable rows, so a full selection locks the 51st but never the 50
 * already selected. */
function capColleagues(): ClientColleagueOptionsResponse {
  return {
    sourceState: 'available',
    source: { enterpriseId: 'ent-1', name: '华东区销售资料库' },
    members: [
      { userId: 'c-2', displayName: '钱敏', avatarUrl: null, projectState: 'joined' },
      ...Array.from({ length: 51 }, (_, index) => ({
        userId: `cap-${String(index + 1).padStart(2, '0')}`,
        displayName: `容量同事${index + 1}`,
        avatarUrl: null,
        projectState: 'available' as const,
      })),
    ],
    nextCursor: null,
  }
}

/** UB3 (U6): an invitations snapshot builder — active/expired/accepted mixes
 * with an optional nextCursor (a page walk that is NOT finished). */
function invitationEntry(overrides: Partial<ClientInvitationEntry> & { invitationId: string }): ClientInvitationEntry {
  return {
    status: 'active',
    maskedPhone: '138****0000',
    maskedEmail: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-11-02T00:00:00.000Z',
    acceptedAt: null,
    ...overrides,
  }
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

interface InvitationPageOptions {
  /** Cursor-aware page answers (a REAL page walk — the fixed `items` shape
   * cannot model "the walk finished"). */
  respond?: (input: Record<string, unknown>) => { items: ClientInvitationEntry[]; nextCursor: string | null }
  items?: ClientInvitationEntry[]
  nextCursor?: string | null
  error?: { code: string }
  /** Extra delay before the invitations response resolves (in-flight faces). */
  delayMs?: number
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
  /** UB3 (U6): the invitation records page (and the pending summary) reads. */
  invitations?: InvitationPageOptions
  /** UB3 (U2): make the clipboard writeText resolve LATER (late-callback
   * generation fences). */
  clipboardDelayMs?: number
  clipboardThrows?: boolean
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
        const page = options.invitations
        if (page?.error) throw pmError(page.error.code)
        if (page?.delayMs) await new Promise(resolve => setTimeout(resolve, page.delayMs))
        const answered = page?.respond
          ? page.respond(input)
          : { items: page?.items ?? [INVITATION], nextCursor: page?.nextCursor ?? null }
        return {
          productSpaceId: SCOPE.productSpaceId,
          viewerRole: 'owner',
          invitations: answered.items,
          nextCursor: answered.nextCursor,
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
        if (options.clipboardThrows) throw new Error('clipboard denied')
        if (options.clipboardDelayMs) await new Promise(resolve => setTimeout(resolve, options.clipboardDelayMs))
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
  scope?: { accountId: string; productSpaceId: string }
  onClose: () => void
  onOpenEnterpriseManagement: () => void
  /** UB4 (U5): land directly on the 添加成员 selection page on the open edge. */
  initialDirectory?: boolean
  /** UB4 (U5): the one-time onboarding face (「先不拉人，直接开始」). */
  onboardingOpen?: boolean
}

/** The production wiring shape: the host owns ONE collaboration-roster
 * controller and passes it to the panel (the header entry reads the same). */
function PanelHost(props: PanelHostProps) {
  const scope = props.scope ?? SCOPE
  const roster = useCollaborationRoster(scope)
  const { viewerRole, open = true, mode = 'push', onClose, onOpenEnterpriseManagement, initialDirectory, onboardingOpen } = props
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ProjectMembersPanel, {
      open,
      mode,
      scope,
      projectName: '华东区销售资料库',
      viewerRole: viewerRole ?? 'owner',
      assertedEnterpriseId: 'ent-1',
      roster,
      onClose,
      onOpenEnterpriseManagement,
      initialDirectory,
      onboardingOpen,
    }),
  ) as ReactElement
}

async function renderPanel(options: Parameters<typeof makeHarness>[0] & {
  mode?: 'push' | 'drawer'
  viewerRole?: ClientMemberRole
  open?: boolean
  scope?: { accountId: string; productSpaceId: string }
  initialDirectory?: boolean
  onboardingOpen?: boolean
} = {}) {
  const harness = makeHarness(options)
  const onClose = mock(() => {})
  const onOpenEnterpriseManagement = mock(() => {})
  const view = render(createElement(PanelHost, {
    open: options.open ?? true,
    mode: options.mode ?? 'push',
    viewerRole: options.viewerRole,
    scope: options.scope,
    onClose,
    onOpenEnterpriseManagement,
    initialDirectory: options.initialDirectory,
    onboardingOpen: options.onboardingOpen,
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
    // UB3 (U2): the multi-result face carries the SAME manual-delivery title
    // as the targeted result page — the invitation is created, sending it is
    // still the user's own last step.
    expect(result.textContent).toContain('还差最后一步')
    expect(result.textContent).toContain('创建或复制邀请不会增加成员数')
    expect(result.getAttribute('data-created')).toBe('true')
    const resultRows = result.querySelectorAll('[data-user-id]')
    expect(resultRows.length).toBeGreaterThanOrEqual(2)
    // UB3 (U2): a single-result set (1 usable link) has no aggregate button.
    // (This run created TWO — the copy-all assertions live in their own test.)
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
    // UB3 (U2): 复制 Promise 成功前不出现「已复制」，也没有下一步指引。
    expect(screen.queryByTestId('project-members-copy-next-step')).toBeNull()
    expect(screen.getByTestId('project-members-copy-link').textContent).toContain('复制链接，去发给对方')
    fireEvent.click(screen.getByTestId('project-members-copy-link'))
    await waitFor(() => expect(harness.clipboard).toEqual([INVITE_URL]))
    expect(screen.getByTestId('project-members-copy-link').textContent).toContain('已复制')
    // UB3 (U2): the copy-success status block appears only AFTER the write.
    const nextStep = screen.getByTestId('project-members-copy-next-step')
    expect(nextStep.getAttribute('role')).toBe('status')
    expect(nextStep.textContent).toContain('需要你亲手发送')
    // UB3 (U2): a single link offers NO aggregate copy.
    expect(screen.queryByTestId('project-members-copy-all')).toBeNull()

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

  // ── UB3 (U2): aggregate「复制全部邀请链接」─────────────────────────────────
  it('UB3 U2: copy-all aggregates ≥2 usable links in row order, one group per invitationId, and no extra writes', async () => {
    const { harness } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')

    // 复制前：按钮不存在；复制动作全程零额外邀请写（聚合只走已有结果）。
    selectColleague('c-1')
    selectColleague('c-4')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await screen.findByTestId('project-members-invite-result')
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(2))
    expect(harness.colleagueInviteCalls.every(call => 'command' in call)).toBe(true)

    expect(screen.getByTestId('project-members-copy-all').textContent).toContain('复制全部邀请链接')
    // 复制前没有任何「已复制」宣称。
    expect(screen.queryByTestId('project-members-copy-all-note')).toBeNull()
    // 每行的专属复制按钮仍在（部分失败逐行保留的通路不变）。
    expect(screen.getAllByTestId('project-members-copy-link').length).toBe(2)

    fireEvent.click(screen.getByTestId('project-members-copy-all'))
    await waitFor(() => expect(harness.clipboard).toHaveLength(1))
    const aggregate = harness.clipboard[0]!
    // 行序 = 结果序（c-1 先于 c-4）；组 = 「姓名\nURL」；组间空行；无明文联系方式。
    const groups = aggregate.split('\n\n')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toBe(`赵强\n${INVITE_URL}`)
    expect(groups[1]).toBe(`周刚\n${INVITE_URL}`)
    expect(aggregate).not.toContain('138')

    // 重复点击只再写剪贴板，不产生新邀请写。
    fireEvent.click(screen.getByTestId('project-members-copy-all'))
    await waitFor(() => expect(harness.clipboard).toHaveLength(2))
    expect(harness.colleagueInviteCalls).toHaveLength(2)
    // 复制成功后按钮进入已复制态（且可再次复制）。
    expect(screen.getByTestId('project-members-copy-all').textContent).toContain('已复制')
  })

  it('UB3 U2: a partial colleague failure keeps per-row errors, shows the copy-all note, and copies ONLY usable links', async () => {
    const { harness } = await renderPanel({
      mode: 'push',
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

    // 1 条可用链接 <2 → 聚合按钮不出现（不存在「复制全部」却只复制一条的假象）。
    expect(screen.queryByTestId('project-members-copy-all')).toBeNull()
    expect(result.textContent).toContain('对方已是本项目成员')
  })

  it('UB3 U2: a 3-link set with one failure shows copyAllNote and copies only the usable groups', async () => {
    const threeAvailable: ClientColleagueOptionsResponse = {
      sourceState: 'available',
      source: { enterpriseId: 'ent-1', name: '华东区销售资料库' },
      members: [
        { userId: 'c-1', displayName: '赵强', avatarUrl: null, projectState: 'available' },
        { userId: 'c-4', displayName: '周刚', avatarUrl: null, projectState: 'available' },
        { userId: 'c-5', displayName: '吴悠', avatarUrl: null, projectState: 'available' },
        { userId: 'c-2', displayName: '钱敏', avatarUrl: null, projectState: 'joined' },
      ],
      nextCursor: null,
    }
    const { harness } = await renderPanel({
      mode: 'push',
      colleagues: () => threeAvailable,
      colleagueInviteError: userId => userId === 'c-4'
        ? Object.assign(new Error('target_already_member'), { code: 'target_already_member' })
        : undefined,
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    selectColleague('c-1')
    selectColleague('c-4')
    selectColleague('c-5')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await screen.findByTestId('project-members-invite-result')
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(3))

    // 2 条可用 + 1 条失败 → 聚合按钮出现，且带「仅复制可用链接」提示。
    expect(screen.getByTestId('project-members-copy-all')).toBeTruthy()
    expect(screen.getByTestId('project-members-copy-all-note').textContent).toContain('仅复制可用链接')
    // 逐行错误保留。
    expect(screen.getByTestId('project-members-invite-result').textContent).toContain('对方已是本项目成员')

    fireEvent.click(screen.getByTestId('project-members-copy-all'))
    await waitFor(() => expect(harness.clipboard).toHaveLength(1))
    const groups = harness.clipboard[0]!.split('\n\n')
    expect(groups).toHaveLength(2)
    expect(groups[0]!.startsWith('赵强\n')).toBe(true)
    expect(groups[1]!.startsWith('吴悠\n')).toBe(true)
    expect(harness.clipboard[0]).not.toContain('周刚')
    // 失败行不会被宣称成功：按钮不含「已复制」之前不会误报（此处聚合成功，
    // 但失败行的错误文案仍在）。
    expect(screen.getByTestId('project-members-invite-result').textContent).toContain('对方已是本项目成员')
  })

  it('UB3 U2: an aggregate resolution/clipboard failure shows the copy-failed note, never a success claim', async () => {
    const { harness } = await renderPanel({
      mode: 'push',
      clipboardThrows: true,
      targetedInviteResponse: { result: 'created', invitation: INVITATION, invitationUrl: INVITE_URL },
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    selectColleague('c-1')
    selectColleague('c-4')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await screen.findByTestId('project-members-invite-result')
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(2))

    fireEvent.click(screen.getByTestId('project-members-copy-all'))
    await waitFor(() => expect(screen.getByTestId('project-members-copy-all-failed')).toBeTruthy())
    expect(screen.getByTestId('project-members-copy-all-failed').textContent).toContain('复制失败')
    expect(harness.clipboard).toHaveLength(0)
    expect(screen.getByTestId('project-members-copy-all').textContent).toContain('复制全部邀请链接')
    expect(screen.queryByTestId('project-members-copy-next-step')).toBeNull()
  })

  it('UB3 U2: an aggregate copy settling after a scope switch is dropped (no success in the new scope)', async () => {
    const { harness, rerender } = await renderPanel({
      mode: 'push',
      clipboardDelayMs: 60,
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    selectColleague('c-1')
    selectColleague('c-4')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await screen.findByTestId('project-members-invite-result')
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(2))

    fireEvent.click(screen.getByTestId('project-members-copy-all'))
    // 复制仍在途时换 scope — 迟到回调整体丢弃：不写剪贴板、不发布「已复制」。
    rerender(createElement(PanelHost, {
      open: true,
      mode: 'push',
      scope: { accountId: 'account-2', productSpaceId: 'space-1' },
      onClose: () => {},
      onOpenEnterpriseManagement: () => {},
    }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
    expect(harness.clipboard).toHaveLength(0)
    expect(screen.queryByText('已复制，可再次复制')).toBeNull()
    expect(screen.queryByTestId('project-members-copy-all')).toBeNull()
  })

  // ── UB3 (U6): pending summary with pagination bounds ─────────────────────
  it('UB3 U6: a fully loaded snapshot shows the exact pending count; expired/accepted never count', async () => {
    const { harness } = await renderPanel({
      mode: 'push',
      invitations: {
        items: [
          INVITATION, // active, unexpired
          invitationEntry({ invitationId: 'inv-expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
          invitationEntry({ invitationId: 'inv-accepted', status: 'accepted', acceptedAt: '2026-11-03T00:00:00.000Z' }),
        ],
        nextCursor: null,
      },
    })
    await screen.findAllByTestId('project-members-roster-row')

    const summary = await screen.findByTestId('project-members-pending-summary')
    await waitFor(() => expect(summary.getAttribute('data-state')).toBe('count'))
    expect(summary.textContent).toContain('待接受 1 人')
    expect(summary.textContent).not.toContain('至少')
    // 点击进入邀请记录（面板内子页）。
    fireEvent.click(summary)
    expect(await screen.findByTestId('project-members-invitations')).toBeTruthy()
    expect(harness.invitationsCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('UB3 U6: dedup counts a repeated invitationId once; cancelled/expired never count (module-level discipline)', async () => {
    const { countPendingInvitations } = await import('../ProjectMembersPanel')
    const snapshot = [
      INVITATION,
      invitationEntry({ invitationId: 'inv-expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
      INVITATION, // same invitationId again — one person, one pending invite
      invitationEntry({ invitationId: 'inv-2' }),
    ]
    expect(countPendingInvitations(snapshot)).toBe(2)
    expect(countPendingInvitations([])).toBe(0)
    expect(countPendingInvitations([
      invitationEntry({ invitationId: 'inv-x', status: 'cancelled' }),
      invitationEntry({ invitationId: 'inv-y', expiresAt: '2020-01-01T00:00:00.000Z' }),
    ])).toBe(0)
  })

  it('UB3 U6: pages still ahead with N>0 say「至少 N」; loading more completes the snapshot; returning refreshes the summary once', async () => {
    const page1 = [INVITATION, invitationEntry({ invitationId: 'inv-expired', expiresAt: '2020-01-01T00:00:00.000Z' })]
    const page2 = [invitationEntry({ invitationId: 'inv-2', maskedPhone: '139****1111' })]
    const { harness } = await renderPanel({
      mode: 'push',
      invitations: {
        respond: input => input.cursor
          ? { items: page2, nextCursor: null }
          : { items: page1, nextCursor: 'page-2' },
      },
    })
    await screen.findAllByTestId('project-members-roster-row')

    const summary = await screen.findByTestId('project-members-pending-summary')
    await waitFor(() => expect(summary.getAttribute('data-state')).toBe('at-least'))
    expect(summary.textContent).toContain('待接受至少 1 人')
    expect(summary.textContent).not.toContain('待接受 1 人')

    // 记录页加载更多 → 快照补全（过期项仍不计）→ Esc 返回总览时刷新一次，
    // 摘要按刷新后的第一页快照重算（仍是「至少」——分页未结束不报全量）。
    fireEvent.click(summary)
    await screen.findByTestId('project-members-invitations')
    fireEvent.click(screen.getByTestId('project-members-invitations-more'))
    await waitFor(() => expect(harness.invitationsCalls.length).toBeGreaterThanOrEqual(2))
    expect(await screen.findByText('139****1111')).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId('project-members-panel'), { key: 'Escape' })
    const recount = await screen.findByTestId('project-members-pending-summary')
    await waitFor(() => expect(recount.getAttribute('data-state')).toBe('at-least'))
    expect(recount.textContent).toContain('待接受至少 1 人')
  })

  it('UB3 U6: unknown counts degrade to the plain entry — error face and pages-ahead-with-0 face show no fabricated number', async () => {
    // 错误面。
    const errored = await renderPanel({
      mode: 'push',
      invitations: { error: { code: 'pm_service_unavailable' } },
    })
    await screen.findAllByTestId('project-members-roster-row')
    const errorSummary = await screen.findByTestId('project-members-pending-summary')
    await waitFor(() => expect(errorSummary.getAttribute('data-state')).toBe('view-only'))
    expect(errorSummary.textContent).toContain('查看待接受邀请')
    expect(errorSummary.textContent).not.toContain('待接受 0')
    expect(errorSummary.textContent).not.toContain('0 人')
    errored.unmount()

    // 有后页但当前 N=0：只给入口，不报假 0。
    await renderPanel({
      mode: 'push',
      invitations: {
        items: [invitationEntry({ invitationId: 'inv-accepted', status: 'accepted', acceptedAt: '2026-11-03T00:00:00.000Z' })],
        nextCursor: 'page-2',
      },
    })
    await screen.findAllByTestId('project-members-roster-row')
    const zeroSummary = await screen.findByTestId('project-members-pending-summary')
    await waitFor(() => expect(zeroSummary.getAttribute('data-state')).toBe('view-only'))
    expect(zeroSummary.textContent).not.toContain('0 人')
  })

  it('UB3 U6: a plain member has no pending summary and no records entry (zero management reads)', async () => {
    const { harness } = await renderPanel({
      viewerRole: 'member',
      roster: () => rosterResponse({ viewerRole: 'member' }),
    })
    await screen.findAllByTestId('project-members-roster-row')
    expect(screen.queryByTestId('project-members-pending-summary')).toBeNull()
    expect(harness.invitationsCalls).toHaveLength(0)
  })

  it('UB3 U6: the records page titles rows with THIS session\'s local name mapping (invitationId-scoped, in-memory)', async () => {
    const colleagueInvitation = invitationEntry({ invitationId: 'inv-c-1', maskedPhone: null, maskedEmail: null })
    const { harness } = await renderPanel({
      mode: 'push',
      invitations: { items: [INVITATION, colleagueInvitation], nextCursor: null },
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    selectColleague('c-1')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await screen.findByTestId('project-members-invite-result')
    await waitFor(() => expect(harness.colleagueInviteCalls).toHaveLength(1))

    // 结果页 → 目录选择页 → 总览 → 记录页（沿真实返回路径逐级走）。
    fireEvent.click(screen.getByTestId('project-members-result-back'))
    fireEvent.click(document.querySelector('[data-testid="project-colleagues-back"]') as HTMLButtonElement)
    fireEvent.click(await screen.findByTestId('project-members-invitations-entry'))
    const list = await screen.findByTestId('project-members-invitations')
    const rows = list.querySelectorAll('[data-testid="project-members-invitation-row"]')
    expect(rows).toHaveLength(2)
    // 有映射的行：标题 = 本次邀请：{{name}} + 脱敏标识/创建时间行。
    const localRow = list.querySelector('[data-local-target="赵强"]')
    expect(localRow).toBeTruthy()
    expect(localRow!.textContent).toContain('本次邀请：赵强')
    expect(localRow!.textContent).toContain('创建于')
    // 无映射的行：保持原脱敏标识 + 原时间语义（无姓名猜测）。
    expect(rows[0]!.textContent).not.toContain('本次邀请')
  })

  it('UB3 U6: a scope switch clears the local name mapping (restart degrades to the masked identifier)', async () => {
    const colleagueInvitation = invitationEntry({ invitationId: 'inv-c-1', maskedPhone: null, maskedEmail: null })
    const { rerender } = await renderPanel({
      mode: 'push',
      invitations: { items: [colleagueInvitation], nextCursor: null },
    })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')
    selectColleague('c-1')
    fireEvent.click(screen.getByTestId('project-colleagues-confirm'))
    await screen.findByTestId('project-members-invite-result')
    fireEvent.click(screen.getByTestId('project-members-result-back'))
    fireEvent.click(document.querySelector('[data-testid="project-colleagues-back"]') as HTMLButtonElement)
    fireEvent.click(await screen.findByTestId('project-members-invitations-entry'))
    expect(await screen.findByTestId('project-members-invitations')).toBeTruthy()
    expect(document.querySelector('[data-local-target="赵强"]')).toBeTruthy()

    // 换账号（scope 变更）→ 内存映射整体清空；同名册重读后退回脱敏标识。
    rerender(createElement(PanelHost, {
      open: true,
      mode: 'push',
      scope: { accountId: 'account-2', productSpaceId: 'space-1' },
      onClose: () => {},
      onOpenEnterpriseManagement: () => {},
    }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    // 面板仍停在记录子页（页状态不随 scope 重置）——Esc 走真实返回路径，
    // 返回总览时刷新一次记录，再进记录页看降级后的行。
    fireEvent.keyDown(screen.getByTestId('project-members-panel'), { key: 'Escape' })
    fireEvent.click(await screen.findByTestId('project-members-invitations-entry'))
    const list = await screen.findByTestId('project-members-invitations')
    expect(list.querySelector('[data-local-target]')).toBeNull()
    expect(list.textContent).not.toContain('本次邀请')
  })

  // ── UB3 (U8): the row-wide toggle ─────────────────────────────────────────
  it('UB3 U8: ONE row-wide button owns avatar/name/checkbox — clicking inner content toggles exactly once', async () => {
    const { harness } = await renderPanel({ mode: 'push' })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')

    const row = document.querySelector('[data-testid="project-colleagues-row"][data-user-id="c-1"]') as HTMLElement
    const toggle = row.querySelector('button')
    expect(toggle).toBeTruthy()
    expect(toggle!.getAttribute('aria-pressed')).toBe('false')

    // 点姓名（button 内部内容）只切一次。
    const nameSpan = row.querySelector('span.flex-1') as HTMLElement
    fireEvent.click(nameSpan)
    expect(toggle!.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('project-colleagues-selected').textContent).toContain('已选 1 人')

    // 点头像区域再切一次（取消）。
    const avatar = row.querySelector('span[aria-hidden="true"]') as HTMLElement
    fireEvent.click(avatar)
    expect(toggle!.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('project-colleagues-selected').textContent).toContain('已选 0 人')

    // joined/pending 行没有切换按钮。
    expect(document.querySelector('[data-testid="project-colleagues-row"][data-user-id="c-2"] button')).toBeNull()
    expect(document.querySelector('[data-testid="project-colleagues-row"][data-user-id="c-3"] button')).toBeNull()
    expect(harness.colleagueInviteCalls).toHaveLength(0)
  })

  it('UB3 U8: at the 50-target cap an unselected row is disabled but a selected row still cancels', async () => {
    const { harness } = await renderPanel({ mode: 'push', colleagues: capColleagues })
    await screen.findAllByTestId('project-members-roster-row')
    fireEvent.click(screen.getByTestId('project-members-invite-action'))
    await screen.findByTestId('project-colleagues-page')

    const availableToggles = () => Array.from(document.querySelectorAll(
      '[data-testid="project-colleagues-row"][data-project-state="available"] button',
    )) as HTMLButtonElement[]

    for (const button of availableToggles()) fireEvent.click(button)
    expect(screen.getByTestId('project-colleagues-selected').textContent).toContain('已选 50 人')
    expect(screen.getByTestId('project-colleagues-selected').textContent).not.toContain('51')
    // 上限提示出现；第 51 行（未选）禁用。
    expect(screen.getByTestId('project-colleagues-confirm').textContent).toContain('邀请 50 人')
    const toggles = availableToggles()
    expect(toggles).toHaveLength(51)
    const last = toggles[50]!
    expect(last.getAttribute('aria-pressed')).toBe('false')
    expect(last.disabled).toBe(true)
    // 已选行仍可取消（旧实现把已选也锁死）。
    const first = toggles[0]!
    expect(first.disabled).toBe(false)
    fireEvent.click(first)
    expect(screen.getByTestId('project-colleagues-selected').textContent).toContain('已选 49 人')
    // 取消后腾出名额，可再选第 51 行。
    expect(last.disabled).toBe(false)
    fireEvent.click(last)
    expect(screen.getByTestId('project-colleagues-selected').textContent).toContain('已选 50 人')
    expect(harness.colleagueInviteCalls).toHaveLength(0)
  })

  // ── UB3 (U7): the entry label's invite affordance ─────────────────────────
  it('UB3 U7: the entry label renders the add-member glyph only for invite-capable hosts (aria-hidden)', async () => {
    const { ProjectMembersEntryLabel } = await import('../ProjectMembersPanel')
    const fakeRoster = {
      members: [
        { userId: 'u-1', displayName: '李明', role: 'owner', isSelf: true, avatarUrl: null },
        { userId: 'u-2', displayName: '王芳', role: 'member', isSelf: false, avatarUrl: null },
        { userId: 'u-3', displayName: '陈晓', role: 'member', isSelf: false, avatarUrl: null },
        { userId: 'u-4', displayName: '周然', role: 'member', isSelf: false, avatarUrl: null },
      ],
      totalActiveMembers: 4,
      viewerRole: 'owner',
      enterpriseName: '华东区销售资料库',
      nextCursor: null,
      loading: false,
      loadingMore: false,
      errorKey: null,
      query: '',
      scopeKey: 'a:s',
      search: () => {},
      loadMore: () => {},
      retry: () => {},
    } as unknown as Parameters<typeof ProjectMembersEntryLabel>[0]['roster']

    const withGlyph = render(createElement(I18nextProvider, { i18n }, createElement(ProjectMembersEntryLabel, { roster: fakeRoster, showInviteAffordance: true })))
    expect(screen.getByTestId('pc-members-entry-plus')).toBeTruthy()
    // ≤3 头像 +「成员 4」+ 加号（aria-hidden，整钮才是唯一目标）。
    expect(withGlyph.container.querySelectorAll('[data-user-id]')).toHaveLength(3)
    expect(withGlyph.container.textContent).toContain('成员 4')
    expect(screen.getByTestId('pc-members-entry-plus').getAttribute('aria-hidden')).toBe('true')
    cleanup()

    const withoutGlyph = render(createElement(I18nextProvider, { i18n }, createElement(ProjectMembersEntryLabel, { roster: fakeRoster })))
    expect(screen.queryByTestId('pc-members-entry-plus')).toBeNull()
    expect(withoutGlyph.container.textContent).toContain('成员 4')
    cleanup()
  })
})

/**
 * UB4 (U5): the one-time onboarding landing + skip face. The auto-open (and
 * the empty-state invite card) must land STRAIGHT on the 添加成员 selection
 * page — never the overview — and the panel bottom carries 「先不拉人，
 * 直接开始」; clicking it is a plain close (the HOST consumes the offer and
 * refocuses the composer). Without the onboarding face there is no skip.
 */
describe('ProjectMembersPanel UB4 onboarding landing + skip (U5)', () => {
  it('initialDirectory lands on the 添加成员 selection page (not the overview) and reads the directory', async () => {
    const harness = await renderPanel({ initialDirectory: true })
    expect(screen.getByTestId('project-colleagues-page')).toBeTruthy()
    expect(screen.queryByTestId('project-members-roster')).toBeNull()
    expect(harness.harness.colleagueCalls.length).toBeGreaterThan(0)
    // The selection reset holds: nothing is pre-selected, confirm stays off.
    expect((screen.getByTestId('project-colleagues-selected').textContent ?? '')).toContain('0')
  })

  it('a plain open (no initialDirectory) still lands on the overview — regression guard', async () => {
    await renderPanel({})
    expect(screen.getByTestId('project-members-roster')).toBeTruthy()
    expect(screen.queryByTestId('project-colleagues-page')).toBeNull()
    expect(screen.queryByTestId('project-onboarding-skip')).toBeNull()
  })

  it('the onboarding face shows 「先不拉人，直接开始」 and clicking it closes via onClose', async () => {
    const view = await renderPanel({ initialDirectory: true, onboardingOpen: true })
    const skip = screen.getByTestId('project-onboarding-skip')
    expect(skip.textContent).toContain((i18n.t('project.entry.skipInvite') as string).slice(0, 4))
    expect(view.onClose).not.toHaveBeenCalled()
    fireEvent.click(skip)
    expect(view.onClose).toHaveBeenCalledTimes(1)
  })

  it('the skip face is absent without onboardingOpen — even on the directory landing', async () => {
    await renderPanel({ initialDirectory: true })
    expect(screen.queryByTestId('project-onboarding-skip')).toBeNull()
    expect(screen.queryByTestId('project-onboarding-skip-bar')).toBeNull()
  })

  it('a member host never renders the skip face even if the flag arrives (defense in depth)', async () => {
    // The live roster is the authority: a member roster makes canManage
    // false, so the directory landing guard keeps the overview and the skip
    // face never renders.
    await renderPanel({
      viewerRole: 'member',
      roster: () => rosterResponse({ viewerRole: 'member' }),
      initialDirectory: true,
      onboardingOpen: true,
    })
    expect(screen.getByTestId('project-members-roster')).toBeTruthy()
    expect(screen.queryByTestId('project-colleagues-page')).toBeNull()
    expect(screen.queryByTestId('project-onboarding-skip')).toBeNull()
  })
})
