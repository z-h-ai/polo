/** POO-196 R3 UB2 (adjudication U11): the composer's synchronous send-
 * admission gate. The REAL FreeFormInput is mounted and submitted through
 * its real form path (the same path a Send click / Enter / programmatic
 * craft:submit-input takes): a gate refusal must produce ZERO side effects —
 * no onSubmit, no draft/attachment/reference/KB clears (nothing for
 * ChatDisplay to mark as sent) — while a pass submits and clears exactly
 * once. This is the「拒绝时无真实副作用」proof, not just "the function
 * returned false". */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'

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

// Heavy leaves the composer pulls but this contract does not exercise —
// stubbed at the module boundary exactly like the ChatInputZone harness does.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))
mock.module('@/components/ui/rich-text-input', () => ({
  RichTextInput: (props: { value?: string; onInput?: (e: unknown) => void; className?: string; 'data-testid'?: string; placeholder?: string | string[] }) =>
    createElement('div', {
      'data-testid': props['data-testid'] ?? 'rich-input-stub',
      className: props.className,
      // UB4 (U13): the placeholder that REACHED the input — a single string
      // is the stable project line; `rotating:N` marks the default carousel.
      'data-placeholder': Array.isArray(props.placeholder)
        ? `rotating:${props.placeholder.length}`
        : (props.placeholder ?? ''),
    }, props.value ?? ''),
}))
mock.module('@/components/ServerDirectoryBrowser', () => ({
  ServerDirectoryBrowser: () => null,
}))
mock.module('@/components/app-shell/AttachmentPreview', () => ({
  AttachmentPreview: (props: { attachments?: unknown[] }) =>
    createElement('div', { 'data-testid': 'attachment-preview-stub', 'data-count': String(props.attachments?.length ?? 0) }),
}))
mock.module('@/components/chat/ElementReferenceChips', () => ({
  ElementReferenceChips: () => null,
}))
mock.module('@/components/project-context/ProjectAssetChip', () => ({
  ProjectAssetDraftChips: () => null,
}))
mock.module('@/components/project-context/AssetMentionPopover', () => ({
  AssetMentionPopover: () => null,
  useAssetMention: () => ({
    isOpen: false,
    handleInputChanged: () => false,
    handleKeyDown: () => false,
    choose: () => {},
    close: () => {},
  }),
}))
mock.module('@/components/ui/EditPopover', () => ({
  EditPopover: () => null,
  getEditConfig: () => null,
}))
// The #label menu pulls the themed LabelIcon, whose module graph reaches the
// Vite-only `import.meta.glob` in ThemeContext — stub at the leaf.
mock.module('@/components/ui/label-icon', () => ({
  LabelIcon: () => createElement('span', { 'data-testid': 'label-icon-stub' }),
}))
// EscapeInterrupt is an App-level provider; the composer reads it for the
// ESC-interrupt affordance, irrelevant to the admission contract here.
mock.module('@/context/EscapeInterruptContext', () => ({
  useEscapeInterrupt: () => ({ showEscapeOverlay: false }),
  EscapeInterruptProvider: (props: { children?: React.ReactNode }) => props.children ?? null,
}))
// ToolbarStatusSlot / EditPopover read the AppShell context through the
// REQUIRED accessor; this contract never touches their state, so a minimal
// provider value mirrors the EmptyState harness's narrowed-provider pattern.
mock.module('@/components/app-shell/input/ToolbarStatusSlot', () => ({
  ToolbarStatusSlot: () => null,
}))
// Tooltip surfaces (model context badge etc.) need the Tooltip provider —
// the production shell mounts one; the isolated harness mirrors that.
const { TooltipProvider } = await import('@polo-ai/ui')

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { FreeFormInput } = await import('../FreeFormInput')
const { I18nextProvider } = await import('react-i18next')

const ATTACHMENT = {
  type: 'text' as const,
  path: '/tmp/notes.txt',
  name: 'notes.txt',
  mimeType: 'text/plain',
  text: 'attachment body',
  size: 15,
}
const ELEMENT_REF = { id: 'el-1', url: 'https://example.com', title: 'Example' }
const ASSET_REF = { assetId: 'as-1', version: 3, name: '周报.md' }

interface DraftHandlers {
  inputChanges: string[]
  attachmentChanges: unknown[][]
  elementRefChanges: unknown[][]
  assetRefChanges: unknown[][]
  submissions: Array<{ message: string; attachments?: unknown[]; refs?: unknown[]; assets?: unknown[] }>
  gateCalls: number
}

function harness(gateResult: boolean) : { handlers: DraftHandlers; unmount: () => void } {
  const handlers: DraftHandlers = {
    inputChanges: [],
    attachmentChanges: [],
    elementRefChanges: [],
    assetRefChanges: [],
    submissions: [],
    gateCalls: 0,
  }
  const props = {
    currentModel: '',
    inputValue: '切换期间的重要草稿',
    onInputChange: (value: string) => { handlers.inputChanges.push(value) },
    attachmentsValue: [ATTACHMENT],
    onAttachmentsChange: (attachments: unknown[]) => { handlers.attachmentChanges.push(attachments) },
    elementReferencesValue: [ELEMENT_REF],
    onElementReferencesChange: (refs: unknown[]) => { handlers.elementRefChanges.push(refs) },
    projectAssetRefsValue: [ASSET_REF],
    onProjectAssetRefsChange: (assets: unknown[]) => { handlers.assetRefChanges.push(assets) },
    submitGate: (() => {
      handlers.gateCalls += 1
      return gateResult
    }) as () => boolean,
    onSubmit: (
      message: string,
      attachments?: unknown[],
      _skills?: unknown[],
      _kb?: unknown,
      refs?: unknown[],
      assets?: unknown[],
    ) => {
      handlers.submissions.push({ message, attachments, refs, assets })
    },
  }
  const view = render(createElement(TooltipProvider as unknown as (props: { children?: ReactElement }) => ReactElement, {}, createElement(I18nextProvider as unknown as (props: { i18n: unknown; children?: ReactElement }) => ReactElement, { i18n }, createElement(
    FreeFormInput,
    props as never,
  ))))
  return { handlers, unmount: view.unmount }
}

function submitThroughRealFormPath() {
  const form = document.querySelector('form')
  expect(form).toBeTruthy()
  fireEvent.submit(form!)
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('FreeFormInput submitGate (U11 准入回调)', () => {
  it('a refused submit has ZERO side effects: no onSubmit, no draft clear, no attachment/reference clear, no notice render', () => {
    const { handlers, unmount } = harness(false)
    submitThroughRealFormPath()
    // The gate ran exactly once for this submit…
    expect(handlers.gateCalls).toBe(1)
    // …and NOTHING else happened: no submission, no draft text clear, no
    // attachment clear, no reference clears (ChatDisplay would have marked
    // its follow-up annotations sent if onSubmit had run).
    expect(handlers.submissions.length).toBe(0)
    expect(handlers.inputChanges.includes('')).toBe(false)
    expect(handlers.inputChanges).toEqual([])
    expect(handlers.attachmentChanges).toEqual([])
    expect(handlers.elementRefChanges).toEqual([])
    expect(handlers.assetRefChanges).toEqual([])
    unmount()
  })

  it('a passed gate submits once and clears each draft field exactly once', () => {
    const { handlers, unmount } = harness(true)
    submitThroughRealFormPath()
    expect(handlers.gateCalls).toBe(1)
    expect(handlers.submissions.length).toBe(1)
    expect(handlers.submissions[0]!.message).toBe('切换期间的重要草稿')
    expect(handlers.submissions[0]!.attachments).toEqual([ATTACHMENT])
    expect(handlers.submissions[0]!.refs).toEqual([ELEMENT_REF])
    expect(handlers.submissions[0]!.assets).toEqual([ASSET_REF])
    expect(handlers.inputChanges).toEqual([''])
    // The submit clears each draft field: only EMPTY lists flow out (the
    // attachments mirror effect may double-emit the clear — a clear is a
    // clear), and the original attachment never re-appears.
    expect(handlers.attachmentChanges.length).toBeGreaterThan(0)
    expect(handlers.attachmentChanges.every(list => list.length === 0)).toBe(true)
    expect(handlers.elementRefChanges).toEqual([[]])
    expect(handlers.assetRefChanges).toEqual([[]])
    unmount()
  })

  it('gateNotice renders above the input (project-entry-send-notice) and disappears when cleared', () => {
    const { handlers, unmount } = harness(false)
    const { rerender } = render(createElement(TooltipProvider as unknown as (props: { children?: ReactElement }) => ReactElement, {}, createElement(I18nextProvider as unknown as (props: { i18n: unknown; children?: ReactElement }) => ReactElement, { i18n }, createElement(
      FreeFormInput,
      {
        currentModel: '',
        inputValue: '',
        onInputChange: (value: string) => { handlers.inputChanges.push(value) },
        onSubmit: () => {},
        gateNotice: '正在打开项目，内容还在，请等打开后再发送。',
      } as never,
    ))))
    const notice = screen.getByTestId('project-entry-send-notice')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('正在打开项目')
    // Cleared notice → element gone.
    rerender(createElement(TooltipProvider as unknown as (props: { children?: ReactElement }) => ReactElement, {}, createElement(I18nextProvider as unknown as (props: { i18n: unknown; children?: ReactElement }) => ReactElement, { i18n }, createElement(
      FreeFormInput,
      {
        currentModel: '',
        inputValue: '',
        onInputChange: (value: string) => { handlers.inputChanges.push(value) },
        onSubmit: () => {},
        gateNotice: null,
      } as never,
    ))))
    expect(screen.queryByTestId('project-entry-send-notice')).toBeNull()
    unmount()
  })
})

/**
 * UB4 (U13): the project composer presentation — a STABLE placeholder that
 * follows the REAL sendMessageKey preference (never the rotating shortcut/#
 * hints) and the always-present 「输入帮助」 affordance whose content lists
 * only what this user's platform/preferences truly support; Esc closes and
 * refocuses the composer. Non-project consumers keep the rotating defaults.
 */
describe('FreeFormInput project composer presentation (U13)', () => {
  function renderProject(projectComposer: boolean, inputRef?: unknown) {
    return render(createElement(TooltipProvider as unknown as (props: { children?: ReactElement }) => ReactElement, {}, createElement(I18nextProvider as unknown as (props: { i18n: unknown; children?: ReactElement }) => ReactElement, { i18n }, createElement(
      FreeFormInput,
      {
        currentModel: '',
        inputValue: '',
        onInputChange: () => {},
        onSubmit: () => {},
        projectComposer,
        ...(inputRef ? { inputRef } : {}),
      } as never,
    ))))
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).electronAPI
  })

  it('the project placeholder is ONE stable line for Enter senders — never the rotating defaults', async () => {
    const { unmount } = renderProject(true)
    // Settings load async (defaults to 'enter' before the read lands, and
    // the fixture-less harness keeps the default afterwards).
    await new Promise(resolve => setTimeout(resolve, 20))
    const input = document.querySelector('[data-testid="rich-input-stub"]')!
    expect(input.getAttribute('data-placeholder')).toBe(i18n.t('project.entry.inputPlaceholder'))
    unmount()
  })

  it('the default (non-project) composer still receives the ROTATING defaults', () => {
    const { unmount } = renderProject(false)
    const input = document.querySelector('[data-testid="rich-input-stub"]')!
    expect((input.getAttribute('data-placeholder') ?? '')).toContain('rotating:')
    unmount()
  })

  it('a cmd-enter preference swaps the stable line to 「点击发送」 (the newline key is never the send key)', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getAutoCapitalisation: async () => false,
        getSpellCheck: async () => false,
        getSendMessageKey: async () => 'cmd-enter',
      },
    })
    const { unmount } = renderProject(true)
    const input = document.querySelector('[data-testid="rich-input-stub"]')!
    await new Promise(resolve => setTimeout(resolve, 20))
    await waitFor(() => {
      expect(input.getAttribute('data-placeholder')).toBe(i18n.t('project.entry.inputPlaceholderClick'))
    }, { timeout: 2000 })
    unmount()
  })

  it('the 「输入帮助」 icon opens real-capability rows; Esc closes and refocuses the composer', () => {
    const focusCalls: number[] = []
    const inputRef = { current: { focus: () => { focusCalls.push(1) } } }
    const { unmount } = renderProject(true, inputRef)
    const help = screen.getByTestId('project-composer-help')
    expect(help.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(help)
    expect(help.getAttribute('aria-expanded')).toBe('true')
    const content = screen.getByTestId('project-composer-help-content')
    const rows = content.textContent ?? ''
    // Send line follows the (default enter) preference; newline + the
    // desktop shortcut rows are the REAL existing keys.
    expect(rows).toContain((i18n.t('project.entry.inputPlaceholder') as string).slice(0, 4))
    expect(rows).toContain((i18n.t('chatInput.placeholder.newLine') as string).slice(0, 4))
    expect(rows).toContain((i18n.t('chatInput.placeholder.shiftTab') as string).slice(0, 4))
    expect(rows).toContain((i18n.t('chatInput.placeholder.mention') as string).slice(0, 3))
    expect(rows).toContain((i18n.t('chatInput.placeholder.labels') as string).slice(0, 3))
    // Esc closes (document capture listener) and hands focus back.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('project-composer-help-content')).toBeNull()
    expect(help.getAttribute('aria-expanded')).toBe('false')
    expect(focusCalls.length).toBe(1)
    unmount()
  })
})
