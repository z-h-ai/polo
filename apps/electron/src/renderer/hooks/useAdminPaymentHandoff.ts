/**
 * Shared trusted-payment handoff (journey review #1).
 *
 * Extracted verbatim from TopBar so a second entry point — the chat banner's
 * 「去充值」 action on an insufficient-credit block — can mint the SAME
 * one-handoff-at-a-time ticket under the SAME scope fences, instead of
 * forking a second payment flow.
 *
 * Semantics kept from TopBar (POO-107):
 * - The visible-scope mirror lives in a ref updated for the WHOLE consumer
 *   lifetime (not per render/menu mount), so a mid-flight handoff is fenced
 *   against account/space/context changes and pending switches.
 * - One handoff at a time per consumer: a re-entry click is dropped silently
 *   — the first click owns the outcome (a second ticket would supersede the
 *   one the user is about to redeem).
 * - `canOpenPayment` gates to personal spaces and enterprise OWNERS; members
 *   get the contact-an-admin copy instead (journey #1 role split).
 */
import { useCallback, useInsertionEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'

/** Role gate for the recharge handoff, factored out for tests: personal
 * spaces pay as themselves; enterprise spaces need the owner role. */
export function canOpenPaymentForSpace(space: {
  pendingSwitch: unknown
  activeProductSpace: { kind: 'personal' | 'enterprise'; role?: string } | null
} | null | undefined): boolean {
  if (!space || space.pendingSwitch) return false
  const active = space.activeProductSpace
  if (!active) return false
  return active.kind === 'personal' || active.role === 'owner'
}

export function useAdminPaymentHandoff() {
  const { t } = useTranslation()
  const productSpace = useOptionalProductSpaceContext()

  const visibleProductSpaceRef = useRef(productSpace)
  useInsertionEffect(() => {
    visibleProductSpaceRef.current = productSpace
    return () => { visibleProductSpaceRef.current = null }
  }, [productSpace])

  const paymentHandoffInFlight = useRef(false)

  const canOpenPayment = canOpenPaymentForSpace(productSpace)

  const openPayment = useCallback(async () => {
    const scope = visibleProductSpaceRef.current
    if (!scope || scope.pendingSwitch || paymentHandoffInFlight.current) return
    paymentHandoffInFlight.current = true
    try {
      const result = await window.electronAPI.adminPaymentHandoff()
      const current = visibleProductSpaceRef.current
      if (!current || current.accountId !== scope.accountId || current.activeProductSpaceId !== scope.activeProductSpaceId
        || current.contextVersion !== scope.contextVersion || current.pendingSwitch) return
      if (!result.success || result.accountId !== current.accountId || result.productSpaceId !== current.activeProductSpaceId) {
        toast.error(t("topbar.account.paymentError")); return
      }
      await window.electronAPI.openUrl(result.url)
    } catch { if (visibleProductSpaceRef.current === scope) toast.error(t("topbar.account.paymentError")) }
    finally { paymentHandoffInFlight.current = false }
  }, [t])

  return { canOpenPayment, openPayment }
}
