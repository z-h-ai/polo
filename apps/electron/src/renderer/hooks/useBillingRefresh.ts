/**
 * POO-177 QUOTA-01/02 — the bounded in-flight state of the manual billing
 * refresh.
 *
 * The hook owns exactly ONE in-flight business operation: a click while busy
 * merges into it (never a second Admin GET), the settlement carries the
 * opaque scope key captured at trigger, and that key is re-checked at settle
 * so a receipt computed for a superseded account/space/epoch never lands.
 * Busy clears in the same finally that ends the operation — a stale receipt
 * is dropped, but the operation IS over, so the next click starts fresh.
 *
 * The real read function is injectable; this hook never caches quota, never
 * persists the legacy DTO, and never decides what the receipt means — App
 * applies the outcome through lib/billing-refresh decisions.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminRefreshBillingRpcInput } from '@polo-ai/shared/admin/schemas'
import type { AdminRefreshBillingRpcResult } from '../../shared/types'

export interface BillingRefreshSettlement {
  /** Monotonic id of the business operation this settlement belongs to. */
  requestId: number
  /** Composite scope captured at trigger; re-checked (not trusted) at settle. */
  scopeKey: string
  result: AdminRefreshBillingRpcResult | null
  error: unknown
}

export function useBillingRefresh(options: {
  read: (input: AdminRefreshBillingRpcInput) => Promise<AdminRefreshBillingRpcResult>
  /** Composite scope key (account/space/epoch/generation/pending) — App-owned. */
  getScopeKey: () => string
}): {
  busy: boolean
  refresh: (
    input: AdminRefreshBillingRpcInput,
  ) => Promise<BillingRefreshSettlement | null>
} {
  const { read, getScopeKey } = options
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(
    async (input: AdminRefreshBillingRpcInput): Promise<BillingRefreshSettlement | null> => {
      // One in-flight business operation: concurrent clicks merge into it.
      if (busyRef.current) return null
      const requestId = ++requestIdRef.current
      const scopeKey = getScopeKey()
      busyRef.current = true
      setBusy(true)
      let result: AdminRefreshBillingRpcResult | null = null
      let error: unknown = null
      try {
        result = await read(input)
      } catch (cause) {
        error = cause
      } finally {
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
      }
      // A superseded operation (a later click could only start after this
      // one settled) or a moved-on scope: drop the receipt entirely — App
      // never sees, toasts or applies it.
      if (requestIdRef.current !== requestId) return null
      if (!mountedRef.current || getScopeKey() !== scopeKey) return null
      return { requestId, scopeKey, result, error }
    },
    [read, getScopeKey],
  )

  return { busy, refresh }
}
