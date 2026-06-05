/**
 * Platform Mode UI Filter Utilities
 *
 * Pure functions for hiding LLM configuration UI elements in platform mode.
 * Platform mode is detected via platformMode=true from GET /api/public-config.
 *
 * In platform mode, users should not see LLM connection configuration UI because
 * the server-side PLATFORM_ANTHROPIC_API_KEY handles all LLM connectivity.
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
