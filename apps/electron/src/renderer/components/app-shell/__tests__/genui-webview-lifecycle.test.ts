import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useGenUiGuestWebview } from '@polo-ai/ui/chat/GenUiAppCard'

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

test('guest registers only when Electron APIs are ready and ignores subframe failures', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const registration = { sessionId: '261027-quick-moor', cardId: 'app-test' }
  let failures = 0
  let calls = 0
  function Host() {
    const webviewRef = useRef<HTMLElement>(null)
    useGenUiGuestWebview({ webviewRef, src: 'file:///tmp/index.html', partition: 'genui-app-test', registration, onLoadFailed: () => failures++ })
    return createElement('webview', { ref: webviewRef })
  }
  try {
    await act(async () => root.render(createElement(Host)))
    const guest = container.querySelector('webview')! as HTMLElement & { getWebContentsId: () => number }
    guest.getWebContentsId = () => { calls++; return 42 }
    guest.dispatchEvent(new Event('did-attach'))
    expect(calls).toBe(0) // Electron throws here before dom-ready.
    guest.dispatchEvent(new Event('dom-ready'))
    expect(calls).toBe(1)
    guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: false }))
    expect(failures).toBe(0)
    guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true }))
    expect(failures).toBe(1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
