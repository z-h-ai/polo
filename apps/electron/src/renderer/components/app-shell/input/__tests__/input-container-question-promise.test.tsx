/**
 * InputContainer question resolution — end-to-end promise propagation
 * (review round 3, issue #1).
 *
 * Executed from the REAL InputContainer entry: QuestionRequest submit/cancel
 * must flow through InputContainer.handleStructuredResponse → the
 * onStructuredResponse callback as an AWAITED promise, so a transient
 * rejection surfaces as the component's retryable error state instead of
 * being silently dropped.
 *
 * FreeFormInput is stubbed (heavy tiptap/cmdk tree, irrelevant here);
 * everything else on the question path is the production code.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import * as React from 'react'

// Register only when another test file in the same process hasn't already:
// plain `bun test` runs files sequentially in one process, and a double
// GlobalRegistrator.register() throws.
//
// The userAgent MUST be an explicit macOS UA: happy-dom's default UA embeds
// `process.platform` ("darwin"), and `navigator.platform.includes('win')`
// matches the "darWIN" substring — platform.ts would freeze `isWindows: true`
// for the whole process and break downstream locale/path-separator tests.
if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      },
    },
  })
}
setupI18n()

mock.module('@/components/app-shell/input/FreeFormInput', () => ({
  FreeFormInput: () => createElement('div', { 'data-testid': 'freeform-stub' }),
  useAutoGrow: () => ({}),
}))

const { cleanup, render, screen, waitFor, act } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { I18nextProvider } = await import('react-i18next')
const { InputContainer } = await import('../InputContainer')

type QuestionRequestType = import('../../../../../shared/types').QuestionRequest

const IC = InputContainer as unknown as (props: Record<string, unknown>) => React.ReactElement

function makeRequest(): QuestionRequestType {
  return {
    requestId: 'q-e2e-1',
    sessionId: 's-1',
    createdAt: Date.now(),
    questions: [{
      id: 'data',
      header: 'Data',
      question: 'What should happen to related data?',
      options: [
        { id: 'trash', label: 'Move to Trash', description: 'Recoverable', recommended: true },
        { id: 'delete', label: 'Delete permanently', description: 'Immediate' },
      ],
    }],
  }
}

function renderInputContainer(opts: {
  onStructuredResponse: (response: unknown) => void | Promise<void>
  request?: QuestionRequestType
}) {
  const props = {
    structuredInput: { type: 'question', data: opts.request ?? makeRequest() },
    onStructuredResponse: opts.onStructuredResponse,
    placeholder: 'Message',
    currentModel: 'model',
    inputValue: '',
    onInputChange: () => {},
  }
  return render(createElement(I18nextProvider, { i18n }, createElement(IC, props)))
}

const TRASH = 'question-option-data-trash'
const CONFIRM = 'question-confirm'
const CANCEL = 'question-cancel'

/**
 * InputContainer renders a hidden measuring copy of the structured content
 * (aria-hidden). Queries must target the VISIBLE instance.
 */
function visibleEl(testId: string): HTMLElement {
  const all = screen.getAllByTestId(testId)
  const visible = all.find(el => !el.closest('[aria-hidden="true"]'))
  if (!visible) throw new Error(`No visible element for ${testId}`)
  return visible as HTMLElement
}

beforeEach(() => {
  void i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

describe('InputContainer question promise propagation', () => {
  it('awaits a resolving submit — the caller promise settles through the container', async () => {
    const user = userEvent.setup({ document: window.document })
    let settleCount = 0
    let received: unknown = null
    const renderResult = renderInputContainer({
      onStructuredResponse: async (response) => {
        await new Promise(r => setTimeout(r, 20))
        received = response
        settleCount++
      },
    })
    void renderResult

    await act(async () => {
      await user.click(visibleEl(TRASH))
    })
    await waitFor(() => expect((visibleEl(CONFIRM) as HTMLButtonElement).disabled).toBe(false))

    await act(async () => {
      await user.click(visibleEl(CONFIRM))
    })

    await waitFor(() => expect(received).not.toBeNull())
    expect(settleCount).toBe(1)
    expect((received as { type: string }).type).toBe('question')
    expect((received as { response: { requestId: string } }).response.requestId).toBe('q-e2e-1')
    // No error surfaced on success
    expect(visibleEl('question-status').textContent).toBe('')
  })

  it('propagates a transient submit failure as the component retryable error state', async () => {
    const user = userEvent.setup({ document: window.document })
    let attempts = 0
    renderInputContainer({
      onStructuredResponse: async () => {
        attempts++
        throw new Error('RPC transient failure')
      },
    })

    await act(async () => {
      await user.click(visibleEl(TRASH))
    })
    await waitFor(() => expect((visibleEl(CONFIRM) as HTMLButtonElement).disabled).toBe(false))

    await act(async () => {
      await user.click(visibleEl(CONFIRM))
    })

    // The dropped-promise defect made this unreachable: the error state now
    // surfaces through the container-returned promise.
    await waitFor(() => expect(visibleEl('question-status').textContent).toContain('RPC transient failure'))
    expect(attempts).toBe(1)
    // Selection kept, confirm re-enabled → retry possible
    expect((visibleEl(TRASH) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
    expect((visibleEl(CONFIRM) as HTMLButtonElement).disabled).toBe(false)
  })

  it('propagates cancel through the same channel (skip resolution awaited)', async () => {
    const user = userEvent.setup({ document: window.document })
    const cancelResponses: Array<{ type: string; requestId?: string }> = []
    renderInputContainer({
      onStructuredResponse: async (response) => {
        await new Promise(r => setTimeout(r, 10))
        cancelResponses.push(response as { type: string })
      },
    })

    await act(async () => {
      await user.click(visibleEl(CANCEL))
    })

    await waitFor(() => expect(cancelResponses).toHaveLength(1))
    expect(cancelResponses[0]).toEqual({ type: 'question_cancel', requestId: 'q-e2e-1' })
  })
})
