/**
 * Regression net for the Calendar year/month dropdown event bridge
 * (apps/electron/src/renderer/components/ui/calendar.tsx `CalendarDropdown`).
 *
 * DayPicker's native select was replaced by a "hidden select + OptionSelect"
 * pair; the visible Radix control bridges the pick back by setting
 * `select.value` and dispatching a manual bubbling `change` event, which is
 * the one indirect link in the component. These tests walk the REAL user path
 * (keyboard-open the combobox, click an option — never fireEvent.change) on a
 * full `captionLayout="dropdown"` Calendar, and assert that the bridge lands:
 * the month/year actually switches (onMonthChange/onSelect callbacks, grid)
 * and the hidden native select's value stays in sync with the pick.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

GlobalRegistrator.register()
HTMLElement.prototype.scrollIntoView ??= () => {}
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react')
const { Calendar } = await import('../calendar')

afterEach(cleanup)

// Mirror of the component's formatMonthDropdown, so option labels stay
// correct no matter which default locale the test machine reports.
const monthLabel = (month: number) => new Date(2026, month, 1).toLocaleString('default', { month: 'short' })

function renderCalendar(overrides: Record<string, unknown> = {}) {
  render(createElement(Calendar, {
    mode: 'single',
    captionLayout: 'dropdown',
    defaultMonth: new Date(2026, 5, 15),
    startMonth: new Date(2024, 0),
    endMonth: new Date(2027, 11),
    ...overrides,
  }))
}

/** Values of every hidden DayPicker select, sorted (month, year pairs). */
const hiddenSelectValues = () =>
  Array.from(document.querySelectorAll('select[hidden]'), el => (el as HTMLSelectElement).value).sort()

/** Real interaction path: keyboard-open the Radix combobox, click the option. */
async function choose(comboboxName: string, optionName: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: comboboxName }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: optionName }))
}

describe('Calendar dropdown caption: hidden select + OptionSelect change bridge', () => {
  it('opens the month dropdown from the keyboard, picks January, and syncs the hidden select', async () => {
    const onMonthChange = jest.fn()
    renderCalendar({ onMonthChange })

    // June 2026 is the initial month, mirrored by the hidden native select.
    expect(hiddenSelectValues()).toEqual(['2026', '5'])

    await choose('Choose the Month', monthLabel(0))

    expect(onMonthChange).toHaveBeenCalledTimes(1)
    const nextMonth = onMonthChange.mock.calls[0]![0] as Date
    expect(nextMonth.getFullYear()).toBe(2026)
    expect(nextMonth.getMonth()).toBe(0)
    // The bridge must keep the hidden native select's value in lockstep.
    expect(hiddenSelectValues()).toEqual(['0', '2026'])
    // The visible trigger reflects the picked month label.
    expect(screen.getByRole('combobox', { name: 'Choose the Month' }).textContent).toBe(monthLabel(0))
    // The rendered grid really moved to January.
    expect(screen.getByRole('grid', { name: `January 2026` })).toBeTruthy()
  })

  it('switches the year through its dropdown, syncs its hidden select, and commits a picked day via onSelect', async () => {
    const onSelect = jest.fn()
    renderCalendar({ onSelect })

    await choose('Choose the Year', '2027')

    // Month untouched (June), year synced to 2027.
    expect(hiddenSelectValues()).toEqual(['2027', '5'])
    expect(screen.getByRole('grid', { name: `June 2027` })).toBeTruthy()

    fireEvent.click(within(screen.getByRole('grid', { name: `June 2027` })).getByText('15'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    const picked = onSelect.mock.calls[0]![0] as Date
    expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([2027, 5, 15])
  })
})
