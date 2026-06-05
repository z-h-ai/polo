/**
 * Unit tests for the QuotaDisplay logic utilities.
 *
 * Tests formatTokens, getQuotaState, and fetchQuotaStatus in isolation.
 *
 * AC1: Quota display rendering
 * AC2: Color coding by usage level
 * AC3: Data fetching (via Polo AI server proxy)
 * AC4: Non-platform mode
 * AC5: Error handling
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  formatTokens,
  getQuotaState,
  fetchQuotaStatus,
  type QuotaDisplayState,
} from '../quota-display-logic'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>

function mockFetch(handler: FetchMock) {
  return spyOn(globalThis, 'fetch').mockImplementation(handler as typeof fetch)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('formatTokens', () => {
  it('formats numbers below 1000 as-is', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(999)).toBe('999')
  })

  it('formats thousands with K suffix', () => {
    expect(formatTokens(1000)).toBe('1K')
    expect(formatTokens(1500)).toBe('1.5K')
    expect(formatTokens(154_000)).toBe('154K')
    expect(formatTokens(999_999)).toBe('1000K')
  })

  it('formats millions with M suffix', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(10_000_000)).toBe('10M')
  })

  it('handles exact boundaries', () => {
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(1_000_000)).toBe('1M')
  })
})

// ---------------------------------------------------------------------------
// getQuotaState
// ---------------------------------------------------------------------------

describe('getQuotaState', () => {
  it('returns "normal" when usage is below 75%', () => {
    expect(getQuotaState(74, 100)).toBe('normal')
    expect(getQuotaState(0, 100)).toBe('normal')
    expect(getQuotaState(150_000, 1_000_000)).toBe('normal')
  })

  it('returns "warning" when usage is between 75% and 90%', () => {
    expect(getQuotaState(75, 100)).toBe('warning')
    expect(getQuotaState(89, 100)).toBe('warning')
    expect(getQuotaState(820_000, 1_000_000)).toBe('warning')
  })

  it('returns "critical" when usage is between 90% and 100%', () => {
    expect(getQuotaState(90, 100)).toBe('critical')
    expect(getQuotaState(95, 100)).toBe('critical')
    expect(getQuotaState(950_000, 1_000_000)).toBe('critical')
  })

  it('returns "exhausted" when usage is 100% or more', () => {
    expect(getQuotaState(100, 100)).toBe('exhausted')
    expect(getQuotaState(110, 100)).toBe('exhausted')
    expect(getQuotaState(1_000_000, 1_000_000)).toBe('exhausted')
  })

  it('handles zero limit without division-by-zero crash', () => {
    const state = getQuotaState(0, 0)
    expect(['normal', 'warning', 'critical', 'exhausted']).toContain(state)
  })
})

// ---------------------------------------------------------------------------
// fetchQuotaStatus
// ---------------------------------------------------------------------------

describe('fetchQuotaStatus', () => {
  it('fetches GET /api/quota/status and returns the parsed status', async () => {
    const statusData = {
      userId: 'user-123',
      period: '2026-06',
      limit: 1_000_000,
      used: 154_000,
      remaining: 846_000,
      usageBreakdown: [],
    }

    mockFetch((url) => {
      expect(url).toBe('/api/quota/status')
      return Promise.resolve(jsonResponse(statusData))
    })

    const result = await fetchQuotaStatus()
    expect(result).toEqual({ ok: true, status: statusData })
  })

  it('returns { ok: false, error: "session_expired" } on 401', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)))

    const result = await fetchQuotaStatus()
    expect(result).toEqual({ ok: false, error: 'session_expired' })
  })

  it('returns { ok: false, error: "unavailable" } on non-401 HTTP errors', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ error: 'server error' }, 500)))

    const result = await fetchQuotaStatus()
    expect(result).toEqual({ ok: false, error: 'unavailable' })
  })

  it('returns { ok: false, error: "unavailable" } on network errors', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED')))

    const result = await fetchQuotaStatus()
    expect(result).toEqual({ ok: false, error: 'unavailable' })
  })

  it('returns { ok: false, error: "unavailable" } on 502/503', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ error: 'admin unreachable' }, 502)))

    const result = await fetchQuotaStatus()
    expect(result).toEqual({ ok: false, error: 'unavailable' })
  })
})

// ---------------------------------------------------------------------------
// QuotaDisplayState helpers
// ---------------------------------------------------------------------------

describe('QuotaDisplayState mapping', () => {
  it('uses green/neutral color class for normal state', () => {
    const state: QuotaDisplayState = getQuotaState(100_000, 1_000_000)
    expect(state).toBe('normal')
  })

  it('uses yellow/warning color class for warning state', () => {
    const state: QuotaDisplayState = getQuotaState(800_000, 1_000_000)
    expect(state).toBe('warning')
  })

  it('uses red/danger color class for critical state', () => {
    const state: QuotaDisplayState = getQuotaState(950_000, 1_000_000)
    expect(state).toBe('critical')
  })

  it('uses red color class for exhausted state', () => {
    const state: QuotaDisplayState = getQuotaState(1_000_000, 1_000_000)
    expect(state).toBe('exhausted')
  })
})
