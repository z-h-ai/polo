import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeTabIdAtom,
  openAppTabAtom,
  openTabsAtom,
} from '../tab-browser'
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
