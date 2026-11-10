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
    // Since b5712dc4 the registration hook listens on BOTH did-attach and
    // dom-ready, mirroring real Electron timing: did-attach can fire before
    // getWebContentsId is ready (real Electron THROWS there) and dom-ready
    // retries. The fake reproduces exactly that: not ready at did-attach.
    let electronReady = false
    guest.getWebContentsId = () => {
      calls++
      if (!electronReady) throw new Error('webContentsId not available before dom-ready')
      return 42
    }
    guest.dispatchEvent(new Event('did-attach'))
    expect(calls).toBe(1) // attempted, threw, swallowed — no crash, no registration
    guest.dispatchEvent(new Event('dom-ready'))
    expect(calls).toBe(2) // still not ready — retried and swallowed again
    electronReady = true
    guest.dispatchEvent(new Event('dom-ready'))
    expect(calls).toBe(3) // now it registers exactly once
    guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: false }))
    expect(failures).toBe(0)
    guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true }))
    expect(failures).toBe(1)
    // will-navigate reads event.url (Electron exposes properties directly, not in detail):
    // poloai:// deep links pass through to Main's authoritative gate, everything else is blocked.
    const poloaiDeepLink = Object.assign(new Event('will-navigate', { cancelable: true }), { url: 'poloai://ui-event?payload=x' })
    guest.dispatchEvent(poloaiDeepLink)
    expect(poloaiDeepLink.defaultPrevented).toBe(false)
    const externalNavigation = Object.assign(new Event('will-navigate', { cancelable: true }), { url: 'https://evil.example/next' })
    guest.dispatchEvent(externalNavigation)
    expect(externalNavigation.defaultPrevented).toBe(true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
