import type { SdkAutomationCallback } from '../automations/types.ts';
import { blockWithReason } from './mode-manager.ts';

/** Protect the whole SDK hook, including filesystem access and early returns. */
export function guardCanonicalToolHook(
  check: (name: string, input: Record<string, unknown>) => Promise<string | null>,
  hook: SdkAutomationCallback,
): SdkAutomationCallback {
  return async (input, toolUseId, options) => {
    if (input.hook_event_name !== 'PreToolUse' || !input.tool_name) return hook(input, toolUseId, options);
    const original = input.tool_input ?? {};
    const before = await check(input.tool_name, original);
    if (before || options.signal?.aborted) return blockWithReason(before ?? 'The original tool turn was aborted');
    const result = await hook(input, toolUseId, options);
    if (!result.continue) return result;
    const actual = (result as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } }).hookSpecificOutput?.updatedInput ?? original;
    const after = await check(input.tool_name, actual);
    return after || options.signal?.aborted ? blockWithReason(after ?? 'The original tool turn was aborted') : result;
  };
}
