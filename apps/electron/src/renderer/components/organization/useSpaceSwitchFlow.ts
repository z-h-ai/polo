import * as React from 'react'
import { useOptionalOrganizationContext } from '@/context/OrganizationContext'

/** Type of a running activity that a space switch would terminate. */
export type RunningActivityKind = 'app' | 'assistant'

/** A running item in the current space (App task or assistant generation). */
export interface RunningActivity {
  id: string
  kind: RunningActivityKind
  /** Display name shown in the stop list (e.g. 数据报表生成器). */
  name: string
  /** Short status line under the name (e.g. 同空间后台运行). */
  detail?: string
}

/** Per-item stop status inside an in-flight switch transaction. */
export type RunningActivityStatus = 'running' | 'stopping' | 'stopped' | 'failed'

export interface RunningActivityEntry extends RunningActivity {
  status: RunningActivityStatus
}

/** Minimal switch target — space rows pass their summary's id and name. */
export interface SpaceSwitchTarget {
  id: string
  name: string
}

/**
 * Transaction phases (prototype M02):
 * idle → confirm → stopping → stopFailed → stopCancel → targetLoading →
 * targetFailed → done, plus the revoked-target explanation (accessLost).
 */
export type SpaceSwitchPhase =
  | 'idle'
  | 'confirm'
  | 'stopping'
  | 'stopFailed'
  | 'stopCancel'
  | 'targetLoading'
  | 'targetFailed'
  | 'accessLost'
  | 'done'

/** Result of loading the target space (catalog / permissions / metering / assistant). */
export type TargetLoadOutcome =
  | { ok: true }
  | { ok: false; cause: 'load-error' | 'access-lost' }

/** Environment operations the flow orchestrates; all optional for demos/tests. */
export interface SpaceSwitchFlowDeps {
  /** Running activities in the current space, snapshot at request time. */
  getRunningActivities?: () => RunningActivity[]
  /** Stop one activity; resolve false (or throw) on failure. */
  stopActivity?: (activity: RunningActivity) => Promise<boolean>
  /** Load the target space before committing the switch. */
  loadTargetSpace?: (target: SpaceSwitchTarget) => Promise<TargetLoadOutcome>
  /** Commit the switch — only called after all stops and the load succeeded. */
  commitSwitch?: (target: SpaceSwitchTarget) => void | Promise<void>
  /** stopCancel 「返回首页」 — navigation side effect, optional. */
  onBackHome?: () => void
  /** stopCancel 「重新选择空间」 — navigation side effect, optional. */
  onReselect?: () => void
}

export interface SpaceSwitchFlowState {
  phase: SpaceSwitchPhase
  target: SpaceSwitchTarget | null
  /** Stop-ledger locked at request time (C-R03: progress reflects this set only). */
  activities: RunningActivityEntry[]
  /** Run token this state belongs to; late async writes must match it. */
  runId: number
}

const IDLE_STATE: SpaceSwitchFlowState = { phase: 'idle', target: null, activities: [], runId: 0 }

export interface SpaceSwitchFlowApi extends SpaceSwitchFlowState {
  /** Entry point — AccountMenu 「切换空间」 row (direct switch when idle ledger is empty). */
  requestSwitch: (target: SpaceSwitchTarget) => void
  /** Confirm dialog primary: stop everything, then load and commit. */
  confirmStop: () => void
  /** Cancel the switch. Already-stopped items stay stopped (C-R04). */
  cancelSwitch: () => void
  /** stopFailed primary: retry only the failed items. */
  retryFailedStops: () => void
  /** targetFailed primary: retry loading the target. */
  retryLoad: () => void
  /** targetFailed secondary: stay in the current space. */
  stayInCurrentSpace: () => void
  /** Close the flow after stopCancel / accessLost / done. */
  dismiss: () => void
  /** stopCancel 「返回首页」: dismiss + optional navigation side effect. */
  backHome: () => void
  /** stopCancel 「重新选择空间」: dismiss + optional navigation side effect. */
  reselectSpace: () => void
  /** Active space display name (read-only from the organization context). */
  currentSpaceName: string
  /** Ledger accounting: successfully stopped item count. */
  stoppedCount: number
  /** Ledger accounting: items not stopped (still running or failed). */
  remainingRunningCount: number
  /** Stopped fraction 0..1 for the progress track. */
  stopProgress: number
}

/**
 * useSpaceSwitchFlowMachine — the space-switch transaction state machine
 * (prototype M02, review story 2). Stop → load → commit, sequential per item,
 * with a run token so cancelled/abandoned transactions never write state.
 */
export function useSpaceSwitchFlowMachine(deps: SpaceSwitchFlowDeps = {}): SpaceSwitchFlowApi {
  const [state, setState] = React.useState<SpaceSwitchFlowState>(IDLE_STATE)
  const runIdRef = React.useRef(0)
  const stateRef = React.useRef(state)
  stateRef.current = state

  const patch = React.useCallback((patched: Partial<SpaceSwitchFlowState>) => {
    setState((previous) => ({ ...previous, ...patched }))
  }, [])

  const reset = React.useCallback(() => {
    runIdRef.current += 1
    setState(IDLE_STATE)
  }, [])

  const loadTarget = React.useCallback(async (target: SpaceSwitchTarget, runId: number) => {
    patch({ phase: 'targetLoading' })
    let outcome: TargetLoadOutcome = { ok: true }
    try {
      outcome = deps.loadTargetSpace ? await deps.loadTargetSpace(target) : { ok: true }
    } catch {
      outcome = { ok: false, cause: 'load-error' }
    }
    if (runIdRef.current !== runId) return
    if (outcome.ok) {
      let committed = true
      try {
        await deps.commitSwitch?.(target)
      } catch {
        committed = false
      }
      if (runIdRef.current !== runId) return
      if (!committed) {
        // A failed commit leaves the user in the current space — same surface
        // as a failed load (retry or stay).
        setState((previous) => ({ ...previous, phase: 'targetFailed' }))
        return
      }
      setState((previous) => ({ ...previous, phase: 'done' }))
    } else if (outcome.cause === 'access-lost') {
      setState((previous) => ({ ...previous, phase: 'accessLost' }))
    } else {
      setState((previous) => ({ ...previous, phase: 'targetFailed' }))
    }
  }, [deps, patch])

  /** Sequential stop pass over the ledger. Already-stopped items are skipped
   *  (retry only acts on failed/unfinished items; stopped items never revive). */
  const runStopPass = React.useCallback(async (target: SpaceSwitchTarget, runId: number) => {
    patch({ phase: 'stopping' })
    const ledger = stateRef.current.activities.map((entry) => ({ ...entry }))
    for (let index = 0; index < ledger.length; index += 1) {
      const entry = ledger[index]
      if (entry.status === 'stopped') continue
      ledger[index] = { ...entry, status: 'stopping' }
      setState((previous) => ({ ...previous, activities: ledger.slice() }))
      let stopped = true
      try {
        stopped = deps.stopActivity ? await deps.stopActivity(entry) : true
      } catch {
        stopped = false
      }
      if (runIdRef.current !== runId) {
        // Transaction abandoned (cancelled). A late SUCCESS still happened in
        // the world — record it on this transaction's ledger, but never touch
        // the phase (C-R04: finished stops are not undone). Guarded on the
        // state's runId so a newer requestSwitch's ledger is never touched.
        if (stopped) {
          setState((previous) => {
            if (previous.runId !== runId) return previous
            return {
              ...previous,
              activities: previous.activities.map((item) =>
                item.id === entry.id ? { ...item, status: 'stopped' } : item,
              ),
            }
          })
        }
        return
      }
      ledger[index] = { ...entry, status: stopped ? 'stopped' : 'failed' }
      setState((previous) => ({ ...previous, activities: ledger.slice() }))
    }
    if (runIdRef.current !== runId) return
    const unfinished = ledger.some((entry) => entry.status !== 'stopped')
    if (unfinished) {
      setState((previous) => ({ ...previous, phase: 'stopFailed' }))
    } else {
      await loadTarget(target, runId)
    }
  }, [deps, loadTarget, patch])

  const requestSwitch = React.useCallback((target: SpaceSwitchTarget) => {
    runIdRef.current += 1
    const runId = runIdRef.current
    const activities: RunningActivityEntry[] = (deps.getRunningActivities?.() ?? []).map(
      (activity) => ({ ...activity, status: 'running' }),
    )
    setState({ phase: 'confirm', target, activities, runId })
    // No running items → direct switch (R9): skip the stop transaction entirely.
    if (activities.length === 0) {
      void loadTarget(target, runId)
    }
  }, [deps, loadTarget])

  const confirmStop = React.useCallback(() => {
    const { phase, target } = stateRef.current
    if (phase !== 'confirm' || !target) return
    void runStopPass(target, runIdRef.current)
  }, [runStopPass])

  const retryFailedStops = React.useCallback(() => {
    const { phase, target } = stateRef.current
    if (phase !== 'stopFailed' || !target) return
    void runStopPass(target, runIdRef.current)
  }, [runStopPass])

  const cancelSwitch = React.useCallback(() => {
    const { phase } = stateRef.current
    if (phase === 'confirm') {
      reset()
      return
    }
    if (phase === 'stopping' || phase === 'stopFailed' || phase === 'targetLoading') {
      // Cancelling abandons the transaction; in-flight items keep running.
      runIdRef.current += 1
      setState((previous) => ({
        ...previous,
        phase: 'stopCancel',
        activities: previous.activities.map((entry) =>
          entry.status === 'stopping' ? { ...entry, status: 'running' } : entry,
        ),
      }))
    }
  }, [reset])

  const retryLoad = React.useCallback(() => {
    const { phase, target } = stateRef.current
    if (phase !== 'targetFailed' || !target) return
    void loadTarget(target, runIdRef.current)
  }, [loadTarget])

  const backHome = React.useCallback(() => {
    reset()
    deps.onBackHome?.()
  }, [deps, reset])

  const reselectSpace = React.useCallback(() => {
    reset()
    deps.onReselect?.()
  }, [deps, reset])

  // Read-only: the flow never mutates the organization context, it only needs
  // the active space name for the "当前仍在 …" copy.
  const organization = useOptionalOrganizationContext()
  const currentSpaceName =
    organization?.organizationSummaries.find((item) => item.id === organization.activeOrganizationId)
      ?.name ?? ''

  const stoppedCount = state.activities.filter((entry) => entry.status === 'stopped').length
  const total = state.activities.length
  const stopProgress = total > 0 ? stoppedCount / total : 0

  return {
    ...state,
    requestSwitch,
    confirmStop,
    cancelSwitch,
    retryFailedStops,
    retryLoad,
    stayInCurrentSpace: reset,
    dismiss: reset,
    backHome,
    reselectSpace,
    currentSpaceName,
    stoppedCount,
    remainingRunningCount: total - stoppedCount,
    stopProgress,
  }
}

const SpaceSwitchFlowContext = React.createContext<SpaceSwitchFlowApi | null>(null)

/**
 * SpaceSwitchFlowProvider — mounts the switch transaction on top of the
 * existing organization context (no changes to OrganizationContext itself).
 * Integration: wrap the app shell once and call
 * `useSpaceSwitchFlow().requestSwitch(target)` from the AccountMenu space rows.
 */
export function SpaceSwitchFlowProvider({
  deps,
  children,
}: {
  deps?: SpaceSwitchFlowDeps
  children: React.ReactNode
}) {
  const flow = useSpaceSwitchFlowMachine(deps)
  return React.createElement(SpaceSwitchFlowContext.Provider, { value: flow }, children)
}

/** Consumer of the mounted space-switch transaction. */
export function useSpaceSwitchFlow(): SpaceSwitchFlowApi {
  const flow = React.useContext(SpaceSwitchFlowContext)
  if (!flow) {
    throw new Error('useSpaceSwitchFlow must be used within SpaceSwitchFlowProvider')
  }
  return flow
}
