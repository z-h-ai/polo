/**
 * Helpers for consuming Claude SDK `query()` streams for the call_llm tool.
 *
 * Extracted from `ClaudeAgent.queryLlm` so the max-turns / partial-output
 * handling can be unit-tested without standing up a full ClaudeAgent.
 */

import type { SDKMessage, SDKResultError, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import type { LLMQueryResult } from './llm-tool.ts';

type SdkResultErrorSubtype = SDKResultError['subtype'];

const ERROR_SUBTYPE_LABELS: Record<SdkResultErrorSubtype, string> = {
  error_max_turns: 'Model stopped at max turns',
  error_max_budget_usd: 'Model stopped at budget cap',
  error_max_structured_output_retries: 'Structured output retries exhausted',
  error_during_execution: 'Model errored during execution',
};

/** Format an SDK error-result into a one-line human warning. */
export function summarizeSdkError(r: SDKResultError): string {
  const base = ERROR_SUBTYPE_LABELS[r.subtype] ?? `Model stopped (${r.subtype})`;
  const extra = r.errors?.length ? ` — ${r.errors.join('; ')}` : '';
  return `${base}${extra} (num_turns=${r.num_turns})`;
}

/**
 * Consume an SDK `query()` async iterable and return the accumulated
 * assistant text (or structured output) plus an optional warning.
 *
 * Handles both shapes the SDK emits on non-success completions:
 * - Yielded `result` message with an error subtype (e.g. `error_max_turns`).
 * - Thrown exception mid-stream (SDK's current behavior for max-turns).
 *
 * Re-throws when nothing was salvaged, so callers still see a hard failure
 * for genuinely broken cases (auth, network, etc.).
 */
export async function consumeLlmQueryMessages(
  iter: AsyncIterable<SDKMessage>,
  onDebug?: (msg: string) => void,
): Promise<LLMQueryResult> {
  let text = '';
  let structuredOutput: unknown = undefined;
  let warning: string | undefined;
  // REAL attribution (POO-134 F8): surface whatever the SDK result actually
  // reports — the model that answered and the tokens it consumed — so a Goal
  // verification receipt can name what it paid for. Read defensively from the
  // result message only; values are NEVER fabricated and stay absent when the
  // SDK omits them (the attempt-7 real run exposed exactly this gap: a
  // completed goal whose verification receipt carried no model/usage).
  let model: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    for await (const msg of iter) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            text += block.text;
          }
        }
      }
      if (msg.type === 'result') {
        const resultMsg = msg as SDKResultSuccess | SDKResultError;
        const reported = resultMsg as unknown as {
          model?: unknown;
          usage?: { input_tokens?: unknown; output_tokens?: unknown };
        };
        if (typeof reported.model === 'string' && reported.model) model = reported.model;
        if (typeof reported.usage?.input_tokens === 'number') inputTokens = reported.usage.input_tokens;
        if (typeof reported.usage?.output_tokens === 'number') outputTokens = reported.usage.output_tokens;
        if (resultMsg.subtype === 'success') {
          structuredOutput = (resultMsg as SDKResultSuccess).structured_output;
        } else {
          const errorMsg = resultMsg as SDKResultError;
          warning = summarizeSdkError(errorMsg);
          onDebug?.(
            `[queryLlm] SDK result subtype=${errorMsg.subtype}` +
            ` num_turns=${errorMsg.num_turns}` +
            ` stop_reason=${errorMsg.stop_reason}` +
            ` errors=${JSON.stringify(errorMsg.errors ?? [])}`,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onDebug?.(`[queryLlm] SDK threw: ${message} (accumulated ${text.length} chars of partial text)`);
    if (!text.trim() && structuredOutput === undefined) {
      throw error;
    }
    warning = `Model stopped early: ${message}`;
  }

  const attribution = {
    ...(model ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
  if (structuredOutput !== undefined) {
    return { text: JSON.stringify(structuredOutput, null, 2), warning, ...attribution };
  }
  return { text: text.trim(), warning, ...attribution };
}
