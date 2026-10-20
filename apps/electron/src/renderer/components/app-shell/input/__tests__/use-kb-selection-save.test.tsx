/**
 * KB composer selection save guards (POO-108 reviews #11/N2).
 *
 * The composer is reused across sessions, so a failed save must only roll
 * back when the failing request is still the latest one AND was issued for
 * the session currently on screen. Covered here:
 *  - plain failure rolls back to the previous selection;
 *  - session A's failure after switching to session B leaves B untouched
 *    (the N2 repro: B would otherwise inherit A's selection);
 *  - an older failure in the SAME session never overwrites a newer save.
 *
 * The save promises are settled manually so the failure lands at a
 * deterministic point of the interleaving, exactly like the real RPC
 * returning after the user has already moved on.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      },
    },
  })
}

const { renderHook } = await import('@testing-library/react')
const { useKbSelectionSave } = await import('../use-kb-selection-save')

/** A save call whose settlement the test controls. */
interface DeferredSave {
  resolve: () => void
  reject: (error: Error) => void
}

interface Harness {
  rollbacks: string[][]
  failures: number
  /** Re-render the hook against a different session identity. */
  switchSession: (sessionId: string | undefined) => void
  /** Starts one optimistic save; settle it later via settleNextSave. */
  persist: (previous: string[], next: string[]) => Promise<void>
  /** Settles the OLDEST unsettled save. */
  settleNextSave: (outcome: 'ok' | 'fail') => void
}

function renderSaver(sessionId: string | undefined): Harness {
  const state: {
    rollbacks: string[][]
    failures: number
    deferred: DeferredSave[]
  } = { rollbacks: [], failures: 0, deferred: [] }
  const harness = renderHook(({ sessionId }: { sessionId: string | undefined }) => useKbSelectionSave({
    sessionId,
    save: () => new Promise<void>((resolve, reject) => {
      state.deferred.push({ resolve, reject })
    }),
    rollback: previous => {
      state.rollbacks.push([...previous])
    },
    notifyFailure: () => {
      state.failures += 1
    },
  }), { initialProps: { sessionId } })
  return {
    get rollbacks() { return state.rollbacks },
    get failures() { return state.failures },
    switchSession(next) {
      harness.rerender({ sessionId: next })
    },
    async persist(previous, next) {
      const persist = harness.result.current
      if (typeof persist !== 'function') throw new Error('saver hook did not render')
      // No act() here: the rollback touches plain captured state, not React
      // — an act() wrapper would overlap with switchSession's rerender.
      await persist(previous, next)
    },
    settleNextSave(outcome) {
      const deferred = state.deferred.shift()
      if (!deferred) throw new Error('no pending save to settle')
      if (outcome === 'ok') deferred.resolve()
      else deferred.reject(new Error('save failed'))
    },
  }
}

describe('useKbSelectionSave rollback guards', () => {
  let harness: Harness

  beforeEach(() => {
    harness = renderSaver('session-a')
  })

  it('rolls back the optimistic toggle when the save fails for the current session', async () => {
    const run = harness.persist(['x'], [])
    harness.settleNextSave('fail')
    await run
    expect(harness.rollbacks).toEqual([['x']])
    expect(harness.failures).toBe(1)
  })

  it('never rolls a failed save into a different session (review N2)', async () => {
    const run = harness.persist(['kb-x'], [])
    // The user switches to an empty-scope session B before the failure lands.
    harness.switchSession('session-b')
    harness.settleNextSave('fail')
    await run
    expect(harness.rollbacks).toEqual([])
    expect(harness.failures).toBe(1)
  })

  it('an older failure does not overwrite a newer save in the same session', async () => {
    const stale = harness.persist(['kb-x'], [])
    const newer = harness.persist([], ['kb-y'])
    // The OLDER request fails, the newer one succeeds — the visible selection
    // must stay the newer save's result.
    harness.settleNextSave('fail')
    harness.settleNextSave('ok')
    await stale
    await newer
    expect(harness.rollbacks).toEqual([])
    expect(harness.failures).toBe(1)
  })

  it('does not roll back when the save succeeds', async () => {
    const run = harness.persist(['kb-x'], [])
    harness.settleNextSave('ok')
    await run
    expect(harness.rollbacks).toEqual([])
    expect(harness.failures).toBe(0)
  })
})
