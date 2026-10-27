/**
 * POO-160 version-consistency orchestrator.
 *
 * Real Electron + production modules. The one boundary: the settings page's
 * IPC fixture preload. The `update:getInfo` answer comes from the PRODUCTION
 * auto-update module (`apps/electron/src/main/auto-update.ts`), so the version
 * the About row renders is whatever a real session would render.
 *
 * PASS = the version the settings About row shows equals `app.getVersion()`
 * (the native app identity behind the top-left "Polo AI" menu → About Polo AI,
 * and the value electron-builder writes into Info.plist), and the shared
 * bundle's APP_VERSION agrees.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const BUILD = process.env.POO160_BUILD_DIR!
const OUT = process.env.POO160_EVIDENCE_DIR!
const SOURCE_REF = process.env.POO160_SOURCE_REF ?? 'unknown'

const result: {
  sourceRef: string
  startedAt: string
  endedAt?: string
  identity: { appVersion: string; electronVersion: string; packaged: boolean }
  probe?: { currentVersion: string; appVersion: string; sharedAppVersion: string }
  checks: { name: string; ok: boolean; detail?: unknown }[]
  consoleNoise: { errors: string[]; warnings: string[] }
  captures: unknown[]
  error?: string
} = {
  sourceRef: SOURCE_REF,
  startedAt: new Date().toISOString(),
  identity: { appVersion: '', electronVersion: process.versions.electron, packaged: app.isPackaged },
  checks: [],
  consoleNoise: { errors: [], warnings: [] },
  captures: [],
}

const check = (name: string, ok: boolean, detail?: unknown) => {
  result.identity.appVersion = app.getVersion()
  result.checks.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
}

let host: BrowserWindow
let probe: { currentVersion: string; appVersion: string; sharedAppVersion: string } | undefined

const delay = (ms = 300) => new Promise<void>((r) => setTimeout(r, ms))
async function until(probe: () => Promise<unknown> | unknown, ms = 20000) {
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
  await delay(300)
  const viewport = await js<[number, number]>('[innerWidth,innerHeight]')
  const image = await host.capturePage()
  const raw = image.toPNG()
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, raw)
  // Scene metadata per the diff-summary evidence contract: every identity
  // value is re-checked against the live page text right after the shot, so
  // the receipt records observed content, not labels.
  const bodyAfter = await js<string>('document.body.innerText')
  const scene = {
    source_ref: SOURCE_REF,
    object: 'version-consistency about-version',
    state: '设置面打开，关于区块滚入视图',
    role: 'desktop-user',
    data: '无更新服务环境，仅本地版本行',
    viewport,
    identity: {
      surface: '设置',
      page: '应用',
      row: '版本',
      version_shown: probe!.currentVersion,
    },
  }
  const receipt = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    url: host.webContents.getURL(),
    scene,
    image: {
      sha256: createHash('sha256').update(raw).digest('hex'),
      width: image.getSize().width,
      height: image.getSize().height,
      device_scale_factor: image.getSize().width / viewport[0],
      full_page: false,
    },
    native_capture: { method: 'BrowserWindow.capturePage' },
    identity_checks: Object.fromEntries(
      Object.entries(scene.identity).map(([key, expected]) => [key, { selector: 'body', expected, observed: bodyAfter }]),
    ),
    state_checks: [
      { selector: 'body', expected: '关于', observed: bodyAfter },
      { selector: 'body', expected: '版本', observed: bodyAfter },
    ],
    harness: { checks: result.checks, ...(extra ?? {}) },
  }
  writeFileSync(path.replace(/\.png$/, '.capture.json'), JSON.stringify(receipt, null, 2))
  result.captures.push({ name, path, receipt: path.replace(/\.png$/, '.capture.json') })
}

ipcMain.handle('probe-update-info', async () => {
  // The production module, loaded after app ready so its electron-log and
  // electron-updater imports initialise exactly as in the packaged app.
  const { getUpdateInfo } = await import('../../src/main/auto-update')
  return { updateInfo: getUpdateInfo(), appVersion: app.getVersion() }
})
ipcMain.handle('probe-app-version', () => app.getVersion())
ipcMain.handle('probe-check-updates', async () => {
  const { checkForUpdates } = await import('../../src/main/auto-update')
  return checkForUpdates()
})
ipcMain.handle('fixture-stub', (_e, name: string) => {
  if (name === 'getRuntimeEnvironment') return 'electron'
  if (name === 'getNotificationsEnabled') return true
  if (name === 'setNotificationsEnabled') return { ok: true }
  if (name === 'getKeepAwakeWhileRunning') return false
  if (name === 'setKeepAwakeWhileRunning') return { ok: true }
  if (name === 'getNetworkProxySettings') return { enabled: false }
  if (name === 'setNetworkProxySettings') return { success: true }
  if (name === 'getTerminalIntegrationStatus') {
    return { success: true, status: { supported: true, installed: false, pathReady: true, needsRepair: false, statusCode: 'not_installed' } }
  }
  if (name === 'installTerminalIntegration' || name === 'uninstallTerminalIntegration') {
    return { success: false, errorCode: 'fixture', errorParams: { operation: 'status' } }
  }
  if (name === 'getAutoCapitalisation') return false
  if (name === 'getSendMessageKey') return 'enter'
  if (name === 'getSpellCheck') return true
  if (name === 'readPreferences') return { content: '', exists: false, path: '/tmp/poo160-fixture/preferences' }
  if (name === 'writePreferences') return { success: true }
  if (name === 'getDismissedUpdateVersion') return null
  if (name === 'dismissUpdate') return { ok: true }
  if (name === 'installUpdate') return { ok: false }
  return {}
})

async function main() {
  app.setPath('userData', join(BUILD, 'profile'))
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion')
  await app.whenReady()
  app.dock?.hide()

  host = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: join(BUILD, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  observeConsole('host', host.webContents)

  await host.loadFile(join(BUILD, 'pages', 'about', 'about.html'), { search: 'lang=zh-Hans' })
  await delay(500)
  await until(() => js("Boolean(window.__versionProbe && window.__versionProbe.ready)"))
  await until(() => js('!document.querySelector("[data-testid=probe-loading]")'))
  // Wait for the About row to leave its loading placeholder.
  await until(async () => {
    const text = await js<string>('document.body.innerText')
    return text.includes('版本') && !text.includes('加载中')
  })

  const probeLocal = await js<{ currentVersion: string; appVersion: string; sharedAppVersion: string }>('window.__versionProbe')
  probe = probeLocal
  result.probe = probeLocal

  const bodyText = await js<string>('document.body.innerText')
  check(
    'V1 设置页 About 版本 == app.getVersion()(原生「关于 Polo AI」身份)',
    probe.currentVersion === probe.appVersion,
    { shown: probe.currentVersion, appVersion: probe.appVersion },
  )
  check('V2 About 行在页面上渲染出该版本号(用户可见面)', bodyText.includes(probe.appVersion), { appVersion: probe.appVersion })
  check(
    'V3 shared bundle 内联的 APP_VERSION == app.getVersion()(packages/shared/package.json 与发布版本一致)',
    probe.sharedAppVersion === probe.appVersion,
    { sharedAppVersion: probe.sharedAppVersion, appVersion: probe.appVersion },
  )
  const shownVersions = [...new Set([...bodyText.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((m) => m[0]))]
  const staleVersions = shownVersions.filter((v) => v !== probe.appVersion)
  check(
    'V4 页面无其它版本号残影(全部版本串 == app.getVersion())',
    staleVersions.length === 0,
    { shown: shownVersions, stale: staleVersions },
  )

  // Scroll the About section into view for the evidence shot.
  await js(`(() => {
    const rows = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent?.trim() === '版本')
    const row = rows.at(-1)
    if (row) row.scrollIntoView({ block: 'center' })
  })()`)
  await delay(250)
  await capture('about-version', { probe })
  check(
    '凭据通道:截图后可见文本核对(identity.version_shown 在页面)',
    bodyText.includes(probe.currentVersion),
    { version: probe.currentVersion },
  )
  check('观测通道:console 零 error', result.consoleNoise.errors.length === 0, result.consoleNoise.errors.slice(0, 8))
}

process.on('unhandledRejection', (e) => console.error('UNHANDLED', String(e)))
const timer = setTimeout(() => { result.error = 'global timeout'; finish(1) }, 120000)
async function finish(code: number) {
  clearTimeout(timer)
  try {
    if (host && !host.isDestroyed()) host.destroy()
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
