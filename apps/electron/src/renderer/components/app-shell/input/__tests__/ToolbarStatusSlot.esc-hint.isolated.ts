/**
 * ToolbarStatusSlot — the persistent "press Esc to interrupt" hint.
 *
 * The double-Esc interrupt is a hidden gesture; while the agent is processing
 * the slot shows a lightweight pointer-events-none hint unless a higher
 * priority status (escape overlay after the first Esc, active browser status)
 * occupies it. Isolated happy-dom render (shared-process pattern, see
 * TopBar.app-menu.isolated.ts).
 *
 * Run per-file: `bun test apps/electron/src/renderer/components/app-shell/input/__tests__/ToolbarStatusSlot.esc-hint.isolated.ts`
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

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

// Mutable fixture — tests reassign before a fresh render.
let browserInstances: Array<Record<string, unknown>> = []
mock.module('jotai', () => ({ useAtomValue: () => browserInstances, atom: () => ({}) }))
mock.module('@/atoms/browser-pane', () => ({
  browserInstancesAtom: {},
  filterInstancesForWorkspace: (all: Array<Record<string, unknown>>) => all,
}))
mock.module('@/context/AppShellContext', () => ({
  useAppShellContext: () => ({ activeWorkspaceId: 'ws-1', workspaces: [] }),
}))
// The barrel eagerly pulls the react-pdf overlay (see styled-dropdown header).
mock.module('@polo-ai/ui', () => ({ Spinner: () => null }))
mock.module('@/components/browser/utils', () => ({
  getHostname: () => 'example.com',
  getThemeLuminance: () => null,
}))

const { render, cleanup } = await import('@testing-library/react')
const { ToolbarStatusSlot } = await import('../ToolbarStatusSlot')

const boundBrowserInstance = {
  id: 'inst-1',
  boundSessionId: 'sess-1',
  agentControlActive: true,
  isVisible: true,
  url: 'https://example.com/page',
  isLoading: false,
  favicon: null,
  themeColor: null,
}

function tree(props: { showEscapeOverlay?: boolean; showEscHint?: boolean }) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement('div', { style: { position: 'relative' } },
      createElement(ToolbarStatusSlot, { sessionId: 'sess-1', showEscapeOverlay: false, ...props })),
  )
}

afterEach(() => {
  cleanup()
  browserInstances = []
})

// The Trans copy carries <kbd> markup; textContent renders it plain.
const plain = (key: string) => (i18n.t(key) as string).replace(/<[^>]+>/g, '')

describe('ToolbarStatusSlot persistent Esc hint', () => {
  it('shows the pointer-events-none hint while processing and nothing else occupies the slot', () => {
    const { container } = render(tree({ showEscHint: true }))

    expect(container.textContent).toContain(plain('toolbar.pressEscToInterrupt'))
    const hint = container.querySelector('[class*="pointer-events-none"]')
    expect(hint).toBeTruthy()
  })

  it('yields to the first-Esc overlay (the "again" copy owns the slot)', () => {
    const { container } = render(tree({ showEscHint: true, showEscapeOverlay: true }))

    expect(container.textContent).toContain(plain('toolbar.escapeToInterrupt'))
    expect(container.textContent).not.toContain(plain('toolbar.pressEscToInterrupt'))
  })

  it('yields to an active browser status bound to this session', () => {
    browserInstances = [boundBrowserInstance]
    const { container } = render(tree({ showEscHint: true }))

    expect(container.textContent).toContain('example.com')
    expect(container.textContent).not.toContain(plain('toolbar.pressEscToInterrupt'))
  })

  it('renders nothing when the caller does not ask for the hint', () => {
    const { container } = render(tree({}))

    expect(container.textContent).toBe('')
  })
})
