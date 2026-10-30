import { describe, expect, it, mock } from 'bun:test'
let sequence = 100
let failPopup = false
let failLoad = false
let allocatedViews = 0
let deferredLoad: Promise<void> | null = null
const registrations = new Map<number, string>()
class FakeWindow {
  webContents = {
    id: ++sequence, events: new Map<string, (...args: any[]) => void>(),
    on(name: string, fn: any) { this.events.set(name, fn) },
    off(name: string) { this.events.delete(name) },
    emit(name: string, ...args: any[]) { this.events.get(name)?.(...args) },
  }
  dead = false
  visible = false
  views: any[] = []
  events = new Map<string, (...args: any[]) => void>()
  constructor() { if (failPopup) throw new Error('popup creation failed') }
  isDestroyed() { return this.dead }
  getContentSize() { return [880, 720] }
  addBrowserView(view: any) { this.views.push(view) }
  removeBrowserView(view: any) { this.views = this.views.filter(v => v !== view) }
  show() { this.visible = true }
  focus() {}
  hide() { this.visible = false }
  on(name: string, fn: any) { this.events.set(name, fn) }
  off(name: string) { this.events.delete(name) }
  once(name: string, fn: any) { this.on(name, fn) }
  destroy() { this.dead = true; this.events.get('closed')?.() }
  close() { this.events.get('close')?.({ preventDefault() {} }) }
}
class FakeView {
  constructor() { allocatedViews += 1 }
  bounds: any
  webContents = { id: ++sequence, dead: false, setWindowOpenHandler() {}, loadURL: async () => { if (failLoad) throw new Error('carrier unavailable') }, loadFile: async () => { if (failLoad) throw new Error('carrier unavailable'); if (deferredLoad) await deferredLoad }, on() {}, off() {}, isDestroyed() { return this.dead }, close() { this.dead = true } }
  setBounds(bounds: any) { this.bounds = bounds }
}
mock.module('electron', () => ({ BrowserView: FakeView, BrowserWindow: FakeWindow, app: {}, dialog: { showMessageBox: async () => ({ response: 0 }) }, nativeTheme: { shouldUseDarkColors: false } }))
mock.module('../webview-security', () => ({ registerGenUiCarrier: (id: number, session: string) => registrations.set(id, session), unregisterGenUiCarrier: (id: number) => registrations.delete(id) }))
const { setSyncTrustedProductSpaceAccountId, beginAccountTransition, settleAccountTransition } = await import('@polo-ai/server-core/handlers/rpc/trusted-product-space-account')
const { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount, setRuntimeProductSpaceRestricted } = await import('@polo-ai/server-core/runtime/product-space-executions')
const { CanvasPopupManager } = await import('../canvas-popup-manager')
const appInfo = { appId: 'guide', title: 'Guide', indexPath: '/owned/session/guide/index.html' }
const bounds = { x: 10, y: 50, width: 450, height: 700 }
async function setup() {
  setSyncTrustedProductSpaceAccountId(null)
  setRuntimeActiveProductSpace(null)
  failLoad = false
  failPopup = false
  const host = new FakeWindow()
  const manager = new CanvasPopupManager()
  const scopes = new Map<number, unknown>()
  manager.setWindowManager({ registerAuxRenderer: (id: number, _host: any, ws: string) => scopes.set(id, ws), unregisterAuxRenderer: (id: number) => scopes.delete(id) } as any)
  await manager.embed('sess-a', appInfo, host as any, 'ws-a', bounds)
  const entry = () => (manager as any).popouts.get('sess-a')
  return { host, manager, entry, scopes }
}
describe('persistent canvas carrier ownership and recovery', async () => {
  it('moves one carrier, hides in place, and returns without rebuilding the guest owner', async () => {
    const { host, manager, entry } = await setup()
    const view = entry().view
    manager.detachToPopup('sess-a')
    const popup = entry().popup
    expect(host.views).not.toContain(view)
    expect(popup.views).toContain(view)
    popup.close()
    expect(entry().poppedOut).toBe(true)
    expect(entry().visible).toBe(false)
    expect(view.webContents.dead).toBe(false)
    manager.focus('sess-a')
    expect(popup.visible).toBe(true)
    manager.attachFromPopup('sess-a')
    await manager.embed('sess-a', appInfo, host as any, 'ws-a', bounds)
    expect(entry().view).toBe(view)
    expect(host.views).toContain(view)
    expect(popup.dead).toBe(true)
    manager.destroyAll()
  })
  it('cancelling a close during AI work preserves its original location and carrier', async () => {
    const { manager, entry } = await setup()
    manager.detachToPopup('sess-a')
    const original = entry()
    const accepted = await manager.requestDestroy('sess-a', true)
    expect(accepted).toBe(false)
    expect(entry()).toBe(original)
    expect(entry().poppedOut).toBe(true)
    expect(entry().view.webContents.dead).toBe(false)
    manager.destroyAll()
  })
  it('popup creation failure leaves the original sidebar view and registration intact', async () => {
    const { host, manager, entry } = await setup()
    const view = entry().view
    failPopup = true
    expect(() => manager.detachToPopup('sess-a')).toThrow('popup creation failed')
    failPopup = false
    expect(host.views).toContain(view)
    expect(entry().poppedOut).toBe(false)
    expect(registrations.get(view.webContents.id)).toBe('sess-a')
    manager.destroyAll()
  })
  it('host reload and renderer crash revoke carriers without renderer RELEASE', async () => {
    const first = await setup()
    const firstView = first.entry().view
    first.host.webContents.emit('did-start-navigation', {}, 'file:///reload', false, true)
    expect(firstView.webContents.dead).toBe(true)
    expect(first.scopes.size).toBe(0)
    first.manager.destroyAll()
    const second = await setup()
    const secondView = second.entry().view
    second.host.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(secondView.webContents.dead).toBe(true)
    expect(second.scopes.size).toBe(0)
    second.manager.destroyAll()
  })
  it('Main account transition revokes an existing popup synchronously', async () => {
    const { manager, entry, scopes } = await setup()
    manager.detachToPopup('sess-a')
    const view = entry().view, popup = entry().popup
    const epoch = beginAccountTransition()
    expect(view.webContents.dead).toBe(true)
    expect(popup.dead).toBe(true)
    expect(scopes.size).toBe(0)
    settleAccountTransition(epoch, 'abort')
    manager.destroyAll()
  })
  it('asynchronous carrier failure rejects embed, retains an explicit failure state and permits retry', async () => {
    const { host, manager, scopes } = await setup()
    manager.destroy('sess-a')
    const states: any[] = []
    manager.onStateChanged(state => states.push(state))
    failLoad = true
    await expect(manager.embed('sess-a', appInfo, host as any, 'ws-a', bounds)).rejects.toThrow('carrier unavailable')
    expect(scopes.size).toBe(0)
    expect(states.at(-1)).toMatchObject({ sessionId: 'sess-a', isVisible: true, loadFailed: true })
    expect(states.at(-1).closed).toBeUndefined()
    failLoad = false
    await manager.embed('sess-a', appInfo, host as any, 'ws-a', bounds)
    expect(scopes.size).toBe(1)
    manager.destroyAll()
  })
  it('restricted and partially signed-out scopes allocate zero native views', async () => {
    const host = new FakeWindow()
    const attempt = async () => {
      const manager = new CanvasPopupManager(), before = allocatedViews
      try { await expect(manager.embed('sess-a', appInfo, host as any, 'ws-a', bounds)).rejects.toThrow('scope is unavailable'); expect(allocatedViews).toBe(before) } finally { manager.destroyAll() }
    }
    setSyncTrustedProductSpaceAccountId('account-a'); setRuntimeActiveProductSpaceAccount('account-a'); setRuntimeActiveProductSpace('space-a')
    setRuntimeProductSpaceRestricted('space-a', true)
    await attempt()
    setRuntimeProductSpaceRestricted('space-a', false)
    setSyncTrustedProductSpaceAccountId(null)
    await attempt() // signed out while the old fence survives
    setRuntimeActiveProductSpace(null)
    const epoch = beginAccountTransition()
    try { await attempt() } finally { settleAccountTransition(epoch, 'abort') }
  })
  it('a replacement with the same session cannot make an older EMBED report success', async () => {
    const { host, manager, entry } = await setup()
    manager.destroy('sess-a')
    let release!: () => void
    deferredLoad = new Promise<void>(resolve => { release = resolve })
    const old = manager.embed('sess-a', appInfo, host as any, 'ws-a', bounds)
    const observed = old.catch(error => error)
    deferredLoad = null
    await manager.embed('sess-a', { ...appInfo, appId: 'next', indexPath: '/owned/next/index.html' }, host as any, 'ws-a', bounds)
    release()
    expect(await observed).toBeInstanceOf(Error)
    expect(entry().app.appId).toBe('next')
    manager.destroyAll()
  })
  it('foreign workspace and foreign sender controls fail before changing the surface', async () => {
    const { host, manager, entry } = await setup()
    expect(() => manager.assertOwner('sess-a', host.webContents.id, 'ws-b')).toThrow()
    expect(() => manager.assertOwner('sess-a', host.webContents.id + 10, 'ws-a')).toThrow()
    expect(entry().poppedOut).toBe(false)
    manager.destroyAll()
  })
  it('host destruction and scope release destroy exactly owned views and registrations', async () => {
    const { host, manager, entry, scopes } = await setup()
    const view = entry().view
    manager.releaseForHost(host.webContents.id + 10)
    expect(view.webContents.dead).toBe(false)
    host.destroy()
    expect(view.webContents.dead).toBe(true)
    expect(scopes.size).toBe(0)
    expect(registrations.has(view.webContents.id)).toBe(false)
    const second = await setup()
    const other = second.entry().view
    second.manager.releaseForHost(second.host.webContents.id)
    expect(other.webContents.dead).toBe(true)
    second.manager.destroyAll()
  })
})
