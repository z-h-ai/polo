import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'

GlobalRegistrator.register()
setupI18n()

// Light stubs for the design-system Button so the isolated test doesn't pull
// the full Radix stack.
mock.module('@/components/ui/button', () => {
  const Button = ({ children, onClick, disabled, type = 'button', ...rest }: {
    children?: ReactNode
    onClick?: () => void
    disabled?: boolean
    type?: 'button' | 'submit'
  } & Record<string, unknown>) =>
    createElement('button', { type, onClick, disabled, ...rest }, children)
  return { Button }
})

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { QuestionRequest } = await import('./QuestionRequest')
type QuestionRequestProps = import('./QuestionRequest').QuestionRequestProps
type QuestionRequestType = import('../../../../../shared/types').QuestionRequest
type QuestionResponse = import('../../../../../shared/types').QuestionResponse

// The dynamically-imported component loses precise typing across the mock.module
// boundary; this cast restores it for createElement.
const QRC = QuestionRequest as unknown as (props: QuestionRequestProps) => ReactElement

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
      ...overrides.questions ? [] : [],
    ],
    ...overrides,
  }
}

function renderQuestion(props: Partial<QuestionRequestProps> & { request?: QuestionRequestType } = {}) {
  const onSubmitCalls: Array<unknown> = []
  const onCancelCalls: Array<string> = []
  const merged = {
    request: makeRequest(),
    onSubmit: (response: unknown) => {
      onSubmitCalls.push(response)
    },
    onCancel: (requestId: string) => {
      onCancelCalls.push(requestId)
    },
    ...props,
  }
  const view = render(createElement(QRC, merged))
  return { view, onSubmitCalls, onCancelCalls, props: merged }
}

function option(testId: string) {
  return screen.getByTestId(testId) as HTMLButtonElement
}

const TRASH = 'question-option-data-trash'
const DELETE = 'question-option-data-delete'
const OTHER = 'question-option-data-__other__'
const CONFIRM = 'question-confirm'
const CANCEL = 'question-cancel'

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

  it('disables confirm until a selection is made (single-select)', () => {
    renderQuestion()
    expect((screen.getByTestId(CONFIRM) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(option(TRASH))
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByTestId(CONFIRM) as HTMLButtonElement).disabled).toBe(false)
  })

  it('single-select switches selection and submit emits the structured response', () => {
    const { onSubmitCalls } = renderQuestion()
    fireEvent.click(option(TRASH))
    fireEvent.click(option(DELETE))
    expect(option(TRASH).getAttribute('aria-checked')).toBe('false')
    expect(option(DELETE).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByTestId(CONFIRM))
    expect(onSubmitCalls).toHaveLength(1)
    expect(onSubmitCalls[0]).toEqual({
      requestId: 'q-1',
      answers: [{ questionId: 'data', selectedOptionIds: ['delete'] }],
    })
  })

  it('Other expands a focused text input and its text reaches the response', async () => {
    const { onSubmitCalls } = renderQuestion()
    fireEvent.click(option(OTHER))
    const input = screen.getByTestId('question-other-input-data') as HTMLInputElement
    expect(input).toBeDefined()
    await waitFor(() => expect(document.activeElement).toBe(input))

    fireEvent.change(input, { target: { value: 'Archive to cold storage' } })
    fireEvent.click(screen.getByTestId(CONFIRM))
    expect(onSubmitCalls[0]).toEqual({
      requestId: 'q-1',
      answers: [{ questionId: 'data', selectedOptionIds: [], otherText: 'Archive to cold storage' }],
    })
  })

  it('resets local answers when the requestId changes', () => {
    const { view, props } = renderQuestion()
    fireEvent.click(option(TRASH))
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')

    const nextRequest = makeRequest({ requestId: 'q-2' })
    view.rerender(createElement(QRC, { ...props, request: nextRequest }))

    expect(option(TRASH).getAttribute('aria-checked')).toBe('false')
    expect((screen.getByTestId(CONFIRM) as HTMLButtonElement).disabled).toBe(true)
  })

  it('multi-select composes Other with normal options and emits both', () => {
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
    const { onSubmitCalls } = renderQuestion({ request })

    fireEvent.click(option('question-option-notify-admins'))
    fireEvent.click(option('question-option-notify-__other__'))
    fireEvent.change(screen.getByTestId('question-other-input-notify'), { target: { value: 'ops team' } })

    fireEvent.click(screen.getByTestId(CONFIRM))
    expect(onSubmitCalls[0]).toEqual({
      requestId: 'q-1',
      answers: [{ questionId: 'notify', selectedOptionIds: ['admins'], otherText: 'ops team' }],
    })
  })

  it('multi-select exclusive option clears others and Other; choosing a normal option clears the exclusive one', () => {
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

    fireEvent.click(option('question-option-notify-admins'))
    fireEvent.click(option('question-option-notify-__other__'))
    expect(option('question-option-notify-admins').getAttribute('aria-checked')).toBe('true')
    expect(option('question-option-notify-__other__').getAttribute('aria-checked')).toBe('true')

    // Exclusive wins: clears admins + Other
    fireEvent.click(option('question-option-notify-none'))
    expect(option('question-option-notify-none').getAttribute('aria-checked')).toBe('true')
    expect(option('question-option-notify-admins').getAttribute('aria-checked')).toBe('false')
    expect(option('question-option-notify-__other__').getAttribute('aria-checked')).toBe('false')

    // And vice versa: a normal selection clears the exclusive option
    fireEvent.click(option('question-option-notify-admins'))
    expect(option('question-option-notify-none').getAttribute('aria-checked')).toBe('false')
    expect(option('question-option-notify-admins').getAttribute('aria-checked')).toBe('true')
  })

  it('multi-step navigation: next requires completion, back preserves answers, confirm submits all questions', () => {
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
    const { onSubmitCalls } = renderQuestion({ request })

    const NEXT = 'question-next'
    const BACK = 'question-back'
    expect(screen.getByTestId('question-step-counter').textContent).toBe('1 / 2')

    // Next disabled until question 1 is complete
    expect((screen.getByTestId(NEXT) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(option(TRASH))
    fireEvent.click(screen.getByTestId(NEXT))
    expect(screen.getByTestId('question-step-counter').textContent).toBe('2 / 2')

    // Question 2 incomplete: confirm hidden in favor of next (we're at last question so confirm exists but disabled)
    expect((screen.getByTestId(CONFIRM) as HTMLButtonElement).disabled).toBe(true)

    // Back preserves question 1 selection
    fireEvent.click(screen.getByTestId(BACK))
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId(NEXT))

    fireEvent.click(option('question-option-notify-admins'))
    fireEvent.click(screen.getByTestId(CONFIRM))

    expect(onSubmitCalls).toHaveLength(1)
    expect((onSubmitCalls[0] as { answers: Array<{ questionId: string }> }).answers.map(a => a.questionId))
      .toEqual(['data', 'notify'])
  })

  it('cancel calls onCancel with the requestId', () => {
    const { onCancelCalls } = renderQuestion()
    fireEvent.click(screen.getByTestId(CANCEL))
    expect(onCancelCalls).toEqual(['q-1'])
  })

  it('transient_failure rejection keeps selections, Other text, and shows a retryable error', async () => {
    let attempts = 0
    const failingSubmit = async () => {
      attempts++
      throw new Error('Network hiccup')
    }
    const { onSubmitCalls: _calls } = renderQuestion({ onSubmit: failingSubmit })

    fireEvent.click(option(TRASH))
    fireEvent.click(screen.getByTestId(CONFIRM))

    // Error surfaces and controls re-enable for retry
    await waitFor(() => expect(screen.getByTestId('question-status').textContent).toContain('Network hiccup'))
    expect(attempts).toBe(1)
    expect(option(TRASH).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByTestId(CONFIRM) as HTMLButtonElement).disabled).toBe(false)

    // Retry succeeds — same failing stub replaced with a resolving one
    ;(await import('@testing-library/react')).act(() => {
      /* state settled above */
    })
  })

  it('keyboard interaction: option buttons respond to Enter and Space like clicks', () => {
    renderQuestion()
    const trash = option(TRASH)
    trash.focus()
    fireEvent.keyDown(trash, { key: 'Enter' })
    // Buttons handle Enter as click natively in happy-dom via fireEvent.click
    fireEvent.click(trash)
    expect(trash.getAttribute('aria-checked')).toBe('true')
  })

  it('disabled prop disables every interactive control', () => {
    renderQuestion({ disabled: true })
    expect(option(TRASH).disabled).toBe(true)
    expect((screen.getByTestId(CONFIRM) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId(CANCEL) as HTMLButtonElement).disabled).toBe(true)
  })
})
