import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'

GlobalRegistrator.register()
setupI18n()
await i18n.changeLanguage('en')

const toastError = mock(() => {})
const toastSuccess = mock(() => {})
mock.module('sonner', () => ({
  toast: { error: toastError, success: toastSuccess },
}))

mock.module('@polo-ai/ui', () => ({
  Spinner: () => null,
}))
mock.module('@/components/app-shell/PanelHeader', () => ({
  PanelHeader: ({ title }: { title?: string }) => createElement('header', null, title),
}))
mock.module('@/components/ui/HeaderMenu', () => ({
  HeaderMenu: () => null,
}))
mock.module('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: React.ComponentProps<'div'>['children'] }) =>
    createElement('div', null, children),
}))
// Real input/textarea stand-ins so change/blur events flow through the page
mock.module('@/components/settings', () => ({
  SettingsCard: ({ children }: { children?: React.ReactNode }) => createElement('div', null, children),
  SettingsInput: (props: { value: string; placeholder?: string; error?: string; onChange: (v: string) => void; onBlur?: () => void }) =>
    createElement('div', { 'data-testid': `input-${props.placeholder ?? ''}` }, [
      createElement('input', {
        key: 'input',
        value: props.value,
        placeholder: props.placeholder,
        onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
        onBlur: props.onBlur,
      }),
      props.error ? createElement('p', { key: 'error' }, props.error) : null,
    ]),
  SettingsSection: ({ children, description, title }: { children?: React.ReactNode; description?: string; title?: string }) =>
    createElement('section', null, createElement('h2', null, title), createElement('p', null, description), children),
  SettingsTextarea: (props: { value: string; placeholder?: string; onChange: (v: string) => void }) =>
    createElement('textarea', {
      value: props.value,
      placeholder: props.placeholder,
      onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
    }),
}))
mock.module('@/components/ui/EditPopover', () => ({
  EditPopover: () => null,
  EditButton: () => null,
  getEditConfig: () => ({}),
}))
mock.module('@/lib/navigate', () => ({
  routes: { view: { settings: () => '/settings/preferences' } },
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { default: PreferencesPage } = await import('../PreferencesPage')

const SAVE_FAILED_TEXT = "Couldn't save automatically. Try again later — what you typed is still in the fields."
const TIMEZONE_INVALID_TEXT = "That doesn't look like a valid timezone. Use an Area/City format, e.g. Asia/Shanghai"

type WriteResult = Awaited<ReturnType<typeof window.electronAPI.writePreferences>>

let storedContent = ''
let writeResult: () => WriteResult

function setElectronApi(): void {
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    readPreferences: async () => ({ content: storedContent, path: '/tmp/preferences.json' }),
    writePreferences: async (json: string) => {
      storedContent = json
      return writeResult()
    },
  }
}

function renderPage(): ReturnType<typeof render> {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(PreferencesPage) as ReactElement,
    ),
  )
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  storedContent = JSON.stringify({ name: 'Tester', timezone: 'Asia/Shanghai', notes: 'original' })
  writeResult = () => ({ success: true, path: '/tmp/preferences.json' })
  setElectronApi()
})

afterEach(() => {
  cleanup()
  toastError.mockClear()
  toastSuccess.mockClear()
})

describe('PreferencesPage auto-save failure is made visible to the user', () => {
  it('toasts and shows an inline error when the debounced auto-save fails', async () => {
    writeResult = () => ({ success: false, path: '/tmp/preferences.json' })
    renderPage()
    const notes = await screen.findByPlaceholderText("Any additional information you'd like to share with the AI assistant...")
    // Wait out the initial-load grace period before typing
    await sleep(150)
    fireEvent.change(notes, { target: { value: 'updated note' } })

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1)
    }, { timeout: 3000 })
    // Inline error state mirrors the toast next to the fields
    expect(screen.getByText(SAVE_FAILED_TEXT)).toBeTruthy()
    // The typed content is still in the field (nothing was silently lost)
    expect((notes as HTMLTextAreaElement).value).toBe('updated note')
  })

  it('stays quiet when auto-save succeeds', async () => {
    renderPage()
    const notes = await screen.findByPlaceholderText("Any additional information you'd like to share with the AI assistant...")
    await sleep(150)
    fireEvent.change(notes, { target: { value: 'another note' } })
    // Outlast the 500ms debounce plus the save round-trip
    await sleep(800)
    expect(toastError).not.toHaveBeenCalled()
    expect(storedContent).toContain('another note')
  })
})

describe('PreferencesPage timezone field guards against typos', () => {
  it('shows an inline hint on blur for an invalid zone and clears it once fixed', async () => {
    renderPage()
    const timezone = await screen.findByPlaceholderText('e.g., America/New_York')
    await sleep(150)

    fireEvent.change(timezone, { target: { value: 'Asia/Shanghia' } })
    fireEvent.blur(timezone)
    expect(screen.getByText(TIMEZONE_INVALID_TEXT)).toBeTruthy()

    fireEvent.change(timezone, { target: { value: 'Asia/Shanghai' } })
    // Editing the value clears the hint immediately
    expect(screen.queryByText(TIMEZONE_INVALID_TEXT)).toBeNull()
    fireEvent.blur(timezone)
    expect(screen.queryByText(TIMEZONE_INVALID_TEXT)).toBeNull()
  })

  it('accepts empty input without complaining (field is optional)', async () => {
    renderPage()
    const timezone = await screen.findByPlaceholderText('e.g., America/New_York')
    await sleep(150)
    fireEvent.change(timezone, { target: { value: '' } })
    fireEvent.blur(timezone)
    expect(screen.queryByText(TIMEZONE_INVALID_TEXT)).toBeNull()
  })
})
