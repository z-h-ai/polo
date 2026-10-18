/**
 * Ephemeral tool_input_delta accumulator (P0-2, Wave-1).
 *
 * Renderer-side buffer of the partial render_ui tool input streamed via
 * `tool_input_delta` SessionEvents. The host app's session-event handler
 * (App.tsx in Electron) calls appendGenUiToolInputDelta() and never routes
 * the event anywhere else; TurnCard subscribes per-session via
 * useGenUiToolInputPartials() to feed the skeleton scanner
 * (genuiSkeleton.ts).
 *
 * Deliberately NOT React state at the app level and NOT persisted anywhere:
 * entries live only while the corresponding tool call is in flight, are
 * cleaned up when TurnCard observes the call leave the in-progress set, and
 * vanish on renderer reload. Same ephemeral discipline as ui_state (POO-103).
 */

import { useSyncExternalStore } from 'react'

/** sessionId → toolUseId → accumulated partial input JSON. */
const buffers = new Map<string, Map<string, string>>()

type Listener = () => void
const listeners = new Set<Listener>()

const EMPTY_PARTIALS: ReadonlyMap<string, string> = new Map()

/** Cached immutable snapshot (rebuilt lazily after each mutation). */
let snapshotCache: ReadonlyMap<string, ReadonlyMap<string, string>> | null = null

function snapshot(): ReadonlyMap<string, ReadonlyMap<string, string>> {
  if (!snapshotCache) {
    snapshotCache = new Map(
      [...buffers.entries()].map(([sessionId, byTool]) => [sessionId, new Map(byTool)] as const),
    )
  }
  return snapshotCache
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Append one delta chunk to a tool call's accumulated partial input. */
export function appendGenUiToolInputDelta(sessionId: string, toolUseId: string, delta: string): void {
  if (!sessionId || !toolUseId || !delta) return
  let byTool = buffers.get(sessionId)
  if (!byTool) {
    byTool = new Map()
    buffers.set(sessionId, byTool)
  }
  byTool.set(toolUseId, (byTool.get(toolUseId) ?? '') + delta)
  snapshotCache = null
  notify()
}

/** Forget one tool call's buffer (call finished / failed / left the turn). */
export function clearGenUiToolInputDelta(sessionId: string, toolUseId: string): void {
  const byTool = buffers.get(sessionId)
  if (!byTool || !byTool.has(toolUseId)) return
  byTool.delete(toolUseId)
  if (byTool.size === 0) buffers.delete(sessionId)
  snapshotCache = null
  notify()
}

/** Forget an entire session's buffers (session switched / cleared). */
export function clearGenUiToolInputDeltasForSession(sessionId: string): void {
  if (!buffers.has(sessionId)) return
  buffers.delete(sessionId)
  snapshotCache = null
  notify()
}

/** Subscribe to accumulator changes (useSyncExternalStore protocol). */
export function subscribeGenUiToolInputDeltas(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Current partial inputs for one session (stable reference between mutations). */
export function getGenUiToolInputPartials(sessionId: string | null | undefined): ReadonlyMap<string, string> {
  if (!sessionId) return EMPTY_PARTIALS
  return snapshot().get(sessionId) ?? EMPTY_PARTIALS
}

/**
 * React hook: the session's accumulated partial tool inputs, live. Components
 * reading this re-render at most at the tool_input_delta emission rate
 * (throttled to one per 250ms per in-flight render_ui call, capped at 8KB).
 */
export function useGenUiToolInputPartials(sessionId: string | null | undefined): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    subscribeGenUiToolInputDeltas,
    () => getGenUiToolInputPartials(sessionId),
    () => EMPTY_PARTIALS,
  )
}
