import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import { initReactI18next } from 'react-i18next'
import { setupI18n } from '@polo-ai/shared/i18n'
import { RichTextInput } from '../rich-text-input'

if (typeof document === 'undefined') GlobalRegistrator.register()
setupI18n([initReactI18next])
const { render, fireEvent, cleanup } = await import('@testing-library/react')
afterEach(cleanup)

describe('RichTextInput semantic newline and browser filler boundaries', () => {
  it('counts a leading newline in the cursor Range fragment', () => {
    const inputs: Array<[string, number]> = []
    const view = render(createElement(RichTextInput, {
      value: '\nabc', onChange: () => {}, onInput: (text, cursor) => inputs.push([text, cursor]),
    }))
    const editor = view.getByRole('textbox')
    const range = document.createRange()
    range.setStart(editor, 1)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.input(editor, { inputType: 'insertText' })
    expect(inputs).toEqual([['\nabc', 1]])
  })

  it('keeps a controlled newline on the next input instead of emitting empty text', () => {
    const changes: string[] = []
    function ControlledEditor() {
      const [value, setValue] = useState('\n')
      return createElement(RichTextInput, {
        value, placeholder: '输入消息', onChange: next => { changes.push(next); setValue(next) },
      })
    }
    const view = render(createElement(ControlledEditor))
    const editor = view.getByRole('textbox')
    expect(editor.innerHTML).toBe('<br>')
    fireEvent.input(editor, { inputType: 'historyUndo' })
    expect(changes).toEqual(['\n'])
    expect(view.queryByText('输入消息') === null).toBe(true)
  })

  it('keeps an externally restored newline draft on subsequent input', () => {
    const changes: string[] = []
    const props = { onChange: (value: string) => changes.push(value), placeholder: '输入消息' }
    const view = render(createElement(RichTextInput, { ...props, value: '' }))
    view.rerender(createElement(RichTextInput, { ...props, value: '\n' }))
    fireEvent.input(view.getByRole('textbox'), { inputType: 'historyRedo' })
    expect(changes).toEqual(['\n'])
    expect(view.queryByText('输入消息') === null).toBe(true)
  })

  it('does not classify an explicitly inserted line break as an empty editor', () => {
    const changes: string[] = []
    const view = render(createElement(RichTextInput, { value: '', onChange: value => changes.push(value) }))
    const editor = view.getByRole('textbox')
    editor.innerHTML = '<br>'
    fireEvent.input(editor, { inputType: 'insertLineBreak' })
    expect(changes).toEqual(['\n'])
  })

  it('can delete an existing newline to a browser filler without retaining the draft', () => {
    const changes: string[] = []
    function ControlledEditor() {
      const [value, setValue] = useState('\n')
      return createElement(RichTextInput, {
        value, placeholder: '输入消息', onChange: next => { changes.push(next); setValue(next) },
      })
    }
    const view = render(createElement(ControlledEditor))
    const editor = view.getByRole('textbox')
    editor.innerHTML = '<br>'
    fireEvent.input(editor, { inputType: 'deleteContentBackward' })
    expect(changes).toEqual([''])
    expect(view.queryByText('输入消息') !== null).toBe(true)
  })
})
