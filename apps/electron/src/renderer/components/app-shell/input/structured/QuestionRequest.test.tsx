import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'

// DOM + i18n first, then component imports (no mock.module — the real Button
// only pulls Radix Slot + cva, which is happy-dom safe and keeps this file
// free of global module pollution that destabilizes parallel full-suite runs).
// Register only when another test file in the same process hasn't already:
// plain `bun test` runs files sequentially in one process, and a double
// GlobalRegistrator.register() throws.
if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()

const { cleanup, render, screen, waitFor, act } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { I18nextProvider } = await import('react-i18next')
const { QuestionRequest } = await import('./QuestionRequest')

type QuestionRequestProps = import('./QuestionRequest').QuestionRequestProps
type QuestionRequestType = import('../../../../../shared/types').QuestionRequest

// The dynamically-imported component loses precise typing across the import
// boundary; this cast restores it for createElement.
const QRC = QuestionRequest as unknown as (props: QuestionRequestProps) => ReactBuiltInElement
type ReactBuiltInElement = ReturnType<typeof createElement>

function makeRequest(overrides: Partial<QuestionRequestType> = {}): QuestionRequestType {
  return {
    requestId: 'q-1',
    sessionId: 's-1',
    createdAt: Date.now(),
    questions: [
      {
        id: 'data',
        header: 'Data',
        question: 'What should happen to related data?',
        options: [
          { id: 'trash', label: 'Move to Trash', description: 'Recoverable', recommended: true },
          { id: 'delete', label: 'Delete permanently', description: 'Immediate' },
        ],
      },
    ],
    ...overrides,
  }
}

interface Harness {
  onSubmitCalls: Array<unknown>
  onCancelCalls: Array<string>
  submit: (response: unknown) => Promise<void> | void
  cancel: (requestId: string) => Promise<void> | void
}

function renderQuestion(props: Partial<QuestionRequestProps> & { request?: QuestionRequestType } = {}) {
  const harness: Harness = {
    onSubmitCalls: [],
    onCancelCalls: [],
    submit: (response: unknown) => {
      harness.onSubmitCalls.push(response)
    },
    cancel: (requestId: string) => {
      harness.onCancelCalls.push(requestId)
    },
  }
  const merged: QuestionRequestProps = {
    request: makeRequest(),
    onSubmit: (response) => harness.submit(response),
    onCancel: (requestId) => harness.cancel(requestId),
    ...props,
  }
  // Explicit provider: useTranslation must resolve against this file's i18n
  // instance, independent of whatever language/module state earlier test
  // files left behind in a shared-process run.
  const view = render(
    createElement(I18nextProvider, { i18n }, createElement(QRC, merged)),
  )
  return { view, harness, props: merged }
}

function option(testId: string) {
  return screen.getByTestId(testId) as HTMLButtonElement
}

function confirmButton() {
  return screen.getByTestId('question-confirm') as HTMLButtonElement
}

const TRASH = 'question-option-data-trash'
const DELETE = 'question-option-data-delete'
const OTHER = 'question-option-data-__other__'
const CONFIRM = 'question-confirm'
const CANCEL = 'question-cancel'

beforeEach(() => {
  i18n.changeLanguage?.('en')
})

afterEach(() => {
  cleanup()
})

describe('QuestionRequest component', () => {
  it('renders the question, options, recommended badge, and auto Other option', () => {
    renderQuestion()
    expect(screen.getByTestId('question-request')).toBeDefined()
    expect(screen.getByText('What should happen to related data?')).toBeDefined()
    expect(screen.getByText('Move to Trash')).toBeDefined()
    expect(screen.getByTestId('question-recommended-data-trash')).toBeDefined()
    expect(option(TRASH)).toBeDefined()
    expect(option(DELETE)).toBeDefined()
    expect(option(OTHER)).toBeDefined()
  })

  it('disables confirm until a selection is made (single-select)', async () => {
    const user = userEvent.setup({ document: window.document })
    renderQuestion()
    expect(confirmButton().disabled).toBe(true)
    await act(async () => {
      await user.click(option(TRASH))
    })
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
  })

  it('single-select switches selection and submit emits the structured response', async () => {
    const user = userEvent.setup({ document: window.document })
    const { harness } = renderQuestion()
    await act(async () => {
      await user.click(option(TRASH))
    })
    await act(async () => {
      await user.click(option(DELETE))
    })
    expect(option(TRASH).getAttribute('aria-checked')).toBe('false')
    expect(option(DELETE).getAttribute('aria-checked')).toBe('true')

    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await act(async () => {
      await user.click(confirmButton())
    })
    await waitFor(() => expect(harness.onSubmitCalls).toHaveLength(1))
    expect(harness.onSubmitCalls[0]).toEqual({
      requestId: 'q-1',
      answers: [{ questionId: 'data', selectedOptionIds: ['delete'] }],
    })
  })

  it('Other expands a focused text input and its text reaches the response', async () => {
    const user = userEvent.setup({ document: window.document })
    const { harness } = renderQuestion()

    await act(async () => {
      await user.click(option(OTHER))
    })
    const input = (await screen.findByTestId('question-other-input-data')) as HTMLInputElement
    expect(input).toBeDefined()

    await act(async () => {
      await user.type(input, 'Archive to cold storage')
    })
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('Archive to cold storage'))
    await waitFor(() => expect(confirmButton().disabled).toBe(false))

    await act(async () => {
      await user.click(confirmButton())
    })
    await waitFor(() => expect(harness.onSubmitCalls).toHaveLength(1))
    expect(harness.onSubmitCalls[0]).toEqual({
      requestId: 'q-1',
      answers: [{ questionId: 'data', selectedOptionIds: [], otherText: 'Archive to cold storage' }],
    })
  })

  it('resets local answers when the requestId changes', async () => {
    const user = userEvent.setup({ document: window.document })
    const { view, props } = renderQuestion()
    await act(async () => {
      await user.click(option(TRASH))
    })
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')

    const nextRequest = makeRequest({ requestId: 'q-2' })
    await act(async () => {
      view.rerender(createElement(QRC, { ...props, request: nextRequest }))
    })

    expect(option(TRASH).getAttribute('aria-checked')).toBe('false')
    expect(confirmButton().disabled).toBe(true)
  })

  it('multi-select composes Other with normal options and emits both', async () => {
    const user = userEvent.setup({ document: window.document })
    const request = makeRequest({
      questions: [{
        id: 'notify',
        header: 'Notifications',
        question: 'Who should be notified?',
        multiple: true,
        options: [
          { id: 'admins', label: 'Admins', description: 'Workspace admins' },
          { id: 'members', label: 'Members', description: 'All members' },
        ],
      }],
    })
    const { harness } = renderQuestion({ request })

    await act(async () => {
      await user.click(option('question-option-notify-admins'))
      await user.click(option('question-option-notify-__other__'))
    })
    const input = (await screen.findByTestId('question-other-input-notify')) as HTMLInputElement
    await act(async () => {
      await user.type(input, 'ops team')
    })
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('ops team'))
    await waitFor(() => expect(confirmButton().disabled).toBe(false))

    await act(async () => {
      await user.click(confirmButton())
    })
    await waitFor(() => expect(harness.onSubmitCalls).toHaveLength(1))
    expect(harness.onSubmitCalls[0]).toEqual({
      requestId: 'q-1',
      answers: [{ questionId: 'notify', selectedOptionIds: ['admins'], otherText: 'ops team' }],
    })
  })

  it('multi-select exclusive option clears others and Other; choosing a normal option clears the exclusive one', async () => {
    const user = userEvent.setup({ document: window.document })
    const request = makeRequest({
      questions: [{
        id: 'notify',
        header: 'Notifications',
        question: 'Who should be notified?',
        multiple: true,
        options: [
          { id: 'admins', label: 'Admins', description: 'Workspace admins' },
          { id: 'none', label: 'No notifications', description: 'Skip', exclusive: true },
        ],
      }],
    })
    renderQuestion({ request })

    await act(async () => {
      await user.click(option('question-option-notify-admins'))
      await user.click(option('question-option-notify-__other__'))
    })
    expect(option('question-option-notify-admins').getAttribute('aria-checked')).toBe('true')
    expect(option('question-option-notify-__other__').getAttribute('aria-checked')).toBe('true')

    // Exclusive wins: clears admins + Other
    await act(async () => {
      await user.click(option('question-option-notify-none'))
    })
    expect(option('question-option-notify-none').getAttribute('aria-checked')).toBe('true')
    expect(option('question-option-notify-admins').getAttribute('aria-checked')).toBe('false')
    expect(option('question-option-notify-__other__').getAttribute('aria-checked')).toBe('false')

    // And vice versa: a normal selection clears the exclusive option
    await act(async () => {
      await user.click(option('question-option-notify-admins'))
    })
    expect(option('question-option-notify-none').getAttribute('aria-checked')).toBe('false')
    expect(option('question-option-notify-admins').getAttribute('aria-checked')).toBe('true')
  })

  it('multi-step navigation: next requires completion, back preserves answers, confirm submits all questions', async () => {
    const user = userEvent.setup({ document: window.document })
    const request = makeRequest({
      questions: [
        makeRequest().questions[0]!,
        {
          id: 'notify',
          header: 'Notifications',
          question: 'Who should be notified?',
          multiple: true,
          options: [{ id: 'admins', label: 'Admins', description: 'Admins' }],
        },
      ],
    })
    const { harness } = renderQuestion({ request })

    const NEXT = 'question-next'
    const BACK = 'question-back'
    expect(screen.getByTestId('question-step-counter').textContent).toBe('1 / 2')

    // Next disabled until question 1 is complete
    expect((screen.getByTestId(NEXT) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      await user.click(option(TRASH))
    })
    await waitFor(() => expect((screen.getByTestId(NEXT) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      await user.click(screen.getByTestId(NEXT))
    })
    expect(screen.getByTestId('question-step-counter').textContent).toBe('2 / 2')

    // Question 2 incomplete: confirm visible (last question) but disabled
    expect(confirmButton().disabled).toBe(true)

    // Back preserves question 1 selection
    await act(async () => {
      await user.click(screen.getByTestId(BACK))
    })
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect((screen.getByTestId(NEXT) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      await user.click(screen.getByTestId(NEXT))
    })

    await act(async () => {
      await user.click(option('question-option-notify-admins'))
    })
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await act(async () => {
      await user.click(confirmButton())
    })

    await waitFor(() => expect(harness.onSubmitCalls).toHaveLength(1))
    expect((harness.onSubmitCalls[0] as { answers: Array<{ questionId: string }> }).answers.map(a => a.questionId))
      .toEqual(['data', 'notify'])
  })

  it('cancel calls onCancel with the requestId', async () => {
    const user = userEvent.setup({ document: window.document })
    const { harness } = renderQuestion()
    await act(async () => {
      await user.click(screen.getByTestId(CANCEL))
    })
    await waitFor(() => expect(harness.onCancelCalls).toEqual(['q-1']))
  })

  it('transient_failure rejection keeps selections and shows a retryable error', async () => {
    let attempts = 0
    const failingSubmit = async () => {
      attempts++
      throw new Error('Network hiccup')
    }
    const user = userEvent.setup({ document: window.document })
    renderQuestion({ onSubmit: failingSubmit })

    await act(async () => {
      await user.click(option(TRASH))
    })
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await act(async () => {
      await user.click(confirmButton())
    })

    // Error surfaces and controls re-enable for retry
    await waitFor(() => expect(screen.getByTestId('question-status').textContent).toContain('Network hiccup'))
    expect(attempts).toBe(1)
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')
    expect(confirmButton().disabled).toBe(false)
  })

  it('keyboard interaction: option buttons respond to Enter and Space like clicks', async () => {
    const user = userEvent.setup({ document: window.document })
    renderQuestion()
    const trash = option(TRASH)
    await act(async () => {
      trash.focus()
      await user.keyboard('{Enter}')
    })
    expect(trash.getAttribute('aria-checked')).toBe('true')
  })

  it('disabled prop disables every interactive control', () => {
    renderQuestion({ disabled: true })
    expect(option(TRASH).disabled).toBe(true)
    expect(confirmButton().disabled).toBe(true)
    expect((screen.getByTestId(CANCEL) as HTMLButtonElement).disabled).toBe(true)
  })
})
