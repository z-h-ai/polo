/**
 * POO-191: TopBar-side mirror of the assistant shell's left-sidebar / focus
 * mode view state. The bar's brand-slot view controls (sidebar collapse +
 * focus mode, TopBar) need the pressed state, but that state lives in
 * AppShellContent's local React state — these read-only mirrors bridge it.
 *
 * The shell's own state stays the single source of truth: AppShellContent
 * writes here in the same effects that persist the storage keys. `null` means
 * the shell has not mounted in this window yet and the controls render
 * neutral instead of guessing. Per-window by design — this is view state, not
 * shared workspace data, and the renderer's default jotai store keeps each
 * window's mirror independent.
 */

import { atom } from 'jotai'

/** Whether the shell's left sidebar is shown (the user's preference, before focus mode hides it). */
export const workbenchSidebarVisibleAtom = atom<boolean | null>(null)

/** Whether focus mode (sidebar + navigator hidden, CMD+.) is active. */
export const workbenchFocusModeAtom = atom<boolean | null>(null)
