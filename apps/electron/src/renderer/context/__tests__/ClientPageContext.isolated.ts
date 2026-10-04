import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ClientPageContextValue } from '../ClientPageContext'

// Render-level probe file (own bun process, shared-process pattern from
// MemberCatalogContext.isolated.ts): proves the React WIRING of
// ClientPageContext — the pure reducer/controller logic lives in
// ClientPageContext.test.ts. ClientPageContext touches no electronAPI, so no
// host stub is needed beyond the happy-dom globals.
GlobalRegistrator.register()

const { cleanup, render, act } = await import('@testing-library/react')
const {
  ClientPageProvider,
  useClientPage,
  useOptionalClientPage,
} = await import('../ClientPageContext')

afterEach(() => {
  cleanup()
})

type ProbeRecorder = { current: ClientPageContextValue | null }

function ClientPageProbe({ recorder }: { recorder: ProbeRecorder }) {
  recorder.current = useClientPage()
  return null
}

function OptionalProbe({ recorder }: { recorder: ProbeRecorder }) {
  recorder.current = useOptionalClientPage()
  return null
}

const SCOPE_A = { accountId: 'acct-n1-fixture', productSpaceId: 'space-1', epoch: 3 }
const SCOPE_B = { accountId: 'acct-n1-fixture', productSpaceId: 'space-2', epoch: 3 }

interface ScrollStub {
  readonly scrollTop: number
  addEventListener(type: 'scroll', listener: () => void): void
  removeEventListener(type: 'scroll', listener: () => void): void
  setScroll(value: number): void
}

function makeScrollStub(initialScrollTop = 0): ScrollStub {
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
  }
}

describe('ClientPageProvider render wiring (P70-NAV-02 scope seal)', () => {
  it('reseals the route stack when the scope prop changes WITHOUT a keyed remount', () => {
    const recorder: ProbeRecorder = { current: null }
    const { rerender } = render(createElement(ClientPageProvider, {
      scope: SCOPE_A,
      children: createElement(ClientPageProbe, { recorder }),
    }))
    expect(recorder.current!.route).toEqual({ kind: 'home' })

    act(() => {
      recorder.current!.navigate({ kind: 'circles' })
    })
    expect(recorder.current!.route).toEqual({ kind: 'circles' })
    expect(recorder.current!.canGoBack).toBe(true)

    // The committed space switch in production remounts via the App key; this
    // rerender changes ONLY the scope prop, proving the fail-closed render-
    // phase seal resets the stack even when the outer key is forgotten.
    act(() => {
      rerender(createElement(ClientPageProvider, {
        scope: SCOPE_B,
        children: createElement(ClientPageProbe, { recorder }),
      }))
    })
    expect(recorder.current!.route).toEqual({ kind: 'home' })
    expect(recorder.current!.canGoBack).toBe(false)
    expect(recorder.current!.scope).toEqual(SCOPE_B)

    // An epoch bump (logout → re-login of the SAME account) is also a new
    // scope: navigating deeper under scope B cannot leak into it.
    act(() => {
      recorder.current!.navigate({ kind: 'circle-detail', circleId: 'c1', section: 'content' })
    })
    act(() => {
      rerender(createElement(ClientPageProvider, {
        scope: { ...SCOPE_B, epoch: 4 },
        children: createElement(ClientPageProbe, { recorder }),
      }))
    })
    expect(recorder.current!.route).toEqual({ kind: 'home' })
    expect(recorder.current!.scope.epoch).toBe(4)
  })

  it('keeps the same stack across rerenders of an UNCHANGED scope (no reset churn)', () => {
    const recorder: ProbeRecorder = { current: null }
    const { rerender } = render(createElement(ClientPageProvider, {
      scope: SCOPE_A,
      children: createElement(ClientPageProbe, { recorder }),
    }))
    act(() => {
      recorder.current!.navigate({ kind: 'circles' })
    })

    act(() => {
      rerender(createElement(ClientPageProvider, {
        scope: { ...SCOPE_A },
        children: createElement(ClientPageProbe, { recorder }),
      }))
    })
    // A field-identical scope is the same scope — navigation survives.
    expect(recorder.current!.route).toEqual({ kind: 'circles' })
    expect(recorder.current!.canGoBack).toBe(true)
  })
})

describe('useOptionalClientPage outside a provider', () => {
  it('returns null instead of throwing (bar/TopBar probes without the App tree)', () => {
    const recorder: ProbeRecorder = { current: null }
    render(createElement(OptionalProbe, { recorder }))
    expect(recorder.current).toBeNull()
  })
})

describe('registerMainScroller wiring (P70-NAV-03 hairline)', () => {
  it('drives isHeaderLineVisible from the registered main scroller only', () => {
    const recorder: ProbeRecorder = { current: null }
    render(createElement(ClientPageProvider, {
      scope: SCOPE_A,
      children: createElement(ClientPageProbe, { recorder }),
    }))
    // Initial state: no hairline.
    expect(recorder.current!.isHeaderLineVisible).toBe(false)

    const scroller = makeScrollStub(0)
    act(() => {
      recorder.current!.registerMainScroller(scroller as unknown as HTMLElement)
    })
    expect(recorder.current!.isHeaderLineVisible).toBe(false)

    // Main scroller scrolls away from the top: the hairline appears.
    act(() => {
      scroller.setScroll(64)
    })
    expect(recorder.current!.isHeaderLineVisible).toBe(true)

    act(() => {
      scroller.setScroll(0)
    })
    expect(recorder.current!.isHeaderLineVisible).toBe(false)

    // Unregistering hides the hairline and detaches the listener: later
    // scrolls of the stale element must not resurface it.
    act(() => {
      recorder.current!.registerMainScroller(null)
    })
    act(() => {
      scroller.setScroll(120)
    })
    expect(recorder.current!.isHeaderLineVisible).toBe(false)
  })
})
