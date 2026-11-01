import { afterEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
if (typeof window === 'undefined') GlobalRegistrator.register()
const { render, act, cleanup } = await import('@testing-library/react')
const React = await import('react')
const { CanvasPaneCard } = await import('../CanvasPane')
afterEach(cleanup)
it('coalesces resize while loading and waits for explicit retry after failure', async () => {
  let resize!: () => void
  ;(globalThis as any).ResizeObserver = class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} }
  const original = HTMLElement.prototype.getBoundingClientRect
  let width = 400
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 20, width, height: 600, top: 20, left: 0, right: width, bottom: 620, toJSON() {} })
  let rejectFirst!: (error: Error) => void
  const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
  const embed = mock(() => embed.mock.calls.length === 1 ? first : Promise.resolve())
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { canvasPane: { embed, unembed: async () => {} } } })
  const view = render(React.createElement(CanvasPaneCard, { sessionId: 'retry-test', app: { appId: 'guide', title: 'Guide', indexPath: '/owned/index.html' } }))
  try {
    expect(embed).toHaveBeenCalledTimes(1)
    act(() => { width = 410; resize(); width = 420; resize() })
    expect(embed).toHaveBeenCalledTimes(1)
    await act(async () => { rejectFirst(new Error('carrier unavailable')) })
    act(() => { width = 430; resize() })
    expect(embed).toHaveBeenCalledTimes(1)
    expect(view.getByRole('alert')).toBeTruthy()
    await act(async () => { view.getByRole('alert').querySelector('button')!.click() })
    expect(embed).toHaveBeenCalledTimes(2)
    expect(view.queryByRole('alert')).toBeNull()
  } finally { view.unmount(); HTMLElement.prototype.getBoundingClientRect = original }
})
