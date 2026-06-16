import type { QuotaStatus } from '@polo-ai/shared/admin-api'

export type QuotaDisplayState = 'normal' | 'warning' | 'critical' | 'exhausted'

export type FetchQuotaResult =
  | { ok: true; status: QuotaStatus }
  | { ok: false; error: 'session_expired' | 'unavailable' }

export function formatTokens(count: number): string {
  if (count < 1_000) {
    return String(count)
  }
  if (count < 1_000_000) {
    const k = count / 1_000
    return `${parseFloat(k.toFixed(1))}K`
  }
  const m = count / 1_000_000
  return `${parseFloat(m.toFixed(1))}M`
}

export function getQuotaState(used: number, limit: number): QuotaDisplayState {
  if (limit <= 0) return 'normal'
  const pct = used / limit
  if (pct >= 1) return 'exhausted'
  if (pct >= 0.9) return 'critical'
  if (pct >= 0.75) return 'warning'
  return 'normal'
}
