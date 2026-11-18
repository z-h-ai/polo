import { afterEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'

GlobalRegistrator.register()
setupI18n()

const { act, cleanup, render, screen } = await import('@testing-library/react')
const { SplashScreen, SPLASH_STILL_STARTING_DELAY_MS } = await import('../SplashScreen')

afterEach(() => {
  cleanup()
  jest.useRealTimers()
  i18n.changeLanguage('en')
})

function renderWithI18n(element: ReactElement) {
  return render(createElement(I18nextProvider, { i18n }, element))
}

describe('SplashScreen hung-startup reassurance line', () => {
  it('shows nothing during normal fast startup (under the delay)', () => {
    jest.useFakeTimers()
    renderWithI18n(createElement(SplashScreen, { isExiting: false }))

    jest.advanceTimersByTime(SPLASH_STILL_STARTING_DELAY_MS - 1)
    expect(screen.queryByTestId('splash-still-starting')).toBeNull()
  })

  it('reveals the reassurance line after 15s without interrupting the splash', () => {
    jest.useFakeTimers()
    renderWithI18n(createElement(SplashScreen, { isExiting: false }))

    act(() => {
      jest.advanceTimersByTime(SPLASH_STILL_STARTING_DELAY_MS)
    })

    const note = screen.getByTestId('splash-still-starting')
    expect(note).toBeTruthy()
    expect(note.textContent).toBe(i18n.t('splash.stillStarting'))
    expect(note.getAttribute('role')).toBe('status')
  })

  it('never arms the timer on the exit path', () => {
    jest.useFakeTimers()
    renderWithI18n(createElement(SplashScreen, { isExiting: true }))

    act(() => {
      jest.advanceTimersByTime(SPLASH_STILL_STARTING_DELAY_MS * 10)
    })
    expect(screen.queryByTestId('splash-still-starting')).toBeNull()
  })
})
