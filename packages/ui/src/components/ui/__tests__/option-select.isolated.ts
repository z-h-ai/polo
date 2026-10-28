import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'

GlobalRegistrator.register()
HTMLElement.prototype.scrollIntoView ??= () => {}
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react')
const { OptionSelect } = await import('../OptionSelect')
afterEach(cleanup)

function Field({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState('')
  return createElement('form', { 'data-testid': 'form' }, createElement(OptionSelect, {
    name: 'source', 'aria-label': 'Source', value, onValueChange: setValue, disabled,
    options: [
      { value: '', label: 'No selection' },
      { value: '0', label: 'Literal zero' },
      { value: '__empty__', label: 'Literal sentinel' },
      { value: 'restricted', label: 'Unavailable', disabled: true },
    ],
  }))
}

async function choose(label: string) {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: label }))
}

describe('OptionSelect public value and keyboard contract', () => {
  it('preserves arbitrary values, clears back to empty, and submits original values', async () => {
    render(createElement(Field))
    for (const [label, value] of [['Literal zero', '0'], ['Literal sentinel', '__empty__'], ['No selection', '']]) {
      await choose(label!)
      expect(screen.getByRole('combobox').textContent).toBe(label)
      expect(new FormData(screen.getByTestId('form') as HTMLFormElement).get('source')).toBe(value)
    }
  })

  it('exposes disabled options and Escape closes without committing another value', async () => {
    render(createElement(Field))
    await choose('Literal zero')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect((await screen.findByRole('option', { name: 'Unavailable' })).getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('combobox').textContent).toBe('Literal zero')
  })

  it('a disabled field cannot open and is excluded from submitted form data', () => {
    render(createElement(Field, { disabled: true }))
    expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(new FormData(screen.getByTestId('form') as HTMLFormElement).has('source')).toBe(false)
  })
})


const { Checkbox } = await import('../Checkbox')
const userEvent = (await import('@testing-library/user-event')).default

describe('shared checkbox semantics', () => {
  it('keeps label activation and original named form submission', async () => {
    function Consent() {
      const [checked, setChecked] = useState(false)
      return createElement('form', { 'data-testid': 'consent' }, createElement('label', null,
        createElement(Checkbox, { name: 'agree', value: 'yes', checked, onChange: event => setChecked(event.target.checked) }), 'Agree'))
    }
    render(createElement(Consent))
    await userEvent.setup().click(screen.getByText('Agree'))
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(new FormData(screen.getByTestId('consent') as HTMLFormElement).get('agree')).toBe('yes')
  })

  it('read-only task lists cannot change state on click', async () => {
    render(createElement(Checkbox, { checked: true, readOnly: true, 'aria-label': 'Completed' }))
    await userEvent.setup().click(screen.getByRole('checkbox'))
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  it('disabled consent stays unchecked', async () => {
    render(createElement(Checkbox, { checked: false, disabled: true, 'aria-label': 'Agree' }))
    await userEvent.setup().click(screen.getByRole('checkbox'))
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
})
