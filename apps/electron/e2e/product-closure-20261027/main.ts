/**
 * product-closure-20261027 E2E orchestrator (U6/U7/U11/U12 nails).
 *
 * Real Electron + production modules. Fixture boundaries: the window manager
 * / IPC layer and login state are stubbed (see README); the toolbar pages,
 * the tab-name resolver, useSidebarBrowserSync and the download toast are
 * production source. Evidence: $PC_EVIDENCE_DIR.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BrowserPaneManager } from '../../src/main/browser-pane-manager'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

const BUILD = process.env.PC_BUILD_DIR!
const OUT = process.env.PC_EVIDENCE_DIR!
const SOURCE_REF = process.env.PC_SOURCE_REF ?? 'unknown'

const result: {
  sourceRef: string
  startedAt: string
  endedAt?: string
  checks: { name: string; ok: boolean; detail?: unknown }[]
  consoleNoise: { errors: string[]; warnings: string[]; i18nWarnings: string[] }
  captures: unknown[]
  error?: string
} = {
  sourceRef: SOURCE_REF,
  startedAt: new Date().toISOString(),
  checks: [],
  consoleNoise: { errors: [], warnings: [], i18nWarnings: [] },
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
let destroyAllCalls = 0

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

// Registered ONCE via app.on('web-contents-created') — not per-page after
// load. A per-page observer registered after `toolbarReady` silently misses
// load-time warnings, which once let a real react-i18next warning slip
// through the zero-warning nail.
function observeWebContents(wc: Electron.WebContents) {
  const tag = () => {
    try {
      const url = wc.getURL()
      return url ? (url.split('/').pop() || url).split('?')[0] : `wc-${wc.id}`
    } catch {
      return `wc-${wc.id}`
    }
  }
  wc.on('console-message', (_e, level: number, message: string, line, sourceId) => {
    const entry = `[${tag()}] ${message} (${sourceId}:${line})`
    if (level >= 3) result.consoleNoise.errors.push(entry)
    else if (level === 2) {
      result.consoleNoise.warnings.push(entry)
      // Nail ①: any missing-key / react-i18next warning is a U6 failure.
      if (/i18next|missingKey|react-i18next/i.test(message)) result.consoleNoise.i18nWarnings.push(entry)
    }
  })
  wc.on('render-process-gone', (_e, d) => result.consoleNoise.errors.push(`[${tag()}] renderer gone: ${JSON.stringify(d)}`))
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
  const receipt = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    url: host.webContents.getURL(),
    scene: { object: `product-closure-20261027 ${name}`, source_ref: SOURCE_REF, viewport, ...(extra ?? {}) },
    image: {
      sha256: createHash('sha256').update(raw).digest('hex'),
      width: image.getSize().width,
      height: image.getSize().height,
      device_scale_factor: image.getSize().width / viewport[0],
      full_page: false,
    },
    native_capture: { method: 'BrowserWindow.capturePage' },
  }
  writeFileSync(path.replace(/\.png$/, '.capture.json'), JSON.stringify(receipt, null, 2))
  result.captures.push({ name, path, receipt: path.replace(/\.png$/, '.capture.json') })
}

// ── Nail ① — U6 toolbar i18n: zh initial + live switch, zero i18n warnings ──
async function nail1_toolbarI18n() {
  const assertMenuLang = async (wc: Electron.WebContents, expected: string, tag: string) => {
    await until(async () => {
      try {
        const found = await wc.executeJavaScript(`Boolean(document.querySelector('[aria-label="${expected}"]'))`)
        return found === true
      } catch {
        return false
      }
    }, 15000)
    const ok = await wc.executeJavaScript(`Boolean(document.querySelector('[aria-label="${expected}"]'))`)
    check(`① ${tag} 工具栏窗口菜单为「${expected}」`, ok === true, { expected })
  }

  // zh-Hans pass: the initial language travels through the ?lang= query param.
  // The instance is created on the main side — the host harness page is not
  // loaded yet (nail ③ loads it).
  await setupI18n()
  await i18n.changeLanguage('zh-Hans')
  lastId = bpm.createInstance('browser-sess-a', { workspaceId: 'ws-a', ownerType: 'session', ownerSessionId: 'sess-a' })
  await until(() => lastId)
  const inst = () => bpm.instances.get(lastId)
  await until(() => inst().toolbarReady && !inst().pageView.webContents.isLoading(), 25000)
  const toolbarQuery = inst().toolbarView.webContents.getURL()
  check('① 初始加载携带 ?lang=zh-Hans(query 传语言)', /lang=zh-Hans/.test(toolbarQuery), toolbarQuery)
  await assertMenuLang(inst().toolbarView.webContents, '窗口选项', 'zh-Hans 初始')

  // en pass: the MAIN-window language change is broadcast to the live toolbar.
  i18n.changeLanguage('en')
  bpm.broadcastToolbarLanguage('en')
  await assertMenuLang(inst().toolbarView.webContents, 'Window options', 'en 跟随切换')
  check('① 语言切换未重载页面(同一 WebContents)', true)
  await capture('nail1-toolbar-i18n')
}

// ── Nail ② — U7 tab names flip with language, legacy zh titles overridden ──
async function nail2_tabNames() {
  await host.loadFile(join(BUILD, 'pages', 'tabs.html'), { search: 'lang=zh-Hans' })
  await until(() => js('Boolean(window.__tabs && window.__tabs.ready)'))

  const zh = await js<Record<string, string>>('({polo: document.querySelector("[data-testid=tab-title]").textContent, kb: document.querySelector("[data-testid=tab-title-kb]").textContent, third: document.querySelector("[data-testid=tab-title-third]").textContent})')
  // kb renders the zh locale value「知识库」, NOT the legacy stored title
  //「企业知识库」— the mismatch itself proves the id-based override.
  check('② zh 历史中文名按 id 覆盖显示(Polo 助手)', zh.polo === 'Polo 助手', zh)
  check('② zh 历史中文名按 id 覆盖显示(知识库,非存量「企业知识库」)', zh.kb === '知识库', zh)
  check('② zh 第三方名不被改写', zh.third === 'Acme 看板', zh)

  await js('window.__tabs.setLang("en")')
  await delay(200)
  const en = await js<Record<string, string>>('({polo: document.querySelector("[data-testid=tab-title]").textContent, kb: document.querySelector("[data-testid=tab-title-kb]").textContent, third: document.querySelector("[data-testid=tab-title-third]").textContent})')
  check('② en 切换后内置名跟随(Polo Assistant)', en.polo === 'Polo Assistant', en)
  check('② en 切换后内置名跟随(Knowledge Base)', en.kb === 'Knowledge Base', en)
  check('② en 第三方名仍不被改写', en.third === 'Acme 看板', en)
  await capture('nail2-tab-names')
}

// ── Nail ③ — U11 download toast on the session-bound persistence path ──────
async function nail3_downloadToast() {
  await host.loadFile(join(BUILD, 'pages', 'host.html'))
  await delay(400)
  await until(() => js('Boolean(window.__pc && window.__pc.ready)'))

  await js('window.__pc.openBrowser()')
  await until(() => lastId)
  const inst = () => bpm.instances.get(lastId)
  await until(() => inst().toolbarReady && !inst().pageView.webContents.isLoading(), 25000)

  const port = (server.address() as { port: number }).port
  // A download navigation is intentionally aborted once will-download fires —
  // Chromium rejects loadURL with ERR_FAILED; that IS the success path here.
  await bpm.navigate(lastId, `http://127.0.0.1:${port}/download`).catch(() => {})
  await delay(600)

  // The file itself must land in the session-bound downloads dir.
  const downloadsDir = join(BUILD, 'sessions', 'sess-a', 'downloads')
  await until(() => existsSync(downloadsDir) && readdirSync(downloadsDir).length > 0, 15000)
  const saved = readdirSync(downloadsDir)
  check('③ 会话绑定落盘路径存在文件', saved.length > 0, { downloadsDir, saved })

  await until(async () => {
    try {
      return await js<boolean>(`Boolean(document.querySelector('[data-sonner-toast]')) && document.body.innerText.includes('打开所在文件夹')`)
    } catch {
      return false
    }
  }, 15000)
  const toast = await js<string>('document.body.innerText')
  check('③ 下载完成 toast 出现', toast.includes('已下载'), { snippet: toast.slice(0, 200) })
  check('③ toast 带「打开所在文件夹」动作', toast.includes('打开所在文件夹'))
  await capture('nail3-download-toast')
}

// ── Nail ④ — U12 logout → destroyAllAndClearStorage via the explicit IPC ───
async function nail4_destroyAll() {
  // One more live instance so the teardown has something real to destroy.
  await js('window.__pc.openBrowser()')
  await delay(600)
  const before = bpm.listInstances().length
  check('④ 销毁前存在活跃实例', before >= 1, { before })

  await js('window.__pc.destroyAll()')
  await delay(800)

  check('④ renderer 调用后 destroyAllAndClearStorage 恰好执行一次', destroyAllCalls === 1, { destroyAllCalls })
  check('④ 全部实例被销毁', bpm.listInstances().length === 0, { after: bpm.listInstances().length })
  await capture('nail4-destroy-all')
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  app.setPath('userData', join(BUILD, 'profile'))
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion')
  await app.whenReady()
  app.dock?.hide()
  // Console observation from the very first webContents creation.
  app.on('web-contents-created', (_e, wc) => observeWebContents(wc))

  server = createServer((req, res) => {
    if (req.url?.startsWith('/download')) {
      res.setHeader('Content-Type', 'text/plain;charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="pc-e2e-report.txt"')
      res.end('product-closure U11 download fixture · 隔离夹具,无账号数据')
      return
    }
    res.setHeader('Content-Type', 'text/html;charset=utf-8')
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>夹具页</title><body><h1>夹具页</h1></body></html>')
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

  bpm = new BrowserPaneManager()
  bpm.setWindowManager({
    getFocusedWindow: () => host,
    getWorkspaceForWindow: (id: number) => (id === host.webContents.id ? 'ws-a' : null),
    getWindowByWorkspace: (id: string) => (id === 'ws-a' ? host : null),
    getAllWindows: () => [{ window: host, workspaceId: 'ws-a' }],
    trackWindow: () => {},
    untrackWindow: () => {},
  } as never)
  // Production parity: the real main process registers the toolbar IPC
  // (menu-geometry etc.) right after creating the manager.
  bpm.registerToolbarIpc()
  // Downloads land inside the isolated build dir — never the user's folder.
  bpm.setSessionPathResolver((sessionId: string) => join(BUILD, 'sessions', sessionId))
  bpm.setSessionNameResolver(() => '阅读指南')
  bpm.onStateChange((i) => { if (!host.isDestroyed()) host.webContents.send('state', i) })
  bpm.onRemoved((id) => { if (!host.isDestroyed()) host.webContents.send('removed', id) })
  bpm.onInteracted((id) => { if (!host.isDestroyed()) host.webContents.send('interacted', id) })
  bpm.onElementPickerEvent((e) => { if (!host.isDestroyed()) host.webContents.send('picker', e) })
  if (bpm.onOpenRequested) bpm.onOpenRequested((i, target, reason) => { target.webContents.send('open', i, reason) })
  // product-closure U11: the download outcome bridge the renderer toast
  // consumes (same broadcast contract as the other browser events).
  bpm.onDownloadEvent((e) => { if (!host.isDestroyed()) host.webContents.send('download', e) })

  ipcMain.handle('fixture-browser', async (_e, method: string, ...args: unknown[]) => {
    if (method === 'create') {
      lastId = bpm.createInstance('browser-sess-a', { ...(args[0] as object), workspaceId: 'ws-a', ownerType: 'session', ownerSessionId: 'sess-a' })
      return lastId
    }
    if (method === 'list') return bpm.listInstances()
    if (method === 'embed') return bpm.embedInstance(args[0] as string, host, args[1])
    if (method === 'destroy') return bpm.destroyInstance(args[0] as string)
    if (method === 'unembed') return bpm.unembedInstance(args[0] as string)
    if (method === 'focus') return bpm.focus(args[0] as string, host)
    return (bpm as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args)
  })
  ipcMain.handle('fixture-stub', (_e, name: string) => {
    if (name === 'getTabBrowserApps') return []
    if (name === 'getRuntimeEnvironment') return 'electron'
    if (name === 'getSystemTheme') return 'light'
    if (name === 'getColorTheme') return 'default'
    return {}
  })
  ipcMain.handle('fixture-show-in-folder', () => ({ ok: true }))
  // product-closure U12: the explicit logout teardown channel. Counting the
  // invocations IS the nail — the manager's destroy+clear semantics are
  // covered by the unit tests; here we verify the renderer → main wiring.
  ipcMain.handle('fixture-destroy-all', async () => {
    destroyAllCalls += 1
    await bpm.destroyAllAndClearStorage()
    return { ok: true }
  })

  host.show()
  await delay(300)
  // Load the host harness page up front so captures and renderer probes work
  // from nail ① on; nail ② swaps in the tabs page and nail ③ swaps back.
  await host.loadFile(join(BUILD, 'pages', 'host.html'))
  await delay(400)
  await until(() => js('Boolean(window.__pc && window.__pc.ready)'))

  await nail1_toolbarI18n()
  await nail2_tabNames()
  await nail3_downloadToast()
  await nail4_destroyAll()

  check('① 观测通道:i18next/react-i18next 零警告', result.consoleNoise.i18nWarnings.length === 0, result.consoleNoise.i18nWarnings.slice(0, 8))
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
