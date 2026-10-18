import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { GenUiAppPinAuditRequest, GenUiAppPinAuditResult } from '../../../shared/types'
import { setWebAppArtifactPolicy } from '@polo-ai/shared/config'
import { unzipSync } from 'fflate'

// The handler registers the canvas-guest src validator on webview-security;
// capture the wiring without pulling the real module's electron graph. The
// POO-103 deep-link forwarder setter is part of the same import surface and
// must be present for the module mock to satisfy genui.ts.
let wiredValidator: unknown = null
let wiredForwarder: unknown = null
mock.module('../../webview-security', () => ({
  setGenUiGuestSrcValidator: (validator: unknown) => {
    wiredValidator = validator
  },
  setGenUiGuestDeepLinkForwarder: (forwarder: unknown) => {
    wiredForwarder = forwarder
  },
}))
mock.module('electron', () => ({
  app: { on: () => {}, getPath: () => tmpdir() },
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => {} },
  // deep-link-callback-bridge sits in genui.ts's import graph (ui-event
  // wiring); its electron surface is inert for these tests.
  ipcMain: { on: () => {}, off: () => {}, handle: () => {} },
  webContents: { fromId: () => undefined, getAllWebContents: () => [] },
}))

const { registerGenUiHandlers } = await import('../genui')
const { GENUI_PINNED_APP_ID_PREFIX } = await import('../../../shared/types')

type AuditHandler = (ctx: { workspaceId?: string; webContentsId?: number }, request: GenUiAppPinAuditRequest) => Promise<GenUiAppPinAuditResult>

type HandlerMap = Map<string, (ctx: { workspaceId?: string; webContentsId?: number }, request: never) => Promise<unknown>>

function loadHandlerWith(explicitDeps?: Parameters<typeof registerGenUiHandlers>[1]): HandlerMap {
  const handlers: HandlerMap = new Map()
  const server = {
    handle: (channel: string, fn: never) => {
      handlers.set(channel, fn)
    },
  } as unknown as RpcServer
  registerGenUiHandlers(server, explicitDeps)
  return handlers
}

describe('genui AUDIT_APP_PIN gate', () => {
  let rootDir: string
  let otherRootDir: string
  let handlers: HandlerMap
  /** The AUDIT_APP_PIN handler under test. */
  let handler: AuditHandler

  // Storage layout stand-in: <workspaceRoot>/sessions/<id>[{/data}].
  const storage = {
    getSessionPath: (root: string, id: string) => join(root, 'sessions', id),
    getDataPath: (root: string, id: string) => join(root, 'sessions', id, 'data'),
  }

  function deps(sessionManagedRoot = rootDir) {
    return {
      windowManager: { getWorkspaceForWindow: () => 'ws-1' },
      sessionManager: {
        getWorkspaces: () => [{ id: 'ws-1', rootPath: rootDir }],
        getSessionPath: (sessionId: string) => join(sessionManagedRoot, 'sessions', sessionId),
      },
      sessionStorage: storage,
    }
  }

  function writeBundle(sessionId: string, appId: string, html = '<html><body>app</body></html>'): string {
    const dataDir = storage.getDataPath(rootDir, sessionId)
    const appDir = join(dataDir, 'genui-apps', appId)
    mkdirSync(appDir, { recursive: true })
    const indexPath = join(appDir, 'index.html')
    writeFileSync(indexPath, html, 'utf-8')
    return indexPath
  }

  function auditRequest(overrides: Partial<GenUiAppPinAuditRequest> = {}): GenUiAppPinAuditRequest {
    const appId = overrides.appId ?? 'app-abc'
    return {
      sessionId: 'sess-1',
      appId,
      title: 'Demo',
      indexPath: overrides.indexPath ?? join(storage.getDataPath(rootDir, 'sess-1'), 'genui-apps', appId, 'index.html'),
      version: 1,
      pinnedAppId: overrides.pinnedAppId ?? `${GENUI_PINNED_APP_ID_PREFIX}${appId}`,
      ...overrides,
    }
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'genui-handler-'))
    otherRootDir = mkdtempSync(join(tmpdir(), 'genui-other-'))
    setWebAppArtifactPolicy(undefined)
    wiredValidator = null
    wiredForwarder = null
    handlers = loadHandlerWith(deps())
    handler = handlers.get(RPC_CHANNELS.genui.AUDIT_APP_PIN) as unknown as AuditHandler
  })

  afterEach(() => {
    setWebAppArtifactPolicy(undefined)
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(otherRootDir, { recursive: true, force: true })
  })

  it('records a pin whose ids, path and size all check out, and wires the src validator', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    const result = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))

    expect(result.ok).toBe(true)
    const auditPath = join(rootDir, 'sessions', 'sess-1', 'audit.jsonl')
    expect(existsSync(auditPath)).toBe(true)
    const record = JSON.parse(readFileSync(auditPath, 'utf-8').trim())
    expect(record).toMatchObject({
      event: 'genui_app_pin',
      sessionId: 'sess-1',
      appId: 'app-abc',
      pinnedAppId: 'gen-ui-app-app-abc',
      indexPath,
    })
    // Registration wires the Main-trusted src validator when deps allow it.
    expect(wiredValidator).not.toBeNull()
  })

  it('rejects a pinnedAppId that is not the gen-ui-app-<appId> derivation', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    for (const forged of [
      'gen-ui-app-app-other', // another app's tab id
      'app-abc', // the bare app id
      `${GENUI_PINNED_APP_ID_PREFIX}app-abc-extra`, // suffixed drift
      'builtin-notes', // a builtin app id
    ]) {
      const result = await handler(
        { workspaceId: 'ws-1', webContentsId: 7 },
        auditRequest({ indexPath, pinnedAppId: forged }),
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain('gen-ui-app-<appId>')
    }
    // Nothing was audited for the forged requests.
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('rejects when the workspace/session storage identity does not match', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    // The managed session path points into a different workspace root than
    // the storage-derived one — a moved or fabricated session.
    const mismatched = loadHandlerWith(deps(otherRootDir)).get(RPC_CHANNELS.genui.AUDIT_APP_PIN) as unknown as AuditHandler
    const result = await mismatched(
      { workspaceId: 'ws-1', webContentsId: 7 },
      auditRequest({ indexPath }),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mismatch')
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('fails the pin when the audit write fails (audit-first, no unrecorded pin)', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    // Make the append target unusable: audit.jsonl exists as a DIRECTORY.
    mkdirSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'), { recursive: true })

    const result = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    // The failed write left no usable audit line behind.
    expect(statSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl')).isDirectory()).toBe(true)
  })

  it('refuses a bundle above the remote web_app policy maxBundleBytes', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc', 'x'.repeat(64))
    // Tighten the remote policy below the bundle size (clamped cache).
    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 16, maxFileCount: 1 })

    const result = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('policy limit')
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)

    // With the policy back at the default the same bundle pins fine.
    setWebAppArtifactPolicy(undefined)
    const allowed = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))
    expect(allowed.ok).toBe(true)
  })
})

// ── POO-104 publish chain: PUBLISH_APP_AS_ARTIFACT packaging leg ────────────

describe('genui PUBLISH_APP_AS_ARTIFACT packaging gate', () => {
  let rootDir: string
  let otherRootDir: string
  let handlers: HandlerMap
  let publish: (ctx: { workspaceId?: string; webContentsId?: number }, request: { sessionId: string; appId: string; title: string }) => Promise<{
    ok: boolean
    error?: string
    payloadBase64?: string
    entry?: { runtime: string; path: string }
    checksum?: string
    sizeBytes?: number
    fileCount?: number
    policyNotice?: string
  }>

  const storage = {
    getSessionPath: (root: string, id: string) => join(root, 'sessions', id),
    getDataPath: (root: string, id: string) => join(root, 'sessions', id, 'data'),
  }

  function deps(sessionManagedRoot = rootDir) {
    return {
      windowManager: { getWorkspaceForWindow: () => 'ws-1' },
      sessionManager: {
        getWorkspaces: () => [{ id: 'ws-1', rootPath: rootDir }],
        getSessionPath: (sessionId: string) => join(sessionManagedRoot, 'sessions', sessionId),
      },
      sessionStorage: storage,
    }
  }

  function writeApp(appId: string, files: Record<string, string>): string {
    const appDir = join(storage.getDataPath(rootDir, 'sess-1'), 'genui-apps', appId)
    mkdirSync(appDir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(appDir, name), content, 'utf-8')
    }
    return appDir
  }

  function publishRequest(overrides: Partial<{ sessionId: string; appId: string; title: string }> = {}) {
    return { sessionId: 'sess-1', appId: 'app-abc', title: 'Demo app', ...overrides }
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'genui-publish-'))
    otherRootDir = mkdtempSync(join(tmpdir(), 'genui-publish-other-'))
    setWebAppArtifactPolicy(undefined)
    handlers = loadHandlerWith(deps())
    publish = handlers.get(RPC_CHANNELS.genui.PUBLISH_APP_AS_ARTIFACT) as typeof publish
  })

  afterEach(() => {
    setWebAppArtifactPolicy(undefined)
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(otherRootDir, { recursive: true, force: true })
  })

  it('packages the bundle into a rooted upload zip and audits before returning the payload', async () => {
    const html = '<html><body>publishable</body></html>'
    writeApp('app-abc', { 'index.html': html, 'version.json': '{"version":3}' })

    const result = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())

    expect(result.ok).toBe(true)
    // Audit-first: the record exists before the payload is handed out.
    const auditPath = join(rootDir, 'sessions', 'sess-1', 'audit.jsonl')
    const record = JSON.parse(readFileSync(auditPath, 'utf-8').trim())
    expect(record).toMatchObject({
      event: 'genui_app_publish',
      sessionId: 'sess-1',
      appId: 'app-abc',
      version: 3,
      title: 'Demo app',
      fileCount: 1,
    })
    expect(record.checksum).toMatch(/^[0-9a-f]{64}$/)

    // The zip: root layout, index.html only (version.json is session-local).
    const archive = unzipSync(new Uint8Array(Buffer.from(result.payloadBase64!, 'base64')))
    expect(Object.keys(archive).sort()).toEqual(['index.html'])
    expect(new TextDecoder().decode(archive['index.html']!)).toBe(html)
    expect(result.entry).toEqual({ runtime: 'static', path: 'index.html' })
    // Checksum matches the payload bytes; the notice ships the policy copy.
    const { createHash } = await import('node:crypto')
    expect(result.checksum).toBe(createHash('sha256').update(Buffer.from(result.payloadBase64!, 'base64')).digest('hex'))
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.policyNotice).toContain('@polo-ai/sdk')
    expect(result.policyNotice).toContain('bridge protocol 1')
    expect(result.policyNotice).toContain('read-only')
  })

  it('rejects an invalid app id and an unknown session without touching disk', async () => {
    for (const bad of [
      publishRequest({ appId: '../escape' }),
      publishRequest({ appId: '' }),
      publishRequest({ sessionId: '' }),
      publishRequest({ title: '' }),
    ]) {
      const result = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, bad)
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    }
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('rejects when the session storage identity does not match (moved or fabricated session)', async () => {
    writeApp('app-abc', { 'index.html': '<html></html>' })
    const mismatched = loadHandlerWith(deps(otherRootDir)).get(RPC_CHANNELS.genui.PUBLISH_APP_AS_ARTIFACT) as typeof publish
    const result = await mismatched({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mismatch')
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('fails closed on a missing index.html and on unexpected bundle files', async () => {
    // Missing bundle entirely.
    const missing = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('Bundle file not found')

    // Unexpected extra file: never swept into a distributed artifact.
    writeApp('app-abc', { 'index.html': '<html></html>', 'notes.txt': 'secret-ish' })
    const extra = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())
    expect(extra.ok).toBe(false)
    expect(extra.error).toContain('Unexpected file')
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('enforces the web_app artifact policy at the packaging boundary', async () => {
    writeApp('app-abc', { 'index.html': 'x'.repeat(64) })
    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 16, maxFileCount: 1 })
    const overBytes = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())
    expect(overBytes.ok).toBe(false)
    expect(overBytes.error).toContain('policy limit')

    // Multi-file bundles are refused while maxFileCount is 1 — the app.js/app.css
    // root-layout slots activate only if the hard policy ever widens.
    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 512 * 1024, maxFileCount: 1 })
    writeApp('app-abc', { 'index.html': '<html></html>', 'app.js': 'console.log(1)' })
    const overCount = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())
    expect(overCount.ok).toBe(false)
    expect(overCount.error).toContain('file limit')

    setWebAppArtifactPolicy({ enabled: false, maxBundleBytes: 512 * 1024, maxFileCount: 1 })
    const disabled = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())
    expect(disabled.ok).toBe(false)
    expect(disabled.error).toContain('disabled by the web_app artifact policy')
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('fails the packaging when the audit write fails (audit-first, no unrecorded payload)', async () => {
    writeApp('app-abc', { 'index.html': '<html></html>' })
    mkdirSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'), { recursive: true })

    const result = await publish({ workspaceId: 'ws-1', webContentsId: 7 }, publishRequest())

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.payloadBase64).toBeUndefined()
    expect(statSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl')).isDirectory()).toBe(true)
  })
})
