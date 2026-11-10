import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'

/**
 * POO-196 R3 (adjudication D15 C-UI, D14; UB2 U11): the project conversation
 * empty state. Entering a project with no history is ZERO-WRITE — the session
 * row is created only by the user's FIRST explicit send through the trusted
 * onCreateSession→onSendMessage path, and only after the created session's
 * committed scope re-matches this project. A failed create keeps the state
 * and never rebuilds a session behind the user's back; the members entry
 * here is the SAME panel host ChatPage uses.
 *
 * UB2 (U11): the composer's send is now gated by the SHARED entry
 * transaction state (atoms/project-entry) — a send while an entry is in
 * flight is refused INSIDE the composer (no session creation, no draft
 * clear), records one contentless notice marker, and the persistent notice
 * above the composer walks through 等待 → 落地请发送 guidance. The marker is
 * consumed by the accepted first send.
 */

// The FreeFormInput stand-in mirrors the REAL composer contract this test
// exercises: the submit path runs props.submitGate() FIRST and only then
// hands off to onSubmit; gateNotice renders as the persistent notice above
// the input; typing flows through props.onInputChange.
// UB4 (U5/U13): the stand-in also exposes the composer handle (focus spy —
// the onboarding panel close must refocus the input) and the projectComposer
// presentation flag so the host wiring is observable.
let composerFocusCalls = 0
mock.module('@/components/app-shell/input/FreeFormInput', () => ({
  FreeFormInput: (props: {
    onSubmit?: (message: string) => void
    inputValue?: string
    onInputChange?: (value: string) => void
    submitGate?: () => boolean
    gateNotice?: string | null
    inputRef?: { current: unknown }
    projectComposer?: boolean
    placeholder?: string
  }) => {
    // Populate the handle the way the real RichTextInput would.
    if (props.inputRef && typeof props.inputRef === 'object') {
      ;(props.inputRef as { current: unknown }).current = {
        focus: () => { composerFocusCalls += 1 },
      }
    }
    return createElement('div', { 'data-testid': 'empty-state-composer', 'data-project-composer': String(Boolean(props.projectComposer)) },
      props.gateNotice
        ? createElement('div', { 'data-testid': 'project-entry-send-notice', role: 'status' }, props.gateNotice)
        : null,
      createElement('button', {
        type: 'button',
        'data-testid': 'empty-state-type',
        onClick: () => props.onInputChange?.('拦截前的原始草稿'),
      }),
      createElement('button', {
        type: 'button',
        'data-testid': 'empty-state-send',
        'data-value': props.inputValue ?? '',
        onClick: () => {
          if (props.submitGate && !props.submitGate()) return
          props.onSubmit?.('hello project')
        },
      }),
    )
  },
}))

// Not exercised here (they mount only on 文件/Pin tab flips) and their module
// graphs pull Vite-only assets — keep the harness lean and bun-safe.
// UB4 (U5): the stand-in mirrors the REAL library's one-shot upload signal
// contract — the dialog "opens" (marker) exactly when the signal is raised,
// and the consumption ack resets the request so a remount cannot re-open.
let libraryUploadOpens = 0
mock.module('@/components/project-context/ProjectFileLibrary', () => ({
  ProjectFileLibrary: (props: { uploadSignal?: number; onUploadSignalConsumed?: () => void }) => {
    if (props.uploadSignal && props.uploadSignal > 0) {
      libraryUploadOpens += 1
      props.onUploadSignalConsumed?.()
    }
    return createElement('div', {
      'data-testid': 'pc-library',
      'data-upload-signal': String(props.uploadSignal ?? 0),
    })
  },
}))
mock.module('@/components/project-context/ProjectPinPane', () => ({
  ProjectPinPane: () => null,
}))
// Same substitution the panel isolated test applies: style tokens only.
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

// Routing is observed, not executed, in this harness.
const navigatedTo: string[] = []
mock.module('@/lib/navigate', () => ({
  routes: { view: { allSessions: (id: string) => `session:${id}` } },
  navigate: (route: string) => {
    navigatedTo.push(route)
  },
}))

GlobalRegistrator.register()
setupI18n()

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { AppShellProvider } = await import('@/context/AppShellContext')
const { ProjectConversationEmptyState } = await import('../ProjectConversationEmptyState')
const { setActiveProject } = await import('@/components/projects/projects-bus')
const atoms = await import('@/atoms/project-entry')
const { projectEntryAtom, projectEntrySendNoticesAtom, projectOnboardingIntentAtom, emptyDraftKey, PROJECT_ENTRY_IDLE } = atoms
type ProjectEntryState = import('@/atoms/project-entry').ProjectEntryState
type ProjectOnboardingIntent = import('@/atoms/project-entry').ProjectOnboardingIntent

const SCOPE = {
  accountId: 'account-1',
  workspaceId: 'ws-1',
  productSpaceId: 'space-1',
  projectName: '华东区销售资料库',
  viewerRole: 'owner' as const,
  enterpriseId: 'ent-1',
}

/** POO-205: the surface binds to the ENTERED project — the active-project
 * bus, stamped to this account + committed org space. */
const ACTIVE_PROJECT = {
  accountId: SCOPE.accountId,
  organizationProductSpaceId: SCOPE.productSpaceId,
  organizationEnterpriseId: SCOPE.enterpriseId,
  projectId: 'pj-1',
  name: SCOPE.projectName,
  myRole: SCOPE.viewerRole,
}

const jotaiStore = getDefaultStore()

function setEntryState(state: ProjectEntryState) {
  jotaiStore.set(projectEntryAtom, state)
}

interface EmptyStateHarness {
  createCalls: number
  sendCalls: number
}

/** Installs the pm transport stubs and hands back the per-test counters the
 * test's own context closure increments. POO-205 contract: the roster reads
 * the PROJECT members (pm:listProjectMembers); the 添加成员 page reads the
 * ORGANIZATION roster (pm:listOrganizationColleagues) — no invitations. */
function makeHarness(options: { viewerRole?: 'owner' | 'manager' | 'member' } = {}): EmptyStateHarness {
  const calls: EmptyStateHarness = { createCalls: 0, sendCalls: 0 }
  const viewerRole = options.viewerRole ?? SCOPE.viewerRole
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListProjectMembers: async () => ({
        contractVersion: 'poo205-contract-r1',
        projectId: ACTIVE_PROJECT.projectId,
        members: [
          { accountId: SCOPE.accountId, displayName: '李明', role: viewerRole, createdAt: '2026-11-08T00:00:00.000Z' },
        ],
      }),
      // UB4 (U5): the 添加成员 selection page read (the auto-open and the
      // invite card both land here — reads only, never a member write).
      pmListOrganizationColleagues: async () => ({
        contractVersion: 'poo205-contract-r1',
        organizationEnterpriseId: SCOPE.enterpriseId,
        colleagues: [
          { accountId: 'c-1', displayName: '赵强', organizationRole: 'member' },
          { accountId: 'c-2', displayName: '钱敏', organizationRole: 'member' },
        ],
      }),
      pcSearchAssets: async () => [],
    },
  })
  return calls
}

/** The provider narrowed to the slice this harness supplies; the full
 * AppShellContextType graph is exactly what these tests must NOT need. */
const Provider = AppShellProvider as unknown as (
  props: { children?: ReactElement; value?: unknown },
) => ReactElement

function renderEmptyState(contextValue: Record<string, unknown>) {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(Provider, { value: contextValue }, createElement(
      ProjectConversationEmptyState,
      { ...SCOPE },
    )),
  ))
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
  navigatedTo.length = 0
  composerFocusCalls = 0
  libraryUploadOpens = 0
  setActiveProject(ACTIVE_PROJECT)
  setEntryState(PROJECT_ENTRY_IDLE)
  jotaiStore.set(projectEntrySendNoticesAtom, [])
  jotaiStore.set(projectOnboardingIntentAtom, null)
})

afterEach(() => {
  setActiveProject(null)
  cleanup()
})

describe('ProjectConversationEmptyState (POO-196 R3 D14/D15)', () => {
  it('entering renders the real conversation layout with ZERO session creation', () => {
    makeHarness()
    const contextValue = {
      onCreateSession: async () => ({ id: 'x' }),
      onSendMessage: () => {},
      filePreview: null,
      filePreviewVisible: false,
    }
    renderEmptyState(contextValue)

    expect(screen.getByTestId('project-entry-empty')).toBeTruthy()
    expect(screen.getByTestId('pc-tabs')).toBeTruthy()
    // The members entry lives in the header (P9) — the same host as ChatPage.
    expect(screen.getByTestId('pc-members-button')).toBeTruthy()
    expect(screen.getByTestId('empty-state-send')).toBeTruthy()
  })

  it('the FIRST explicit send creates exactly one session and delivers the message through the trusted path', async () => {
    const calls = makeHarness()
    const contextValue = {
      onCreateSession: async () => {
        calls.createCalls += 1
        return { id: 'session-1', productSpaceId: SCOPE.productSpaceId, accountId: SCOPE.accountId, projectId: ACTIVE_PROJECT.projectId }
      },
      onSendMessage: () => {
        calls.sendCalls += 1
      },
      filePreview: null,
      filePreviewVisible: false,
    }
    renderEmptyState(contextValue)

    expect(calls.createCalls).toBe(0)
    fireEvent.click(screen.getByTestId('empty-state-send'))
    await waitFor(() => expect(calls.createCalls).toBe(1))
    expect(navigatedTo).toEqual(['session:session-1'])
    // The deep-link handoff delay lets the panel mount before the send.
    await waitFor(() => expect(calls.sendCalls).toBe(1), { timeout: 2000 })
  })

  it('a failed create sends NOTHING and the next send retries the create (never fabricates a session)', async () => {
    const calls = makeHarness()
    const contextValue = {
      onCreateSession: async () => {
        calls.createCalls += 1
        throw new Error('fixture create failed')
      },
      onSendMessage: () => {
        calls.sendCalls += 1
      },
      filePreview: null,
      filePreviewVisible: false,
    }
    renderEmptyState(contextValue)

    fireEvent.click(screen.getByTestId('empty-state-send'))
    await waitFor(() => expect(calls.createCalls).toBe(1))
    expect(navigatedTo).toEqual([])
    expect(calls.sendCalls).toBe(0)

    // The user retries; the second attempt is a NEW create (no phantom row).
    fireEvent.click(screen.getByTestId('empty-state-send'))
    await waitFor(() => expect(calls.createCalls).toBe(2))
    expect(calls.sendCalls).toBe(0)
  })

  it('a session whose committed scope does not match this project is never sent into', async () => {
    const calls = makeHarness()
    const contextValue = {
      onCreateSession: async () => {
        calls.createCalls += 1
        return { id: 'session-2', productSpaceId: 'space-OTHER', accountId: SCOPE.accountId, projectId: ACTIVE_PROJECT.projectId }
      },
      onSendMessage: () => {
        calls.sendCalls += 1
      },
      filePreview: null,
      filePreviewVisible: false,
    }
    renderEmptyState(contextValue)

    fireEvent.click(screen.getByTestId('empty-state-send'))
    await waitFor(() => expect(calls.createCalls).toBe(1))
    // The scope fence refuses the send even though the create "succeeded".
    await waitFor(() => expect(screen.getByTestId('project-entry-empty')).toBeTruthy())
    expect(navigatedTo).toEqual([])
    expect(calls.sendCalls).toBe(0)
  })
})

/**
 * UB2 (U11): the entry-in-flight composer gate over the SHARED state.
 */
describe('ProjectConversationEmptyState 发送准入 (U11)', () => {
  const switching: ProjectEntryState = {
    accountId: SCOPE.accountId,
    productSpaceId: SCOPE.productSpaceId,
    generation: 5,
    phase: 'switching',
    origin: 'home',
  }

  it('a send while an entry is in flight is refused with ZERO side effects and the draft is kept byte for byte', async () => {
    const calls = makeHarness()
    const contextValue = {
      onCreateSession: async () => {
        calls.createCalls += 1
        return { id: 'session-3', productSpaceId: SCOPE.productSpaceId, accountId: SCOPE.accountId, projectId: ACTIVE_PROJECT.projectId }
      },
      onSendMessage: () => {
        calls.sendCalls += 1
      },
      filePreview: null,
      filePreviewVisible: false,
    }
    setEntryState(switching)
    renderEmptyState(contextValue)

    // The waiting-time notice is persistent above the composer.
    const notice = screen.getByTestId('project-entry-send-notice')
    expect(notice.textContent).toContain((i18n.t('project.entry.sendBlocked') as string).slice(0, 6))

    fireEvent.click(screen.getByTestId('empty-state-type'))

    // The blocked attempt: gate refuses INSIDE the composer — no create, no
    // send, no navigation, and the draft text is untouched (the blocked
    // send re-renders through the notice-marker state, so data-value now
    // reflects the retained draft — a clear would surface here as '').
    fireEvent.click(screen.getByTestId('empty-state-send'))
    await waitFor(() => expect(jotaiStore.get(projectEntrySendNoticesAtom).length).toBe(1))
    expect(calls.createCalls).toBe(0)
    expect(calls.sendCalls).toBe(0)
    expect(navigatedTo).toEqual([])
    expect(screen.getByTestId('empty-state-send').getAttribute('data-value')).toBe('拦截前的原始草稿')

    // The marker carries scope identity + generation, never message content.
    // POO-205 C3: the empty-state draft scope is per-PROJECT (the entered
    // active project rides the key).
    const marker = jotaiStore.get(projectEntrySendNoticesAtom)[0]!
    expect(marker).toEqual({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      draftKey: emptyDraftKey(SCOPE.accountId, SCOPE.productSpaceId, ACTIVE_PROJECT.projectId),
      generation: 5,
    })
  })

  it('after the project lands (ready) the notice flips to 请点击发送 and the accepted send consumes the marker exactly once', async () => {
    const calls = makeHarness()
    const contextValue = {
      onCreateSession: async () => {
        calls.createCalls += 1
        return { id: 'session-4', productSpaceId: SCOPE.productSpaceId, accountId: SCOPE.accountId, projectId: ACTIVE_PROJECT.projectId }
      },
      onSendMessage: () => {
        calls.sendCalls += 1
      },
      filePreview: null,
      filePreviewVisible: false,
    }
    setEntryState(switching)
    renderEmptyState(contextValue)
    fireEvent.click(screen.getByTestId('empty-state-type'))
    fireEvent.click(screen.getByTestId('empty-state-send'))
    await waitFor(() => expect(jotaiStore.get(projectEntrySendNoticesAtom).length).toBe(1))
    expect(calls.createCalls).toBe(0)

    // The entry lands: ready, same scope, same generation → guidance flips.
    setEntryState({ ...switching, phase: 'ready' })
    await waitFor(() => {
      const notice = screen.getByTestId('project-entry-send-notice')
      expect(notice.textContent).toContain((i18n.t('project.entry.sendReady') as string).slice(0, 5))
    })

    // The user's ONE explicit send now goes through: exactly one create and
    // one send, and the marker is consumed.
    fireEvent.click(screen.getByTestId('empty-state-send'))
    await waitFor(() => expect(calls.createCalls).toBe(1))
    await waitFor(() => expect(calls.sendCalls).toBe(1))
    expect(navigatedTo).toEqual(['session:session-4'])
    await waitFor(() => expect(jotaiStore.get(projectEntrySendNoticesAtom)).toEqual([]))
    expect(calls.createCalls).toBe(1)
    expect(calls.sendCalls).toBe(1)
  })

  it('a landed ready state WITHOUT a recorded block shows no stale guidance', () => {
    makeHarness()
    const contextValue = {
      onCreateSession: async () => ({ id: 'x' }),
      onSendMessage: () => {},
      filePreview: null,
      filePreviewVisible: false,
    }
    setEntryState({ ...switching, phase: 'ready', generation: 5 })
    renderEmptyState(contextValue)
    expect(screen.queryByTestId('project-entry-send-notice')).toBeNull()
  })
})

/**
 * UB4 (U5): the empty-state three action cards + the one-time onboarding
 * auto-open. Cards are presentation-only (0 create / 0 send / 0 invite
 * write); the invite card lands on the EXISTING 添加成员 selection page; the
 * upload card switches to the files tab and raises the one-shot signal into
 * the EXISTING upload dialog wiring; the start card only focuses the
 * composer. The recorded intent is consumed by THIS host exactly once —
 * skip closes, consumes and refocuses the composer; a member host never
 * sees the invite card, the invite sentence or the auto-open.
 */
describe('ProjectConversationEmptyState UB4 三动作卡 + 一次性拉人 (U5)', () => {
  const ready: ProjectEntryState = {
    accountId: SCOPE.accountId,
    productSpaceId: SCOPE.productSpaceId,
    generation: 7,
    phase: 'ready',
    origin: 'create',
  }

  it('an inviting viewer sees the three action cards and the invite sentence; every card click keeps 0 create / 0 send / 0 invite write', async () => {
    const calls = makeHarness()
    const contextValue = {
      onCreateSession: async () => {
        calls.createCalls += 1
        return { id: 'x' }
      },
      onSendMessage: () => { calls.sendCalls += 1 },
      filePreview: null,
      filePreviewVisible: false,
    }
    renderEmptyState(contextValue)

    expect(screen.getByTestId('project-entry-action-invite')).toBeTruthy()
    expect(screen.getByTestId('project-entry-action-upload')).toBeTruthy()
    expect(screen.getByTestId('project-entry-action-start')).toBeTruthy()
    // The honest capability copy: assistant scope first, invite sentence for
    // those who may actually invite.
    const hint = screen.getByTestId('project-entry-empty-hint')
    expect(hint.textContent).toContain((i18n.t('project.entry.emptyHint') as string).slice(0, 6))
    expect(hint.textContent).toContain((i18n.t('project.entry.inviteHint') as string).slice(0, 4))
    // The composer carries the project presentation flag (U13 threading).
    expect(screen.getByTestId('empty-state-composer').getAttribute('data-project-composer')).toBe('true')

    // POO-205: the live add-members authority is the PROJECT member list —
    // wait for the roster to speak before exercising the authority-gated
    // directory landing.
    await waitFor(() => expect(screen.getByTestId('pc-members-button').textContent).toContain('成员 1'))

    // Invite card → the members panel opens straight on the 添加成员
    // selection page (never the overview), and NOTHING writes.
    fireEvent.click(screen.getByTestId('project-entry-action-invite'))
    await waitFor(() => expect(screen.getByTestId('project-colleagues-page')).toBeTruthy())
    expect(screen.queryByTestId('project-members-roster')).toBeNull()
    expect(calls.createCalls).toBe(0)
    expect(calls.sendCalls).toBe(0)
    expect(navigatedTo).toEqual([])
    // Close the panel again (backdrop-less push close button).
    fireEvent.click(screen.getByTestId('project-members-close'))
    await waitFor(() => expect(screen.queryByTestId('project-colleagues-page')).toBeNull())

    // Upload card → files tab surface + the one-shot signal (consumed once).
    fireEvent.click(screen.getByTestId('project-entry-action-upload'))
    await waitFor(() => expect(screen.getByTestId('pc-library')).toBeTruthy())
    expect(libraryUploadOpens).toBe(1)
    expect(screen.getByTestId('pc-library').getAttribute('data-upload-signal')).toBe('0')

    // Start card → composer focus ONLY.
    fireEvent.click(screen.getByTestId('project-entry-action-start'))
    expect(composerFocusCalls).toBe(1)

    // All three clicks together: still zero session creation and zero sends.
    expect(calls.createCalls).toBe(0)
    expect(calls.sendCalls).toBe(0)
  })

  it('a member host renders NO invite card, NO invite sentence and NO upload fabrication path change', () => {
    makeHarness({ viewerRole: 'member' })
    const contextValue = {
      onCreateSession: async () => ({ id: 'x' }),
      onSendMessage: () => {},
      filePreview: null,
      filePreviewVisible: false,
    }
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(Provider, { value: contextValue }, createElement(
        ProjectConversationEmptyState,
        { ...SCOPE, viewerRole: 'member' as const },
      )),
    ))
    expect(screen.queryByTestId('project-entry-action-invite')).toBeNull()
    expect(screen.getByTestId('project-entry-action-upload')).toBeTruthy()
    expect(screen.getByTestId('project-entry-action-start')).toBeTruthy()
    const hint = screen.getByTestId('project-entry-empty-hint')
    expect(hint.textContent).not.toContain((i18n.t('project.entry.inviteHint') as string).slice(0, 4))
  })

  it('the recorded one-time intent auto-opens the 添加成员 page exactly once; skip consumes it and refocuses the composer', async () => {
    const calls = makeHarness()
    const contextValue = {
      onCreateSession: async () => {
        calls.createCalls += 1
        return { id: 'x' }
      },
      onSendMessage: () => { calls.sendCalls += 1 },
      filePreview: null,
      filePreviewVisible: false,
    }
    setEntryState(ready)
    const intent: ProjectOnboardingIntent = {
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      generation: 7,
    }
    jotaiStore.set(projectOnboardingIntentAtom, intent)
    const view = renderEmptyState(contextValue)

    // Auto-open lands directly on the selection page + the skip face.
    await waitFor(() => expect(screen.getByTestId('project-colleagues-page')).toBeTruthy())
    expect(screen.getByTestId('project-onboarding-skip')).toBeTruthy()
    expect(jotaiStore.get(projectOnboardingIntentAtom)).toBeNull()
    // Opening invited nobody, created nothing, sent nothing.
    expect(calls.createCalls).toBe(0)
    expect(calls.sendCalls).toBe(0)

    // Skip = close + consume + composer focus.
    fireEvent.click(screen.getByTestId('project-onboarding-skip'))
    await waitFor(() => expect(screen.queryByTestId('project-colleagues-page')).toBeNull())
    expect(composerFocusCalls).toBe(1)

    // A re-render (resize/return equivalent) never resurrects the offer.
    view.rerender(createElement(
      I18nextProvider,
      { i18n },
      createElement(Provider, { value: contextValue }, createElement(
        ProjectConversationEmptyState,
        { ...SCOPE },
      )),
    ))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(screen.queryByTestId('project-colleagues-page')).toBeNull()
    expect(composerFocusCalls).toBe(1)
  })

  it('an entry still in flight does NOT consume the intent — only U3 ready does', async () => {
    makeHarness()
    const contextValue = {
      onCreateSession: async () => ({ id: 'x' }),
      onSendMessage: () => {},
      filePreview: null,
      filePreviewVisible: false,
    }
    setEntryState({ ...ready, phase: 'switching' })
    jotaiStore.set(projectOnboardingIntentAtom, {
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      generation: 7,
    })
    renderEmptyState(contextValue)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(screen.queryByTestId('project-colleagues-page')).toBeNull()
    expect(jotaiStore.get(projectOnboardingIntentAtom)).not.toBeNull()
  })

  it('an intent for ANOTHER project never opens this host', async () => {
    makeHarness()
    const contextValue = {
      onCreateSession: async () => ({ id: 'x' }),
      onSendMessage: () => {},
      filePreview: null,
      filePreviewVisible: false,
    }
    setEntryState({ ...ready, productSpaceId: 'space-OTHER' })
    jotaiStore.set(projectOnboardingIntentAtom, {
      accountId: SCOPE.accountId,
      productSpaceId: 'space-OTHER',
      generation: 9,
    })
    renderEmptyState(contextValue)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(screen.queryByTestId('project-colleagues-page')).toBeNull()
    expect(screen.queryByTestId('project-onboarding-skip')).toBeNull()
  })

  it('a member host never auto-opens even with intent + ready entry', async () => {
    makeHarness({ viewerRole: 'member' })
    const contextValue = {
      onCreateSession: async () => ({ id: 'x' }),
      onSendMessage: () => {},
      filePreview: null,
      filePreviewVisible: false,
    }
    setEntryState(ready)
    jotaiStore.set(projectOnboardingIntentAtom, {
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      generation: 7,
    })
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(Provider, { value: contextValue }, createElement(
        ProjectConversationEmptyState,
        { ...SCOPE, viewerRole: 'member' as const },
      )),
    ))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(screen.queryByTestId('project-colleagues-page')).toBeNull()
    expect(screen.queryByTestId('project-onboarding-skip')).toBeNull()
  })
})
