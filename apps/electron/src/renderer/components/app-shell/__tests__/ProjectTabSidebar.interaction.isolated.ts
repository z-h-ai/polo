import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { PmUpdateProjectInputSchema } from '@polo-ai/shared/protocol'
import { encodeRpcErrorCodeInMessage } from '../../../../shared/rpc-error-bridge'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { SidebarItem } from '../LeftSidebar'

/**
 * POO-205 C8 (R7/R8), trimmed by POO-208 — the ENTERPRISE project tab's
 * sidebar identity and its settings dialog, isolated happy-dom render.
 * Proven contracts:
 *
 * - the sidebar TRIM is the whitelist {allSessions, labels}; sources / skills
 *   / automations / assistant settings (workspace-global rows) never survive
 *   it, and the gate answers FALSE for a personal space on a project tab —
 *   the personal sidebar is untouched (the反例);
 * - the header carries the project identity (name + one-line purpose) and the
 *   settings gear — and NO「新建会话」button (POO-207: the navigator header
 *   owns new-session);
 * - POO-208: NO members entry — the chat header is the single members home;
 *   the sidebar hosts no members PANEL;
 * - the settings dialog: per-field length counters, a success toast, PATCH
 *   semantics (only changed fields travel), pm wire codes surfaced through
 *   the shared mapping — and a MEMBER sees the READ-ONLY face with the full
 *   instructions instead of an editing form.
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

const SCOPE = {
  accountId: 'account-a',
  productSpaceId: 'space-org',
  organizationEnterpriseId: 'ent-org',
  projectId: 'pj-1',
}

const INSTRUCTIONS_TEXT = '回答一律用中文；引用资料时给出处。'

function activeProject(overrides: Record<string, unknown> = {}) {
  return {
    accountId: SCOPE.accountId,
    organizationProductSpaceId: SCOPE.productSpaceId,
    organizationEnterpriseId: SCOPE.organizationEnterpriseId,
    projectId: SCOPE.projectId,
    name: '华东区资料库',
    purpose: '区域销售资料与口径',
    instructions: INSTRUCTIONS_TEXT,
    myRole: 'owner' as const,
    ...overrides,
  }
}

function member(accountId: string, name: string, role: 'owner' | 'manager' | 'member') {
  return { accountId, displayName: name, role, createdAt: '2026-11-08T00:00:00.000Z' }
}

interface Harness {
  listCalls: Array<Record<string, unknown>>
  updateCalls: Array<Record<string, unknown>>
  listMembers: Array<Record<string, unknown>>
  updateResponse: Record<string, unknown> | Error
}

function makeHarness(options: { members?: Array<Record<string, unknown>> } = {}): Harness {
  const harness: Harness = {
    listCalls: [],
    updateCalls: [],
    listMembers: options.members ?? [
      member(SCOPE.accountId, '李明', 'owner'),
      member('owner-1', '王芳', 'member'),
    ],
    updateResponse: {},
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListProjectMembers: async (input: Record<string, unknown>) => {
        harness.listCalls.push(input)
        return {
          contractVersion: 'poo205-contract-r1',
          projectId: SCOPE.projectId,
          members: harness.listMembers,
        }
      },
      pmUpdateProject: async (input: Record<string, unknown>) => {
        harness.updateCalls.push(input)
        PmUpdateProjectInputSchema.parse(input)
        if (harness.updateResponse instanceof Error) throw harness.updateResponse
        return harness.updateResponse
      },
    },
  })
  return harness
}

// The settings view reads the committed space for the pm scope; the sidebar
// itself never does. A minimal enterprise value matches the fixture scope.
mock.module('@/context/ProductSpaceContext', () => ({
  useProductSpaceContext: () => ({
    accountId: SCOPE.accountId,
    activeProductSpace: { id: SCOPE.productSpaceId, kind: 'enterprise', enterpriseId: SCOPE.organizationEnterpriseId, name: 'Ent' },
  }),
}))

const toastSuccessCalls: Array<unknown[]> = []
mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => { void args },
    success: (...args: unknown[]) => { toastSuccessCalls.push(args) },
  },
}))

async function renderSidebar(props: Record<string, unknown> = {}, options: { members?: Array<Record<string, unknown>> } = {}) {
  const harness = makeHarness(options)
  const { ProjectTabSidebar } = await import('../ProjectTabSidebar')
  const onProjectSaved = mock(() => {})
  const view = render(createElement(I18nextProvider, { i18n }, createElement(ProjectTabSidebar, {
    project: activeProject(),
    onProjectSaved,
    ...props,
  })))
  return { harness, onProjectSaved, view }
}

beforeEach(async () => {
  toastSuccessCalls.length = 0
  await i18n.changeLanguage('zh-Hans')
})
afterEach(cleanup)

// =============================================================================
// Part A — the pure gate + whitelist trim
// =============================================================================

describe('projectTabSidebarItems (C8 R7 whitelist trim)', () => {
  it('keeps ONLY the conversation filters; every workspace-global row is retired', async () => {
    const { projectTabSidebarItems } = await import('../ProjectTabSidebar')
    const { isSeparatorItem } = await import('../LeftSidebar')
    const items = [
      { id: 'nav:allSessions', title: '全部会话', icon: null, variant: 'ghost' },
      { id: 'nav:labels', title: '标签', icon: null, variant: 'ghost' },
      { id: 'separator:chats-sources', type: 'separator' },
      { id: 'nav:sources', title: '数据源', icon: null, variant: 'ghost' },
      { id: 'nav:skills', title: '技能', icon: null, variant: 'ghost' },
      { id: 'nav:automations', title: '自动化', icon: null, variant: 'ghost' },
      { id: 'nav:settings', title: '设置', icon: null, variant: 'ghost' },
    ] as unknown as SidebarItem[]
    const kept = projectTabSidebarItems(items).filter(item => !isSeparatorItem(item))
    expect(kept.map(item => item.id)).toEqual(['nav:allSessions', 'nav:labels'])
    const ids = new Set(projectTabSidebarItems(items).map(item => isSeparatorItem(item) ? '' : item.id))
    for (const retired of ['nav:sources', 'nav:skills', 'nav:automations', 'nav:settings', 'separator:chats-sources']) {
      expect(ids.has(retired)).toBe(false)
    }
  })

  it('the gate: an enterprise PROJECT tab is the project layout; a personal space on the same tab is NOT (反例)', async () => {
    const { isEnterpriseProjectTabLayout } = await import('../ProjectTabSidebar')
    const projectTab = { type: 'project' }
    expect(isEnterpriseProjectTabLayout('enterprise', projectTab)).toBe(true)
    // The personal space keeps the unified sidebar even on a project-shaped
    // tab — the trim must never fire there.
    expect(isEnterpriseProjectTabLayout('personal', projectTab)).toBe(false)
    // A committed-space gap (pre-hydration) fails open to the personal layout.
    expect(isEnterpriseProjectTabLayout(null, projectTab)).toBe(false)
    // Other tabs keep the workspace rows in an enterprise space too.
    expect(isEnterpriseProjectTabLayout('enterprise', { type: 'polo' })).toBe(false)
    expect(isEnterpriseProjectTabLayout('enterprise', { type: 'home' })).toBe(false)
    expect(isEnterpriseProjectTabLayout('enterprise', null)).toBe(false)
  })
})

// =============================================================================
// Part B — the header render
// =============================================================================

describe('ProjectTabSidebar header (C8 R7, POO-208 trim)', () => {
  it('carries the project identity and the gear — no「新建会话」, no members entry', async () => {
    const { harness } = await renderSidebar()
    await waitFor(() => expect(screen.getByTestId('project-tab-name').textContent).toBe('华东区资料库'))
    expect(screen.getByTestId('project-tab-purpose').textContent).toBe('区域销售资料与口径')
    // POO-208: the sidebar lost its members row — the chat header is the
    // single members entry. No row, no hosted PANEL.
    expect(screen.queryByTestId('project-tab-members-entry')).toBeNull()
    expect(screen.queryByTestId('project-members-panel')).toBeNull()
    expect(screen.getByTestId('project-tab-settings').getAttribute('aria-label')).toBe('项目设置')
    // POO-207: the duplicate is gone — the navigator (session list) header
    // has owned new-session since POO-202.
    expect(screen.queryByTestId('project-tab-new-session')).toBeNull()
    // The workspace-global rows are not part of this header at all.
    expect(screen.queryByTestId('nav:sources')).toBeNull()
    expect(screen.queryByTestId('nav:skills')).toBeNull()
    expect(screen.queryByTestId('nav:automations')).toBeNull()
    expect(screen.queryByTestId('nav:settings')).toBeNull()
    // The roster hook still speaks: the settings dialog reads the SERVER
    // count through it (2 members read from the wire).
    await waitFor(() => expect(harness.listCalls).toHaveLength(1))
  })

  it('a project without a purpose renders the name alone (no empty purpose line)', async () => {
    await renderSidebar({ project: activeProject({ purpose: undefined }) })
    await waitFor(() => expect(screen.getByTestId('project-tab-name').textContent).toBe('华东区资料库'))
    expect(screen.queryByTestId('project-tab-purpose')).toBeNull()
  })
})

// =============================================================================
// Part C — the settings dialog (C8 R8)
// =============================================================================

describe('ProjectTabSidebar settings dialog (C8 R8)', () => {
  it('owner: the editing form with length counters; a save PATCHes only the changed field, toasts and hands the fresh project back', async () => {
    const fresh = {
      contractVersion: 'poo205-contract-r1',
      project: {
        id: SCOPE.projectId,
        organizationEnterpriseId: SCOPE.organizationEnterpriseId,
        organizationProductSpaceId: SCOPE.productSpaceId,
        name: '华东区主资料库',
        purpose: '区域销售资料与口径',
        instructions: INSTRUCTIONS_TEXT,
        createdByAccountId: SCOPE.accountId,
        createdAt: '2026-11-08T00:00:00.000Z',
        updatedAt: '2026-11-09T00:00:00.000Z',
        myRole: 'owner',
        memberCount: 2,
      },
    }
    const { harness, onProjectSaved } = await renderSidebar()
    harness.updateResponse = fresh
    fireEvent.click(await screen.findByTestId('project-tab-settings'))
    await waitFor(() => expect(screen.getByTestId('project-settings-view')).toBeTruthy())

    // Length counters use the CONTRACT constants (256 / 2000 / 8192).
    expect(screen.getByTestId('project-settings-name-count').textContent).toBe('6/256')
    expect(screen.getByTestId('project-settings-purpose-count').textContent).toBe('9/2000')
    expect(screen.getByTestId('project-settings-instructions-count').textContent).toBe(`${INSTRUCTIONS_TEXT.length}/8192`)

    const nameInput = screen.getByTestId('project-settings-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '华东区主资料库' } })
    expect(screen.getByTestId('project-settings-name-count').textContent).toBe('7/256')

    fireEvent.click(screen.getByTestId('project-settings-save'))
    await waitFor(() => expect(harness.updateCalls).toHaveLength(1))
    // PATCH semantics: only the CHANGED field travels; purpose/instructions
    // stay absent (untouched), and the wire input is .strict() — a stray key
    // would have thrown in the harness.
    const sent = harness.updateCalls[0]!
    expect((sent as { command: Record<string, unknown> }).command).toEqual({ name: '华东区主资料库' })
    // The success toast fired, the dialog closed and the host got the fresh
    // identity (which re-publishes the bus for the header).
    expect(toastSuccessCalls).toHaveLength(1)
    expect(onProjectSaved).toHaveBeenCalledTimes(1)
    expect((onProjectSaved.mock.calls[0] as unknown[])[0]).toMatchObject({ name: '华东区主资料库' })
    await waitFor(() => expect(screen.queryByTestId('project-settings-view')).toBeNull())
  })

  it('member: the READ-ONLY face shows the full instructions and offers no save', async () => {
    await renderSidebar({}, {
      members: [
        member(SCOPE.accountId, '李小明', 'member'),
        member('owner-1', '王芳', 'owner'),
      ],
    })
    fireEvent.click(await screen.findByTestId('project-tab-settings'))
    await waitFor(() => expect(screen.getByTestId('project-settings-readonly')).toBeTruthy())
    // The advisory names the authority…
    expect(screen.getByTestId('project-settings-readonly-hint').textContent).toContain('负责人或管理员')
    // …but the content is ALL there — the instructions in full.
    expect(screen.getByTestId('project-settings-readonly-instructions').textContent).toContain(INSTRUCTIONS_TEXT)
    expect(screen.getByTestId('project-settings-readonly-name').textContent).toContain('华东区资料库')
    expect(screen.queryByTestId('project-settings-save')).toBeNull()
    expect(screen.queryByTestId('project-settings-name')).toBeNull()
  })

  it('a prj_forbidden save answer surfaces through the shared pm mapping, not a raw code', async () => {
    const { harness } = await renderSidebar()
    // The context-bridge carriage: the code rides the message marker (E2-5),
    // exactly as the real transport delivers it.
    harness.updateResponse = new Error(encodeRpcErrorCodeInMessage('prj_forbidden', 'forbidden'))
    fireEvent.click(await screen.findByTestId('project-tab-settings'))
    await waitFor(() => expect(screen.getByTestId('project-settings-view')).toBeTruthy())
    const nameInput = screen.getByTestId('project-settings-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '改名' } })
    fireEvent.click(screen.getByTestId('project-settings-save'))
    const error = await screen.findByTestId('project-settings-error')
    expect(error.textContent).not.toContain('prj_forbidden')
    expect(error.textContent).toContain('没有权限')
    expect(toastSuccessCalls).toHaveLength(0)
  })
})
