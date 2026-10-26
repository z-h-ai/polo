/**
 * POO-135 element reference chips — draft (composer) and message (sent) modes.
 *
 * Isolated happy-dom render (shared-process pattern, see TopBar.app-menu.isolated.ts).
 * Run per-file: `bun test apps/electron/src/renderer/components/chat/__tests__/ElementReferenceChips.interaction.isolated.ts`
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

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

// The workbench theming layer pulls CSS custom properties at runtime; the
// chips only need stable class names here.
mock.module('@/components/ui/client-workbench', () => ({
  clientWorkbenchDialogClassName: 'workbench-dialog',
  clientWorkbenchOverlayClassName: 'workbench-overlay',
  useClientWorkbenchStyle: () => ({}),
}))

// Minimal Dialog stand-in: renders children only while open.
const h = (...args: unknown[]) => (createElement as any)(...args)
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? h('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => h('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => h('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => h('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => h('div', null, children),
}))

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  withTranslation: () => (Component: unknown) => Component,
}))

const { render, cleanup, fireEvent, waitFor } = await import('@testing-library/react')
const { createElement } = await import('react')
const { ElementReferenceChips, elementReferenceChipLabel } = await import('../ElementReferenceChips')

import type { WebElementReference } from '@polo-ai/core/types'

function makeReference(overrides: Partial<WebElementReference> = {}): WebElementReference {
  return {
    id: 'element-1',
    browserInstanceId: 'inst-1',
    sessionId: 'sess-a',
    tag: 'button',
    text: 'Buy now',
    aria: 'Purchase button',
    locator: 'html>body>div:nth-child(2)>button',
    pageTitle: 'Example Shop',
    url: 'https://example.com/page',
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('ElementReferenceChips (POO-135)', () => {
  it('renders nothing for an empty reference list', () => {
    const { container } = render(createElement(ElementReferenceChips, { references: [], mode: 'draft' }))
    expect(container.querySelector('[data-testid="element-draft-chips"]')).toBeNull()
  })

  it('draft mode: chips are removable, removal only fires for the clicked reference', () => {
    const onRemove = mock((_id: string) => {})
    const refs = [makeReference(), makeReference({ id: 'element-2', tag: 'a', text: 'Docs' })]
    const { getByTestId } = render(
      createElement(ElementReferenceChips, { references: refs, mode: 'draft', onRemove }),
    )

    expect(getByTestId('element-draft-chips')).toBeTruthy()
    expect(getByTestId('element-draft-chips').textContent).toContain('button · Buy now')
    expect(getByTestId('element-draft-chips').textContent).toContain('a · Docs')

    fireEvent.click(getByTestId('element-draft-chip-remove-element-1'))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('element-1')
  })

  it('falls back to aria (then bare tag) when the element has no visible text', () => {
    // Form controls whitelist no text — the aria label carries the summary.
    expect(elementReferenceChipLabel(makeReference({ text: '', aria: 'Email address' }))).toBe('button · Email address')
    expect(elementReferenceChipLabel(makeReference({ text: '', aria: undefined }))).toBe('button')
  })

  it('message mode: read-only chips (no remove buttons) and no removal', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(ElementReferenceChips, { references: [makeReference()], mode: 'message' }),
    )
    expect(getByTestId('element-reference-chips')).toBeTruthy()
    expect(queryByTestId('element-draft-chip-remove-element-1')).toBeNull()
  })

  it('clicking a chip opens the point-in-time snapshot dialog with the whitelisted fields', async () => {
    const { getByTestId, queryByTestId, getByText } = render(
      createElement(ElementReferenceChips, { references: [makeReference()], mode: 'draft' }),
    )

    expect(queryByTestId('dialog')).toBeNull()
    fireEvent.click(getByText('button · Buy now'))

    const dialog = await waitFor(() => getByTestId('dialog'))
    // Four labeled sections, exactly the capture whitelist.
    expect(dialog.textContent).toContain('browserPane.elementReference.previewTitle')
    expect(dialog.textContent).toContain('browserPane.elementReference.fieldPage')
    expect(dialog.textContent).toContain('Example Shop')
    expect(dialog.textContent).toContain('https://example.com/page')
    expect(dialog.textContent).toContain('browserPane.elementReference.fieldElement')
    expect(dialog.textContent).toContain('Purchase button')
    expect(dialog.textContent).toContain('browserPane.elementReference.fieldLocator')
    expect(dialog.textContent).toContain('html>body>div:nth-child(2)>button')
    expect(dialog.textContent).toContain('browserPane.elementReference.fieldSummary')
    expect(dialog.textContent).toContain('Buy now')
  })
})
