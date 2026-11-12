import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()

// UX danger guard coverage: the preparation screen's escape hatch signs the
// user OUT, so (1) the leaf must say "Cancel and sign out" (not a light
// "Cancel"), (2) it must confirm before firing onCancel, and (3) after 30s
// of silent preparing a reassurance line must appear so the wait doesn't
// read as a freeze.

const cancelMock = mock(() => {})

mock.module('@/components/ui/client-workbench', () => ({
  useClientWorkbenchStyle: () => ({}),
  clientWorkbenchFocusClassName: '',
  clientWorkbenchButtonClassName: '',
}))

const { render, screen, cleanup, act } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ProductSpacePreparationScreen } = await import('../ProductSpacePreparationScreen')

function renderScreen() {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(ProductSpacePreparationScreen, { onCancel: cancelMock }),
  ))
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  cancelMock.mockClear()
})

afterEach(() => {
  cleanup()
  try {
    jest.useRealTimers()
  } catch {
    // already real
  }
})

describe('ProductSpacePreparationScreen cancel semantics (UX danger guard)', () => {
  it('spells out the consequence: the leaf reads "Cancel and sign out", not "Cancel"', async () => {
    renderScreen()

    expect(screen.getByRole('button', { name: 'Cancel and sign out' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('asks before signing out; cancel never fires onCancel', async () => {
    renderScreen()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Cancel and sign out' }))

    const dialog = await screen.findByTestId('product-space-cancel-confirm')
    expect(dialog.textContent).toContain('Cancel and sign out?')

    await user.click(screen.getByTestId('confirm-dialog-cancel'))

    expect(cancelMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('product-space-cancel-confirm')).toBeNull()
  })

  it('confirm is the only path that fires onCancel', async () => {
    renderScreen()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Cancel and sign out' }))
    await screen.findByTestId('product-space-cancel-confirm')
    await user.click(screen.getByTestId('confirm-dialog-action'))

    expect(cancelMock).toHaveBeenCalledTimes(1)
  })

  it('after 30s of preparing the reassurance line appears', async () => {
    jest.useFakeTimers()
    renderScreen()
    expect(screen.queryByTestId('product-space-preparation-still-preparing')).toBeNull()

    act(() => {
      jest.advanceTimersByTime(30_000)
    })

    expect(screen.getByTestId('product-space-preparation-still-preparing').textContent).toContain('Still preparing')
    expect(cancelMock).not.toHaveBeenCalled()
  })
})
