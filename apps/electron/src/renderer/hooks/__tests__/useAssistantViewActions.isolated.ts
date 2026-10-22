import { describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
const calls: string[] = []
const actions = new Map<string, () => void>()
const native = new Map<string, () => void>()
mock.module('@/actions', () => ({ useAction: (id: string, handler: () => void) => actions.set(id, handler) }))
mock.module('@/context/TabShellContext', () => ({ useTabShell: () => ({ openApp: (app: { id: string }) => calls.push(`open:${app.id}`) }) }))
window.electronAPI = {
  onMenuToggleSidebar: (fn: () => void) => { native.set('sidebar', fn); return () => native.delete('sidebar') },
  onMenuToggleFocusMode: (fn: () => void) => { native.set('focus', fn); return () => native.delete('focus') },
} as unknown as typeof window.electronAPI
const { renderHook, act } = await import('@testing-library/react')
const { useAssistantViewActions } = await import('../useAssistantViewActions')
const { POLO_APP_DEFINITION } = await import('../../../shared/tab-browser-types')

describe('assistant view actions from a non-assistant tab', () => {
  it('surfaces the assistant before toggling for registry/menu, keyboard and native entries', () => {
    const hook = renderHook(() => useAssistantViewActions(() => calls.push('sidebar'), () => calls.push('focus')))
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
