/**
 * Quota Display Logic — pure utility functions for the QuotaDisplay component.
 *
 * These are extracted into a separate module so they can be unit-tested
 * without React/DOM dependencies, following the same pattern as login-logic.ts.
 */

import type { FetchQuotaResult } from '@/lib/quota-display-logic'
export { formatTokens, getQuotaState } from '@/lib/quota-display-logic'
export type { FetchQuotaResult, QuotaDisplayState } from '@/lib/quota-display-logic'

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
