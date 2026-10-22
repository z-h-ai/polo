/**
 * KbReferenceChips — the read-side of the POO-108 vertical slice.
 *
 * Rendered from the REAL component: the persisted `kbReferences` snapshot
 * under a user message must render as chips, and clicking a chip must fetch
 * the CURRENT document read-only through kbGetDocument (the snapshot text
 * itself stays immutable on the message).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { KbReference } from '@polo-ai/core/types'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      },
    },
  })
}
setupI18n()

// The design-token adapter is Vite-only (`?raw` imports + import.meta.glob);
// the chips under test only consume the injected CSS custom properties.
mock.module('@/lib/client-workbench-style', () => ({
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { I18nextProvider } = await import('react-i18next')
const { KbReferenceChips } = await import('../KbReferenceChips')

function reference(overrides: Partial<KbReference> = {}): KbReference {
  return {
    docId: 'doc-1',
    collectionId: 'col-1',
    collectionName: 'Travel policy',
    title: 'Flights policy',
    snippet: '…book flights through the corporate portal…',
    score: 4,
    ...overrides,
  }
}

function renderChips(references: KbReference[], workspaceId = 'ws-1') {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(KbReferenceChips as unknown as (props: Record<string, unknown>) => React.ReactElement, {
        references,
        workspaceId,
      }),
    ),
  )
}

let getCalls: Array<{ workspaceId: string; docId: string }>

beforeEach(() => {
  void i18n.changeLanguage('en')
  getCalls = []
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    kbGetDocument: async (input: { workspaceId: string; docId: string }) => {
      getCalls.push(input)
      if (input.docId === 'doc-gone') return null
      return {
        id: input.docId,
        title: input.docId === 'doc-1' ? 'Flights policy' : 'Per diem policy',
        content: 'Published body text',
        status: 'published',
      }
    },
  }
})

afterEach(() => {
  cleanup()
})

describe('KbReferenceChips (POO-108)', () => {
  it('renders one chip per persisted reference with collection context', () => {
    renderChips([
      reference(),
      reference({ docId: 'doc-2', collectionId: 'col-2', collectionName: 'HR', title: 'Per diem policy' }),
    ])

    expect(screen.getByTestId('kb-reference-chips').textContent).toContain('Flights policy')
    expect(screen.getByTestId('kb-reference-chips').textContent).toContain('Per diem policy')
    expect(screen.getByTestId('kb-reference-chips').textContent).toContain('Travel policy')
  })

  it('renders nothing for a message without references', () => {
    const { container } = renderChips([])
    expect(container.textContent).toBe('')
  })

  it('opens the read-only preview with the CURRENT document on click', async () => {
    const user = userEvent.setup({ document: window.document })
    renderChips([reference()])

    user.click(screen.getByRole('button', { name: /Flights policy/ }))

    await waitFor(() => {
      expect(screen.getByText('Published body text')).toBeTruthy()
    })
    expect(getCalls).toEqual([{ workspaceId: 'ws-1', docId: 'doc-1' }])
  })

  it('keeps the snapshot chips intact when the document is gone (no preview)', async () => {
    const user = userEvent.setup({ document: window.document })
    renderChips([reference({ docId: 'doc-gone' })])

    user.click(screen.getByRole('button', { name: /Flights policy/ }))

    await waitFor(() => {
      expect(getCalls).toEqual([{ workspaceId: 'ws-1', docId: 'doc-gone' }])
    })
    expect(screen.queryByText('Published body text')).toBeNull()
  })
})
