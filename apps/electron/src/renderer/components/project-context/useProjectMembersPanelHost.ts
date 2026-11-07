import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  PROJECT_MEMBERS_PANEL_WIDTH,
  resolveProjectMembersMode,
  type ProjectMembersMode,
} from './project-members-layout'
import { rightPaneNativeSuspendAtom } from '@/atoms/right-pane-suspension'
import {
  projectEntryAtom,
  projectOnboardingIntentAtom,
} from '@/atoms/project-entry'

/**
 * POO-196 R3 (adjudication D8): the shared host state for the project
 * members panel — open flag, the resolved push/drawer form factor, and the
 * native-pane suspension the DRAWER requires. Both ChatPage branches and the
 * project conversation empty state mount the panel through this one hook, so
 * the two entry points cannot drift.
 *
 * Measurement contract (D8): the chat lane is measured on the container the
 * CALLER owns (the common flex row that would host the panel as a sibling).
 * Its content-box width is identical before and after the insertion (the row
 * is sized by its own parent), so one ResizeObserver serves the pre-insert
 * lane width the resolver needs in both states. Unknown measurements fail
 * closed to the drawer; the hysteresis band lives inside
 * `resolveProjectMembersMode`. Navigation is never collapsed to make room.
 *
 * POO-196 R3 UB4 (adjudication U5): the ONE-TIME post-create invite
 * onboarding. The host owns the consume decision because it IS the "实际对话
 * 宿主": the recorded intent (atoms/project-entry) is consumed ONLY when this
 * host is mounted for the intent's exact scope, the shared entry transaction
 * is `ready` on the committed target (U3), and the viewer holds the live
 * invite right. Consumption opens the panel straight onto the 添加成员
 * selection page (never the overview) and clears the atom — close/skip then
 * cannot re-pop on resize, re-render or page return. A member/read_only host
 * never opens; the intent simply stays pending (the adjudication's destroy
 * list — cancel/account-change/leaving the target — belongs to the entry
 * owner). The panel opened this way shows 「先不拉人，直接开始」 at its
 * bottom; ANY close of that face consumes the offer and refocuses the
 * composer (0 invite / 0 createSession / 0 send along the whole path).
 */
export interface ProjectMembersPanelHostOptions {
  /** False keeps the panel closed and inert (non-project sessions). */
  enabled: boolean
  /** The chat lane container (content-box measured; borders/gaps excluded). */
  laneRef: RefObject<HTMLElement | null>
  /** A browser/canvas/file-preview pane currently owns the right column. */
  toolPaneOccupied: boolean
  /** The header entry button — focus returns to it when the panel closes. */
  triggerRef: RefObject<HTMLButtonElement | null>
  /** UB4 (U5): this host's scope identity — enables the onboarding
   * reconcile; null/undefined keeps the auto-open machinery off. */
  onboardingScope?: { accountId: string; productSpaceId: string } | null
  /** UB4 (U5): the live invite capability (roster/summary owner-manager).
   * False never auto-opens (member/read_only 不自动开). */
  canInvite?: boolean
  /** UB4 (U5): focus target for after the onboarding panel closes — the
   * conversation composer (「关闭后聚焦输入框」). */
  onOnboardingClosed?: () => void
}

export interface ProjectMembersPanelHost {
  open: boolean
  mode: ProjectMembersMode
  /** Content-box width of the lane container (0 until first measured). */
  laneWidth: number
  openPanel: () => void
  closePanel: () => void
  /** UB4 (U5): open the panel directly on the 添加成员 selection page (the
   * empty-state「邀请同事」card's existing-selection-page path). */
  openInvitePanel: () => void
  /** UB4 (U5): true while the CURRENT open came from the one-time onboarding
   * auto-open — the panel renders the「先不拉人，直接开始」skip face. */
  onboardingAutoOpen: boolean
  /** UB4 (U5): the current open should land directly on the 添加成员
   * selection page (onboarding auto-open or the invite card request). */
  directoryLanding: boolean
}

export function useProjectMembersPanelHost(options: ProjectMembersPanelHostOptions): ProjectMembersPanelHost {
  const { enabled, laneRef, toolPaneOccupied, triggerRef } = options

  const [open, setOpen] = useState(false)
  const [laneWidth, setLaneWidth] = useState(0)
  const [shellWidth, setShellWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  )
  const [mode, setMode] = useState<ProjectMembersMode>('push')
  // UB4 (U5): the open came from the onboarding auto-open (skip face), and/or
  // should land on the 添加成员 selection page (invite card).
  const [onboardingAutoOpen, setOnboardingAutoOpen] = useState(false)
  const [directoryOpenRequest, setDirectoryOpenRequest] = useState(false)
  // The resolver's hysteresis reads the previous mode; keeping it in a ref
  // lets the resolution effect depend only on the real inputs (no loops).
  const modeRef = useRef<ProjectMembersMode>('push')

  // UB4 (U5): the reconcile inputs — the shared entry state, the recorded
  // intent and this host's live scope/capability.
  const entryState = useAtomValue(projectEntryAtom)
  const intent = useAtomValue(projectOnboardingIntentAtom)
  const setIntent = useSetAtom(projectOnboardingIntentAtom)
  const onboardingScope = options.onboardingScope ?? null
  const onboardingScopeKey = onboardingScope
    ? `${onboardingScope.accountId}:${onboardingScope.productSpaceId}`
    : null
  const onboardingClosedRef = useRef(options.onOnboardingClosed)
  onboardingClosedRef.current = options.onOnboardingClosed

  // Window width = the shell width proxy available inside a page (AppShell's
  // container tracks the window in the desktop shell; D13's compact threshold
  // semantics are preserved by the resolver).
  useEffect(() => {
    const update = () => setShellWidth(window.innerWidth)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Measure the lane container's content box (navigation, session list, gaps
  // and borders already deducted at this node).
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const element = laneRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentBoxSize?.[0]?.inlineSize
      if (typeof width === 'number' && Number.isFinite(width)) setLaneWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [laneRef])

  // Deterministic mode resolution — no timers; the 480–503 dead zone keeps
  // the previous mode while the lane sits inside the hysteresis band.
  useEffect(() => {
    if (!open) {
      if (modeRef.current !== 'push') {
        modeRef.current = 'push'
        setMode('push')
      }
      return
    }
    const next = resolveProjectMembersMode({
      shellWidth,
      chatLaneWidth: laneWidth,
      panelWidth: PROJECT_MEMBERS_PANEL_WIDTH,
      toolPaneOccupied,
      previousMode: modeRef.current,
    })
    if (next !== modeRef.current) {
      modeRef.current = next
      setMode(next)
    }
  }, [open, shellWidth, laneWidth, toolPaneOccupied])

  // The drawer is a modal overlay: while it is up, the native browser/canvas
  // views must leave the visible layer through their existing IPC lifecycle
  // (never destroyed). The panel owns the flag; hosts react to it.
  const store = useStore()
  const drawerActive = open && mode === 'drawer'
  useEffect(() => {
    store.set(rightPaneNativeSuspendAtom, drawerActive)
    return () => {
      store.set(rightPaneNativeSuspendAtom, false)
    }
  }, [drawerActive, store])

  // UB4 (U5): the ONE-TIME consume decision. Every condition is bound to the
  // live host — the intent's exact scope, U3 `ready` on the committed target
  // (same scope), the live invite right. Consuming = clearing the atom (no
  // resize/re-render/return can re-pop) + opening the panel on the 添加成员
  // selection page. Without the invite right NOTHING happens here (member/
  // read_only 不自动开; the intent's destruction rules live in the entry
  // owner). A single intent guards re-entry: once cleared this effect idles.
  useEffect(() => {
    if (!enabled || !onboardingScopeKey || !options.canInvite) return
    if (!intent) return
    const scope = onboardingScope as { accountId: string; productSpaceId: string }
    if (intent.accountId !== scope.accountId || intent.productSpaceId !== scope.productSpaceId) return
    const entryReadyOnTarget = entryState.phase === 'ready'
      && entryState.accountId === scope.accountId
      && entryState.productSpaceId === scope.productSpaceId
    if (!entryReadyOnTarget) return
    // Consume by removal — one-shot, no resize/re-render/return resurrection.
    setIntent(() => null)
    setDirectoryOpenRequest(true)
    setOnboardingAutoOpen(true)
    setOpen(true)
  }, [enabled, entryState, intent, onboardingScope, onboardingScopeKey, options.canInvite, setIntent])

  const openPanel = useCallback(() => setOpen(true), [])

  /** UB4 (U5): the empty-state「邀请同事」card path — straight onto the
   * existing 添加成员 selection page (never through the overview). */
  const openInvitePanel = useCallback(() => {
    setDirectoryOpenRequest(true)
    setOpen(true)
  }, [])

  const closePanel = useCallback(() => {
    setOpen(false)
    // UB4 (U5): any close of the onboarding face (skip button, X, backdrop,
    // Esc) consumes the offer — the host is the actual dialog surface, so a
    // dismissal here can never resurrect on a later resize/return — and
    // hands focus to the composer (「关闭后聚焦输入框」). Plain closes reset
    // the landing-page request so the next manual open is the overview.
    setDirectoryOpenRequest(false)
    if (onboardingAutoOpen) {
      setOnboardingAutoOpen(false)
      onboardingClosedRef.current?.()
    } else {
      // 关闭焦点回成员触发器 (P8) — after the panel unmounts.
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [onboardingAutoOpen, triggerRef])

  return {
    open,
    mode,
    laneWidth,
    openPanel,
    closePanel,
    openInvitePanel,
    onboardingAutoOpen,
    /** UB4 (U5): the current open should land directly on the 添加成员
     * selection page (onboarding auto-open or the invite card request). */
    directoryLanding: directoryOpenRequest || onboardingAutoOpen,
  }
}
