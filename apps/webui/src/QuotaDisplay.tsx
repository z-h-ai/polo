/**
 * QuotaDisplay — WebUI top bar quota usage indicator.
 *
 * Fixed-position overlay that appears in the top-right corner of the viewport,
 * aligned with the top bar. Only rendered in platform mode.
 *
 * State matrix:
 * | State     | Text                       | Color  | Bar           |
 * |-----------|----------------------------|--------|---------------|
 * | loading   | "Loading..."               | neutral| indeterminate |
 * | normal    | "154K / 1M"                | green  | 15%           |
 * | warning   | "820K / 1M"                | yellow | 82%           |
 * | critical  | "950K / 1M"                | red    | 95%           |
 * | exhausted | "1M / 1M — Quota exceeded" | red    | 100%          |
 * | error     | "Usage unavailable"        | gray   | hidden        |
 */

import { useState, useEffect, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { platformModeAtom, quotaRefreshTriggerAtom } from '@/atoms/platform'
import { formatTokens, getQuotaState, fetchQuotaStatus } from './quota-display-logic'
import type { QuotaStatus } from '@polo-ai/shared/admin-api'

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

type IndicatorState = ReturnType<typeof getQuotaState> | 'loading' | 'error'

function getColorClasses(state: IndicatorState): { text: string; bar: string } {
  switch (state) {
    case 'normal':
      return { text: 'text-green-600 dark:text-green-400', bar: 'bg-green-500' }
    case 'warning':
      return { text: 'text-yellow-600 dark:text-yellow-400', bar: 'bg-yellow-500' }
    case 'critical':
    case 'exhausted':
      return { text: 'text-red-600 dark:text-red-400', bar: 'bg-red-500' }
    default:
      // loading / error
      return { text: 'text-foreground/40', bar: 'bg-foreground/20' }
  }
}

// ---------------------------------------------------------------------------
// QuotaDisplay
// ---------------------------------------------------------------------------

export function QuotaDisplay() {
  const platformMode = useAtomValue(platformModeAtom)
  const refreshTrigger = useAtomValue(quotaRefreshTriggerAtom)

  const [quotaStatus, setQuotaStatus] = useState<QuotaStatus | null>(null)
  const [fetchState, setFetchState] = useState<'loading' | 'ready' | 'error'>('loading')

  const loadQuota = useCallback(async () => {
    const result = await fetchQuotaStatus()
    if (result.ok) {
      setQuotaStatus(result.status)
      setFetchState('ready')
    } else if (result.error === 'session_expired') {
      // Redirect to login page on session expiry
      window.location.href = '/login'
    } else {
      // Keep previous quota if available; show error state otherwise
      setFetchState('error')
    }
  }, [])

  useEffect(() => {
    if (!platformMode) return
    loadQuota()
  }, [platformMode, loadQuota, refreshTrigger])

  // Not in platform mode → render nothing
  if (!platformMode) return null

  // Loading state (no previous data)
  if (fetchState === 'loading' && !quotaStatus) {
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-foreground/40"
        aria-label="Loading quota status"
        data-testid="quota-display"
        data-quota-state="loading"
      >
        <div className="h-1 w-14 rounded-full overflow-hidden bg-foreground/10">
          <div className="h-full w-1/2 animate-pulse bg-foreground/20 rounded-full" />
        </div>
        <span>Loading...</span>
      </div>
    )
  }

  // Error state (and no cached previous data)
  if (fetchState === 'error' && !quotaStatus) {
    return (
      <div
        className="flex items-center px-2 py-1 text-[11px] text-foreground/40"
        data-testid="quota-display"
        data-quota-state="error"
        aria-label="Usage unavailable"
      >
        <span>Usage unavailable</span>
      </div>
    )
  }

  // No data at all
  if (!quotaStatus) return null

  const state = getQuotaState(quotaStatus.used, quotaStatus.limit)
  const pct = quotaStatus.limit > 0
    ? Math.min(Math.round((quotaStatus.used / quotaStatus.limit) * 100), 100)
    : 0
  const { text: textClass, bar: barClass } = getColorClasses(state)

  const usedFmt = formatTokens(quotaStatus.used)
  const limitFmt = formatTokens(quotaStatus.limit)
  const label = state === 'exhausted'
    ? `${usedFmt} / ${limitFmt} — Quota exceeded`
    : `${usedFmt} / ${limitFmt}`

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 text-[11px] transition-colors duration-300 ${textClass}`}
      data-testid="quota-display"
      data-quota-state={state}
      aria-label={`Token usage: ${label}`}
    >
      <div className="h-1 w-14 rounded-full overflow-hidden bg-foreground/10">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barClass}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <span className="whitespace-nowrap font-mono">{label}</span>
    </div>
  )
}
