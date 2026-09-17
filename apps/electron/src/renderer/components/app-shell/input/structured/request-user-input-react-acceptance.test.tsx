// RENDERER question-card pipeline test.
//
// Scope: the PRODUCTION renderer contract only — a `question_request` event
// flows through the real event processor (`processEvent`) into the real
// pending-question map helpers App.tsx uses, the MOUNTED QuestionRequest
// component renders the question and submits/cancels with the right
// requestId/answers, and a resolution event clears the card exactly once
// (requestId-guarded). No SessionManager, no agents, no private-method
// overwrites: the REAL Claude/Pi/Pi×Codex outside-in turns (production
// factory + subprocess) are covered by
// `packages/server-core/src/sessions/request-user-input-acceptance.test.ts`.
//
// Visual anchors (question-request / question-option-* / question-confirm /
// question-cancel) are asserted for the E2E smoke selectors.

import { afterEach, describe, expect, it } from 'bun:test'

if (typeof window === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { GlobalRegistrator }: any = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
const { setupI18n, i18n } = await import('@polo-ai/shared/i18n/setupI18n')
setupI18n()

const { cleanup, render, screen, act } = await import('@testing-library/react')
const { I18nextProvider } = await import('react-i18next')
const { createElement } = await import('react')
const { QuestionRequest } = await import('./QuestionRequest')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rendererEvents: any = await import('../../../../event-processor/processor.ts')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rendererPending: any = await import('../../../../lib/pending-questions.ts')

describe('request_user_input renderer question-card pipeline', () => {
  // Production renderer pipeline: events → processEvent → pending map.
  const renderer = (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = new rendererPending.PendingQuestionTerminalGuard()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map = new Map<string, any>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const states = new Map<string, any>()
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pendingOf: (sessionId: string) => map.get(sessionId) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deliver(event: any): void {
        const sessionId = event.sessionId as string
        if (event.type === 'session_deleted') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map = rendererPending.clearPendingQuestionForDeletedSession(map, sessionId, guard)
          return
        }
        if (typeof sessionId !== 'string') return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let state = states.get(sessionId)
        if (!state) {
          state = {
            session: {
              id: sessionId, name: '', createdAt: 0, lastUsedAt: 0, messages: [],
              tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
            },
            streaming: null,
          }
          states.set(sessionId, state)
        }
        const { state: nextState, effects } = rendererEvents.processEvent(state, event)
        states.set(sessionId, nextState)
        for (const effect of effects) {
          if (effect.type === 'question_request') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map = rendererPending.setPendingQuestionForSession(map, sessionId, effect.request, guard)
          } else if (effect.type === 'question_resolved') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map = rendererPending.removePendingQuestionForSession(map, sessionId, effect.requestId, guard)
          }
        }
      },
    }
  })()

  afterEach(() => {
    cleanup()
  })

  function makeRequest(sessionId: string, requestId = 'q-render-1'): any {
    return {
      requestId,
      sessionId,
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
    }
  }

  /**
   * Mount the REAL QuestionRequest card against the pending question from the
   * renderer pipeline; onSubmit/onCancel record the component's outputs (the
   * durable resolution is the server acceptance's contract, not this file's).
   */
  async function mountQuestionCard(sessionId: string) {
    const pending = renderer.pendingOf(sessionId)
    expect(pending).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let submitted: any = null
    let cancelled: string | null = null
    const view = render(
      createElement(
        I18nextProvider,
        { i18n },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createElement(QuestionRequest as any, {
          request: pending,
          onSubmit: async (response: any) => { submitted = response },
          onCancel: async (requestId: string) => { cancelled = requestId },
        }),
      ),
    )
    return {
      view,
      get submitted() { return submitted },
      get cancelled() { return cancelled },
    }
  }

  it('a question_request event renders the card through the production pipeline; the answer submits ONE response with the requestId and the resolution clears the card once', async () => {
    const sessionId = 'render-pipeline-1'
    const request = makeRequest(sessionId)
    renderer.deliver({ type: 'question_request', sessionId, request })
    expect(renderer.pendingOf(sessionId)?.requestId).toBe(request.requestId)

    const card = await mountQuestionCard(sessionId)
    // Visual smoke anchors for the E2E selectors.
    expect(screen.getByTestId('question-request')).toBeDefined()

    await act(async () => {
      (screen.getByTestId('question-option-data-delete') as HTMLButtonElement).click()
    })
    await act(async () => {
      (screen.getByTestId('question-confirm') as HTMLButtonElement).click()
    })
    await act(async () => {})
    // ONE submit with the right identity and the selected answer.
    expect(card.submitted).not.toBeNull()
    expect(card.submitted.requestId).toBe(request.requestId)
    expect(card.submitted.answers).toEqual([
      { questionId: 'data', selectedOptionIds: ['delete'] },
    ])

    // The resolution event clears the card through the pipeline; a repeated
    // (idempotent) resolution keeps it cleared.
    renderer.deliver({ type: 'question_resolved', sessionId, requestId: request.requestId, action: 'answer' })
    expect(renderer.pendingOf(sessionId)).toBeNull()
    renderer.deliver({ type: 'question_resolved', sessionId, requestId: request.requestId, action: 'answer' })
    expect(renderer.pendingOf(sessionId)).toBeNull()
  })

  it('cancel submits the requestId through the pipeline and a STALE resolution never clears a newer card', async () => {
    const sessionId = 'render-pipeline-2'
    const request = makeRequest(sessionId, 'q-render-2')
    renderer.deliver({ type: 'question_request', sessionId, request })
    const card = await mountQuestionCard(sessionId)

    await act(async () => {
      (screen.getByTestId('question-cancel') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(card.cancelled).toBe(request.requestId)
    expect(card.submitted).toBeNull()

    // The card is replaced by a NEWER requestId; the stale resolution of the
    // old card must not clear the newer one (requestId guard).
    const newer = makeRequest(sessionId, 'q-render-2-newer')
    renderer.deliver({ type: 'question_request', sessionId, request: newer })
    expect(renderer.pendingOf(sessionId)?.requestId).toBe(newer.requestId)
    renderer.deliver({ type: 'question_resolved', sessionId, requestId: request.requestId, action: 'cancel' })
    expect(renderer.pendingOf(sessionId)?.requestId).toBe(newer.requestId)
    // The NEWER resolution clears it.
    renderer.deliver({ type: 'question_resolved', sessionId, requestId: newer.requestId, action: 'cancel' })
    expect(renderer.pendingOf(sessionId)).toBeNull()
  })
})
