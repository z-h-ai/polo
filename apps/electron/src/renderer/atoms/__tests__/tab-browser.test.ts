import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeTabIdAtom,
  closeTabAtom,
  openAppTabAtom,
  openTabsAtom,
} from '../tab-browser'
import {
  HOME_TAB_ID,
  KNOWLEDGE_BASE_APP_DEFINITION,
  KNOWLEDGE_BASE_TAB_ID,
  POLO_TAB_ID,
} from '../../../shared/tab-browser-types'
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

// POO-108: the enterprise knowledge base is a built-in surface with ONE
// shared tab instance, opened from the Home card and restored from storage —
// never duplicated per entry point, never re-created on restore.
describe('tab browser knowledge base tab (POO-108)', () => {
  it('opens a single knowledge-base tab right after the assistant tab', () => {
    const store = createStore()
    store.set(openAppTabAtom, app) // a webapp tab first, so ordering is observable

    store.set(openAppTabAtom, KNOWLEDGE_BASE_APP_DEFINITION)

    const tabs = store.get(openTabsAtom)
    const kbIndex = tabs.findIndex(tab => tab.id === KNOWLEDGE_BASE_TAB_ID)
    const poloIndex = tabs.findIndex(tab => tab.id === POLO_TAB_ID)
    expect(kbIndex).toBeGreaterThan(-1)
    expect(tabs[kbIndex].type).toBe('knowledge-base')
    expect(kbIndex).toBe(poloIndex + 1)
    expect(store.get(activeTabIdAtom)).toBe(KNOWLEDGE_BASE_TAB_ID)
  })

  it('focuses the existing tab instead of spawning a duplicate', () => {
    const store = createStore()
    store.set(openAppTabAtom, KNOWLEDGE_BASE_APP_DEFINITION)
    store.set(activeTabIdAtom, POLO_TAB_ID)

    store.set(openAppTabAtom, KNOWLEDGE_BASE_APP_DEFINITION)

    expect(store.get(openTabsAtom).filter(tab => tab.id === KNOWLEDGE_BASE_TAB_ID)).toHaveLength(1)
    expect(store.get(activeTabIdAtom)).toBe(KNOWLEDGE_BASE_TAB_ID)
  })

  it('keeps the webapp duplicate-collapse rule untouched for non built-in apps', () => {
    const store = createStore()
    store.set(openAppTabAtom, KNOWLEDGE_BASE_APP_DEFINITION)

    store.set(openAppTabAtom, app)

    expect(store.get(activeTabIdAtom)).toBe(
      store.get(openTabsAtom).find(tab => tab.appId === app.id)!.id,
    )
    // the KB tab stays open in the background, unchanged
    expect(store.get(openTabsAtom).some(tab => tab.id === KNOWLEDGE_BASE_TAB_ID)).toBe(true)
  })
})
