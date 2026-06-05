/**
 * Quota Display Logic — pure utility functions for the QuotaDisplay component.
 *
 * These are extracted into a separate module so they can be unit-tested
 * without React/DOM dependencies, following the same pattern as login-logic.ts.
 */

import type { QuotaStatus } from '@polo-ai/shared/admin-api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuotaDisplayState = 'normal' | 'warning' | 'critical' | 'exhausted'

export type FetchQuotaResult =
  | { ok: true; status: QuotaStatus }
  | { ok: false; error: 'session_expired' | 'unavailable' }

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

/**
 * Format a token count into a human-readable string.
 * - Below 1000: raw number
 * - 1000–999999: Xk (e.g. "154K", "1.5K")
 * - 1000000+: XM (e.g. "1M", "1.5M")
 */
export function formatTokens(count: number): string {
  if (count < 1_000) {
    return String(count)
  }
  if (count < 1_000_000) {
    const k = count / 1_000
    // Avoid trailing ".0" — show one decimal place only when needed
    return `${parseFloat(k.toFixed(1))}K`
  }
  const m = count / 1_000_000
  return `${parseFloat(m.toFixed(1))}M`
}

// ---------------------------------------------------------------------------
// getQuotaState
// ---------------------------------------------------------------------------

/**
 * Compute the usage state bucket from (used, limit).
 *
 * | Range           | State      | Color      |
 * |-----------------|------------|------------|
 * | < 75%           | normal     | green      |
 * | 75% – <90%      | warning    | yellow     |
 * | 90% – <100%     | critical   | red        |
 * | >= 100%         | exhausted  | red        |
 */
export function getQuotaState(used: number, limit: number): QuotaDisplayState {
  if (limit <= 0) return 'normal'
  const pct = used / limit
  if (pct >= 1) return 'exhausted'
  if (pct >= 0.9) return 'critical'
  if (pct >= 0.75) return 'warning'
  return 'normal'
}

// ---------------------------------------------------------------------------
// fetchQuotaStatus
// ---------------------------------------------------------------------------

/**
 * Fetch quota status from the Polo AI server proxy.
 * The server proxies GET /api/quota/status to Admin using the stored JWT.
 * No JWT is needed in browser JS — the session cookie handles authentication.
 */
export async function fetchQuotaStatus(): Promise<FetchQuotaResult> {
  try {
    const res = await fetch('/api/quota/status', {
      credentials: 'same-origin',
    })
    if (res.status === 401) {
      return { ok: false, error: 'session_expired' }
    }
    if (!res.ok) {
      return { ok: false, error: 'unavailable' }
    }
    const status = (await res.json()) as QuotaStatus
    return { ok: true, status }
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}
