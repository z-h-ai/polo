/**
 * Platform Mode UI Filter Utilities
 *
 * Pure functions for hiding LLM configuration UI elements in platform mode.
 * Platform mode is active when the server has PLATFORM_ANTHROPIC_API_KEY set,
 * which is reported via GET /api/public-config → platformMode=true.
 *
 * In platform mode, users should not see LLM connection configuration UI because
 * the server-side key handles all LLM connectivity. This hides:
 * - The "AI" settings page (LLM connections, model management)
 * - Connection picker / model selector
 * - Onboarding API Key / OAuth steps
 *
 * State matrix (from spec §8.3):
 * | platformMode     | LLM Config Nav | LLM Config Page | Model Provider Settings |
 * | true             | hidden         | not rendered    | hidden                  |
 * | false            | visible        | accessible      | visible                 |
 * | loading/error    | hidden (safe)  | not rendered    | hidden (safe)           |
 */

/**
 * Settings pages that should be hidden in platform mode.
 * These are pages that expose LLM connection configuration to end users.
 */
export const PLATFORM_HIDDEN_SETTINGS: readonly string[] = ['ai'] as const

/**
 * Filter a list of settings items to hide LLM-config-related pages in platform mode.
 *
 * @param items - Full list of settings items
 * @param platformMode - Whether platform mode is active
 * @returns Filtered list with LLM config pages removed in platform mode
 */
export function filterSettingsItemsForPlatformMode<T extends { id: string }>(
  items: T[],
  platformMode: boolean,
): T[] {
  if (!platformMode) return items
  return items.filter((item) => !PLATFORM_HIDDEN_SETTINGS.includes(item.id))
}

/**
 * Check if a specific settings page should be hidden in platform mode.
 *
 * @param settingsId - The settings subpage ID (e.g., 'ai', 'app')
 * @param platformMode - Whether platform mode is active
 * @returns true if the page should be hidden
 */
export function isLlmConfigHiddenInPlatformMode(
  settingsId: string,
  platformMode: boolean,
): boolean {
  if (!platformMode) return false
  return PLATFORM_HIDDEN_SETTINGS.includes(settingsId)
}
