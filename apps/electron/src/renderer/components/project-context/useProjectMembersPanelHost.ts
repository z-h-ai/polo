import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useStore } from 'jotai'
import {
  PROJECT_MEMBERS_PANEL_WIDTH,
  resolveProjectMembersMode,
  type ProjectMembersMode,
} from './project-members-layout'
import { rightPaneNativeSuspendAtom } from '@/atoms/right-pane-suspension'

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
}

export interface ProjectMembersPanelHost {
  open: boolean
  mode: ProjectMembersMode
  /** Content-box width of the lane container (0 until first measured). */
  laneWidth: number
  openPanel: () => void
  closePanel: () => void
}

export function useProjectMembersPanelHost(options: ProjectMembersPanelHostOptions): ProjectMembersPanelHost {
  const { enabled, laneRef, toolPaneOccupied, triggerRef } = options

  const [open, setOpen] = useState(false)
  const [laneWidth, setLaneWidth] = useState(0)
  const [shellWidth, setShellWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  )
  const [mode, setMode] = useState<ProjectMembersMode>('push')
  // The resolver's hysteresis reads the previous mode; keeping it in a ref
  // lets the resolution effect depend only on the real inputs (no loops).
  const modeRef = useRef<ProjectMembersMode>('push')

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

  const openPanel = useCallback(() => setOpen(true), [])
  const closePanel = useCallback(() => {
    setOpen(false)
    // 关闭焦点回成员触发器 (P8) — after the panel unmounts.
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [triggerRef])

  return { open, mode, laneWidth, openPanel, closePanel }
}
