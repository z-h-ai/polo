/**
 * ClientPageContext (POO-70 N1, P70-NAV-01/02/03) — the routing + main-scroll
 * foundation for the personal-home client pages (Home, Circles, Circle
 * detail). Published ONLY as a navigation contract: the route parameters are
 * navigation candidates, never an authorization — every circle surface still
 * resolves its own trusted read through the member catalog / C1 RPC bridge
 * before rendering anything.
 *
 * Scope isolation (P70-NAV-02): the provider is keyed by
 * `epoch::accountId::productSpaceId`. The App mounts it inside the
 * ProductSpace consumption boundary and OUTSIDE TabShell with that key, so an
 * account switch, a committed space switch or an epoch bump (logout, auth
 * failure, reset — see A4 `invalidateAccountSession`) destroys the whole
 * provider instance: no back stack, no stale circle detail can survive into
 * the next scope. As a fail-closed second line the provider also re-seals
 * itself when it observes a scope key change without a remount.
 *
 * Header hairline (P70-NAV-03): the workbench bar's bottom border is no
 * longer unconditional. The current page registers its MAIN scroll container
 * here; the hairline appears only when THAT element is scrolled away from the
 * top. The assistant's internal scroll containers never register, so opening
 * the Polo tab can never move the hairline. The frozen narrow-window guard
 * (TabShell ≤640px) is untouched — it replaces the whole shell including the
 * bar, so the mobile client stays out of scope.
 *
 * Handoff (POO-100): this card publishes `useClientPage()` plus the typed
 * route and the main-scroll registration. The actual mounting of Home/Circles
 * surfaces inside TabContent, and the registration of their scroll
 * containers, belong to POO-100. No circle ProductSpace and no circle App tab
 * is introduced here (P70-NAV-01: circles live in the personal home content
 * area, there is no second nav row).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'

// ─── Typed route (implementation order step 1) ───────────────────────────────

export type ClientPageRoute =
  | { kind: 'home' }
  | { kind: 'circles' }
  | { kind: 'circle-detail'; circleId: string; section: 'content' | 'updates' | 'subscription' }

export type ClientCircleDetailSection = Extract<
  ClientPageRoute,
  { kind: 'circle-detail' }
>['section']

export const HOME_CLIENT_PAGE_ROUTE: ClientPageRoute = { kind: 'home' }

/** Structural route equality — navigate to the current route is a no-op. */
export function areClientPageRoutesEqual(left: ClientPageRoute, right: ClientPageRoute): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'circle-detail' && right.kind === 'circle-detail') {
    return left.circleId === right.circleId && left.section === right.section
  }
  return true
}

// ─── Scope isolation key (P70-NAV-02) ────────────────────────────────────────

/**
 * The immutable scope of client page state. `epoch` is the A4 account-session
 * epoch (`accountSessionEpochRef`): it bumps on every authenticated-session
 * end (logout, auth failure, reset), so logging back into the SAME account
 * still destroys the previous session's page state.
 */
export interface ClientPageScope {
  accountId: string | null
  productSpaceId: string | null
  epoch: number
}

export function clientPageScopeKey(scope: ClientPageScope): string {
  return `${scope.epoch}::${scope.accountId ?? 'no-account'}::${scope.productSpaceId ?? 'no-space'}`
}

// ─── Route stack (pure, unit-testable state machine) ─────────────────────────

/**
 * The back stack always keeps the home route as its un-shiftable root
 * (stack[0]); `back()` at the root is a no-op and navigation depth above the
 * root is capped so a pathological consumer cannot grow it without bound.
 */
export const CLIENT_PAGE_MAX_ROUTE_DEPTH = 32

export interface ClientPageState {
  /** The scope this state belongs to — a mismatch re-seals (reset) it. */
  scopeKey: string
  /** stack[0] is always `home`; the LAST entry is the current route. */
  stack: ClientPageRoute[]
}

export type ClientPageAction =
  | { type: 'navigate'; route: ClientPageRoute }
  | { type: 'back' }
  | { type: 'reset' }
  | { type: 'scope-seal'; scopeKey: string }

export function createInitialClientPageState(scopeKey: string): ClientPageState {
  return {
    scopeKey,
    stack: [HOME_CLIENT_PAGE_ROUTE],
  }
}

export function clientPageStateReducer(state: ClientPageState, action: ClientPageAction): ClientPageState {
  switch (action.type) {
    case 'navigate': {
      const current = state.stack[state.stack.length - 1]!
      if (areClientPageRoutesEqual(current, action.route)) return state
      const stack = [...state.stack, action.route]
      // Cap the depth ABOVE the home root: drop the OLDEST non-root entry so
      // `back()` can always walk home.
      if (stack.length > CLIENT_PAGE_MAX_ROUTE_DEPTH) {
        stack.splice(1, stack.length - CLIENT_PAGE_MAX_ROUTE_DEPTH)
      }
      return { ...state, stack }
    }
    case 'back': {
      if (state.stack.length <= 1) return state
      return { ...state, stack: state.stack.slice(0, -1) }
    }
    case 'reset': {
      if (state.stack.length <= 1) return state
      return { ...state, stack: [HOME_CLIENT_PAGE_ROUTE] }
    }
    case 'scope-seal': {
      // Fail-closed scope seal (P70-NAV-02): ANY scope-key change — account,
      // space or epoch — resets to a fresh home-only stack. A stale route of
      // the previous scope can never be observed in the new scope.
      if (state.scopeKey === action.scopeKey) return state
      return createInitialClientPageState(action.scopeKey)
    }
  }
}

// ─── Header hairline controller (P70-NAV-03, pure + DOM-duck-typed) ──────────

export interface HeaderLineScrollTarget {
  readonly scrollTop: number
  addEventListener(type: 'scroll', listener: () => void, options?: { passive?: boolean }): void
  removeEventListener(type: 'scroll', listener: () => void): void
}

export interface HeaderLineController {
  /**
   * Registers the CURRENT page's main scroll container (null = unregister).
   * The LAST registration wins — exactly one main scroller exists per page.
   */
  attach(element: HeaderLineScrollTarget | null): void
  dispose(): void
  isVisible(): boolean
}

/**
 * The hairline is visible iff the registered main scroller exists and its
 * scrollTop is away from the top. Initial state (and the state after any
 * unregister) is NOT visible. Assistant-internal scrollers simply never
 * attach, so they can never move the hairline.
 */
export function createHeaderLineController(onChange: (visible: boolean) => void): HeaderLineController {
  let element: HeaderLineScrollTarget | null = null
  let visible = false

  const commit = (next: boolean) => {
    if (visible === next) return
    visible = next
    onChange(next)
  }

  const handleScroll = () => {
    if (!element) return
    commit(element.scrollTop > 0)
  }

  return {
    attach(next) {
      if (element === next) return
      if (element) {
        element.removeEventListener('scroll', handleScroll)
      }
      element = next
      if (element) {
        element.addEventListener('scroll', handleScroll, { passive: true })
      }
      // A newly attached element reports its CURRENT position: a scroller
      // restored mid-list shows the hairline immediately, a fresh page does
      // not (P70-NAV-03: initial state has no hairline).
      commit(element ? element.scrollTop > 0 : false)
    },
    dispose() {
      this.attach(null)
    },
    isVisible() {
      return visible
    },
  }
}

// ─── React binding ───────────────────────────────────────────────────────────

export interface ClientPageContextValue {
  scope: ClientPageScope
  route: ClientPageRoute
  canGoBack: boolean
  navigate: (route: ClientPageRoute) => void
  back: () => void
  reset: () => void
  /**
   * Registers the current page's MAIN scroll container for the P70-NAV-03
   * header hairline (null unregisters). Call from an effect; the cleanup
   * passes null. The last registration wins.
   */
  registerMainScroller: (element: HTMLElement | null) => void
  /** True iff the registered main scroller is scrolled away from the top. */
  isHeaderLineVisible: boolean
}

const ClientPageContext = createContext<ClientPageContextValue | null>(null)

export function ClientPageProvider({
  scope,
  children,
}: {
  scope: ClientPageScope
  children: ReactNode
}) {
  // Stabilize the scope identity: App passes a fresh literal each render, but
  // the context VALUE (and its consumers' re-renders) must only change when a
  // scope FIELD actually changes.
  const { accountId, productSpaceId, epoch } = scope
  const stableScope = useMemo(
    () => ({ accountId, productSpaceId, epoch }),
    [accountId, productSpaceId, epoch],
  )
  const scopeKey = clientPageScopeKey(stableScope)
  const [state, dispatch] = useReducer(
    clientPageStateReducer,
    scopeKey,
    createInitialClientPageState,
  )
  // Fail-closed re-seal WITHOUT a remount (React render-phase reset): the
  // App also keys this provider by the scope key, but a consumer that mounts
  // it unkeyed still gets the P70-NAV-02 isolation — the stale stack is
  // discarded in the same commit, never painted.
  if (state.scopeKey !== scopeKey) {
    dispatch({ type: 'scope-seal', scopeKey })
  }

  const [isHeaderLineVisible, setHeaderLineVisible] = useState(false)
  const headerLineRef = useRef<HeaderLineController | null>(null)
  if (!headerLineRef.current) {
    headerLineRef.current = createHeaderLineController(setHeaderLineVisible)
  }

  useEffect(() => {
    const controller = headerLineRef.current
    return () => {
      controller?.dispose()
    }
  }, [])

  const registerMainScroller = useCallback((element: HTMLElement | null) => {
    headerLineRef.current?.attach(element)
  }, [])

  const value = useMemo<ClientPageContextValue>(() => ({
    scope: stableScope,
    route: state.stack[state.stack.length - 1]!,
    canGoBack: state.stack.length > 1,
    navigate: (route) => { dispatch({ type: 'navigate', route }) },
    back: () => { dispatch({ type: 'back' }) },
    reset: () => { dispatch({ type: 'reset' }) },
    registerMainScroller,
    isHeaderLineVisible,
  }), [stableScope, state.stack, registerMainScroller, isHeaderLineVisible])

  return (
    <ClientPageContext.Provider value={value}>
      {children}
    </ClientPageContext.Provider>
  )
}

/**
 * Optional accessor for surfaces mounted outside this provider (the workbench
 * TopBar is rendered by TabShell, which in tests/probes can be mounted
 * without the App's provider tree). Returns null there — the hairline then
 * simply stays in its initial (hidden) state, never throws.
 */
export function useOptionalClientPage(): ClientPageContextValue | null {
  return useContext(ClientPageContext)
}

export function useClientPage(): ClientPageContextValue {
  const value = useOptionalClientPage()
  if (!value) {
    throw new Error('useClientPage must be used within ClientPageProvider')
  }
  return value
}
