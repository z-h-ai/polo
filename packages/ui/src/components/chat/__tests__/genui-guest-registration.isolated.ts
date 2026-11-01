import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
if (typeof window === 'undefined') GlobalRegistrator.register()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useGenUiGuestWebview, GENUI_CARD_REGISTER_EVENT, GENUI_CARD_UNREGISTER_EVENT } = await import('../GenUiAppCard')
afterEach(cleanup)
function setup() {
  const element = document.createElement('div') as HTMLElement & { getWebContentsId(): number }
  let ready = false, guestId = 1
  element.getWebContentsId = () => { if (!ready) throw new Error('not dom-ready'); return guestId }
  const registrations: any[] = [], unregistrations: any[] = []
  const onRegister = (event: any) => registrations.push(event.detail)
  const onUnregister = (event: any) => unregistrations.push(event.detail)
  window.addEventListener(GENUI_CARD_REGISTER_EVENT, onRegister)
  window.addEventListener(GENUI_CARD_UNREGISTER_EVENT, onUnregister)
  const ref = { current: element }
  const identity = { sessionId: 'sess-a', cardId: 'app-1-card' }
  const hook = renderHook(({ src }) => useGenUiGuestWebview({ webviewRef: ref, src, partition: 'genui-app-sess-a', registration: identity, onLoadFailed() {} }), { initialProps: { src: 'file:///owned/index.html' } })
  return { element, hook, registrations, unregistrations, ready: (id = 1) => { ready = true; guestId = id }, emit: (name: string) => act(() => { element.dispatchEvent(new Event(name)) }), finish: () => { hook.unmount(); window.removeEventListener(GENUI_CARD_REGISTER_EVENT, onRegister); window.removeEventListener(GENUI_CARD_UNREGISTER_EVENT, onUnregister) } }
}
describe('shared inline and sidebar guest registration', () => {
  it('retries an early did-attach on dom-ready and keeps exact session/card/guest identity', () => {
    const s = setup()
    s.emit('did-attach')
    expect(s.registrations).toEqual([])
    s.ready(77); s.emit('dom-ready')
    expect(s.registrations).toEqual([{ sessionId: 'sess-a', cardId: 'app-1-card', guestWebContentsId: 77 }])
    s.emit('dom-ready'); s.emit('did-attach')
    expect(s.registrations.length).toBe(1)
    s.finish()
    expect(s.unregistrations).toEqual(s.registrations)
  })
  it('guest replacement unregisters the old guest and repeated destruction stays idempotent', () => {
    const s = setup()
    s.ready(11); s.emit('dom-ready')
    s.ready(12); s.emit('dom-ready')
    expect(s.registrations.map(x => x.guestWebContentsId)).toEqual([11, 12])
    expect(s.unregistrations.map(x => x.guestWebContentsId)).toEqual([11])
    s.emit('destroyed'); s.emit('render-process-gone'); s.finish()
    expect(s.unregistrations.map(x => x.guestWebContentsId)).toEqual([11, 12])
  })
  it('changing the rendered source unregisters its previous document before registering the next', () => {
    const s = setup()
    s.ready(4); s.emit('dom-ready')
    s.hook.rerender({ src: 'file:///owned/next.html' })
    expect(s.unregistrations.map(x => x.guestWebContentsId)).toEqual([4])
    s.ready(5); s.emit('dom-ready')
    expect(s.registrations.map(x => x.guestWebContentsId)).toEqual([4, 5])
    s.finish()
  })
})

it('the existing inline GenUiAppCard consumer registers its real webview and unregisters on unmount', async () => {
  const React = await import('react')
  const { render } = await import('@testing-library/react')
  const { GenUiAppCard } = await import('../GenUiAppCard')
  const { TooltipProvider } = await import('../../tooltip')
  const registered: any[] = [], unregistered: any[] = []
  const onRegister = (event: any) => registered.push(event.detail)
  const onUnregister = (event: any) => unregistered.push(event.detail)
  window.addEventListener(GENUI_CARD_REGISTER_EVENT, onRegister)
  window.addEventListener(GENUI_CARD_UNREGISTER_EVENT, onUnregister)
  const view = render(React.createElement(TooltipProvider, null, React.createElement(GenUiAppCard, { appId: 'inline-app', title: 'Inline', html: '<p>inline</p>', indexPath: '/owned/index.html', sessionId: 'sess-a' })))
  try {
    const webview = view.container.querySelector('webview')! as HTMLElement & { getWebContentsId(): number }
    expect(webview).toBeTruthy()
    webview.getWebContentsId = () => 909
    act(() => { webview.dispatchEvent(new Event('dom-ready')) })
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ sessionId: 'sess-a', guestWebContentsId: 909 })
    expect(registered[0].cardId).toStartWith('inline-app-')
    view.unmount()
    expect(unregistered).toEqual(registered)
  } finally {
    view.unmount()
    window.removeEventListener(GENUI_CARD_REGISTER_EVENT, onRegister)
    window.removeEventListener(GENUI_CARD_UNREGISTER_EVENT, onUnregister)
  }
})
