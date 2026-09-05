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
  // ProductSpace identity: every account or space transition (including
  // sign-out) invalidates all pending handoffs before any consumer can
  // take them across a context boundary.
  useEffect(() => {
    syncProductSpaceLaunchHandoffContext(
      value.accountId && value.activeProductSpaceId
        ? { accountId: value.accountId, productSpaceId: value.activeProductSpaceId }
        : null,
    )
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
