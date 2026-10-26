/**
 * Journey #5 — Goal status-badge mapping.
 *
 * The strip badge is no longer a binary running/paused label: the
 * server-owned pause reason (GoalPauseReason) and the terminal states each
 * get their own honest badge, so 「已暂停」 stops hiding WHY the goal is
 * waiting. Pure mapping over the authoritative GoalRecord — no i18n at module
 * level, no state synthesis.
 */
import type { GoalRecord } from '@polo-ai/shared/protocol'
import { isGoalTerminal } from '@polo-ai/shared/protocol'

export type GoalBadgeState =
  | 'running'
  | 'verifying'
  | 'awaiting-user'
  | 'paused-error'
  | 'paused-no-progress'
  | 'paused-restart-required'
  | 'paused'
  | 'completed'
  | 'ended'

export interface GoalBadgeMeta {
  labelKey: string
  /** Tailwind classes for the badge pill (bg/text, border for emphasis). */
  className: string
  /** True when the badge must visually stand out (awaiting-user highlight). */
  emphasized?: boolean
  /** Optional title/aria hint explaining what unblocks the goal. */
  hintKey?: string
}

export const GOAL_BADGE_META: Record<GoalBadgeState, GoalBadgeMeta> = {
  running: {
    labelKey: 'goal.statusRunning',
    className: 'bg-success/10 text-success',
  },
  verifying: {
    labelKey: 'goal.statusVerifying',
    className: 'bg-accent/10 text-accent',
  },
  'awaiting-user': {
    labelKey: 'goal.statusAwaitingUser',
    className: 'bg-accent/15 text-accent ring-1 ring-accent/40',
    emphasized: true,
    hintKey: 'goal.awaitingUserHint',
  },
  'paused-error': {
    labelKey: 'goal.statusPausedError',
    className: 'bg-destructive/10 text-destructive',
  },
  'paused-no-progress': {
    labelKey: 'goal.statusPausedNoProgress',
    className: 'bg-info/10 text-info',
  },
  'paused-restart-required': {
    labelKey: 'goal.statusPausedRestartRequired',
    className: 'bg-info/10 text-info',
  },
  paused: {
    labelKey: 'goal.statusPaused',
    className: 'bg-foreground/5 text-muted-foreground',
  },
  completed: {
    labelKey: 'goal.statusCompleted',
    className: 'bg-success/10 text-success',
  },
  ended: {
    labelKey: 'goal.statusEnded',
    className: 'bg-foreground/5 text-muted-foreground',
  },
}

/** Single mapping point from the authoritative record to the badge state. */
export function goalBadgeState(goal: Pick<GoalRecord, 'status' | 'pauseReason'>): GoalBadgeState {
  if (goal.status === 'active') return 'running'
  if (goal.status === 'verifying') return 'verifying'
  if (goal.status === 'completed') return 'completed'
  if (goal.status === 'ended') return 'ended'
  // paused — the reason picks the specific badge; unknown/absent reasons stay
  // on the plain paused badge instead of guessing.
  switch (goal.pauseReason) {
    case 'awaiting_user': return 'awaiting-user'
    case 'error': return 'paused-error'
    case 'no_progress': return 'paused-no-progress'
    case 'restart_required': return 'paused-restart-required'
    default: return 'paused'
  }
}

/** True when the goal record is kept read-only after its lifecycle ended. */
export function isGoalRecordTerminal(goal: Pick<GoalRecord, 'status'>): boolean {
  return isGoalTerminal(goal.status)
}
