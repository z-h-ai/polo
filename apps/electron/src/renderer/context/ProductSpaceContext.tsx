import * as React from 'react'
import { createContext, useContext, useMemo, useRef } from 'react'
import type { ProductSpaceSummary, ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { PendingSpaceSwitch } from '@/hooks/useProductSpaceContext'
import {
  createProductSpaceLaunchHandoffStore,
  type PendingProductSpaceAppLaunch,
  type ProductSpaceAppLaunchContext,
  type ProductSpaceAppLaunchListener,
  type ProductSpaceAppLaunchRequest,
  type ProductSpaceLaunchHandoffStore,
} from '@/lib/product-space-app-launch-handoff'

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

/**
 * The sealed launch handoff store is owned by the mounted Provider instance:
 * it holds no module state, is created once per provider mount, and dies with
 * it. Liveness is enforced per call from the COMMITTED ProductSpace context
 * (see useProductSpaceAppLaunchHandoff), so neither speculative renders nor
 * effect ordering can leak a handoff across a context boundary.
 */
const LaunchHandoffStoreContext = createContext<ProductSpaceLaunchHandoffStore | null>(null)

export function ProductSpaceProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: ProductSpaceContextValue
}) {
  // React-sanctioned lazy initialization: created once per provider mount,
  // never during speculative re-renders of an already-mounted provider.
  const storeRef = useRef<ProductSpaceLaunchHandoffStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createProductSpaceLaunchHandoffStore()
  }
  return (
    <LaunchHandoffStoreContext.Provider value={storeRef.current}>
      <ProductSpaceContext.Provider value={value}>
        {children}
      </ProductSpaceContext.Provider>
    </LaunchHandoffStoreContext.Provider>
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

export interface ProductSpaceAppLaunchHandoff {
  /**
   * Seals credentials in memory and publishes an opaque handle to POO-47.
   * Fails closed unless the publisher targets the committed context.
   */
  publish(
    accountId: string,
    launch: ResolveLaunchResponse,
  ): ProductSpaceAppLaunchRequest
  /** Single-attempt, liveness-checked consumption for POO-47. */
  take(
    handoffId: string,
    expected: ProductSpaceAppLaunchContext,
  ): PendingProductSpaceAppLaunch | null
  /** Subscribes to published handles (POO-47 consumer side). */
  onLaunch(listener: ProductSpaceAppLaunchListener): () => void
}

/**
 * Handoff API bound to the CURRENT committed ProductSpace context. Every
 * publish/take validates against this context read, so:
 * - a subtree consumer running layout effects of a NEW context commit can
 *   never take a handle sealed under the previous context (the context read
 *   already returns the new commit), and
 * - a discarded speculative render mutates nothing — the committed context
 *   keeps publishing and taking exactly as before.
 */
export function useProductSpaceAppLaunchHandoff(): ProductSpaceAppLaunchHandoff {
  const store = useContext(LaunchHandoffStoreContext)
  const { accountId, activeProductSpaceId } = useProductSpaceContext()
  return useMemo(() => {
    const live = { accountId, productSpaceId: activeProductSpaceId }
    if (!store) {
      return {
        publish: (_publisherAccountId: string, _launch: ResolveLaunchResponse) => {
          throw new Error('ProductSpace App launch handoff requires an active ProductSpace')
        },
        take: (_handoffId: string, _expected: ProductSpaceAppLaunchContext) => null,
        onLaunch: (_listener: ProductSpaceAppLaunchListener) => () => {},
      }
    }
    return {
      publish: (publisherAccountId: string, launch: ResolveLaunchResponse) =>
        store.publish(live, publisherAccountId, launch),
      take: (handoffId: string, expected: ProductSpaceAppLaunchContext) =>
        store.take(live, handoffId, expected),
      onLaunch: (listener: ProductSpaceAppLaunchListener) => store.onLaunch(listener),
    }
  }, [store, accountId, activeProductSpaceId])
}
