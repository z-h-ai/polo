import type { SdkAutomationCallback } from '../automations/types.ts';
import { blockWithReason } from './mode-manager.ts';

/** Protect the whole SDK hook, including filesystem access and early returns. */
export function guardCanonicalToolHook(
  check: (name: string, input: Record<string, unknown>) => Promise<string | null>,
  hook: SdkAutomationCallback,
  originalQuerySignal: AbortSignal,
): SdkAutomationCallback {
  return async (input, toolUseId, options) => {
    if (input.hook_event_name !== 'PreToolUse' || !input.tool_name) return hook(input, toolUseId, options);
    if (originalQuerySignal.aborted || options.signal?.aborted) return blockWithReason('The original tool query was ended or aborted');
    const original = input.tool_input ?? {};
    const before = await check(input.tool_name, original);
    if (before || originalQuerySignal.aborted || options.signal?.aborted) return blockWithReason(before ?? 'The original tool query was ended or aborted');
    const result = await hook(input, toolUseId, options);
    if (!result.continue) return result;
    if (originalQuerySignal.aborted || options.signal?.aborted) return blockWithReason('The original tool query was ended or aborted');
    const actual = (result as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } }).hookSpecificOutput?.updatedInput ?? original;
    const after = await check(input.tool_name, actual);
    return after || originalQuerySignal.aborted || options.signal?.aborted ? blockWithReason(after ?? 'The original tool query was ended or aborted') : result;
  };
}
