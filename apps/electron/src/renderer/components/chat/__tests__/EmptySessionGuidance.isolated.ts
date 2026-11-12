/**
 * EmptySessionGuidance — the desktop empty session's "what can I do" cards.
 *
 * Isolated happy-dom render (shared-process pattern, see TopBar.app-menu.isolated.ts).
 * Run per-file: `bun test apps/electron/src/renderer/components/chat/__tests__/EmptySessionGuidance.isolated.ts`
 */

import { afterEach, describe, expect, it } from 'bun:test'
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

const { render, screen, cleanup, fireEvent } = await import('@testing-library/react')
const { EmptySessionGuidance } = await import('../EmptySessionGuidance')

function tree(sessionId?: string) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(EmptySessionGuidance, { sessionId }),
  )
}

afterEach(() => cleanup())

describe('EmptySessionGuidance', () => {
  it('renders the invitation plus three example cards for an empty session', () => {
    render(tree('sess-1'))

    expect(screen.getByText(i18n.t('chatInput.placeholder.workOn') as string)).toBeTruthy()
    expect(screen.getByText(i18n.t('chat.emptySession.tryHint') as string)).toBeTruthy()
    const cards = screen.getAllByTestId('empty-session-guidance-hint')
    expect(cards).toHaveLength(3)
  })

  it('clicking a card inserts the plain-text hint into the composer channel', () => {
    const inserted: Array<{ text: string; sessionId?: string }> = []
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string; sessionId?: string }>).detail
      inserted.push({ text: detail.text, sessionId: detail.sessionId })
    }
    window.addEventListener('craft:insert-text', listener)

    render(tree('sess-9'))
    fireEvent.click(screen.getAllByTestId('empty-session-guidance-hint')[0])

    window.removeEventListener('craft:insert-text', listener)

    // Entity tokens ({source:Gmail} etc.) must collapse to their labels — the
    // inserted sentence is what the user would have typed themselves.
    expect(inserted).toHaveLength(1)
    expect(inserted[0].sessionId).toBe('sess-9')
    expect(inserted[0].text).toBe(
      'Summarize your Gmail inbox, draft replies, and save notes to Polo AI',
    )
  })

  it('scopes the insert event without a session id when none is given', () => {
    const inserted: string[] = []
    const listener = (event: Event) => {
      inserted.push((event as CustomEvent<{ text: string }>).detail.text)
    }
    window.addEventListener('craft:insert-text', listener)

    render(tree())
    fireEvent.click(screen.getAllByTestId('empty-session-guidance-hint')[2])

    window.removeEventListener('craft:insert-text', listener)
    expect(inserted).toEqual(['Refactor code in your folder, then push to GitHub'])
  })
})
