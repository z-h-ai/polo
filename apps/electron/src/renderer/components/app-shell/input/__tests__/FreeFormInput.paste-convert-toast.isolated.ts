/** Focus test: long-text paste → .txt attachment conversion must give the
 *  user a light heads-up (sonner toast, i18n copy). Before this, a >100-line
 *  paste silently became an attachment and users assumed the text was
 *  directly in the message body. The conversion logic itself is untouched —
 *  this pins the NOTICE, not the conversion. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()

// Captured toast calls (FreeFormInput only ever imports { toast }).
const toastCalls: Array<{ level: string; message: string }> = []
mock.module('sonner', () => ({
  toast: new Proxy({}, {
    get: (_target, level) =>
      (message: unknown) => { toastCalls.push({ level: String(level), message: String(message) }) },
  }),
}))

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'data:application/javascript,' }))
mock.module('@sentry/electron/renderer', () => new Proxy({}, { get: () => () => {} }))
// RichTextInput stub: clicking the stub fires the long-text paste path with a
// 100+ line text (the real conversion threshold lives inside the input).
const PASTED_TEXT = Array.from({ length: 120 }, (_, i) => `第${i}行`).join('\n')
mock.module('@/components/ui/rich-text-input', () => ({
  RichTextInput: (props: { value?: string; onLongTextPaste?: (text: string) => void }) =>
    createElement('div', {
      'data-testid': 'rich-input-stub',
      onClick: () => props.onLongTextPaste?.(PASTED_TEXT),
    }, props.value ?? ''),
}))
mock.module('@/components/ServerDirectoryBrowser', () => ({ ServerDirectoryBrowser: () => null }))
mock.module('@/components/app-shell/AttachmentPreview', () => ({
  AttachmentPreview: () => null,
}))
mock.module('@/components/chat/ElementReferenceChips', () => ({ ElementReferenceChips: () => null }))
mock.module('@/components/project-context/ProjectAssetChip', () => ({ ProjectAssetDraftChips: () => null }))
mock.module('@/components/project-context/AssetMentionPopover', () => ({
  AssetMentionPopover: () => null,
  useAssetMention: () => ({
    isOpen: false,
    handleInputChanged: () => false,
    handleKeyDown: () => false,
    choose: () => {},
    close: () => {},
  }),
}))
mock.module('@/components/ui/EditPopover', () => ({ EditPopover: () => null, getEditConfig: () => null }))
mock.module('@/components/ui/label-icon', () => ({ LabelIcon: () => createElement('span') }))
mock.module('@/context/EscapeInterruptContext', () => ({
  useEscapeInterrupt: () => ({ showEscapeOverlay: false }),
  EscapeInterruptProvider: (props: { children?: React.ReactNode }) => props.children ?? null,
}))
mock.module('@/components/app-shell/input/ToolbarStatusSlot', () => ({ ToolbarStatusSlot: () => null }))

const { TooltipProvider } = await import('@polo-ai/ui')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { FreeFormInput } = await import('../FreeFormInput')
const { I18nextProvider } = await import('react-i18next')

beforeEach(() => { toastCalls.length = 0; cleanup() })
afterEach(() => { cleanup() })

function mount(onAttachmentsChange: (attachments: unknown[]) => void) {
  return render(createElement(
    TooltipProvider as unknown as (props: { children?: ReactElement }) => ReactElement,
    {},
    createElement(
      I18nextProvider as unknown as (props: { i18n: unknown; children?: ReactElement }) => ReactElement,
      { i18n },
      createElement(FreeFormInput, {
        currentModel: '',
        inputValue: '',
        onInputChange: () => {},
        onAttachmentsChange,
        onSubmit: () => {},
      } as never),
    ),
  ))
}

describe('FreeFormInput long-text paste conversion heads-up', () => {
  it('fires an info toast with the resolved copy and the generated .txt name', () => {
    const attachmentLists: unknown[][] = []
    const view = mount((list) => { attachmentLists.push(list) })

    fireEvent.click(screen.getByTestId('rich-input-stub'))

    // Exactly ONE heads-up, at info level (not an error).
    expect(toastCalls.length).toBe(1)
    expect(toastCalls[0]!.level).toBe('info')
    // The copy is the i18n source ({{name}} interpolated with the .txt name),
    // NOT a hardcoded string.
    expect(toastCalls[0]!.message).toBe(String(i18n.t('chatInput.pasteConvertedToFile', { name: 'pasted-text-1.txt' })))
    expect(toastCalls[0]!.message).toContain('pasted-text-1.txt')
    // The conversion itself still happened: a text attachment flows out.
    const emitted = attachmentLists.some(list =>
      (list as Array<{ name?: string; type?: string }>).some(
        a => a.name === 'pasted-text-1.txt' && a.type === 'text',
      ),
    )
    expect(emitted).toBe(true)
    view.unmount()
  })

  it('numbers subsequent conversions without re-notifying duplicates', () => {
    const attachmentLists: unknown[][] = []
    const view = mount((list) => { attachmentLists.push(list) })
    const stub = screen.getByTestId('rich-input-stub')

    fireEvent.click(stub)
    fireEvent.click(stub)

    expect(toastCalls.length).toBe(2)
    expect(toastCalls[1]!.message).toContain('pasted-text-2.txt')
    view.unmount()
  })
})
