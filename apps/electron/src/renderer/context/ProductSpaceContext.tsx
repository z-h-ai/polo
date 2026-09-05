import * as React from 'react'
import { createContext, useContext, useEffect } from 'react'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { PendingSpaceSwitch } from '@/hooks/useProductSpaceContext'
import { syncProductSpaceLaunchHandoffContext } from '@/lib/product-space-app-launch-handoff'

export interface ProductSpaceContextValue {
  accountId: string
  activeProductSpaceId: string
  activeProductSpace: ProductSpaceSummary
  productSpaces: ProductSpaceSummary[]
  allProductSpaces: ProductSpaceSummary[]
  personalProductSpaceId: string
  productSpaceContextKey: string
  contextVersion: number
  pendingSwitch: PendingSpaceSwitch | null
  onSelectProductSpace: (productSpaceId: string) => void
  onRefreshProductSpaces: () => void
  onConfirmStopAndSwitch: () => void
  onRetryFailedStops: () => void
  onRetryTargetLoad: () => void
  onCancelSwitch: () => void
  onDismissTargetAccessLost: () => void
  /** R32-4: per-item atomic termination inside the active switch transaction. */
  onStopSwitchExecution: (executionId: string) => void
}

const ProductSpaceContext = createContext<ProductSpaceContextValue | null>(null)

export function ProductSpaceProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: ProductSpaceContextValue
}) {
  // The sealed launch handoff store is bound to the authoritative live
  // ProductSpace identity. The invalidation runs at the RENDER boundary —
  // before the committing subtree's layout or passive effects can run — so a
  // consumer mounted under the NEW context can never take a handoff that was
  // sealed under the previous one (child layout effects run before any
  // provider effect, so an effect-only binding leaves a takeover window).
  // The sync is idempotent per (account, space): re-renders with the same
  // context are no-ops. A discarded concurrent render only clears sealed
  // launches (fail closed); the next render re-affirms the committed context.
  const handoffContext = value.accountId && value.activeProductSpaceId
    ? { accountId: value.accountId, productSpaceId: value.activeProductSpaceId }
    : null
  syncProductSpaceLaunchHandoffContext(handoffContext)
  // Passive effect: re-affirm after commit and clear on unmount/sign-out —
  // the render-phase sync above can never run for an unmounted provider.
  useEffect(() => {
    syncProductSpaceLaunchHandoffContext(handoffContext)
    return () => {
      syncProductSpaceLaunchHandoffContext(null)
    }
  }, [value.accountId, value.activeProductSpaceId])
  return (
    <ProductSpaceContext.Provider value={value}>
      {children}
    </ProductSpaceContext.Provider>
  )
}

export function useProductSpaceContext(): ProductSpaceContextValue {
  const value = useContext(ProductSpaceContext)
  if (!value) {
    throw new Error('useProductSpaceContext must be used within ProductSpaceProvider')
  }
  return value
}

export function useOptionalProductSpaceContext(): ProductSpaceContextValue | null {
  return useContext(ProductSpaceContext)
}
