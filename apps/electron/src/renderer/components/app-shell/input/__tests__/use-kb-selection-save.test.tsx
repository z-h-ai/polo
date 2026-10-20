/**
 * KB composer selection save guards (POO-108 reviews #11/N2).
 *
 * The composer is reused across sessions, so a failed save must only roll
 * back when the failing request is still the latest one, was issued for the
 * session currently on screen, and is not older than the current session
 * LIFECYCLE generation — and it must roll back to the last CONFIRMED server
 * snapshot, never to an optimistic guess. Covered here:
 *  - plain failure rolls back to the confirmed server scope;
 *  - two consecutive failures leave the confirmed scope, not the first
 *    optimistic guess (review #11 repro);
 *  - a scope event that lands while a save is pending wins over it;
 *  - a save success confirms its value for a later rollback;
 *  - a stale success does not drag the snapshot behind a newer event;
 *  - session A's failure after switching to session B leaves B untouched
 *    (the N2 repro: B would otherwise inherit A's selection);
 *  - an A→B→A round trip does not resurrect the pre-switch request (the
 *    N2 follow-up: the session id matches again, only the generation
 *    catches it);
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
  /** Re-renders the hook against a different session identity. */
  switchSession: (sessionId: string | undefined) => void
  /** Re-renders the hook with a server-pushed scope for the CURRENT session. */
  pushServerValue: (serverValue: string[]) => void
  /** Starts one optimistic save; settle it later via settleNextSave. */
  persist: (next: string[]) => Promise<void>
  /** Settles the OLDEST unsettled save. */
  settleNextSave: (outcome: 'ok' | 'fail') => void
}

function renderSaver(sessionId: string | undefined, serverValue: string[] = []): Harness {
  const state: {
    rollbacks: string[][]
    failures: number
    deferred: DeferredSave[]
  } = { rollbacks: [], failures: 0, deferred: [] }
  // The session id the hook is currently on — pushServerValue re-renders
  // against it, exactly like a scope event for the visible session.
  let currentSessionId = sessionId
  const harness = renderHook(
    ({ sessionId, serverValue }: { sessionId: string | undefined; serverValue: string[] }) =>
      useKbSelectionSave({
        sessionId,
        serverValue,
        save: () => new Promise<void>((resolve, reject) => {
          state.deferred.push({ resolve, reject })
        }),
        rollback: confirmed => {
          state.rollbacks.push([...confirmed])
        },
        notifyFailure: () => {
          state.failures += 1
        },
      }),
    { initialProps: { sessionId, serverValue } },
  )
  const rerender = (props: { sessionId: string | undefined; serverValue: string[] }) => {
    currentSessionId = props.sessionId
    harness.rerender(props)
  }
  return {
    get rollbacks() { return state.rollbacks },
    get failures() { return state.failures },
    switchSession(next) {
      // A session switch carries the target session's own pushed scope.
      rerender({ sessionId: next, serverValue: [] })
    },
    pushServerValue(serverValue) {
      rerender({ sessionId: currentSessionId, serverValue })
    },
    async persist(next) {
      const persist = harness.result.current
      if (typeof persist !== 'function') throw new Error('saver hook did not render')
      // No act() here: the rollback touches plain captured state, not React
      // — an act() wrapper would overlap with switchSession's rerender.
      await persist(next)
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

  it('rolls back to the confirmed server scope, not the optimistic guess (review #11)', async () => {
    // The server holds nothing; the optimistic toggle selected 'x'.
    const run = harness.persist(['x'])
    harness.settleNextSave('fail')
    await run
    expect(harness.rollbacks).toEqual([[]])
    expect(harness.failures).toBe(1)
  })

  it('two consecutive failures leave the confirmed scope, not the first guess (review #11 repro)', async () => {
    const first = harness.persist(['kb-x'])
    const second = harness.persist(['kb-x', 'kb-y'])
    // Neither save ever reached the server: the first failure is stale, the
    // second rolls back to the CONFIRMED snapshot — which is still the empty
    // server scope, so the next send can never carry 'kb-x'.
    harness.settleNextSave('fail')
    harness.settleNextSave('fail')
    await first
    await second
    expect(harness.rollbacks).toEqual([[]])
    expect(harness.failures).toBe(2)
  })

  it('a scope event landing while a save is pending wins over it', async () => {
    const run = harness.persist(['kb-x'])
    // Another window moved the scope while the save was in flight.
    harness.pushServerValue(['kb-y'])
    harness.settleNextSave('fail')
    await run
    expect(harness.rollbacks).toEqual([['kb-y']])
  })

  it('a settled save confirms its value for a later rollback', async () => {
    const confirmedSave = harness.persist(['kb-x'])
    harness.settleNextSave('ok')
    await confirmedSave
    const run = harness.persist(['kb-x', 'kb-y'])
    harness.settleNextSave('fail')
    await run
    expect(harness.rollbacks).toEqual([['kb-x']])
  })

  it('a stale success does not drag the snapshot behind a newer scope event', async () => {
    const stale = harness.persist(['kb-x'])
    const newer = harness.persist(['kb-y'])
    harness.pushServerValue(['kb-z'])
    harness.settleNextSave('ok')
    harness.settleNextSave('fail')
    await stale
    await newer
    expect(harness.rollbacks).toEqual([['kb-z']])
  })

  it('never rolls a failed save into a different session (review N2)', async () => {
    const run = harness.persist(['kb-x'])
    // The user switches to an empty-scope session B before the failure lands.
    harness.switchSession('session-b')
    harness.settleNextSave('fail')
    await run
    expect(harness.rollbacks).toEqual([])
    expect(harness.failures).toBe(1)
  })

  it('an A→B→A round trip does not resurrect the pre-switch request (review N2)', async () => {
    // Session A holds [kb-x]; the user clears it and the save hangs.
    harness.pushServerValue(['kb-x'])
    const stale = harness.persist([])
    // Away to B and back to A — where another window has moved A to [kb-y].
    harness.switchSession('session-b')
    harness.switchSession('session-a')
    harness.pushServerValue(['kb-y'])
    // The stale clear finally fails: the session id matches again, but the
    // generation has moved twice, so A must keep the server value.
    harness.settleNextSave('fail')
    await stale
    expect(harness.rollbacks).toEqual([])
    expect(harness.failures).toBe(1)
  })

  it('an older failure does not overwrite a newer save in the same session', async () => {
    const stale = harness.persist(['kb-x'])
    const newer = harness.persist(['kb-y'])
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
    const run = harness.persist(['kb-x'])
    harness.settleNextSave('ok')
    await run
    expect(harness.rollbacks).toEqual([])
    expect(harness.failures).toBe(0)
  })
})
