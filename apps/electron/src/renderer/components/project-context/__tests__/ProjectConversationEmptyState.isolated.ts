import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'

/**
 * POO-196 R3 (adjudication D15 C-UI, D14): the project conversation empty
 * state. Entering a project with no history is ZERO-WRITE — the session row
 * is created only by the user's FIRST explicit send through the trusted
 * onCreateSession→onSendMessage path, and only after the created session's
 * committed scope re-matches this project. A failed create keeps the state
 * and never rebuilds a session behind the user's back; the members entry
 * here is the SAME panel host ChatPage uses (the retired centered dialog is
 * gone from this surface too).
 */

// The real FreeFormInput pulls the whole composer stack; the empty-state
// contract under test is the SEND PATH, not the composer chrome.
mock.module('@/components/app-shell/input/FreeFormInput', () => ({
  FreeFormInput: (props: { onSubmit?: (message: string) => void; inputValue?: string }) =>
    createElement('button', {
      type: 'button',
      'data-testid': 'empty-state-send',
      'data-value': props.inputValue ?? '',
      onClick: () => props.onSubmit?.('hello project'),
    }),
}))

// Not exercised here (they mount only on 文件/Pin tab flips) and their module
// graphs pull Vite-only assets — keep the harness lean and bun-safe.
mock.module('@/components/project-context/ProjectFileLibrary', () => ({
  ProjectFileLibrary: () => null,
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

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { AppShellProvider } = await import('@/context/AppShellContext')
const { ProjectConversationEmptyState } = await import('../ProjectConversationEmptyState')

const SCOPE = {
  accountId: 'account-1',
  workspaceId: 'ws-1',
  productSpaceId: 'space-1',
  projectName: '华东区销售资料库',
  viewerRole: 'owner' as const,
  enterpriseId: 'ent-1',
}

interface EmptyStateHarness {
  createCalls: number
  sendCalls: number
}

/** Installs the pm transport stubs and hands back the per-test counters the
 * test's own context closure increments. */
function makeHarness(): EmptyStateHarness {
  const calls: EmptyStateHarness = { createCalls: 0, sendCalls: 0 }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListCollaborationRoster: async () => ({
        productSpaceId: SCOPE.productSpaceId,
        enterpriseName: SCOPE.projectName,
        viewerRole: SCOPE.viewerRole,
        totalActiveMembers: 1,
        members: [
          { userId: 'u-1', displayName: '李明', avatarUrl: null, role: 'owner', isSelf: true },
        ],
        nextCursor: null,
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
})

afterEach(cleanup)

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
        return { id: 'session-1', productSpaceId: SCOPE.productSpaceId, accountId: SCOPE.accountId }
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
        return { id: 'session-2', productSpaceId: 'space-OTHER', accountId: SCOPE.accountId }
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
