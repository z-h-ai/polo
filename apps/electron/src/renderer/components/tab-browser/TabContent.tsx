import type { ReactNode } from 'react'
import { ClientHomeRouter } from '@/components/circles/ClientHomeRouter'
import { useOptionalMemberCatalog } from '@/context/MemberCatalogContext'
import { MemberCircleResourceProvider } from '@/context/MemberCircleResourceContext'
import { MembershipTransitionBanner } from '@/components/product-space/MembershipTransitionBanner'
import type { CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import { WebAppView } from './WebAppView'
import { KnowledgeBaseApp } from './KnowledgeBaseApp'
import { useTabShell } from '@/context/TabShellContext'
import type { TabInstance } from '../../../shared/tab-browser-types'

interface TabContentProps {
  renderPolo: () => ReactNode
  /**
   * The App-threaded A1 re-login entry for the C8 account-mismatch recovery
   * (POO-100 C8 wiring). OPTIONAL: App forwards enterAdminLogin via TabShell;
   * unset only in isolated mounts. Unset, the mismatch recovery keeps the
   * minimal target and the user recovers through the existing account menu.
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
 * The home-branch surface (POO-70 C9 / POO-100). POO-142 moved the SINGLE
 * member-circle resource provider OUT of this surface to the TabContent root:
 * the workbench membership banner reads the same shared relations resource,
 * and the silent circle pull now runs with the shell (not only while the home
 * tab is active). The router still reads THE one shared instance through
 * `useMemberCircles()` — a row click's invalidation refreshes list and detail
 * through one context, exactly as before.
 *
 * Lifecycle: the provider mounts/dies with the keyed TabShell scope (account
 * + ProductSpace context key), so no relations fact of a previous scope can
 * survive into the next one; the N1 route stack still lives in the App-level
 * ClientPageProvider, so the route and its depth survive the tab switch.
 */
function ClientHomeSurface({
  onReauthenticateRequest,
}: {
  onReauthenticateRequest?: (target: CircleReturnTargetIds | null) => void
}) {
  return (
    <ClientHomeRouter onReauthenticateRequest={onReauthenticateRequest} />
  )
}

export function TabContent({ renderPolo, onReauthenticateRequest }: TabContentProps) {
  const { activeTab, openTabs, backgroundTabs = [] } = useTabShell()
  // Optional read: isolated shells (tests, minimal mounts) have no App-level
  // catalog — relations still load, only invalidateAndRefresh's catalog
  // coupling reports 'unavailable'.
  const catalog = useOptionalMemberCatalog()
  const activeType = activeTab.type

  return (
    <MemberCircleResourceProvider catalog={catalog}>
      {/* POO-142: flex column so the membership banner can take exactly one row
      above the tab surfaces when (and only when) it has something to say.
      The banner renders null otherwise, and the surfaces below keep their
      h-full sizing inside the flex-1 min-h-0 region. */}
      <div
        className="flex h-full min-h-0 flex-col text-foreground"
        style={{ paddingTop: 'var(--content-top-offset)' }}
      >
        <MembershipTransitionBanner />
        <div className="relative min-h-0 flex-1">
          <div className={activeType === 'polo' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            {renderPolo()}
          </div>

          {activeType === 'home' && <ClientHomeSurface onReauthenticateRequest={onReauthenticateRequest} />}

          {/* POO-108: the enterprise knowledge base app tab. Mounted only while
          active — the surface re-reads its scope on mount, and the tab strip is
          the only persistent state it needs. */}
          {activeType === 'knowledge-base' && <KnowledgeBaseApp />}

          {[...openTabs, ...backgroundTabs]
            .filter((tab) => tab.type === 'webapp')
            .map((tab) => (
              <WebTabLayer key={tab.id} tab={tab} active={activeTab.id === tab.id} />
            ))}
        </div>
      </div>
    </MemberCircleResourceProvider>
  )
}
