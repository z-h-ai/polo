// POO-205 C6 — the EditPopover space gate. In a committed ENTERPRISE space the
// popover edits the personal workspace's config files with organization
// compute, so the trigger is an inert dimmed affordance with a tooltip, the
// popover can never open, and the session-creation entry throws before
// reaching the context callback. In the personal space everything keeps the
// original shape. The jotai atom is mocked as a REAL atom so the test drives
// the same committedSpaceKindAtom write path the app uses.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { atom, getDefaultStore } from 'jotai'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()

// A real atom stands in for the app atom — same type, controlled per test.
const committedSpaceKindAtomMock = atom<'personal' | 'enterprise' | null>(null)
mock.module('@/atoms/tab-browser', () => ({ committedSpaceKindAtom: committedSpaceKindAtomMock }))

// Popover shims: the gate lives in WHICH wrapper wraps the trigger, so the
// shims tag them for querying instead of pulling real Radix.
mock.module('@/components/ui/popover', () => {
  const { createElement } = require('react')
  return {
    Popover: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-testid': 'popover-root' }, children),
    PopoverTrigger: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-testid': 'popover-trigger' }, children),
    PopoverContent: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-testid': 'popover-content' }, children),
  }
})

// The whole barrel is replaced: the real one evaluates a Vite-only pdfjs
// `?url` import that bun test cannot execute. Everything the EditPopover
// import graph names must be present here (Tooltip passthroughs instead of
// real Radix, whose content only mounts on hover).
mock.module('@polo-ai/ui', () => {
  const { createElement } = require('react')
  const passthrough = (testId: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-testid': testId }, children)
  return {
    Markdown: () => createElement('div', { 'data-testid': 'markdown-stub' }),
    Tooltip: passthrough('tooltip-root'),
    TooltipTrigger: passthrough('tooltip-trigger'),
    TooltipContent: passthrough('tooltip-content'),
    usePlatform: () => ({ onOpenFile: null, onOpenUrl: null }),
  }
})

mock.module('motion/react', () => {
  const { createElement } = require('react')
  return {
    motion: { div: (props: Record<string, unknown>) => createElement('div', props) },
    AnimatePresence: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  }
})

mock.module('sonner', () => ({
  toast: { error: () => {}, success: () => {}, loading: () => {} },
}))

const { createElement: reactCreateElement } = require('react')
mock.module('@/components/ui/viewport-portal', () => ({
  ViewportPortal: ({ children }: { children?: ReactNode }) =>
    reactCreateElement('div', { 'data-testid': 'viewport-portal' }, children),
}))

mock.module('@/context/EscapeInterruptContext', () => ({
  useEscapeInterrupt: () => ({ handleEscapePress: () => false }),
}))

mock.module('@/components/app-shell/ChatDisplay', () => ({
  ChatDisplay: () => reactCreateElement('div', { 'data-testid': 'chat-display-stub' }),
}))

// Capture harness: the restore hook hands the test the popover's own
// createPopoverSession callback; the context records whether the trusted
// creation entry was reached.
let capturedCreatePopoverSession: (() => Promise<string>) | null = null
let createEditPopoverSessionCalls = 0
let createEditPopoverSessionImpl: (() => Promise<{ id: string }>) | null = null

mock.module('@/components/ui/useEditPopoverSessionRestore', () => ({
  EditPopoverRestoreUnavailableError: class extends Error {},
  useEditPopoverSessionRestore: (options: { createPopoverSession: () => Promise<string> }) => {
    capturedCreatePopoverSession = options.createPopoverSession
    return { inlineSessionId: null, restoring: false, ensureSessionForSend: options.createPopoverSession }
  },
}))

mock.module('@/context/AppShellContext', () => ({
  useActiveWorkspace: () => ({ id: 'ws-1', name: 'Workspace One', rootPath: '/tmp/ws-1' }),
  useSession: () => null,
  usePendingPermission: () => null,
  usePendingCredential: () => null,
  usePendingQuestion: () => null,
  useAppShellContext: () => ({
    onCreateSession: async () => { throw new Error('not used by EditPopover') },
    onCreateEditPopoverSession: async () => {
      createEditPopoverSessionCalls += 1
      return createEditPopoverSessionImpl
        ? await createEditPopoverSessionImpl()
        : { id: 'popover-session-1' }
    },
    onSendMessage: () => {},
    onRespondToPermission: async () => {},
    onRespondToCredential: async () => {},
    onRespondToQuestion: async () => {},
    onGetEditPopoverPendingQuestion: async () => null,
  }),
}))

const { cleanup, render, screen } = await import('@testing-library/react')
const { EditPopover } = await import('@/components/ui/EditPopover')
const { committedSpaceKindAtom } = await import('@/atoms/tab-browser')

beforeEach(() => {
  cleanup()
  capturedCreatePopoverSession = null
  createEditPopoverSessionCalls = 0
  createEditPopoverSessionImpl = null
  getDefaultStore().set(committedSpaceKindAtom, null)
})

afterEach(() => {
  cleanup()
  getDefaultStore().set(committedSpaceKindAtom, null)
})

function withI18n(node: ReactNode) {
  return createElement(I18nextProvider, { i18n }, node)
}

function renderPopover() {
  render(withI18n(createElement(EditPopover, {
    trigger: createElement('button', { type: 'button' }, 'Edit'),
    context: { label: 'Permission Settings', filePath: '/tmp/ws-1/permissions.json' },
    inlineExecution: true,
  })))
}

describe('EditPopover enterprise gate (POO-205 C6)', () => {
  it('enterprise space: trigger is an inert blocked span with the tooltip, popover never mounts', () => {
    getDefaultStore().set(committedSpaceKindAtom, 'enterprise')
    renderPopover()

    expect(document.querySelector('[data-edit-popover-blocked="enterprise"]')).not.toBeNull()
    // The tooltip carries the readable reason (en locale under the test i18n).
    expect(screen.getByTestId('tooltip-content').textContent).toBe(i18n.t('editPopover.enterpriseUnsupported'))
    expect(screen.getByTestId('tooltip-content').textContent?.length).toBeGreaterThan(0)
    // The popover wrapper is gone — open is forced false and no trigger mounts.
    expect(document.querySelector('[data-testid="popover-trigger"]')).toBeNull()
  })

  it('enterprise space: createPopoverSession rejects before touching the context entry', async () => {
    getDefaultStore().set(committedSpaceKindAtom, 'enterprise')
    renderPopover()

    expect(capturedCreatePopoverSession).not.toBeNull()
    let message = ''
    await capturedCreatePopoverSession!().catch(error => { message = (error as Error).message })
    expect(message).toContain('enterprise')
    expect(createEditPopoverSessionCalls).toBe(0)
  })

  it('personal space: trigger rides the real PopoverTrigger and creation reaches the context entry', async () => {
    getDefaultStore().set(committedSpaceKindAtom, 'personal')
    renderPopover()

    expect(document.querySelector('[data-edit-popover-blocked="enterprise"]')).toBeNull()
    expect(document.querySelector('[data-testid="popover-trigger"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="tooltip-root"]')).toBeNull()

    expect(capturedCreatePopoverSession).not.toBeNull()
    const sessionId = await capturedCreatePopoverSession!()
    expect(sessionId).toBe('popover-session-1')
    expect(createEditPopoverSessionCalls).toBe(1)
  })
})
