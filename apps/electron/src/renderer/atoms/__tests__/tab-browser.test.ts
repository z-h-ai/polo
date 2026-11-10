import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeTabIdAtom,
  closeTabAtom,
  committedSpaceKindAtom,
  openAppTabAtom,
  openProjectTabAtom,
  openTabsAtom,
  visibleTabsAtom,
} from '../tab-browser'
import {
  HOME_TAB_ID,
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

const project = {
  projectId: 'proj-1',
  name: 'Alpha project',
  organizationEnterpriseId: 'ent-1',
  organizationProductSpaceId: 'space-1',
  myRole: 'owner' as const,
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

// POO-205: the enterprise knowledge base built-in app/tab retired (Spec Q5/Q6
// — chat is a base capability, knowledge flows through the project shared-file
// area). The retired tab-type surface and its single-instance ordering tests
// went with it; legacy persisted kb tabs are dropped on restore instead.

// POO-205 C4 (R4/R5/R6): the committed-space gate. The Polo tab retires from
// the VISIBLE strip in an enterprise space (chat lives only inside project
// tabs) while staying in openTabsAtom for persistence/mounting; project-tab
// close returns Home; new project tabs append so ⌘-digit mapping is stable.
describe('tab browser committed space (POO-205 C4)', () => {
  const enterprise = (store: ReturnType<typeof createStore>) =>
    store.set(committedSpaceKindAtom, 'enterprise')

  it('visibleTabsAtom keeps the personal layout untouched (null and personal both keep Polo)', () => {
    const store = createStore()
    expect(store.get(visibleTabsAtom).some(tab => tab.id === POLO_TAB_ID)).toBe(true)

    store.set(committedSpaceKindAtom, 'personal')
    expect(store.get(visibleTabsAtom).some(tab => tab.id === POLO_TAB_ID)).toBe(true)
  })

  it('visibleTabsAtom drops the retired Polo tab only in an enterprise space; openTabsAtom keeps it', () => {
    const store = createStore()
    enterprise(store)

    expect(store.get(visibleTabsAtom).some(tab => tab.id === POLO_TAB_ID)).toBe(false)
    // The Polo tab itself is still persisted/mounted — only its visibility went.
    expect(store.get(openTabsAtom).some(tab => tab.id === POLO_TAB_ID)).toBe(true)
  })

  it('closing the ACTIVE project tab returns Home (R5) — never a neighbor conversation', () => {
    const store = createStore()
    store.set(openProjectTabAtom, project)
    const projectTabId = store.get(openTabsAtom).find(tab => tab.type === 'project')!.id
    enterprise(store)
    store.set(openAppTabAtom, app)
    const appTab = store.get(openTabsAtom).find(tab => tab.appId === app.id)!

    store.set(activeTabIdAtom, projectTabId)
    // Move the project tab BEFORE the webapp so the old neighbor rule would
    // have replaced it with the webapp — R5 must still answer Home.
    store.set(openTabsAtom, [
      ...store.get(openTabsAtom).filter(tab => tab.id !== projectTabId).slice(0, 1),
      store.get(openTabsAtom).find(tab => tab.id === projectTabId)!,
      ...store.get(openTabsAtom).filter(tab => tab.id !== projectTabId).slice(1),
    ])

    store.set(closeTabAtom, projectTabId)
    expect(store.get(activeTabIdAtom)).toBe(HOME_TAB_ID)
    expect(store.get(openTabsAtom).some(tab => tab.id === projectTabId)).toBe(false)
    expect(store.get(openTabsAtom).some(tab => tab.id === appTab.id)).toBe(true)
  })

  it('closing a NON-active project tab leaves the active tab alone (R5)', () => {
    const store = createStore()
    store.set(openProjectTabAtom, project)
    const projectTabId = store.get(openTabsAtom).find(tab => tab.type === 'project')!.id
    store.set(openAppTabAtom, app)
    const appTab = store.get(openTabsAtom).find(tab => tab.appId === app.id)!

    store.set(closeTabAtom, projectTabId)
    expect(store.get(activeTabIdAtom)).toBe(appTab.id)
    expect(store.get(openTabsAtom).some(tab => tab.id === projectTabId)).toBe(false)
  })

  it('enterprise webapp close falls back PAST the Polo ghost to the next visible tab', () => {
    const store = createStore()
    store.set(openAppTabAtom, app)
    const appTab = store.get(openTabsAtom).find(tab => tab.appId === app.id)!
    store.set(openProjectTabAtom, { ...project, projectId: 'proj-2', name: 'Beta project' })
    const projectTabId = store.get(openTabsAtom).find(tab => tab.project?.projectId === 'proj-2')!.id
    enterprise(store)
    store.set(activeTabIdAtom, appTab.id)

    // Personal-space close semantics (fallback = Polo) are pinned by the
    // POO-104 describe above; here the visible fallback must skip Polo.
    store.set(closeTabAtom, appTab.id)
    expect(store.get(activeTabIdAtom)).toBe(projectTabId)
    expect(store.get(activeTabIdAtom)).not.toBe(POLO_TAB_ID)
  })

  it('enterprise close of the LAST visible tab lands Home — never the invisible Polo', () => {
    const store = createStore()
    store.set(openAppTabAtom, app)
    const appTab = store.get(openTabsAtom).find(tab => tab.appId === app.id)!
    enterprise(store)

    store.set(closeTabAtom, appTab.id)
    expect(store.get(activeTabIdAtom)).toBe(HOME_TAB_ID)
  })

  it('openProjectTabAtom APPENDS a new tab at the end (R6) — ⌘-digit order stays stable', () => {
    const store = createStore()
    enterprise(store)
    store.set(openAppTabAtom, app)

    store.set(openProjectTabAtom, project)
    const visible = store.get(visibleTabsAtom)
    expect(visible[visible.length - 1]?.type).toBe('project')
    expect(visible[visible.length - 1]?.project?.projectId).toBe('proj-1')
    // Polo stays first in the persistence array — only visibility is derived.
    expect(store.get(openTabsAtom)[0]?.id).toBe(POLO_TAB_ID)
  })

  it('openProjectTabAtom is idempotent per project: re-open only refreshes + activates', () => {
    const store = createStore()
    store.set(openProjectTabAtom, project)
    const first = store.get(openTabsAtom).filter(tab => tab.type === 'project')
    expect(first).toHaveLength(1)

    store.set(activeTabIdAtom, HOME_TAB_ID)
    store.set(openProjectTabAtom, { ...project, name: 'Alpha project (renamed)' })

    const tabs = store.get(openTabsAtom).filter(tab => tab.type === 'project')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.title).toBe('Alpha project (renamed)')
    expect(store.get(activeTabIdAtom)).toBe(tabs[0]!.id)
  })
})
