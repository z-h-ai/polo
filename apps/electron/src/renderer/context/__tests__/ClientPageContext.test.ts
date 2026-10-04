import { describe, expect, it } from 'bun:test'
import {
  CLIENT_PAGE_MAX_ROUTE_DEPTH,
  HOME_CLIENT_PAGE_ROUTE,
  areClientPageRoutesEqual,
  clientPageScopeKey,
  clientPageStateReducer,
  createHeaderLineController,
  createInitialClientPageState,
  type ClientPageAction,
  type ClientPageRoute,
  type ClientPageState,
  type HeaderLineScrollTarget,
} from '../ClientPageContext'

// ─── Route equality ──────────────────────────────────────────────────────────

describe('areClientPageRoutesEqual', () => {
  it('treats same-kind parameterless routes as equal', () => {
    expect(areClientPageRoutesEqual({ kind: 'home' }, { kind: 'home' })).toBe(true)
    expect(areClientPageRoutesEqual({ kind: 'circles' }, { kind: 'circles' })).toBe(true)
  })

  it('distinguishes circle-detail by circleId AND section', () => {
    const base: ClientPageRoute = { kind: 'circle-detail', circleId: 'c1', section: 'content' }
    expect(areClientPageRoutesEqual(base, { ...base })).toBe(true)
    expect(areClientPageRoutesEqual(base, { ...base, circleId: 'c2' })).toBe(false)
    expect(areClientPageRoutesEqual(base, { ...base, section: 'updates' })).toBe(false)
  })

  it('distinguishes different kinds', () => {
    expect(areClientPageRoutesEqual({ kind: 'home' }, { kind: 'circles' })).toBe(false)
    expect(
      areClientPageRoutesEqual({ kind: 'circles' }, { kind: 'circle-detail', circleId: 'c1', section: 'content' }),
    ).toBe(false)
  })
})

// ─── Route stack state machine (P70-NAV-02 back semantics) ──────────────────

function reducer(state: ClientPageState, ...actions: ClientPageAction[]): ClientPageState {
  return actions.reduce(clientPageStateReducer, state)
}

const current = (state: ClientPageState): ClientPageRoute => state.stack[state.stack.length - 1]!

describe('clientPageStateReducer route stack', () => {
  it('starts sealed to its scope with only the home route', () => {
    const state = createInitialClientPageState('1::acct::space')
    expect(state.scopeKey).toBe('1::acct::space')
    expect(current(state)).toEqual(HOME_CLIENT_PAGE_ROUTE)
    expect(state.stack).toHaveLength(1)
  })

  it('navigate pushes, back pops, and back at the root is a no-op', () => {
    let state = createInitialClientPageState('scope')
    state = reducer(state, { type: 'navigate', route: { kind: 'circles' } })
    expect(current(state)).toEqual({ kind: 'circles' })

    state = reducer(state, { type: 'navigate', route: { kind: 'circle-detail', circleId: 'c1', section: 'content' } })
    expect(current(state)).toEqual({ kind: 'circle-detail', circleId: 'c1', section: 'content' })

    state = reducer(state, { type: 'back' })
    expect(current(state)).toEqual({ kind: 'circles' })

    state = reducer(state, { type: 'back' })
    expect(current(state)).toEqual({ kind: 'home' })
    expect(state.stack).toHaveLength(1)

    // Back at the root: identity-preserved no-op.
    const before = state
    state = reducer(state, { type: 'back' })
    expect(state).toBe(before)
  })

  it('navigating to the current route is a no-op', () => {
    let state = createInitialClientPageState('scope')
    state = reducer(state, { type: 'navigate', route: { kind: 'circle-detail', circleId: 'c1', section: 'updates' } })
    const before = state
    state = reducer(state, { type: 'navigate', route: { kind: 'circle-detail', circleId: 'c1', section: 'updates' } })
    expect(state).toBe(before)

    // A different section or circle is a NEW route.
    state = reducer(state, { type: 'navigate', route: { kind: 'circle-detail', circleId: 'c1', section: 'subscription' } })
    expect(state.stack).toHaveLength(3)
    const currentRoute = current(state)
    expect(currentRoute.kind === 'circle-detail' && currentRoute.section).toBe('subscription')
  })

  it('reset flattens back to home without changing the scope seal', () => {
    let state = createInitialClientPageState('scope')
    state = reducer(state,
      { type: 'navigate', route: { kind: 'circles' } },
      { type: 'navigate', route: { kind: 'circle-detail', circleId: 'c9', section: 'subscription' } },
    )
    state = reducer(state, { type: 'reset' })
    expect(current(state)).toEqual(HOME_CLIENT_PAGE_ROUTE)
    expect(state.stack).toHaveLength(1)
    expect(state.scopeKey).toBe('scope')

    // Reset at home is a no-op (identity preserved).
    const before = state
    state = reducer(state, { type: 'reset' })
    expect(state).toBe(before)
  })

  it('caps the stack depth above the un-shiftable home root', () => {
    let state = createInitialClientPageState('scope')
    for (let index = 0; index < CLIENT_PAGE_MAX_ROUTE_DEPTH + 10; index += 1) {
      state = reducer(state, {
        type: 'navigate',
        route: { kind: 'circle-detail', circleId: `c${index}`, section: 'content' },
      })
    }
    expect(state.stack).toHaveLength(CLIENT_PAGE_MAX_ROUTE_DEPTH)
    expect(state.stack[0]).toEqual(HOME_CLIENT_PAGE_ROUTE)
    // The OLDEST non-root entries were dropped; the newest survives.
    const newestRoute = current(state)
    expect(newestRoute.kind === 'circle-detail' && newestRoute.circleId).toBe(
      `c${CLIENT_PAGE_MAX_ROUTE_DEPTH + 9}`,
    )
  })
})

// ─── Scope isolation key (P70-NAV-02: accountId+productSpaceId+epoch) ────────

describe('clientPageScopeKey', () => {
  it('separates accounts, spaces and epochs', () => {
    const base = { accountId: 'acct-a', productSpaceId: 'space-1', epoch: 3 }
    const key = clientPageScopeKey(base)
    expect(key).toBe(clientPageScopeKey({ ...base }))
    expect(key).not.toBe(clientPageScopeKey({ ...base, accountId: 'acct-b' }))
    expect(key).not.toBe(clientPageScopeKey({ ...base, productSpaceId: 'space-2' }))
    // Same account re-login after logout bumps the epoch: a NEW scope.
    expect(key).not.toBe(clientPageScopeKey({ ...base, epoch: 4 }))
  })

  it('distinguishes the scopeless state from any real scope', () => {
    const scopeless = clientPageScopeKey({ accountId: null, productSpaceId: null, epoch: 0 })
    expect(scopeless).toBe('0::no-account::no-space')
    expect(scopeless).not.toBe(
      clientPageScopeKey({ accountId: 'acct-a', productSpaceId: null, epoch: 0 }),
    )
  })
})

describe('clientPageStateReducer scope seal (space change / epoch bump / logout / stale receipt)', () => {
  it('a scope-key change resets the whole stack to home in one step', () => {
    let state = createInitialClientPageState('3::acct-a::space-1')
    state = reducer(state,
      { type: 'navigate', route: { kind: 'circles' } },
      { type: 'navigate', route: { kind: 'circle-detail', circleId: 'c1', section: 'content' } },
    )
    expect(state.stack).toHaveLength(3)

    // Committed space switch: another scope's circle detail must not leak.
    state = reducer(state, { type: 'scope-seal', scopeKey: '3::acct-a::space-2' })
    expect(state).toEqual(createInitialClientPageState('3::acct-a::space-2'))
    expect(current(state)).toEqual(HOME_CLIENT_PAGE_ROUTE)
  })

  it('an epoch bump (logout → re-login of the SAME account) is a new scope', () => {
    let state = createInitialClientPageState('3::acct-a::space-1')
    state = reducer(state, { type: 'navigate', route: { kind: 'circle-detail', circleId: 'c1', section: 'updates' } })

    state = reducer(state, { type: 'scope-seal', scopeKey: '4::acct-a::space-1' })
    expect(state.stack).toEqual([HOME_CLIENT_PAGE_ROUTE])
    expect(state.scopeKey).toBe('4::acct-a::space-1')
  })

  it('an unchanged scope seal is an identity no-op (no reset churn)', () => {
    let state = createInitialClientPageState('3::acct-a::space-1')
    state = reducer(state, { type: 'navigate', route: { kind: 'circles' } })
    const before = state
    state = reducer(state, { type: 'scope-seal', scopeKey: '3::acct-a::space-1' })
    expect(state).toBe(before)
  })
})

// ─── Header hairline controller (P70-NAV-03) ────────────────────────────────

interface ScrollTargetFixture extends HeaderLineScrollTarget {
  /** Sets scrollTop and notifies listeners, like a real scroller would. */
  setScroll(value: number): void
  emitScroll(): void
}

function makeScrollTarget(initialScrollTop = 0): ScrollTargetFixture {
  let scrollTop = initialScrollTop
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  return {
    get scrollTop() { return scrollTop },
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    setScroll(value: number) {
      scrollTop = value
      notify()
    },
    emitScroll: notify,
  }
}

function makeController() {
  let changes = 0
  let lastVisible = false
  const controller = createHeaderLineController((visible) => {
    changes += 1
    lastVisible = visible
  })
  return {
    controller,
    isVisible: () => controller.isVisible(),
    lastVisible: () => lastVisible,
    changes: () => changes,
  }
}

describe('createHeaderLineController', () => {
  it('starts invisible (initial state has no hairline)', () => {
    const harness = makeController()
    expect(harness.isVisible()).toBe(false)
    expect(harness.changes()).toBe(0)
  })

  it('attaching a scrolled container publishes the hairline immediately; a fresh one does not', () => {
    const scrolled = makeScrollTarget(120)
    const fresh = makeScrollTarget(0)
    const harness = makeController()

    harness.controller.attach(scrolled)
    expect(harness.isVisible()).toBe(true)

    harness.controller.attach(fresh)
    expect(harness.isVisible()).toBe(false)

    // The replaced scroller no longer drives the hairline.
    scrolled.emitScroll()
    expect(harness.isVisible()).toBe(false)
  })

  it('follows only the registered main scroller and returns to hidden at the top', () => {
    const main = makeScrollTarget(0)
    const harness = makeController()
    harness.controller.attach(main)

    main.setScroll(40)
    expect(harness.isVisible()).toBe(true)
    expect(harness.lastVisible()).toBe(true)

    main.setScroll(0)
    expect(harness.isVisible()).toBe(false)
  })

  it('detaching hides the hairline and stops listening', () => {
    const main = makeScrollTarget(80)
    const harness = makeController()
    harness.controller.attach(main)
    expect(harness.isVisible()).toBe(true)

    harness.controller.attach(null)
    expect(harness.isVisible()).toBe(false)

    main.emitScroll()
    expect(harness.isVisible()).toBe(false)
  })

  it('re-attaching the same element is a no-op (no duplicate listeners)', () => {
    const main = makeScrollTarget(0)
    const harness = makeController()
    harness.controller.attach(main)
    harness.controller.attach(main)

    main.setScroll(10)
    expect(harness.isVisible()).toBe(true)
    // One subscription only: the no-op re-attach added none, so the single
    // scroll event produces exactly one visible change.
    expect(harness.changes()).toBe(1)
  })

  it('dispose hides the hairline and detaches the listener', () => {
    const main = makeScrollTarget(80)
    const harness = makeController()
    harness.controller.attach(main)
    expect(harness.isVisible()).toBe(true)

    harness.controller.dispose()
    expect(harness.isVisible()).toBe(false)

    main.emitScroll()
    expect(harness.isVisible()).toBe(false)
  })
})
