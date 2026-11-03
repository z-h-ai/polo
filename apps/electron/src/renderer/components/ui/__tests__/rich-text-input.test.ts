import { afterEach, describe, it, expect } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { initReactI18next } from 'react-i18next'
import { setupI18n } from '@polo-ai/shared/i18n'
import { RichTextInput, isEscapeDuringComposition } from '../rich-text-input'

if (typeof document === 'undefined') GlobalRegistrator.register()
setupI18n([initReactI18next])
const { render, fireEvent, cleanup } = await import('@testing-library/react')
afterEach(cleanup)

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true)
  })

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false
      )
    ).toBe(true)
  })

  it('returns true for Escape when event.isComposing is true', () => {
    expect(isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false)).toBe(true)
  })

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false)
  })

  it('returns false for non-Escape keys even if composing', () => {
    expect(isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true)).toBe(false)
  })
})


describe('RichTextInput placeholder during IME composition', () => {
  it('hides the overlay and transparent text while composing without publishing unfinished text', () => {
    const values: string[] = []
    const inputs: string[] = []
    const view = render(createElement(RichTextInput, {
      value: '', onChange: value => values.push(value),
      onInput: value => inputs.push(value), placeholder: '输入消息',
    }))
    const editor = view.getByRole('textbox')
    expect(view.queryByText('输入消息') !== null).toBe(true)

    fireEvent.compositionStart(editor)
    editor.textContent = '中'
    fireEvent.input(editor, { data: '中', inputType: 'insertCompositionText', isComposing: true })

    expect(view.queryByText('输入消息') === null).toBe(true)
    expect(editor.classList.contains('text-transparent')).toBe(false)
    expect(values).toEqual([])
    expect(inputs).toEqual([])

    fireEvent.compositionEnd(editor, { data: '中' })
    expect(values).toEqual(['中'])
    expect(inputs).toEqual(['中'])
    // A controlled consumer may apply the committed value on its next render.
    expect(view.queryByText('输入消息') === null).toBe(true)
  })

  it('restores the empty placeholder when composition text is cancelled, and keeps Escape inside IME', () => {
    const values: string[] = []
    let forwardedEscape = 0
    const view = render(createElement(RichTextInput, {
      value: '', onChange: value => values.push(value), placeholder: '输入消息',
      onKeyDown: event => { if (event.key === 'Escape') forwardedEscape += 1 },
    }))
    const editor = view.getByRole('textbox')
    fireEvent.compositionStart(editor)
    editor.textContent = 'ni'
    fireEvent.input(editor, { data: 'ni', inputType: 'insertCompositionText', isComposing: true })
    expect(view.queryByText('输入消息') === null).toBe(true)
    fireEvent.keyDown(editor, { key: 'Escape', isComposing: true })
    expect(forwardedEscape).toBe(0)
    editor.textContent = ''
    fireEvent.input(editor, { data: '', inputType: 'insertCompositionText', isComposing: true })
    fireEvent.compositionEnd(editor, { data: '' })
    expect(view.queryByText('输入消息') !== null).toBe(true)
    expect(values).toEqual([''])
  })

  it('follows external draft fill and clear after composing', () => {
    const onChange = () => {}
    const view = render(createElement(RichTextInput, { value: '', onChange, placeholder: '输入消息' }))
    const editor = view.getByRole('textbox')
    fireEvent.compositionStart(editor)
    editor.textContent = '中'
    fireEvent.input(editor, { data: '中', inputType: 'insertCompositionText', isComposing: true })
    fireEvent.compositionEnd(editor, { data: '中' })
    view.rerender(createElement(RichTextInput, { value: '外部草稿\n第二行', onChange, placeholder: '输入消息' }))
    expect(editor.textContent).toContain('外部草稿')
    expect(view.queryByText('输入消息') === null).toBe(true)
    view.rerender(createElement(RichTextInput, { value: '', onChange, placeholder: '输入消息' }))
    expect(view.queryByText('输入消息') !== null).toBe(true)
    expect(editor.textContent).not.toContain('外部草稿')
  })
})
