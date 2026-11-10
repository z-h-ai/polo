import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HOME_TAB_ID, POLO_TAB_ID, projectTabId, type TabInstance } from '../../../../shared/tab-browser-types'
import { setupI18n } from '@polo-ai/shared/i18n'

/**
 * POO-205 C9 (R12): project-tab RECONCILIATION.
 *
 * The pure resolver answers WHICH open project tabs a successful directory
 * read closes and how each close is announced. The reactor performs the
 * closes against the real tab atoms (a vanilla jotai store) — an ACTIVE
 * project tab lands Home through closeTabAtom's own rule; the project's
 * stored last-selected session is cleaned up with it. The coded
 * `prj_not_found` entry (C7a's CREATE/SEND refusal) rides the SAME closing
 * move; every other code touches nothing.
 *
 * No mock.module here — bun's module mocks leak across test FILES in one
 * process (a later file importing the shared i18n entry sees the mock and
 * loses `setupI18n`). The real i18n initializes synchronously and sonner's
 * toast object takes an inline capture spy instead.
 */

setupI18n()

// The reactor announces closes through sonner — capture at the toast object
// itself (no module mock).
const toastErrors: string[] = []
function captureToastErrors(): void {
  (toast as unknown as { error: (message: string) => void }).error = (message) => {
    toastErrors.push(message)
  }
}
import { toast } from 'sonner'

// The last-selected cleanup rides localStorage — an in-memory surface. When
// another test file in the same process already registered happy-dom's
// (readonly-slot) localStorage, keep using IT through the same helper — the
// assignment to globalThis would throw. A separate backing map keeps the
// assertions hermetic either way.
const localStorageMap = new Map<string, string>()
const inMemoryStorage = {
  getItem: (key: string) => localStorageMap.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageMap.set(key, value) },
  removeItem: (key: string) => { localStorageMap.delete(key) },
}
const storageSlot = globalThis as unknown as { localStorage?: typeof inMemoryStorage }
if (!storageSlot.localStorage) storageSlot.localStorage = inMemoryStorage
const ls = (): typeof inMemoryStorage => storageSlot.localStorage ?? inMemoryStorage
const usedKeys = new Set<string>()
const lsSet = (key: string, value: string): void => {
  usedKeys.add(key)
  ls().setItem(key, value)
}
const lsHas = (key: string): boolean => ls().getItem(key) !== null
const lsGetRaw = (key: string): string | null => ls().getItem(key)

const { createStore } = await import('jotai/vanilla')
const { openTabsAtom, activeTabIdAtom } = await import('@/atoms/tab-browser')
const {
  PROJECT_TAB_REMOVAL_TOAST_KEY,
  closeProjectTabForLostProject,
  handleCodedProjectLoss,
  reconcileOpenProjectTabs,
  reconcileProjectTabRemovals,
} = await import('../reconcile')

function projectTab(projectId: string, name = `项目 ${projectId}`): TabInstance {
  return {
    id: projectTabId(projectId),
    appId: projectTabId(projectId),
    type: 'project',
    title: name,
    project: {
      projectId,
      name,
      organizationEnterpriseId: 'ent-1',
      organizationProductSpaceId: 'space-1',
      myRole: 'member',
    },
  }
}

function webappTab(id: string): TabInstance {
  return { id, appId: `app-${id}`, type: 'webapp', title: id, url: 'https://example.com', isLoading: false }
}

const POLO_TAB_FIXTURE: TabInstance = {
  id: POLO_TAB_ID,
  appId: POLO_TAB_ID,
  type: 'polo',
  title: 'Polo AI',
}

beforeEach(() => {
  toastErrors.length = 0
  for (const key of usedKeys) ls().removeItem(key)
  usedKeys.clear()
  captureToastErrors()
})
afterEach(() => {
  delete (toast as unknown as { error?: unknown }).error
})

describe('reconcileProjectTabRemovals (pure)', () => {
  it('closes every open project tab the visible list no longer carries, with the tab-title toast', () => {
    const removals = reconcileProjectTabRemovals({
      visibleProjects: [{ id: 'kept' }],
      openTabs: [POLO_TAB_FIXTURE, projectTab('kept'), projectTab('lost-1', '被移除的项目'), webappTab('w1')],
    })
    expect(removals).toEqual([
      {
        projectId: 'lost-1',
        tabTitle: '被移除的项目',
        toast: { key: PROJECT_TAB_REMOVAL_TOAST_KEY, values: { name: '被移除的项目' } },
      },
    ])
    expect(PROJECT_TAB_REMOVAL_TOAST_KEY).toBe('home.projects.noLongerMember')
  })

  it('closes SEVERAL lost project tabs, one removal each', () => {
    const removals = reconcileProjectTabRemovals({
      visibleProjects: [],
      openTabs: [projectTab('a', 'A'), projectTab('b', 'B'), projectTab('c', 'C')],
    })
    expect(removals.map(removal => removal.projectId).sort()).toEqual(['a', 'b', 'c'])
    expect(removals.every(removal => removal.toast.key === PROJECT_TAB_REMOVAL_TOAST_KEY)).toBe(true)
    expect(removals.map(removal => removal.toast.values.name)).toEqual(['A', 'B', 'C'])
  })

  it('leaves the Polo tab, webapp tabs and still-listed project tabs untouched', () => {
    const removals = reconcileProjectTabRemovals({
      visibleProjects: [{ id: 'listed' }],
      openTabs: [POLO_TAB_FIXTURE, webappTab('w1'), webappTab('w2'), projectTab('listed')],
    })
    expect(removals).toEqual([])
  })

  it('dedupes a project id (projectTabId is deterministic, the invariant stays local)', () => {
    const duplicate = { ...projectTab('dup'), id: 'weird-but-different' }
    const removals = reconcileProjectTabRemovals({
      visibleProjects: [],
      openTabs: [projectTab('dup'), duplicate],
    })
    expect(removals).toHaveLength(1)
  })
})

describe('reconcileOpenProjectTabs (reactor)', () => {
  it('closes the lost tabs for real; the ACTIVE project tab lands Home', () => {
    const store = createStore()
    const lostActive = projectTab('lost-active', '已激活却失去的项目')
    const lostBackground = projectTab('lost-bg', '后台失去的项目')
    store.set(openTabsAtom, [POLO_TAB_FIXTURE, lostActive, lostBackground, webappTab('w1')])
    store.set(activeTabIdAtom, lostActive.id)

    const removals = reconcileOpenProjectTabs(store, {
      visibleProjects: [],
      workspaceId: 'ws-1',
    })

    expect(removals).toHaveLength(2)
    const tabs = store.get(openTabsAtom)
    expect(tabs.some(tab => tab.id === projectTabId('lost-active'))).toBe(false)
    expect(tabs.some(tab => tab.id === projectTabId('lost-bg'))).toBe(false)
    expect(tabs.some(tab => tab.id === 'w1')).toBe(true)
    expect(tabs.some(tab => tab.id === POLO_TAB_ID)).toBe(true)
    // The ACTIVE project tab's close returns Home (closeTabAtom's rule).
    expect(store.get(activeTabIdAtom)).toBe(HOME_TAB_ID)
  })

  it('cleans up the project-scoped last-selected key and toasts ONCE per project', () => {
    const store = createStore()
    store.set(openTabsAtom, [projectTab('gone', '离开的项目')])
    lsSet('craft-last-selected-session-id:ws-9:project:gone', JSON.stringify('sess-1'))
    lsSet('craft-last-selected-session-id:ws-9', JSON.stringify('personal-sess'))

    reconcileOpenProjectTabs(store, { visibleProjects: [], workspaceId: 'ws-9' })

    expect(lsHas('craft-last-selected-session-id:ws-9:project:gone')).toBe(false)
    // The workspace-level key is NOT the project's — untouched.
    expect(lsGetRaw('craft-last-selected-session-id:ws-9')).toBe(JSON.stringify('personal-sess'))
    // The REAL copy (en fallback) announces the loss with the tab title.
    expect(toastErrors).toHaveLength(1)
    expect(toastErrors[0]).toContain('离开的项目')
    expect(toastErrors[0]).toContain('no longer a member')
  })

  it('is idempotent — a second run over the same state finds nothing and stays silent', () => {
    const store = createStore()
    store.set(openTabsAtom, [projectTab('p1')])
    reconcileOpenProjectTabs(store, { visibleProjects: [], workspaceId: 'ws-1' })
    toastErrors.length = 0

    const second = reconcileOpenProjectTabs(store, { visibleProjects: [], workspaceId: 'ws-1' })
    expect(second).toEqual([])
    expect(toastErrors).toEqual([])
  })
})

describe('closeProjectTabForLostProject (the prj_not_found closing move)', () => {
  it('closes THAT project tab with the same copy when it is open', () => {
    const store = createStore()
    store.set(openTabsAtom, [POLO_TAB_FIXTURE, projectTab('proj-x', '失效项目')])
    store.set(activeTabIdAtom, HOME_TAB_ID)

    const handled = closeProjectTabForLostProject(store, { projectId: 'proj-x', workspaceId: 'ws-2' })
    expect(handled).toBe(true)
    expect(store.get(openTabsAtom).some(tab => tab.id === projectTabId('proj-x'))).toBe(false)
    expect(lsHas('craft-last-selected-session-id:ws-2:project:proj-x')).toBe(false)
    expect(toastErrors).toHaveLength(1)
    expect(toastErrors[0]).toContain('失效项目')
  })

  it('answers false and touches NOTHING when the tab is not open', () => {
    const store = createStore()
    store.set(openTabsAtom, [POLO_TAB_FIXTURE])
    const handled = closeProjectTabForLostProject(store, { projectId: 'never-open', workspaceId: 'ws-2' })
    expect(handled).toBe(false)
    expect(toastErrors).toEqual([])
  })

  it('answers false for a null/undefined projectId', () => {
    const store = createStore()
    expect(closeProjectTabForLostProject(store, { projectId: null })).toBe(false)
    expect(closeProjectTabForLostProject(store, { projectId: undefined })).toBe(false)
    expect(toastErrors).toEqual([])
  })
})

describe('handleCodedProjectLoss (the coded refusal gate)', () => {
  function codedError(code: string): { code: string; message: string } {
    return { code, message: `wire:${code}` }
  }

  it('a prj_not_found refusal triggers the closing move exactly once', () => {
    const store = createStore()
    store.set(openTabsAtom, [projectTab('proj-r', '被拒的项目')])
    const handled = handleCodedProjectLoss(store, {
      error: codedError('prj_not_found'),
      projectId: 'proj-r',
      workspaceId: 'ws-3',
    })
    expect(handled).toBe(true)
    expect(store.get(openTabsAtom).some(tab => tab.id === projectTabId('proj-r'))).toBe(false)
    expect(toastErrors).toHaveLength(1)
  })

  it('any OTHER code (forbidden, transport) touches nothing', () => {
    const store = createStore()
    store.set(openTabsAtom, [projectTab('proj-r')])
    expect(handleCodedProjectLoss(store, { error: codedError('prj_forbidden'), projectId: 'proj-r' })).toBe(false)
    expect(handleCodedProjectLoss(store, { error: codedError('pm_service_unavailable'), projectId: 'proj-r' })).toBe(false)
    expect(handleCodedProjectLoss(store, { error: new Error('plain'), projectId: 'proj-r' })).toBe(false)
    expect(store.get(openTabsAtom)).toHaveLength(1)
    expect(toastErrors).toEqual([])
  })
})
