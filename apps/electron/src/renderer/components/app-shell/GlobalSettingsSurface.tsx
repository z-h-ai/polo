/**
 * GlobalSettingsSurface (POO-125) — the shell-level surface for the Polo-scope
 * (client-shell) settings pages.
 *
 * The top-right account-menu Settings entry is a GLOBAL entry: it must not
 * activate the Polo assistant tab or touch the assistant's route, and it must
 * always be leftable. TabShell mounts this surface over the current tab's
 * content (the tab keeps its state underneath) and hands back on the explicit
 * 返回 action — the assistant view is exactly where the user left it.
 *
 * Layout mirrors the in-tab two-column settings surface (navigator + details)
 * and reuses the same production components: SettingsNavigator renders the
 * Polo scope (derived from the selected subpage via settings-registry), and
 * the details column renders the registry page component. Below the 768px
 * compact line the surface drills list → details in a single column, like the
 * assistant's compact settings.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { Panel } from '@/components/app-shell/Panel'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { RADIUS_INNER } from '@/components/app-shell/panel-constants'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import SettingsNavigator from '@/pages/settings/SettingsNavigator'
import { getSettingsPageComponent } from '@/pages/settings/settings-pages'
import { resolveRenderableSettingsSubpage } from '../../../shared/menu-schema'
import { getSettingsPage, type SettingsSubpage } from '../../../shared/settings-registry'

/** Same compact line the assistant shell uses (AppShell MOBILE_THRESHOLD). */
const COMPACT_QUERY = '(max-width: 767px)'

/** Navigator column width — the session-list default, shared for visual parity. */
const NAVIGATOR_WIDTH = 300

function useCompactSettingsViewport(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches)

  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY)
    const update = () => { setCompact(query.matches) }
    update()
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])

  return compact
}

interface GlobalSettingsSurfaceProps {
  /** Selected Polo-scope subpage (already defaulted by TabShell). */
  subpage: SettingsSubpage
  /** Navigator row click. Assistant-scope rows are handed off by TabShell. */
  onSelectSubpage: (subpage: SettingsSubpage) => void
  /** Explicit exit — hands the previous tab surface back unchanged. */
  onClose: () => void
}

export function GlobalSettingsSurface({ subpage, onSelectSubpage, onClose }: GlobalSettingsSurfaceProps) {
  const { t } = useTranslation()
  const isCompact = useCompactSettingsViewport()
  // Compact drills straight into the landing subpage; desktop shows both columns.
  const [drilled, setDrilled] = useState(isCompact)

  // POO-121 fail-closed: pages hidden from every navigator never render here
  // either — same single source as MainContentPanel.
  const page = resolveRenderableSettingsSubpage(subpage)
  const SettingsPageComponent = getSettingsPageComponent(page)

  const handleBack = () => {
    if (isCompact && drilled) {
      setDrilled(false)
      return
    }
    onClose()
  }

  const handleSelect = (next: SettingsSubpage) => {
    onSelectSubpage(next)
    if (isCompact) setDrilled(true)
  }

  const header = (
    <PanelHeader
      title={(isCompact && drilled) ? t(getSettingsPage(page).labelKey) : t('sidebar.settings')}
      leadingAction={
        <HeaderIconButton
          icon={<ArrowLeft className="h-4 w-4" />}
          tooltip={t('common.back')}
          data-testid="global-settings-back"
          onClick={handleBack}
        />
      }
    />
  )

  // Compact (<768px): single column — the list, or the drilled-in page.
  if (isCompact) {
    return (
      <div
        data-testid="global-settings-surface"
        className="absolute inset-x-0 bottom-0 flex min-h-0 flex-col bg-background"
        style={{ top: 'var(--topbar-height)' }}
      >
        {header}
        <div className="min-h-0 flex-1">
          {drilled ? (
            <SettingsPageComponent />
          ) : (
            <SettingsNavigator selectedSubpage={subpage} onSelectSubpage={handleSelect} />
          )}
        </div>
      </div>
    )
  }

  // Desktop: navigator column + details panel, same panel materials as the
  // in-tab surface (POO-105 list/reading surfaces, interior corner radius).
  return (
    <div
      data-testid="global-settings-surface"
      className="absolute inset-x-0 bottom-0 flex min-h-0 gap-[6px] px-[6px] pb-[6px]"
      style={{ top: 'var(--topbar-height)' }}
    >
      <div
        data-panel-role="navigator"
        className="relative flex h-full shrink-0 flex-col overflow-hidden bg-background shadow-middle client-material-list"
        style={{
          width: NAVIGATOR_WIDTH,
          borderTopLeftRadius: RADIUS_INNER,
          borderTopRightRadius: RADIUS_INNER,
          borderBottomLeftRadius: RADIUS_INNER,
          borderBottomRightRadius: RADIUS_INNER,
        }}
      >
        {header}
        <div className="min-h-0 flex-1">
          <SettingsNavigator selectedSubpage={subpage} onSelectSubpage={handleSelect} />
        </div>
      </div>
      <div
        data-panel-role="content"
        className="relative h-full min-w-0 flex-1 overflow-hidden bg-foreground-2 shadow-middle client-material-reading"
        style={{
          borderTopLeftRadius: RADIUS_INNER,
          borderTopRightRadius: RADIUS_INNER,
          borderBottomLeftRadius: RADIUS_INNER,
          borderBottomRightRadius: RADIUS_INNER,
        }}
      >
        <SettingsPageComponent />
      </div>
    </div>
  )
}
