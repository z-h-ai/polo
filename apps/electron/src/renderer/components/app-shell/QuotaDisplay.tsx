import { useCallback, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { QuotaStatus } from '@polo-ai/shared/admin-api'
import { quotaRefreshTriggerAtom, setPlatformModeAtom } from '@/atoms/platform'
import { formatTokens, getQuotaState } from '@/lib/quota-display-logic'

type IndicatorState = ReturnType<typeof getQuotaState> | 'error'

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
      return { text: 'text-foreground/40', bar: 'bg-foreground/20' }
  }
}

export function QuotaDisplay() {
  const refreshTrigger = useAtomValue(quotaRefreshTriggerAtom)
  const setPlatformMode = useSetAtom(setPlatformModeAtom)
  const [quotaStatus, setQuotaStatus] = useState<QuotaStatus | null>(null)
  const [fetchState, setFetchState] = useState<'idle' | 'ready' | 'error'>('idle')
  const [enabled, setEnabled] = useState<boolean | null>(null)

  const loadQuota = useCallback(async () => {
    const result = await window.electronAPI.getQuotaStatus()

    if (result === null) {
      setEnabled(false)
      setPlatformMode(false)
      setQuotaStatus(null)
      setFetchState('idle')
      return
    }

    setEnabled(true)
    setPlatformMode(true)

    if (result.ok) {
      setQuotaStatus(result.status)
      setFetchState('ready')
    } else {
      setFetchState('error')
    }
  }, [setPlatformMode])

  useEffect(() => {
    loadQuota()
  }, [loadQuota, refreshTrigger])

  if (!enabled) return null

  if (fetchState === 'error' && !quotaStatus) {
    return (
      <div
        className="titlebar-no-drag flex items-center px-2 py-1 text-[11px] text-foreground/40"
        data-testid="quota-display"
        data-quota-state="error"
        aria-label="Usage unavailable"
      >
        <span>Usage unavailable</span>
      </div>
    )
  }

  if (!quotaStatus) return null

  const state = getQuotaState(quotaStatus.used, quotaStatus.limit)
  const pct = quotaStatus.limit > 0
    ? Math.min(Math.round((quotaStatus.used / quotaStatus.limit) * 100), 100)
    : 0
  const { text: textClass, bar: barClass } = getColorClasses(state)
  const usedFmt = formatTokens(quotaStatus.used)
  const limitFmt = formatTokens(quotaStatus.limit)
  const label = state === 'exhausted'
    ? `${usedFmt} / ${limitFmt} - Quota exceeded`
    : `${usedFmt} / ${limitFmt}`

  return (
    <div
      className={`titlebar-no-drag flex items-center gap-1.5 px-2 py-1 text-[11px] transition-colors duration-300 ${textClass}`}
      data-testid="quota-display"
      data-quota-state={state}
      aria-label={`Token usage: ${label}`}
    >
      <div className="h-1 w-14 overflow-hidden rounded-full bg-foreground/10">
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
