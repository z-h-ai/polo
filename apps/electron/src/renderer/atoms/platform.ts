/**
 * Platform Mode Atom
 *
 * Tracks whether the WebUI is running in platform mode.
 * Platform mode is set when PLATFORM_ANTHROPIC_API_KEY is configured on the server
 * and reported via GET /api/public-config.
 *
 * Safe default: false (hidden) — matches "loading" and "error" states from the state matrix:
 * | platformMode     | LLM Config Nav | LLM Config Page | Model Provider Settings |
 * | loading (before) | hidden         | not rendered    | hidden                  |
 * | error            | hidden         | not rendered    | hidden                  |
 *
 * Set by: webui/src/App.tsx after fetching /api/public-config
 * Read by: AiSettingsPage, SettingsNavigator (to hide the AI settings entry)
 */

import { atom } from 'jotai'

/**
 * Whether the app is running in platform mode.
 * Defaults to false (safe default — hides LLM config until confirmed).
 */
export const platformModeAtom = atom<boolean>(false)

/**
 * Write-only atom to set the platform mode flag.
 * Used by the webui App component after fetching /api/public-config.
 */
export const setPlatformModeAtom = atom<null, [boolean], void>(
  null,
  (_get, set, value) => {
    set(platformModeAtom, value)
  },
)
