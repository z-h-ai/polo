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

function editorWithValue(initialValue: string, changes: string[]) {
  function ControlledEditor() {
    const [value, setValue] = useState(initialValue)
    return createElement(RichTextInput, {
      value, placeholder: '输入消息',
      onChange: next => { changes.push(next); setValue(next) },
    })
  }
  return render(createElement(ControlledEditor))
}

describe('RichTextInput browser empty-editor marker', () => {
  it('restores the placeholder after deleting the last character leaves a filler BR', () => {
    const changes: string[] = []
    const view = editorWithValue('中', changes)
    const editor = view.getByRole('textbox')
    // Chromium leaves this empty-line marker after select-all + Backspace.
    editor.innerHTML = '<br>'
    fireEvent.input(editor, { inputType: 'deleteContentBackward' })
    expect(changes).toEqual([''])
    expect(view.queryByText('输入消息') !== null).toBe(true)
  })

  it('keeps a cancelled empty composition empty when Chromium leaves a filler BR', () => {
    const changes: string[] = []
    const view = editorWithValue('', changes)
    const editor = view.getByRole('textbox')
    fireEvent.compositionStart(editor)
    editor.textContent = 'ni'
    fireEvent.input(editor, { data: 'ni', inputType: 'insertCompositionText', isComposing: true })
    editor.innerHTML = '<br>'
    fireEvent.input(editor, { data: '', inputType: 'insertCompositionText', isComposing: true })
    fireEvent.compositionEnd(editor, { data: '' })
    expect(changes).toEqual([''])
    expect(view.queryByText('输入消息') !== null).toBe(true)
  })

  it('preserves actual multiline text and intentional whitespace', () => {
    const changes: string[] = []
    const view = editorWithValue('', changes)
    const editor = view.getByRole('textbox')
    editor.innerHTML = '第一行<br>第二行'
    fireEvent.input(editor, { inputType: 'insertFromPaste' })
    expect(changes).toEqual(['第一行\n第二行'])
    expect(view.queryByText('输入消息') === null).toBe(true)
    editor.textContent = ' '
    fireEvent.input(editor, { data: ' ', inputType: 'insertText' })
    expect(changes.at(-1)).toBe(' ')
    expect(view.queryByText('输入消息') === null).toBe(true)
  })
})
