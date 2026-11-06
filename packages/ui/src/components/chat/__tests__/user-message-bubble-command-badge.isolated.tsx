// C10 regression (POO-179): the CommandBadge computes a localized displayLabel
// for known slash commands and must actually render it. The delivery bug was
// that the span kept emitting the persisted badge.label, silently discarding
// the computed value.
//
// Persistence boundary: /compact itself is message content — only the badge's
// display label localizes, and only for commands we positively identify.
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

// Same shared-process pattern as apps/electron TopBar.*.isolated.ts: register
// only when no window exists yet so sibling files in the same bun process are
// not hit by a second global registration.
if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()

// The markdown barrel pulls the whole Tiptap editor chain; the badge under
// test never renders markdown, so stub it with a pass-through element.
mock.module('../../markdown', () => ({
  Markdown: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

const { render, screen, cleanup } = await import('@testing-library/react')
const { UserMessageBubble } = await import('../UserMessageBubble')

function commandBubble(rawText: string) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(UserMessageBubble, {
      content: rawText,
      badges: [{ type: 'command', label: rawText, rawText, start: 0, end: rawText.length }],
    })
  )
}

afterEach(() => {
  cleanup()
  i18n.changeLanguage('en')
})

describe('UserMessageBubble CommandBadge display localization (C10)', () => {
  it('shows the localized compact badge under zh-Hans — not the raw label', () => {
    i18n.changeLanguage('zh-Hans')
    render(commandBubble('/compact'))
    expect(screen.getByText('压缩')).toBeTruthy()
    // The persisted raw text must not render as the badge label anymore.
    expect(screen.queryByText('/compact')).toBeNull()
  })

  it('shows the raw label verbatim under en', () => {
    i18n.changeLanguage('en')
    render(commandBubble('/compact'))
    expect(screen.getByText('Compact')).toBeTruthy()
    expect(screen.queryByText('/compact')).toBeNull()
  })

  it('keeps an unknown command label untranslated in every locale', () => {
    i18n.changeLanguage('zh-Hans')
    render(commandBubble('/frobnicate'))
    expect(screen.getByText('/frobnicate')).toBeTruthy()
    expect(screen.queryByText('压缩')).toBeNull()
  })
})
