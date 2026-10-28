/**
 * POO-161 canvas-recovery harness main. Runs the REAL production data
 * pipeline — SessionManager + PiEventAdapter + handleGenerateApp + shared
 * jsonl read/write — under `cwd=/` (the Finder-launch condition that
 * triggered the POO-161 white-canvas bug), then renders the produced bundle
 * through the production GenUiAppCard (inline) and CanvasPaneCard (sidebar /
 * popout carrier) in real Electron windows with real <webview> guests.
 *
 * Phases (POO161_PHASE):
 *   create  — generate → persist → assert write-end integrity → craft the
 *             legacy cwd=/ corruption form → assert read-end recovery →
 *             render all entries → screenshots → evidence → exit 0.
 *   recover — RESTART simulation: fresh process re-reads the legacy-corrupted
 *             session.jsonl from disk through the production read path and
 *             renders it → screenshots → evidence → exit 0.
 *
 * Account login / AI-provider cloud calls are out of harness scope (see
 * README); the data + webview layers exercised here are the layers the
 * POO-161 fix changed.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import { webContents } from 'electron'
// Production modules under test — static imports so esbuild bundles the real
// sources into the harness main (runtime dynamic import of TS never works).
import { SessionManager, createManagedSession } from '../../../../packages/server-core/src/sessions/SessionManager'
import { PiEventAdapter } from '../../../../packages/shared/src/agent/backend/pi/event-adapter'
import { handleGenerateApp } from '../../../../packages/session-tools-core/src/handlers/generate-app'
import { readSessionMessages } from '../../../../packages/shared/src/sessions/jsonl'

// THE bug condition: a Finder launch runs with cwd=/, which made the old
// SessionManager rewrite /tmp/... protocol paths into ./tmp/....
process.chdir('/')

// esbuild compiles this module to CJS for Electron main, where import.meta is
// unavailable — __dirname is the stable path anchor in the compiled output.
const here = __dirname
const build = process.env.POO161_BUILD_DIR ?? '/tmp/poo161-canvas-recovery'
const evidence = process.env.POO161_EVIDENCE_DIR ?? join(build, 'evidence')
const phase = process.env.POO161_PHASE ?? 'create'
mkdirSync(evidence, { recursive: true })

const workspaceRoot = join(build, 'workspace')
const MAIN_SESSION = 'poo161-real-canvas'
const LEGACY_SESSION = 'poo161-legacy-corrupted'
const APP_HTML = '<!doctype html><html><body><h1>POO161 画布联调 App ready</h1><p>canvas-recovery harness bundle</p></body></html>'

async function main(): Promise<void> {
  app.getPath('userData') // touch before ready
  await app.whenReady()

  if (phase === 'create') await runCreate()
  else await runRecover()
}

type HarnessSessionManager = {
  sessions: Map<string, ManagedSession>
  processEvent: (session: ManagedSession, event: AgentEvent) => Promise<void>
  persistSession: (session: ManagedSession) => void
  flushSession: (id: string) => Promise<void>
  flushAllSessions: () => Promise<void>
}
type ManagedSession = { id: string; messages: unknown[]; messagesLoaded: boolean; workspace: unknown }

async function runCreate(): Promise<void> {
  const manager = new SessionManager()
  const workspace = { id: 'poo161', slug: 'poo161', name: 'poo161', rootPath: workspaceRoot, createdAt: 0 }
  const managed = createManagedSession({ id: MAIN_SESSION }, workspace, { messagesLoaded: true })
  const harness = manager as unknown as HarnessSessionManager
  harness.sessions.set(managed.id, managed)

  const sessionDir = join(workspaceRoot, 'sessions', MAIN_SESSION)
  const input = { title: 'POO161 联调画布', html: APP_HTML }

  const generated = await handleGenerateApp({ dataPath: join(sessionDir, 'data') } as never, input)
  if (generated.isError) fail('create', 'handleGenerateApp returned isError')
  const original = generated.content.map((c: { text: string }) => c.text).join('\n')
  const indexPath = /path="([^"]+)"/.exec(original)?.[1]
  if (!indexPath || !existsSync(indexPath)) fail('create', `bundle missing at ${indexPath}`)

  // Real Pi adapter → real SessionManager persistence.
  const adapter = new PiEventAdapter()
  adapter.startTurn()
  for (const sdkEvent of [
    { type: 'tool_execution_start' as const, toolCallId: 't1', toolName: 'generate_app', args: input },
    { type: 'tool_execution_end' as const, toolCallId: 't1', toolName: 'generate_app', result: generated, isError: false },
  ]) {
    for (const event of adapter.adaptEvent(sdkEvent)) await harness.processEvent(managed, event)
  }
  harness.persistSession(managed)
  await harness.flushSession(managed.id)

  // ── Write-end check: under cwd=/ the persisted marker keeps the ABSOLUTE path.
  const rawJsonl = readFileSync(join(sessionDir, 'session.jsonl'), 'utf8')
  const stored = rawJsonl.trim().split('\n').slice(1).map(line => JSON.parse(line))
  const persistedResult = String(stored[0]?.toolResult ?? '')
  const writeEnd = {
    persistedAbsolutePath: persistedResult.includes(`path="{{SESSION_PATH}}/data/genui-apps/`),
    persistedCorrupted: persistedResult.includes(`path=".{{SESSION_PATH}}`),
  }
  if (!writeEnd.persistedAbsolutePath || writeEnd.persistedCorrupted) fail('create', 'write-end integrity broken: ' + JSON.stringify(writeEnd))

  // ── Craft the legacy cwd=/ corruption (exactly the old-bug persisted form)
  //    in a second session dir, sharing the same bundle files.
  const legacyDir = join(workspaceRoot, 'sessions', LEGACY_SESSION)
  mkdirSync(legacyDir, { recursive: true })
  const corrupted = persistedResult.replace('path="{{SESSION_PATH}}', 'path=".{{SESSION_PATH}}')
  const legacyLines = rawJsonl.trim().split('\n')
  legacyLines[1] = JSON.stringify({ ...stored[0], toolResult: corrupted })
  writeFileSync(join(legacyDir, 'session.jsonl'), legacyLines.join('\n') + '\n')
  cpSync(join(sessionDir, 'data'), join(legacyDir, 'data'), { recursive: true })

  // ── Read-end check: production read path recovers the corrupted marker.
  // After read, {{SESSION_PATH}} is untokenized to the session dir, so the
  // recovered marker carries the ABSOLUTE legacy bundle path.
  const reloaded = readSessionMessages(join(legacyDir, 'session.jsonl'))
  const recoveredResult = String(reloaded[0]?.toolResult ?? '')
  const legacyBundlePrefix = `path="${join(legacyDir, 'data', 'genui-apps')}`
  const readEnd = {
    recoveredToAbsolute: recoveredResult.includes(legacyBundlePrefix),
    stillCorrupted: recoveredResult.includes(`path=".{{SESSION_PATH}}`),
  }
  if (!readEnd.recoveredToAbsolute || readEnd.stillCorrupted) fail('create', 'read-end recovery broken: ' + JSON.stringify(readEnd))

  // Fresh manager read (API surface) of the corrupted session must also recover.
  const manager2 = new SessionManager()
  const managed2 = createManagedSession({ id: LEGACY_SESSION }, workspace, { messagesLoaded: false })
  const harness2 = manager2 as unknown as HarnessSessionManager
  harness2.sessions.set(managed2.id, managed2)
  const viaGetSession = await (manager2 as unknown as { getSession: (id: string) => Promise<{ messages: Array<{ toolResult?: string }> | null }> }).getSession(LEGACY_SESSION)
  const viaGetSessionOk = String(viaGetSession?.messages?.[0]?.toolResult ?? '').includes(legacyBundlePrefix)
  if (!viaGetSessionOk) fail('create', 'getSession did not recover legacy session')

  // ── Render: production cards in real windows with real webview guests.
  const mainPayload = { sessionId: MAIN_SESSION, app: parseMarker(original), html: APP_HTML }
  const legacyPayload = { sessionId: LEGACY_SESSION, app: parseMarker(recoveredResult), html: APP_HTML }

  ipcMain.handle('fixture-stub', (_e, name: string, args: unknown[]) => {
    if (name === 'registerGenUiCard') return true
    if (name === 'unregisterGenUiCard') return true
    return null
  })

  const bundleParam = encodeURIComponent(JSON.stringify({ main: mainPayload, legacy: legacyPayload }))
  const win = await createHarnessWindow(join(here, 'pages', 'canvas.html'), `?mode=all&phase=create&bundle=${bundleParam}`)
  const popout = await createHarnessWindow(join(here, 'pages', 'canvas.html'), `?mode=popout&phase=create&bundle=${bundleParam}`)

  const guestChecks = await assertGuestsRender(['inline-main', 'sidebar-main', 'popout-main'], [win, popout])

  const shotMain = join(evidence, 'create-inline-sidebar.png')
  const shotPopout = join(evidence, 'create-popout.png')
  await capture(win, shotMain)
  await capture(popout, shotPopout)

  writeFileSync(join(evidence, 'runtime-create.json'), JSON.stringify({
    phase: 'create', cwd: process.cwd(), sourceRef: process.env.POO161_SOURCE_REF ?? 'unknown',
    workspaceRoot, mainSession: MAIN_SESSION, legacySession: LEGACY_SESSION,
    writeEnd, readEnd, viaGetSessionOk, guestChecks,
    screenshots: [shotMain, shotPopout],
    startedAt: new Date().toISOString(),
  }, null, 2))

  app.exit(guestChecks.ok ? 0 : 1)
}

async function runRecover(): Promise<void> {
  const sessionDir = join(workspaceRoot, 'sessions', LEGACY_SESSION)
  const recovered = readSessionMessages(join(sessionDir, 'session.jsonl'))
  const recoveredResult = String(recovered[0]?.toolResult ?? '')
  const readEnd = {
    recoveredToAbsolute: recoveredResult.includes(`path="${join(sessionDir, 'data', 'genui-apps')}`),
    stillCorrupted: recoveredResult.includes(`path=".{{SESSION_PATH}}`),
  }
  if (!readEnd.recoveredToAbsolute || readEnd.stillCorrupted) fail('recover', 'restart read-end recovery broken: ' + JSON.stringify(readEnd))

  ipcMain.handle('fixture-stub', (_e, name: string) => (name === 'registerGenUiCard' || name === 'unregisterGenUiCard' ? true : null))

  const legacyPayload = { sessionId: LEGACY_SESSION, app: parseMarker(recoveredResult), html: APP_HTML }
  const bundleParam = encodeURIComponent(JSON.stringify({ legacy: legacyPayload }))
  const win = await createHarnessWindow(join(here, 'pages', 'canvas.html'), `?mode=all&phase=recover&bundle=${bundleParam}`)
  const guestChecks = await assertGuestsRender(['sidebar-legacy'], [win])
  const shot = join(evidence, 'recover-legacy-session.png')
  await capture(win, shot)

  writeFileSync(join(evidence, 'runtime-recover.json'), JSON.stringify({
    phase: 'recover', cwd: process.cwd(), sourceRef: process.env.POO161_SOURCE_REF ?? 'unknown',
    readEnd, guestChecks, screenshot: shot,
    startedAt: new Date().toISOString(),
  }, null, 2))

  app.exit(guestChecks.ok ? 0 : 1)
}

function parseMarker(toolResult: string): { appId: string; title: string; indexPath: string; version: number } {
  const m = /\[genui-app id="([^"]+)" version="(\d+)" path="([^"]+)"\]/.exec(toolResult)
  if (!m) fail('parse', 'no genui-app marker in toolResult')
  return { appId: m![1]!, title: 'POO161 联调画布', indexPath: m![3]!, version: Number(m![2]) }
}

async function createHarnessWindow(page: string, query: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { webviewTag: true, preload: join(here, 'preload.cjs'), contextIsolation: true },
  })
  await win.loadFile(page, { search: query })
  win.show()
  return win
}

async function assertGuestsRender(expectedKeys: string[], windows: BrowserWindow[]): Promise<{ ok: boolean; details: Record<string, unknown> }> {
  // The authoritative render proof: each card's real <webview> guest exposes
  // its webContents id through the production getWebContentsId() API (throws
  // before attach, POO-103 pattern). The renderer reports the ids; main reads
  // each guest's body text via webContents.fromId.
  const details: Record<string, unknown> = {}
  const guestIds: Record<string, number> = {}
  const guestBodies: Record<string, string> = {}
  const guestSrcs: Record<string, string> = {}
  const deadline = Date.now() + 25000
  const collect = async (): Promise<void> => {
    const states = await Promise.all(windows.map(w => w.webContents.executeJavaScript('window.__poo161 ?? null', true).catch(() => null)))
    for (const s of states.filter(Boolean)) {
      const parsed = s as { webviews: Record<string, string>; guestIds: Record<string, number> }
      for (const [k, v] of Object.entries(parsed.webviews ?? {})) guestSrcs[k] = v
      for (const [k, v] of Object.entries(parsed.guestIds ?? {})) guestIds[k] = v
    }
  }
  while (Date.now() < deadline) {
    await collect()
    const allIds = expectedKeys.every(k => typeof guestIds[k] === 'number' && guestIds[k]! > 0)
    if (allIds) break
    await new Promise(r => setTimeout(r, 400))
  }
  for (const key of expectedKeys) {
    const id = guestIds[key]
    if (typeof id === 'number' && id > 0) {
      try {
        const guest = webContents.fromId(id)
        const body = await guest.executeJavaScript('document.body ? document.body.innerText.slice(0, 160) : "(no body)"', true)
        guestBodies[key] = body
        details[key] = { guestId: id, src: guest.getURL().slice(0, 140), bodyOk: body.includes('POO161') }
      } catch (err) {
        guestBodies[key] = `(executeJavaScript failed: ${String(err).slice(0, 100)})`
        details[key] = { guestId: id, error: String(err).slice(0, 100) }
      }
    } else {
      details[key] = { guestId: id ?? null, src: (guestSrcs[key] ?? '').slice(0, 140) }
    }
  }
  const ok = expectedKeys.every(k => typeof guestBodies[k] === 'string' && guestBodies[k]!.includes('POO161'))
  details.guestBodies = guestBodies
  return { ok, details }
}

async function capture(win: BrowserWindow, out: string): Promise<void> {
  const image = win.webContents.capturePage()
  const img = await image
  writeFileSync(out, img.toPNG())
}

function fail(phaseName: string, message: string): never {
  writeFileSync(join(evidence, `runtime-${phaseName}.json`), JSON.stringify({ phase: phaseName, ok: false, error: message, cwd: process.cwd() }, null, 2))
  console.error(`[poo161-canvas-recovery] FAIL(${phaseName}): ${message}`)
  app.exit(1)
  throw new Error(message)
}

main().catch(err => {
  console.error('[poo161-canvas-recovery] fatal:', err)
  app.exit(1)
})
