/**
 * Right-side canvas pane state (POO-115): which GenUI app, if any, a chat
 * session has expanded out of its inline card, plus the pane width the user
 * last dragged for that session.
 *
 * Process-local by design: the pane is a session-scoped workspace affordance
 * (same ephemeral `genui-app-<sessionId>` partition as the inline card), so
 * there is nothing to persist across restarts — the width only needs to
 * survive session switches within a running app.
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'

export interface CanvasPaneApp {
  appId: string
  title: string
  /**
   * Absolute bundle path. The pane only hosts real bundles — cards built from
   * a data: fallback have no identity and never get a canvas entry.
   */
  indexPath: string
  version?: number
}

export const CANVAS_PANE_MIN_RATIO = 0.25
export const CANVAS_PANE_MAX_RATIO = 0.7
export const CANVAS_PANE_DEFAULT_RATIO = 0.45

/** Clamp a drag/keyboard width ratio into the pane's allowed band. */
export function clampCanvasPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return CANVAS_PANE_DEFAULT_RATIO
  return Math.min(CANVAS_PANE_MAX_RATIO, Math.max(CANVAS_PANE_MIN_RATIO, ratio))
}

/**
 * Per-session pane content; null = closed. One app at a time per session:
 * opening another app overwrites this, and the replaced card restores itself
 * from the state broadcast.
 */
export const canvasPaneAppAtomFamily = atomFamily((_sessionId: string) =>
  atom<CanvasPaneApp | null>(null),
)

/** Per-session pane width ratio, remembered across open/close within the run. */
export const canvasPaneWidthAtomFamily = atomFamily((_sessionId: string) =>
  atom(CANVAS_PANE_DEFAULT_RATIO),
)
