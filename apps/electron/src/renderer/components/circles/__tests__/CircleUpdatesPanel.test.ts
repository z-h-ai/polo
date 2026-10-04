/**
 * CircleUpdatesPanel tests (POO-70 C5 / POO-94).
 *
 * Coverage required by the card (证明完成): ordering / no-updates / error /
 * no-permission / stale-receipt, plus the P70-CIRCLE-UPDATES-02/03 display
 * guarantees (no open/install/enable action, no exit control). The G2
 * upstream-pending fact is asserted to render as awaiting-upstream — never
 * as an empty-list success and never as an error — and the entries arm is
 * exercised ONLY through fixtures (the runtime bridge cannot produce
 * entries today; nothing is fabricated from the prototype demo content).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { MemberCircleUpstreamPendingState } from '@polo-ai/shared/admin'
import type {
  MemberCircleReadError,
  MemberCircleUpstreamReadState,
} from '@/hooks/useMemberCircles'
import type { CircleUpdateEntry } from '../CircleUpdatesPanel'

GlobalRegistrator.register()
setupI18n()

const { cleanup, render, screen } = await import('@testing-library/react')
const {
  CircleUpdatesPanel,
  formatCircleUpdateTimestamp,
  isCircleUpdatesPermissionBlocked,
  orderCircleUpdatesForDisplay,
} = await import('../CircleUpdatesPanel')

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function g2Pending(): MemberCircleUpstreamPendingState {
  // The EXACT shape C2 getUpdates/refreshUpdates resolve to today (G2).
  return { availability: 'upstream_pending', contractGap: 'G2' }
}

function entry(overrides: Partial<CircleUpdateEntry> = {}): CircleUpdateEntry {
  return {
    id: 'update-1',
    version: '1.2.0',
    summary: 'Fixture summary of the confirmed update.',
    publishedAt: '2026-03-05T10:30:00.000Z',
    ...overrides,
  }
}

const loadingState: MemberCircleUpstreamReadState = { phase: 'loading' }
const readyState = (updates: unknown): MemberCircleUpstreamReadState => ({
  phase: 'ready',
  state: updates as MemberCircleUpstreamPendingState,
})
const failedState = (code: string): MemberCircleUpstreamReadState => ({
  phase: 'failed',
  error: { code: code as MemberCircleReadError['code'], retryable: true },
})

function renderPanel(props: Partial<Parameters<typeof CircleUpdatesPanel>[0]> = {}) {
  return render(
    createElement(I18nextProvider, { i18n }, createElement(CircleUpdatesPanel, {
      circleId: 'circle-a',
      updates: null,
      ...props,
    })),
  )
}

// ---------------------------------------------------------------------------
// Pure ordering helper (P70-CIRCLE-UPDATES-01: 排序稳定)
// ---------------------------------------------------------------------------

describe('orderCircleUpdatesForDisplay', () => {
  it('orders newest authoritative time first', () => {
    const ordered = orderCircleUpdatesForDisplay([
      entry({ id: 'old', publishedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'new', publishedAt: '2026-06-01T00:00:00.000Z' }),
      entry({ id: 'mid', publishedAt: '2026-03-05T10:30:00.000Z' }),
    ])
    expect(ordered.map(e => e.id)).toEqual(['new', 'mid', 'old'])
  })

  it('keeps input order for equal times (stable, engine-independent)', () => {
    const sameTime = '2026-03-05T10:30:00.000Z'
    const ordered = orderCircleUpdatesForDisplay([
      entry({ id: 'first' , publishedAt: sameTime }),
      entry({ id: 'second', publishedAt: sameTime }),
      entry({ id: 'third' , publishedAt: sameTime }),
    ])
    expect(ordered.map(e => e.id)).toEqual(['first', 'second', 'third'])
  })

  it('sinks unparsable times to the end in input order without dropping them', () => {
    const ordered = orderCircleUpdatesForDisplay([
      entry({ id: 'bad-a', publishedAt: 'not-a-date' }),
      entry({ id: 'good', publishedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'bad-b', publishedAt: '' }),
      entry({ id: 'new', publishedAt: '2026-06-01T00:00:00.000Z' }),
    ])
    expect(ordered.map(e => e.id)).toEqual(['new', 'good', 'bad-a', 'bad-b'])
  })
})

describe('formatCircleUpdateTimestamp', () => {
  it('renders a parsable ISO time in the requested locale', () => {
    const text = formatCircleUpdateTimestamp('2026-03-05T10:30:00.000Z', 'en-US')
    expect(text).toContain('2026')
    expect(text.toLowerCase()).toContain('mar')
  })

  it('returns an unparsable value verbatim instead of guessing', () => {
    expect(formatCircleUpdateTimestamp('not-a-date')).toBe('not-a-date')
  })
})

describe('isCircleUpdatesPermissionBlocked', () => {
  it('flags unauthorized/forbidden only', () => {
    expect(isCircleUpdatesPermissionBlocked({ code: 'forbidden', retryable: true })).toBe(true)
    expect(isCircleUpdatesPermissionBlocked({ code: 'unauthorized', retryable: true })).toBe(true)
    expect(isCircleUpdatesPermissionBlocked({ code: 'network_error', retryable: true })).toBe(false)
    expect(isCircleUpdatesPermissionBlocked(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Read states (P70-CIRCLE-UPDATES-01: 没有更新与获取失败分别反馈)
// ---------------------------------------------------------------------------

describe('CircleUpdatesPanel read states', () => {
  it('renders loading when no C2 read state has been issued yet', () => {
    renderPanel({ updates: g2Pending(), state: undefined })
    expect(screen.getByTestId('circle-updates-loading')).toBeTruthy()
    expect(screen.queryByTestId('circle-updates-pending-upstream')).toBeNull()
  })

  it('renders loading while the C2 read is in flight', () => {
    renderPanel({ updates: null, state: loadingState })
    expect(screen.getByTestId('circle-updates-loading')).toBeTruthy()
  })

  it('renders the G2 upstream_pending fact as awaiting-upstream, never as empty success or error', () => {
    renderPanel({ updates: g2Pending(), state: readyState(g2Pending()) })
    const pending = screen.getByTestId('circle-updates-pending-upstream')
    expect(pending).toBeTruthy()
    expect(screen.queryByTestId('circle-updates-empty')).toBeNull()
    expect(screen.queryByTestId('circle-updates-error')).toBeNull()
    expect(screen.queryByTestId('circle-updates-list')).toBeNull()
  })

  it('renders awaiting-upstream when ready but no updates fact exists in this scope', () => {
    renderPanel({ updates: null, state: readyState(null) })
    expect(screen.getByTestId('circle-updates-pending-upstream')).toBeTruthy()
  })

  it('renders a legitimately empty confirmed list as its own no-updates state', () => {
    renderPanel({
      updates: { availability: 'entries', entries: [] },
      state: readyState(null),
    })
    expect(screen.getByTestId('circle-updates-empty')).toBeTruthy()
    expect(screen.queryByTestId('circle-updates-pending-upstream')).toBeNull()
    expect(screen.queryByTestId('circle-updates-error')).toBeNull()
  })

  it('renders a failed read as an error with retry, and onRetry wires the caller', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const onRetry = jest.fn()
    renderPanel({ updates: null, state: failedState('network_error'), onRetry })
    const banner = screen.getByTestId('circle-updates-error')
    expect(banner).toBeTruthy()
    expect(screen.queryByTestId('circle-updates-empty')).toBeNull()
    const retry = screen.getByTestId('circle-updates-retry') as HTMLButtonElement
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the permission state instead of update content on unauthorized/forbidden (fail closed)', () => {
    for (const code of ['unauthorized', 'forbidden']) {
      const { unmount } = renderPanel({ updates: g2Pending(), state: failedState(code) })
      expect(screen.getByTestId('circle-updates-forbidden')).toBeTruthy()
      expect(screen.queryByTestId('circle-updates-list')).toBeNull()
      expect(screen.queryByTestId('circle-updates-retry')).toBeNull()
      expect(screen.queryByTestId('circle-updates-error')).toBeNull()
      unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// Confirmed entries (P70-CIRCLE-UPDATES-01: 版本、摘要和权威时间)
// ---------------------------------------------------------------------------

describe('CircleUpdatesPanel confirmed entries', () => {
  it('renders version, summary and authoritative time, newest first', () => {
    renderPanel({
      updates: {
        availability: 'entries',
        entries: [
          entry({ id: 'old', version: '1.0.0', summary: 'Initial fixture release.', publishedAt: '2026-01-01T00:00:00.000Z' }),
          entry({ id: 'new', version: '1.2.0', summary: 'Newest fixture release.', publishedAt: '2026-06-01T00:00:00.000Z' }),
        ],
      },
      state: readyState(null),
    })
    const list = screen.getByTestId('circle-updates-list')
    expect(list).toBeTruthy()
    expect(screen.getByTestId('circle-update-entry-0').getAttribute('data-testid')).toBe('circle-update-entry-0')
    expect(screen.getByTestId('circle-update-entry-version-0').textContent).toBe('1.2.0')
    expect(screen.getByTestId('circle-update-entry-0').textContent).toContain('Newest fixture release.')
    expect(screen.getByTestId('circle-update-entry-1').textContent).toContain('1.0.0')
    expect(screen.getByTestId('circle-update-entry-1').textContent).toContain('Initial fixture release.')
    expect(screen.getByTestId('circle-update-entry-published-at-0').textContent?.length).toBeGreaterThan(0)
    expect(screen.getByTestId('circle-update-entry-published-at-1').textContent?.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Scope isolation (P70-CIRCLE-UPDATES-03: 旧回执不串圈)
// ---------------------------------------------------------------------------

describe('CircleUpdatesPanel scope isolation', () => {
  it('shows only the props of the current circleId — no panel cache can bleed a previous receipt', () => {
    const view = renderPanel({
      circleId: 'circle-a',
      updates: {
        availability: 'entries',
        entries: [entry({ id: 'a1', summary: 'Circle A fixture receipt.' })],
      },
      state: readyState(null),
    })
    expect(screen.getByTestId('circle-updates-list')).toBeTruthy()
    expect(screen.getByTestId('circle-updates-panel').getAttribute('data-circle-id')).toBe('circle-a')

    // Switch to circle B whose C2 read is still loading: circle A's receipt
    // must disappear in the same commit — the panel holds no cache.
    view.rerender(
      createElement(I18nextProvider, { i18n }, createElement(CircleUpdatesPanel, {
        circleId: 'circle-b',
        updates: null,
        state: loadingState,
      })),
    )
    expect(screen.getByTestId('circle-updates-panel').getAttribute('data-circle-id')).toBe('circle-b')
    expect(screen.queryByTestId('circle-updates-list')).toBeNull()
    expect(screen.queryByText('Circle A fixture receipt.')).toBeNull()
    expect(screen.getByTestId('circle-updates-loading')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Display guarantees (P70-CIRCLE-UPDATES-02 / -03)
// ---------------------------------------------------------------------------

describe('CircleUpdatesPanel display guarantees', () => {
  it('renders no action control besides the failure retry (updates never open/install/enable)', () => {
    const { container } = renderPanel({
      updates: {
        availability: 'entries',
        entries: [entry(), entry({ id: 'u2' })],
      },
      state: readyState(null),
    })
    // P70-CIRCLE-UPDATES-02: informational only — not even a retry exists in
    // the ready path, and there is no open/install/enable affordance.
    expect(container.querySelectorAll('button, a')).toHaveLength(0)
  })

  it('never renders an exit control in any state (exit lives only in the subscription section)', () => {
    const states: Array<Parameters<typeof renderPanel>[0]> = [
      { updates: null, state: undefined },
      { updates: g2Pending(), state: readyState(g2Pending()) },
      { updates: { availability: 'entries', entries: [] }, state: readyState(null) },
      { updates: null, state: failedState('network_error'), onRetry: () => {} },
      { updates: null, state: failedState('forbidden') },
    ]
    for (const props of states) {
      const { container, unmount } = renderPanel(props)
      const buttons = Array.from(container.querySelectorAll('button, a'))
      for (const button of buttons) {
        expect(button.textContent).not.toContain('退出')
        expect(button.textContent?.toLowerCase()).not.toContain('leave')
      }
      unmount()
    }
  })
})
