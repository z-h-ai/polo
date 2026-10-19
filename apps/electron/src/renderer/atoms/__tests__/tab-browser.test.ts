import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeTabIdAtom,
  closeTabAtom,
  openAppTabAtom,
  openTabsAtom,
} from '../tab-browser'
import { HOME_TAB_ID, POLO_TAB_ID } from '../../../shared/tab-browser-types'
import type { AppDefinition } from '../../../shared/tab-browser-types'

const app: AppDefinition = {
  id: 'organization:org-1:app-1',
  name: 'Knowledge base',
  url: 'http://127.0.0.1:3210',
  type: 'webapp',
  createdAt: 0,
  order: 1,
}

describe('tab browser app activation', () => {
  it('activates an existing app tab instead of spawning a duplicate process view', () => {
    const store = createStore()

    store.set(openAppTabAtom, app)
    const firstTab = store.get(openTabsAtom).find(tab => tab.appId === app.id)
    expect(firstTab).toBeDefined()

    store.set(activeTabIdAtom, 'home')
    store.set(openAppTabAtom, { ...app, url: 'http://127.0.0.1:9876' })

    expect(store.get(openTabsAtom).filter(tab => tab.appId === app.id)).toHaveLength(1)
    expect(store.get(activeTabIdAtom)).toBe(firstTab!.id)
    expect(store.get(openTabsAtom).find(tab => tab.appId === app.id)?.url)
      .toBe('http://127.0.0.1:9876')
  })
})

// POO-104: the assistant tab is a permanent entry. Closing it must be a no-op
// in every activation state — it must never yank focus to Home, never remove
// the tab, and never disturb the currently active app tab.
describe('tab browser assistant close protection (POO-104)', () => {
  it('keeps the assistant tab active when a close request targets it', () => {
    const store = createStore()
    store.set(openAppTabAtom, app)
    store.set(activeTabIdAtom, POLO_TAB_ID)

    store.set(closeTabAtom, POLO_TAB_ID)

    expect(store.get(activeTabIdAtom)).toBe(POLO_TAB_ID)
    expect(store.get(openTabsAtom).some(tab => tab.id === POLO_TAB_ID)).toBe(true)
  })

  it('never moves focus off another app when a close request targets the assistant', () => {
    const store = createStore()
    store.set(openAppTabAtom, app)
    const appTab = store.get(openTabsAtom).find(tab => tab.appId === app.id)!
    store.set(activeTabIdAtom, appTab.id)

    store.set(closeTabAtom, POLO_TAB_ID)

    expect(store.get(activeTabIdAtom)).toBe(appTab.id)
    expect(store.get(openTabsAtom).some(tab => tab.id === POLO_TAB_ID)).toBe(true)
  })

  it('keeps regular webapp close semantics intact', () => {
    const store = createStore()
    store.set(openAppTabAtom, app)
    const appTab = store.get(openTabsAtom).find(tab => tab.appId === app.id)!
    store.set(activeTabIdAtom, appTab.id)

    // Closing the active webapp tab keeps the existing replacement rule: the
    // tab at the closed slot's position (the assistant, pinned first here).
    store.set(closeTabAtom, appTab.id)
    expect(store.get(openTabsAtom).some(tab => tab.id === appTab.id)).toBe(false)
    expect(store.get(activeTabIdAtom)).toBe(POLO_TAB_ID)
    expect(store.get(openTabsAtom).some(tab => tab.id === POLO_TAB_ID)).toBe(true)
  })
})
