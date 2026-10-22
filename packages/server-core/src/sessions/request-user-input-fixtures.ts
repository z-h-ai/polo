import type { QuestionRequest, QuestionResolution } from '@polo-ai/shared/protocol'

/**
 * Shared fixtures for request_user_input session-manager tests.
 * `sessionId` must match the seeded session id (QuestionRequest.sessionId).
 */
export function makeQuestionRequest(sessionId: string, requestId?: string): QuestionRequest {
  return {
    requestId: requestId ?? `q-${sessionId}`,
    sessionId,
    createdAt: Date.now(),
    questions: [
      {
        id: 'data-handling',
        header: 'Data',
        question: 'What should happen to related data?',
        options: [
          { id: 'trash', label: 'Move to Trash', description: 'Recoverable for 30 days', recommended: true },
          { id: 'delete', label: 'Delete permanently', description: 'Immediate, unrecoverable' },
        ],
      },
      {
        id: 'notify',
        header: 'Notifications',
        question: 'Who should be notified?',
        multiple: true,
        options: [
          { id: 'admins', label: 'Admins', description: 'Workspace admins' },
          { id: 'none', label: 'No notifications', description: 'Skip notifications', exclusive: true },
        ],
      },
    ],
  }
}

/** A valid answer payload for {@link makeQuestionRequest}. */
export function makeAnswerResolution(request: QuestionRequest): Extract<QuestionResolution, { action: 'answer' }> {
  return {
    action: 'answer',
    response: {
      requestId: request.requestId,
      answers: [
        { questionId: 'data-handling', selectedOptionIds: ['delete'] },
        { questionId: 'notify', selectedOptionIds: ['admins'], otherText: 'audit@example.com' },
      ],
    },
  }
}

export function buildQuestionFixtures() {
  return { makeQuestionRequest, makeAnswerResolution }
}
