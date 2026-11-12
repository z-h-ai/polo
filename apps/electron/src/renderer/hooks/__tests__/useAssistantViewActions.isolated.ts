import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { getDefaultStore } from 'jotai'
GlobalRegistrator.register()
const calls: string[] = []
const actions = new Map<string, () => void>()
const native = new Map<string, () => void>()
mock.module('@/actions', () => ({ useAction: (id: string, handler: () => void) => actions.set(id, handler) }))
// POO-209: the mock carries the ACTIVE TAB — the hook now decides the
// surface hand-off from it (polo/project = already on the assistant surface).
let activeTab: { type: string } = { type: 'polo' }
mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    openApp: (app: { id: string }) => calls.push(`open:${app.id}`),
    activeTab: { id: 't', appId: 't', type: activeTab.type, title: 'T' },
  }),
}))
window.electronAPI = {
  onMenuToggleSidebar: (fn: () => void) => { native.set('sidebar', fn); return () => native.delete('sidebar') },
  onMenuToggleFocusMode: (fn: () => void) => { native.set('focus', fn); return () => native.delete('focus') },
} as unknown as typeof window.electronAPI
const { renderHook, act } = await import('@testing-library/react')
const { useAssistantViewActions } = await import('../useAssistantViewActions')
const { POLO_APP_DEFINITION } = await import('../../../shared/tab-browser-types')
const { committedSpaceKindAtom } = await import('@/atoms/tab-browser')

function setSpaceKind(kind: 'personal' | 'enterprise' | null) {
  getDefaultStore().set(committedSpaceKindAtom, kind)
}

async function mountActions() {
  const hook = renderHook(() => useAssistantViewActions(() => calls.push('sidebar'), () => calls.push('focus')))
  return hook
}

beforeEach(() => {
  activeTab = { type: 'polo' }
  setSpaceKind('personal')
  calls.length = 0
})

describe('assistant view actions from a non-assistant tab', () => {
  it('surfaces the assistant before toggling for registry/menu, keyboard and native entries', async () => {
    // POO-209 regression guard for the LEGACY contract: from a surface with no
    // assistant chrome (Home, personal space) the hand-off stays.
    activeTab = { type: 'home' }
    const hook = await mountActions()
    for (const [handler, expected] of [
      [actions.get('view.toggleSidebar'), 'sidebar'],
      [actions.get('view.toggleFocusMode'), 'focus'],
      [native.get('sidebar'), 'sidebar'],
      [native.get('focus'), 'focus'],
    ] as const) {
      calls.length = 0
      act(() => handler!())
      expect(calls).toEqual([`open:${POLO_APP_DEFINITION.id}`, expected])
    }
    hook.unmount()
    expect(native.size).toBe(0)
  })
})

describe('POO-209: no tab re-route from inside the assistant surface', () => {
  it.each(['polo', 'project'] as const)('toggles in place from a %s tab (registry + native entries)', async (tabType) => {
    activeTab = { type: tabType }
    const hook = await mountActions()
    for (const handler of [actions.get('view.toggleFocusMode'), native.get('focus')]) {
      calls.length = 0
      act(() => handler!())
      expect(calls).toEqual(['focus'])
    }
    hook.unmount()
  })

  it('toggles in place from an enterprise non-assistant tab — no Polo ghost activation', async () => {
    // The POO-205 C4 guard would snap the stray Polo activation to Home, so
    // the hand-off is skipped entirely: toggle without any navigation.
    activeTab = { type: 'home' }
    setSpaceKind('enterprise')
    const hook = await mountActions()
    for (const handler of [actions.get('view.toggleFocusMode'), native.get('focus'), actions.get('view.toggleSidebar'), native.get('sidebar')]) {
      calls.length = 0
      act(() => handler!())
      expect(calls.every(call => !call.startsWith('open:'))).toBe(true)
    }
    hook.unmount()
  })

  it('still surfaces the assistant from a webapp tab in a personal space', async () => {
    activeTab = { type: 'webapp' }
    const hook = await mountActions()
    act(() => actions.get('view.toggleFocusMode')!())
    expect(calls).toEqual([`open:${POLO_APP_DEFINITION.id}`, 'focus'])
    hook.unmount()
  })
})
