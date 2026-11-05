// C06 regression (POO-179): the ServerDirectoryBrowser dialog footer and the
// browse-mode path submit button resolved their labels as hardcoded English
// ("Go" / "Cancel" / "Select") while the rest of the same dialog already went
// through t(). All three must now resolve at render time from shared keys.
//
// Render-time rule: the component body calls t() through useTranslation — no
// module-level evaluation, so a language switch re-renders these buttons.
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

// Same shared-process pattern as app-shell TopBar.*.isolated.ts: register only
// when no window exists yet to avoid clobbering siblings in this bun process.
if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()

// The @polo-ai/ui barrel drags in the shared component library; only Spinner
// is referenced and only while loading, so stub the barrel.
mock.module('@polo-ai/ui', () => ({
  Spinner: () => createElement('span', { 'data-testid': 'spinner' }),
}))

// Browse mode fetches a listing on open; resolve a stable empty root so the
// dialog settles without touching a real electronAPI.
const listing = {
  currentPath: '/',
  parentPath: null,
  breadcrumbs: [{ name: '/', path: '/' }],
  platform: 'darwin' as const,
  truncated: false,
  totalEntries: 0,
  entries: [],
}
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    listServerDirectory: async () => listing,
    getServerHomeDir: async () => '/',
    getHomeDir: async () => '/',
  },
})

const { render, screen, cleanup } = await import('@testing-library/react')
const { ServerDirectoryBrowser } = await import('../ServerDirectoryBrowser')

function browser(mode: 'browse' | 'manual' = 'browse') {
  return createElement(I18nextProvider, { i18n }, createElement(ServerDirectoryBrowser, {
    open: true,
    mode,
    onSelect: () => {},
    onCancel: () => {},
    initialPath: '/',
  }))
}

afterEach(() => {
  cleanup()
  i18n.changeLanguage('en')
})

describe('ServerDirectoryBrowser button labels (C06)', () => {
  it('renders Go/Cancel/Select from i18n keys in English', async () => {
    i18n.changeLanguage('en')
    render(browser())
    // Breadcrumbs render once the stubbed listing lands.
    await screen.findByText('/')
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select...' })).toBeTruthy()
  })

  it('re-translates all three buttons under zh-Hans', async () => {
    i18n.changeLanguage('zh-Hans')
    render(browser())
    await screen.findByText('/')
    expect(screen.getByRole('button', { name: '前往' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '请选择…' })).toBeTruthy()
    // The hardcoded English labels are gone in this locale.
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('localizes the manual-mode dialog footer too', () => {
    i18n.changeLanguage('zh-Hans')
    render(browser('manual'))
    // Manual mode renders the path input, not breadcrumbs — the footer is
    // present synchronously.
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '请选择…' })).toBeTruthy()
  })
})
