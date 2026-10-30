/** Native regression harness. Production managers, view carriers, components and attach gate;
 * only account/transport/storage boundaries are isolated fixtures. */
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { BrowserPaneManager } from '../../src/main/browser-pane-manager'
import { CanvasPopupManager } from '../../src/main/canvas-popup-manager'
import { installWebviewSecurityHandlers, setGenUiGuestSrcValidator, setWebviewScopeResolver } from '../../src/main/webview-security'
import { getUiCardRegistry } from '../../src/main/ui-card-registry'
import { setSyncTrustedProductSpaceAccountId } from '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
import { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } from '@polo-ai/server-core/runtime/product-space-executions'

const BUILD = process.env.POO159_BUILD_DIR!
const OUT = process.env.POO159_EVIDENCE_DIR!
const SOURCE_REF = process.env.POO159_SOURCE_REF ?? 'unknown'
const BASELINE = process.env.POO159_BASELINE === '1'
mkdirSync(OUT, { recursive: true })
const result: any = { sourceRef: SOURCE_REF, baseline: BASELINE, startedAt: new Date().toISOString(), checks: [], captures: [], consoleErrors: [] }
const check = (name: string, ok: boolean, detail?: unknown) => { result.checks.push({ name, ok, detail }); if (!ok) console.error('FAIL', name, detail) }
const delay = (ms = 200) => new Promise<void>(r => setTimeout(r, ms))
async function until(probe: () => unknown | Promise<unknown>, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return; await delay(80) } throw new Error(`Timeout: ${probe.toString().slice(0, 100)}`) }
let host: BrowserWindow
let bpm: BrowserPaneManager
let canvas: CanvasPopupManager
let server: ReturnType<typeof createServer>
let lastId = ''
const js = <T = any>(expr: string) => host.webContents.executeJavaScript(expr) as Promise<T>
const bundle = join(BUILD, 'fixture-bundle', 'index.html')
const secondBundle = join(BUILD, 'fixture-other', 'index.html')
let restoreCarrier: (() => void) | null = null
const auxiliary = new Map<number, string | null>()
let registryCalls = 0

async function capture(name: string, file = false) {
  host.show()
  host.focus()
  await delay(100)
  const viewport = await js<[number, number]>('[innerWidth,innerHeight]')
  const selector = file ? 'button containing guide.html (visible, unobscured)' : 'header span'
  const expected = file ? 'guide.html' : 'ws-a / sess-a'
  const probe = async () => js<string>(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(file ? 'button' : 'header span')})]
    for (const node of candidates) {
      const rect = node.getBoundingClientRect(), text = node.innerText || ''
      const hit = document.elementFromPoint(rect.x + Math.min(rect.width / 2, 50), rect.y + rect.height / 2)
      if (text.includes(${JSON.stringify(expected)}) && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden' && hit && (node.contains(hit) || hit.contains(node))) return text
    }
    throw new Error('Expected visible identity unavailable')
  })()`)
  const observed = await probe()
  const raw = (await host.capturePage()).toPNG()
  if (observed !== await probe()) throw new Error('Identity changed during capture')
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, raw)
  const scene = { source_ref: SOURCE_REF, object: file ? 'guide.html' : 'same-session browser', state: name, role: 'workspace member', data: 'isolated ws-a / sess-a fixture', viewport, identity: { resource: expected } }
  const receipt = { schema_version: 1, captured_at: new Date().toISOString(), url: host.webContents.getURL(), scene, image: { sha256: createHash('sha256').update(raw).digest('hex'), width: raw.readUInt32BE(16), height: raw.readUInt32BE(20), device_scale_factor: await js('devicePixelRatio'), full_page: false }, identity_checks: { resource: { selector, expected, observed } }, state_checks: [{ selector, expected, observed }], native_capture: 'BrowserWindow.capturePage; native BrowserViews excluded; see separate view captures' }
  writeFileSync(path.replace('.png', '.capture.json'), JSON.stringify(receipt, null, 2))
  result.captures.push({ kind: 'screenshot', path, capture: path.replace('.png', '.capture.json'), ...scene })
}
async function captureView(name: string, wc: Electron.WebContents) {
  const image = await wc.capturePage()
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, image.toPNG())
  result.captures.push({ path, boundary: 'native view captured separately from host', webContentsId: wc.id, url: wc.getURL(), size: image.getSize() })
}

async function browserJourney() {
  await js('window.__harness.openBrowser()')
  await until(() => lastId)
  const inst = () => bpm.instances.get(lastId)!
  await until(() => inst().toolbarReady && !inst().pageView.webContents.isLoading(), 25000)
  await bpm.navigate(lastId, `http://127.0.0.1:${(server.address() as { port: number }).port}/guide`)
  await delay(600)
  check('ordinary open uses sidebar without popup', inst().hostMode === 'embedded' && !inst().window.isVisible())
  await capture('browser-open')
  const page = inst().pageView.webContents
  await page.executeJavaScript("window.fixtureMarker=123;document.querySelector('#draft').value='未提交笔记';scrollTo(0,60)")
  const id = page.id
  await js("document.querySelector('[data-testid=sidebar-browser-detach]').click()")
  await delay(400)
  check('explicit popup moves same WebContents', page.id === id && inst().hostMode === 'popup' && inst().window.isVisible())
  check('popup releases sidebar width', await js("document.querySelector('[data-right-sidebar-pane]').getBoundingClientRect().width < 2"))
  await capture('browser-popup')
  await captureView('browser-popup-page', page)
  inst().window.close()
  await delay(250)
  check('system close only hides popup', inst().hostMode === 'popup' && !inst().window.isVisible())
  check('hidden popup retains instance and JS/input', page.id === id && await page.executeJavaScript("window.fixtureMarker===123 && document.querySelector('#draft').value==='未提交笔记'"))
  await capture('browser-hidden')
  bpm.focus(lastId)
  await delay(250)
  check('ordinary reopen restores chosen popup surface', inst().hostMode === 'popup' && inst().window.isVisible())
  await bpm.embedInstance(lastId, host)
  await js('window.__harness.open()')
  await delay(400)
  check('explicit return preserves JS/input/scroll', page.id === id && await page.executeJavaScript("window.fixtureMarker===123 && document.querySelector('#draft').value==='未提交笔记' && scrollY===60"))
  await capture('browser-return')
  await captureView('browser-return-page', page)
  bpm.destroyInstance(lastId)
  await js('window.__harness.collapse()')
}

async function fileJourney() {
  await js('void window.__harness.openFile()')
  await until(() => js('Boolean(window.__releaseFile)'))
  await capture('file-loading', true)
  check('file read is still pending during capture', await js('Boolean(window.__releaseFile)'))
  await js('window.__releaseFile(); window.__releaseFile=null')
  await delay(650)
  await capture('file-rendered', true)
  if (BASELINE) return
  const frame = host.webContents.mainFrame.framesInSubtree.find(f => f.url === 'about:srcdoc')!
  check('HTML rendered with an isolated script context', Boolean(frame) && await frame.executeJavaScript('window.marker===123 && !window.electronAPI'))
  check('HTML cannot read host bridge', await frame.executeJavaScript("(()=>{try{return !parent.electronAPI}catch{return true}})()"))
  const relativeLoaded = await frame.executeJavaScript('document.querySelector("img").naturalWidth>0')
  result.htmlRelativeResourceSupport = { supported: relativeLoaded, explanation: 'Opaque sandboxed srcDoc does not grant arbitrary local-file access; inline content and scripts are supported.' }
  await frame.executeJavaScript("document.querySelector('input').value='保留输入'; window.marker=456; scrollTo(0,40)")
  await js("document.querySelector('[title=查看源码]').click()")
  await delay(150)
  await js("document.querySelector('[title=查看源码]').click()")
  check('source toggle retains the same HTML document', await frame.executeJavaScript("window.marker===456 && document.querySelector('input').value==='保留输入'"))
  await js('window.__harness.hideFile()')
  await delay(300)
  await until(() => js("document.querySelector('[data-right-sidebar-pane]').getBoundingClientRect().width < 1"), 2500)
  check('hidden HTML releases sidebar width', await js("document.querySelector('[data-right-sidebar-pane]').getBoundingClientRect().width < 2"))
  await js('window.__harness.showFile()')
  await delay(300)
  check('hidden HTML resumes same document and input', await frame.executeJavaScript("window.marker===456 && document.querySelector('input').value==='保留输入'"))
  await js('window.__harness.openRequestedBrowser()')
  await bpm.navigate(lastId, `http://127.0.0.1:${(server.address() as { port: number }).port}/guide`)
  await delay(400)
  check('opening a webpage replaces visible HTML through the real open-request subscription', await js("Boolean(document.querySelector('[data-testid=file-preview-pane]')?.parentElement.hidden) && Boolean(document.querySelector('[data-testid=sidebar-browser-nav-layer]'))"))
  await capture('file-to-browser')
  bpm.destroyInstance(lastId)
  await js('window.__harness.hideFile()')
}

async function baselineCanvasJourney() {
  await js('window.__harness.closeFile()')
  await js(`window.__harness.openCanvas(${JSON.stringify(bundle)})`)
  await until(() => js("(()=>{try{return Boolean(document.querySelector('webview')?.getWebContentsId())}catch{return false}})()"))
  const { webContents } = await import('electron')
  const beforeId = await js("document.querySelector('webview').getWebContentsId()")
  const original = webContents.fromId(beforeId)!
  await until(() => original.executeJavaScript("Boolean(document.querySelector('#draft'))"))
  await original.executeJavaScript("window.marker=777;document.querySelector('#draft').value='画布输入';scrollTo(0,60)")
  await js("document.querySelector('[data-testid=canvas-card-popout]').click()")
  await until(() => (canvas as any).popouts.has('sess-a'))
  await delay(700)
  const popup = (canvas as any).popouts.get('sess-a').window as BrowserWindow
  await until(() => popup.webContents.executeJavaScript("(()=>{try{return Boolean(document.querySelector('webview')?.getWebContentsId())}catch{return false}})()"), 20000)
  const popupId = await popup.webContents.executeJavaScript("document.querySelector('webview').getWebContentsId()")
  const popupGuest = webContents.fromId(popupId)!
  await until(() => popupGuest.executeJavaScript("Boolean(document.querySelector('#draft'))"))
  await until(() => js("Boolean(document.querySelector('[data-testid=sidebar-canvas-popup-placeholder]'))"))
  await delay(300)
  await capture('canvas-popup')
  await captureView('canvas-popup-carrier', popup.webContents)
  await captureView('canvas-popup-guest', popupGuest)
  result.baselineCanvas = { beforeGuestId: beforeId, popupGuestId: popupId, originalDestroyed: original.isDestroyed(), sameGuest: beforeId === popupId }
  try { canvas.attachFromPopup('sess-a') } catch (error) { result.baselineCanvas.attachError = String(error) }
  await delay(500)
  await capture('canvas-return')
}

async function canvasJourney() {
  await js(`window.__harness.openCanvas(${JSON.stringify(bundle)})`)
  await until(() => (canvas as any).popouts.has('sess-a'))
  const entry = () => (canvas as any).popouts.get('sess-a')
  await until(() => entry().view.webContents.getURL().includes('canvas-popout'))
  const carrier = entry().view.webContents as Electron.WebContents
  await until(async () => carrier.executeJavaScript("(()=>{try{return Boolean(document.querySelector('webview')?.getWebContentsId())}catch{return false}})()").catch(() => false), 20000)
  const guestId = await carrier.executeJavaScript("document.querySelector('webview').getWebContentsId()")
  const { webContents } = await import('electron')
  const guest = webContents.fromId(guestId)!
  await until(async () => guest.executeJavaScript("Boolean(document.querySelector('#draft'))"))
  await until(() => registryCalls > 0)
  check('trusted canvas registered through real attach gate', registryCalls > 0, { guestId, carrierId: carrier.id })
  await guest.executeJavaScript("document.querySelector('#draft').value='画布输入'; window.marker=777; scrollTo(0,60)")
  canvas.detachToPopup('sess-a')
  await delay(400)
  check('canvas popup keeps carrier and guest IDs', entry().view.webContents.id === carrier.id && await carrier.executeJavaScript("document.querySelector('webview').getWebContentsId()") === guestId)
  check('canvas popup frees sidebar', await js("document.querySelector('[data-right-sidebar-pane]').getBoundingClientRect().width < 2"))
  await capture('canvas-popup')
  await captureView('canvas-popup-carrier', carrier)
  await captureView('canvas-popup-guest', guest)
  entry().popup.close()
  await delay(200)
  check('canvas system close hides without return', entry().poppedOut && !entry().visible)
  await js('window.__harness.focusCanvas()')
  await delay(150)
  check('transcript FOCUS restores existing popup without returning it', entry().poppedOut && entry().visible && entry().popup.isVisible())
  canvas.attachFromPopup('sess-a')
  await delay(500)
  check('canvas return preserves JS/input/scroll and guest', await carrier.executeJavaScript("document.querySelector('webview').getWebContentsId()") === guestId && await guest.executeJavaScript("window.marker===777 && document.querySelector('#draft').value==='画布输入' && scrollY===60"))
  const foreign = getUiCardRegistry().registerCard({ sessionId: 'sess-b', cardId: 'foreign-test', guestWebContentsId: guestId, hostWebContentsId: carrier.id })
  check('foreign-session bridge registration refused', !foreign.ok, foreign)
  let ownerRejected = false
  try { canvas.assertOwner('sess-a', host.webContents.id + 1000, 'ws-a') } catch { ownerRejected = true }
  check('foreign sender cannot control canvas', ownerRejected)
  // A compromised carrier cannot attach another session or an arbitrary file.
  const attachCount = await carrier.executeJavaScript("document.querySelectorAll('webview').length")
  await carrier.executeJavaScript("(()=>{const v=document.createElement('webview');v.partition='genui-app-sess-b';v.src='file:///etc/hosts';document.body.append(v)})()")
  await delay(200)
  const forged = await carrier.executeJavaScript("(()=>{const v=[...document.querySelectorAll('webview')].at(-1);try{return v.getWebContentsId()}catch{return null}})()")
  check('forged foreign-session partition never attaches', !forged, { attachCount, forged })
  await capture('canvas-return')
  canvas.destroy('sess-a')
  await delay(100)
  check('explicit canvas close destroys only owned carrier/guest', carrier.isDestroyed() && guest.isDestroyed())
  await until(() => js('window.__harness.canvasState().app === null'))
  await js(`window.__harness.openCanvas(${JSON.stringify(bundle)})`)
  await until(() => (canvas as any).popouts.has('sess-a'))
  await until(() => js("Boolean(document.querySelector('[data-testid=native-canvas-surface]'))"))
  check('close then same-app open resets presentation', await js("Boolean(window.__harness.canvasState().app) && window.__harness.canvasState().presentation?.isVisible !== false"))
  canvas.destroy('sess-a')
  await until(() => js('window.__harness.canvasState().app === null'))
  await js(`window.__harness.openCanvas(${JSON.stringify(secondBundle)}, 'guide-other', '第二画布')`)
  await until(() => (canvas as any).popouts.has('sess-a'))
  check('close then a different app opens normally', entry().app.appId === 'guide-other')
  canvas.destroy('sess-a')
  await until(() => js('window.__harness.canvasState().app === null'))

  const carrierPath = join(BUILD, 'renderer', 'canvas-popout.html'), unavailable = carrierPath + '.unavailable'
  renameSync(carrierPath, unavailable)
  restoreCarrier = () => { if (existsSync(unavailable)) renameSync(unavailable, carrierPath); restoreCarrier = null }
  try {
    await js(`window.__harness.openCanvas(${JSON.stringify(bundle)})`)
    await until(() => js("Boolean(document.querySelector('[data-testid=native-canvas-surface] [role=alert]'))"))
    check('carrier load failure remains an explicit error with the original target', await js("window.__harness.canvasState().app?.appId === 'guide-canvas' && Boolean(document.querySelector('[data-testid=native-canvas-surface] [role=alert] button'))"))
    await capture('canvas-load-error')
  } finally { restoreCarrier?.() }
  await js("document.querySelector('[data-testid=native-canvas-surface] [role=alert] button').click()")
  await until(() => (canvas as any).popouts.has('sess-a'))
  const retryCarrier = entry().view.webContents as Electron.WebContents
  await until(() => retryCarrier.executeJavaScript("(()=>{try{return Boolean(document.querySelector('webview')?.getWebContentsId())}catch{return false}})()"))
  check('retry starts the same requested target after load recovery', entry().app.appId === 'guide-canvas' && !retryCarrier.isDestroyed())
  canvas.detachToPopup('sess-a')
  const reloadView = entry().view.webContents
  const reloaded = new Promise<void>(resolve => host.webContents.once('did-finish-load', () => resolve()))
  host.webContents.reload()
  await reloaded
  await until(() => reloadView.isDestroyed())
  check('host reload independently revokes its popup and auxiliary mapping', auxiliary.size === 0)
  await until(() => js('Boolean(window.__harness?.ready)'))
  await js(`window.__harness.openCanvas(${JSON.stringify(bundle)})`)
  await until(() => (canvas as any).popouts.has('sess-a'))
  const scopeView = entry().view.webContents as Electron.WebContents
  await until(() => scopeView.executeJavaScript("(()=>{try{return Boolean(document.querySelector('webview')?.getWebContentsId())}catch{return false}})()"))
  const scopeGuestId = await scopeView.executeJavaScript("document.querySelector('webview').getWebContentsId()")
  const scopeGuest = webContents.fromId(scopeGuestId)!
  canvas.detachToPopup('sess-a')
  const scopePopup = entry().popup as BrowserWindow
  setRuntimeActiveProductSpace(null)
  const synchronouslyRevoked = !(canvas as any).popouts.has('sess-a') && auxiliary.size === 0 && (scopePopup.isDestroyed() || !scopePopup.isVisible())
  await until(() => scopeView.isDestroyed() && scopeGuest.isDestroyed() && scopePopup.isDestroyed())
  check('Main scope invalidation independently revokes the carrier', synchronouslyRevoked && scopeView.isDestroyed() && scopeGuest.isDestroyed() && scopePopup.isDestroyed(), { synchronouslyRevoked, carrierDestroyed: scopeView.isDestroyed(), guestDestroyed: scopeGuest.isDestroyed(), popupDestroyed: scopePopup.isDestroyed() })

}

async function main() {
  mkdirSync(join(BUILD, 'profile'), { recursive: true })
  app.setPath('userData', join(BUILD, 'profile'))
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion')
  await app.whenReady()
  app.dock?.hide()
  setSyncTrustedProductSpaceAccountId('fixture-account')
  setRuntimeActiveProductSpaceAccount('fixture-account')
  setRuntimeActiveProductSpace('fixture-space')
  setWebviewScopeResolver({ getWorkspaceForWebContentsId: id => auxiliary.get(id) ?? (host?.webContents.id === id ? 'ws-a' : null) })
  setGenUiGuestSrcValidator((sid, src) => { try { return sid === 'sess-a' && [bundle, secondBundle].includes(fileURLToPath(new URL(src)).split('?')[0]) } catch { return false } })
  installWebviewSecurityHandlers()
  app.on('web-contents-created', (_event, contents) => { contents.on('console-message', (_e, level, message) => { if (level >= 3) result.consoleErrors.push({ webContentsId: contents.id, message }) }) })
  server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><title>阅读指南</title><style>body{font:16px -apple-system;padding:28px}section{height:900px}input{padding:12px;width:80%}</style><h1>阅读指南</h1><label>阅读笔记<input id="draft"></label><section>隔离网页夹具</section>') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  mkdirSync(join(BUILD, 'fixture-other'), { recursive: true })
  writeFileSync(secondBundle, '<!doctype html><title>第二画布</title><h1>第二画布</h1><input id="draft">')
  writeFileSync(bundle, '<!doctype html><title>阅读指南</title><meta name="polo-bridge" content="ui-event"><h1>阅读指南</h1><input id="draft"><div style="height:1000px"></div><script>window.marker=123</script>')
  host = new BrowserWindow({ width: 1440, height: 900, frame: false, useContentSize: true, show: false, webPreferences: { preload: join(BUILD, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true } })
  const wm: any = { getFocusedWindow: () => host, getWorkspaceForWindow: (id: number) => auxiliary.get(id) ?? (id === host.webContents.id ? 'ws-a' : null), getWindowByWorkspace: () => host, getAllWindows: () => [{ window: host, workspaceId: 'ws-a' }], trackWindow() {}, untrackWindow() {}, registerAuxRenderer: (id: number, _host: BrowserWindow, ws: string) => auxiliary.set(id, ws), unregisterAuxRenderer: (id: number) => auxiliary.delete(id), registerAuxWindow: (window: BrowserWindow, ws: string) => auxiliary.set(window.webContents.id, ws), unregisterAuxWindow: (id: number) => auxiliary.delete(id) }
  bpm = new BrowserPaneManager(); bpm.setWindowManager(wm); bpm.setSessionNameResolver(() => '阅读指南'); bpm.registerToolbarIpc()
  canvas = new CanvasPopupManager(); canvas.setWindowManager(wm)
  canvas.onStateChanged(state => {
    if (!host.isDestroyed()) host.webContents.send('canvas-state', state)
    const entry = (canvas as any).popouts.get(state.sessionId)
    const carrier = entry?.view?.webContents ?? entry?.window?.webContents
    if (carrier && !carrier.isDestroyed()) carrier.send('canvas-state', state)
  })
  bpm.onStateChange(i => { if (!host.isDestroyed()) host.webContents.send('state', i) })
  bpm.onRemoved(id => { if (!host.isDestroyed()) host.webContents.send('removed', id) })
  bpm.onInteracted(id => { if (!host.isDestroyed()) host.webContents.send('interacted', id) })
  bpm.onElementPickerEvent(e => { if (!host.isDestroyed()) host.webContents.send('picker', e) })
  bpm.onOpenRequested((i, target, reason) => target.webContents.send('open', i, reason))
  ipcMain.handle('fixture-browser', async (_event, method: string, ...args: any[]) => {
    if (method === 'create') { lastId = bpm.createForSession('sess-a', { show: false, allowReuseManual: false, workspaceId: 'ws-a' }); return lastId }
    if (method === 'list') return bpm.listInstances()
    if (method === 'embed') return bpm.embedInstance(args[0], host, args[1])
    if (method === 'destroy') return bpm.requestDestroy(args[0])
    if (method === 'unembed') return bpm.unembedInstance(args[0])
    if (method === 'focus') return bpm.focus(args[0], host)
    return (bpm as any)[method]?.(...args)
  })
  ipcMain.handle('fixture-canvas', (e, method: string, ...args: any[]) => {
    if (method === 'embed') return canvas.embed(args[0], args[1], host, 'ws-a', args[2])
    if (method === 'release') return canvas.releaseForHost(e.sender.id)
    if (method === 'detachToPopup') return canvas.detachToPopup(args[0], args[1], 'ws-a')
    if (!BASELINE) canvas.assertOwner(args[0], e.sender.id, 'ws-a')
    return (canvas as any)[method]?.(...args)
  })
  ipcMain.handle('fixture-stub', (e, name: string, args: any[]) => {
    if (name === 'registerGenUiCard') { const verdict = getUiCardRegistry().registerCard({ ...args[0], hostWebContentsId: e.sender.id }); if (verdict.ok) registryCalls++; return verdict }
    if (name === 'unregisterGenUiCard') return getUiCardRegistry().unregisterCard(args[0].sessionId, args[0].cardId)
    return name === 'getSystemTheme' ? 'light' : name === 'getColorTheme' ? 'default' : []
  })
  host.show()
  await host.loadFile(join(BUILD, 'pages', 'host', 'host.html'))
  await until(() => js('Boolean(window.__harness?.ready)'))
  await browserJourney()
  await fileJourney()
  if (BASELINE) await baselineCanvasJourney(); else await canvasJourney()
}
process.on('uncaughtException', error => { (result.uncaughtExceptions ??= []).push(String(error.stack ?? error)); if (!BASELINE) void finish(1, error) })
let finishing = false
const timer = setTimeout(() => finish(1, 'global timeout'), 120000)
async function finish(code: number, error?: unknown) {
  if (finishing) return
  finishing = true
  clearTimeout(timer)
  if (error) result.error = String((error as any)?.stack ?? error)
  restoreCarrier?.()
  for (const release of [() => canvas?.destroyAll(), () => bpm?.destroyAll(), () => { if (host && !host.isDestroyed()) host.destroy() }, () => server?.close()]) { try { release() } catch (e) { (result.cleanupErrors ??= []).push(String(e)) } }
  for (const window of BrowserWindow.getAllWindows()) { try { if (!window.isDestroyed()) window.destroy() } catch (error) { (result.cleanupErrors ??= []).push(String(error)) } }
  result.endedAt = new Date().toISOString()
  result.cleanup = { auxiliaryMappings: auxiliary.size, remainingWindows: BrowserWindow.getAllWindows().length }
  writeFileSync(join(OUT, 'runtime.json'), JSON.stringify(result, null, 2))
  console.log(`CHECKS ${result.checks.filter((c: any) => c.ok).length}/${result.checks.length}`)
  app.exit(code)
}
main().then(() => finish(!BASELINE && result.checks.some((c: any) => !c.ok) ? 1 : 0)).catch(e => finish(1, e))
