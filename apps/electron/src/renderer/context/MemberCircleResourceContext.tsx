import * as React from 'react'
import { createContext, useContext } from 'react'
import type { AppCatalogInstance } from '@/hooks/useAppCatalog'
import {
  useMemberCirclesResource,
  type MemberCirclesResource,
  type MemberCirclesResourceOptions,
} from '@/hooks/useMemberCircles'

export type {
  MemberCirclesResource,
  MemberCirclesResourceOptions,
} from '@/hooks/useMemberCircles'

/**
 * POO-70 C2 (P70-CIRCLE-STATE-01/02/03): the SINGLE holder of the member
 * circle relations read hook.
 *
 * Mounted by C9 (POO-100) OUTSIDE ClientHomeRouter, the provider calls
 * `useMemberCirclesResource` EXACTLY ONCE and every consumer — my-circles
 * list, circle detail, exit/return verification, support entry — reads the
 * same resource through `useMemberCircles()`. Pages must not create their
 * own instances: diverging instances would break the one-invalidate-
 * refreshes-both contract with the shared H1 catalog.
 *
 * Catalog coupling: the provider holds the injected H1 `useMemberCatalog`
 * instance (pass it via the `catalog` prop from the same MemberCatalogProvider
 * the pages use). `invalidateAndRefresh` refreshes the relations AND that
 * instance, so exit/return flows cannot leave a stale catalog beside fresh
 * relations. Without an injected instance the relations still refresh, and
 * the outcome reports `catalog: 'unavailable'` instead of pretending.
 *
 * Epoch cleanup: the held instance resets its relations, capability caches
 * and support state whenever the ProductSpace context epoch (contextVersion)
 * or the account/personal-space binding changes — an invalidated context
 * immediately loses its display authority and a pending response can never
 * resurrect the previous account's rows, exactly like the H1 catalog.
 */
const MemberCircleResourceContext = createContext<MemberCirclesResource | null>(null)

/**
 * Inner component so the own-instance branch mounts `useMemberCirclesResource`
 * only when nothing is injected (conditional hook calls are not allowed, and
 * creating a hidden second instance beside an injected one would double the
 * trusted relation reads).
 */
function OwnMemberCircleResourceProvider({
  catalog,
  children,
}: MemberCirclesResourceOptions & { children: React.ReactNode }) {
  const resource = useMemberCirclesResource({ catalog })
  return (
    <MemberCircleResourceContext.Provider value={resource}>
      {children}
    </MemberCircleResourceContext.Provider>
  )
}

export function MemberCircleResourceProvider({
  resource,
  catalog,
  children,
}: {
  /** Pre-built instance to reuse instead of creating the provider's own. */
  resource?: MemberCirclesResource
  /** THE shared H1 member catalog instance for invalidateAndRefresh. */
  catalog?: AppCatalogInstance | null
  children: React.ReactNode
}) {
  if (resource) {
    return (
      <MemberCircleResourceContext.Provider value={resource}>
        {children}
      </MemberCircleResourceContext.Provider>
    )
  }
  return (
    <OwnMemberCircleResourceProvider catalog={catalog}>
      {children}
    </OwnMemberCircleResourceProvider>
  )
}

/**
 * Returns THE shared member circle resource (same state / circles /
 * memberships / commands for every consumer). Throws outside a provider —
 * mounting the provider is C9's responsibility and consumers must fail
 * loudly rather than silently creating diverging read surfaces.
 */
export function useMemberCircles(): MemberCirclesResource {
  const resource = useContext(MemberCircleResourceContext)
  if (!resource) {
    throw new Error(
      'useMemberCircles must be used within MemberCircleResourceProvider',
    )
  }
  return resource
}
