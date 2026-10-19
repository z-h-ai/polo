/**
 * useUserMessageRecap — visibility + reveal for the floating latest-user-message
 * Recap (POO-111).
 *
 * Scheduling contract:
 * - Visibility is re-evaluated on scroll (rAF-coalesced), viewport resize,
 *   and whenever the target / pagination window / session / loading state
 *   changes. All listeners and animation frames are cleaned up.
 * - The target is only trusted inside the rendered session subtree
 *   (`data-recap-session`), so AnimatePresence exit nodes from a previous
 *   session — which can share message ids after branching — never get measured.
 * - `reveal()` scrolls *this* viewport only, instantly (reduced-motion safe),
 *   drops pending bottom-follow, expands reverse pagination when the target is
 *   not rendered yet, and moves focus onto the message (preventScroll) because
 *   the button unmounts right after.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  computeRecapScrollTop,
  isElementInRecapScope,
  isRecapTargetScrolledOut,
} from '../components/app-shell/user-message-recap'

/** Where the Recap points: the selected turn's DOM key and full-list index. */
export interface RecapTargetLocation {
  turnKey: string
  turnIndex: number
}

export interface UseUserMessageRecapOptions {
  sessionId: string | null
  target: RecapTargetLocation | null
  /** First rendered turn index of the reverse-pagination window. */
  startIndex: number
  scrollViewportRef: RefObject<HTMLDivElement | null>
  turnRefs: RefObject<Map<string, HTMLDivElement>>
  /** Distance below the viewport top where the target lands on reveal (px). */
  topOffsetPx: number
  /** While true (lazy loading, no messages) the Recap stays hidden. */
  paused?: boolean
  /** Expand rendering so a paginated-away target mounts (set visibleTurnCount). */
  ensureTargetRendered?: (turnIndex: number) => void
}

export interface UseUserMessageRecapResult {
  visible: boolean
  reveal: () => void
}

/** Upper bound for the post-expansion DOM retries (double-rAF hops). */
const MAX_REVEAL_ATTEMPTS = 5

interface RecapOptionsSnapshot {
  sessionId: string | null
  target: RecapTargetLocation | null
  startIndex: number
  scrollViewportRef: RefObject<HTMLDivElement | null>
  turnRefs: RefObject<Map<string, HTMLDivElement>>
  topOffsetPx: number
  paused: boolean
  ensureTargetRendered?: (turnIndex: number) => void
}

export function useUserMessageRecap(options: UseUserMessageRecapOptions): UseUserMessageRecapResult {
  const { sessionId, target, startIndex, scrollViewportRef, turnRefs, topOffsetPx, paused = false, ensureTargetRendered } = options

  const [visible, setVisible] = useState(false)

  // Latest inputs for the rAF callbacks; avoids re-binding scroll listeners.
  const optionsRef = useRef<RecapOptionsSnapshot>({
    sessionId,
    target,
    startIndex,
    scrollViewportRef,
    turnRefs,
    topOffsetPx,
    paused,
    ensureTargetRendered,
  })
  optionsRef.current = {
    sessionId,
    target,
    startIndex,
    scrollViewportRef,
    turnRefs,
    topOffsetPx,
    paused,
    ensureTargetRendered,
  }

  const frameRef = useRef<number | null>(null)
  // Suppress re-evaluation while a programmatic reveal is mid-flight, so a
  // premature "target not measured yet" pass cannot flash the button back on.
  const revealInFlightRef = useRef(false)

  const evaluate = useCallback(() => {
    frameRef.current = null
    const current = optionsRef.current
    if (current.paused || !current.sessionId || !current.target) {
      setVisible(false)
      return
    }
    // Older than everything rendered → definitively above the viewport.
    if (current.target.turnIndex < current.startIndex) {
      setVisible(true)
      return
    }
    const element = current.turnRefs.current?.get(current.target.turnKey)
    const viewport = current.scrollViewportRef.current
    if (!element || !element.isConnected || !viewport) {
      setVisible(false)
      return
    }
    if (!isElementInRecapScope(element, current.sessionId)) {
      setVisible(false)
      return
    }
    setVisible(isRecapTargetScrolledOut(element.getBoundingClientRect(), viewport.getBoundingClientRect().top))
  }, [])

  const scheduleEvaluate = useCallback(() => {
    if (revealInFlightRef.current) return
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(evaluate)
  }, [evaluate])

  // Re-evaluate on target/pagination/session/loading changes. On a session
  // switch the Recap hides immediately — the new session's preview must never
  // flash while the previous session's nodes are still exiting.
  const previousSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId
      setVisible(false)
    }
    scheduleEvaluate()
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [scheduleEvaluate, sessionId, target?.turnKey, target?.turnIndex, startIndex, paused])

  // Viewport may appear after the first commit (null → session mounts) and is
  // replaced when the session area unmounts, so (re)bind on session changes.
  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport || paused || !sessionId) return
    viewport.addEventListener('scroll', scheduleEvaluate, { passive: true })
    return () => viewport.removeEventListener('scroll', scheduleEvaluate)
  }, [scheduleEvaluate, scrollViewportRef, sessionId, paused])

  // Panel resizes change the viewport box without a scroll event.
  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport || paused || !sessionId) return
    const observer = new ResizeObserver(scheduleEvaluate)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [scheduleEvaluate, scrollViewportRef, sessionId, paused])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const reveal = useCallback(() => {
    const current = optionsRef.current
    if (!current.sessionId || !current.target) return
    const viewport = current.scrollViewportRef.current
    if (!viewport) return

    revealInFlightRef.current = true
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    setVisible(false)

    const scrollToTarget = (element: HTMLDivElement) => {
      const viewportRect = viewport.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      viewport.scrollTo({
        top: computeRecapScrollTop({
          targetTop: rect.top,
          viewportTop: viewportRect.top,
          scrollTop: viewport.scrollTop,
          offsetPx: optionsRef.current.topOffsetPx,
        }),
        // Instant on purpose: honors reduced-motion and cannot fight the user.
        behavior: 'instant',
      })
      // The button unmounts once the target is visible; keep keyboard focus on
      // the message instead of dropping it to <body>.
      element.focus({ preventScroll: true })
    }

    const attempt = (attemptIndex: number) => {
      const snapshot = optionsRef.current
      const element = snapshot.target && snapshot.sessionId
        ? snapshot.turnRefs.current?.get(snapshot.target.turnKey)
        : undefined
      if (element && element.isConnected && snapshot.sessionId && isElementInRecapScope(element, snapshot.sessionId)) {
        scrollToTarget(element)
        revealInFlightRef.current = false
        return
      }
      if (attemptIndex === 0) {
        // Target paginated out of the render window — expand first, then locate.
        snapshot.ensureTargetRendered?.(snapshot.target?.turnIndex ?? -1)
      }
      // Always terminates: bounded retries clear the in-flight gate.
      if (attemptIndex >= MAX_REVEAL_ATTEMPTS) {
        revealInFlightRef.current = false
        return
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => attempt(attemptIndex + 1))
      })
    }

    attempt(0)
  }, [])

  return { visible, reveal }
}
