import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'

let nextId = 1
class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    id: nextId++, mainFrame: {}, isDestroyed: () => this.destroyed,
    isLoadingMainFrame: () => this.loading,
    setWindowOpenHandler() {}, send() {},
  })
  destroyed = false
  visible = false
  focused = false
  loading = false
  setTitle() {}
  loadFile() { return Promise.resolve() }
  loadURL() { return Promise.resolve() }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isFocused() { return this.focused }
  show() { this.visible = true }
  focus() { this.focused = true }
  destroy() { this.destroyed = true; this.emit('closed') }
}
mock.module('electron', () => ({ BrowserWindow: FakeWindow, shell: {}, Menu: {}, nativeTheme: new EventEmitter(), app: { getName: () => 'Polo AI', isPackaged: true } }))
mock.module('../logger', () => ({ windowLog: { info() {}, warn() {}, error() {} } }))
mock.module('../webview-security', () => ({ installWebviewSecurityHandlers() {}, setWebviewScopeResolver() {} }))
mock.module('@polo-ai/shared/config', () => ({ getWorkspaceByNameOrId: () => ({ name: 'runtime' }) }))
const scope = { accountId: 'account-a', productSpaceId: 'enterprise-a' }
let trusted: typeof scope | null = scope
let accountGeneration = 1
let transitionEpoch = 1
let switching = false
mock.module('@polo-ai/server-core/handlers/rpc/trusted-product-space-account', () => ({
  captureTrustedSessionScope: () => trusted,
  getTrustedAccountGeneration: () => accountGeneration,
  getAccountTransitionEpoch: () => transitionEpoch,
  isAccountTransitionInProgress: () => false,
}))
mock.module('@polo-ai/server-core/runtime/product-space-executions', () => ({
  isSwitchInProgress: () => switching, isRuntimeOfflineReadOnly: () => false, isRuntimeProductSpaceRestricted: () => false,
}))
const { WindowManager } = await import('../window-manager')

beforeEach(() => { trusted = scope; switching = false; accountGeneration = 1; transitionEpoch = 1 })
function setup() {
  const manager = new WindowManager()
  const origin = manager.createWindow({ workspaceId: 'runtime-a' })
  expect(manager.reportWorkbenchReady(origin.webContents.id, scope)).toBe(true)
  return { manager, origin }
}
function target(manager: InstanceType<typeof WindowManager>) {
  return manager.getAllWindows().at(-1)!.window as unknown as FakeWindow
}

describe('verified main-window lifecycle', () => {
  it('keeps verified scope across in-page routes and revokes it on a real document navigation', async () => {
    const { manager, origin } = setup()
    origin.webContents.emit('did-start-navigation', {}, 'file:///workbench#chat', true, true)
    const pending = manager.createNewMainWindow(origin.webContents.id, 'renderer')
    expect(manager.getAllWindows()).toHaveLength(2)
    const win = target(manager)
    manager.reportWorkbenchReady(win.webContents.id, scope)
    expect((await pending).ok).toBe(true)
    origin.webContents.emit('did-start-navigation', {}, 'file:///workbench', false, true)
    expect((await manager.createNewMainWindow(origin.webContents.id, 'renderer')).reason).toBe('scope_unavailable')
  })

  it('shares one pending request across renderer, native menu and guest shortcuts', async () => {
    const { manager, origin } = setup()
    const first = manager.createNewMainWindow(origin.webContents.id, 'renderer')
    const second = manager.createNewMainWindow(origin.webContents.id, 'native_menu')
    const third = manager.createNewMainWindow(origin.webContents.id, 'webview_shortcut')
    expect(manager.getAllWindows()).toHaveLength(2)
    const win = target(manager)
    expect(manager.getWindowLaunchContext(win.webContents.id)).toEqual(scope)
    win.emit('ready-to-show')
    expect(win.visible).toBe(false)
    expect(manager.reportWorkbenchReady(win.webContents.id, { ...scope, productSpaceId: 'personal-a' })).toBe(false)
    expect(manager.reportWorkbenchReady(win.webContents.id, scope)).toBe(true)
    const results = await Promise.all([first, second, third])
    expect(results.every(result => result.ok)).toBe(true)
    expect(new Set(results.map(result => result.webContentsId)).size).toBe(1)
    expect(win.visible && win.focused).toBe(true)
    // A later independent request creates a fresh target.
    const fourth = manager.createNewMainWindow(origin.webContents.id, 'renderer')
    const next = target(manager)
    expect(next).not.toBe(win)
    manager.reportWorkbenchReady(next.webContents.id, scope)
    expect((await fourth).ok).toBe(true)
  })

  it('refuses unknown, unready, switching and stale-scope origins without creating a window', async () => {
    const { manager, origin } = setup()
    expect((await manager.createNewMainWindow(-1, 'renderer')).ok).toBe(false)
    switching = true
    expect((await manager.createNewMainWindow(origin.webContents.id, 'renderer')).reason).toBe('scope_unavailable')
    switching = false
    trusted = { ...scope, productSpaceId: 'another-space' }
    expect((await manager.createNewMainWindow(origin.webContents.id, 'renderer')).reason).toBe('scope_unavailable')
    trusted = scope
    manager.reportWorkbenchReady(origin.webContents.id, null)
    expect((await manager.createNewMainWindow(origin.webContents.id, 'renderer')).reason).toBe('scope_unavailable')
    expect(manager.getAllWindows()).toHaveLength(1)
  })

  it('rejects readiness during main-document load and destroys the target when its account session changes', async () => {
    const { manager, origin } = setup()
    const pending = manager.createNewMainWindow(origin.webContents.id, 'renderer')
    const win = target(manager)
    win.loading = true
    expect(manager.reportWorkbenchReady(win.webContents.id, scope)).toBe(false)
    win.loading = false
    accountGeneration++
    manager.reportWorkbenchReady(win.webContents.id, scope)
    expect((await pending).ok).toBe(false)
    expect(win.destroyed).toBe(true)
    expect(origin.isDestroyed()).toBe(false)
  })

  it('uses the initiating window runtime mapping and preserves its live sibling', async () => {
    const { manager, origin } = setup()
    const sibling = manager.createWindow({ workspaceId: 'runtime-b' })
    manager.reportWorkbenchReady(sibling.webContents.id, scope)
    const pending = manager.createNewMainWindow(sibling.webContents.id, 'renderer')
    const win = target(manager)
    expect(manager.getWorkspaceForWindow(win.webContents.id)).toBe('runtime-b')
    win.destroy()
    expect((await pending).ok).toBe(false)
    expect(origin.isDestroyed() || sibling.isDestroyed()).toBe(false)
    expect(win.listenerCount('closed')).toBe(1) // WindowManager's normal cleanup only.
  })
})
