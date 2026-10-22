/**
 * useUserMessageRecap — visibility + reveal for the floating latest-user-message
 * Recap (POO-111).
 *
 * Scheduling contract:
 * - Visibility is re-evaluated on scroll (rAF-coalesced), viewport *and*
 *   content resize, late list mounts (MutationObserver on the viewport
 *   subtree — AnimatePresence mode="wait" mounts after the commit, and a
 *   same-height list fires no ResizeObserver), and whenever the target /
 *   pagination window / session / loading state changes. All listeners,
 *   observers and animation frames are cleaned up.
 * - The target is only trusted inside the rendered session subtree
 *   (`data-recap-session`), so AnimatePresence exit nodes from a previous
 *   session — which can share message ids after branching — never get measured.
 * - Visibility is keyed to `{sessionId, turnKey}` during render: a session or
 *   target switch starts hidden, so the first committed frame can never show
 *   the new preview under a stale `visible=true`.
 * - `reveal()` scrolls *this* viewport only, instantly (reduced-motion safe),
 *   drops pending bottom-follow, expands reverse pagination when the target is
 *   not rendered yet, and moves focus onto the message (preventScroll) because
 *   the button unmounts right after.
 * - A pending reveal is an *intent* locked to the click-time `{sessionId,
 *   turnKey, viewport}`. Retries only ever serve that original intent: a
 *   session/target change or unmount cancels every pending frame and resets
 *   the in-flight gate, so a slow retry chain can never scroll or focus a
 *   different conversation.
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

/** The click-time reveal identity every retry must still match. */
interface RevealIntent {
  sessionId: string
  turnKey: string
  turnIndex: number
  viewport: HTMLDivElement
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
  // Frames of a pending reveal chain (double-rAF hops). Tracked so a session
  // switch or unmount can cancel them instead of letting them fire later.
  const revealFramesRef = useRef<Set<number>>(new Set())
  // Suppress re-evaluation while a programmatic reveal is mid-flight, so a
  // premature "target not measured yet" pass cannot flash the button back on.
  const revealInFlightRef = useRef(false)

  /** Cancel every pending reveal frame and release the in-flight gate. */
  const cancelRevealChain = useCallback(() => {
    for (const handle of revealFramesRef.current) cancelAnimationFrame(handle)
    revealFramesRef.current.clear()
    revealInFlightRef.current = false
  }, [])

  // ---------------------------------------------------------------------------
  // Visibility keyed to the current session+target (render-phase derivation)
  // ---------------------------------------------------------------------------

  // getDerivedStateFromProps equivalent: the same committed frame that swaps
  // in a new session/target also drops a stale visible=true, so the new
  // preview can never flash under the old measurement.
  const visibilityKey = sessionId && target ? `${sessionId} ${target.turnKey}` : null
  const previousVisibilityKeyRef = useRef(visibilityKey)
  if (previousVisibilityKeyRef.current !== visibilityKey) {
    previousVisibilityKeyRef.current = visibilityKey
    cancelRevealChain()
    if (visible) setVisible(false)
  }

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

  // Re-evaluate on target/pagination/session/loading changes.
  useEffect(() => {
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

  // Resize + late-mount signals. The viewport box changes on panel resize;
  // the content box changes on streaming/layout shifts without a scroll
  // event; and AnimatePresence may mount list nodes after this commit — a
  // same-height list fires no ResizeObserver, so insertions need their own
  // signal. Everything funnels into one coalesced rAF evaluation.
  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport || paused || !sessionId) return

    const resizeObserver = new ResizeObserver(scheduleEvaluate)
    // Both boxes matter: the viewport (panel resizes) and the content
    // container (streaming/layout shifts without a scroll event).
    resizeObserver.observe(viewport)
    let observedContent: Element | null = null
    const observeContent = () => {
      const content = viewport.firstElementChild
      if (content && content !== observedContent) {
        // Swap only the content target — disconnecting here would also drop
        // the viewport observation above.
        if (observedContent) resizeObserver.unobserve(observedContent)
        resizeObserver.observe(content)
        observedContent = content
      }
    }
    observeContent()

    const mutationObserver = new MutationObserver(() => {
      observeContent()
      scheduleEvaluate()
    })
    mutationObserver.observe(viewport, { childList: true, subtree: true })

    return () => {
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [scheduleEvaluate, scrollViewportRef, sessionId, paused])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      cancelRevealChain()
    }
  }, [cancelRevealChain])

  const reveal = useCallback(() => {
    const current = optionsRef.current
    if (!current.sessionId || !current.target) return
    const viewport = current.scrollViewportRef.current
    if (!viewport) return

    // Lock the click-time identity: retries serve THIS intent only.
    const intent: RevealIntent = {
      sessionId: current.sessionId,
      turnKey: current.target.turnKey,
      turnIndex: current.target.turnIndex,
      viewport,
    }

    revealInFlightRef.current = true
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    setVisible(false)

    const scrollToTarget = (element: HTMLDivElement) => {
      const viewportRect = intent.viewport.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      intent.viewport.scrollTo({
        top: computeRecapScrollTop({
          targetTop: rect.top,
          viewportTop: viewportRect.top,
          scrollTop: intent.viewport.scrollTop,
          offsetPx: optionsRef.current.topOffsetPx,
        }),
        // Instant on purpose: honors reduced-motion and cannot fight the user.
        behavior: 'instant',
      })
      // The button unmounts once the target is visible; keep keyboard focus on
      // the message instead of dropping it to <body>.
      element.focus({ preventScroll: true })
    }

    /** rAF with the handle tracked so session switches can cancel it. */
    const requestTrackedFrame = (run: () => void) => {
      const handle = requestAnimationFrame(() => {
        revealFramesRef.current.delete(handle)
        run()
      })
      revealFramesRef.current.add(handle)
    }

    const attempt = (attemptIndex: number, chainIntent: RevealIntent) => {
      const snapshot = optionsRef.current
      // The intent is authoritative: if the session or target changed while
      // these frames were pending, stop — never scroll/focus the new one.
      if (snapshot.sessionId !== chainIntent.sessionId || snapshot.target?.turnKey !== chainIntent.turnKey) {
        revealFramesRef.current.clear()
        revealInFlightRef.current = false
        return
      }
      const element = snapshot.turnRefs.current?.get(chainIntent.turnKey)
      if (element && element.isConnected && isElementInRecapScope(element, chainIntent.sessionId)) {
        scrollToTarget(element)
        revealInFlightRef.current = false
        return
      }
      if (attemptIndex === 0) {
        // Target paginated out of the render window — expand first, then locate.
        snapshot.ensureTargetRendered?.(chainIntent.turnIndex)
      }
      // Always terminates: bounded retries clear the in-flight gate.
      if (attemptIndex >= MAX_REVEAL_ATTEMPTS) {
        revealInFlightRef.current = false
        return
      }
      // Double rAF lets React commit the expanded pagination before we re-measure.
      requestTrackedFrame(() => {
        requestTrackedFrame(() => attempt(attemptIndex + 1, chainIntent))
      })
    }

    attempt(0, intent)
  }, [])

  return { visible, reveal }
}
