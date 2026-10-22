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

const { render, screen, cleanup, within } = await import('@testing-library/react')
const SettingsNavigator = (await import('../SettingsNavigator')).default

function renderNavigator(selectedSubpage: string | null, onSelect: (subpage: string) => void = () => {}) {
  return render(
    createElement(I18nextProvider, { i18n }, createElement(SettingsNavigator, {
      selectedSubpage: selectedSubpage as never,
      onSelectSubpage: onSelect,
    }))
  )
}

function visibleRowIds() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="settings-item-"]')
  ).map(el => el.dataset.testid!)
}

afterEach(() => {
  cleanup()
})

/**
 * POO-103: Polo-scope settings (the TopBar account-menu entry) is an
 * independent two-column surface — the assistant sidebar is hidden, so the
 * navigator ends with a "Polo AI assistant settings" shortcut row that jumps
 * into the assistant scope. The assistant scope's own navigator (sidebar
 * Settings row entry) must NOT show that shortcut.
 */
describe('SettingsNavigator assistant shortcut (POO-103)', () => {
  it('ends the polo navigator with the assistant shortcut row', () => {
    renderNavigator('app')
    const ids = visibleRowIds()
    expect(ids[ids.length - 1]).toBe('settings-item-assistant-shortcut')
    // Polo rows stay; the shortcut never replaces a registry row.
    expect(ids).toContain('settings-item-app')
    expect(ids).toContain('settings-item-appearance')
    expect(ids).toContain('settings-item-shortcuts')
  })

  it('does not show the shortcut in the assistant navigator', () => {
    renderNavigator('input')
    expect(visibleRowIds()).not.toContain('settings-item-assistant-shortcut')
    expect(screen.getByTestId('settings-item-input')).toBeDefined()
  })

  it('navigates to the assistant scope default subpage on click', () => {
    const selected: { value: string | null } = { value: null }
    renderNavigator('app', (subpage: string) => { selected.value = subpage })
    screen.getByTestId('settings-item-assistant-shortcut').click()
    expect(selected.value).toBe('input')
  })

  it('shows the translated shortcut label', () => {
    renderNavigator('app')
    const row = screen.getByTestId('settings-item-assistant-shortcut')
    expect(within(row).getByText(i18n.t('settings.assistantShortcut.title'))).toBeDefined()
  })
})
