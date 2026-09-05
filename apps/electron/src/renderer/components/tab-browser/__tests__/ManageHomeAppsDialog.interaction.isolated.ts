import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { CatalogApp } from '@polo-ai/shared/admin'

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
)
const { ManageHomeAppsDialog } = await import('../ManageHomeAppsDialog')

function app(id: string, overrides: Partial<CatalogApp> = {}): CatalogApp {
  return {
    id,
    organizationId: 'space-a',
    name: `App ${id}`,
    description: '',
    deliveryMode: 'remote_url',
    remoteUrl: `https://${id}.example.com`,
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

const scopeKeyForApp = (target: CatalogApp) =>
  `["catalog","account-a","space-a","${target.id}"]`

describe('ManageHomeAppsDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
  })

  function renderDialog(
    apps: CatalogApp[],
    selectedIds: ReadonlySet<string>,
    onToggle: ReturnType<typeof jest.fn>,
    maxSlots = 5,
  ) {
    return render(createElement(
      I18nextProvider,
      { i18n },
      createElement(ManageHomeAppsDialog, {
        open: true,
        onOpenChange: () => {},
        apps,
        scopeKeyForApp,
        selectedIds,
        maxSlots,
        onToggle,
      }),
    ))
  }

  it('explains that it only adjusts shortcuts and lists catalog Apps', () => {
    const apps = [app('a'), app('b')]
    renderDialog(apps, new Set(), jest.fn())

    expect(screen.getByTestId('manage-home-apps-dialog')).toBeTruthy()
    expect(screen.getByText('Manage home Apps')).toBeTruthy()
    expect(screen.getByText(/Only adjusts the home shortcuts/)).toBeTruthy()
    const items = screen.getAllByTestId('manage-home-apps-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.getAttribute('data-app-id')).toBe('a')
    expect(items[0]!.getAttribute('data-selected')).toBe('false')
    expect(items[0]!.getAttribute('aria-checked')).toBe('false')
  })

  it('toggles membership without touching installation', async () => {
    const apps = [app('a'), app('b')]
    const selected = new Set([scopeKeyForApp(apps[0]!)])
    const onToggle = jest.fn()
    renderDialog(apps, selected, onToggle)

    const items = screen.getAllByTestId('manage-home-apps-item')
    expect(items[0]!.getAttribute('data-selected')).toBe('true')
    fireEvent.click(items[0]!)
    expect(onToggle).toHaveBeenCalledWith(apps[0], scopeKeyForApp(apps[0]!), false)
    fireEvent.click(items[1]!)
    expect(onToggle).toHaveBeenCalledWith(apps[1], scopeKeyForApp(apps[1]!), true)
  })

  it('disables unselected items once the five-slot capacity is reached', () => {
    const apps = [app('a'), app('b'), app('c')]
    const selected = new Set([
      scopeKeyForApp(apps[0]!),
      scopeKeyForApp(apps[1]!),
    ])
    const onToggle = jest.fn()
    renderDialog(apps, selected, onToggle, 2)

    const items = screen.getAllByTestId('manage-home-apps-item')
    expect(items[0]!.hasAttribute('disabled')).toBe(false)
    expect(items[1]!.hasAttribute('disabled')).toBe(false)
    expect(items[2]!.hasAttribute('disabled')).toBe(true)

    fireEvent.click(items[2]!)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('shows an empty state and a done button', async () => {
    const onToggle = jest.fn()
    renderDialog([], new Set(), onToggle)

    expect(screen.getByText('No Apps to choose from in this space yet.')).toBeTruthy()
    const done = screen.getByTestId('manage-home-apps-done')
    fireEvent.click(done)
    await waitFor(() => {
      expect(onToggle).not.toHaveBeenCalled()
    })
  })
})
