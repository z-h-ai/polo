import type { ReactNode } from 'react'
import { HomePage } from './HomePage'
import { WebAppView } from './WebAppView'
import { useTabShell } from '@/context/TabShellContext'
import type { TabInstance } from '../../../shared/tab-browser-types'

interface TabContentProps {
  onAddApp: () => void
  renderPolo: () => ReactNode
}

function WebTabLayer({ tab, active }: { tab: TabInstance; active: boolean }) {
  return (
    <div className={active ? 'block h-full min-h-0' : 'hidden'}>
      <WebAppView tab={tab} />
    </div>
  )
}

export function TabContent({ onAddApp, renderPolo }: TabContentProps) {
  const { activeTab, openTabs } = useTabShell()
  const activeType = activeTab.type

  return (
    <div className="h-full min-h-0 text-foreground" style={{ paddingTop: 'var(--content-top-offset)' }}>
      <div className={activeType === 'polo' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
        {renderPolo()}
      </div>

      {activeType === 'home' && <HomePage onAddApp={onAddApp} />}

      {openTabs
        .filter((tab) => tab.type === 'webapp')
        .map((tab) => (
          <WebTabLayer key={tab.id} tab={tab} active={activeTab.id === tab.id} />
        ))}
    </div>
  )
}
