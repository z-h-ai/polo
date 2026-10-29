/** Real ChatDisplay scroll controller; layout/IPC and heavy leaf views are
 * replaced at their boundaries. Run alone to keep module mocks isolated. */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import React, { createElement as h } from 'react'
import type { Session } from '../../../../shared/types'

GlobalRegistrator.register()
const { render, fireEvent, cleanup, act } = await import('@testing-library/react')
const noop = () => {}
let focused = true
let recapReveal = noop
let anchorPadding = 0
const observers = new Set<ResizeObserverStub>()
class ResizeObserverStub {
  constructor(public callback: () => void) { observers.add(this) }
  observe() {}
  unobserve() {}
  disconnect() { observers.delete(this) }
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
const scrollIntoView = mock(function(this: HTMLElement) {
  const viewport = this.closest('[data-testid="viewport"]') as HTMLElement | null
  if (viewport) {
    // scrollIntoView ends at the anchor, before the column's bottom padding.
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - anchorPadding
    viewport.dispatchEvent(new Event('scroll'))
  }
})
HTMLElement.prototype.scrollIntoView = scrollIntoView
window.electronAPI = {
  getSendMessageKey: async () => 'enter',
  readPreferences: async () => ({ content: '{}' }),
} as unknown as typeof window.electronAPI
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/context/AppShellContext', () => ({ useAppShellContext: () => ({ isFocusedPanel: focused }) }))
mock.module('@/context/ProductSpaceContext', () => ({ useOptionalProductSpaceContext: () => null }))
mock.module('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: noop }) }))
mock.module('@/hooks/keyboard', () => ({ useFocusZone: () => ({ zoneRef: { current: null }, isFocused: false }) }))
mock.module('@/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
mock.module('@/hooks/useBackgroundTasks', () => ({ useBackgroundTasks: () => ({ tasks: [], killTask: noop }) }))
mock.module('@/hooks/useTurnCardExpansion', () => ({ useTurnCardExpansion: () => ({ expandedTurns: new Set(), toggleTurn: noop, expandedActivityGroups: {}, setExpandedActivityGroups: noop }) }))
mock.module('@/hooks/useUserMessageRecap', () => ({ useUserMessageRecap: () => ({ visible: true, reveal: () => recapReveal() }) }))
mock.module('@/components/ui/scroll-area', () => ({ ScrollArea: ({ viewportRef, children }: any) => h('div', { ref: viewportRef, 'data-testid': 'viewport' }, h('div', null, children)) }))
mock.module('@/components/app-shell/input', () => ({ ChatInputZone: (props: any) => h('textarea', { 'data-testid': 'composer', onChange: props.inputProps?.onInputChange, 'data-submit': '', onKeyDown: (e: any) => { if (e.key === 'Enter') props.inputProps.onSubmit('sent') } }) }))
mock.module('@/components/markdown', () => ({ Markdown: () => null, StreamingMarkdown: () => null, CollapsibleMarkdownProvider: ({ children }: any) => children }))
mock.module('@/components/chat/AuthRequestCard', () => ({ MemoizedAuthRequestCard: () => null }))
mock.module('@/components/chat/KbReferenceChips', () => ({ KbReferenceChips: () => null }))
mock.module('@/components/chat/ElementReferenceChips', () => ({ ElementReferenceChips: () => null }))
mock.module('motion/react', () => ({
  AnimatePresence: ({ children }: any) => children,
  motion: {
    div: React.forwardRef(({ children, initial, animate, exit, transition, ...props }: any, ref: any) => h('div', { ...props, ref }, children)),
    span: ({ children }: any) => h('span', null, children),
  },
}))
const turnUtils = await import('../../../../../../../packages/ui/src/components/chat/turn-utils')
const layout = await import('../../../../../../../packages/ui/src/lib/layout')
mock.module('@polo-ai/ui', () => ({
  ...turnUtils,
  ...layout,
  TurnCard: ({ response }: any) => h('div', null, response?.text ?? 'assistant'),
  UserMessageBubble: ({ content }: any) => h('div', null, content),
  asRecord: (v: any) => v && typeof v === 'object' ? v : undefined,
  Spinner: noop, parseReadResult: noop, parseBashResult: noop, parseGrepResult: noop,
  parseGlobResult: noop, extractOverlayData: noop, extractOverlayCards: noop,
  ActivityCardsOverlay: noop, CodePreviewOverlay: noop, MultiDiffPreviewOverlay: noop,
  TerminalPreviewOverlay: noop, GenericOverlay: noop, JSONPreviewOverlay: noop,
  DocumentFormattedMarkdownOverlay: noop, detectLanguage: noop,
  getAnnotationNoteText: noop, isAnnotationFollowUpSent: noop,
  extractAnnotationSelectedText: noop, normalizeFollowUpText: noop,
}))

const { ChatDisplay } = await import('../ChatDisplay')
const baseSession = (id = 'a', count = 6): Session => ({
  id, workspaceId: 'ws', workspaceName: 'Test workspace', name: id, lastMessageAt: 1, isProcessing: false,
  messages: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, timestamp: index, role: index % 2 ? 'assistant' : 'user', content: `message ${index}` })),
})
const props = (session: Session | null) => ({ session, onSendMessage: noop, onOpenFile: noop, onOpenUrl: noop, currentModel: 'model' })
async function mount(session: Session | null = baseSession()) {
  let result!: ReturnType<typeof render>
  await act(async () => { result = render(h(ChatDisplay, props(session))) })
  const viewport = () => result.getByTestId('viewport') as HTMLElement
  const geometry = (top = 600, total = 1000, height = 400) => {
    Object.defineProperties(viewport(), { scrollHeight: { value: total, configurable: true }, clientHeight: { value: height, configurable: true } })
    viewport().scrollTop = top
    fireEvent.scroll(viewport())
  }
  const jump = () => result.queryByRole('button', { name: 'chat.jumpToLatest' })
  return { ...result, viewport, geometry, jump }
}
const tick = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
afterEach(() => { cleanup(); focused = true; recapReveal = noop; anchorPadding = 0; scrollIntoView.mockClear() })

describe('POO-170 jump to latest', () => {
  it('appears only beyond the existing 20px threshold; short and bottom views stay quiet', async () => {
    const view = await mount()
    view.geometry(0, 200, 400); expect(view.jump()).toBeNull()
    view.geometry(581); expect(view.jump()).toBeNull()
    view.geometry(580); expect(view.jump()).not.toBeNull()
    view.geometry(600); expect(view.jump()).toBeNull()
  })
  it('uses the bottom anchor, hides the button, moves keyboard focus and expires feedback', async () => {
    const view = await mount(); view.geometry(300)
    anchorPadding = 32
    fireEvent.click(view.jump()!)
    expect(view.viewport().scrollTop).toBe(600)
    expect(view.jump()).toBeNull()
    expect(view.container.querySelector('[data-latest-highlight="true"]')).not.toBeNull()
    expect(view.getByRole('status').textContent).toBe('chat.latestReached')
    expect(view.viewport().contains(document.activeElement)).toBe(true)
    await tick(1700)
    expect(view.container.querySelector('[data-latest-highlight="true"]')).toBeNull()
    view.geometry(300); expect(view.jump()).not.toBeNull()
  })
  it('keeps history steady during draft, content resize and viewport resize', async () => {
    const session = baseSession(); const view = await mount(session); view.geometry(300)
    view.rerender(h(ChatDisplay, { ...props(session), inputValue: 'draft' }))
    await act(async () => { for (const observer of observers) observer.callback() })
    await tick(250)
    expect(view.viewport().scrollTop).toBe(300)
    expect(view.jump()).not.toBeNull()
  })
  it('cancels queued bottom-follow when Recap takes over', async () => {
    const view = await mount(); view.geometry(600)
    await tick(550) // Leave the existing session-switch smooth-scroll guard.
    await act(async () => { for (const observer of observers) observer.callback() })
    recapReveal = () => view.geometry(300)
    fireEvent.click(view.getByRole('button', { name: 'chat.recap.jumpToMessage' }))
    await tick(250)
    expect(view.viewport().scrollTop).toBe(300)
    expect(view.jump()).not.toBeNull()
  })
  it('preserves the history anchor while reverse pagination prepends older turns', async () => {
    const view = await mount(baseSession('a', 80))
    view.geometry(50)
    Object.defineProperty(view.viewport(), 'scrollHeight', { value: 1300, configurable: true })
    await tick(40)
    expect(view.viewport().scrollTop).toBe(350)
    expect(view.jump()).not.toBeNull()
  })
  it('does not resume bottom-follow when a streaming assistant grows in history', async () => {
    const session = baseSession(); const view = await mount(session); view.geometry(300)
    view.rerender(h(ChatDisplay, props({ ...session, isProcessing: true, messages: session.messages.map((message, index) => index === 5 ? { ...message, content: 'streamed continuation', isStreaming: true } : message) })))
    Object.defineProperty(view.viewport(), 'scrollHeight', { value: 1300, configurable: true })
    await act(async () => { for (const observer of observers) observer.callback() })
    await tick(250)
    expect(view.viewport().scrollTop).toBe(300)
    expect(view.jump()).not.toBeNull()
  })
  it('clears feedback on session switch, panel blur and unmount', async () => {
    const view = await mount(); view.geometry(300); fireEvent.click(view.jump()!)
    view.rerender(h(ChatDisplay, props(baseSession('b'))))
    expect(view.queryByRole('status')?.textContent ?? '').toBe('')
    view.geometry(300); fireEvent.click(view.jump()!)
    focused = false; view.rerender(h(ChatDisplay, props(baseSession('b'))))
    expect(view.queryByRole('status')?.textContent ?? '').toBe('')
    expect(view.container.querySelector('[data-latest-highlight="true"]')).toBeNull()
    view.unmount(); await tick(1700); expect(observers.size).toBe(0)
  })
  it('attaches after null-to-session mount and preserves user-message commit auto-scroll', async () => {
    const view = await mount(null)
    const session = baseSession(); view.rerender(h(ChatDisplay, props(session))); view.geometry(300)
    expect(view.jump()).not.toBeNull()
    view.rerender(h(ChatDisplay, props({ ...session, messages: [...session.messages, { id: 'new', role: 'user', content: 'sent', timestamp: 20 }] })))
    await tick(40)
    expect(view.viewport().scrollTop).toBe(600)
    expect(view.jump()).toBeNull()
  })
})
