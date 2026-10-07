import * as React from 'react'
import { createContext, useContext } from 'react'
import { useAppCatalog, type AppCatalogInstance } from '@/hooks/useAppCatalog'

export type { AppCatalogInstance } from '@/hooks/useAppCatalog'

/**
 * POO-70 H1 (P70-CATALOG-01/02/03): the SINGLE holder of `useAppCatalog` for
 * member pages.
 *
 * Mount location (docblock corrected by N1 review P2-1): since the H2
 * extraction the provider is mounted by HomePage, which injects its own
 * pre-created instance via the `catalog` prop — `useAppCatalog` runs EXACTLY
 * ONCE and every consumer reads the same catalog/refresh/launch surface
 * through `useMemberCatalog()`; pages must not create their own instances.
 * N1's ClientPageProvider now occupies the App-level slot OUTSIDE TabShell
 * (routing + hairline only); H3/POO-91 owns lifting THIS provider up next to
 * it (App.tsx, inside the ProductSpace boundary), retiring the page-internal
 * mount.
 *
 * H2 extraction transition: the provider accepts an already-created instance
 * (e.g. HomePage's current one) via the `catalog` prop, so extraction can
 * move consumers onto the shared context before the old page instance is
 * retired by H3/POO-91. When `catalog` is provided no second instance is
 * created.
 *
 * Epoch cleanup: the held instance already clears its catalog, statuses and
 * generations whenever the ProductSpace context epoch (productSpaceContextKey)
 * changes — an invalidated context immediately loses its display authority
 * and a pending refresh can never resurrect authorization for it. Consumers
 * fence stale closures with `instance.productSpace?.productSpaceContextKey`
 * / `contextVersion`, exactly as before.
 */
const MemberCatalogContext = createContext<AppCatalogInstance | null>(null)

/**
 * Inner component so the own-instance branch mounts `useAppCatalog` only
 * when nothing is injected (conditional hook calls are not allowed, and
 * creating a hidden second instance beside an injected one would issue
 * duplicate catalog syncs).
 */
function OwnMemberCatalogProvider({ children }: { children: React.ReactNode }) {
  const catalog = useAppCatalog()
  return (
    <MemberCatalogContext.Provider value={catalog}>
      {children}
    </MemberCatalogContext.Provider>
  )
}

export function MemberCatalogProvider({
  catalog,
  children,
}: {
  /** Pre-existing instance to reuse during the H2 extraction transition. */
  catalog?: AppCatalogInstance
  children: React.ReactNode
}) {
  if (catalog) {
    return (
      <MemberCatalogContext.Provider value={catalog}>
        {children}
      </MemberCatalogContext.Provider>
    )
  }
  return <OwnMemberCatalogProvider>{children}</OwnMemberCatalogProvider>
}

/**
 * Returns THE shared member catalog surface (same catalog / refresh /
 * launch methods for every consumer). Throws outside a provider — the
 * HomePage-internal mount (until H3/POO-91 lifts it to the App level) is the
 * single holder, and consumers must fail loudly rather than silently creating
 * diverging catalog instances.
 */
export function useMemberCatalog(): AppCatalogInstance {
  const catalog = useContext(MemberCatalogContext)
  if (!catalog) {
    throw new Error(
      'useMemberCatalog must be used within MemberCatalogProvider',
    )
  }
  return catalog
}
