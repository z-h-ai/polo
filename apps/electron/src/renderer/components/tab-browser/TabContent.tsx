import type { ReactNode } from 'react'
import { ClientHomeRouter } from '@/components/circles/ClientHomeRouter'
import { useMemberCatalog } from '@/context/MemberCatalogContext'
import { MemberCircleResourceProvider } from '@/context/MemberCircleResourceContext'
import type { CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import { WebAppView } from './WebAppView'
import { useTabShell } from '@/context/TabShellContext'
import type { TabInstance } from '../../../shared/tab-browser-types'

interface TabContentProps {
  renderPolo: () => ReactNode
  /**
   * The App-threaded A1 re-login entry for the C8 account-mismatch recovery
   * (POO-100 C8 wiring). OPTIONAL and unset today: TabShell does not forward
   * it yet — the declared minimal owner change is one optional prop on
   * TabShell plus one `enterAdminLogin`-shaped callback at the App call site
   * (see the CircleDetailPage docblock and the POO-100 delivery notes).
   * Unset, the mismatch recovery keeps the minimal target and the user
   * recovers through the existing account menu.
   */
  onReauthenticateRequest?: (target: CircleReturnTargetIds | null) => void
}

function WebTabLayer({ tab, active }: { tab: TabInstance; active: boolean }) {
  return (
    <div className={active ? 'block h-full min-h-0' : 'hidden'}>
      <WebAppView tab={tab} />
    </div>
  )
}

/**
 * The home-branch surface (POO-70 C9 / POO-100): the C2 member-circle
 * resource provider mounted OUTSIDE ClientHomeRouter on the App-level H1
 * catalog instance, so the my-circles list, circle detail, leave flow and
 * support entry all read ONE shared relations/catalog context (a row click's
 * invalidation refreshes both list and detail — never two instances).
 *
 * Lifecycle unchanged from the pre-C9 home branch: the surface mounts with
 * the home tab and unmounts on Polo/web app tabs; the N1 route stack lives
 * in the App-level ClientPageProvider (outside TabShell), so the route and
 * its depth survive the tab switch.
 */
function ClientHomeSurface({
  onReauthenticateRequest,
}: {
  onReauthenticateRequest?: (target: CircleReturnTargetIds | null) => void
}) {
  const catalog = useMemberCatalog()
  return (
    <MemberCircleResourceProvider catalog={catalog}>
      <ClientHomeRouter onReauthenticateRequest={onReauthenticateRequest} />
    </MemberCircleResourceProvider>
  )
}

export function TabContent({ renderPolo, onReauthenticateRequest }: TabContentProps) {
  const { activeTab, openTabs } = useTabShell()
  const activeType = activeTab.type

  return (
    <div className="h-full min-h-0 text-foreground" style={{ paddingTop: 'var(--content-top-offset)' }}>
      <div className={activeType === 'polo' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
        {renderPolo()}
      </div>

      {activeType === 'home' && <ClientHomeSurface onReauthenticateRequest={onReauthenticateRequest} />}

      {openTabs
        .filter((tab) => tab.type === 'webapp')
        .map((tab) => (
          <WebTabLayer key={tab.id} tab={tab} active={activeTab.id === tab.id} />
        ))}
    </div>
  )
}
