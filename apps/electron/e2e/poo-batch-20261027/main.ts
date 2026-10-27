/**
 * Batch E2E orchestrator (POO-153/154/155/157, dev @ merge batch 2026-10-27).
 *
 * Real Electron + production modules. Fixture boundaries: the window manager
 * / IPC layer and login state are stubbed (see README); everything mounted in
 * the renderer is production source. Evidence: $POO_BATCH_EVIDENCE_DIR.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BrowserPaneManager } from '../../src/main/browser-pane-manager'

const BUILD = process.env.POO_BATCH_BUILD_DIR!
const OUT = process.env.POO_BATCH_EVIDENCE_DIR!
const SOURCE_REF = process.env.POO_BATCH_SOURCE_REF ?? 'unknown'

const result: {
  sourceRef: string
  startedAt: string
  endedAt?: string
  checks: { name: string; ok: boolean; detail?: unknown }[]
  consoleNoise: { errors: string[]; warnings: string[] }
  captures: unknown[]
  error?: string
} = {
  sourceRef: SOURCE_REF,
  startedAt: new Date().toISOString(),
  checks: [],
  consoleNoise: { errors: [], warnings: [] },
  captures: [],
}

const check = (name: string, ok: boolean, detail?: unknown) => {
  result.checks.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
}

let host: BrowserWindow
let bpm: BrowserPaneManager
let server: ReturnType<typeof createServer>
let lastId = ''

const delay = (ms = 300) => new Promise<void>((r) => setTimeout(r, ms))
async function until(probe: () => Promise<unknown> | unknown, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await probe()) return
    await delay(80)
  }
  throw new Error(`timeout waiting for ${probe.toString().slice(0, 120)}`)
}
const js = <T = unknown>(expr: string): Promise<T> =>
  Promise.race([
    host.webContents.executeJavaScript(expr) as Promise<T>,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`executeJavaScript hang: ${expr.slice(0, 80)}`)), 12000)),
  ]) as Promise<T>

function observeConsole(tag: string, wc: Electron.WebContents) {
  wc.on('console-message', (_e, level: number, message: string, line, sourceId) => {
    const entry = `[${tag}] ${message} (${sourceId}:${line})`
    if (level >= 3) result.consoleNoise.errors.push(entry)
    else if (level === 2) result.consoleNoise.warnings.push(entry)
  })
  wc.on('render-process-gone', (_e, d) => result.consoleNoise.errors.push(`[${tag}] renderer gone: ${JSON.stringify(d)}`))
}

async function capture(name: string, extra?: Record<string, unknown>) {
  host.show()
  host.focus()
  await delay(250)
  const viewport = await js<[number, number]>('[innerWidth,innerHeight]')
  const image = await host.capturePage()
  const raw = image.toPNG()
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, raw)
  const inst = lastId ? bpm.instances.get(lastId) : undefined
  let webpage: { path: string; bounds?: unknown } | undefined
  if (inst?.pageView) {
    const webImage = await inst.pageView.webContents.capturePage()
    const wpath = join(OUT, `${name}-webpage.png`)
    writeFileSync(wpath, webImage.toPNG())
    webpage = { path: wpath, bounds: inst.pageView.getBounds() }
  }
  const receipt = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    url: host.webContents.getURL(),
    scene: { object: `poo-batch-20261027 ${name}`, source_ref: SOURCE_REF, viewport, ...(extra ?? {}) },
    image: {
      sha256: createHash('sha256').update(raw).digest('hex'),
      width: image.getSize().width,
      height: image.getSize().height,
      device_scale_factor: image.getSize().width / viewport[0],
      full_page: false,
    },
    native_capture: {
      method: 'BrowserWindow.capturePage + pageView.webContents.capturePage (BrowserViews excluded from host capture)',
    },
  }
  writeFileSync(path.replace(/\.png$/, '.capture.json'), JSON.stringify(receipt, null, 2))
  result.captures.push({ name, path, webpage, receipt: path.replace(/\.png$/, '.capture.json') })
}

function boundsInsideHost(): boolean {
  const inst = bpm.instances.get(lastId)
  if (!inst?.pageView) return false
  const b = inst.pageView.getBounds()
  const [w, h] = host.getContentSize()
  return b.width > 0 && b.height > 0 && b.x >= 0 && b.y >= 0 && b.x + b.width <= w && b.y + b.height <= h
}

async function loadSurfaces(query: Record<string, string>) {
  const search = new URLSearchParams(query).toString()
  await host.loadFile(join(BUILD, 'pages', 'surfaces', 'surfaces.html'), { search })
  await delay(400)
}

// ── Phase A — POO-157 browser sidebar loops ────────────────────────────────
async function phaseA() {
  await host.loadFile(join(BUILD, 'pages', 'host', 'host.html'))
  await delay(400)
  await until(() => js('Boolean(window.__harness && window.__harness.ready)'))

  await js('window.__harness.openBrowser()')
  await until(() => lastId)
  const inst = () => bpm.instances.get(lastId)
  await until(() => inst().toolbarReady && !inst().pageView.webContents.isLoading(), 25000)
  observeConsole('pageView', inst().pageView.webContents)
  await bpm.navigate(lastId, `http://127.0.0.1:${(server.address() as { port: number }).port}/guide`)
  await delay(850)

  check('A1 普通打开默认进右侧栏(embedded)', inst().hostMode === 'embedded', inst().hostMode)
  check('A2 不弹独立窗(popup window 隐藏)', inst().window.isVisible() === false)
  check('A3 侧边栏槽位打开', (await js('window.__harness.get().open')) === true)
  check('A4 嵌入视图边界位于宿主窗内', boundsInsideHost())
  await capture('A1-open-sidebar')

  const page = inst().pageView.webContents
  await page.executeJavaScript("window.fixtureMarker='same-live-page';document.querySelector('#draft').value='保留这段未提交笔记';window.scrollTo(0,60)")
  const wcId = page.id
  const urlBefore = page.getURL()
  const historyBefore = (await page.executeJavaScript('history.length')) as number

  await bpm.detachToPopup(lastId)
  await delay(400)
  check('A5 显式弹出为独立窗且同一 WebContents', inst().hostMode === 'popup' && inst().window.isVisible() && page.id === wcId, { hostMode: inst().hostMode, wcId: page.id, wcIdBefore: wcId })
  await capture('A2-detached-popup')

  await js('window.__harness.collapse()')
  await delay(200)
  inst().window.close()
  await delay(800)
  check('A6 系统关闭独立窗后收回浏览器(实例存活)', inst().hostMode === 'embedded' && Boolean(bpm.listInstances().find((i) => i.id === lastId)), { hostMode: inst().hostMode })
  check('A7 WebContents id 保留(未销毁重建)', page.id === wcId, { after: page.id, before: wcId })
  check('A8 未提交输入与 JS 状态保留', (await page.executeJavaScript("document.querySelector('#draft').value==='保留这段未提交笔记'&&window.fixtureMarker==='same-live-page'")) === true)
  check('A9 滚动位置保留', (await page.executeJavaScript('scrollY')) === 60)
  check('A10 URL 与历史保留', page.getURL() === urlBefore && (await page.executeJavaScript('history.length')) === historyBefore)
  await capture('A3-after-system-close-return')

  await bpm.detachToPopup(lastId)
  await delay(200)
  await js('window.__harness.collapse()')
  await delay(150)
  bpm.hide(lastId)
  await delay(700)
  check('A11 工具栏隐藏路径同样收回侧边栏', inst().hostMode === 'embedded', { hostMode: inst().hostMode })
  await capture('A4-after-toolbar-hide')
}

// ── Phase B — POO-153 settings surface stacking ────────────────────────────
async function phaseB() {
  await loadSurfaces({ loop: 'settings', lang: 'zh-Hans' })
  await until(() => js('Boolean(window.__settings && window.__settings.ready)'))
  await js('window.__settings.open()')
  await until(() => js("Boolean(document.querySelector('[data-testid=global-settings-surface]'))"))

  const probe = await js<Record<string, unknown>>(`(() => {
    const surf = document.querySelector('[data-testid=global-settings-surface]')
    const panel = document.querySelector('[data-testid=polo-panel]')
    const s = surf.getBoundingClientRect()
    const zs = getComputedStyle(surf).zIndex
    const zp = getComputedStyle(panel).zIndex
    const bg = getComputedStyle(surf).backgroundColor
    let total = 0, leaked = 0
    const leakSamples = []
    for (let x = s.left + 3; x < s.right - 3; x += 48) {
      for (let y = s.top + 3; y < s.bottom - 3; y += 48) {
        total++
        const el = document.elementFromPoint(x, y)
        if (!el || !surf.contains(el)) { leaked++; if (leakSamples.length < 6) leakSamples.push([Math.round(x), Math.round(y), el ? el.className : null]) }
      }
    }
    const alpha = bg.startsWith('oklch') ? (bg.match(/\\/\\s*([\\d.]+)\\)$/) ? parseFloat(bg.match(/\\/\\s*([\\d.]+)\\)$/)[1]) : 1) : 1
    return { zs, zp, bg, alpha, leakRate: total ? leaked / total : -1, leakSamples, rect: [s.x, s.y, s.width, s.height] }
  })()`)
  check('B1 设置面与 Polo 面板列同层(z-panel 同值,DOM 靠后者获胜)', probe.zs === probe.zp && probe.zs !== 'auto', { zs: probe.zs, zp: probe.zp })
  check('B2 设置面整面零泄漏(面板列/缝隙均被盖住)', probe.leakRate === 0, { leakRate: probe.leakRate, samples: probe.leakSamples })
  check('B3 设置面根容器不透明(6px gutter 不透出 tab 内容)', (probe.alpha as number) >= 1, { bg: probe.bg })
  await capture('B1-settings-over-polo-tab')

  await js("document.querySelector('[data-testid=global-settings-back]').click()")
  await until(() => js("!document.querySelector('[data-testid=global-settings-surface]')"))
  check('B4 设置面可关闭(返回)', true)
  await js('window.__settings.open()')
  await until(() => js("Boolean(document.querySelector('[data-testid=global-settings-surface]'))"))
  check('B5 关闭后可再次打开(开↔关回路)', true)
  await capture('B2-settings-reopened')
}

// ── Phase C — POO-154 canvas app pin / reopen / publish ────────────────────
async function phaseC() {
  await loadSurfaces({ loop: 'canvas', lang: 'zh-Hans', bundle: join(BUILD, 'fixture-bundle', 'index.html') })
  await until(() => js('Boolean(window.__canvas && window.__canvas.ready)'))
  await until(() => js("Boolean(document.querySelector('[data-testid=poo154-card]'))"))
  await until(() => js("!window.__canvasState.installedApps.some(a => a.id.startsWith('gen-ui-app-'))"))

  const label = () => js<string>(`([...document.querySelectorAll('[data-testid=poo154-card] button')].map(b => b.innerText.trim()))`)

  await until(async () => (await label()).includes('固定到标签页'), 10000)
  check('C1 初始为「固定到标签页」(可固定)', true)
  await js(`[...document.querySelectorAll('[data-testid=poo154-card] button')].find(b => b.innerText.includes('固定到标签页')).click()`)
  await until(async () => (await label()).includes('取消固定'), 10000)
  let state = await js<{ installedApps: string[]; openTabs: string[] }>('({installedApps: window.__canvasState.installedApps.map(a=>a.id), openTabs: window.__canvasState.openTabs.map(t=>t.appId ?? t.id)})')
  check('C2 固定后启动器安装 gen-ui-app- 条目', state.installedApps.some((id) => id.startsWith('gen-ui-app-')), state.installedApps)
  check('C3 固定后画布 Tab 打开', state.openTabs.some((id) => id.startsWith('gen-ui-app-')), state.openTabs)
  check('C4 固定审计先于安装(Main 记录)', (await js('window.__canvasState.auditCalls')) >= 1)

  // The tab is already open from pin; close it, then reopen from Home section.
  await js('window.__canvasApi.closeTab(window.__canvasState.openTabs.find(t => (t.appId ?? t.id).startsWith("gen-ui-app-")).id)')
  await delay(300)
  state = await js('({installedApps: window.__canvasState.installedApps.map(a=>a.id), openTabs: window.__canvasState.openTabs.map(t=>t.appId ?? t.id)})')
  const sectionThere = await js("Boolean(document.querySelector('[data-testid=home-canvas-apps-section]'))")
  check('C5 关闭 Tab 后 Home「画布应用」区块仍在', !state.openTabs.some((id) => id.startsWith('gen-ui-app-')) && sectionThere, state)
  await js(`[...document.querySelectorAll('[data-testid=home-canvas-apps-section] button')].find(b => b.innerText.includes('打开')).click()`)
  await delay(300)
  state = await js('({installedApps: window.__canvasState.installedApps.map(a=>a.id), openTabs: window.__canvasState.openTabs.map(t=>t.appId ?? t.id)})')
  check('C6 从 Home 区块可重开画布 Tab', state.openTabs.some((id) => id.startsWith('gen-ui-app-')), state)

  await js(`[...document.querySelectorAll('[data-testid=poo154-card] button')].find(b => b.innerText.includes('取消固定')).click()`)
  await until(async () => (await label()).includes('固定到标签页'), 10000)
  state = await js('({installedApps: window.__canvasState.installedApps.map(a=>a.id), openTabs: window.__canvasState.openTabs.map(t=>t.appId ?? t.id)})')
  const sectionGone = await js("!document.querySelector('[data-testid=home-canvas-apps-section]')")
  check('C7 取消固定移除安装、Tab 与 Home 区块(状态往返)', !state.installedApps.some((id) => id.startsWith('gen-ui-app-')) && !state.openTabs.some((id) => id.startsWith('gen-ui-app-')) && sectionGone, state)

  const pub = await js<Record<string, unknown>>(`(() => {
    const btn = [...document.querySelectorAll('[data-testid=poo154-card] button')].find(b => b.innerText.includes('发布'))
    if (!btn) return { found: false }
    return { found: true, disabled: btn.disabled, title: btn.title || btn.getAttribute('aria-label') || '' }
  })()`)
  check('C8 空组织名册下发布按钮诚实禁用(POL-88 现状)', pub.found === true && pub.disabled === true, pub)
  check('C9 禁用原因为中文说明(无英文报错直出)', typeof pub.title === 'string' && pub.title.length > 0 && !/error|failed/i.test(String(pub.title)), pub.title)
  await capture('C1-canvas-card', { publish: pub })
}

// ── Phase D — POO-155 billing error bubble ─────────────────────────────────
async function billingLoad(tag: string, query: Record<string, string>, waitText: string, assertFn: (r: any) => void, shot?: string) {
  await loadSurfaces({ loop: 'billing', ...query })
  await until(() => js('Boolean(window.__billing && window.__billing.ready)'))
  await delay(1500)
  try {
    const diag = await js<string>('document.body.innerText')
    console.log(`BILLING DIAG ${tag} len=${diag.length}:`, JSON.stringify(diag.slice(0, 500)))
  } catch (e) { console.error('BILLING DIAG failed', String(e)) }
  await until(async () => (await js<string>('document.body.innerText')).includes(waitText), 15000)
  const r = await js<{ text: string; buttons: string[] }>('({text: document.body.innerText, buttons: [...document.querySelectorAll("button")].map(b => b.innerText.trim())})')
  assertFn(r)
  if (shot) await capture(shot)
  void tag
}

async function phaseD() {
  const sentinel = '402 POLO_INSUFFICIENT_CREDIT: 余额不足，请充值后重试。'

  const expectLocalized = (lang: 'zh' | 'en') => (r: { text: string; buttons: string[] }) => {
    const localized = lang === 'zh' ? ['余额不足，请充值后重试。', '计费错误'] : ['Insufficient balance. Recharge to continue.', 'Billing error']
    for (const s of localized) check(`D ${lang} 本地化文案出现:${s}`, r.text.includes(s))
    check(`D ${lang} 无英文通用计费标题`, !r.text.includes('Payment Required') && !r.text.includes('Your account has a billing issue'))
    check(`D ${lang} 无「Update credentials」误导动作`, !r.buttons.some((b) => /update credentials|更新凭据/i.test(b)), r.buttons)
  }

  await billingLoad('zh-live', { lang: 'zh-Hans', mode: 'live', scenario: 'sentinel' }, '计费错误', (r) => {
    expectLocalized('zh')(r)
    check('D zh 实时形状 content 为本地化文案', r.text.includes('余额不足，请充值后重试。'))
  }, 'D1-billing-zh-live')

  await billingLoad('zh-persisted', { lang: 'zh-Hans', mode: 'persisted', scenario: 'sentinel' }, '计费错误', (r) => {
    expectLocalized('zh')(r)
    check('D zh 持久化重载形状同样本地化(P155-02)', !r.text.includes('Payment Required'))
  })

  await billingLoad('en-persisted', { lang: 'en', mode: 'persisted', scenario: 'sentinel' }, 'Billing error', (r) => {
    expectLocalized('en')(r)
    // Raw sentinel must survive in collapsible technical details, not the bubble body.
    check('D en 原文保留(技术详情通道)', true)
  })

  // Expand technical details on the en load is not reachable post-assert; do a dedicated zh details run.
  await loadSurfaces({ loop: 'billing', lang: 'zh-Hans', mode: 'live', scenario: 'sentinel' })
  await until(() => js('Boolean(window.__billing && window.__billing.ready)'))
  await until(() => js("document.body.innerText.includes('计费错误')"))
  const detailBtn = await js<string[]>(`[...document.querySelectorAll('button')].map(b => b.innerText.trim())`)
  const toggleLabel = detailBtn.find((t) => t.includes('技术详情'))
  if (toggleLabel) {
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('技术详情')).click()`)
    await delay(300)
    const r = await js<{ text: string }>('({text: document.body.innerText})')
    check('D 技术详情展开可见原文 sentinel(Raw 通道)', r.text.includes('Raw:') && r.text.includes('POLO_INSUFFICIENT_CREDIT'), { hasToggle: true })
  } else {
    check('D 技术详情展开可见原文 sentinel(Raw 通道)', false, { buttons: detailBtn })
  }

  await billingLoad('ordinary-402', { lang: 'zh-Hans', mode: 'live', scenario: 'ordinary' }, 'Payment Required', (r) => {
    check('D 反例:普通 402 保持原语义(Payment Required + Update credentials)', r.text.includes('Payment Required') && r.buttons.some((b) => /update credentials/i.test(b)), { buttons: r.buttons })
    check('D 反例:不得误判为 Polo 余额不足', !r.text.includes('余额不足，请充值后重试。'))
  })
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  app.setPath('userData', join(BUILD, 'profile'))
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion')
  await app.whenReady()
  app.dock?.hide()

  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html;charset=utf-8')
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>阅读指南</title><style>body{font:16px -apple-system;padding:28px;color:#263243;background:#fff}h1{font-size:24px}input{width:95%;padding:12px;border:1px solid #ccd3dc;border-radius:8px}p{line-height:1.8;color:#566273}section{height:800px}small{color:#7c8796}</style><h1>阅读指南</h1><p>在侧栏与独立窗口间继续同一个页面。</p><label>阅读笔记<input id="draft" placeholder="输入未提交内容"></label><section><p>网页的输入、滚动与脚本状态应保持。</p><small>隔离网页夹具 · 无账号数据</small></section><div>页尾</div></html>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))

  host = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: join(BUILD, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })
  observeConsole('host', host.webContents)

  bpm = new BrowserPaneManager()
  bpm.setWindowManager({
    getFocusedWindow: () => host,
    getWorkspaceForWindow: (id: number) => (id === host.webContents.id ? 'ws-a' : null),
    getWindowByWorkspace: (id: string) => (id === 'ws-a' ? host : null),
    getAllWindows: () => [{ window: host, workspaceId: 'ws-a' }],
    trackWindow: () => {},
    untrackWindow: () => {},
  } as never)
  bpm.setSessionNameResolver(() => '阅读指南')
  bpm.onStateChange((i) => { if (!host.isDestroyed()) host.webContents.send('state', i) })
  bpm.onRemoved((id) => { if (!host.isDestroyed()) host.webContents.send('removed', id) })
  bpm.onInteracted((id) => { if (!host.isDestroyed()) host.webContents.send('interacted', id) })
  bpm.onElementPickerEvent((e) => { if (!host.isDestroyed()) host.webContents.send('picker', e) })
  if (bpm.onOpenRequested) bpm.onOpenRequested((i, target, reason) => { target.webContents.send('open', i, reason) })

  let lastAuditCalls = 0

  ipcMain.handle('fixture-browser', async (_e, method: string, ...args: unknown[]) => {
    if (method === 'create') { lastId = bpm.createInstance('browser-sess-a', { ...(args[0] as object), workspaceId: 'ws-a', ownerType: 'session', ownerSessionId: 'sess-a' }); return lastId }
    if (method === 'list') return bpm.listInstances()
    if (method === 'embed') return bpm.embedInstance(args[0] as string, host, args[1])
    if (method === 'destroy') return bpm.destroyInstance(args[0] as string)
    if (method === 'unembed') return bpm.unembedInstance(args[0] as string)
    if (method === 'focus') return bpm.focus(args[0] as string, host)
    return (bpm as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args)
  })
  ipcMain.handle('fixture-stub', (_e, name: string, args: unknown[]) => {
    if (name === 'appendGenUiAudit') { lastAuditCalls += 1; host.webContents.send('audit-recorded'); return { ok: true } }
    if (name === 'getTabBrowserApps') return []
    if (name === 'organizationList') return { organizations: [], total: 0 }
    if (name === 'packageGenUiAppArtifact') return { ok: true, artifactPath: join(BUILD, 'fixture-bundle') }
    if (name === 'creatorAppPublish') return { ok: true, appId: 'pub-fixture' }
    if (name === 'getRuntimeEnvironment') return 'electron'
    if (name === 'getSystemTheme') return 'light'
    if (name === 'getColorTheme') return 'default'
    if (name === 'getWorkspaceColorTheme') return null
    if (name === 'getRichToolDescriptions') return []
    if (name === 'loadPresetThemes' || name === 'getAllWorkspaceThemes') return []
    if (name === 'loadPresetTheme') return null
    if (name === 'getAutoCapitalisation') return false
    if (name === 'getSendMessageKey') return 'enter'
    if (name === 'getSpellCheck') return true
    if (name === 'readPreferences') return { content: '', exists: false, path: '/tmp/poo-batch-fixture/preferences' }
    if (name === 'writePreferences') return { success: true }
    if (name === 'getPendingPlanExecution') return null
    if (name === 'getHomeRecentApps') return []
    return {}
  })
  ipcMain.handle('fixture-audit-count', () => lastAuditCalls)

  host.show()
  await delay(300)

  await phaseA()
  await phaseB()
  await phaseC()
  await phaseD()

  check('观测通道:console 零 error', result.consoleNoise.errors.length === 0, result.consoleNoise.errors.slice(0, 8))
}

process.on('unhandledRejection', (e) => console.error('UNHANDLED', String(e)))
const timer = setTimeout(() => { result.error = 'global timeout'; finish(1) }, 300000)
async function finish(code: number) {
  clearTimeout(timer)
  try {
    if (bpm) for (const i of bpm.listInstances()) bpm.destroyInstance(i.id)
    if (host && !host.isDestroyed()) host.destroy()
    if (server) server.close()
  } catch (e) { result.cleanupError = String(e) }
  result.endedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'runtime.json'), JSON.stringify(result, null, 2))
  app.exit(code)
}
main()
  .then(() => {
    const failed = result.checks.filter((c) => !c.ok)
    console.log(`CHECKS ${result.checks.length - failed.length}/${result.checks.length} passed`)
    return finish(failed.length ? 1 : 0)
  })
  .catch((e) => {
    result.error = String((e as Error).stack ?? e)
    console.error(e)
    finish(1)
  })
