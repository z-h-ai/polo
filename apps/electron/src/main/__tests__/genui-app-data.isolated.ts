/**
 * GenUI canvas app data channel (P1-3/P2-1) — isolation tests.
 *
 * Security fence first (fail-closed, same discipline as
 * webview-genui-partition.isolated.ts): a declared data file is only ever
 * read/written/pushed when, AFTER realpath resolution, it still lives inside
 * the session data/ directory. Symlinks, `..` segments and absolute paths
 * that walk out of the fence are rejected, not clamped; oversized files and
 * malformed JSON fail closed; the per-card declaration cap holds.
 *
 * The push path is exercised against a fake DeepLinkCallbackBridge surface —
 * the real bridge's ownership checks (registered callback bound to the exact
 * guest webContents) are what make ui_state point-to-point.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { readGenUiAppDataFile, setGenUiAppDataDeps, observeGenUiGuestForAppData, releaseGenUiAppDataForGuest, pushGenUiAppDataUpdate, clearGenUiAppDataForSession, releaseGenUiAppDataChannel, __getGenUiAppDataWatchCountForTests } = await import('../genui-app-data')
// The real session-tools-core handler for the end-to-end composition (the
// same import pattern the shared-side parity guard uses to cross packages).
const { handleUpdateAppData } = await import('../../../../../packages/session-tools-core/src/handlers/update-app-data')
const { extractPoloAppDataFromDocument, extractPoloAppDataDeclarations } = await import('../ui-card-registry')
const { GENUI_APP_DATA_MAX_FILES_PER_CARD, GENUI_APP_DATA_MAX_FILE_BYTES, GENUI_APP_DATA_META_NAME, GENUI_APP_DATA_WATCH_DEBOUNCE_MS, parseGenUiAppDataDeclaration } = await import('@polo-ai/shared/protocol')

/** Poll until the predicate holds (fs.watch delivery is asynchronous). */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return predicate()
}

let root: string
let dataDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'polo-app-data-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeAppDocument(body: string): string {
  const appDir = join(dataDir, 'genui-apps', 'app-1')
  mkdirSync(appDir, { recursive: true })
  const html = `<!doctype html><html><head>${body}</head><body></body></html>`
  writeFileSync(join(appDir, 'index.html'), html, 'utf-8')
  // Mirror the real renderer flow: the guest src carries the card identity
  // query the bundle reads its own ids from.
  return `${pathToFileURL(join(appDir, 'index.html')).toString()}?poloCard=${CARD_ID}`
}

describe('parseGenUiAppDataDeclaration (shared)', () => {
  it('splits, dedupes and caps declarations', () => {
    expect(parseGenUiAppDataDeclaration('data/state.json, data/state.json data/rows.json')).toEqual([
      'data/state.json',
      'data/rows.json',
    ])
  })

  it('keeps at most the per-card cap (fail closed, never grows)', () => {
    const declared = parseGenUiAppDataDeclaration('a.json b.json c.json d.json e.json')
    expect(declared.length).toBe(GENUI_APP_DATA_MAX_FILES_PER_CARD)
    expect(declared).toEqual(['a.json', 'b.json', 'c.json'])
  })

  it('drops malformed tokens (NUL, over-length) and non-string content', () => {
    // A NUL can never appear in a real attribute value — the whole content
    // is voided (fail closed), never split into plausible halves.
    expect(parseGenUiAppDataDeclaration('ok.json\0evil.json')).toEqual([])
    expect(parseGenUiAppDataDeclaration(`${'x'.repeat(2000)}.json fine.json`)).toEqual(['fine.json'])
    expect(parseGenUiAppDataDeclaration(undefined)).toEqual([])
    expect(parseGenUiAppDataDeclaration(null)).toEqual([])
    expect(parseGenUiAppDataDeclaration(42 as unknown as string)).toEqual([])
  })
})

describe('extractPoloAppDataFromDocument', () => {
  it('reads the polo-app-data meta regardless of attribute order', () => {
    expect(extractPoloAppDataFromDocument(`<meta content="data/state.json" name="${GENUI_APP_DATA_META_NAME}">`)).toEqual(['data/state.json'])
    expect(extractPoloAppDataFromDocument(`<meta name='${GENUI_APP_DATA_META_NAME}' content='data/rows.json'>`)).toEqual(['data/rows.json'])
  })

  it('unions multiple meta tags, dedupes and caps at the per-card limit', () => {
    const doc = [
      `<meta name="${GENUI_APP_DATA_META_NAME}" content="a.json">`,
      `<meta name="${GENUI_APP_DATA_META_NAME}" content="a.json b.json c.json d.json">`,
    ].join('')
    const declared = extractPoloAppDataFromDocument(doc)
    expect(declared.length).toBe(GENUI_APP_DATA_MAX_FILES_PER_CARD)
    expect(declared).toEqual(['a.json', 'b.json', 'c.json'])
  })

  it('returns empty for documents without the declaration', () => {
    expect(extractPoloAppDataFromDocument('<meta name="polo-bridge-capabilities" content="ui-event">')).toEqual([])
    expect(extractPoloAppDataFromDocument('')).toEqual([])
  })
})

describe('extractPoloAppDataDeclarations (file: src)', () => {
  it('reads the declaration from the exact attached document', () => {
    const src = writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="data/state.json">`)
    expect(extractPoloAppDataDeclarations(src)).toEqual(['data/state.json'])
  })

  it('fails closed for unreadable or foreign srcs', () => {
    expect(extractPoloAppDataDeclarations('file:///definitely/not/there/index.html')).toEqual([])
    expect(extractPoloAppDataDeclarations('https://example.invalid/app.html')).toEqual([])
  })
})

describe('readGenUiAppDataFile — the data/ fence', () => {
  it('reads a simple relative declaration inside data/', () => {
    writeFileSync(join(dataDir, 'state.json'), '{"count":3}', 'utf-8')
    const verdict = readGenUiAppDataFile(dataDir, 'state.json')
    expect(verdict).toEqual({ ok: true, state: { count: 3 } })
  })

  it('reads a nested declaration inside data/', () => {
    mkdirSync(join(dataDir, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(dataDir, 'nested', 'deep', 'state.json'), '[1,2]', 'utf-8')
    const verdict = readGenUiAppDataFile(dataDir, 'nested/deep/state.json')
    expect(verdict).toEqual({ ok: true, state: [1, 2] })
  })

  it('rejects `..` path escapes', () => {
    writeFileSync(join(root, 'outside.json'), '{"evil":true}', 'utf-8')
    const verdict = readGenUiAppDataFile(dataDir, '../outside.json')
    expect(verdict.ok).toBe(false)
  })

  it('rejects deep `..` escapes through nested segments', () => {
    mkdirSync(join(dataDir, 'nested'), { recursive: true })
    writeFileSync(join(root, 'outside.json'), '{"evil":true}', 'utf-8')
    const verdict = readGenUiAppDataFile(dataDir, 'nested/../../outside.json')
    expect(verdict.ok).toBe(false)
  })

  it('rejects absolute paths outside data/', () => {
    writeFileSync(join(root, 'outside.json'), '{"evil":true}', 'utf-8')
    const verdict = readGenUiAppDataFile(dataDir, join(root, 'outside.json'))
    expect(verdict.ok).toBe(false)
  })

  it('rejects a symlink inside data/ that points outside the fence', () => {
    writeFileSync(join(root, 'secret.json'), '{"evil":true}', 'utf-8')
    symlinkSync(join(root, 'secret.json'), join(dataDir, 'state.json'))
    const verdict = readGenUiAppDataFile(dataDir, 'state.json')
    expect(verdict.ok).toBe(false)
  })

  it('rejects a symlinked intermediate directory that points outside', () => {
    const realDir = join(root, 'elsewhere')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'state.json'), '{"evil":true}', 'utf-8')
    symlinkSync(realDir, join(dataDir, 'link'))
    const verdict = readGenUiAppDataFile(dataDir, 'link/state.json')
    expect(verdict.ok).toBe(false)
  })

  it('rejects files above the 1MB cap', () => {
    writeFileSync(join(dataDir, 'big.json'), JSON.stringify({ blob: 'x'.repeat(GENUI_APP_DATA_MAX_FILE_BYTES) }), 'utf-8')
    const verdict = readGenUiAppDataFile(dataDir, 'big.json')
    expect(verdict.ok).toBe(false)
  })

  it('rejects invalid JSON and missing files', () => {
    writeFileSync(join(dataDir, 'broken.json'), '{nope', 'utf-8')
    expect(readGenUiAppDataFile(dataDir, 'broken.json').ok).toBe(false)
    expect(readGenUiAppDataFile(dataDir, 'missing.json').ok).toBe(false)
  })

  it('rejects NUL-carrying declarations', () => {
    expect(readGenUiAppDataFile(dataDir, 'state\0.json').ok).toBe(false)
  })
})

// ── Channel lifecycle: attach injection + update push (fake bridge) ──────────

interface RecordedUiState {
  callbackId: string
  webContentsId: number
  sessionId: string
  cardId: string
  state: unknown
}

function createFakeBridge() {
  const uiStates: RecordedUiState[] = []
  const registeredCallbacks = new Map<string, number>()
  const boundSessions = new Map<string, string>()
  const bridge = {
    registerCallback(callbackId: string, webContentsId: number) {
      registeredCallbacks.set(callbackId, webContentsId)
      return { ok: true as const }
    },
    bindCallbackToSession(callbackId: string, webContentsId: number, sessionId: string) {
      if (registeredCallbacks.get(callbackId) !== webContentsId) return { ok: false as const }
      boundSessions.set(callbackId, sessionId)
      return { ok: true as const }
    },
    postUiStateToCard(
      callbackId: string,
      webContentsId: number,
      event: { sessionId: string; cardId: string; state: unknown; modelContextTruncated: boolean },
    ) {
      uiStates.push({ callbackId, webContentsId, sessionId: event.sessionId, cardId: event.cardId, state: event.state })
    },
  }
  return { bridge, uiStates, registeredCallbacks, boundSessions }
}

const SESSION_ID = 'sess-app-data-1'
const CARD_ID = 'app-1-9f2c1a0b'
const GUEST_ID = 4242

function observeGuest(overrides: { src?: string; dataPath?: string | null } = {}) {
  const { bridge, uiStates, registeredCallbacks } = createFakeBridge()
  setGenUiAppDataDeps({
    bridge,
    resolveSessionDataPath: () => overrides.dataPath === null ? null : (overrides.dataPath ?? dataDir),
  })
  const src = overrides.src ?? writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="state.json">`)
  observeGenUiGuestForAppData({
    sessionId: SESSION_ID,
    guestWebContentsId: GUEST_ID,
    hostWebContentsId: 1,
    src,
  })
  return { uiStates, registeredCallbacks }
}

describe('attach injection + update push (P1-3 channel)', () => {
  afterEach(() => {
    clearGenUiAppDataForSession(SESSION_ID)
    setGenUiAppDataDeps(null)
  })

  it('injects the declared data file as ui_state on attach, via a registered state callback', () => {
    writeFileSync(join(dataDir, 'state.json'), '{"v":1}', 'utf-8')
    const { uiStates, registeredCallbacks } = observeGuest()
    expect(uiStates.length).toBe(1)
    expect(uiStates[0]).toMatchObject({ sessionId: SESSION_ID, cardId: CARD_ID, state: { v: 1 } })
    // The push traveled over a callback that Main itself registered and bound
    // to this exact guest — the bridge's ownership check stays meaningful.
    expect(registeredCallbacks.get(uiStates[0]!.callbackId)).toBe(GUEST_ID)
    expect(uiStates[0]!.callbackId).toMatch(/^[A-Za-z0-9-]{8,64}$/)
  })

  it('skips injection when the guest src carries no parsable card identity', () => {
    const { uiStates } = observeGuest({ src: writeAppDocument('') })
    expect(uiStates.length).toBe(0)
  })

  it('skips injection when the session data path cannot be resolved', () => {
    const { uiStates } = observeGuest({ dataPath: null })
    expect(uiStates.length).toBe(0)
  })

  it('does not inject undeclared files (declaration is the only data path)', () => {
    writeFileSync(join(dataDir, 'other.json'), '{"v":9}', 'utf-8')
    const { uiStates } = observeGuest()
    expect(uiStates.length).toBe(0)
  })

  it('end-to-end: pushGenUiAppDataUpdate delivers freshly written data to the mounted card', () => {
    writeFileSync(join(dataDir, 'state.json'), '{"v":1}', 'utf-8')
    const { uiStates } = observeGuest()
    expect(uiStates.length).toBe(1)

    writeFileSync(join(dataDir, 'state.json'), '{"v":2,"rows":[1,2,3]}', 'utf-8')
    const pushed = pushGenUiAppDataUpdate(SESSION_ID, 'app-1', join(dataDir, 'state.json'))
    expect(pushed).toBe(1)
    const last = uiStates[uiStates.length - 1]!
    expect(last.state).toEqual({ v: 2, rows: [1, 2, 3] })
    expect(last.cardId).toBe(CARD_ID)
  })

  it('pushGenUiAppDataUpdate never crosses cards or sessions', () => {
    writeFileSync(join(dataDir, 'state.json'), '{"v":1}', 'utf-8')
    const { uiStates } = observeGuest()
    expect(pushGenUiAppDataUpdate('other-session', 'app-1', join(dataDir, 'state.json'))).toBe(0)
    expect(pushGenUiAppDataUpdate(SESSION_ID, 'other-app', join(dataDir, 'state.json'))).toBe(0)
    expect(uiStates.length).toBe(1)
  })

  it('stops pushing after the guest is released (destroyed/unmounted)', () => {
    writeFileSync(join(dataDir, 'state.json'), '{"v":1}', 'utf-8')
    const { uiStates } = observeGuest()
    releaseGenUiAppDataForGuest(GUEST_ID)
    writeFileSync(join(dataDir, 'state.json'), '{"v":2}', 'utf-8')
    expect(pushGenUiAppDataUpdate(SESSION_ID, 'app-1', join(dataDir, 'state.json'))).toBe(0)
    expect(uiStates.length).toBe(1)
  })

  it('refuses to push a data path that escapes the fence at push time', () => {
    writeFileSync(join(dataDir, 'state.json'), '{"v":1}', 'utf-8')
    const { uiStates } = observeGuest()
    writeFileSync(join(root, 'outside.json'), '{"evil":true}', 'utf-8')
    expect(pushGenUiAppDataUpdate(SESSION_ID, 'app-1', join(root, 'outside.json'))).toBe(0)
    expect(uiStates.length).toBe(1)
  })
})

describe('end-to-end: update_app_data → mounted card receives fresh ui_state', () => {
  afterEach(() => {
    clearGenUiAppDataForSession(SESSION_ID)
    setGenUiAppDataDeps(null)
  })

  function mountCard(bridge: ReturnType<typeof createFakeBridge>['bridge']): void {
    setGenUiAppDataDeps({
      bridge,
      resolveSessionDataPath: () => dataDir,
    })
    observeGenUiGuestForAppData({
      sessionId: SESSION_ID,
      guestWebContentsId: GUEST_ID,
      hostWebContentsId: 1,
      src: writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="state.json">`),
    })
  }

  function buildCtx(notify: (appId: string, dataPath: string) => void) {
    return {
      sessionId: SESSION_ID,
      workspacePath: root,
      sourcesPath: join(root, 'sources'),
      skillsPath: join(root, 'skills'),
      plansFolderPath: join(root, 'plans'),
      callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
      fs: {
        exists: () => false,
        readFile: () => '',
        readFileBuffer: () => Buffer.from(''),
        writeFile: () => {},
        isDirectory: () => false,
        readdir: () => [],
        stat: () => ({ size: 0, isDirectory: () => false }),
      },
      loadSourceConfig: () => null,
      dataPath: dataDir,
      notifyCanvasAppDataUpdated: notify,
    }
  }

  it('delivers the freshly written data to the mounted card through the handler ctx seam', async () => {
    const fake = createFakeBridge()
    mountCard(fake.bridge)
    // No data file yet — the attach injection has nothing to deliver.
    expect(fake.uiStates.length).toBe(0)

    const result = await handleUpdateAppData(
      buildCtx((appId, dataPath) => pushGenUiAppDataUpdate(SESSION_ID, appId, dataPath)),
      { appId: 'app-1', dataSrc: 'state.json', data: { rows: [7, 8, 9] } },
    )
    expect(result.isError).toBeFalsy()
    expect(fake.uiStates.length).toBe(1)
    expect(fake.uiStates[0]).toMatchObject({
      sessionId: SESSION_ID,
      cardId: CARD_ID,
      state: { rows: [7, 8, 9] },
    })
    // The file the handler wrote is exactly what the card received.
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf-8'))).toEqual({ rows: [7, 8, 9] })
  })

  it('keeps an update to an undeclared path storage-only (review P1-1)', async () => {
    const fake = createFakeBridge()
    mountCard(fake.bridge)

    const undeclared = await handleUpdateAppData(
      buildCtx((appId, dataPath) => pushGenUiAppDataUpdate(SESSION_ID, appId, dataPath)),
      { appId: 'app-1', dataSrc: 'scratch.json', data: { note: 'not declared' } },
    )
    expect(undeclared.isError).toBeFalsy()
    expect(JSON.parse(readFileSync(join(dataDir, 'scratch.json'), 'utf-8'))).toEqual({ note: 'not declared' })
    expect(fake.uiStates.length).toBe(0)
    expect(undeclared.content[0]?.text).toContain('polo-app-data')

    const declared = await handleUpdateAppData(
      buildCtx((appId, dataPath) => pushGenUiAppDataUpdate(SESSION_ID, appId, dataPath)),
      { appId: 'app-1', dataSrc: 'state.json', data: { rows: [1] } },
    )
    expect(declared.isError).toBeFalsy()
    expect(fake.uiStates.length).toBe(1)
  })

  it('degrades to write-only when no card is mounted', async () => {
    // The app bundle exists (the model created one earlier) but no card is
    // attached — the update lands on disk only.
    writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="state.json">`)
    const fake = createFakeBridge()
    setGenUiAppDataDeps({ bridge: fake.bridge, resolveSessionDataPath: () => dataDir })
    const result = await handleUpdateAppData(
      buildCtx((appId, dataPath) => pushGenUiAppDataUpdate(SESSION_ID, appId, dataPath)),
      { appId: 'app-1', dataSrc: 'state.json', data: { v: 1 } },
    )
    expect(result.isError).toBeFalsy()
    expect(fake.uiStates.length).toBe(0)
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf-8'))).toEqual({ v: 1 })
    expect(result.content[0]?.text).toContain('polo-app-data')
  })
})

// ── P2-1: debounced fs-watch auto-refresh ────────────────────────────────────

describe('P2-1 declared-file auto-refresh', () => {
  const WATCH_DEBOUNCE_MS = 80

  afterEach(() => {
    clearGenUiAppDataForSession(SESSION_ID)
    clearGenUiAppDataForSession('sess-other')
    setGenUiAppDataDeps(null)
  })

  function observeWithWatch(bridge: ReturnType<typeof createFakeBridge>['bridge'], sessionId = SESSION_ID): void {
    setGenUiAppDataDeps({
      bridge,
      resolveSessionDataPath: () => dataDir,
      watchDebounceMs: WATCH_DEBOUNCE_MS,
    })
    observeGenUiGuestForAppData({
      sessionId,
      guestWebContentsId: GUEST_ID,
      hostWebContentsId: 1,
      src: writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="state.json">`),
    })
  }

  it('registers one directory watcher per attach', () => {
    observeWithWatch(createFakeBridge().bridge)
    expect(__getGenUiAppDataWatchCountForTests()).toBe(1)
  })

  it('shares one watcher between cards watching the same directory (refcounted)', () => {
    const first = createFakeBridge()
    observeWithWatch(first.bridge)
    const second = createFakeBridge()
    // Same data dir, different session/card — the directory watcher is shared.
    setGenUiAppDataDeps({
      bridge: second.bridge,
      resolveSessionDataPath: () => dataDir,
      watchDebounceMs: WATCH_DEBOUNCE_MS,
    })
    observeGenUiGuestForAppData({
      sessionId: 'sess-other',
      guestWebContentsId: GUEST_ID + 1,
      hostWebContentsId: 1,
      src: writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="other.json">`),
    })
    expect(__getGenUiAppDataWatchCountForTests()).toBe(1)

    releaseGenUiAppDataChannel(SESSION_ID, CARD_ID)
    expect(__getGenUiAppDataWatchCountForTests()).toBe(1)
    releaseGenUiAppDataChannel('sess-other', CARD_ID)
    expect(__getGenUiAppDataWatchCountForTests()).toBe(0)
  })

  it('pushes a changed declared file to the card after the debounce quiet period', async () => {
    const fake = createFakeBridge()
    writeFileSync(join(dataDir, 'state.json'), '{"v":1}', 'utf-8')
    observeWithWatch(fake.bridge)
    // Initial injection already delivered v1.
    expect(fake.uiStates.length).toBe(1)

    writeFileSync(join(dataDir, 'state.json'), '{"v":2}', 'utf-8')
    const delivered = await waitFor(() => fake.uiStates.length >= 2)
    expect(delivered).toBe(true)
    expect(fake.uiStates[1]).toMatchObject({ sessionId: SESSION_ID, cardId: CARD_ID, state: { v: 2 } })
  })

  it('never pushes a file the card did not declare (no broadcast)', async () => {
    const fake = createFakeBridge()
    observeWithWatch(fake.bridge)
    writeFileSync(join(dataDir, 'undeclared.json'), '{"v":9}', 'utf-8')
    await new Promise(resolve => setTimeout(resolve, WATCH_DEBOUNCE_MS * 6))
    expect(fake.uiStates.length).toBe(0)
  })

  it('collapses a burst of writes into one debounced push', async () => {
    const fake = createFakeBridge()
    writeFileSync(join(dataDir, 'state.json'), '{"v":0}', 'utf-8')
    observeWithWatch(fake.bridge)

    // Rapid-fire writes inside one debounce window.
    for (let v = 1; v <= 5; v++) {
      writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ v }), 'utf-8')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await waitFor(() => fake.uiStates.length >= 2)
    await new Promise(resolve => setTimeout(resolve, WATCH_DEBOUNCE_MS * 3))
    // Exactly one follow-up push beyond the attach injection, carrying the
    // last settled value.
    expect(fake.uiStates.length).toBe(2)
    expect(fake.uiStates[1]).toMatchObject({ state: { v: 5 } })
  })

  it('routes a change only to the session that declared the file', async () => {
    // One process-wide deps surface (as in the real wiring): a single bridge
    // plus a per-session data/ resolver — the routing must be decided by the
    // declaration match, not by which bridge happens to be installed.
    const fake = createFakeBridge()
    writeFileSync(join(dataDir, 'state.json'), '{"v":1}', 'utf-8')
    writeFileSync(join(dataDir, 'theirs.json'), '{"v":1}', 'utf-8')
    setGenUiAppDataDeps({
      bridge: fake.bridge,
      resolveSessionDataPath: () => dataDir,
      watchDebounceMs: WATCH_DEBOUNCE_MS,
    })
    observeGenUiGuestForAppData({
      sessionId: SESSION_ID,
      guestWebContentsId: GUEST_ID,
      hostWebContentsId: 1,
      src: writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="state.json">`),
    })
    observeGenUiGuestForAppData({
      sessionId: 'sess-other',
      guestWebContentsId: GUEST_ID + 1,
      hostWebContentsId: 1,
      src: writeAppDocument(`<meta name="${GENUI_APP_DATA_META_NAME}" content="theirs.json">`),
    })
    // Both cards hold their attach-time injection now.
    const pushesAfterMount = fake.uiStates.length

    writeFileSync(join(dataDir, 'state.json'), '{"v":2}', 'utf-8')
    const delivered = await waitFor(() =>
      fake.uiStates.some(push => push.sessionId === SESSION_ID && (push.state as { v?: number })?.v === 2))
    expect(delivered).toBe(true)
    // The other session's card — which declared theirs.json, not state.json —
    // received nothing beyond its initial injection: point-to-point per
    // declaration, never a broadcast.
    expect(fake.uiStates.slice(pushesAfterMount).filter(push => push.sessionId === 'sess-other').length).toBe(0)
  })

  it('stops pushing after the guest is released and unregisters the watcher', async () => {
    const fake = createFakeBridge()
    observeWithWatch(fake.bridge)
    expect(__getGenUiAppDataWatchCountForTests()).toBe(1)

    releaseGenUiAppDataForGuest(GUEST_ID)
    expect(__getGenUiAppDataWatchCountForTests()).toBe(0)

    writeFileSync(join(dataDir, 'state.json'), '{"v":2}', 'utf-8')
    await new Promise(resolve => setTimeout(resolve, WATCH_DEBOUNCE_MS * 6))
    expect(fake.uiStates.length).toBe(0)
  })

  it('session teardown unregisters the watcher (leak-free)', () => {
    const fake = createFakeBridge()
    observeWithWatch(fake.bridge)
    expect(__getGenUiAppDataWatchCountForTests()).toBe(1)
    clearGenUiAppDataForSession(SESSION_ID)
    expect(__getGenUiAppDataWatchCountForTests()).toBe(0)
  })
})
