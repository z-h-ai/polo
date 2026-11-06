import { describe, it, expect, beforeAll, afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof window === 'undefined') GlobalRegistrator.register()

import { createElement } from 'react'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'

const { render, cleanup, screen, act } = await import('@testing-library/react')
const { I18nextProvider } = await import('react-i18next')
const { TerminalOutput } = await import('../TerminalOutput')

// Expectations are read from the live locale table instead of being spelled
// out here, so the test tracks the key contract rather than a frozen string.
const L = (key: string, lng: string) => i18n.t(key, { lng })

function mountTerminal(props: { command: string; output?: string; exitCode?: number }) {
  render(
    createElement(I18nextProvider, { i18n }, createElement(TerminalOutput, {
      command: props.command,
      output: props.output ?? '',
      exitCode: props.exitCode,
    })),
  )
}

beforeAll(async () => {
  await setupI18n()
})

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('en')
})

describe('TerminalOutput localized chrome (POO-179 F-I18N-OVERLAY-CHROME)', () => {
  it('renders the section label and empty-output fallback via overlay.* keys in zh-Hans', () => {
    void i18n.changeLanguage('zh-Hans')
    mountTerminal({ command: 'ls -la /fixture/work' })

    // Section headers resolve through t(), no English residue.
    expect(screen.getByText(L('overlay.command', 'zh-Hans'))).toBeTruthy()
    expect(screen.getByText(L('terminal.output', 'zh-Hans'))).toBeTruthy()
    expect(screen.getByText(L('overlay.noOutputCaptured', 'zh-Hans'))).toBeTruthy()

    // The executed command is protocol data and stays verbatim.
    expect(screen.getByText('ls -la /fixture/work')).toBeTruthy()

    expect(screen.queryByText('Command')).toBeNull()
    expect(screen.queryByText('(no output)')).toBeNull()
  })

  it('keeps the English surface on the overlay.* en values', () => {
    void i18n.changeLanguage('en')
    mountTerminal({ command: 'ls -la /fixture/work' })

    expect(screen.getByText(L('overlay.command', 'en'))).toBeTruthy()
    expect(screen.getByText(L('overlay.noOutputCaptured', 'en'))).toBeTruthy()
    expect(screen.getByText('ls -la /fixture/work')).toBeTruthy()
    expect(screen.queryByText(L('overlay.command', 'zh-Hans'))).toBeNull()
  })

  it('shows real output instead of the fallback, and re-translates chrome on language switch', async () => {
    void i18n.changeLanguage('zh-Hans')
    mountTerminal({ command: 'echo hi', output: 'hello fixture' })

    expect(screen.getByText('hello fixture')).toBeTruthy()
    expect(screen.queryByText(L('overlay.noOutputCaptured', 'zh-Hans'))).toBeNull()

    // Same mounted tree, no remount: switching the language re-resolves t().
    await act(async () => { await i18n.changeLanguage('en') })
    expect(screen.getByText(L('overlay.command', 'en'))).toBeTruthy()
    expect(screen.queryByText(L('overlay.command', 'zh-Hans'))).toBeNull()
  })
})
