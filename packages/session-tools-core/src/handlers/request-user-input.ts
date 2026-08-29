/**
 * request_user_input Handler
 *
 * Pauses agent execution by surfacing a structured question request to the
 * desktop UI via the SessionToolCallbacks.onQuestionRequested hook.
 *
 * The SessionManager owns requestId generation, persistence, and the handoff
 * that stops the current turn; this handler only validates the protocol and
 * forwards the normalized questions.
 */

import type { SessionToolContext, ToolResult } from '../index.ts';
import { errorResponse, successResponse } from '../response.ts';
import { parseRequestUserInputArgs, type RequestUserInputQuestionArgs } from '../question-types.ts';

export async function handleRequestUserInput(ctx: SessionToolContext, args: unknown): Promise<ToolResult> {
  const parsed = parseRequestUserInputArgs(args);
  if (!parsed.ok) {
    return errorResponse(`Invalid request_user_input arguments: ${parsed.error}`);
  }

  if (typeof ctx.callbacks.onQuestionRequested !== 'function') {
    return errorResponse(
      'request_user_input is not available in this session. Ask the user your question as plain text instead.'
    );
  }

  const questions: RequestUserInputQuestionArgs[] = parsed.data.questions;
  ctx.callbacks.onQuestionRequested(questions);

  return successResponse(
    'Waiting for user input. The question has been shown to the user and execution is paused. '
    + 'The conversation will resume automatically with the user\'s answers (or their decision to skip). '
    + 'Do not output any further content — wait for the next turn.'
  );
}
