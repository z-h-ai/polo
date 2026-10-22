import { describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
let space: { accountId: string; activeProductSpaceId: string; pendingSwitch: object | null } = { accountId: 'account-a', activeProductSpaceId: 'enterprise-a', pendingSwitch: null }
mock.module('@/context/ProductSpaceContext', () => ({ useOptionalProductSpaceContext: () => space }))
mock.module('@/lib/logger', () => ({ rendererLog: { warn() {} } }))
const report = mock(async (_context: unknown) => true)
window.electronAPI = { reportWorkbenchReady: report } as unknown as typeof window.electronAPI
const { renderHook, act } = await import('@testing-library/react')
const { useWorkbenchReady } = await import('../useWorkbenchReady')

describe('workbench readiness acknowledgement', () => {
  it('waits for hydration and main-document load, then clears readiness across switches and unmount', () => {
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' })
    const hook = renderHook(({ ready }) => useWorkbenchReady(ready), { initialProps: { ready: false } })
    expect(report).toHaveBeenLastCalledWith(null)
    report.mockClear()
    hook.rerender({ ready: true })
    // Cleanup of the pre-hydration effect clears its old context, never marks ready.
    expect(report.mock.calls.every(([value]) => value === null)).toBe(true)
    act(() => { Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' }); window.dispatchEvent(new Event('load')) })
    expect(report).toHaveBeenLastCalledWith({ accountId: 'account-a', productSpaceId: 'enterprise-a' })
    space = { ...space, pendingSwitch: {} }
    hook.rerender({ ready: true })
    expect(report).toHaveBeenLastCalledWith(null)
    hook.unmount()
    report.mockClear()
    act(() => window.dispatchEvent(new Event('load')))
    expect(report).not.toHaveBeenCalled()
  })
})
