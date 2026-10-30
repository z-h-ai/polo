import { afterEach, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
if (typeof window === 'undefined') GlobalRegistrator.register()
const { render, act, cleanup } = await import('@testing-library/react')
const React = await import('react')
const { CanvasPaneCard } = await import('../CanvasPane')
afterEach(cleanup)
it('a missing generated index exposes Retry and remounts only the failed trusted guest', async () => {
  const view = render(React.createElement(CanvasPaneCard, { nativeGuest: true, sessionId: '20261029-test-session', app: { appId: 'retry-app', title: 'Retry app', indexPath: '/owned/index.html' } }))
  const first = view.container.querySelector('webview')!
  expect(first).toBeTruthy()
  await act(async () => { first.dispatchEvent(new CustomEvent('did-fail-load', { detail: { isMainFrame: true, errorCode: -6 } })) })
  const alert = view.getByRole('alert')
  expect(alert.textContent).toBeTruthy()
  await act(async () => { alert.querySelector('button')!.click() })
  const next = view.container.querySelector('webview')!
  expect(next).toBeTruthy()
  expect(next).not.toBe(first)
  expect(next.getAttribute('partition')).toBe(first.getAttribute('partition'))
  expect(next.getAttribute('src')).not.toBe(first.getAttribute('src'))
  expect(view.queryByRole('alert')).toBeNull()
})
