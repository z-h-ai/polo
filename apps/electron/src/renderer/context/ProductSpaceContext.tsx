import * as React from 'react'
import { createContext, useContext } from 'react'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { PendingSpaceSwitch } from '@/hooks/useProductSpaceContext'

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
