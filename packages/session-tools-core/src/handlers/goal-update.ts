/**
 * goal_update Handler (POO-134)
 *
 * The ONE structured reporting channel a Goal turn has. It validates the
 * model's report against the canonical schema and forwards it to the host —
 * it NEVER writes Goal authority state itself. The server's GoalController is
 * the only writer, and it applies a report only after matching the report to a
 * successful goal_update tool_result of the SAME turn, bound to the GoalID /
 * runGeneration captured when that turn started.
 *
 * Like request_user_input, the generation is snapshotted at TOOL-CALL
 * INITIATION (first statement, before any await) and carried immutably, so a
 * late report can never borrow a newer turn's generation.
 */

import type { SessionToolContext, ToolResult } from '../index.ts';
import { errorResponse, successResponse } from '../response.ts';
import {
  GOAL_UPDATE_TOOL_NAME,
  parseGoalUpdateArgs,
  serializeGoalUpdateReport,
  type GoalUpdateReport,
} from '../goal-types.ts';

/** Kind-specific acknowledgement the model reads after the report payload. */
function acknowledgement(report: GoalUpdateReport): string {
  switch (report.kind) {
    case 'progress':
      return 'Progress recorded. Continue working on the goal. All todos being checked off does NOT complete the goal — report kind "candidate" with real evidence when you believe every requirement is satisfiable.';
    case 'clarification':
      return 'Report recorded. The goal is paused while waiting for the user. Stop working and end this turn; do not keep retrying. The user\'s next reply arrives in this same conversation as a supplement to the SAME goal.';
    case 'candidate':
      return 'Candidate recorded. The server will now verify the evidence independently against every requirement. Do not claim completion yourself; continue only if asked.';
  }
}

export async function handleGoalUpdate(ctx: SessionToolContext, args: unknown): Promise<ToolResult> {
  const parsed = parseGoalUpdateArgs(args);
  if (!parsed.ok) {
    return errorResponse(`Invalid ${GOAL_UPDATE_TOOL_NAME} arguments: ${parsed.error}`);
  }

  if (typeof ctx.callbacks.onGoalUpdateReport !== 'function') {
    return errorResponse(
      `${GOAL_UPDATE_TOOL_NAME} is not available in this session: there is no active goal on this turn. `
      + 'Summarize progress in plain text instead.'
    );
  }

  const report = parsed.data;

  // GENERATION SNAPSHOT: bound at TOOL-CALL INITIATION — the first read,
  // before any await — and carried immutably through the callback chain.
  const generationAtRequest = ctx.getTurnGeneration ? ctx.getTurnGeneration() : 0;

  try {
    // Await the host: the report must be durably accounted for before this
    // tool reports success. A rejection surfaces as a tool error, never as a
    // fake "recorded".
    await ctx.callbacks.onGoalUpdateReport(report, generationAtRequest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(
      `${GOAL_UPDATE_TOOL_NAME} failed: ${message}. The report was NOT applied to the goal. `
      + 'Do not treat the goal as advanced; continue working or report again.'
    );
  }

  return successResponse(`${acknowledgement(report)}\n${serializeGoalUpdateReport(report)}`);
}
