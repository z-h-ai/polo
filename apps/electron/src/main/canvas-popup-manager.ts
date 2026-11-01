/** A persistent renderer carrier moves as one BrowserView; its trusted guest never remounts. */
import { BrowserView, BrowserWindow, app, nativeTheme, dialog } from 'electron'
import { i18n } from '@polo-ai/shared/i18n'
import { join } from 'path'
import type { BrowserEmbedBounds, CanvasPaneApp, CanvasPanePopoutState } from '@polo-ai/shared/protocol'
import { registerGenUiCarrier, unregisterGenUiCarrier } from './webview-security'
import { captureCompleteTrustedSessionScopeToken, isTrustedSessionScopeTokenCurrent, getAccountTransitionEpoch, getTrustedAccountGeneration, getSyncTrustedProductSpaceAccountState, isAccountTransitionInProgress, type TrustedSessionScopeToken } from '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
import { onRuntimeScopeChanged, getRuntimeFenceGeneration, getRuntimeActiveProductSpace, isRuntimeProductSpaceRestricted } from '@polo-ai/server-core/runtime/product-space-executions'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
interface CanvasEntry {
  view: BrowserView
  host: BrowserWindow
  popup: BrowserWindow | null
  app: CanvasPaneApp
  workspaceId: string | null
  poppedOut: boolean
  visible: boolean
  mountedIn: BrowserWindow | null
  ready: Promise<void>
  cleanupHost: () => void
  scope: { token: TrustedSessionScopeToken | null; epoch: number; generation: number; fence: number }
}

export class CanvasPopupManager {
  private popouts = new Map<string, CanvasEntry>()
  private windowManager: WindowManager | null = null
  private readonly offScope: () => void
  constructor() {
    this.offScope = onRuntimeScopeChanged(() => {
      for (const [id, entry] of [...this.popouts]) if (!this.scopeCurrent(entry.scope)) this.destroy(id)
    })
  }
  private scopeCurrent(scope: CanvasEntry['scope']): boolean {
    const { token, epoch, generation, fence } = scope
    if (token) return isTrustedSessionScopeTokenCurrent(token) && !isRuntimeProductSpaceRestricted(token.productSpaceId)
    return getSyncTrustedProductSpaceAccountState().status === 'signed_out' && !getRuntimeActiveProductSpace() && !isAccountTransitionInProgress() && getAccountTransitionEpoch() === epoch && getTrustedAccountGeneration() === generation && getRuntimeFenceGeneration() === fence
  }
  private stateListeners = new Set<(state: CanvasPanePopoutState) => void>()
  setWindowManager(value: WindowManager | null): void { this.windowManager = value }
  onStateChanged(listener: (state: CanvasPanePopoutState) => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }
  private emit(sessionId: string, entry: CanvasEntry, closed = false): void {
    const state = { sessionId, poppedOut: entry.poppedOut, isVisible: entry.visible, ...(closed ? { closed: true } : {}) }
    for (const listener of this.stateListeners) { try { listener(state) } catch (error) { mainLog.warn('[canvas] state consumer failed', error) } }
  }
  /** All controls accept only the exact owner window or this canvas's carrier renderer. */
  assertOwner(sessionId: string, senderId: number | null | undefined, workspaceId: string | null | undefined): CanvasEntry | undefined {
    const entry = this.popouts.get(sessionId)
    if (entry && !this.scopeCurrent(entry.scope)) { this.destroy(sessionId); throw new Error('Canvas scope has ended') }
    if (entry && (entry.workspaceId !== (workspaceId ?? null) || (senderId !== entry.host.webContents.id && senderId !== entry.view.webContents.id))) {
      throw new Error('Canvas belongs to another window or workspace')
    }
    return entry
  }
  private mount(entry: CanvasEntry, target: BrowserWindow): void {
    if (entry.mountedIn === target) return
    if (entry.mountedIn && !entry.mountedIn.isDestroyed()) entry.mountedIn.removeBrowserView(entry.view)
    target.addBrowserView(entry.view)
    entry.mountedIn = target
  }
  private unmount(entry: CanvasEntry): void {
    if (entry.mountedIn && !entry.mountedIn.isDestroyed()) entry.mountedIn.removeBrowserView(entry.view)
    entry.mountedIn = null
  }
  async embed(sessionId: string, app_: CanvasPaneApp, host: BrowserWindow, workspaceId: string | null | undefined, bounds: BrowserEmbedBounds): Promise<void> {
    let entry = this.assertOwner(sessionId, host.webContents.id, workspaceId)
    if (entry && (entry.app.appId !== app_.appId || entry.app.indexPath !== app_.indexPath)) {
      this.destroy(sessionId, false)
      entry = undefined
    }
    if (!entry) {
      const token = captureCompleteTrustedSessionScopeToken(workspaceId)
      const scope = { token, epoch: getAccountTransitionEpoch(), generation: getTrustedAccountGeneration(), fence: getRuntimeFenceGeneration() }
      if (!this.scopeCurrent(scope)) throw new Error('Canvas scope is unavailable')
      const view = new BrowserView({ webPreferences: { preload: join(__dirname, 'bootstrap-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true } })
      entry = { view, host, popup: null, app: app_, workspaceId: workspaceId ?? null, poppedOut: false, visible: true, mountedIn: null, scope, ready: Promise.resolve(), cleanupHost: () => {} }
      this.popouts.set(sessionId, entry)
      registerGenUiCarrier(view.webContents.id, sessionId)
      this.windowManager?.registerAuxRenderer(view.webContents.id, host, entry.workspaceId)
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const current = entry
      const release = () => { if (this.popouts.get(sessionId) === current) this.destroy(sessionId) }
      const onNavigation = (_event: unknown, _url: string, sameDocument: boolean, mainFrame: boolean) => { if (mainFrame && !sameDocument) release() }
      const fail = () => { if (this.popouts.get(sessionId) === current) this.failLoad(sessionId, current) }
      host.once('closed', release)
      host.webContents.on('render-process-gone', release)
      host.webContents.on('did-start-navigation', onNavigation)
      view.webContents.on('render-process-gone', fail)
      entry.cleanupHost = () => {
        host.off('closed', release)
        host.webContents.off('render-process-gone', release)
        host.webContents.off('did-start-navigation', onNavigation)
        view.webContents.off('render-process-gone', fail)
      }
      const query = new URLSearchParams({ sessionId, app: JSON.stringify(app_) })
      const load = VITE_DEV_SERVER_URL ? view.webContents.loadURL(`${VITE_DEV_SERVER_URL}/canvas-popout.html?${query}`) : view.webContents.loadFile(join(__dirname, 'renderer/canvas-popout.html'), { search: query.toString() })
      entry.ready = load.catch(error => {
        if (this.popouts.get(sessionId) === current) this.failLoad(sessionId, current)
        throw error
      })
    }
    if (entry.poppedOut) return
    this.mount(entry, host)
    entry.view.setBounds({ x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) })
    entry.visible = true
    this.emit(sessionId, entry)
    await entry.ready
    if (this.popouts.get(sessionId) !== entry || !this.scopeCurrent(entry.scope)) throw new Error('Canvas scope or host has ended')
  }
  unembed(sessionId: string): void {
    const entry = this.popouts.get(sessionId)
    if (!entry || entry.poppedOut) return
    this.unmount(entry)
  }
  detachToPopup(sessionId: string, _app?: CanvasPaneApp, _workspaceId?: string | null): void {
    const entry = this.popouts.get(sessionId)
    if (!entry) throw new Error('Open the canvas before detaching it')
    if (entry.popup && !entry.popup.isDestroyed()) { this.focus(sessionId); return }
    // Construct before moving the carrier: a failed popup leaves the sidebar intact.
    const popup = new BrowserWindow({ width: 880, height: 720, minWidth: 480, minHeight: 360, show: false, title: entry.app.title, backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b292e' : '#fafafb', autoHideMenuBar: true })
    const layout = () => { const [width, height] = popup.getContentSize(); entry.view.setBounds({ x: 0, y: 0, width, height }) }
    try { this.mount(entry, popup); layout() } catch (error) { popup.destroy(); this.mount(entry, entry.host); throw error }
    entry.popup = popup
    entry.poppedOut = true
    entry.visible = true
    popup.on('resize', layout)
    popup.on('close', event => { event.preventDefault(); this.hide(sessionId) })
    popup.on('closed', () => { if (entry.popup === popup) { entry.popup = null; entry.visible = false; this.emit(sessionId, entry) } })
    popup.show()
    popup.focus()
    this.emit(sessionId, entry)
  }
  attachFromPopup(sessionId: string): void {
    const entry = this.popouts.get(sessionId)
    if (!entry) return
    this.unmount(entry)
    const popup = entry.popup
    entry.popup = null
    if (popup && !popup.isDestroyed()) popup.destroy()
    entry.poppedOut = false
    entry.visible = true
    this.emit(sessionId, entry)
    // Renderer measures the sidebar before the view is attached there.
  }
  hide(sessionId: string): void {
    const entry = this.popouts.get(sessionId)
    if (!entry) return
    if (entry.poppedOut) entry.popup?.hide()
    else this.unmount(entry)
    entry.visible = false
    this.emit(sessionId, entry)
  }
  focus(sessionId: string): void {
    const entry = this.popouts.get(sessionId)
    if (!entry) return
    if (entry.poppedOut && entry.popup && !entry.popup.isDestroyed()) { entry.popup.show(); entry.popup.focus() }
    entry.visible = true
    this.emit(sessionId, entry)
  }
  async requestDestroy(sessionId: string, aiActive: boolean): Promise<boolean> {
    const entry = this.popouts.get(sessionId)
    if (!entry) return true
    if (aiActive) {
      const parent = entry.poppedOut && entry.popup ? entry.popup : entry.host
      const answer = await dialog.showMessageBox(parent, { type: 'warning', title: entry.app.title, message: i18n.t('genui.app.closeActiveTitle'), detail: i18n.t('genui.app.closeActiveBody'), buttons: [i18n.t('common.cancel'), i18n.t('common.close')], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return false
    }
    if (this.popouts.get(sessionId) !== entry) return false
    this.destroy(sessionId)
    return true
  }
  private failLoad(sessionId: string, entry: CanvasEntry): void {
    this.destroy(sessionId, false)
    for (const listener of this.stateListeners) { try { listener({ sessionId, poppedOut: false, isVisible: true, loadFailed: true }) } catch (error) { mainLog.warn('[canvas] failure consumer failed', error) } }
  }
  destroy(sessionId: string, notify = true): void {
    const entry = this.popouts.get(sessionId)
    if (!entry) return
    this.popouts.delete(sessionId)
    const wcId = entry.view.webContents.id
    const popup = entry.popup
    entry.popup = null
    const releases = [
      () => entry.cleanupHost(),
      () => this.unmount(entry),
      () => unregisterGenUiCarrier(wcId),
      () => this.windowManager?.unregisterAuxRenderer(wcId),
      () => { if (popup && !popup.isDestroyed()) popup.destroy() },
      () => { if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false }) },
    ]
    for (const release of releases) { try { release() } catch (error) { mainLog.error('[canvas] failed to release owned resource', error) } }
    entry.visible = false
    if (notify) this.emit(sessionId, entry, true)
  }
  releaseForHost(senderId: number): void {
    for (const [id, entry] of this.popouts) if (entry.host.webContents.id === senderId) this.destroy(id)
  }
  isPoppedOut(sessionId: string): boolean { return this.popouts.get(sessionId)?.poppedOut ?? false }
  destroyAll(): void { for (const id of [...this.popouts.keys()]) this.destroy(id); this.offScope() }
}
export function isCanvasPopupSupported(): boolean { return typeof BrowserWindow !== 'undefined' && typeof app !== 'undefined' }
