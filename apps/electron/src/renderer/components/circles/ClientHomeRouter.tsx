import { useEffect, useRef } from 'react'
import type { CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import { useOptionalClientPage } from '@/context/ClientPageContext'
import { HomePage } from '@/components/tab-browser/HomePage'
import { CircleDetailPage } from './CircleDetailPage'
import { MyCirclesPage } from './MyCirclesPage'

/**
 * ClientHomeRouter (POO-70 C9 / POO-100) — the N1 route switch for the
 * TabContent home branch: `home` → HomePage (H3), `circles` → MyCirclesPage
 * (C3), `circle-detail` → CircleDetailPage (this card). The route stack lives
 * in the App-level ClientPageProvider (OUTSIDE TabShell), so switching the
 * Polo/web app tab and back never loses the page or its depth.
 *
 * Main-scroller registration (P70-NAV-03 / P70-CIRCLE-DETAIL-03): every
 * routed page owns a DEDICATED viewport-bounded scroller as its single root
 * element (HomePage / MyCirclesPage / CircleDetailPage roots are all
 * `h-full min-h-0 overflow-y-auto`). The pages are other cards' files, so
 * the router registers the ACTIVE page's root scroller by ref-walking its
 * own container: the routed page is the container's only element child, and
 * the re-registration effect runs AFTER that child committed (route changes
 * re-run it), so exactly the current page's scroller drives the header
 * hairline. Assistant-internal scrollers never pass through here.
 *
 * Fail-safe without the App provider tree (isolated probes such as
 * TabShell.scope-isolation mount the shell WITHOUT ClientPageProvider):
 * `useOptionalClientPage` returns null and the router renders the plain home
 * surface — the pre-C9 behavior — instead of throwing. Inside the real App
 * tree the provider is always present and the full route switch is live.
 *
 * Scope isolation is inherited, not implemented here: the provider re-seals
 * on any scope-key change and the App keys the remount, so a stale
 * circle-detail route can never survive into another account/space/epoch.
 */

export interface ClientHomeRouterProps {
  /**
   * The App-threaded A1 re-login entry for the C8 account-mismatch recovery
   * (forwarded verbatim to CircleDetailPage; optional — App forwards it via
   * TabShell (enterAdminLogin); unset only in isolated mounts (degraded note)).
   */
  onReauthenticateRequest?: (target: CircleReturnTargetIds | null) => void
}

export function ClientHomeRouter({ onReauthenticateRequest }: ClientHomeRouterProps = {}) {
  const clientPage = useOptionalClientPage()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const route = clientPage?.route ?? { kind: 'home' as const }

  // Re-registered per route identity: the LAST registration wins, so after
  // each committed route change exactly the new page's scroller is attached.
  const routeKey = route.kind === 'circle-detail'
    ? `${route.kind}:${route.circleId}:${route.section}`
    : route.kind
  useEffect(() => {
    if (!clientPage) return
    const container = containerRef.current
    const candidate = container?.firstElementChild
    clientPage.registerMainScroller(candidate instanceof HTMLElement ? candidate : null)
    return () => {
      clientPage.registerMainScroller(null)
    }
  }, [clientPage, routeKey])

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0"
      data-testid="client-home-router"
      data-route-kind={route.kind}
    >
      {route.kind === 'home' && <HomePage />}
      {route.kind === 'circles' && <MyCirclesPage />}
      {route.kind === 'circle-detail' && (
        // Keyed by circleId: a different circle remounts the page (identity
        // hygiene), a section switch keeps it mounted (the panels own their
        // per-identity reset contracts).
        <CircleDetailPage
          key={route.circleId}
          circleId={route.circleId}
          section={route.section}
          onReauthenticateRequest={onReauthenticateRequest}
        />
      )}
    </div>
  )
}
