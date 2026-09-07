import type { ReactNode } from 'react'
import { HomePage } from './HomePage'
import { WebAppView } from './WebAppView'
import { useTabShell } from '@/context/TabShellContext'
import type { TabInstance } from '../../../shared/tab-browser-types'

interface TabContentProps {
  renderPolo: () => ReactNode
  /**
   * Narrow-route boundary (Review R31/R32): when the window is at/below the
   * frozen mobile width, the POO-43 Home surface is the ONLY mounted tab
   * content — the POO-47-owned workbench (`renderPolo`), every WebAppView
   * webview layer, and retained preview overlays stay unmounted. Wide
   * windows keep the full tab/workbench behavior unchanged.
   */
  narrowHome?: boolean
}

function WebTabLayer({ tab, active }: { tab: TabInstance; active: boolean }) {
  return (
    <div className={active ? 'block h-full min-h-0' : 'hidden'}>
      <WebAppView tab={tab} />
    </div>
  )
}

export function TabContent({ renderPolo, narrowHome = false }: TabContentProps) {
  const { activeTab, openTabs } = useTabShell()
  const activeType = activeTab.type

  return (
    <div className="h-full min-h-0 text-foreground" style={{ paddingTop: 'var(--content-top-offset)' }}>
      {!narrowHome && (
        <div className={activeType === 'polo' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
          {renderPolo()}
        </div>
      )}

      {(narrowHome || activeType === 'home') && <HomePage />}

      {!narrowHome
        && openTabs
          .filter((tab) => tab.type === 'webapp')
          .map((tab) => (
            <WebTabLayer key={tab.id} tab={tab} active={activeTab.id === tab.id} />
          ))}
    </div>
  )
}
