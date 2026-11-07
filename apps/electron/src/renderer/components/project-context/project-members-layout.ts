import { PANEL_MIN_WIDTH } from '@/components/app-shell/panel-constants'

/**
 * POO-196 R3 (adjudication D8, consensus P8) — the project members panel's
 * adaptive form-factor. 推挤 (push, non-modal) is the DEFAULT because the
 * Feishu-style reference keeps members and the conversation visible
 * side-by-side; an overlay drawer is the safe degradation for narrow shells
 * and when a native tool pane (browser/canvas/file-preview) occupies the
 * right column. The switch is deterministic (no timers) with a hysteresis
 * band so measurement jitter at the boundary can never flip-flop the mode —
 * and it never collapses the user's navigation to make room.
 */

/** The conversation must keep at least this much width for members to push.
 * Takes the stricter of the panel floor (440) and the R3 members threshold
 * (480); the generic right-pane MIN_CHAT_WIDTH=360 stays untouched. */
export const PROJECT_MEMBERS_MIN_CHAT_WIDTH = Math.max(PANEL_MIN_WIDTH, 480)

/** Target panel width (border box). Drawer mode clamps to the viewport. */
export const PROJECT_MEMBERS_PANEL_WIDTH = 320

/** Re-open gap: a drawer only upgrades back to push once the net width
 * clears the threshold PLUS this band (dead zone 480–503 keeps the mode). */
export const PROJECT_MEMBERS_HYSTERESIS = 24

export type ProjectMembersMode = 'push' | 'drawer'

export interface ProjectMembersModeInput {
  /** Outer shell width; below the shared compact threshold everything is a drawer. */
  shellWidth: number
  /** Content-box width of the chat lane measured BEFORE inserting the panel
   * (navigation, session list, gaps and borders already deducted). */
  chatLaneWidth: number
  /** Actual border-box width the members panel will occupy (default 320). */
  panelWidth?: number
  /** Measured layout gap the insertion introduces (default 0). */
  gapWidth?: number
  /** A browser/canvas/file-preview pane currently owns the right column. */
  toolPaneOccupied?: boolean
  previousMode?: ProjectMembersMode
}

/** The shell's existing auto-compact threshold. Source of truth stays the
 * app-shell's 768px semantics; kept as a local constant so the layout module
 * has no runtime dependency on component code. */
export const SHELL_COMPACT_THRESHOLD = 768

/**
 * Pure mode resolver. Unknown measurements fail closed to the drawer (an
 * overlay can always render; a push with an unmeasured lane can silently
 * squeeze the conversation below readable width).
 */
export function resolveProjectMembersMode(input: ProjectMembersModeInput): ProjectMembersMode {
  const panelWidth = input.panelWidth ?? PROJECT_MEMBERS_PANEL_WIDTH
  const gapWidth = input.gapWidth ?? 0
  const toolPaneOccupied = input.toolPaneOccupied ?? false
  const previousMode = input.previousMode ?? 'push'

  if (input.shellWidth > 0 && input.shellWidth < SHELL_COMPACT_THRESHOLD) return 'drawer'
  if (toolPaneOccupied) return 'drawer'
  if (!(input.chatLaneWidth > 0)) return 'drawer'

  const net = input.chatLaneWidth - panelWidth - gapWidth
  // First open and steady state: push only with the full threshold met.
  if (net >= PROJECT_MEMBERS_MIN_CHAT_WIDTH + (previousMode === 'drawer' ? PROJECT_MEMBERS_HYSTERESIS : 0)) {
    return 'push'
  }
  // Below the floor, push must always degrade immediately.
  if (previousMode === 'push' && net < PROJECT_MEMBERS_MIN_CHAT_WIDTH) return 'drawer'
  // Inside the hysteresis band keep the current mode.
  return previousMode === 'drawer' ? 'drawer' : 'push'
}

/** Drawer width clamped to the real viewport (long locales must still fit). */
export function drawerWidthFor(viewportWidth: number): number {
  return Math.max(0, Math.min(PROJECT_MEMBERS_PANEL_WIDTH, viewportWidth))
}
