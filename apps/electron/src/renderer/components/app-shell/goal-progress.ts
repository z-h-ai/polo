/**
 * POO-134 Goal strip time helpers.
 *
 * Thin presentation layer over the authoritative server protocol: the
 * renderer never owns Goal state, it only re-evaluates and formats what the
 * server reports (`elapsedMs` + `runningSince` via `computeGoalElapsedMs`).
 */
import { computeGoalElapsedMs, type GoalRecord } from '@polo-ai/shared/protocol'

/** Live accumulated runtime for the strip clock, re-evaluated per tick. */
export function goalElapsedMs(goal: GoalRecord, now: number): number {
  return computeGoalElapsedMs(goal, now)
}

/**
 * Format accumulated milliseconds as `h:mm:ss` (or `m:ss` under one hour).
 * Pure numeric clock formatting — locale-independent by design.
 */
export function formatGoalElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
