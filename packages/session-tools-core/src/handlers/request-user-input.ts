/**
 * request_user_input Handler
 *
 * Pauses agent execution by surfacing a structured question request to the
 * desktop UI via the SessionToolCallbacks.onQuestionRequested hook.
 *
 * The callback is AWAITED end-to-end: the SessionManager's durable
 * persist+flush+handoff must complete before this handler reports success.
 * Any failure (validation, persistence, handoff) rejects/throws and is
 * converted into a tool error — the model never sees a "paused" success
 * while the pending question is not yet authoritative on disk.
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

  try {
    // Await the durable handoff — a slow or failed callback blocks the tool
    // result; a rejection becomes an error response (never a fake "paused").
    await ctx.callbacks.onQuestionRequested(questions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(
      `request_user_input failed: ${message}. The question was NOT shown to the user and execution was NOT paused. `
      + 'You may retry the tool or continue with a plain-text question.'
    );
  }

  return successResponse(
    'Waiting for user input. The question has been shown to the user and execution is paused. '
    + 'The conversation will resume automatically with the user\'s answers (or their decision to skip). '
    + 'Do not output any further content — wait for the next turn.'
  );
}
