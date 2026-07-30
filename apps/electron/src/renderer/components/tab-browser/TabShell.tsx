import { useEffect, useState, type ReactNode } from 'react'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { AddAppDialog } from './AddAppDialog'
import { useTabShell } from '@/context/TabShellContext'
import { HOME_TAB_ID } from '../../../shared/tab-browser-types'

interface TabShellProps {
  renderPolo: () => ReactNode
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

export function TabShell({ renderPolo }: TabShellProps) {
  const { activeTab, openTabs, activeTabId, activateHome, activateTab, closeTab } = useTabShell()
  const [addAppOpen, setAddAppOpen] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.activeTab = activeTab.type
    return () => {
      delete root.dataset.activeTab
    }
  }, [activeTab.type])

  useEffect(() => {
    return window.electronAPI.onDeepLinkNavigate((nav) => {
      if (nav.view || nav.action || nav.joinToken || nav.tabType === 'polo') {
        const poloTab = openTabs.find((tab) => tab.type === 'polo')
        if (poloTab) activateTab(poloTab.id)
      }
    })
  }, [activateTab, openTabs])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey || isEditableTarget(event.target)) return

      if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        activateHome()
        return
      }

      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        closeTab(activeTabId)
        return
      }

      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        const tab = openTabs[index]
        if (tab) {
          event.preventDefault()
          activateTab(tab.id)
        } else if (index === 0) {
          event.preventDefault()
          activateHome()
        }
        return
      }

      if (event.shiftKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        const sequence = [HOME_TAB_ID, ...openTabs.map((tab) => tab.id)]
        const currentIndex = Math.max(0, sequence.indexOf(activeTabId))
        const delta = event.key === ']' ? 1 : -1
        const nextIndex = (currentIndex + delta + sequence.length) % sequence.length
        const nextId = sequence[nextIndex]
        if (nextId === HOME_TAB_ID) activateHome()
        else activateTab(nextId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activateHome, activateTab, activeTabId, closeTab, openTabs])

  return (
    <div className="h-full min-h-0 bg-background">
      <TabBar />
      <TabContent onAddApp={() => setAddAppOpen(true)} renderPolo={renderPolo} />
      <AddAppDialog open={addAppOpen} onOpenChange={setAddAppOpen} />
    </div>
  )
}
